/**
 * `isRateLimited`: a limit is read from a stream line's own error fields, and
 * nothing the agent read can decide it. The `result` lines are trimmed from
 * Claude Code 2.1.332 runs against a local server answering 429 and 529.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { isRateLimited } from "./eval-rate-limit.js";

const line = (o: object): string => JSON.stringify(o);

const RESULT_429 = line({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 429,
  api_error_type: "rate_limit_error",
  result:
    "API Error: Server is temporarily limiting requests (not your usage limit) · probe rate_limit_error",
});

const RESULT_529 = line({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 529,
  api_error_type: "overloaded_error",
});

const SUCCESS = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
});

/** A tool result whose text names every word the old pattern matched. */
const READ_A_FILE_ABOUT_LIMITS = line({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        content:
          "const RATE_LIMIT_RE = /rate limit|\\b429\\b|overloaded|too many requests/; // rate_limit_error",
      },
    ],
  },
});

test("a 429 or a 529 in the result event is a limit", () => {
  assert.ok(isRateLimited({ stdout: RESULT_429 }));
  assert.ok(isRateLimited({ stdout: RESULT_529 }));
});

test("what the agent read cannot make a finished run look limited", () => {
  // Guards: an attempt that worked is not discarded and run again because a
  // file it opened mentions HTTP 429 (the eval's own source does, 19 times).
  assert.ok(
    !isRateLimited({ stdout: [READ_A_FILE_ABOUT_LIMITS, SUCCESS].join("\n") }),
  );
});

test("the informational rate_limit_event printed on every run is not a limit", () => {
  const telemetry = line({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
  });
  assert.ok(!isRateLimited({ stdout: [telemetry, SUCCESS].join("\n") }));
});

test("the raw API error body is read by its type", () => {
  assert.ok(
    isRateLimited({ stdout: line({ error: { type: "rate_limit_error" } }) }),
  );
  assert.ok(
    !isRateLimited({ stdout: line({ error: { type: "invalid_request" } }) }),
  );
});

test("a field of another type reads as absent, not as a broken line", () => {
  // Guards: the assistant event's `error` is a string ("rate_limit"); the
  // status beside it must still be read.
  assert.ok(
    isRateLimited({
      stdout: line({ error: "rate_limit", api_error_status: 429 }),
    }),
  );
});

test("text that is not a JSON object is matched by the pattern", () => {
  assert.ok(isRateLimited({ stdout: "", stderr: "Error: 429 happened" }));
  assert.ok(isRateLimited({ stdout: "overloaded_error" }));
  assert.ok(isRateLimited({ stdout: "rate-limited, backing off" }));
  assert.ok(!isRateLimited({ stdout: "all good" }));
  // Guards: `.?` would match the `_` in the event's name.
  assert.ok(!isRateLimited({ stdout: "rate_limit_event" }));
});
