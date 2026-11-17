/**
 * `vigiles test --changed=<ref>` — run only the harness files a change can reach.
 *
 * A harness file is SELECTED when any of these holds, checked in this order and
 * reported with the first that matched:
 *
 * 1. `self`    — the harness file itself changed.
 * 2. `run-all` — a file every harness depends on changed (`package.json`, a
 *                lockfile, `.vigilesrc.json`, a CI workflow, or a glob listed in
 *                `.vigilesrc.json` `test.runAllOn`). Every file is selected.
 * 3. `folder`  — a changed file sits in the harness's own directory or below it.
 * 4. `import`  — a changed file is in the harness's static import closure
 *                (relative specifiers only, resolved, followed transitively).
 *
 * 🔴 WHY THE FOLDER RULE, AND WHY IT COMES BEFORE IMPORTS. The common harness
 * shape spawns the script it tests (`spawnSync("node", ["hook.mjs"])`) or reads
 * a fixture beside it. Neither is an import, so an import-graph selector cannot
 * see it: measured on Vitest 5.1 (`--changed`, `related`) and Jest 30.5
 * (`--findRelatedTests`), editing a spawned script reported "no affected tests"
 * and exited 0 — a green run that tested nothing. Build systems that get this
 * right (Bazel `data`, Nx `inputs`, Pants `dependencies`) make the author
 * DECLARE such inputs. Colocation is the declaration harness authors already
 * write: the hook and its harness share a folder. So a harness owns its folder,
 * and the import closure adds what lives elsewhere (a shared helper).
 *
 * What it does NOT see, said plainly: a harness that spawns or reads a file
 * OUTSIDE its own folder without importing it. That is what `test.runAllOn` is
 * for, and the full run on the default branch (the Action's push mode) still
 * runs every file, so nothing is unwired for good.
 *
 * Paths here are POSIX and relative to the run's cwd; a path outside it starts
 * with `../` and never matches a folder. Pure: the git diff and the file reads
 * arrive through `src/host/changed-files.io.ts`.
 */
import ts from "typescript";
import { dirname, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

/** Why one harness file was selected. */
export type SelectionReason =
  | { readonly kind: "self" }
  | { readonly kind: "run-all"; readonly trigger: string }
  | { readonly kind: "folder"; readonly changed: string }
  | { readonly kind: "import"; readonly changed: string };

export interface SelectedFile {
  readonly file: string;
  readonly reason: SelectionReason;
}

export interface Selection {
  readonly selected: readonly SelectedFile[];
  readonly skipped: readonly string[];
}

/**
 * Files whose change can alter any harness's outcome, relative to the run's
 * cwd. The CI workflow folder is added from {@link ChangedSince}, because it
 * sits at the git root, which need not be the cwd.
 */
export const DEFAULT_RUN_ALL_ON: readonly string[] = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  ".vigilesrc.json",
];

export interface SelectInput {
  /** Harness files, POSIX, cwd-relative. */
  readonly files: readonly string[];
  /** Changed files, POSIX, cwd-relative. */
  readonly changed: readonly string[];
  /** Globs (cwd-relative) whose change selects every file. */
  readonly runAllOn: readonly string[];
  /** A harness file's import closure; called only when the cheaper rules missed. */
  readonly importClosure: (file: string) => ReadonlySet<string>;
}

/** Pure: decide which files run, and why. Order of `files` is kept. */
export function selectTests(input: SelectInput): Selection {
  const trigger = input.changed.find((c) =>
    input.runAllOn.some((g) => minimatch(c, g, { dot: true })),
  );
  if (trigger !== undefined) {
    return {
      selected: input.files.map((file) => ({
        file,
        reason: { kind: "run-all", trigger },
      })),
      skipped: [],
    };
  }
  const decided = input.files.map((file) => ({
    file,
    reason: reasonFor(file, input),
  }));
  return {
    selected: decided.flatMap(({ file, reason }) =>
      reason === undefined ? [] : [{ file, reason }],
    ),
    skipped: decided.filter((d) => d.reason === undefined).map((d) => d.file),
  };
}

function reasonFor(
  file: string,
  input: SelectInput,
): SelectionReason | undefined {
  if (input.changed.includes(file)) return { kind: "self" };
  const dir = dirname(file);
  const inFolder = input.changed.find((c) => isUnder(c, dir));
  if (inFolder !== undefined) return { kind: "folder", changed: inFolder };
  const closure = input.importClosure(file);
  const imported = input.changed.find((c) => closure.has(c));
  return imported === undefined
    ? undefined
    : { kind: "import", changed: imported };
}

/** Is `path` in `dir` or below it? A `../` path is outside every folder. */
function isUnder(path: string, dir: string): boolean {
  if (path.startsWith("../")) return false;
  return dir === "." || path.startsWith(`${dir}/`);
}

/** One line per selected file, then the tally — or the explicit zero line. */
export function formatSelection(
  sel: Selection,
  ref: string,
  since: ChangedSince,
): string {
  const total = String(sel.selected.length + sel.skipped.length);
  const how =
    since.via === "merge-base"
      ? `merge-base of ${ref} and HEAD`
      : `${ref} itself — no merge-base in this clone`;
  const head = `--changed=${ref}: ${String(since.files.length)} changed file(s) since ${since.base.slice(0, 12)} (${how}).`;
  if (sel.selected.length === 0) {
    return (
      `${head}\n0 of ${total} test file(s) selected: no changed file is a harness, ` +
      `in a harness's folder or import closure, or a run-all trigger.\n` +
      `Nothing ran; ${String(sel.skipped.length)} skipped. Run without --changed to run them all.`
    );
  }
  const lines = sel.selected.map(
    (s) => `  ▸ ${s.file} — ${describeReason(s.reason)}`,
  );
  return (
    `${head}\nSelected ${String(sel.selected.length)} of ${total} test file(s); ` +
    `${String(sel.skipped.length)} skipped:\n${lines.join("\n")}`
  );
}

function describeReason(r: SelectionReason): string {
  switch (r.kind) {
    case "self":
      return "self: the file changed";
    case "run-all":
      return `run-all: ${r.trigger} changed`;
    case "folder":
      return `folder: ${r.changed} changed`;
    case "import":
      return `import: ${r.changed} changed`;
  }
}

// ---------------------------------------------------------------------------
// The import closure — TypeScript's own scanner and resolver
// ---------------------------------------------------------------------------

/** The reads the import closure needs. Paths are absolute. */
export interface SourceHost {
  /** A file's text, or null when it is absent or unreadable. */
  readonly read: (path: string) => string | null;
  readonly isFile: (path: string) => boolean;
}

/**
 * `typescript` is already a runtime dependency, and `preProcessFile` is its
 * import scanner: static `import`/`export … from`, `require("…")` and a literal
 * `import("…")`, in JS and TS alike, without a type-check. Resolution goes
 * through `resolveModuleName` in Bundler mode, so `./x.js` finds `x.ts` the way
 * a NodeNext project writes it, and an extensionless specifier resolves. The
 * literal path is kept too, so `./x.js` beside an `x.ts` counts both.
 */
const RESOLVE_OPTIONS: Readonly<ts.CompilerOptions> = {
  allowJs: true,
  resolveJsonModule: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Absolute paths of the files `abs` imports through a relative specifier. */
function relativeImportsOf(abs: string, host: SourceHost): readonly string[] {
  const text = host.read(abs);
  if (text === null) return [];
  const resolver = {
    fileExists: host.isFile,
    readFile: (p: string) => host.read(p) ?? undefined,
  };
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map((i) => i.fileName)
    .filter((s) => s.startsWith("./") || s.startsWith("../"))
    .flatMap((spec) => {
      const literal = resolve(dirname(abs), spec);
      const viaTs = ts.resolveModuleName(spec, abs, RESOLVE_OPTIONS, resolver)
        .resolvedModule?.resolvedFileName;
      return [
        ...(host.isFile(literal) ? [literal] : []),
        ...(viaTs === undefined ? [] : [resolve(viaTs)]),
      ];
    });
}

/** Breadth-first over the import graph; `seen` holds every file reached. */
function walk(
  frontier: readonly string[],
  seen: ReadonlySet<string>,
  host: SourceHost,
): ReadonlySet<string> {
  if (frontier.length === 0) return seen;
  const next = [
    ...new Set(
      frontier
        .filter((f) => CODE_EXT.test(f))
        .flatMap((f) => relativeImportsOf(f, host)),
    ),
  ].filter((d) => !seen.has(d));
  return walk(next, new Set([...seen, ...next]), host);
}

/**
 * Every file reachable from `file` by relative imports, cwd-relative and POSIX,
 * not including `file` itself. Only code files are followed; a JSON or text
 * import is a leaf. A file that cannot be read contributes nothing.
 */
export function importClosure(
  cwd: string,
  file: string,
  host: SourceHost,
): ReadonlySet<string> {
  const start = resolve(cwd, file);
  const reached = walk([start], new Set([start]), host);
  return new Set(
    [...reached].filter((p) => p !== start).map((p) => posixRelative(cwd, p)),
  );
}

/** `relative`, in POSIX separators. */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// The changed set — computed by the host (git), described here
// ---------------------------------------------------------------------------

/** A ref the user named, or why it cannot be used. */
export type ParsedRef =
  | { readonly kind: "ok"; readonly ref: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Refuse an empty ref, and one starting with `-`: it reaches `git` as an
 * argument, where it would be read as an OPTION.
 */
export function parseChangedRef(raw: string): ParsedRef {
  if (raw === "")
    return { kind: "error", message: "--changed= needs a git ref" };
  if (raw.startsWith("-")) {
    return {
      kind: "error",
      message: `--changed=${raw}: a ref cannot start with "-"`,
    };
  }
  return { kind: "ok", ref: raw };
}

export interface ChangedSince {
  /** Changed files, POSIX, relative to the cwd. */
  readonly files: readonly string[];
  /** The commit compared against. */
  readonly base: string;
  /** How `base` was found: the merge-base, or the ref itself in a shallow clone. */
  readonly via: "merge-base" | "ref";
  /** The CI workflow folder as a glob, relative to the cwd — a run-all trigger. */
  readonly workflowsGlob: string;
}

export type ChangedResult =
  | ({ readonly kind: "ok" } & ChangedSince)
  | { readonly kind: "error"; readonly message: string };
