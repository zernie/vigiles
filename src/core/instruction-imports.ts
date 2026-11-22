/**
 * Does each `@path` import a loaded instruction file names RESOLVE to a file in
 * the repository? The detector behind the instruction-import rule, shared by
 * `lint`, `audit` and the browser engine (one-detector-no-drift).
 *
 * 🔴 IT READS THE ADAPTER'S RESOLVED PATH, NEVER THE TOKEN. Which text counts as
 * an import, and what it is relative to, is the harness's answer
 * (`PluginLayout.instructionChain` → `NamedImport.path`): Claude Code resolves
 * `@notes.md` in `.claude/CLAUDE.md` against `.claude/`, OpenCode names a path
 * in its manifest. Re-resolving the token here against the repository root
 * would report a file that loads as missing.
 *
 * 🔴 EXISTENCE COMES FROM A DIRECTORY LISTING, NOT FROM "CAN IT BE OPENED".
 * On a case-insensitive file system (macOS by default) `@docs/Style.md` opens
 * `docs/style.md`, and the same commit then fails on Linux and in CI. A listing
 * returns the names as they are stored, so the two cases separate: a name that
 * matches only when case is ignored is a `case-mismatch`, carrying the real
 * spelling, and nothing matching at all is `missing`. The disk scan lists with
 * `readdir` (each entry's type, a symlink resolved with `stat`), the browser
 * engine lists its file map (`listingOfPaths`), and both ask
 * {@link importResolution} — so the two engines cannot disagree about it. The
 * name an import ends on must be a FILE: a directory or a dangling symlink is
 * `not-a-file`.
 *
 * Harness-agnostic: no harness, file name or rule id is spelled here.
 */
import type { InstructionViews, NamedImport } from "./instruction-chain.js";

/**
 * What one directory entry IS. A listing of bare names read a directory named
 * `guide.md`, or a symlink to nothing, as a resolved import — the exact name
 * is in the listing — though the harness has no file there to load. So the
 * listing says what each name is, and the name an import ends on must be a
 * `file` (a symlink counts as what it points at).
 */
export type DirEntryKind =
  | "file"
  | "dir"
  /** Neither: a dangling symlink, a socket, a FIFO — nothing a harness can read as a file. */
  | "other";

/** One name directly inside a directory, and what it is. */
export interface DirEntry {
  readonly name: string;
  readonly kind: DirEntryKind;
}

/** The entries directly inside a repo-relative directory (`""` is the root); empty when it is absent. */
export type DirListing = (dir: string) => readonly DirEntry[];

/** Why an import does not resolve. A tagged union: each reason is its own fact. */
export type ImportResolution =
  /** Nothing in the repository has this path, in any letter case. */
  | { readonly kind: "missing" }
  /**
   * A file exists under a different letter case — it opens on a
   * case-insensitive file system and not on Linux or in CI.
   */
  | { readonly kind: "case-mismatch"; readonly actual: string }
  /**
   * Something is at this path and it is not a file — a directory, or (`other`)
   * a dangling symlink or a special file. Its own reason rather than
   * `missing`, because the cure differs: the user who reads "does not exist"
   * lists the directory, sees the name, and has nothing left to try.
   */
  | {
      readonly kind: "not-a-file";
      readonly is: Exclude<DirEntryKind, "file">;
    };

/**
 * Which view of the chain names an unresolved import — and so whether it is
 * PRINTED (the effective view: this working copy) and whether it is SCORED (the
 * committed view, written in a committed file: a teammate's checkout and CI).
 *
 * A tagged answer rather than two booleans or a `fromScope` filter at the
 * scoring site, because the two sets differ in BOTH directions: an import in
 * `CLAUDE.local.md` is printed and not scored, and an import in a committed
 * `AGENTS.md` that a `CLAUDE.local.md` supersedes is scored and not printed —
 * this copy never reads that file, a teammate does.
 */
export type ImportView = "both" | "effective" | "committed";

/** An import that does not resolve, why, and which view names it. */
export interface UnresolvedImport extends NamedImport {
  readonly resolution: ImportResolution;
  readonly seenIn: ImportView;
}

/** Printed by `lint` and listed by `audit`: this working copy's chain names it. */
export function isShownImport(issue: UnresolvedImport): boolean {
  return issue.seenIn !== "committed";
}

/** Counted by the grade: the committed view names it, in a committed file. */
export function isScoredImport(issue: UnresolvedImport): boolean {
  return issue.seenIn !== "effective";
}

/**
 * Where `path` stands in the listing: `null` when a FILE is there exactly as
 * written, otherwise why not. Walks one segment at a time through
 * DIRECTORIES, so a directory spelled in the wrong case is caught as well as a
 * file, and a file is never walked into.
 */
export function importResolution(
  path: string,
  list: DirListing,
): ImportResolution | null {
  const segments = path.split("/");
  const last = segments.at(-1) ?? "";
  const dir = segments
    .slice(0, -1)
    .reduce<
      readonly string[] | null
    >((found, segment) => (found === null ? null : stepInto(found, segment, list, "dir")), []);
  if (dir === null) return { kind: "missing" };
  const file = stepInto(dir, last, list, "file");
  if (file === null) return notAFile(dir, last, list);
  const spelled = file.join("/");
  return spelled === path ? null : { kind: "case-mismatch", actual: spelled };
}

/** No file is named `last` in `dir`: is something else there, or nothing? */
function notAFile(
  dir: readonly string[],
  last: string,
  list: DirListing,
): ImportResolution {
  const entry = matching(list(dir.join("/")), last, () => true);
  return entry === undefined || entry.kind === "file"
    ? { kind: "missing" }
    : { kind: "not-a-file", is: entry.kind };
}

/**
 * `found` plus the entry of its directory that is `segment` and of `kind` —
 * exactly, else the first by name that matches ignoring case — or `null` when
 * none does.
 */
function stepInto(
  found: readonly string[],
  segment: string,
  list: DirListing,
  kind: DirEntryKind,
): readonly string[] | null {
  const hit = matching(list(found.join("/")), segment, (k) => k === kind);
  return hit === undefined ? null : [...found, hit.name];
}

/** The entry named `segment` (exact first, else the least name equal ignoring case) whose kind `accept`s. */
function matching(
  entries: readonly DirEntry[],
  segment: string,
  accept: (kind: DirEntryKind) => boolean,
): DirEntry | undefined {
  const of = entries.filter((e) => accept(e.kind));
  const folded = segment.toLowerCase();
  return (
    of.find((e) => e.name === segment) ??
    of
      .filter((e) => e.name.toLowerCase() === folded)
      .reduce<
        DirEntry | undefined
      >((a, e) => (a === undefined || e.name < a.name ? e : a), undefined)
  );
}

/**
 * Every import that does not resolve — the effective view's, in the order it
 * named them, then the ones only the committed view names — each tagged with
 * {@link ImportView}. The committed side counts only imports written in a
 * committed file (`fromScope: "repo"`); an import in one machine's file is
 * shown, never scored (see `InstructionScope`).
 *
 * Except one WRITTEN in a file `.vigilesrc.json#exclude` drops (`excluded`
 * answers for the importing file's repo-relative path). Exclude beats every
 * rule with no finding either, and this is the one place both scan engines
 * ask it for imports.
 */
export function unresolvedImports(
  views: InstructionViews,
  list: DirListing,
  excluded: (from: string) => boolean,
): readonly UnresolvedImport[] {
  const key = (imp: NamedImport): string => `${imp.from}\u0000${imp.path}`;
  const shown = unresolvedIn(views.effective.imports, list, excluded);
  const scored = unresolvedIn(
    views.committed.imports.filter((imp) => imp.fromScope === "repo"),
    list,
    excluded,
  );
  const scoredKeys = new Set(scored.map(key));
  const shownKeys = new Set(shown.map(key));
  return [
    ...shown.map(
      (i): UnresolvedImport => ({
        ...i,
        seenIn: scoredKeys.has(key(i)) ? "both" : "effective",
      }),
    ),
    ...scored
      .filter((i) => !shownKeys.has(key(i)))
      .map((i): UnresolvedImport => ({ ...i, seenIn: "committed" })),
  ];
}

/** The imports of one view that do not resolve, minus those written in an excluded file. */
function unresolvedIn(
  imports: readonly NamedImport[],
  list: DirListing,
  excluded: (from: string) => boolean,
): readonly (NamedImport & { readonly resolution: ImportResolution })[] {
  return imports
    .filter((imp) => !excluded(imp.from))
    .flatMap((imp) => {
      const resolution = importResolution(imp.path, list);
      return resolution === null ? [] : [{ ...imp, resolution }];
    });
}

/**
 * A {@link DirListing} over a set of repo-relative FILE paths (the browser
 * engine's map): a path's last segment is a `file`, every segment before it a
 * `dir`. A map holds no symlinks, so it never lists an `other`.
 */
export function listingOfPaths(paths: readonly string[]): DirListing {
  const entries = paths.flatMap((p) => {
    const segments = p.split("/");
    return segments.map((name, i) => ({
      dir: segments.slice(0, i).join("/"),
      name,
      kind: i === segments.length - 1 ? ("file" as const) : ("dir" as const),
    }));
  });
  return (dir) => [
    ...new Map(
      entries
        .filter((e) => e.dir === dir)
        .map((e): readonly [string, DirEntry] => [
          `${e.kind}:${e.name}`,
          { name: e.name, kind: e.kind },
        ]),
    ).values(),
  ];
}
