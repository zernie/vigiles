/**
 * What every linter's proof shares: the scope test, the verdict on a planted
 * pair, and the split of per-file reports into the lists a run returns.
 */
import { minimatch } from "minimatch";
import type {
  FileReport,
  Flagged,
  PairVerdict,
  ReadingScope,
} from "./types.js";

const MATCH = { dot: true } as const;

/**
 * Is `path` (relative, `/`-separated) in the scope? Dot files match, as they do
 * in a linter's own `files` patterns.
 */
export function inScope(path: string, scope: ReadingScope): boolean {
  const matches = (p: string): boolean => minimatch(path, p, MATCH);
  return scope.files.some(matches) && !scope.ignores.some(matches);
}

/** A planted file's hits, or why it gives no verdict. */
function hitsOf(file: FileReport): number | PairVerdict {
  if (file.kind === "parse-error")
    return {
      kind: "not-run",
      stage: "parse",
      reason: `${file.path}: ${file.message}`,
    };
  if (file.kind === "ignored")
    return {
      kind: "not-run",
      stage: "pair-ignored",
      reason: `${file.path}: the linter ignored the planted file`,
    };
  return file.hits;
}

/** Proved only when the bad file is flagged AND its twin is not. */
export function judgePair(bad: FileReport, good: FileReport): PairVerdict {
  const badHits = hitsOf(bad);
  if (typeof badHits !== "number") return badHits;
  const goodHits = hitsOf(good);
  if (typeof goodHits !== "number") return goodHits;
  return badHits > 0 && goodHits === 0
    ? { kind: "proved" }
    : { kind: "not-proved", badHits, goodHits };
}

/** Split per-file reports into the three lists, each sorted. */
export function summarize(files: readonly FileReport[]): Flagged {
  const paths = (keep: (f: FileReport) => boolean): readonly string[] =>
    files
      .filter(keep)
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
  return {
    linted: files.filter((f) => f.kind === "linted").length,
    flagged: paths((f) => f.kind === "linted" && f.hits > 0),
    parseErrors: paths((f) => f.kind === "parse-error"),
    ignored: paths((f) => f.kind === "ignored"),
  };
}
