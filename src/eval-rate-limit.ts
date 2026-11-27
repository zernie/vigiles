/**
 * Whether a run was rate-limited or overloaded, the retry loop's one question
 * (`runWithRetry` in `eval.ts`), read so that what the agent READ cannot answer it.
 *
 * The transcript is stream-json: one JSON object per line, with every tool
 * result, file the agent opened and word the model wrote NESTED inside such a
 * line. So a line that is a JSON object is judged only by its own top-level
 * error fields, and its content is never matched. A pattern over the whole
 * stdout read the content too: a finished attempt that had opened a file
 * mentioning HTTP 429 was discarded as rate-limited and run again, up to four
 * times, and the retry wiped its tree while its processes still wrote there.
 *
 * The fields, measured on Claude Code 2.1.332 against a local server answering
 * 429 and then 529: the `result` event carries `api_error_status` (429 / 529)
 * and `api_error_type` (`rate_limit_error` / `overloaded_error`). The raw API
 * error body (`{"error":{"type":"rate_limit_error"}}`) is read the same way.
 * Text that is not a JSON object (stderr, a runner that prints plain text) is
 * still matched by the pattern; there is no structure to read.
 */
import { z } from "zod";

const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 529]);
const LIMIT_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_error",
  "overloaded_error",
]);

// The separator is `[ -]?`, not `.?`: `.` matches `_`, and the CLI's
// informational `rate_limit_event`, printed on every run, then read as a limit.
const LIMIT_TEXT =
  /rate[ -]?limit(?:ed)?\b|rate_limit_error|\b429\b|overloaded|too many requests/i;

/** A line's top-level error fields; a field of another type reads as absent. */
const ErrorFields = z.object({
  api_error_status: z.number().optional().catch(undefined),
  api_error_type: z.string().optional().catch(undefined),
  error: z.object({ type: z.string() }).optional().catch(undefined),
});

type Fields = Readonly<z.infer<typeof ErrorFields>>;

type Line =
  | { readonly kind: "event"; readonly fields: Fields }
  | { readonly kind: "text"; readonly text: string };

/** Whether a run's captured output says the model call was limited. Pure. */
export function isRateLimited(out: {
  readonly stdout: string;
  readonly stderr?: string;
}): boolean {
  return (
    LIMIT_TEXT.test(out.stderr ?? "") ||
    out.stdout.split("\n").map(readLine).some(lineLimited)
  );
}

function readLine(text: string): Line {
  const parsed = ErrorFields.safeParse(parseJson(text));
  return parsed.success
    ? { kind: "event", fields: parsed.data }
    : { kind: "text", text };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lineLimited(line: Line): boolean {
  switch (line.kind) {
    case "event":
      return eventLimited(line.fields);
    case "text":
      return LIMIT_TEXT.test(line.text);
  }
}

function eventLimited(f: Fields): boolean {
  return (
    inSet(LIMIT_STATUSES, f.api_error_status) ||
    inSet(LIMIT_TYPES, f.api_error_type) ||
    inSet(LIMIT_TYPES, f.error?.type)
  );
}

function inSet<T>(set: ReadonlySet<T>, value: T | undefined): boolean {
  return value !== undefined && set.has(value);
}
