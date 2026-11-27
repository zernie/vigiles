/**
 * The world of a regression case (vigiles#416), its pure half: which commits
 * are refused, what the symptom file and the installs must be, what is
 * removed from `head`, and the edits that turn the world into the fix again
 * (gold) or into a test edit (gold + test edit). The machine is behind the
 * {@link CaseWorldHost} port (`src/host/case-world.io.ts`); the flow that
 * calls both is `src/eval-case-qualify.ts`.
 *
 * Every read of the user's repository is read-only: the world is assembled
 * in vigiles' own copies, never in the checkout.
 */
import { matchesAny, type FixPath } from "./regression-case.js";
import type {
  DepsRefusal,
  HistoryRefusal,
  SymptomRefusal,
} from "./regression-case-refusal.js";
import type { TouchedRow } from "./workspace.js";

/** One entry of a commit's tree (`git ls-tree -r -z`). */
export interface TreeEntry {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
}

/** The fix's own change, reversed file by file, as it applies at `head`. */
export interface RevertPatches {
  /** The reverse of every file that applied, concatenated. */
  readonly patch: string;
  /** The files whose reverse did not apply at `head`. */
  readonly failed: readonly string[];
}

/**
 * The machine reads a case's world needs (the port). Every method reads the
 * user's repository and writes nothing into it.
 */
export interface CaseWorldHost {
  /** The git dir of the work tree at `top`, where its objects are read. */
  gitDir(top: string): string;
  /** The parents of `commit`; undefined when it or a parent is not in the repository. */
  parents(top: string, commit: string): readonly string[] | undefined;
  isAncestor(top: string, ancestor: string, of: string): boolean;
  /** The fix's paths against its parent, renames off. */
  fixPaths(top: string, commit: string): readonly FixPath[];
  /** Every entry of `sha`'s tree, recursively. */
  treeEntries(top: string, sha: string): readonly TreeEntry[];
  /** The blob id of the working-copy file at `path`, no filter run; undefined when it is not a regular file. */
  workingBlob(top: string, path: string): string | undefined;
  revertPatches(
    top: string,
    at: {
      readonly commit: string;
      readonly head: string;
      readonly paths: readonly string[];
    },
  ): RevertPatches;
  /** A patch that deletes `paths` from `head`'s tree. */
  removalPatch(top: string, head: string, paths: readonly string[]): string;
}

/** Parse `git ls-tree -r -z`: `<mode> <type> <object>` TAB `<path>`, NUL-ended. */
export function parseTreeEntries(z: string): readonly TreeEntry[] {
  return z
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", , blob = ""] = line.slice(0, tab).split(" ");
      return { mode, blob, path: line.slice(tab + 1) };
    });
}

/** The facts about the two commits a history refusal reads. */
export interface HistoryFacts {
  /** `head` resolved, or undefined when it is not a commit. */
  readonly head: string | undefined;
  readonly parents: readonly string[] | undefined;
  /** Is the fix an ancestor of the resolved `head`? Read only once the rest holds. */
  readonly isAncestor: (head: string) => boolean;
}

/** The first refusal about the commits, in the order a user fixes them. */
export function historyRefusal(
  declaredHead: string,
  facts: HistoryFacts,
): HistoryRefusal | undefined {
  if (facts.head === undefined)
    return { kind: "head-not-a-commit", head: declaredHead };
  if (facts.parents === undefined) return { kind: "commit-not-in-history" };
  if (facts.parents.length !== 1)
    return { kind: "merge-commit", parents: facts.parents.length };
  return facts.isAncestor(facts.head)
    ? undefined
    : { kind: "commit-not-ancestor-of-head", head: declaredHead };
}

const REGULAR: ReadonlySet<string> = new Set(["100644", "100755"]);

/** A path that is absolute or steps out of, or around, the repository root. */
export function escapes(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

/**
 * The first problem with the symptom file: it must be a repo-relative path,
 * a regular file committed at `head`, unchanged in the working copy (an edit
 * the user forgot to commit would not be the task the agent reads).
 */
export function symptomRefusal(
  path: string,
  atHead: TreeEntry | undefined,
  working: () => string | undefined,
): SymptomRefusal | undefined {
  if (escapes(path)) return { kind: "symptom-path-escapes", path };
  if (atHead === undefined) return { kind: "symptom-not-committed", path };
  if (!REGULAR.has(atHead.mode)) return { kind: "symptom-not-a-file", path };
  return working() === atHead.blob
    ? undefined
    : { kind: "symptom-uncommitted-changes", path };
}

/** What `head` loses in the world: the symptom file and every entry `hide` matches. */
export function removedPaths(
  entries: readonly TreeEntry[],
  symptom: string,
  hide: readonly string[],
): readonly string[] {
  return entries
    .map((e) => e.path)
    .filter((p) => p === symptom || matchesAny(p, hide));
}

/**
 * The edits that make a world copy the fix again: each reverted path as it
 * is at `head`, a regular file written from its blob, a path absent at
 * `head` deleted. Any other entry (a link, a gitlink) is left out, as the
 * carry would drop it; that can only make gold fail and refuse the case.
 */
export function goldRows(
  reverted: readonly string[],
  entries: readonly TreeEntry[],
): readonly TouchedRow[] {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return reverted.flatMap((path): readonly TouchedRow[] => {
    const e = byPath.get(path);
    if (e === undefined)
      return [{ status: "D", path, entry: { kind: "absent" } }];
    return e.mode === "100644" || e.mode === "100755"
      ? [
          {
            status: "M",
            path,
            entry: { kind: "file", mode: e.mode, blob: e.blob },
          },
        ]
      : [];
  });
}

/** Gold plus a deleted oracle test: an edit under test territory the scorer must catch. */
export function goldEditRows(
  gold: readonly TouchedRow[],
  oracle: readonly string[],
): readonly TouchedRow[] {
  const first = oracle.at(0);
  return first === undefined
    ? gold
    : [...gold, { status: "D", path: first, entry: { kind: "absent" } }];
}

/** Lockfiles whose content decides a Node install, by the name at a root. */
export const INSTALL_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/** What the deps check reads. */
export interface DepsFacts {
  /** Every install of the checkout (`findInstalls`), repo-relative. */
  readonly installs: readonly string[];
  readonly entries: readonly TreeEntry[];
  /** The working copy's blob id of a path, as `CaseWorldHost.workingBlob`. */
  readonly working: (path: string) => string | undefined;
}

/** The installs a case copies, and the lockfiles that key them. */
export interface CaseDeps {
  readonly installs: readonly string[];
  /** Every known lockfile at a declared root, sorted by path, as committed at `head`. */
  readonly lockfiles: readonly TreeEntry[];
}

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
};

const under = (path: string, root: string): boolean =>
  root === "." || path === root || path.startsWith(`${root}/`);

/**
 * The installs under the declared roots and their lockfiles, or the first
 * refusal: no install, a root with no lockfile, a lockfile the working copy
 * changed (the install would not be `head`'s), or a lockfile between a root
 * and an install under it (that install is keyed by a lockfile nobody hashes).
 */
export function caseDeps(
  roots: readonly string[],
  facts: DepsFacts,
): { readonly kind: "deps"; readonly deps: CaseDeps } | DepsRefusal {
  const installs = facts.installs.filter((i) => roots.some((r) => under(i, r)));
  if (installs.length === 0)
    return { kind: "deps-unsupported", why: "no-node-modules" };
  const lockfiles = facts.entries
    .filter((e) => isLockfile(e.path) && roots.includes(dirOf(e.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  return (
    rootsRefusal(roots, lockfiles, facts) ??
    nestedRefusal(roots, installs, facts.entries) ?? {
      kind: "deps",
      deps: { installs, lockfiles },
    }
  );
}

const isLockfile = (path: string): boolean =>
  INSTALL_LOCKFILES.includes(path.slice(path.lastIndexOf("/") + 1));

function rootsRefusal(
  roots: readonly string[],
  lockfiles: readonly TreeEntry[],
  facts: DepsFacts,
): DepsRefusal | undefined {
  if (roots.some((r) => !lockfiles.some((l) => dirOf(l.path) === r)))
    return { kind: "deps-unsupported", why: "no-lockfile" };
  const changed = lockfiles.find((l) => facts.working(l.path) !== l.blob);
  return changed === undefined
    ? undefined
    : { kind: "host-install-not-at-head", lockfile: changed.path };
}

/**
 * A lockfile in a directory strictly between a root and an install's
 * package under it, where that directory is not itself a declared root.
 */
function nestedRefusal(
  roots: readonly string[],
  installs: readonly string[],
  entries: readonly TreeEntry[],
): DepsRefusal | undefined {
  const lockDirs = entries
    .filter((e) => isLockfile(e.path))
    .map((e) => dirOf(e.path))
    .filter((d) => !roots.includes(d));
  const dir = installs
    .map(dirOf)
    .flatMap((pkg) => lockDirs.filter((d) => between(roots, d, pkg)))
    .at(0);
  return dir === undefined
    ? undefined
    : { kind: "deps-unsupported", why: "nested-lockfile", dir };
}

/** Is `dir` beneath a root that owns `pkg`, and `pkg` at or beneath `dir`? */
const between = (roots: readonly string[], dir: string, pkg: string): boolean =>
  under(pkg, dir) && roots.some((r) => under(pkg, r) && under(dir, r));
