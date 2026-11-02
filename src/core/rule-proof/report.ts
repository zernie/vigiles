/**
 * Helpers every kit uses to read its linter's JSON report: the array after any
 * banner lines, paths made repository-relative, and the one shape an unreadable
 * report takes.
 */
import { posix, relative, sep } from "node:path";
import type { LintParse } from "./types.js";

/** `file` relative to `dir`, `/`-separated. */
export const toRelative = (dir: string, file: string): string =>
  relative(dir, file).split(sep).join(posix.sep);

/**
 * The JSON array in a linter's stdout. A plugin may print banner lines first,
 * so the array starts at the first line that opens one.
 */
export function jsonArray(stdout: string): unknown {
  const start = stdout.search(/^\[/m);
  if (start === -1) return undefined;
  try {
    const value: unknown = JSON.parse(stdout.slice(start));
    return value;
  } catch {
    return undefined;
  }
}

/** Output that is not the report: never an empty list. */
export const unreadable = (stdout: string): LintParse => ({
  kind: "unreadable",
  reason: `no JSON report in the linter's output: ${stdout.slice(0, 200)}`,
});
