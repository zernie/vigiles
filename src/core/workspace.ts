/**
 * A repo workspace for `paid_runEval` (vigiles#416): trials run on a sealed
 * copy of a commit of your own repository instead of a `fixture` record.
 *
 * This module is the pure half: the shape of the key, the refusals it can
 * raise before a token is spent, and the reading of git's raw diff into a
 * touched set. The git processes live in `src/host/repo-copy.io.ts`.
 */

/**
 * A repository as the world of every trial.
 *
 * @experimental
 * @public
 */
export interface RepoWorkspace {
  /** The one kind today: a git repository on this machine. */
  readonly kind: "repo";
  /** A git work tree. Its untracked and ignored files are NOT copied. */
  readonly dir: string;
  /** A commit-ish, resolved to a SHA once, before the first trial. */
  readonly ref: string;
  /** A binary diff applied on top of `ref` before the `baseline` commit. */
  readonly patch?: string;
  /**
   * `node-modules`: every `node_modules` directory of the checkout whose
   * parent exists at `ref` is copied (a byte copy, never a link) into each
   * trial. `none`: nothing is installed.
   */
  readonly deps: { readonly kind: "node-modules" } | { readonly kind: "none" };
}

/**
 * What a trial sees of its own world, written by the parent before the agent
 * starts. Present exactly when the spec sets `experimental_workspace`.
 *
 * @experimental
 * @public
 */
export interface TrialWorkspaceView {
  /** The arm this trial ran in. */
  readonly arm: string;
  /**
   * The tree of the trial dir after the arm's files and `settings.json` were
   * written and before the agent started.
   */
  readonly baseTree: string;
  /**
   * A git dir the parent owns, BESIDE the trial dir (never in it), holding
   * `baseTree`'s objects. The base is not reachable through the trial's own
   * `.git`, so the agent's `commit --amend`, `reset` or `gc` cannot move it.
   */
  readonly gitDir: string;
  /**
   * Paths where this trial's world differs from the workspace by
   * construction (the arm's files, `settings.json`, a materialised plugin):
   * an edit there is the arm's, not the agent's. Each is where the file
   * really sits, as git reports it: as staged, and where writing it lands
   * (every link resolved, the last one included).
   */
  readonly armPaths: readonly string[];
}

/** Why `paid_runEval` refuses a workspace spec before any trial runs. */
export type WorkspaceRefusal =
  | { readonly kind: "workspace-with-fixture" }
  | { readonly kind: "cache-not-supported-with-workspace" }
  | {
      readonly kind: "harness-not-driven";
      readonly declared: readonly string[];
      readonly driven: string;
    }
  | { readonly kind: "ref-not-a-commit"; readonly ref: string }
  | { readonly kind: "not-a-git-work-tree"; readonly dir: string }
  | { readonly kind: "trial-dir-inside-repo"; readonly dir: string }
  | {
      readonly kind: "link-outside-world";
      readonly links: readonly string[];
    }
  | {
      readonly kind: "not-enough-disk";
      readonly neededBytes: number;
      readonly freeBytes: number;
    };

/** One line per refusal, naming what to change. */
export function describeWorkspaceRefusal(r: WorkspaceRefusal): string {
  switch (r.kind) {
    case "workspace-with-fixture":
      return "experimental_workspace and fixture are both set: a trial's world is one or the other";
    case "cache-not-supported-with-workspace":
      return 'experimental_workspace needs cache: "off" (a replayed trial has no git tree to score)';
    case "harness-not-driven":
      return `the workspace declares ${r.declared.join(", ")} in .vigilesrc.json; paid_runEval drives ${r.driven} only`;
    case "ref-not-a-commit":
      return `experimental_workspace.ref ${r.ref} is not a commit in the repository`;
    case "not-a-git-work-tree":
      return `experimental_workspace.dir ${r.dir} is not a git work tree`;
    case "trial-dir-inside-repo":
      return `the temp dir for trials (${r.dir}) is inside the workspace repository; set TMPDIR outside it`;
    case "link-outside-world":
      return `links that leave the repository, so a trial would write outside its copy: ${r.links.join(", ")}`;
    case "not-enough-disk":
      return `not enough disk for the trial copies: need ${mb(r.neededBytes)}, ${mb(r.freeBytes)} free`;
  }
}

const mb = (bytes: number): string => `${Math.ceil(bytes / 1_048_576)} MB`;

/** The thrown form, so a caller can read `refusal` instead of the message. */
export class WorkspaceRefusalError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(`paid_runEval: ${describeWorkspaceRefusal(refusal)}`);
    this.name = "WorkspaceRefusalError";
  }
}

/**
 * The harness a workspace may run under: refused only when the repo DECLARES
 * harnesses and the driven one is not among them. A repo that declares
 * nothing (or declares the driven one beside others) runs.
 */
export function harnessRefusal(
  declared: readonly string[],
  driven: string,
): WorkspaceRefusal | undefined {
  return declared.length === 0 || declared.includes(driven)
    ? undefined
    : { kind: "harness-not-driven", declared, driven };
}

/**
 * The new side of a touched path, read from its git mode. Only `file` has
 * content a scorer may carry; `absent` is a deletion.
 */
export type TouchedEntry =
  | {
      readonly kind: "file";
      readonly mode: "100644" | "100755";
      /** The blob id of the new content, in the trial's base git dir. */
      readonly blob: string;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "symlink" }
  | { readonly kind: "gitlink" }
  | { readonly kind: "other"; readonly mode: string };

/** One path of a trial's touched set. */
export interface TouchedRow {
  readonly status: "A" | "M" | "D" | "T";
  readonly path: string;
  readonly entry: TouchedEntry;
}

/**
 * Read `git diff-index --raw -z --no-renames` output. Each entry is
 * `:<old mode> <new mode> <old sha> <new sha> <status>` NUL `<path>` NUL.
 * Renames and copies are off, so there is exactly one path per entry.
 */
export function parseRawDiff(z: string): readonly TouchedRow[] {
  const parts = z.split("\0");
  return Array.from({ length: Math.floor(parts.length / 2) }, (_, i) =>
    /* v8 ignore next -- `-z` pairs every header with its path; the fallback only types the index */
    rawRow(parts[2 * i] ?? "", parts[2 * i + 1] ?? ""),
  );
}

function rawRow(head: string, path: string): TouchedRow {
  const fields = head.replace(/^:/, "").split(" ");
  const status = fields[4];
  if (!isStatus(status)) {
    throw new Error(`unexpected git raw diff entry: ${head}`);
  }
  /* v8 ignore next -- a row with a valid status has all five fields */
  return { status, path, entry: entryOf(fields[1] ?? "", fields[3] ?? "") };
}

function entryOf(mode: string, blob: string): TouchedEntry {
  switch (mode) {
    case "100644":
    case "100755":
      return { kind: "file", mode, blob };
    case "000000":
      return { kind: "absent" };
    case "120000":
      return { kind: "symlink" };
    case "160000":
      return { kind: "gitlink" };
    default:
      return { kind: "other", mode };
  }
}

function isStatus(s: string | undefined): s is TouchedRow["status"] {
  return s === "A" || s === "M" || s === "D" || s === "T";
}

/** A sealed copy of one commit: one `baseline` commit, no history, no remote. */
export interface RepoTemplate {
  /** The template's work tree (its `.git` holds the baseline commit). */
  readonly root: string;
  /** The resolved commit of the source repository. */
  readonly sha: string;
  /** The tree id of the baseline commit (source tree + patch). */
  readonly tree: string;
}

/** A trial's base: the tree before the agent, in a git dir beside the trial. */
export interface TrialBase {
  readonly gitDir: string;
  readonly baseTree: string;
}

/**
 * The trial's base record cannot be read or written, so the touched set is
 * unknown. The one fault {@link WorkspaceHost.touchedPaths} throws on purpose:
 * a scorer leaves such a trial unscored, and lets every other throw through.
 */
export class ShadowUnhealthyError extends Error {
  override readonly name = "ShadowUnhealthyError";
}

/**
 * What stayed out of the touched set: nothing, the paths git left unstaged
 * (a directory ends in `/`), or a failed staging that listed no path.
 */
export type Unstaged =
  | { readonly kind: "none" }
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly detail: string };

/** What the agent changed against its base. */
export interface TouchedSet {
  readonly rows: readonly TouchedRow[];
  /** What `add -A` could not stage (a nested repo without a commit). */
  readonly unstaged: Unstaged;
  /**
   * Ignored entries (`ls-files --others --ignored --directory`) present now
   * and not at the base: new files no scorer sees. A new file inside an
   * ignored directory that already existed at the base is not counted.
   */
  readonly ignoredNewFiles: number;
}

/**
 * The machine operations a workspace eval needs (the port; the host adapter
 * `src/host/repo-copy.io.ts` implements it). Every git call it makes runs
 * without the user's global and system git config.
 */
export interface WorkspaceHost {
  /** The real path of the work tree's top at `dir`; undefined when it is not one. */
  workTreeTop(dir: string): string | undefined;
  resolveCommit(top: string, ref: string): string | undefined;
  /** The text of `path` in commit `sha`; undefined when it is not a file there. */
  showFile(top: string, sha: string, path: string): string | undefined;
  /** The real path of the directory trial dirs are made in. */
  tmpRoot(): string;
  buildTemplate(opts: {
    readonly dir: string;
    readonly ref: string;
    readonly patch?: string;
  }): RepoTemplate;
  cloneTemplate(template: RepoTemplate, dest: string): void;
  /**
   * Record `cwd`'s tree into the empty dir `gitDir` (seeded from the template
   * tree, so files it tracks stay tracked under an ignored path; the
   * `armPaths`, relative to `cwd`, go in even when ignored); returns the
   * tree id and the arm paths where they were staged (a directory link on
   * the way resolved), which is how git reports them later.
   */
  recordTrialBase(
    template: RepoTemplate,
    at: {
      readonly gitDir: string;
      readonly cwd: string;
      readonly armPaths: readonly string[];
    },
  ): { readonly baseTree: string; readonly armPaths: readonly string[] };
  touchedPaths(base: TrialBase, cwd: string): TouchedSet;
  findInstalls(top: string, sha: string): readonly string[];
  linksOutside(
    template: RepoTemplate,
    top: string,
    installs: readonly string[],
  ): readonly string[];
  copyInstalls(top: string, installs: readonly string[], dest: string): void;
  treeBytes(path: string): number;
  freeBytes(dir: string): number;
  readWorld(template: RepoTemplate): Readonly<Record<string, string>>;
  removeDir(dir: string): void;
}
