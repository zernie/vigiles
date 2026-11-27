/**
 * The cleanup of every trial that ran an agent, which must never throw.
 *
 * An agent can start a process that outlives it (a background `vitest` in a
 * new session) and keeps writing into the trial's temp dir. A throw from the
 * trial's `finally` would replace the score already computed and end the
 * whole run (#626). So a dir that will not go is left behind, named in one
 * warning line, and the next dir is still removed.
 *
 * Containing such a process is out of scope here: on the host runner it may
 * still have changed the tree while the trial was scored.
 */
import { removeTree, type TreeRemoval } from "./core/tmp-root.js";

/** What {@link removeTrialDirs} calls; replaced in tests. */
export interface TrialCleanupDeps {
  readonly remove: (dir: string) => TreeRemoval;
  readonly warn: (msg: string) => void;
}

const DEFAULT_DEPS: TrialCleanupDeps = {
  remove: (dir) => removeTree(dir),
  warn: (msg) => {
    console.warn(msg);
  },
};

/**
 * Remove each dir in order, skipping an absent one. List a credential copy
 * before the dir that holds it, so the secret goes first even if its dir stays.
 */
export function removeTrialDirs(
  dirs: readonly (string | undefined)[],
  deps: Partial<TrialCleanupDeps> = {},
): readonly TreeRemoval[] {
  const { remove, warn } = { ...DEFAULT_DEPS, ...deps };
  const removals = dirs
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => remove(dir));
  removals.forEach((r) => {
    if (r.kind === "left-behind") warn(leftBehindMessage(r.path, r.reason));
  });
  return removals;
}

function leftBehindMessage(path: string, reason: string): string {
  return (
    `vigiles: could not remove ${path} (${reason}): a process the agent ` +
    `started may still be writing there, and may have changed what the ` +
    `trial scored. The score is kept; delete the folder by hand.`
  );
}
