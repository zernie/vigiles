/**
 * Why a regression case (vigiles#416) is refused before its first trial: one
 * tagged union and a one-line renderer. The workspace's own refusals stay in
 * `./workspace.ts`.
 */
/** A file of the fix that changed after it, so its hunk does not revert at `head`. */
export interface RevertConflict {
  readonly path: string;
}

/** A refusal about the commits: found, single-parent, in line with `head`. */
export type HistoryRefusal =
  | { readonly kind: "head-not-a-commit"; readonly head: string }
  | { readonly kind: "commit-not-in-history" }
  | { readonly kind: "merge-commit"; readonly parents: number }
  | { readonly kind: "commit-not-ancestor-of-head"; readonly head: string }
  | { readonly kind: "agent-binary-missing"; readonly binary: string };

/** A refusal decided from the fix's paths and the tree at `head`, before anything runs. */
export type PathRefusal =
  | { readonly kind: "no-test-in-fix" }
  | { readonly kind: "fix-touches-only-tests" }
  | {
      readonly kind: "oracle-missing-in-world";
      readonly paths: readonly string[];
    }
  | { readonly kind: "fix-outside-source"; readonly paths: readonly string[] }
  | {
      readonly kind: "revert-touches-manifest";
      readonly paths: readonly string[];
    };

/** A refusal about the installs copied into the world. */
export type DepsRefusal =
  | {
      readonly kind: "deps-unsupported";
      readonly why: "no-node-modules" | "no-lockfile";
    }
  | {
      readonly kind: "deps-unsupported";
      readonly why: "nested-lockfile";
      /** The directory that holds the lockfile: add it to `deps.roots`. */
      readonly dir: string;
    }
  | { readonly kind: "host-install-not-at-head"; readonly lockfile: string }
  | {
      readonly kind: "deps-link-outside-world";
      readonly links: readonly string[];
    };

type SymptomProblem =
  | "symptom-not-committed"
  | "symptom-uncommitted-changes"
  | "symptom-not-a-file"
  | "symptom-path-escapes";

/** A refusal about the symptom file, the agent's only task text. */
export type SymptomRefusal = {
  readonly [K in SymptomProblem]: { readonly kind: K; readonly path: string };
}[SymptomProblem];

/** Why the world does not reproduce the bug any more. */
export type Outdated =
  | {
      readonly why: "revert-conflict";
      readonly files: readonly RevertConflict[];
    }
  | { readonly why: "build-fails-after-revert"; readonly exitCode: number }
  | {
      readonly why: "oracle-passes-without-fix";
      readonly paths: readonly string[];
    };

/** A refusal from the controls run through the scoring pipeline. */
export type ControlRefusal =
  | ({ readonly kind: "outdated" } & Outdated)
  | {
      readonly kind: "oracle-flaky";
      readonly red: readonly boolean[];
      readonly gold: readonly boolean[];
    }
  | {
      readonly kind: "fix-not-reproducible-under-scoring";
      readonly gold: readonly boolean[];
    }
  | {
      readonly kind: "scoring-timed-out";
      readonly control: "build" | "red" | "gold" | "gold-edit";
      readonly ms: number;
    };

/** Every reason a regression case is refused. */
export type RegressionCaseRefusal =
  | HistoryRefusal
  | PathRefusal
  | DepsRefusal
  | SymptomRefusal
  | ControlRefusal;

/** The refusal unions, one per group of causes. */
interface RefusalGroups {
  readonly history: HistoryRefusal;
  readonly paths: PathRefusal;
  readonly deps: DepsRefusal;
  readonly symptom: SymptomRefusal;
  readonly control: ControlRefusal;
}

type Group = keyof RefusalGroups;

/** The group a kind belongs to, computed from the unions themselves. */
type GroupOf<K extends RegressionCaseRefusal["kind"]> = {
  [G in Group]: K extends RefusalGroups[G]["kind"] ? G : never;
}[Group];

/** Every kind → its group. tsc refuses a kind left out or put in the wrong group. */
const GROUP_OF: { readonly [K in RegressionCaseRefusal["kind"]]: GroupOf<K> } =
  {
    "head-not-a-commit": "history",
    "commit-not-in-history": "history",
    "merge-commit": "history",
    "commit-not-ancestor-of-head": "history",
    "agent-binary-missing": "history",
    "no-test-in-fix": "paths",
    "fix-touches-only-tests": "paths",
    "oracle-missing-in-world": "paths",
    "fix-outside-source": "paths",
    "revert-touches-manifest": "paths",
    "deps-unsupported": "deps",
    "host-install-not-at-head": "deps",
    "deps-link-outside-world": "deps",
    "symptom-not-committed": "symptom",
    "symptom-uncommitted-changes": "symptom",
    "symptom-not-a-file": "symptom",
    "symptom-path-escapes": "symptom",
    outdated: "control",
    "oracle-flaky": "control",
    "fix-not-reproducible-under-scoring": "control",
    "scoring-timed-out": "control",
  };

function inGroup<G extends Group>(
  r: RegressionCaseRefusal,
  g: G,
): r is RefusalGroups[G] {
  return GROUP_OF[r.kind] === g;
}

/** One line per refusal, naming what to change. */
export function describeRegressionCaseRefusal(
  r: RegressionCaseRefusal,
): string {
  if (inGroup(r, "history")) return describeHistory(r);
  if (inGroup(r, "paths")) return describePaths(r);
  if (inGroup(r, "deps")) return describeDeps(r);
  if (inGroup(r, "symptom")) return describeSymptom(r);
  return describeControl(r);
}

function describeHistory(r: HistoryRefusal): string {
  switch (r.kind) {
    case "head-not-a-commit":
      return `head ${r.head} is not a commit in the repository`;
    case "commit-not-in-history":
      return "the fix or its parent is not in the repository (a shallow clone? run git fetch --unshallow)";
    case "merge-commit":
      return `the fix has ${String(r.parents)} parents; a case needs a single-parent commit (squash-merged history works)`;
    case "commit-not-ancestor-of-head":
      return `the fix is not an ancestor of head ${r.head}`;
    case "agent-binary-missing":
      return `the agent binary ${r.binary} was not found on PATH`;
  }
}

function describePaths(r: PathRefusal): string {
  switch (r.kind) {
    case "no-test-in-fix":
      return "the fix adds or changes no file under tests.run, so there is no oracle";
    case "fix-touches-only-tests":
      return "the fix changes only test paths, so there is nothing to revert";
    case "oracle-missing-in-world":
      return `oracle tests missing at head: ${r.paths.join(", ")}`;
    case "fix-outside-source":
      return `the fix changes paths outside source: ${r.paths.join(", ")}`;
    case "revert-touches-manifest":
      return `the revert changes a manifest or lockfile, so the copied install would not match: ${r.paths.join(", ")}`;
  }
}

function describeDeps(r: DepsRefusal): string {
  switch (r.kind) {
    case "deps-unsupported":
      return describeUnsupported(r);
    case "host-install-not-at-head":
      return `${r.lockfile} in the working copy differs from head's; reinstall at head or bump head`;
    case "deps-link-outside-world":
      return `links in the installs that leave the copy: ${r.links.join(", ")}`;
  }
}

function describeUnsupported(
  r: Extract<DepsRefusal, { kind: "deps-unsupported" }>,
): string {
  switch (r.why) {
    case "no-node-modules":
      return 'deps is "node-modules" but the checkout has no node_modules to copy';
    case "no-lockfile":
      return 'deps is "node-modules" but a root in deps.roots has no lockfile';
    case "nested-lockfile":
      return `${r.dir} has its own lockfile under a declared root; add "${r.dir}" to deps.roots`;
  }
}

const SYMPTOM_PROBLEM: Readonly<Record<SymptomRefusal["kind"], string>> = {
  "symptom-not-committed": "is not committed at head",
  "symptom-uncommitted-changes": "has uncommitted changes",
  "symptom-not-a-file": "is not a regular file at head",
  "symptom-path-escapes": "is absolute or leaves the repository",
};

function describeSymptom(r: SymptomRefusal): string {
  return `the symptom file ${r.path} ${SYMPTOM_PROBLEM[r.kind]}`;
}

function describeControl(r: ControlRefusal): string {
  switch (r.kind) {
    case "outdated":
      return `outdated: ${describeOutdated(r)}`;
    case "oracle-flaky":
      return `the oracle is flaky: red ${runs(r.red)}, gold ${runs(r.gold)}`;
    case "fix-not-reproducible-under-scoring":
      return `the fix itself fails the oracle under scoring (gold ${runs(r.gold)}); a build step or an env variable may be missing`;
    case "scoring-timed-out":
      return `the ${r.control} control hit scoringTimeoutMs (${String(r.ms)} ms)`;
  }
}

function describeOutdated(o: Outdated): string {
  switch (o.why) {
    case "revert-conflict":
      return o.files
        .map((f) => `${f.path} changed after the fix and does not revert`)
        .join("; ");
    case "build-fails-after-revert":
      return `the build exits ${String(o.exitCode)} on the reverted world`;
    case "oracle-passes-without-fix":
      return `the oracle passes without the fix: ${o.paths.join(", ")}`;
  }
}

/** `[true, false]` → `1/2`: how many runs passed. */
const runs = (results: readonly boolean[]): string =>
  `${String(results.filter(Boolean).length)}/${String(results.length)}`;
