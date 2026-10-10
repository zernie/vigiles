/**
 * The pure core of a per-invocation tool stub: which rule answers an argv, what
 * it answers, and how the calls are recorded.
 *
 * The argv shapes below are the ones a real model used when it was told to file
 * an issue (`gh issue create --repo o/r --title … --body …`, once with `-R`), the
 * probes it ran first (`gh auth status`, `gh search repos …`, `gh --version`),
 * and the reads a status script made through `execFile(gh, ["api", endpoint])`.
 * The failure these tests pin down was measured: one fixed answer for every argv
 * fed an issue URL to the script's JSON reads, and the script reported a parse
 * error.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  ARGV_REST,
  answerFor,
  decideInvocation,
  decodeStub,
  describePattern,
  encodeStub,
  isUnanswered,
  matchArgv,
  parseStubLog,
  priorAnswers,
  stubLogLine,
  unansweredMessage,
  type StubCall,
  type ToolStub,
} from "./stub-rules.js";

const ISSUE_URL = "https://github.com/o/r/issues/9001\n";

const GH: ToolStub = {
  name: "gh",
  rules: [
    {
      argv: ["issue", "create", ARGV_REST],
      reply: { kind: "always", stdout: ISSUE_URL },
    },
    {
      argv: ["api", /^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\?/],
      reply: { kind: "always", stdout: "[]" },
    },
  ],
};

const MEASURED_CREATE = [
  "issue",
  "create",
  "--repo",
  "o/r",
  "--title",
  "init in a Yarn PnP repo links into node_modules that never exists",
  "--body",
  "Noted for later; not being worked on right now.",
];
const MEASURED_CREATE_SHORT = [
  "issue",
  "create",
  "-R",
  "o/r",
  "--title",
  "t",
  "--body",
  "b",
];
const FOOTER_READ = ["api", "repos/o/r/issues?state=open&per_page=100"];

// --- matching ---------------------------------------------------------------

test("a positional prefix plus rest answers the measured create, with --repo and with -R", () => {
  const rule = GH.rules[0];
  assert.equal(matchArgv(rule, MEASURED_CREATE), true);
  assert.equal(matchArgv(rule, MEASURED_CREATE_SHORT), true);
  // rest also admits zero further tokens
  assert.equal(matchArgv(rule, ["issue", "create"]), true);
  assert.equal(matchArgv(rule, ["issue", "list"]), false);
  assert.equal(matchArgv(rule, ["issue"]), false);
});

test("without rest the length is exact: the footer's read is answered, the same endpoint with a write flag is not", () => {
  const rule = GH.rules[1];
  assert.equal(matchArgv(rule, FOOTER_READ), true);
  assert.equal(
    matchArgv(rule, [...FOOTER_READ, "-f", "title=x"]),
    false,
    "a trailing -f turns a read into a write; a read rule must not answer it",
  );
  assert.equal(matchArgv(rule, ["api"]), false);
  assert.equal(matchArgv(rule, ["api", "user"]), false);
});

test("a RegExp token is tested against ONE token, never the joined line", () => {
  const rule = { argv: ["search", /^repos$/, ARGV_REST] } as const;
  assert.equal(matchArgv(rule, ["search", "repos", "vigiles"]), true);
  // the joined line "search repos vigiles" would match /repos/ anywhere
  assert.equal(matchArgv(rule, ["search", "issues", "repos"]), false);
});

test("contains: tokens after the prefix, in any order — the repo under either flag spelling", () => {
  const rule = {
    argv: ["issue", "create", ARGV_REST],
    contains: ["o/r", /^--title$/],
  } as const;
  assert.equal(matchArgv(rule, MEASURED_CREATE), true);
  assert.equal(matchArgv(rule, MEASURED_CREATE_SHORT), true);
  assert.equal(
    matchArgv(rule, ["issue", "create", "--repo", "other/r", "--title", "t"]),
    false,
  );
  // a contains token is never satisfied by the positional prefix itself
  const self = { argv: ["o/r", ARGV_REST], contains: ["o/r"] } as const;
  assert.equal(matchArgv(self, ["o/r"]), false);
  assert.equal(matchArgv(self, ["o/r", "o/r"]), true);
});

// --- deciding ---------------------------------------------------------------

test("first matching rule wins; an argv no rule matches is UNANSWERED, not answered with a default", () => {
  const none = new Map<number, number>();
  assert.deepEqual(decideInvocation(GH, none, MEASURED_CREATE), {
    kind: "answered",
    rule: 0,
    answer: 0,
  });
  assert.deepEqual(decideInvocation(GH, none, FOOTER_READ), {
    kind: "answered",
    rule: 1,
    answer: 0,
  });
  for (const probe of [
    ["auth", "status"],
    ["search", "repos", "vigiles", "--limit", "10"],
    ["--version"],
    ["issue", "list", "-R", "o/r", "--search", "Yarn PnP", "--state", "all"],
  ])
    assert.deepEqual(decideInvocation(GH, none, probe), { kind: "no-rule" });
});

test("inOrder: call k gets answer k; past the end is UNANSWERED (repetition is never the default)", () => {
  const stub: ToolStub = {
    name: "git",
    rules: [
      {
        argv: ["push", ARGV_REST],
        reply: {
          kind: "inOrder",
          answers: [{ stderr: "rejected", exitCode: 1 }, { stdout: "ok" }],
        },
      },
    ],
  };
  const at = (n: number) => decideInvocation(stub, new Map([[0, n]]), ["push"]);
  assert.deepEqual(at(0), { kind: "answered", rule: 0, answer: 0 });
  assert.deepEqual(at(1), { kind: "answered", rule: 0, answer: 1 });
  assert.deepEqual(at(2), { kind: "exhausted", rule: 0 });
  assert.deepEqual(answerFor(stub, at(1)), { stdout: "ok" });
  assert.equal(answerFor(stub, at(2)), undefined);
  assert.equal(isUnanswered(at(2)), true);
  assert.equal(isUnanswered(at(0)), false);
});

test("an always reply answers every matching call with the same answer", () => {
  const outcome = decideInvocation(GH, new Map([[0, 41]]), MEASURED_CREATE);
  assert.deepEqual(outcome, { kind: "answered", rule: 0, answer: 0 });
  assert.deepEqual(answerFor(GH, outcome), {
    kind: "always",
    stdout: ISSUE_URL,
  });
  assert.equal(answerFor(GH, { kind: "no-rule" }), undefined);
});

test("priorAnswers counts answered calls per rule of ONE tool, from the log", () => {
  const calls: StubCall[] = [
    { tool: "gh", argv: FOOTER_READ, outcome: { kind: "answered", rule: 1, answer: 0 } },
    { tool: "gh", argv: FOOTER_READ, outcome: { kind: "answered", rule: 1, answer: 0 } },
    { tool: "gh", argv: ["x"], outcome: { kind: "no-rule" } },
    { tool: "git", argv: ["push"], outcome: { kind: "answered", rule: 1, answer: 0 } },
  ];
  assert.deepEqual([...priorAnswers(calls, "gh")], [[1, 2]]);
});

// --- encoding (rules file, cache key, lock) ---------------------------------

test("encode/decode round-trips strings, RegExps and rest", () => {
  const back = decodeStub(encodeStub(GH));
  assert.equal(back.name, "gh");
  assert.equal(matchArgv(back.rules[0], MEASURED_CREATE), true);
  assert.equal(matchArgv(back.rules[1], FOOTER_READ), true);
  assert.equal(matchArgv(back.rules[1], ["api", "user"]), false);
  assert.deepEqual(back.rules[0].reply, GH.rules[0].reply);
});

test("the encoding distinguishes two RegExp tokens — JSON.stringify(/x/) is {} and would not", () => {
  const withRe = (re: RegExp): ToolStub => ({
    name: "gh",
    rules: [{ argv: ["api", re], reply: { kind: "always", stdout: "[]" } }],
  });
  assert.equal(JSON.stringify(/^repos/), "{}", "the trap the encoding avoids");
  assert.notEqual(encodeStub(withRe(/^repos/)), encodeStub(withRe(/^search/)));
  assert.notEqual(encodeStub(withRe(/^repos/)), encodeStub(withRe(/^repos/i)));
});

// --- the log ----------------------------------------------------------------

test("parseStubLog reads the JSONL the stub processes append, ignoring blank lines", () => {
  const a: StubCall = {
    tool: "gh",
    argv: ["auth", "status"],
    outcome: { kind: "no-rule" },
  };
  const b: StubCall = {
    tool: "gh",
    argv: MEASURED_CREATE,
    outcome: { kind: "answered", rule: 0, answer: 0 },
  };
  assert.deepEqual(parseStubLog(stubLogLine(a) + "\n" + stubLogLine(b)), [a, b]);
  assert.deepEqual(parseStubLog(""), []);
  assert.throws(() => parseStubLog("{not json\n"), /stub log line 1/);
});

// --- the author-facing diagnostic -------------------------------------------

test("describePattern prints tokens, RegExps and rest the way a rule is written", () => {
  assert.equal(
    describePattern(GH.rules[1].argv),
    '["api", /^repos\\/[^/]+\\/[^/]+\\/(?:issues|pulls)\\?/]',
  );
  assert.equal(
    describePattern(GH.rules[0].argv),
    '["issue", "create", experimental_stub.rest]',
  );
});

test("unansweredMessage names each argv, the rules tried, and a per-command rule to add — never a catch-all", () => {
  const calls: StubCall[] = [
    { tool: "gh", argv: ["auth", "status"], outcome: { kind: "no-rule" } },
    { tool: "gh", argv: ["auth", "status"], outcome: { kind: "no-rule" } },
    { tool: "gh", argv: FOOTER_READ, outcome: { kind: "answered", rule: 1, answer: 0 } },
    { tool: "git", argv: ["push"], outcome: { kind: "exhausted", rule: 0 } },
  ];
  const msg = unansweredMessage(calls, [GH]) ?? "";
  assert.match(msg, /3 stub call\(s\) went unanswered/);
  assert.match(msg, /gh \["auth","status"\] ×2 — no rule matches/);
  assert.match(msg, /#1 \["issue", "create", experimental_stub\.rest\]/);
  assert.match(msg, /git \["push"\] — rule #1 has no answer left/);
  assert.match(msg, /\{ argv: \["auth", "status"\], reply: \{ kind: "always", stdout: "…" \} \}/);
  assert.doesNotMatch(msg, /argv: \[experimental_stub\.rest\]/);
  assert.equal(unansweredMessage(calls.slice(2, 3), [GH]), undefined);
});
