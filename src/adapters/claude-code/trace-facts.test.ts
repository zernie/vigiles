/**
 * The trace FACTS the Claude Code adapter puts in a `Trace`: `ToolCall.shell`
 * (the `Bash` tool's command) and `Trace.skills` (the `Skill` tool's
 * activations), so a harness-neutral check reads the fact instead of the tool.
 *
 * The decoys are the six inputs on which a substring "skill fired" detector was
 * measured wrong (three false positives and one miss): only a `Skill` tool call
 * fires a skill here. The contract that both tiers ANSWER is in
 * `src/adapter-contract.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { bashCommandOf, streamSkillFacts } from "./trace-facts.js";
import { parseClaudeRun } from "../../harness-test.js";
import { parseClaudeRun as parseClaudeEvalRun } from "../../eval.js";
import { check, skill } from "../../check.js";
import type { Trace } from "../../core/eval-driver.js";
import type { ParsedRun } from "../../core/harness-driver.js";

interface Use {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly isError?: boolean;
  readonly result?: string;
}

/** A stream-json run: a `system` line, then each tool use and its result. */
function stream(...uses: Use[]): string {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    ...uses.flatMap((u, i) => [
      JSON.stringify({
        type: "assistant",
        message: {
          id: `m${String(i)}`,
          content: [
            {
              type: "tool_use",
              id: `t${String(i)}`,
              name: u.name,
              input: u.input,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `t${String(i)}`,
              content: u.result ?? "ok",
              is_error: u.isError === true,
            },
          ],
        },
      }),
    ]),
    JSON.stringify({ type: "result", result: "done", num_turns: 1 }),
  ].join("\n");
}

function traceOf(p: ParsedRun): Trace {
  return {
    toolCalls: p.toolCalls,
    hooks: p.hooks,
    output: p.output,
    modelRequests: [],
    turns: 1,
    ...(p.skills === undefined ? {} : { skills: p.skills }),
    file: () => null,
  };
}

describe("ToolCall.shell", () => {
  test("a Bash call carries its command; other tools carry none", () => {
    assert.equal(bashCommandOf("Bash", { command: "git push" }), "git push");
    assert.equal(bashCommandOf("Read", { command: "git push" }), undefined);
    assert.equal(bashCommandOf("Bash", { command: 3 }), undefined);
    const p = parseClaudeRun(
      stream(
        { name: "Bash", input: { command: "git push -f" } },
        { name: "Read", input: { file_path: "a" } },
      ),
    );
    assert.equal(p.toolCalls[0]?.shell, "git push -f");
    assert.equal("shell" in (p.toolCalls[1] ?? {}), false);
  });

  test("the eval tier's parser fills it too", () => {
    const p = parseClaudeEvalRun({
      code: 0,
      stdout: stream({ name: "Bash", input: { command: "ls" } }),
    });
    assert.equal(p.toolCalls[0]?.shell, "ls");
    assert.equal(p.skills?.observable, true);
  });
});

describe("Trace.skills — only a Skill tool call fires a skill", () => {
  test("a Skill call is a fire, and skill() passes on it", () => {
    const p = parseClaudeRun(
      stream({ name: "Skill", input: { skill: "demo:verify-citations" } }),
    );
    assert.deepEqual(p.skills, {
      observable: true,
      fired: [
        { id: "demo:verify-citations", isError: false, resultText: "ok" },
      ],
    });
    assert.equal(skill("demo:verify-citations").eval(traceOf(p)).pass, true);
  });

  test("an errored activation fails with what it returned", () => {
    const p = parseClaudeRun(
      stream({
        name: "Skill",
        input: { skill: "demo:x" },
        isError: true,
        result: "Unknown skill",
      }),
    );
    const r = skill("demo:x").eval(traceOf(p));
    assert.equal(r.pass, false);
    assert.match(r.message, /invoked but errored: Unknown skill/);
  });
});

describe("Trace.skills — the six inputs a substring detector got wrong", () => {
  const decoys: readonly [string, Use][] = [
    [
      "grepped by name",
      { name: "Grep", input: { pattern: "verify-citations" } },
    ],
    [
      "only read its SKILL.md",
      {
        name: "Read",
        input: { file_path: "skills/verify-citations/SKILL.md" },
      },
    ],
    [
      "wrote a new SKILL.md",
      {
        name: "Write",
        input: { file_path: "skills/verify-citations/SKILL.md", content: "x" },
      },
    ],
    [
      "another tool whose input has name: <skill>",
      { name: "TodoWrite", input: { name: "verify-citations" } },
    ],
    [
      "read it through Bash",
      {
        name: "Bash",
        input: { command: "cat skills/verify-citations/SKILL.md" },
      },
    ],
    // A miss no parser can recover: only the skill's EFFECTS reached the log.
    [
      "left only its effects",
      { name: "Bash", input: { command: "node verify-cites.mjs" } },
    ],
  ];
  for (const [what, use] of decoys)
    test(`not a fire: ${what}`, () => {
      const r = skill("verify-citations").eval(
        traceOf(parseClaudeRun(stream(use))),
      );
      assert.equal(r.pass, false);
      assert.match(r.message, /skills invoked: none/);
    });
});

describe("Trace.skills — a run that captured no tool calls", () => {
  test("a run that was not streamed is not observable — skill() says so, naming the harness", () => {
    const facts = streamSkillFacts(
      JSON.stringify({ type: "result", result: "done" }),
      [],
    );
    assert.equal(facts.observable, false);
    const p = parseClaudeRun(
      JSON.stringify({ type: "result", result: "done" }),
    );
    const r = skill("demo:x").eval(traceOf(p));
    assert.equal(r.pass, false);
    assert.match(r.message, /not observable on claude-code/);
    assert.match(r.message, /transcript: true/);
  });
});

describe("check.runs over a Claude Code run", () => {
  for (const command of [
    "git push --force origin main",
    "git push -f",
    `sudo git push "-f" origin main`,
    `bash -c 'git push --force'`,
  ])
    test(`a Bash force push is seen: ${command}`, () => {
      const t = traceOf(
        parseClaudeRun(stream({ name: "Bash", input: { command } })),
      );
      const r = check.runs("git push", { force: true }).eval(t);
      assert.equal(r.pass, true, r.message);
    });

  test("a non-forced push, or the words in another tool's input, is not", () => {
    const t = traceOf(
      parseClaudeRun(
        stream(
          { name: "Bash", input: { command: "git push origin main" } },
          {
            name: "Write",
            input: { file_path: "n.md", content: "git push -f" },
          },
        ),
      ),
    );
    assert.equal(check.runs("git push", { force: true }).eval(t).pass, false);
  });
});
