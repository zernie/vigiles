/**
 * Steps 1-4 of a regression case's pre-flight (vigiles#416; the order is in
 * `./eval-case-qualify.ts`): every refusal decidable from the repository,
 * then the patch that turns `head` into the case's world and the edits that
 * turn the world back into the fix (gold). Runs no build and no test; every
 * read of the user's checkout goes through the `CaseWorldHost` port and
 * writes nothing into it.
 */
import {
  caseDeps,
  goldRows,
  historyRefusal,
  removedPaths,
  symptomRefusal,
  type CaseDeps,
  type CaseWorldHost,
  type TreeEntry,
} from "./core/case-world.js";
import {
  driftVerdict,
  pathRefusal,
  splitFix,
  type FixSplit,
  type RegressionCaseSpec,
} from "./core/regression-case.js";
import type { RegressionCaseRefusal } from "./core/regression-case-refusal.js";
import type { TouchedRow, WorkspaceHost } from "./core/workspace.js";

/** The ports the plan reads. */
export type PlanHost = WorkspaceHost & CaseWorldHost;

/** What steps 1-4 found: everything the world is built from. */
export interface Planned {
  readonly kind: "planned";
  readonly head: string;
  readonly split: FixSplit;
  readonly deps: CaseDeps;
  /** `head` → the world: the reverted hunks, then the removals. */
  readonly patch: string;
  /** World → the fix: each reverted path as `head` has it. */
  readonly gold: readonly TouchedRow[];
  readonly markdownKeptAtHead: readonly string[];
}

/** A case refused before anything ran. */
export interface Refused {
  readonly kind: "refused";
  readonly refusal: RegressionCaseRefusal;
}

export const refused = (refusal: RegressionCaseRefusal): Refused => ({
  kind: "refused",
  refusal,
});

/** Steps 1-4: every refusal decidable from the repository, then the world patch. */
export function planWorld(
  host: PlanHost,
  top: string,
  spec: RegressionCaseSpec,
): Planned | Refused {
  const head = host.resolveCommit(top, spec.head);
  const history = historyRefusal(spec.head, {
    partialClone: host.isPartialClone(top),
    head,
    parents: host.parents(top, spec.commit),
    isAncestor: (h) => host.isAncestor(top, spec.commit, h),
  });
  if (history !== undefined || head === undefined)
    return refused(history ?? { kind: "head-not-a-commit", head: spec.head });
  const entries = host.treeEntries(top, head);
  const split = splitFix(host.fixPaths(top, spec.commit), spec.tests);
  const files = new Set(entries.filter(isRegular).map((e) => e.path));
  const paths = pathRefusal(split, {
    declaredSource: spec.source,
    atHead: (p) => files.has(p),
  });
  if (paths !== undefined) return refused(paths);
  return planAfterPaths(host, { top, head, spec, entries, split });
}

const isRegular = (e: TreeEntry): boolean =>
  e.mode === "100644" || e.mode === "100755";

interface PathsOk {
  readonly top: string;
  readonly head: string;
  readonly spec: RegressionCaseSpec;
  readonly entries: readonly TreeEntry[];
  readonly split: FixSplit;
}

/** Step 3, the symptom and the installs; then step 4. */
function planAfterPaths(host: PlanHost, p: PathsOk): Planned | Refused {
  const { top, spec, entries } = p;
  const symptomPath = spec.symptom.path;
  const symptom = symptomRefusal(
    symptomPath,
    entries.find((e) => e.path === symptomPath),
    () => host.workingBlob(top, symptomPath),
  );
  if (symptom !== undefined) return refused(symptom);
  const deps = depsOf(host, p);
  return deps.kind === "deps" ? planRevert(host, p, deps.deps) : refused(deps);
}

function depsOf(host: PlanHost, p: PathsOk): ReturnType<typeof caseDeps> {
  if (p.spec.deps.kind === "none")
    return { kind: "deps", deps: { installs: [], lockfiles: [] } };
  return caseDeps(p.spec.deps.roots ?? ["."], {
    installs: host.findInstalls(p.top, p.head),
    entries: p.entries,
    working: (path) => host.workingBlob(p.top, path),
  });
}

/** Step 4: reverse each reverted file's hunk at `head`, remove the hidden paths. */
function planRevert(
  host: PlanHost,
  p: PathsOk,
  deps: CaseDeps,
): Planned | Refused {
  const r = reverse(host, p);
  const drift = driftVerdict(r.failed);
  if (drift.kind === "outdated")
    return refused({
      kind: "outdated",
      why: "revert-conflict",
      files: drift.files,
    });
  return {
    ...{ kind: "planned", head: p.head, split: p.split, deps },
    patch: r.patch + host.removalPatch(p.top, p.head, r.removed),
    gold: goldRows(
      r.reverted.filter((path) => !r.failed.includes(path)),
      p.entries,
    ),
    markdownKeptAtHead: drift.markdownKeptAtHead,
  };
}

/** The reverted paths that are not removed anyway, each reversed alone at `head`. */
function reverse(host: PlanHost, p: PathsOk) {
  const { spec } = p;
  const removed = removedPaths(p.entries, spec.symptom.path, spec.hide ?? []);
  const reverted = p.split.reverted.filter((r) => !removed.includes(r));
  const revert = host.revertPatches(p.top, {
    commit: spec.commit,
    head: p.head,
    paths: reverted,
  });
  return { removed, reverted, ...revert };
}
