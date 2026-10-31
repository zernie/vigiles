/**
 * Text sized in a harness's OWN unit — characters for Claude Code, bytes for
 * Codex, never tokens (`InstructionBudget.unit` says why). One function, so
 * every part of an always-loaded sum is sized the same way and the sum is one
 * number in one unit, reproducible from a commit.
 */

/** The units harnesses count always-loaded text in. */
export type HarnessUnit = "chars" | "bytes";

/**
 * Size in the harness's own unit. Bytes and chars differ on any non-ASCII text.
 *
 * Line endings are counted as `\n`. A checkout with `core.autocrlf` holds the
 * same commit with one more character per line, and a number that differs
 * between two clones of one commit cannot be committed and compared — a
 * 1 000-line file read +1 000 on Windows with no content change. The harness
 * may count the CR itself; reproducibility is worth more here than that
 * fidelity.
 */
export function sizeIn(text: string, unit: HarnessUnit): number {
  const lf = text.replaceAll("\r\n", "\n");
  return unit === "chars" ? lf.length : Buffer.byteLength(lf, "utf8");
}
