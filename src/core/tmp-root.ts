/**
 * The ONE way to make a temporary fixture root, with its symlinks resolved.
 *
 * ── THE TRAP THIS EXISTS TO ABOLISH (issue #241, measured) ──────────────────────
 * On macOS `os.tmpdir()` returns a path under `/var/folders/…`, and `/var` is
 * itself a symlink to `/private/var`. Node resolves a module's own URL to the
 * REALPATH but leaves `process.argv[1]`, and any path a test composed itself,
 * exactly as typed. A fixture built under `tmpdir()` therefore carries two
 * spellings of one directory, and anything comparing them is red on macOS and
 * green on Linux:
 *
 *     const d = mkdtempSync(join(tmpdir(), "probe-"));
 *     // import.meta.url → "file:///private/var/folders/…/probe.mjs"
 *     // process.argv[1] → "/var/folders/…/probe.mjs"
 *
 * A consumer hit that three times in one suite: a resolver's return value against
 * a composed expectation, an `isMain` control case, and a git fixture whose
 * repository root git reported realpath'd while the relative path was computed
 * against the other spelling (`zernie/research-paper-pipeline#9`).
 *
 * 🔴 WHY A SHIPPED HELPER AND NOT THREE FIXED CALL SITES. Those call sites were
 * hand-rolled because the product shipped nothing to roll: `mkdtempSync(join(
 * tmpdir(), …))` is the shape a harness author reaches for, and it is the shape
 * that carries the trap. Fixing our own sites leaves every future author to
 * rediscover it. So this is exported from the harness surface (`vigiles`), where
 * `recordCheck` and `skip` already live.
 *
 * 🔴 WHY ITS OWN MODULE. `core/test-utils.ts` also carries `makeSpec` and
 * `initGitRepo`, which pull in spec types and `execSync`; the runtime modules
 * that need a temp root must not drag those in. `test-utils` re-exports these two
 * so existing imports keep working, and there is still exactly one definition.
 *
 * ⚠️ On Linux `realpathSync` is the identity here, so no behavioural test on this
 * platform can hold the fix in place. What holds it is the regression test beside
 * this file, which builds its own symlink rather than relying on the platform's.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Create a temporary directory and return the path with every symlink resolved.
 *
 * The `realpathSync` wrapper is the whole point: it must stay OUTSIDE
 * `mkdtempSync`, because the directory has to exist before it can be resolved.
 *
 * @param suffix distinguishes roots in a listing; the name is `vigiles-<suffix>-*`
 *
 * @public
 */
export function makeTmpDir(suffix: string = "test"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `vigiles-${suffix}-`)));
}

/**
 * Remove a root made by {@link makeTmpDir}. Safe on a path that is already gone.
 *
 * @public
 */
export function cleanupTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** What removing one tree did: it is gone, or it is still on disk, and why. */
export type TreeRemoval =
  | { readonly kind: "removed"; readonly path: string }
  | {
      readonly kind: "left-behind";
      readonly path: string;
      /** The errno code (`ENOTEMPTY`, `EBUSY`), else the error's message; `recreated` when the delete worked and the dir came back. */
      readonly reason: string;
    };

/** The two file-system calls {@link removeTree} makes; replaced in tests. */
export interface RemoveTreeFs {
  readonly rm: (path: string) => void;
  readonly exists: (path: string) => boolean;
}

const REAL_FS: RemoveTreeFs = {
  // Node's own retry (ENOTEMPTY, EBUSY, EPERM), linear backoff. Kept short:
  // `rmSync` sleeps synchronously, so a long budget stalls every other trial.
  rm: (path) => {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  },
  exists: existsSync,
};

/**
 * Remove a tree and say what happened, never throwing. For a dir something
 * else may still be writing to: a process the agent started that outlived it.
 */
export function removeTree(
  path: string,
  fs: Partial<RemoveTreeFs> = {},
): TreeRemoval {
  const rm = fs.rm ?? REAL_FS.rm;
  const exists = fs.exists ?? REAL_FS.exists;
  const failure = failureOf(() => {
    rm(path);
  });
  if (failure !== undefined)
    return { kind: "left-behind", path, reason: failure };
  // A writer still running can rebuild the dir between the delete and here.
  return exists(path)
    ? { kind: "left-behind", path, reason: "recreated" }
    : { kind: "removed", path };
}

/** The errno code (else the message) of what `run` threw; undefined when it returned. */
function failureOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (e) {
    return reasonOf(e);
  }
}

function reasonOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return "code" in e && typeof e.code === "string" ? e.code : e.message;
}

/** What {@link removeTrees} calls; replaced in tests. */
export interface RemoveTreesDeps {
  readonly remove: (path: string) => TreeRemoval;
  readonly warn: (msg: string) => void;
}

/**
 * The cleanup of every dir an agent ran in, which must never throw.
 *
 * An agent can start a process that outlives it (a background `vitest` in a
 * new session) and keeps writing there. A throw from a trial's `finally`
 * would replace the score already computed and end the whole run (#626). So
 * each path is removed in order, an absent one skipped, and one that will not
 * go is named in one warning line without stopping the next. List a
 * credential copy before the dir that holds it, so the secret goes first.
 */
export function removeTrees(
  paths: readonly (string | undefined)[],
  deps: Partial<RemoveTreesDeps> = {},
): readonly TreeRemoval[] {
  const remove = deps.remove ?? ((path: string) => removeTree(path));
  const warn =
    deps.warn ??
    ((msg: string) => {
      console.warn(msg);
    });
  const removals = paths
    .filter((path): path is string => path !== undefined)
    .map((path) => remove(path));
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
