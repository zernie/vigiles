/**
 * The eval spec boundary for `stubs` and `env`: parsed once, before a token is
 * spent, with messages that teach the new shape. An eval file is often plain JS,
 * so nothing type-checks the literal; this parse is the guard.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseRunEnv, parseToolStubs } from "./eval-spec-parse.js";
import { ARGV_REST } from "./stub-rules.js";

const KEEP = [".claude/.credentials.json"];

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
  const bad = (rules: unknown, re: RegExp) =>
    assert.throws(() => parseToolStubs([{ name: "gh", rules }], "runEval"), re);
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

// --- env --------------------------------------------------------------------

test("env is required: no default, and the message names both choices", () => {
  assert.throws(
    () => parseRunEnv(undefined, "runEval", KEEP),
    (e: Error) => {
      assert.match(e.message, /runEval: `env` is required/);
      assert.match(e.message, /env: \{ kind: "ephemeral" \}/);
      assert.match(e.message, /env: \{ kind: "inherit", reason: "…" \}/);
      return true;
    },
  );
});

test("ephemeral, with or without a seeded HOME; inherit with a reason", () => {
  assert.deepEqual(parseRunEnv({ kind: "ephemeral" }, "runEval", KEEP), {
    kind: "ephemeral",
  });
  assert.deepEqual(
    parseRunEnv(
      {
        kind: "ephemeral",
        home: { kind: "files", files: { ".config/x/y.txt": "z" } },
      },
      "runEval",
      KEEP,
    ),
    {
      kind: "ephemeral",
      home: { kind: "files", files: { ".config/x/y.txt": "z" } },
    },
  );
  assert.deepEqual(
    parseRunEnv({ kind: "inherit", reason: "needs my gh auth" }, "runEval", KEEP),
    { kind: "inherit", reason: "needs my gh auth" },
  );
});

test("home exists only on ephemeral: seeding it on inherit would write into your real HOME", () => {
  assert.throws(
    () =>
      parseRunEnv(
        {
          kind: "inherit",
          reason: "r",
          home: { kind: "files", files: { a: "b" } },
        },
        "runEval",
        KEEP,
      ),
    /`home` exists only on an ephemeral env: seeding would write into your real HOME/,
  );
  assert.throws(
    () => parseRunEnv({ kind: "inherit", reason: "  " }, "runEval", KEEP),
    /env\.reason/,
  );
  assert.throws(
    () => parseRunEnv({ kind: "sandbox" }, "runEval", KEEP),
    /env\.kind/,
  );
});

test("a seed path outside HOME, or over the harness's own auth file, is refused before any trial", () => {
  const seed = (path: string) =>
    parseRunEnv(
      { kind: "ephemeral", home: { kind: "files", files: { [path]: "x" } } },
      "runEval",
      KEEP,
    );
  for (const p of ["../escape", "/etc/x", "a/../../b", "", "a//b", "./a"])
    assert.throws(() => seed(p), /env\.home\.files: /);
  assert.throws(
    () => seed(".claude/.credentials.json"),
    /env\.home\.files: ".claude\/.credentials.json" is the harness's own auth file/,
  );
  assert.throws(
    () =>
      parseRunEnv(
        { kind: "ephemeral", home: { kind: "files", files: {} } },
        "runEval",
        KEEP,
      ),
    /env\.home\.files: .*no files/,
  );
});
