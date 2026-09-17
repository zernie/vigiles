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
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Create a temporary directory and return the path with every symlink resolved.
 *
 * The `realpathSync` wrapper is the whole point: it must stay OUTSIDE
 * `mkdtempSync`, because the directory has to exist before it can be resolved.
 *
 * @param suffix distinguishes roots in a listing; the name is `vigiles-<suffix>-*`
 */
export function makeTmpDir(suffix: string = "test"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `vigiles-${suffix}-`)));
}

/** Remove a root made by {@link makeTmpDir}. Safe on a path that is already gone. */
export function cleanupTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
