/**
 * Where compiled hooks and their stamps live — the one owner of these two
 * paths. A leaf module, so the writer (`compile`), the runtime and the
 * hook-line plan can all import it without importing each other.
 */

/** The directory `compile` reads hook sources from, repo-relative. */
export const HOOKS_DIR = ".vigiles/hooks";

/**
 * The stamp sidecar a hook's compile writes, as a repo-relative reference
 * (`.vigiles/hooks/<basename>.json`). `hookStampPath` resolves it; the hook-line
 * plan names it.
 */
export function hookStampRef(hookFile: string): string {
  // Either separator: a Windows path names the same sidecar.
  const base = hookFile.replace(/\\/g, "/").split("/").at(-1) ?? hookFile;
  return `${HOOKS_DIR}/${base}.json`;
}
