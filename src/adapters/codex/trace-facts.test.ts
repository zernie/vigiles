/**
 * The trace FACTS the Codex adapter puts in a `Trace`: `ToolCall.shell` (a
 * `command_execution`'s command) and `Trace.skills`, so `skill(name)` and other
 * harness-neutral checks work on Codex without knowing its stream.
 *
 * Codex has no skill-selection event; an activation shows as the model READING
 * the skill's `SKILL.md`. The logic that used to be a substring test inside
 * `codexSkillFired` now lives in the parser and reads the command with the
 * compiled-hook shell parser, so the measured false positives of a substring
 * detector — writing the file, grepping it, listing it, a sibling skill whose
 * name ends the same way — no longer count as firing. The contract that both
 * tiers ANSWER is in `src/adapter-contract.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { parseCodexEvalRun, codexSkillFired } from "./eval.js";
import { codexShell, codexSkillFires } from "./command-facts.js";
import { parseCodexRun } from "./driver.js";
import { skill } from "../../check.js";
import type { Trace } from "../../core/eval-driver.js";
import type { ToolCall } from "../../core/harness-driver.js";

/** A `codex exec --json` stream with one completed command per entry. */
function stream(...commands: string[]): string {
  return [
    `{"type":"thread.started","thread_id":"t"}`,
    `{"type":"turn.started"}`,
    ...commands.map((command, i) =>
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `item_${String(i)}`,
          type: "command_execution",
          command,
          aggregated_output: "",
          exit_code: 0,
          status: "completed",
        },
      }),
    ),
    `{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"done"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
  ].join("\n");
}

/** The eval-tier parse of `stdout` as the `Trace` a check reads. */
function traceOf(stdout: string): Trace {
  const p = parseCodexEvalRun({ stdout });
  return {
    toolCalls: p.toolCalls,
    hooks: p.hooks,
    output: p.output,
    modelRequests: [],
    turns: p.turns,
    ...(p.skills === undefined ? {} : { skills: p.skills }),
    file: () => null,
  };
}

// The real capture from codex-cli 0.139.0 (see eval.test.ts): the command is
// wrapped in `/bin/bash -lc "…"`, which the parser reads through.
const REAL_READ = `/bin/bash -lc "sed -n '1,220p' /tmp/cxreal/.codex/skills/vigiles-marker/SKILL.md"`;

describe("ToolCall.shell", () => {
  test("a command_execution carries its command as the shell fact", () => {
    const t = traceOf(stream("git status"));
    assert.equal(t.toolCalls[0]?.shell, "git status");
  });

  test("…without the `bash -lc` wrapper Codex runs it in, as Claude Code's Bash carries it", () => {
    const t = traceOf(stream(`/bin/bash -lc 'git push --force origin main'`));
    assert.equal(t.toolCalls[0]?.shell, "git push --force origin main");
    // the display name is unchanged: it is what existing traces and tests read
    assert.equal(
      t.toolCalls[0]?.name,
      `/bin/bash -lc 'git push --force origin main'`,
    );
  });
});

describe("Trace.skills — a SKILL.md read is an activation", () => {
  test("the real wrapped read fires the skill, and skill() passes on it", () => {
    const t = traceOf(stream(REAL_READ));
    assert.deepEqual(t.skills, {
      observable: true,
      fired: [{ id: "vigiles-marker", isError: false, resultText: "" }],
    });
    assert.equal(skill("vigiles-marker").eval(t).pass, true);
    assert.equal(skill("other").eval(t).pass, false);
  });

  for (const read of [
    "cat .codex/skills/x/SKILL.md",
    "head -n 40 skills/x/SKILL.md",
    "nl -ba ./x/SKILL.md | head",
    "bash -c 'cat skills/x/SKILL.md'",
  ])
    test(`a read fires: ${read}`, () => {
      assert.equal(skill("x").eval(traceOf(stream(read))).pass, true);
    });

  for (const decoy of [
    // authoring the skill is not using it
    "cat > skills/x/SKILL.md <<'EOF'\n---\nname: x\n---\nEOF",
    "echo body >> skills/x/SKILL.md",
    "tee skills/x/SKILL.md < draft.md",
    "sed -i 's/a/b/' skills/x/SKILL.md",
    // finding or listing the file is not reading it
    "grep -n description skills/x/SKILL.md",
    "ls skills/x/SKILL.md",
    // a sibling whose name ENDS in the asked name — the old substring matched it
    "cat skills/prefix-x/SKILL.md",
  ])
    test(`not an activation: ${decoy.split("\n")[0] ?? decoy}`, () => {
      const r = skill("x").eval(traceOf(stream(decoy)));
      assert.equal(r.pass, false);
      assert.match(r.message, /expected skill "x" to resolve/);
    });

  test("a skill that left only its effects is a miss no parser can recover", () => {
    // Documented, not fixed: nothing in `node verify-cites.mjs` names the skill.
    assert.equal(
      skill("verify-cites").eval(traceOf(stream("node verify-cites.mjs"))).pass,
      false,
    );
  });

  test("an empty stream is not observable, and the failure says so — not 'did not fire'", () => {
    const r = skill("x").eval(traceOf(""));
    assert.equal(r.pass, false);
    assert.match(r.message, /not observable on codex/);
    assert.doesNotMatch(r.message, /did not/);
  });
});

describe("the harness tier", () => {
  test("plain-text `codex exec` observes no skills, and skill() fails naming codex", () => {
    const p = parseCodexRun("a final answer");
    assert.equal(p.skills?.observable, false);
    const t: Trace = {
      toolCalls: p.toolCalls,
      hooks: p.hooks,
      output: p.output,
      modelRequests: [],
      turns: 1,
      ...(p.skills === undefined ? {} : { skills: p.skills }),
      file: () => null,
    };
    const r = skill("x").eval(t);
    assert.equal(r.pass, false);
    assert.match(r.message, /not observable on codex/);
    assert.match(r.message, /--json/);
  });
});

describe("codexSkillFired — the same fact, asked about one name", () => {
  test("still reads a call recorded before ToolCall.shell existed", () => {
    // Recorded traces carry the command as `name` only.
    const legacy: ToolCall = {
      name: "sed -n 1,80p .codex/skills/x/SKILL.md",
      input: {},
      resultText: "",
      isError: false,
    };
    assert.equal(codexSkillFired({ toolCalls: [legacy] }, "x"), true);
    assert.deepEqual(
      codexSkillFires([legacy]).map((f) => f.id),
      ["x"],
    );
  });
});

describe("codexShell — the command out of Codex's wrapper", () => {
  test("unwraps exactly one `<shell> -lc <script>`", () => {
    assert.equal(codexShell(`/bin/bash -lc 'git push -f'`), "git push -f");
    assert.equal(codexShell(`bash -c "ls"`), "ls");
  });
  for (const kept of [
    "git status",
    `bash -lc 'a' > out.txt`,
    `bash -lc 'a' && rm x`,
    `bash -x -c 'a'`,
  ])
    test(`leaves anything else as it was: ${kept}`, () => {
      assert.equal(codexShell(kept), kept);
    });
});
