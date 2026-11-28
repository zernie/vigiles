/**
 * The eval spec boundary for `stubs`: parsed once, before a token is spent,
 * with messages that teach the new shape. An eval file is often plain JS,
 * so nothing type-checks the literal; this parse is the guard.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseToolStubs } from "./eval-spec-parse.js";
import { ARGV_REST } from "./stub-rules.js";

// --- stubs ------------------------------------------------------------------

test("a well-formed stub passes through, RegExp and rest intact", () => {
  const [gh] = parseToolStubs(
    [
      {
        name: "gh",
        rules: [
          {
            argv: ["issue", "create", ARGV_REST],
            contains: [/^o\/r$/],
            reply: { kind: "always", stdout: "u\n" },
          },
          {
            argv: ["api", /^repos\//],
            reply: { kind: "inOrder", answers: [{ stdout: "[]" }] },
          },
        ],
      },
    ],
    "runEval",
  );
  assert.equal(gh?.name, "gh");
  assert.ok(gh?.rules[1]?.argv[1] instanceof RegExp);
  assert.equal(gh?.rules[0]?.argv[2], ARGV_REST);
});

test("an unbranded literal from a .mjs file is accepted — the parse is the guard, not a type", () => {
  const stubs = parseToolStubs(
    [{ name: "gh", rules: [{ argv: ["x"], reply: { kind: "always" } }] }],
    "runEval",
  );
  assert.equal(stubs.length, 1);
  // `{ kind: "rest" }` written by hand is the same marker
  const [s] = parseToolStubs(
    [
      {
        name: "gh",
        rules: [{ argv: ["x", { kind: "rest" }], reply: { kind: "always" } }],
      },
    ],
    "runEval",
  );
  assert.equal(s?.rules[0]?.argv[1], ARGV_REST);
});

test("the old argv-blind shape is refused, and the rewrite is per-command rules — not a catch-all", () => {
  assert.throws(
    () =>
      parseToolStubs(
        [{ name: "gh", stdout: "https://github.com/o/r/issues/999\n" }],
        "runEval",
      ),
    (e: Error) => {
      assert.match(e.message, /stubs\[0\] \("gh"\) is the old shape/);
      assert.match(e.message, /printed one answer for EVERY invocation/);
      assert.match(
        e.message,
        /experimental_stub\("gh", \[\n\s+\{ argv: \["<command>", experimental_stub\.rest\], reply: \{ kind: "always", stdout: "https:\/\/github\.com\/o\/r\/issues\/999\\n" \} \}/,
      );
      assert.doesNotMatch(e.message, /argv: \[experimental_stub\.rest\]/);
      return true;
    },
  );
});

test("structural mistakes are refused with the path of the bad field", () => {
  const bad = (rules: unknown, re: RegExp) => {
    assert.throws(() => parseToolStubs([{ name: "gh", rules }], "runEval"), re);
  };
  bad([], /stubs\[0\]\.rules: .*at least one rule/);
  bad(
    [{ argv: [ARGV_REST, "x"], reply: { kind: "always" } }],
    /stubs\[0\]\.rules\[0\]\.argv: .*rest.*only as the last token/,
  );
  bad(
    [{ argv: ["x"], contains: ["y"], reply: { kind: "always" } }],
    /stubs\[0\]\.rules\[0\]\.contains: .*needs a trailing experimental_stub\.rest/,
  );
  bad(
    [{ argv: ["x"], reply: { kind: "inOrder", answers: [] } }],
    /stubs\[0\]\.rules\[0\]\.reply\.answers/,
  );
  bad(
    [{ argv: ["x"], reply: { kind: "always", exitCode: 256 } }],
    /stubs\[0\]\.rules\[0\]\.reply\.exitCode/,
  );
  bad(
    [{ argv: ["x"], reply: { kind: "sometimes" } }],
    /stubs\[0\]\.rules\[0\]\.reply/,
  );
  bad(
    [{ argv: ["x"], reply: { kind: "always" }, when: {} }],
    /stubs\[0\]\.rules\[0\]: .*"when"/,
  );
});

test("a RegExp with g or y is refused: test() would carry lastIndex from one call to the next", () => {
  for (const re of [/x/g, /x/y])
    assert.throws(
      () =>
        parseToolStubs(
          [{ name: "gh", rules: [{ argv: [re], reply: { kind: "always" } }] }],
          "runEval",
        ),
      /stubs\[0\]\.rules\[0\]\.argv\[0\]: .*flags g and y/,
    );
});

test("names: non-empty, no path separator, no duplicates", () => {
  const rules = [{ argv: ["x"], reply: { kind: "always" } }];
  assert.throws(
    () => parseToolStubs([{ name: "", rules }], "runEval"),
    /stubs\[0\]\.name/,
  );
  assert.throws(
    () => parseToolStubs([{ name: "bin/gh", rules }], "runEval"),
    /stubs\[0\]\.name: .*a bare binary name/,
  );
  assert.throws(
    () =>
      parseToolStubs(
        [
          { name: "gh", rules },
          { name: "gh", rules },
        ],
        "runEval",
      ),
    /two stubs named "gh"/,
  );
  assert.deepEqual(parseToolStubs(undefined, "runEval"), []);
  assert.throws(() => parseToolStubs("gh", "runEval"), /stubs: /);
});
