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
 *                (relative specifiers only, resolved, followed transitively;
 *                a build output read as its source — `./test-reach.ts`).
 * 5. `reads`   — a changed file is one an effect call in that closure runs,
 *                reads or copies, wherever it lives.
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
 * What it does NOT see, said plainly: a file an effect call reaches through a
 * path nothing is known about (a helper's parameter, a command read from a
 * file). Selecting such harnesses on every change was measured on a consumer
 * repository of 155 harnesses: 114 ran on an average narrowed change instead
 * of 19, which is no selection at all. So they are not selected for it, and the
 * output NAMES them (`Selection.unresolved`); `test.runAllOn` covers a known
 * input, and the full run on the default branch runs every file.
 *
 * Paths here are POSIX and relative to the run's cwd; a path outside it starts
 * with `../` and never matches a folder. Pure: the git diff and the file reads
 * arrive through `src/host/changed-files.io.ts`.
 */
import { dirname } from "node:path";
import { minimatch } from "minimatch";
import { reachMatch, type Reach, type Unresolved } from "./test-reach.js";

/** Why one harness file was selected. */
export type SelectionReason =
  | { readonly kind: "self" }
  | { readonly kind: "run-all"; readonly trigger: string }
  | { readonly kind: "folder"; readonly changed: string }
  | { readonly kind: "import"; readonly changed: string }
  | {
      readonly kind: "reads";
      readonly changed: string;
      readonly call: string;
    };

export interface SelectedFile {
  readonly file: string;
  readonly reason: SelectionReason;
}

export interface Selection {
  readonly selected: readonly SelectedFile[];
  readonly skipped: readonly string[];
  /**
   * Skipped files that make an effect call whose path could not be evaluated
   * (a function parameter, a command read from a file), with the first such
   * call. Not selected for it — measured, doing so ran most files on every
   * change — but always NAMED, so the gap is in the output, not hidden.
   */
  readonly unresolved: readonly {
    readonly file: string;
    readonly at: Unresolved;
  }[];
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
  /** What a harness file reaches (`./test-reach.ts`); asked only when the cheaper rules missed. */
  readonly reach: (file: string) => Reach;
}

/** Pure: decide which files run, and why. Order of `files` is kept. */
export function selectTests(input: SelectInput): Selection {
  const trigger = input.changed.find((c) =>
    input.runAllOn.some((g) => minimatch(c, g, { dot: true })),
  );
  if (trigger !== undefined) return runAll(input.files, trigger);
  const decided = input.files.map((file) => ({
    file,
    ...decide(file, input),
  }));
  return {
    selected: decided.flatMap(({ file, reason }) =>
      reason === undefined ? [] : [{ file, reason }],
    ),
    skipped: decided.flatMap((d) => (d.reason ? [] : [d.file])),
    unresolved: decided.flatMap(({ file, reason, unknown }) =>
      reason === undefined && unknown !== undefined
        ? [{ file, at: unknown }]
        : [],
    ),
  };
}

function runAll(files: readonly string[], trigger: string): Selection {
  const reason = { kind: "run-all", trigger } as const;
  return {
    selected: files.map((file) => ({ file, reason })),
    skipped: [],
    unresolved: [],
  };
}

/**
 * Why `file` runs, or why not: the first unresolved effect call of a skipped
 * file rides along, so its reach is computed once.
 */
function decide(
  file: string,
  input: SelectInput,
): {
  readonly reason: SelectionReason | undefined;
  readonly unknown?: Unresolved;
} {
  if (input.changed.includes(file)) return { reason: { kind: "self" } };
  const dir = dirname(file);
  const inFolder = input.changed.find((c) => isUnder(c, dir));
  if (inFolder !== undefined)
    return { reason: { kind: "folder", changed: inFolder } };
  const r = input.reach(file);
  return { reason: reachReason(r, input.changed), unknown: r.unresolved[0] };
}

function reachReason(
  r: Reach,
  changed: readonly string[],
): SelectionReason | undefined {
  const hit = changed
    .map((c) => ({ changed: c, hit: reachMatch(r, c) }))
    .find((h) => h.hit !== undefined);
  if (hit?.hit === undefined) return undefined;
  return hit.hit.kind === "reads"
    ? { kind: "reads", changed: hit.changed, call: hit.hit.call }
    : { kind: "import", changed: hit.changed };
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
  const gap = unresolvedLine(sel);
  if (sel.selected.length === 0) {
    return (
      `${head}\n0 of ${total} test file(s) selected: no changed file is a harness, ` +
      `in a harness's folder, import closure or effect calls, or a run-all trigger.\n` +
      `Nothing ran; ${String(sel.skipped.length)} skipped. Run without --changed to run them all.${gap}`
    );
  }
  const lines = sel.selected.map(
    (s) => `  ▸ ${s.file} — ${describeReason(s.reason)}`,
  );
  return (
    `${head}\nSelected ${String(sel.selected.length)} of ${total} test file(s); ` +
    `${String(sel.skipped.length)} skipped:\n${lines.join("\n")}${gap}`
  );
}

/** The skipped files whose effect calls could not be evaluated — said, never hidden. */
function unresolvedLine(sel: Selection): string {
  const first = sel.unresolved[0];
  if (first === undefined) return "";
  const { call, file, line } = first.at;
  return (
    `\n⚠ ${String(sel.unresolved.length)} skipped file(s) also make an effect call whose path ` +
    `cannot be evaluated (first: ${first.file} — ${call}() at ${file}:${String(line)}). ` +
    `A change they read that way is not seen; the full run (no --changed) covers them.`
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
    case "reads":
      return `reads: ${r.changed} changed (${r.call})`;
  }
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
