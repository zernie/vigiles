/**
 * Tests for the eval aggregation/formatting + orchestration (deterministic, no
 * model). `runEval` itself spawns the real `claude` CLI (bench/ exercises that);
 * `runEvalWith` takes an injected runner, so the loop / `measure` context /
 * aggregation are tested here against canned stream-json — no model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  cpSync as cpSyncForTest,
} from "node:fs";
import { tmpdir } from "node:os";
import { claudeCodeLiveDriver } from "./eval.js";
import type { Trace } from "./core/eval-driver.js";
import { join } from "node:path";

import {
  aggregate,
  aggregateStats,
  aggregateUsage,
  parseUsage,
  formatEvalReport,
  runEvalWith,
  runPool,
  isRateLimited,
  measureTriggerRateWith,
  measureTriggerRate,
  formatTriggerRateReport,
  measureWith,
  measureArmsWith,
  compareCheck,
  formatCheckReport,
  assertRates,
  checkReportToJUnit,
  type CheckReport,
  packageSkillsDir,
  packageInstallSet,
  stubbedPluginDir,
  stubSkillBody,
  promptDistance,
  checkPromptDiversity,
  assertPromptDiversity,
  isDatedModel,
  modelTier,
  belowModelFloor,
  runSkillSelectionTrial,
  ephemeralRunEnv,
  seedEphemeralHome,
  resolveSpawnEnv,
  EPHEMERAL_HOME_KEEP,
  type AgentRunArgs,
  type AgentRunner,
  type ParsedModelRun,
  type ModelOutputParser,
  unregisteredSkillFiles,
  spawnAgent,
} from "./eval.js";
import {
  usedTool,
  skillResolved,
  outputContains,
  assertTriggerRate,
} from "./harness-assert.js";
import { tool, output, turns, judged } from "./check.js";
import { parseIntercepts } from "./tool-intercept.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** A zero ArmUsage for TriggerRateReport fixtures (cost isn't what these assert). */
const zeroUsage = {
  totalCostUsd: 0,
  meanCostUsd: 0,
  meanDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
};

test("aggregateStats reports mean, sample std, se, and n", () => {
  const s = aggregateStats([{ x: 2 }, { x: 4 }, { x: 6 }]);
  assert.equal(s.x.mean, 4);
  assert.equal(s.x.n, 3);
  // sample std of [2,4,6] = 2
  assert.ok(Math.abs(s.x.std - 2) < 1e-9);
  assert.ok(Math.abs(s.x.se - 2 / Math.sqrt(3)) < 1e-9);
});

test("aggregateStats gives std 0 for a single observation", () => {
  const s = aggregateStats([{ x: 5 }]);
  assert.equal(s.x.std, 0);
  assert.equal(s.x.se, 0);
});

test("aggregateStats reports pass^k: 1 only when every trial succeeds", () => {
  // booleans: all true → passK 1; any false → 0
  const all = aggregateStats([{ ok: true }, { ok: true }]);
  assert.equal(all.ok.passK, 1);
  const some = aggregateStats([{ ok: true }, { ok: false }]);
  assert.equal(some.ok.passK, 0);
  // counts: a trial succeeds when > 0
  const counts = aggregateStats([{ marks: 2 }, { marks: 0 }]);
  assert.equal(counts.marks.passK, 0);
  assert.equal(aggregateStats([{ marks: 1 }, { marks: 3 }]).marks.passK, 1);
});

test("aggregate averages numbers and takes the true-fraction of booleans", () => {
  const agg = aggregate([
    { marks: 2, caught: true },
    { marks: 0, caught: false },
    { marks: 4, caught: true },
  ]);
  assert.equal(agg.marks, 2); // (2+0+4)/3
  assert.ok(Math.abs(agg.caught - 2 / 3) < 1e-9); // 2 of 3 true
});

test("aggregate tolerates missing keys across rows", () => {
  const agg = aggregate([{ a: 1 }, { b: true }]);
  assert.equal(agg.a, 1); // averaged over the 1 row that has it
  assert.equal(agg.b, 1);
});

test("runEvalWith drives arms × trials via an injected runner (no model)", async () => {
  // Canned stream-json: the `on` arm reports a Skill tool_use, a hook firing,
  // and a result with num_turns + answer; the `off` arm reports a bare result
  // (no tool / hook / num_turns / answer) — exercising both makeContext branches.
  const onStream = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
      },
    }),
    JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "Stop",
      hook_event: "Stop",
      exit_code: 0,
      outcome: "success",
      output: "",
    }),
    JSON.stringify({ type: "result", result: "answer is on", num_turns: 2 }),
  ].join("\n");
  const offStream = JSON.stringify({ type: "result" }); // no num_turns/result

  const seen: AgentRunArgs[] = [];
  const fakeRunner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: a.hasSettings ? onStream : offStream,
    });
  };

  const report = await runEvalWith(
    {
      fixture: { "a.txt": "hi" },
      arms: {
        off: {},
        on: {
          settings: {
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "true" }] }],
            },
          },
        },
      },
      task: "do it",
      trials: 2,
      spacingSec: 0,
      measure: (ctx) => ({
        used: usedTool(ctx, "Skill"),
        turns: ctx.turns,
        sawFile: ctx.file("a.txt") !== null,
        missing: ctx.file("nope.txt") === null,
        shOk: ctx.sh("echo hi") === "hi",
        // failing command WITH stdout → catch returns the partial stdout
        shPartial: ctx.sh("echo part; exit 1") === "part",
        // failing command WITHOUT stdout → catch returns ""
        shEmpty: ctx.sh("exit 7") === "",
        onArm: outputContains(ctx, "answer is on"),
      }),
    },
    fakeRunner,
  );

  assert.equal(seen.length, 4); // 2 arms × 2 trials
  assert.equal(report.arms.off?.runs, 2);
  assert.equal(report.arms.on?.runs, 2);
  // `on` arm: Skill used, 2 turns, answer present → all true (pass^k = 1)
  assert.equal(report.arms.on?.metrics.used, 1);
  assert.equal(report.arms.on?.metrics.turns, 2);
  assert.equal(report.arms.on?.stats.used?.passK, 1);
  // `off` arm: no Skill, 0 turns, no answer
  assert.equal(report.arms.off?.metrics.used, 0);
  assert.equal(report.arms.off?.metrics.turns, 0);
  // both arms: the fixture file is present, sh try/catch all hold
  assert.equal(report.arms.off?.metrics.sawFile, 1);
  assert.equal(report.arms.off?.metrics.shOk, 1);
  assert.equal(report.arms.off?.metrics.shPartial, 1);
  assert.equal(report.arms.off?.metrics.shEmpty, 1);
});

test("runEvalWith honors provided optionals (name/model/tools/timeout, arm.files)", async () => {
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  const report = await runEvalWith(
    {
      name: "custom",
      fixture: { "base.txt": "b" },
      arms: { a: { files: { "extra.txt": "e" } } }, // arm.files spread branch
      task: "t",
      trials: 1,
      model: "sonnet",
      allowedTools: ["Read"],
      timeoutMs: 1000,
      spacingSec: 0,
      measure: (ctx) => ({
        both: ctx.file("base.txt") !== null && ctx.file("extra.txt") !== null,
      }),
    },
    runner,
  );
  assert.equal(report.name, "custom"); // spec.name provided
  assert.equal(report.arms.a?.metrics.both, 1);
});

test("measureTriggerRateWith aggregates per-prompt and overall trigger rate", async () => {
  const skillStream =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", num_turns: 1 });
  const plainStream = JSON.stringify({ type: "result", num_turns: 1 });

  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    // prompts containing "fire" trigger the Skill; the rest don't
    return Promise.resolve({
      code: 0,
      stdout: a.task.includes("fire") ? skillStream : plainStream,
    });
  };

  const report = await measureTriggerRateWith(
    {
      pluginDir: "/some/plugin",
      stubSkillBodies: false, // fake dir + fake runner — use the passthrough, no FS
      prompts: ["fire one", "ignore this", "fire two"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => usedTool(t, "Skill"),
      trials: 2,
      spacingSec: 0,
    },
    runner,
  );

  assert.equal(report.n, 6); // 3 prompts × 2 trials
  assert.equal(seen.length, 6);
  assert.equal(seen[0]?.pluginDir, "/some/plugin"); // pluginDir forwarded
  assert.ok(Math.abs(report.rate - 4 / 6) < 1e-9); // 2 firing prompts × 2 trials
  const fireOne = report.perPrompt.find((p) => p.prompt === "fire one");
  assert.equal(fireOne?.fired, 2);
  assert.equal(fireOne?.rate, 1);
  const ignore = report.perPrompt.find((p) => p.prompt === "ignore this");
  assert.equal(ignore?.fired, 0);
  assert.equal(ignore?.rate, 0);
  assert.ok(formatTriggerRateReport(report).includes("trigger-rate: 67%"));
});

test("formatTriggerRateReport prints an EXPERIMENTAL caveat only when flagged", () => {
  const base = {
    rate: 0.5,
    n: 4,
    perPrompt: [],
    competitors: 0,
    usage: zeroUsage,
  };
  // Supported (Claude Code) → no caveat.
  assert.ok(!formatTriggerRateReport(base).includes("EXPERIMENTAL"));
  // Experimental (Codex) → a loud caveat above the number.
  const exp = formatTriggerRateReport({
    ...base,
    experimental: "Codex trigger-rate is experimental — no skill event.",
  });
  assert.ok(
    exp.includes("⚠ EXPERIMENTAL — Codex trigger-rate is experimental"),
  );
  assert.ok(exp.includes("trigger-rate: 50%"));
});

test("measureTriggerRateWith accepts a custom ModelOutputParser (non-Claude trace)", async () => {
  // Prove the trace-parser seam: a runner emitting a NON-Claude format + a custom
  // parser that understands it → firing is detected without any Claude stream-json.
  // This is the seam a Codex `codex exec --json` parser plugs into.
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    // a deliberately un-Claude-like line protocol
    Promise.resolve({
      code: 0,
      stdout: a.task.includes("fire") ? "CALLED:Skill:demo:test\n" : "NOOP\n",
    });
  const codexLikeParser = (out: {
    code: number;
    stdout: string;
  }): ParsedModelRun => {
    const calls = [...out.stdout.matchAll(/^CALLED:Skill:(\S+)$/gm)].map(
      (m) => ({
        name: "Skill",
        input: { skill: m[1] },
        resultText: "",
        isError: false,
      }),
    );
    return {
      turns: calls.length,
      output: out.stdout,
      toolCalls: calls,
      hooks: [],
      subagents: [],
      usage: {
        costUsd: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
  };
  const report = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["fire one", "ignore this", "fire two"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => skillResolved(t, "demo:test"),
      trials: 1,
      spacingSec: 0,
    },
    runner,
    codexLikeParser,
  );
  assert.ok(Math.abs(report.rate - 2 / 3) < 1e-9); // 2 of 3 fired, via the custom parser
});

test("measureTriggerRateWith excludes errored/rate-limited runs (not misses)", async () => {
  // A "boom" prompt errors; runError flags it. It must be dropped from n, not
  // scored as a recall-0 miss — the Codex usage-limit class of bug.
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: a.task.includes("boom") ? "RUN_ERROR" : "FIRED",
    });
  const parse: ModelOutputParser = (out) => ({
    turns: 1,
    output: out.stdout,
    toolCalls: out.stdout.includes("FIRED")
      ? [{ name: "Skill", input: {}, resultText: "", isError: false }]
      : [],
    hooks: [],
    subagents: [],
    usage: {
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  });
  const report = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["fire a", "boom b", "fire c"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => t.toolCalls.some((c) => c.name === "Skill"),
      trials: 1,
      spacingSec: 0,
    },
    runner,
    parse,
    (out) => (out.stdout.includes("RUN_ERROR") ? "errored" : null),
  );
  assert.equal(report.n, 2); // boom excluded
  assert.equal(report.errored, 1); // and surfaced
  assert.equal(report.rate, 1); // the 2 valid runs both fired
});

test("measureTriggerRate dispatches a custom { evalDriver } (the codex seam)", async () => {
  // The public entry must route runner+parse+runError from the driver.
  const report = await measureTriggerRate(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["x one", "x two", "x three"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => t.toolCalls.some((c) => c.name === "Skill"),
      trials: 1,
      spacingSec: 0,
    },
    {
      evalDriver: {
        runner: () => Promise.resolve({ code: 0, stdout: "OK" }),
        parse: (out) => ({
          turns: 1,
          output: out.stdout,
          toolCalls: [
            { name: "Skill", input: {}, resultText: "", isError: false },
          ],
          hooks: [],
          subagents: [],
          usage: {
            costUsd: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        }),
      },
    },
  );
  assert.equal(report.rate, 1); // the injected driver drove every run
  assert.equal(report.n, 3);
});

test("measureTriggerRateWith seeds `fixture` files into each run's cwd", async () => {
  const skillStream =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", num_turns: 1 });
  const plain = JSON.stringify({ type: "result", num_turns: 1 });
  // The skill "fires" iff the fixture file is on disk in the run cwd — proving
  // the context was seeded BEFORE the agent ran.
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: existsSync(join(a.cwd, "package.json")) ? skillStream : plain,
    });

  const withFixture = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["a", "b", "c"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => usedTool(t, "Skill"),
      trials: 1,
      spacingSec: 0,
      fixture: { "package.json": "{}", "src/index.js": "x" },
    },
    runner,
  );
  assert.equal(withFixture.rate, 1); // fixture present → every run fires

  const without = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["a", "b", "c"],
      minPrompts: 1,
      minDistance: 0,
      fired: (t) => usedTool(t, "Skill"),
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(without.rate, 0); // empty cwd → never fires
});

test("measureTriggerRateWith runs the grid in parallel when concurrency > 1", async () => {
  let active = 0;
  let maxActive = 0;
  const runner = async (): Promise<{ code: number; stdout: string }> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return {
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    };
  };

  const report = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["a", "b", "c", "d"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => false,
      trials: 2,
      spacingSec: 0,
      concurrency: 4,
    },
    runner,
  );

  assert.equal(report.n, 8); // 4 prompts × 2 trials all executed
  assert.deepEqual(
    report.perPrompt.map((p) => p.prompt),
    ["a", "b", "c", "d"], // aggregation preserves input order despite parallelism
  );
  assert.ok(
    maxActive > 1,
    `expected parallel runs, max concurrent was ${maxActive}`,
  );
});

test("promptDistance (NCD) is 0 for identical, larger for different, normalized", () => {
  assert.equal(promptDistance("same text", "same text"), 0);
  assert.equal(promptDistance("SAME  text", "same text"), 0); // normalized
  // a one-word-swap template is closer than two unrelated sentences
  const near = promptDistance(
    "Update the architecture section of CLAUDE.md.",
    "Update the testing section of CLAUDE.md.",
  );
  const far = promptDistance(
    "Add a dark-mode toggle to the settings page.",
    "Why is this regex throwing an exception?",
  );
  assert.ok(near < far);
  assert.ok(near < 0.3, `template pair should be < 0.3, got ${String(near)}`);
});

test("checkPromptDiversity flags too-few and too-similar sets", () => {
  // Too few (default min 10)
  const few = checkPromptDiversity(["a", "b", "c"]);
  assert.ok(few.some((i) => i.kind === "too-few"));

  // Near-duplicate pair (override min so only the NCD distance is tested)
  const dup = checkPromptDiversity(
    [
      "Write a test for my hook.",
      "Write a test for my hook!",
      "Totally different prompt here.",
    ],
    { minPrompts: 1 },
  );
  assert.ok(dup.some((i) => i.kind === "too-similar"));

  // A genuinely varied set of 10 distinct prompts passes clean.
  const varied = [
    "Add a dark-mode toggle to the settings page.",
    "Why is this regex throwing an exception?",
    "Rename the chargeCard function across the billing module.",
    "Write a unit test for the pagination helper.",
    "Refactor the auth middleware to use async/await.",
    "Document the public API in the README.",
    "Investigate the memory leak in the worker pool.",
    "Set up a GitHub Action that runs the linter on push.",
    "Convert these CommonJS modules to ESM.",
    "Optimize the SQL query behind the dashboard.",
  ];
  assert.deepEqual(checkPromptDiversity(varied), []);
});

test("assertPromptDiversity throws with an actionable message", () => {
  assert.throws(() => {
    assertPromptDiversity(["one", "two"]);
  }, /at least 10/);
});

test("measureTriggerRateWith rejects a too-small prompt set by default (no model run)", async () => {
  let calls = 0;
  const runner = (): Promise<{ code: number; stdout: string }> => {
    calls++;
    return Promise.resolve({ code: 0, stdout: "" });
  };
  await assert.rejects(
    measureTriggerRateWith(
      { pluginDir: "/p", prompts: ["just one"], fired: () => true },
      runner,
    ),
    /not eval-ready|at least 10/,
  );
  assert.equal(calls, 0, "must reject before any model run");
});

test("measureWith scores a check vocabulary across trials (rate ± se, pass^k)", async () => {
  const stream =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", result: "all done", num_turns: 1 });

  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: stream });

  const report = await measureWith(
    {
      task: "do the thing",
      checks: [tool("Bash"), output("done"), tool("Read")],
      trials: 3,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.n, 3);
  const [bash, out, read] = report.perCheck;
  assert.equal(bash.check.kind, "tool");
  assert.equal(bash.rate, 1); // Bash used every trial
  assert.equal(bash.passK, 1);
  assert.equal(out.rate, 1); // "done" in output every trial
  assert.equal(read.rate, 0); // Read never used
  assert.equal(read.passK, 0);
  assert.ok(formatCheckReport(report).includes("measured 3 run(s)"));
});

test("measureWith threads usage into the CheckReport (the cost source)", async () => {
  // Each trial's `result` event carries cost/tokens; the report must aggregate
  // them the same way runEval does, so `measure` can print the spend.
  const stream = JSON.stringify({
    type: "result",
    result: "ok",
    num_turns: 1,
  }).replace(
    /}$/,
    ',"total_cost_usd":0.02,"duration_ms":1000,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10}}',
  );
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: stream });

  const report = await measureWith(
    { task: "t", checks: [output("ok")], trials: 2, spacingSec: 0 },
    runner,
  );
  // 2 trials × $0.02 = $0.04 total, tokens summed across trials.
  assert.ok(Math.abs(report.usage.totalCostUsd - 0.04) < 1e-9);
  assert.equal(report.usage.totalInputTokens, 200);
  assert.equal(report.usage.totalOutputTokens, 100);
  assert.equal(report.usage.totalCacheReadTokens, 20);
  assert.equal(report.usage.meanDurationMs, 1000);
});

test("measureArmsWith carries each arm's usage", async () => {
  const stream = JSON.stringify({
    type: "result",
    result: "ok",
    num_turns: 1,
  }).replace(/}$/, ',"total_cost_usd":0.01,"usage":{"output_tokens":5}}');
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: stream });

  const report = await measureArmsWith(
    {
      arms: { a: {}, b: {} },
      task: "t",
      checks: [output("ok")],
      trials: 2,
      spacingSec: 0,
    },
    runner,
  );
  // Each arm ran 2 trials × $0.01.
  assert.ok(Math.abs((report.arms.a?.usage.totalCostUsd ?? 0) - 0.02) < 1e-9);
  assert.ok(Math.abs((report.arms.b?.usage.totalCostUsd ?? 0) - 0.02) < 1e-9);
  assert.equal(report.arms.a?.usage.totalOutputTokens, 10);
});

test("measureWith stubSkillBodies packages a stubbed plugin and cleans it up", async () => {
  const dir = makeTmpDir("measure-stub");
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "foo"), { recursive: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "myplug", version: "0.0.0" }),
  );
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun the expensive thing\n",
  );

  const seen: AgentRunArgs[] = [];
  let seenBody = "";
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    if (a.pluginDir)
      seenBody = readFileSync(
        join(a.pluginDir, "skills", "foo", "SKILL.md"),
        "utf-8",
      );
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  const report = await measureWith(
    {
      task: "do foo",
      pluginDir: dir,
      stubSkillBodies: true,
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.n, 1);
  // The run saw a STUBBED throwaway plugin (body gone, name preserved), removed after.
  assert.ok(seenBody.includes("description: does foo"), "frontmatter kept");
  assert.ok(!seenBody.includes("run the expensive thing"), "body stubbed");
  const used = seen[0]?.pluginDir;
  assert.ok(used && used !== dir, "a packaged plugin dir was used");
  assert.ok(!existsSync(used), "the throwaway plugin dir is removed afterward");
  cleanupTmpDir(dir);
});

// --- skillsDir on the ARM (issue #307): the loose-`.claude/skills` install source
// is resolved ONCE, in runEvalWith, so measure / measureArms / runEval all get it.

/** A loose `<dir>/.claude/skills/foo/SKILL.md` (no plugin manifest) + a runner
 *  that records what pluginDir it was handed and the SKILL.md body found there. */
function looseSkillsFixture(prefix: string): {
  dir: string;
  skills: string;
  seen: AgentRunArgs[];
  bodies: string[];
  runner: AgentRunner;
} {
  const dir = makeTmpDir(prefix);
  const skills = join(dir, ".claude", "skills");
  mkdirSync(join(skills, "foo", "references"), { recursive: true });
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun the expensive thing\n",
  );
  writeFileSync(join(skills, "foo", "references", "r.md"), "ref");
  const seen: AgentRunArgs[] = [];
  const bodies: string[] = [];
  const runner: AgentRunner = (a) => {
    seen.push(a);
    if (a.pluginDir)
      bodies.push(
        readFileSync(join(a.pluginDir, "skills", "foo", "SKILL.md"), "utf-8"),
      );
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  return { dir, skills, seen, bodies, runner };
}

test("measureWith skillsDir packages a loose .claude/skills dir (bodies intact) and cleans up", async () => {
  const f = looseSkillsFixture("measure-skillsdir");
  const report = await measureWith(
    {
      task: "do foo",
      skillsDir: f.skills,
      checks: [turns({ min: 1 })],
      trials: 2,
      spacingSec: 0,
    },
    f.runner,
  );
  assert.equal(report.n, 2);
  // The run was handed a REAL plugin dir (manifest + skills/<name>/), not the
  // loose dir, and the whole skill dir came along — a judged check needs the body.
  const used = f.seen[0]?.pluginDir;
  assert.ok(used && used !== f.skills, "a packaged plugin dir was used");
  assert.ok(f.bodies[0]?.includes("run the expensive thing"), "body kept");
  assert.ok(!existsSync(used), "the throwaway plugin dir is removed afterward");
  // The namespace the skills installed under is REPORTED — it is the `<plugin>`
  // half of the id `skill()` must match, and with skillsDir the caller never chose it.
  assert.equal(report.namespace, "vigiles-loose-skills");
  cleanupTmpDir(f.dir);
});

test("measureWith skillsDir + stubSkillBodies stubs the packaged bodies", async () => {
  const f = looseSkillsFixture("measure-skillsdir-stub");
  await measureWith(
    {
      task: "do foo",
      skillsDir: f.skills,
      stubSkillBodies: true,
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    f.runner,
  );
  assert.ok(f.bodies[0]?.includes("description: does foo"), "frontmatter kept");
  assert.ok(!f.bodies[0]?.includes("run the expensive thing"), "body stubbed");
  cleanupTmpDir(f.dir);
});

test("measureWith rejects pluginDir together with skillsDir (before any run)", async () => {
  const runner: AgentRunner = () => {
    throw new Error("runner should not run");
  };
  await assert.rejects(
    measureWith(
      {
        task: "x",
        pluginDir: "/p",
        skillsDir: "/s",
        checks: [turns({ min: 1 })],
      },
      runner,
    ),
    /not both/,
  );
});

test("runEvalWith / measureArmsWith: an ARM may name skillsDir (the resolver lives at the arm)", async () => {
  const f = looseSkillsFixture("arm-skillsdir");
  await runEvalWith(
    {
      arms: { on: { skillsDir: f.skills }, off: {} },
      task: "do foo",
      trials: 1,
      spacingSec: 0,
      measure: () => ({ ok: true }),
    },
    f.runner,
  );
  const installed = f.seen.filter((a) => a.pluginDir !== undefined);
  assert.equal(installed.length, 1, "only the `on` arm installed anything");
  assert.ok(f.bodies[0]?.includes("run the expensive thing"), "body kept");
  assert.ok(!existsSync(installed[0]?.pluginDir ?? ""), "throwaway removed");

  // And through measureArms, with per-arm namespace on each CheckReport.
  const before = f.seen.length;
  const report = await measureArmsWith(
    {
      arms: { on: { skillsDir: f.skills }, off: {} },
      task: "do foo",
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    f.runner,
  );
  assert.equal(f.seen.length - before, 2);
  assert.equal(report.arms.on?.namespace, "vigiles-loose-skills");
  assert.equal(report.arms.off?.namespace, undefined);
  cleanupTmpDir(f.dir);
});

test("CheckReport.namespace is the plugin's declared name for a pluginDir arm", async () => {
  const dir = makeTmpDir("measure-ns");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", "foo"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "myplug", version: "0.0.0" }),
  );
  writeFileSync(
    join(dir, "skills", "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\nbody\n",
  );
  const runner: AgentRunner = () =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  const report = await measureWith(
    {
      task: "t",
      pluginDir: dir,
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.namespace, "myplug");
  cleanupTmpDir(dir);
});

// --- unknown spec fields are REFUSED, not dropped (issue #307, second ask). A
// `.eval.mjs` file is plain JS: nothing type-checks the object it hands over, so a
// stray key used to vanish and the run reported a confident number about nothing.

test("measureWith refuses an unknown MeasureSpec field, with a did-you-mean", async () => {
  const runner: AgentRunner = () => {
    throw new Error("runner should not run");
  };
  const bad = {
    task: "x",
    checks: [turns({ min: 1 })],
    skillDir: "/s", // typo of skillsDir
  } as unknown as Parameters<typeof measureWith>[0];
  await assert.rejects(measureWith(bad, runner), (e: unknown) => {
    const msg = (e as Error).message;
    assert.match(msg, /measure: unknown MeasureSpec field "skillDir"/);
    assert.match(msg, /did you mean `skillsDir`/);
    return true;
  });
  // A trigger-rate-only field on measure is the case that bit: refused by name.
  const foreign = {
    task: "x",
    checks: [turns({ min: 1 })],
    prompts: ["a"],
  } as unknown as Parameters<typeof measureWith>[0];
  await assert.rejects(
    measureWith(foreign, runner),
    /unknown MeasureSpec field "prompts"/,
  );
});

test("runEvalWith refuses an unknown field on the spec AND on an arm", async () => {
  const runner: AgentRunner = () => {
    throw new Error("runner should not run");
  };
  const badArm = {
    arms: { on: { pluginDirs: "/p" } },
    task: "x",
    measure: () => ({}),
  } as unknown as Parameters<typeof runEvalWith>[0];
  await assert.rejects(
    runEvalWith(badArm, runner),
    /runEval: unknown EvalArm field "pluginDirs" on arm "on".*did you mean `pluginDir`/s,
  );
  const badSpec = {
    arms: {},
    task: "x",
    measure: () => ({}),
    checks: [],
  } as unknown as Parameters<typeof runEvalWith>[0];
  await assert.rejects(
    runEvalWith(badSpec, runner),
    /runEval: unknown EvalSpec field "checks"/,
  );
});

test("measureTriggerRateWith refuses an unknown TriggerRateSpec field", async () => {
  const runner: AgentRunner = () => {
    throw new Error("runner should not run");
  };
  const bad = {
    pluginDir: "/p",
    prompts: ["x"],
    fired: () => true,
    minPrompts: 1,
    checks: [],
  } as unknown as Parameters<typeof measureTriggerRateWith>[0];
  await assert.rejects(
    measureTriggerRateWith(bad, runner),
    /measureTriggerRate: unknown TriggerRateSpec field "checks"/,
  );
});

test("formatCheckReport: every skill() check at 0% prints the namespace diagnostic", () => {
  const zero = (id: string): CheckReport["perCheck"][number] => ({
    check: { kind: "skill", id },
    rate: 0,
    se: 0,
    passK: 0,
    n: 3,
  });
  const out = formatCheckReport({
    n: 3,
    perCheck: [
      zero("foo"),
      { ...zero("x"), check: { kind: "turns" }, rate: 1 },
    ],
    usage: zeroUsage,
    namespace: "vigiles-loose-skills",
  });
  assert.match(out, /nothing resolved for ANY skill\(\) check/);
  assert.match(out, /installed under `vigiles-loose-skills`/);
  assert.match(out, /`vigiles-loose-skills:<skill>`/);
  // Without a namespace the advice still names the namespaced form.
  const noNs = formatCheckReport({
    n: 3,
    perCheck: [zero("foo")],
    usage: zeroUsage,
  });
  assert.match(noNs, /NAMESPACED id/);
  // A PARTIAL rate is a real measurement and is left alone; so is a report with
  // no skill() check at all.
  const partial = formatCheckReport({
    n: 3,
    perCheck: [{ ...zero("foo"), rate: 0.33 }],
    usage: zeroUsage,
  });
  assert.doesNotMatch(partial, /nothing resolved/);
  const noSkill = formatCheckReport({
    n: 3,
    perCheck: [{ ...zero("x"), check: { kind: "tool", name: "Bash" } }],
    usage: zeroUsage,
  });
  assert.doesNotMatch(noSkill, /nothing resolved/);
});

test("runEvalWith honors a per-arm model override (model = a harness arm)", async () => {
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: {
        cheap: { model: "claude-haiku-4-5-20251001" }, // arm overrides
        prod: {}, // falls back to the eval-level model
      },
      task: "t",
      trials: 1,
      model: "claude-sonnet-4-6", // eval-level default
      spacingSec: 0,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const byArm = (m: string) => seen.find((a) => a.model === m);
  assert.ok(byArm("claude-haiku-4-5-20251001"), "cheap arm used its override");
  assert.ok(byArm("claude-sonnet-4-6"), "prod arm used the eval-level model");
});

test("measureWith interceptTools: auto-wires the PreToolUse hook + env round-trip", async () => {
  let seenSettings = "";
  let seenEnv: Record<string, string> | undefined;
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seenEnv = a.env;
    seenSettings = a.hasSettings
      ? readFileSync(join(a.cwd, "settings.json"), "utf-8")
      : "";
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  const report = await measureWith(
    {
      task: "push the release branch",
      // an arm hook already present → the intercept hook APPENDS, never clobbers
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "true" }] },
          ],
        },
      },
      interceptTools: [
        {
          tool: "Bash",
          when: { command: /push origin main/ },
          denyReason: "ok",
        },
      ],
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.n, 1);

  // settings.json keeps the existing hook AND appends the intercept hook (Bash).
  const settings = JSON.parse(seenSettings) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Write"); // existing, untouched
  const entry = settings.hooks.PreToolUse[1];
  assert.equal(entry.matcher, "Bash");
  assert.match(entry.hooks[0].command, /intercept-tool/);

  // the intercept list rides VIGILES_INTERCEPT_TOOLS, RegExp matcher preserved.
  const parsed = parseIntercepts(seenEnv?.VIGILES_INTERCEPT_TOOLS ?? "");
  assert.equal(parsed[0]?.tool, "Bash");
  assert.equal(parsed[0]?.denyReason, "ok");
  assert.ok(parsed[0]?.when?.command instanceof RegExp);
});

test("measureWith without interceptTools sets no intercept env or hook", async () => {
  let seenEnv: Record<string, string> | undefined;
  let hadSettings = true;
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seenEnv = a.env;
    hadSettings = a.hasSettings;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  await measureWith(
    {
      task: "do a thing",
      checks: [turns({ min: 1 })],
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(seenEnv, undefined);
  assert.equal(hadSettings, false);
});

test("isDatedModel(): dated id is honest, floating alias is not", () => {
  assert.equal(isDatedModel("claude-haiku-4-5-20251001"), true);
  assert.equal(isDatedModel("claude-3-5-sonnet-20241022"), true);
  assert.equal(isDatedModel("haiku"), false);
  assert.equal(isDatedModel("claude-sonnet-4-6"), false); // version, not a date
});

test("runEvalWith warns when an eval cache rides a floating model alias", async () => {
  const dir = makeTmpDir();
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  const base = {
    arms: { a: {} },
    task: "t",
    trials: 1,
    spacingSec: 0,
    cache: "readwrite" as const,
    cacheDir: dir,
    measure: () => ({ ok: true }),
  };

  const origEnv = process.env.GITHUB_ACTIONS;
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (m?: unknown) => logs.push(String(m));
  console.warn = (m?: unknown) => warns.push(String(m));
  try {
    // CI path: a GitHub `::warning::` annotation.
    process.env.GITHUB_ACTIONS = "true";
    await runEvalWith({ ...base, model: "haiku" }, runner);
    assert.ok(
      logs.some(
        (l) => l.startsWith("::warning::") && l.includes("floating alias"),
      ),
    );

    // Non-CI path: a plain stderr warning.
    delete process.env.GITHUB_ACTIONS;
    await runEvalWith({ ...base, model: "sonnet" }, runner);
    assert.ok(warns.some((w) => w.includes("floating alias")));

    // A dated id is honest → no warning at all.
    logs.length = 0;
    warns.length = 0;
    await runEvalWith({ ...base, model: "claude-haiku-4-5-20251001" }, runner);
    assert.equal(warns.length, 0);
    assert.equal(logs.filter((l) => l.startsWith("::warning::")).length, 0);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    if (origEnv === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = origEnv;
  }
  cleanupTmpDir(dir);
});

test("runEvalWith cache invalidates when a native pluginDir's contents change", async () => {
  const cacheDir = makeTmpDir();
  const plugin = makeTmpDir();
  writeFileSync(join(plugin, "SKILL.md"), "v1");
  let calls = 0;
  const counting = (): Promise<{ code: number; stdout: string }> => {
    calls++;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  const spec = (cache: "readwrite" | "read") => ({
    arms: { a: { pluginDir: plugin } },
    task: "t",
    trials: 1,
    spacingSec: 0,
    model: "claude-haiku-4-5-20251001", // dated → no floating-alias warning
    cache,
    cacheDir,
    measure: () => ({ ok: true }),
  });

  await runEvalWith(spec("readwrite"), counting); // record
  assert.equal(calls, 1);
  await runEvalWith(spec("read"), counting); // same content → replay, no call
  assert.equal(calls, 1);

  writeFileSync(join(plugin, "SKILL.md"), "v2"); // edit a skill in the plugin
  await runEvalWith(spec("read"), counting); // cache miss → runner called again
  assert.equal(calls, 2);

  cleanupTmpDir(cacheDir);
  cleanupTmpDir(plugin);
});

test("measureWith stubSkillBodies without pluginDir throws", async () => {
  await assert.rejects(
    measureWith(
      {
        task: "x",
        stubSkillBodies: true,
        checks: [turns({ min: 1 })],
        trials: 1,
      },
      () => Promise.resolve({ code: 0, stdout: "" }),
    ),
    /requires `pluginDir`/,
  );
});

test("measureArmsWith scores checks per arm; compareCheck reads significance", async () => {
  const skillStream =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", num_turns: 1 });
  const plain = JSON.stringify({ type: "result", num_turns: 1 });

  // `gated` arm (hasSettings) always fires the Skill; `vanilla` never does.
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: a.hasSettings ? skillStream : plain });

  const report = await measureArmsWith(
    {
      task: "do it",
      arms: {
        vanilla: {},
        gated: { settings: { hooks: {} } },
      },
      checks: [tool("Skill")],
      trials: 4,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.arms.gated.perCheck[0].rate, 1); // fires every trial
  assert.equal(report.arms.vanilla.perCheck[0].rate, 0); // never
  const cmp = compareCheck(report, "vanilla", "gated", 0);
  assert.equal(cmp.delta, 1); // gated − vanilla
  assert.equal(cmp.significant, true); // a clean 0 → 1 separation
  assert.throws(() => compareCheck(report, "nope", "gated", 0));
});

test("measureArmsWith stubSkillBodies stubs each arm's pluginDir (and cleans up)", async () => {
  const dir = makeTmpDir("arms-stub");
  // Two arms, each a plugin dir with the same skill but a different description.
  const make = (suffix: string): string => {
    const p = join(dir, suffix);
    mkdirSync(join(p, ".claude-plugin"), { recursive: true });
    mkdirSync(join(p, "skills", "foo"), { recursive: true });
    writeFileSync(
      join(p, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "myplug", version: "0.0.0" }),
    );
    writeFileSync(
      join(p, "skills", "foo", "SKILL.md"),
      `---\nname: foo\ndescription: variant ${suffix}\n---\n\n# Procedure\nrun the expensive thing ${suffix}\n`,
    );
    return p;
  };
  const armA = make("a");
  const armB = make("b");

  const bodies: Record<string, string> = {};
  const usedDirs: string[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    if (a.pluginDir) {
      usedDirs.push(a.pluginDir);
      bodies[a.pluginDir] = readFileSync(
        join(a.pluginDir, "skills", "foo", "SKILL.md"),
        "utf-8",
      );
    }
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  await measureArmsWith(
    {
      task: "do foo",
      arms: { a: { pluginDir: armA }, b: { pluginDir: armB }, plain: {} },
      stubSkillBodies: true,
      checks: [tool("Skill")],
      trials: 1,
      spacingSec: 0,
    },
    runner,
  );
  // Each arm ran against a STUBBED throwaway (body gone, description kept), not
  // the original dir, and the throwaways were removed afterward.
  for (const md of Object.values(bodies)) {
    assert.ok(md.includes("description: variant"), "description kept");
    assert.ok(!md.includes("run the expensive thing"), "body stubbed");
  }
  for (const used of usedDirs) {
    assert.ok(used !== armA && used !== armB, "a packaged dir was used");
    assert.ok(!existsSync(used), "throwaway removed afterward");
  }
  cleanupTmpDir(dir);
});

test("assertRates + checkReportToJUnit gate and serialize a CheckReport", () => {
  const report: CheckReport = {
    n: 10,
    perCheck: [
      {
        check: { kind: "tool", name: "Bash" },
        rate: 0.9,
        se: 0.1,
        passK: 0,
        n: 10,
      },
      {
        check: { kind: "skill", id: "vig:x" },
        rate: 0.4,
        se: 0.16,
        passK: 0,
        n: 10,
      },
    ],
    usage: zeroUsage,
  };
  // gate: skill at 0.4 is below 0.8 → throws naming it
  assert.throws(() => {
    assertRates(report, { min: 0.8 });
  }, /skill\(vig:x\): 40%/);
  assertRates(report, { min: 0.3 }); // both above → no throw

  const xml = checkReportToJUnit(report, { min: 0.8, name: "demo" });
  assert.match(xml, /<testsuite name="demo" tests="2" failures="1">/);
  assert.match(
    xml,
    /<testcase classname="vigiles.checks" name="tool\(Bash\)">/,
  );
  assert.match(xml, /name="skill\(vig:x\)">[\s\S]*<failure message="rate 40%/);
});

test("assertRates: `per` overrides the threshold by check kind", () => {
  const report: CheckReport = {
    n: 10,
    perCheck: [
      {
        check: { kind: "tool", name: "Bash" },
        rate: 0.9,
        se: 0.1,
        passK: 0,
        n: 10,
      },
      {
        check: { kind: "skill", id: "vig:x" },
        rate: 0.4,
        se: 0.16,
        passK: 0,
        n: 10,
      },
    ],
    usage: zeroUsage,
  };
  // A stricter per-kind threshold trips a check the global `min` would pass, and
  // the failure message reports that check's own min.
  assert.throws(() => {
    assertRates(report, { min: 0.3, per: { skill: 0.5 } });
  }, /skill\(vig:x\): 40% ± 16% \(min 50%\)/);
  // A laxer per-kind threshold lets a low check pass while a strict global `min`
  // still gates the others — one call, two thresholds.
  assertRates(report, { min: 0.8, per: { skill: 0.3 } });

  // checkReportToJUnit shares the same threshold helper, so `per` marks exactly
  // the same testcase failed — the gate and the XML can't disagree.
  const xml = checkReportToJUnit(report, { min: 0.3, per: { skill: 0.5 } });
  assert.match(xml, /failures="1"/);
  assert.match(
    xml,
    /name="skill\(vig:x\)">[\s\S]*<failure message="rate 40% below min 50%/,
  );
  assert.match(xml, /name="tool\(Bash\)"><\/testcase>/);
});

test("assertRates: throws on an empty report (a green that tested nothing)", () => {
  assert.throws(() => {
    assertRates({ n: 5, perCheck: [], usage: zeroUsage }, { min: 0.9 });
  }, /no checks to gate/);
});

test("measure: rejects stubSkillBodies paired with a judged check", async () => {
  // The runner must never be reached — the guard throws first.
  const runner = (): Promise<{ code: number; stdout: string }> => {
    throw new Error("runner should not run");
  };
  await assert.rejects(
    measureWith(
      {
        pluginDir: "/tmp/does-not-matter",
        stubSkillBodies: true,
        task: "t",
        checks: [judged("is it good")],
      },
      runner,
    ),
    /stubSkillBodies` is for firing/,
  );
});

test("formatCheckReport labels a no-arg check by its kind alone", () => {
  // checkLabel's fallback: a check with no name/id/event/path/matcher (e.g.
  // `turns`) renders as just its kind, not `kind(arg)`.
  const report: CheckReport = {
    n: 3,
    perCheck: [{ check: { kind: "turns" }, rate: 1, se: 0, passK: 1, n: 3 }],
    usage: zeroUsage,
  };
  assert.ok(formatCheckReport(report).includes("turns"));
  assert.ok(!formatCheckReport(report).includes("turns(")); // no arg parens
});

test("packageSkillsDir throws when the skills dir does not exist", () => {
  assert.throws(
    () => packageSkillsDir("/no/such/skills/dir"),
    /skillsDir not found/,
  );
});

test("packageSkillsDir follows a SYMLINKED skill directory (npm-linked skills)", () => {
  // 🔴 THE REGRESSION THIS PINS. `Dirent.isDirectory()` describes the ENTRY, not its
  // target: for a symlink to a directory it is FALSE. Skipping on it dropped symlinked
  // skills from the temp install SILENTLY — the run then fired nothing on any prompt
  // and reported 0% recall, which reads as a finding about the skill's description
  // rather than about the packaging. A symlinked skills tree is the ordinary shape
  // when skills ship as an npm package and are linked into `.claude/skills/`.
  const dir = makeTmpDir("symlinked-skill");
  const real = join(dir, "package", "beta");
  mkdirSync(real, { recursive: true });
  writeFileSync(
    join(real, "SKILL.md"),
    "---\nname: beta\ndescription: linked from a package\n---\n\n# Procedure\nrun it\n",
  );
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "alpha"), { recursive: true });
  writeFileSync(
    join(skills, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: a real directory\n---\n\n# Procedure\nrun it\n",
  );
  // The linked one, exactly as `npm`/a consumer would leave it: a RELATIVE link.
  symlinkSync(join("..", "package", "beta"), join(skills, "beta"));
  // A DANGLING link must not throw and must not count — statSync on it raises.
  symlinkSync(join("..", "package", "gone"), join(skills, "ghost"));

  const pkg = packageSkillsDir(skills);
  // Both skills present: the real directory AND the symlinked one.
  assert.ok(
    existsSync(join(pkg, "skills", "alpha", "SKILL.md")),
    "real dir missing",
  );
  assert.ok(
    existsSync(join(pkg, "skills", "beta", "SKILL.md")),
    "SYMLINKED skill missing — Dirent.isDirectory() answered about the link",
  );
  // The dangling link is simply not a skill, and it did not blow up the packaging.
  assert.ok(
    !existsSync(join(pkg, "skills", "ghost")),
    "dangling link was packaged",
  );
  // Content travelled, not just the name.
  assert.ok(
    readFileSync(join(pkg, "skills", "beta", "SKILL.md"), "utf-8").includes(
      "linked from a package",
    ),
  );
  rmSync(pkg, { recursive: true, force: true });
  cleanupTmpDir(dir);
});

test("stubbedPluginDir falls back to .claude/skills and tolerates a missing manifest", () => {
  const dir = makeTmpDir("stubbed-fallback");
  // No .claude-plugin/plugin.json (pluginName → undefined) and skills under
  // .claude/skills/ (skillsDirOf's fallback branch), not skills/.
  const skills = join(dir, ".claude", "skills", "foo");
  mkdirSync(skills, { recursive: true });
  writeFileSync(
    join(skills, "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun it\n",
  );
  // A stray NON-directory entry at the skills root — packageSkillsDir skips it.
  writeFileSync(join(dir, ".claude", "skills", "README.md"), "not a skill\n");
  const pkg = stubbedPluginDir(dir);
  const md = readFileSync(join(pkg, "skills", "foo", "SKILL.md"), "utf-8");
  assert.ok(md.includes("description: does foo")); // frontmatter kept
  assert.ok(!md.includes("run it")); // body stubbed
  // pluginName returned undefined → packageSkillsDir's default name.
  const manifest = JSON.parse(
    readFileSync(join(pkg, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { name: string };
  assert.equal(manifest.name, "vigiles-loose-skills");
  rmSync(pkg, { recursive: true, force: true });
  cleanupTmpDir(dir);
});

test("measureTriggerRateWith stubs a real pluginDir's bodies (pluginDir + stub)", async () => {
  const dir = makeTmpDir("trigger-plugindir-stub");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", "foo"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "myplug", version: "0.0.0" }),
  );
  writeFileSync(
    join(dir, "skills", "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun the expensive thing\n",
  );

  let seenBody = "";
  let usedDir = "";
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    if (a.pluginDir) {
      usedDir = a.pluginDir;
      seenBody = readFileSync(
        join(a.pluginDir, "skills", "foo", "SKILL.md"),
        "utf-8",
      );
    }
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  await measureTriggerRateWith(
    {
      pluginDir: dir,
      stubSkillBodies: true,
      prompts: ["do foo"],
      minPrompts: 1,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.ok(seenBody.includes("description: does foo"), "frontmatter kept");
  assert.ok(!seenBody.includes("run the expensive thing"), "body stubbed");
  assert.ok(usedDir && usedDir !== dir, "a packaged throwaway was used");
  assert.ok(!existsSync(usedDir), "throwaway removed afterward");
  cleanupTmpDir(dir);
});

test("packageSkillsDir builds a --plugin-dir from loose .claude/skills", () => {
  const dir = makeTmpDir("pkg-skills");
  const skills = join(dir, ".claude", "skills");
  mkdirSync(join(skills, "foo", "references"), { recursive: true });
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\nbody\n",
  );
  writeFileSync(join(skills, "foo", "references", "extra.md"), "ref\n");
  // a non-skill dir (no SKILL.md) is skipped
  mkdirSync(join(skills, "notaskill"), { recursive: true });

  const pluginDir = packageSkillsDir(skills);
  assert.ok(existsSync(join(pluginDir, ".claude-plugin", "plugin.json")));
  assert.ok(existsSync(join(pluginDir, "skills", "foo", "SKILL.md")));
  // recursive copy brings references/ along
  assert.ok(
    existsSync(join(pluginDir, "skills", "foo", "references", "extra.md")),
  );
  assert.ok(!existsSync(join(pluginDir, "skills", "notaskill")));
  const manifest = JSON.parse(
    readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { name: string };
  assert.ok(manifest.name.length > 0);
  cleanupTmpDir(dir);
});

test("stubSkillBody keeps frontmatter, drops the body", () => {
  const out = stubSkillBody(
    "---\nname: foo\ndescription: does foo\ndisable-model-invocation: false\n---\n\n# Big procedure\nStep 1: read files\nStep 2: run commands\n",
  );
  // Frontmatter (the trigger surface) survives verbatim.
  assert.ok(/^---\nname: foo\ndescription: does foo/.test(out));
  // The expensive body is gone.
  assert.ok(!out.includes("Step 1: read files"));
  assert.ok(out.includes("trigger-test stub"));
  // No frontmatter → still produces a stub (no crash).
  assert.ok(stubSkillBody("just a body, no frontmatter").includes("stub"));
});

test("packageSkillsDir { stub } writes frontmatter-only skills (no body, no references)", () => {
  const dir = makeTmpDir("pkg-stub");
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "foo", "references"), { recursive: true });
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun the whole thing\n",
  );
  writeFileSync(join(skills, "foo", "references", "big.md"), "x".repeat(5000));

  const pkg = packageSkillsDir(skills, { stub: true, name: "vigiles" });
  const md = readFileSync(join(pkg, "skills", "foo", "SKILL.md"), "utf-8");
  assert.ok(md.includes("description: does foo")); // trigger surface kept
  assert.ok(!md.includes("run the whole thing")); // body stripped
  // references/ are not copied in stub mode (the body won't run).
  assert.ok(!existsSync(join(pkg, "skills", "foo", "references")));
  // plugin name preserved so `<name>:<skill>` still matches.
  const manifest = JSON.parse(
    readFileSync(join(pkg, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { name: string };
  assert.equal(manifest.name, "vigiles");
  cleanupTmpDir(dir);
});

test("packageSkillsDir throws when the dir has no <name>/SKILL.md", () => {
  const dir = makeTmpDir("pkg-empty");
  mkdirSync(join(dir, "skills"), { recursive: true });
  assert.throws(() => packageSkillsDir(join(dir, "skills")), /No .*SKILL\.md/);
  cleanupTmpDir(dir);
});

test("measureTriggerRateWith accepts skillsDir, packaging it into a plugin dir", async () => {
  const dir = makeTmpDir("trigger-skillsdir");
  const skills = join(dir, ".claude", "skills");
  mkdirSync(join(skills, "foo"), { recursive: true });
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\nbody\n",
  );

  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  const report = await measureTriggerRateWith(
    {
      skillsDir: skills,
      prompts: ["do foo"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.n, 1);
  // The runner saw a real packaged plugin dir (not the loose skills dir), and
  // it was cleaned up after the run.
  const used = seen[0]?.pluginDir;
  assert.ok(used && used !== skills, "a packaged plugin dir was used");
  assert.ok(!existsSync(used), "the throwaway plugin dir is removed afterward");
  cleanupTmpDir(dir);
});

test("a SYMLINKED skill counts as a competitor in a real pluginDir", async () => {
  // The third site of the same defect, and the only one the installSet path cannot
  // reach: with `pluginDir` (no stub) the pool is counted on the USER'S OWN directory,
  // not on a merged temp copy, so a linked skill there is invisible to countSkills and
  // `competitors` comes back short. That number is what tells an author whether a run
  // had real selection pressure — understating it makes an isolated-looking run out of
  // a crowded one.
  const store = makeTmpDir("plugindir-store");
  for (const n of ["realOne", "linkedTwo"]) {
    mkdirSync(join(store, n), { recursive: true });
    writeFileSync(
      join(store, n, "SKILL.md"),
      `---\nname: ${n}\ndescription: does ${n}\n---\nbody\n`,
    );
  }
  const plug = makeTmpDir("plugindir-linked");
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(plug, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "myplug", version: "0.0.0" }),
  );
  const skills = join(plug, "skills");
  mkdirSync(skills, { recursive: true });
  cpSyncForTest(join(store, "realOne"), join(skills, "realOne"), {
    recursive: true,
  });
  symlinkSync(join(store, "linkedTwo"), join(skills, "linkedTwo"));

  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  const report = await measureTriggerRateWith(
    {
      pluginDir: plug,
      // 🔴 LOAD-BEARING: with the default `stubSkillBodies: true` the pool is counted
      // on a temp COPY (real directories), so the symlink never reaches countSkills.
      // Only the un-stubbed path counts the user's own directory as it lies on disk.
      stubSkillBodies: false,
      prompts: ["do it"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  // Two skills in the pool, one of them under test → exactly one competitor.
  assert.equal(
    report.competitors,
    1,
    "countSkills skipped the SYMLINKED skill — the competitor pool was understated",
  );
  cleanupTmpDir(plug);
  cleanupTmpDir(store);
});

test("installSet + the competitor count follow SYMLINKED skills too", async () => {
  // Sibling of the packageSkillsDir case: the same `Dirent.isDirectory()` defect sat
  // in copySkillsInto (the installSet merge) and in countSkills (the pool behind
  // `competitors`). Linked skills were dropped from BOTH — so a run under real
  // selection pressure reported a competitor count short by however many were linked,
  // and the missing ones could not be selected at all. Driven through the public
  // measureTriggerRateWith with a FAKE runner: no model, no key, no cost.
  const store = makeTmpDir("linked-store"); // where the package really lives
  for (const n of ["linkedFoo", "linkedBar"]) {
    mkdirSync(join(store, n), { recursive: true });
    writeFileSync(
      join(store, n, "SKILL.md"),
      `---\nname: ${n}\ndescription: does ${n}\n---\nbody\n`,
    );
  }
  const ut = makeTmpDir("ut-linked");
  symlinkSync(join(store, "linkedFoo"), join(ut, "linkedFoo"));
  const others = makeTmpDir("others-linked");
  symlinkSync(join(store, "linkedBar"), join(others, "linkedBar"));
  // A dangling link in the competitor set must be skipped, not thrown on.
  symlinkSync(join(store, "vanished"), join(others, "ghost"));

  let pluginDirSeen: string | undefined;
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    pluginDirSeen ??= a.pluginDir;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  const report = await measureTriggerRateWith(
    {
      skillsDir: ut,
      installSet: [others],
      prompts: ["do foo"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  // Both halves in one number: the under-test skill had to survive packaging AND the
  // linked competitor had to survive the merge, or this is 0.
  assert.equal(
    report.competitors,
    1,
    "a SYMLINKED skill was dropped from the competitor pool",
  );
  assert.ok(pluginDirSeen, "the runner never saw a plugin dir");
  cleanupTmpDir(others);
  cleanupTmpDir(ut);
  cleanupTmpDir(store);
});

test("packageInstallSet merges under-test + competitors (under-test wins a collision)", () => {
  const base = makeTmpDir("under-test"); // loose skills dir of the skill under test
  mkdirSync(join(base, "mine"), { recursive: true });
  writeFileSync(
    join(base, "mine", "SKILL.md"),
    "---\nname: mine\ndescription: D\n---\nUNDERTEST\n",
  );
  mkdirSync(join(base, "dup"), { recursive: true }); // collides with a competitor
  writeFileSync(
    join(base, "dup", "SKILL.md"),
    "---\nname: dup\ndescription: mine\n---\nMINE\n",
  );

  const comp = makeTmpDir("competitor"); // a plugin-shaped competitor (skills/)
  const compSkills = join(comp, "skills");
  mkdirSync(join(compSkills, "rival"), { recursive: true });
  writeFileSync(
    join(compSkills, "rival", "SKILL.md"),
    "---\nname: rival\ndescription: R\n---\nRIVAL\n",
  );
  mkdirSync(join(compSkills, "dup"), { recursive: true });
  writeFileSync(
    join(compSkills, "dup", "SKILL.md"),
    "---\nname: dup\ndescription: theirs\n---\nTHEIRS\n",
  );
  // junk the merge must skip: a stray file (non-dir) and a dir with no SKILL.md
  writeFileSync(join(compSkills, "notes.txt"), "not a skill");
  mkdirSync(join(compSkills, "empty"), { recursive: true });

  const comp2 = makeTmpDir("competitor2"); // a .claude/skills-shaped competitor
  const cc = join(comp2, ".claude", "skills");
  mkdirSync(join(cc, "extra"), { recursive: true });
  writeFileSync(
    join(cc, "extra", "SKILL.md"),
    "---\nname: extra\ndescription: E\n---\nEXTRA\n",
  );

  const { dir, added } = packageInstallSet({
    underTestSrc: base,
    name: "vigiles",
    installSet: [comp, comp2],
    stub: false,
  });
  // 'rival' (skills/) + 'extra' (.claude/skills/) added; 'dup' collided → not counted
  assert.equal(added, 2);
  assert.ok(existsSync(join(dir, "skills", "extra", "SKILL.md")));
  // named for the under-test plugin so `<name>:<skill>` ids still match `fired`
  const manifest = JSON.parse(
    readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { name: string };
  assert.equal(manifest.name, "vigiles");
  assert.ok(existsSync(join(dir, "skills", "mine", "SKILL.md")));
  assert.ok(existsSync(join(dir, "skills", "rival", "SKILL.md")));
  // the under-test 'dup' won the collision (its body, not the competitor's)
  assert.match(
    readFileSync(join(dir, "skills", "dup", "SKILL.md"), "utf-8"),
    /MINE/,
  );
  rmSync(dir, { recursive: true, force: true });
  cleanupTmpDir(base);
  cleanupTmpDir(comp);
  cleanupTmpDir(comp2);
});

test("packageInstallSet throws (and cleans up) on a missing installSet source", () => {
  const ut = makeTmpDir("ut-ok");
  mkdirSync(join(ut, "mine"), { recursive: true });
  writeFileSync(
    join(ut, "mine", "SKILL.md"),
    "---\nname: mine\ndescription: D\n---\nbody\n",
  );
  assert.throws(
    () =>
      packageInstallSet({
        underTestSrc: ut,
        name: "n",
        installSet: ["/no/such/install/source"],
        stub: false,
      }),
    /installSet source not found/,
  );
  cleanupTmpDir(ut);
});

test("packageInstallSet stubs bodies and throws on an empty under-test source", () => {
  const empty = makeTmpDir("ut-empty"); // no <name>/SKILL.md
  const comp = makeTmpDir("comp2");
  mkdirSync(join(comp, "x"), { recursive: true });
  writeFileSync(
    join(comp, "x", "SKILL.md"),
    "---\nname: x\ndescription: X\n---\nbody\n",
  );
  assert.throws(
    () =>
      packageInstallSet({
        underTestSrc: empty,
        name: "n",
        installSet: [comp],
        stub: false,
      }),
    /skill-under-test/,
  );

  const ut = makeTmpDir("ut2");
  mkdirSync(join(ut, "mine"), { recursive: true });
  writeFileSync(
    join(ut, "mine", "SKILL.md"),
    "---\nname: mine\ndescription: D\n---\nSECRET BODY\n",
  );
  const { dir } = packageInstallSet({
    underTestSrc: ut,
    name: "n",
    installSet: [comp],
    stub: true,
  });
  const md = readFileSync(join(dir, "skills", "mine", "SKILL.md"), "utf-8");
  assert.ok(md.includes("description: D") && !md.includes("SECRET BODY"));
  rmSync(dir, { recursive: true, force: true });
  cleanupTmpDir(empty);
  cleanupTmpDir(comp);
  cleanupTmpDir(ut);
});

test("measureTriggerRateWith installSet measures the whole-harness tier", async () => {
  const ut = makeTmpDir("ut-skills");
  mkdirSync(join(ut, "foo"), { recursive: true });
  writeFileSync(
    join(ut, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\nbody\n",
  );
  const others = makeTmpDir("others");
  mkdirSync(join(others, "bar"), { recursive: true });
  writeFileSync(
    join(others, "bar", "SKILL.md"),
    "---\nname: bar\ndescription: does bar\n---\nbody\n",
  );

  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };
  const report = await measureTriggerRateWith(
    {
      skillsDir: ut,
      installSet: [others],
      prompts: ["do foo"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.competitors, 1); // 'bar' co-installed as a competitor
  const used = seen[0]?.pluginDir;
  assert.ok(used && !existsSync(used), "combined plugin dir cleaned up after");
  assert.ok(formatTriggerRateReport(report).includes("whole-harness"));
  cleanupTmpDir(ut);
  cleanupTmpDir(others);
});

test("measureTriggerRateWith installSet works from a pluginDir under-test source", async () => {
  const plugin = makeTmpDir("ut-plugin"); // a real plugin (manifest + skills/)
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "vig", version: "0.0.0" }),
  );
  mkdirSync(join(plugin, "skills", "foo"), { recursive: true });
  writeFileSync(
    join(plugin, "skills", "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\nbody\n",
  );
  const others = makeTmpDir("others-p");
  mkdirSync(join(others, "bar"), { recursive: true });
  writeFileSync(
    join(others, "bar", "SKILL.md"),
    "---\nname: bar\ndescription: does bar\n---\nbody\n",
  );
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  const report = await measureTriggerRateWith(
    {
      pluginDir: plugin,
      installSet: [others],
      prompts: ["do foo"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.competitors, 1);
  cleanupTmpDir(plugin);
  cleanupTmpDir(others);
});

test("measureTriggerRateWith installSet still requires a skill-under-test source", async () => {
  const others = makeTmpDir("others-only");
  mkdirSync(join(others, "bar"), { recursive: true });
  writeFileSync(
    join(others, "bar", "SKILL.md"),
    "---\nname: bar\ndescription: does bar\n---\nbody\n",
  );
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: "" });
  await assert.rejects(
    () =>
      measureTriggerRateWith(
        {
          installSet: [others], // no pluginDir / skillsDir under test
          prompts: ["a", "b"],
          minPrompts: 1,
          minDistance: 0,
          fired: () => true,
          spacingSec: 0,
        },
        runner,
      ),
    /pluginDir.*skillsDir|provide `pluginDir`/,
  );
  cleanupTmpDir(others);
});

test("formatTriggerRateReport labels an isolated run honestly (upper-bound recall)", () => {
  const out = formatTriggerRateReport({
    rate: 1,
    n: 1,
    perPrompt: [],
    competitors: 0,
    usage: zeroUsage,
  });
  assert.ok(out.includes("isolated"));
  assert.ok(out.toLowerCase().includes("upper bound"));
});

test("modelTier ranks by family; belowModelFloor is fail-open on unknowns", () => {
  assert.equal(modelTier("haiku"), 1);
  assert.equal(modelTier("claude-haiku-4-5-20251001"), 1);
  assert.equal(modelTier("sonnet"), 2);
  assert.equal(modelTier("claude-sonnet-4-6"), 2);
  assert.equal(modelTier("opus"), 3);
  assert.equal(modelTier("some-future-model"), null); // unrankable
  // below
  assert.equal(belowModelFloor("haiku", "sonnet"), true);
  // equal / above / unknown → never "below" (fail-open)
  assert.equal(belowModelFloor("sonnet", "sonnet"), false);
  assert.equal(belowModelFloor("opus", "sonnet"), false);
  assert.equal(belowModelFloor("mystery", "sonnet"), false);
  assert.equal(belowModelFloor("haiku", "mystery"), false);
});

test("measureTriggerRateWith FAILS when the model is below the floor (default sonnet)", async () => {
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: "" });
  const base = {
    pluginDir: "/x",
    stubSkillBodies: false, // fake dir + fake runner — passthrough, no FS
    prompts: ["a", "b"],
    minPrompts: 1,
    minDistance: 0,
    fired: () => true,
    spacingSec: 0,
  };
  // haiku < default sonnet floor → throws before any run
  await assert.rejects(
    () => measureTriggerRateWith({ ...base, model: "haiku" }, runner),
    /below the minimum "sonnet"/,
  );
  // explicitly lowering the floor lets a deliberate cheap run through
  const ok = await measureTriggerRateWith(
    { ...base, model: "haiku", minModel: "haiku" },
    runner,
  );
  assert.equal(ok.n, 2); // ran (2 prompts), not blocked by the floor

  // raising the floor catches an otherwise-fine model
  await assert.rejects(
    () =>
      measureTriggerRateWith(
        { ...base, model: "sonnet", minModel: "opus" },
        runner,
      ),
    /below the minimum "opus"/,
  );
});

test("measureTriggerRateWith counts SIBLING skills as competitors (not just installSet)", async () => {
  // A multi-skill plugin with NO installSet: the under-test skill still competes
  // against its siblings, so the run must NOT be mislabeled "isolated" (the bug
  // the dogfood surfaced — competitors used to count only installSet additions).
  const dir = makeTmpDir("multi");
  const skills = join(dir, ".claude", "skills");
  for (const name of ["foo", "bar", "baz"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(
      join(skills, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: does ${name}\n---\nbody\n`,
    );
  }
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  const report = await measureTriggerRateWith(
    {
      skillsDir: skills,
      prompts: ["do foo"],
      minPrompts: 1,
      minDistance: 0,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.competitors, 2); // 3 skills installed − the one under test
  const out = formatTriggerRateReport(report);
  assert.ok(out.includes("whole-harness"));
  assert.ok(!out.includes("isolated"));
  cleanupTmpDir(dir);
});

test("measureTriggerRateWith stubSkillBodies strips the body in the packaged plugin", async () => {
  const dir = makeTmpDir("trigger-stub");
  const skills = join(dir, ".claude", "skills");
  mkdirSync(join(skills, "foo"), { recursive: true });
  writeFileSync(
    join(skills, "foo", "SKILL.md"),
    "---\nname: foo\ndescription: does foo\n---\n\n# Procedure\nrun the expensive thing\n",
  );

  let seenBody = "";
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    // Read the packaged skill DURING the run (before cleanup).
    if (a.pluginDir)
      seenBody = readFileSync(
        join(a.pluginDir, "skills", "foo", "SKILL.md"),
        "utf-8",
      );
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", num_turns: 1 }),
    });
  };

  await measureTriggerRateWith(
    {
      skillsDir: skills,
      stubSkillBodies: true,
      prompts: ["do foo"],
      minPrompts: 1,
      fired: () => true,
      spacingSec: 0,
    },
    runner,
  );
  assert.ok(seenBody.includes("description: does foo"), "frontmatter kept");
  assert.ok(!seenBody.includes("run the expensive thing"), "body stubbed");
  cleanupTmpDir(dir);
});

test("measureTriggerRateWith rejects both/neither pluginDir and skillsDir", async () => {
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: "" });
  await assert.rejects(
    measureTriggerRateWith(
      {
        pluginDir: "/p",
        skillsDir: "/s",
        prompts: ["x"],
        fired: () => true,
        minPrompts: 1,
        minDistance: 0,
      },
      runner,
    ),
    /not both/,
  );
  await assert.rejects(
    measureTriggerRateWith(
      { prompts: ["x"], fired: () => true, minPrompts: 1 },
      runner,
    ),
    /provide `pluginDir` or `skillsDir`/,
  );
});

test("measureTriggerRateWith adds precision when irrelevant prompts are given", async () => {
  const skillStream =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", num_turns: 1 });
  const plain = JSON.stringify({ type: "result", num_turns: 1 });
  // fires whenever the task mentions "fire"
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({
      code: 0,
      stdout: a.task.includes("fire") ? skillStream : plain,
    });

  const report = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["fire one", "fire two"], // both should fire → recall 1.0
      minPrompts: 1,
      minDistance: 0,
      irrelevantPrompts: ["calm down", "fire wrongly"], // one wrongly fires
      fired: (t) => usedTool(t, "Skill"),
      spacingSec: 0,
    },
    runner,
  );

  assert.equal(report.rate, 1); // recall: both relevant fired
  assert.equal(report.n, 2);
  assert.equal(report.falsePositiveRate, 0.5); // 1 of 2 irrelevant fired
  assert.ok(Math.abs((report.precision ?? 0) - 2 / 3) < 1e-9); // 2 right / 3 fired
  assert.equal(report.perIrrelevant?.length, 2);
  const out = formatTriggerRateReport(report);
  assert.ok(out.includes("false-positive: 50%"));
  assert.ok(out.includes("precision: 67%"));
  assert.ok(out.includes("[irrelevant]"));
});

test("measureTriggerRateWith: precision is undefined when nothing fires at all", async () => {
  const plain = JSON.stringify({ type: "result", num_turns: 1 });
  const runner = (): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: plain });

  const report = await measureTriggerRateWith(
    {
      pluginDir: "/p",
      stubSkillBodies: false,
      prompts: ["quiet"],
      minPrompts: 1,
      minDistance: 0,
      irrelevantPrompts: ["silent"],
      fired: (t) => usedTool(t, "Skill"),
      spacingSec: 0,
    },
    runner,
  );
  assert.equal(report.rate, 0);
  assert.equal(report.falsePositiveRate, 0);
  assert.equal(report.precision, undefined);
  assert.ok(formatTriggerRateReport(report).includes("precision: n/a"));
});

test("parseUsage pulls cost/latency/tokens from the result event", () => {
  const stdout = JSON.stringify({
    type: "result",
    total_cost_usd: 0.02,
    duration_ms: 900,
    usage: { input_tokens: 120, output_tokens: 30 },
  });
  const u = parseUsage(stdout);
  assert.equal(u.costUsd, 0.02);
  assert.equal(u.durationMs, 900);
  assert.equal(u.inputTokens, 120);
  assert.equal(u.outputTokens, 30);
});

test("parseUsage is all-zero when no result/usage is present", () => {
  const u = parseUsage("");
  assert.equal(u.costUsd, 0);
  assert.equal(u.durationMs, 0);
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.cacheCreationTokens, 0);
  assert.equal(u.cacheReadTokens, 0);
});

test("parseUsage parses cache_creation_input_tokens and cache_read_input_tokens", () => {
  const resultEvent = JSON.stringify({
    type: "result",
    num_turns: 1,
    result: "ok",
    total_cost_usd: 0.02,
    duration_ms: 800,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 250,
      cache_read_input_tokens: 400,
    },
  });
  const u = parseUsage(resultEvent);
  assert.equal(u.cacheCreationTokens, 250);
  assert.equal(u.cacheReadTokens, 400);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
});

test("parseUsage yields 0 for cache fields when absent from usage", () => {
  const resultEvent = JSON.stringify({
    type: "result",
    num_turns: 1,
    result: "ok",
    total_cost_usd: 0.01,
    duration_ms: 500,
    usage: { input_tokens: 80, output_tokens: 30 },
  });
  const u = parseUsage(resultEvent);
  assert.equal(u.cacheCreationTokens, 0);
  assert.equal(u.cacheReadTokens, 0);
});

test("aggregateUsage totals and averages cost/latency/tokens", () => {
  const u = aggregateUsage([
    {
      costUsd: 0.01,
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    {
      costUsd: 0.03,
      durationMs: 2000,
      inputTokens: 200,
      outputTokens: 150,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ]);
  assert.ok(Math.abs(u.totalCostUsd - 0.04) < 1e-9);
  assert.ok(Math.abs(u.meanCostUsd - 0.02) < 1e-9);
  assert.equal(u.meanDurationMs, 1500);
  assert.equal(u.totalInputTokens, 300);
  assert.equal(u.totalOutputTokens, 200);
});

test("aggregateUsage sums totalCacheCreationTokens and totalCacheReadTokens", () => {
  const u = aggregateUsage([
    {
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 300,
      cacheReadTokens: 100,
    },
    {
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 200,
      cacheReadTokens: 400,
    },
    {
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ]);
  assert.equal(u.totalCacheCreationTokens, 500);
  assert.equal(u.totalCacheReadTokens, 500);
});

test("aggregateUsage cache totals are zero for no runs", () => {
  const u = aggregateUsage([]);
  assert.equal(u.totalCacheCreationTokens, 0);
  assert.equal(u.totalCacheReadTokens, 0);
});

test("aggregateUsage is all-zero for no runs", () => {
  const u = aggregateUsage([]);
  assert.equal(u.totalCostUsd, 0);
  assert.equal(u.meanCostUsd, 0);
  assert.equal(u.meanDurationMs, 0);
});

test("runEvalWith record/replay cache: replays without re-calling the model", async () => {
  const cacheDir = makeTmpDir("eval-cache");
  const resultStream = JSON.stringify({
    type: "result",
    num_turns: 1,
    result: "done",
    total_cost_usd: 0.01,
    duration_ms: 1200,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  let calls = 0;
  const recordingRunner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    calls++;
    writeFileSync(join(a.cwd, "OUT.txt"), "agent output"); // a side-effect to snapshot
    return Promise.resolve({ code: 0, stdout: resultStream });
  };
  const spec = {
    fixture: { "in.txt": "x" },
    arms: { only: {} },
    task: "do it",
    trials: 2,
    spacingSec: 0,
    cacheDir,
    measure: (ctx: { file: (p: string) => string | null }) => ({
      created: ctx.file("OUT.txt") !== null,
    }),
  };
  try {
    const r1 = await runEvalWith(
      { ...spec, cache: "readwrite" as const },
      recordingRunner,
    );
    assert.equal(calls, 2); // model called for both trials
    assert.equal(r1.arms.only?.metrics.created, 1);
    assert.ok(Math.abs(r1.totalCostUsd - 0.02) < 1e-9); // 2 × $0.01
    assert.equal(r1.arms.only?.usage.totalInputTokens, 200);

    // second run, read-only, with a runner that throws if called → must replay
    const boom = (): Promise<{ code: number; stdout: string }> => {
      throw new Error("runner should not be called on a cache hit");
    };
    const r2 = await runEvalWith({ ...spec, cache: "read" as const }, boom);
    assert.equal(r2.arms.only?.metrics.created, 1); // OUT.txt restored → measure sees it
    assert.ok(Math.abs(r2.totalCostUsd - 0.02) < 1e-9); // replayed usage
  } finally {
    cleanupTmpDir(cacheDir);
  }
});

test("runPool maps with bounded concurrency, preserving order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const worker = async (n: number): Promise<number> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  };
  const out = await runPool([1, 2, 3, 4, 5], 2, worker);
  assert.deepEqual(out, [2, 4, 6, 8, 10]); // order preserved
  assert.equal(maxInFlight, 2); // never exceeded, did reach the limit
});

test("isRateLimited detects rate-limit / overload in either stream", () => {
  assert.ok(
    isRateLimited({ code: 1, stdout: "", stderr: "Error: 429 happened" }),
  );
  assert.ok(isRateLimited({ code: 1, stdout: "overloaded_error" }));
  assert.ok(isRateLimited({ code: 1, stdout: "rate limit exceeded" }));
  assert.ok(isRateLimited({ code: 1, stdout: "rate-limited, backing off" }));
  assert.ok(!isRateLimited({ code: 0, stdout: "all good" }));
});

test("isRateLimited ignores the CLI's informational rate_limit_event telemetry", () => {
  // Verbatim from a real `claude -p --output-format stream-json` run, 2026-08-13
  // (examples/experimental-emit/records/rate-limit-event.json). The CLI emits
  // this on EVERY run. `/rate.?limit/` matched it, because `.` matches `_`, so
  // every eval trial retried `retries + 1` times and only the last attempt's cost
  // was ever counted against `maxCostUsd` — measured at 8 model runs for 2 trials.
  const telemetry =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",' +
    '"resetsAt":1786648200,"rateLimitType":"five_hour","overageStatus":"rejected",' +
    '"overageDisabledReason":"org_level_disabled","isUsingOverage":false}}';
  assert.ok(!isRateLimited({ code: 0, stdout: telemetry }));
  // A real limit still retries — the API reports it under a different name.
  assert.ok(
    isRateLimited({
      code: 1,
      stdout: `${telemetry}\n{"error":{"type":"rate_limit_error"}}`,
    }),
  );
});

test("runEvalWith retries a rate-limited run, then succeeds", async () => {
  let calls = 0;
  const runner = (): Promise<{ code: number; stdout: string }> => {
    calls++;
    const stdout =
      calls === 1
        ? "rate limit exceeded"
        : JSON.stringify({ type: "result", num_turns: 1, result: "ok" });
    return Promise.resolve({ code: 0, stdout });
  };
  const report = await runEvalWith(
    {
      arms: { only: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      retryBackoffMs: 0,
      measure: (ctx) => ({ turns: ctx.turns }),
    },
    runner,
  );
  assert.equal(calls, 2); // retried once
  assert.equal(report.arms.only?.metrics.turns, 1);
});

test("runEvalWith gives up after rateLimitRetries=0 (no retry)", async () => {
  let calls = 0;
  const runner = (): Promise<{ code: number; stdout: string }> => {
    calls++;
    return Promise.resolve({ code: 0, stdout: "rate limit" });
  };
  await runEvalWith(
    {
      arms: { only: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      rateLimitRetries: 0,
      retryBackoffMs: 0,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  assert.equal(calls, 1); // gave up immediately
});

test("runEvalWith honors concurrency and inter-run spacing", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const stream = JSON.stringify({ type: "result", num_turns: 1, result: "ok" });
  const runner = async (): Promise<{ code: number; stdout: string }> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { code: 0, stdout: stream };
  };
  await runEvalWith(
    {
      arms: { a: {}, b: {} },
      task: "t",
      trials: 3,
      spacingSec: 0.001, // > 0 → exercises the spacing path
      concurrency: 3,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  assert.equal(maxInFlight, 3); // 6 units, 3 in flight at once
});

test("runEvalWith aborts when maxCostUsd is exceeded", async () => {
  const stream = JSON.stringify({
    type: "result",
    num_turns: 1,
    result: "ok",
    total_cost_usd: 0.1,
  });
  let calls = 0;
  const runner = (): Promise<{ code: number; stdout: string }> => {
    calls++;
    return Promise.resolve({ code: 0, stdout: stream });
  };
  const report = await runEvalWith(
    {
      arms: { only: {} },
      task: "t",
      trials: 5,
      spacingSec: 0,
      maxCostUsd: 0.15, // exceeded after 2 trials ($0.20)
      measure: () => ({ ok: true }),
    },
    runner,
  );
  assert.equal(report.aborted, true);
  assert.equal(calls, 2); // stopped early
  assert.equal(report.arms.only?.runs, 2); // only completed trials counted
  assert.ok(Math.abs(report.totalCostUsd - 0.2) < 1e-9);
});

test("assertTriggerRate gates on the minimum rate", () => {
  const report = {
    rate: 0.5,
    n: 4,
    perPrompt: [],
    competitors: 0,
    usage: zeroUsage,
  };
  assert.doesNotThrow(() => {
    assertTriggerRate(report, { min: 0.5 });
  });
  assert.throws(() => {
    assertTriggerRate(report, { min: 0.8 });
  });
});

test("assertTriggerRate gates precision: false-positive rate and minPrecision", () => {
  const report = {
    rate: 1,
    n: 2,
    perPrompt: [],
    falsePositiveRate: 0.5,
    precision: 0.667,
    perIrrelevant: [],
    competitors: 0,
    usage: zeroUsage,
  };
  // within both thresholds → ok
  assert.doesNotThrow(() => {
    assertTriggerRate(report, { maxFalsePositive: 0.5, minPrecision: 0.6 });
  });
  // too many false positives → throws
  assert.throws(() => {
    assertTriggerRate(report, { maxFalsePositive: 0.2 });
  }, /false-positive/);
  // precision too low → throws
  assert.throws(() => {
    assertTriggerRate(report, { minPrecision: 0.9 });
  }, /precision/);
  // precision undefined (nothing fired) reads as n/a and fails a minPrecision gate
  assert.throws(() => {
    assertTriggerRate(
      {
        rate: 0,
        n: 2,
        perPrompt: [],
        falsePositiveRate: 0,
        precision: undefined,
        competitors: 0,
        usage: zeroUsage,
      },
      { minPrecision: 0.5 },
    );
  }, /n\/a/);
});

const NO_USAGE = {
  totalCostUsd: 0,
  meanCostUsd: 0,
  meanDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
} as const;

test("formatEvalReport renders one line per arm", () => {
  const out = formatEvalReport({
    name: "demo",
    trials: 6,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      vanilla: { runs: 6, metrics: { caught: 0 }, stats: {}, usage: NO_USAGE },
      gated: { runs: 6, metrics: { caught: 0.5 }, stats: {}, usage: NO_USAGE },
    },
  });
  assert.match(out, /demo \(6 trials\/arm\)/);
  assert.match(out, /vanilla\s+caught=0\.00/);
  assert.match(out, /gated\s+caught=0\.50/);
});

test("formatEvalReport shows ± se and pass^k when stats are present", () => {
  const out = formatEvalReport({
    name: "demo",
    trials: 3,
    totalCostUsd: 0,
    aborted: false,
    arms: {
      gated: {
        runs: 3,
        metrics: { caught: 0.5 },
        stats: { caught: { mean: 0.5, std: 0.5, se: 0.25, n: 3, passK: 0 } },
        usage: NO_USAGE,
      },
    },
  });
  assert.match(out, /caught=0\.50±0\.25/);
  assert.match(out, /pass\^k=0/);
});

test("formatEvalReport surfaces cost/latency/tokens when usage is present", () => {
  const out = formatEvalReport({
    name: "demo",
    trials: 2,
    totalCostUsd: 0.05,
    aborted: false,
    arms: {
      gated: {
        runs: 2,
        metrics: { caught: 1 },
        stats: {},
        usage: {
          totalCostUsd: 0.05,
          meanCostUsd: 0.025,
          meanDurationMs: 1500,
          totalInputTokens: 2000,
          totalOutputTokens: 1400,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
        },
      },
    },
  });
  assert.match(out, /\$0\.0500 total/);
  assert.match(out, /\$0\.0500 · 1\.5s\/run · 3\.4k tok/);
});

// --- ephemeral run environment (opt-in, default OFF) -----------------------

test("ephemeralRunEnv sets a fresh HOME/TMPDIR and passes the auth allowlist", () => {
  const env = ephemeralRunEnv(
    {
      HOME: "/Users/real",
      TMPDIR: "/var/real-tmp",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-real",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: "oauth-tok",
      CLAUDE_CONFIG_DIR: "/Users/real/.claude",
    },
    { home: "/tmp/ephemeral-home" },
  );
  // Fresh HOME + TMPDIR, NOT the real ones.
  assert.equal(env.HOME, "/tmp/ephemeral-home");
  assert.equal(env.TMPDIR, "/tmp/ephemeral-home");
  // Runtime essentials survive.
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "en_US.UTF-8"); // LC_* prefix
  assert.equal(env.TERM, "xterm");
  // Auth survives — the real `claude` CLI must still authenticate.
  assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "oauth-tok");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/real/.claude"); // CLAUDE_* prefix
});

test("ephemeralRunEnv DROPS git/ssh/aws-secret and other non-allowlisted vars", () => {
  const env = ephemeralRunEnv(
    {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-real",
      // Secret-shaped / escape-the-CWD vars that must NOT leak into a run.
      GIT_AUTHOR_NAME: "real",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/id_rsa",
      GH_TOKEN: "ghp_secret",
      SSH_AUTH_SOCK: "/run/ssh-agent.sock",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      NPM_TOKEN: "npm_secret",
      SOME_RANDOM_SECRET: "x",
    },
    { home: "/tmp/h" },
  );
  // Auth + runtime kept...
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
  // ...everything secret-shaped dropped.
  for (const k of [
    "GIT_AUTHOR_NAME",
    "GIT_SSH_COMMAND",
    "GH_TOKEN",
    "SSH_AUTH_SOCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "SOME_RANDOM_SECRET",
  ]) {
    assert.equal(env[k], undefined, `${k} must be dropped`);
  }
});

test("ephemeralRunEnv keeps the opts.allow extras (e.g. VIGILES_*)", () => {
  const env = ephemeralRunEnv(
    {
      PATH: "/bin",
      VIGILES_INTERCEPT_TOOLS: "Bash",
      VIGILES_OTHER: "y",
      NOT_ALLOWED: "z",
    },
    { home: "/tmp/h", allow: ["VIGILES_INTERCEPT_TOOLS", "VIGILES_OTHER"] },
  );
  assert.equal(env.VIGILES_INTERCEPT_TOOLS, "Bash");
  assert.equal(env.VIGILES_OTHER, "y");
  // An extra NOT in the allow list is still dropped.
  assert.equal(env.NOT_ALLOWED, undefined);
});

test("ephemeralRunEnv ignores undefined values in the base env", () => {
  const env = ephemeralRunEnv(
    { PATH: "/bin", ANTHROPIC_API_KEY: undefined },
    { home: "/tmp/h" },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal("ANTHROPIC_API_KEY" in env, false);
});

test("seedEphemeralHome COPIES the auth credential file into the fresh HOME", () => {
  const realHome = makeTmpDir();
  const fakeHome = makeTmpDir();
  try {
    // Lay down a credential file under the real HOME (parent dir nested).
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".claude", ".credentials.json"), "{tok:1}");

    seedEphemeralHome(fakeHome, realHome);

    // It was COPIED (parent dir created) and the content matches.
    const dest = join(fakeHome, ".claude", ".credentials.json");
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest, "utf-8"), "{tok:1}");
  } finally {
    cleanupTmpDir(realHome);
    cleanupTmpDir(fakeHome);
  }
});

test("seedEphemeralHome skips silently when the credential file is absent", () => {
  const realHome = makeTmpDir(); // no .claude/.credentials.json
  const fakeHome = makeTmpDir();
  try {
    seedEphemeralHome(fakeHome, realHome); // must not throw
    assert.equal(
      existsSync(join(fakeHome, ".claude", ".credentials.json")),
      false,
    );
  } finally {
    cleanupTmpDir(realHome);
    cleanupTmpDir(fakeHome);
  }
});

test("seedEphemeralHome does NOT carry .gitconfig/.ssh even when present", () => {
  const realHome = makeTmpDir();
  const fakeHome = makeTmpDir();
  try {
    // The credential is carried; the secret-shaped files must NOT be.
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".claude", ".credentials.json"), "{tok:1}");
    writeFileSync(join(realHome, ".gitconfig"), "[user] name = real");
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    writeFileSync(join(realHome, ".ssh", "id_rsa"), "PRIVATE KEY");

    seedEphemeralHome(fakeHome, realHome);

    assert.equal(
      existsSync(join(fakeHome, ".claude", ".credentials.json")),
      true,
    );
    assert.equal(existsSync(join(fakeHome, ".gitconfig")), false);
    assert.equal(existsSync(join(fakeHome, ".ssh", "id_rsa")), false);
    // The keep-list is exactly the auth allowlist, nothing more.
    assert.deepEqual(EPHEMERAL_HOME_KEEP, [".claude/.credentials.json"]);
  } finally {
    cleanupTmpDir(realHome);
    cleanupTmpDir(fakeHome);
  }
});

test("ephemeralEnv DEFAULT (off): env is the byte-identical overlay, not scrubbed", async () => {
  // With the flag OFF (default), the runner is handed the legacy overlay env:
  // no `replaceEnv`, and only the intercept overlay (or undefined) — proving the
  // default path is unchanged and DOES NOT scrub the inherited environment.
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: { a: {} }, // no interceptTools, no ephemeralEnv
      task: "t",
      trials: 1,
      spacingSec: 0,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const a = seen[0];
  assert.ok(a);
  // Default: env overlay is undefined and replaceEnv is falsy — so `spawnAgent`
  // builds `{ ...process.env }`, exactly as before this feature existed.
  assert.equal(a.env, undefined);
  assert.notEqual(a.replaceEnv, true);
});

test("stubs (default env path): prepends the stub bin dir to the run's PATH", async () => {
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: { a: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      stubs: [{ name: "gh", stdout: "PR merged" }],
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const a = seen[0];
  assert.ok(a);
  // Legacy overlay path: `spawnAgent` spreads `{ ...process.env, ...a.env }`, so
  // the overlay PATH starts with the stub dir, then the real PATH.
  assert.ok(a.env, "env overlay set");
  assert.ok(
    a.env.PATH?.startsWith(a.cwd),
    `PATH "${a.env.PATH ?? "<unset>"}" starts with the trial cwd (the stub bin dir is under it)`,
  );
  assert.ok(
    process.env.PATH === undefined || a.env.PATH?.endsWith(process.env.PATH),
    "the real PATH still follows the stub dir",
  );
  assert.notEqual(a.replaceEnv, true);
});

test("stubs (ephemeral env path): prepends the stub bin dir to the scrubbed PATH", async () => {
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: { a: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      ephemeralEnv: true,
      stubs: [{ name: "psql", stdout: "row" }],
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const a = seen[0];
  assert.ok(a);
  assert.equal(a.replaceEnv, true);
  assert.ok(a.env);
  // The stub dir (under the trial cwd) is prepended ahead of the passed-through
  // real PATH in the ephemeral env.
  assert.ok(
    a.env.PATH?.startsWith(a.cwd),
    `scrubbed PATH "${a.env.PATH ?? "<unset>"}" starts with the trial cwd`,
  );
});

test("ephemeral env + interceptTools: the intercept overlay survives the scrub", async () => {
  // The one path where both features compose: a scrubbed ephemeral run env must
  // STILL carry the eval-injected VIGILES_INTERCEPT_TOOLS overlay, otherwise
  // tool interception silently breaks under `ephemeralEnv`. Proves the overlay
  // is merged onto the fresh env (eval.ts — `if (overlay) Object.assign(...)`).
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: { a: { interceptTools: [{ tool: "Bash", denyReason: "no" }] } },
      task: "t",
      trials: 1,
      spacingSec: 0,
      ephemeralEnv: true,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const a = seen[0];
  assert.ok(a);
  assert.equal(a.replaceEnv, true); // the ephemeral (scrubbed) path
  assert.ok(a.env);
  // the intercept overlay was Object.assign'd onto the scrubbed env, not lost.
  const parsed = parseIntercepts(a.env.VIGILES_INTERCEPT_TOOLS ?? "");
  assert.equal(parsed[0]?.tool, "Bash");
  assert.equal(parsed[0]?.denyReason, "no");
});

test("stubs absent: PATH is unchanged (env overlay undefined)", async () => {
  const seen: AgentRunArgs[] = [];
  const runner = (
    a: AgentRunArgs,
  ): Promise<{ code: number; stdout: string }> => {
    seen.push(a);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
    });
  };
  await runEvalWith(
    {
      arms: { a: {} },
      task: "t",
      trials: 1,
      spacingSec: 0,
      measure: () => ({ ok: true }),
    },
    runner,
  );
  const a = seen[0];
  assert.ok(a);
  // No stubs, no intercepts, no ephemeral → overlay undefined (byte-identical).
  assert.equal(a.env, undefined);
});

test("ephemeralEnv on: runner gets a replaceEnv scrubbed env with auth + allowed extras", async () => {
  process.env.VIGILES_EPHEMERAL_PROBE_SECRET = "leak-me";
  try {
    const seen: AgentRunArgs[] = [];
    const runner = (
      a: AgentRunArgs,
    ): Promise<{ code: number; stdout: string }> => {
      seen.push(a);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ type: "result", result: "r", num_turns: 1 }),
      });
    };
    await runEvalWith(
      {
        arms: { a: {} },
        task: "t",
        trials: 1,
        spacingSec: 0,
        ephemeralEnv: true,
        measure: () => ({ ok: true }),
      },
      runner,
    );
    const a = seen[0];
    assert.ok(a);
    // Ephemeral mode: env is the COMPLETE replacement env, not an overlay.
    assert.equal(a.replaceEnv, true);
    assert.ok(a.env);
    // HOME is the throwaway dir (under the trial's temp cwd), not the real one.
    assert.notEqual(a.env.HOME, process.env.HOME);
    assert.equal(a.env.HOME, a.env.TMPDIR);
    // Auth + PATH still present (so a real run still authenticates / resolves).
    assert.equal(a.env.PATH, process.env.PATH);
    // The non-allowlisted secret we planted in process.env is scrubbed.
    assert.equal(a.env.VIGILES_EPHEMERAL_PROBE_SECRET, undefined);
  } finally {
    delete process.env.VIGILES_EPHEMERAL_PROBE_SECRET;
  }
});

// The security-critical env resolution behind `ephemeralEnv` — the one line that
// actually drops the host environment — lives in `resolveSpawnEnv` (extracted
// from the v8-ignored real-spawn path so it's testable). These two tests pin the
// DECISION (pure) and the BEHAVIOUR (a real child honours the scrub).
test("resolveSpawnEnv: replaceEnv replaces (drops base), default overlays", () => {
  const base = { SECRET: "leak", PATH: "/bin", HOME: "/real" };
  // replaceEnv → EXACTLY the scrubbed env; the base (incl. SECRET) is dropped.
  const scrubbed = { PATH: "/bin", HOME: "/tmp/throwaway" };
  assert.deepEqual(resolveSpawnEnv({ env: scrubbed, replaceEnv: true }, base), {
    PATH: "/bin",
    HOME: "/tmp/throwaway",
  });
  // default (overlay) → base merged under the overlay (the pre-ephemeral path).
  const overlay = resolveSpawnEnv({ env: { X: "1" }, replaceEnv: false }, base);
  assert.equal(overlay.SECRET, "leak");
  assert.equal(overlay.X, "1");
});

test("resolveSpawnEnv: a REAL subprocess honours the scrub (secret gone, HOME redirected, ~/.ssh unreachable)", () => {
  const realHome = mkdtempSync(join(tmpdir(), "vig-realhome-"));
  const throwaway = mkdtempSync(join(tmpdir(), "vig-throwaway-"));
  try {
    // Plant a secret in the 'real' env and a private key under the real HOME.
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    writeFileSync(join(realHome, ".ssh", "id_rsa"), "PRIVATE-KEY");
    const base = {
      ...process.env,
      HOME: realHome,
      VIG_PROBE_SECRET: "leak-me",
    };
    const scrubbed = ephemeralRunEnv(base, { home: throwaway });
    const env = resolveSpawnEnv({ env: scrubbed, replaceEnv: true }, base);
    // A real node child reports what it can actually see with that env.
    const probe =
      "const fs=require('fs'),p=require('path');" +
      "process.stdout.write(JSON.stringify({" +
      "secret: process.env.VIG_PROBE_SECRET ?? null," +
      "home: process.env.HOME," +
      "sshReadable: fs.existsSync(p.join(process.env.HOME||'','.ssh','id_rsa'))" +
      "}))";
    const out = spawnSync(process.execPath, ["-e", probe], {
      env,
      encoding: "utf8",
    });
    const seen = JSON.parse(out.stdout) as {
      secret: string | null;
      home: string;
      sshReadable: boolean;
    };
    assert.equal(seen.secret, null, "planted secret must be scrubbed");
    assert.equal(seen.home, throwaway, "HOME must be the throwaway dir");
    assert.equal(
      seen.sshReadable,
      false,
      "HOME redirection must make the real ~/.ssh unreachable",
    );
  } finally {
    rmSync(realHome, { recursive: true, force: true });
    rmSync(throwaway, { recursive: true, force: true });
  }
});

// runSkillSelectionTrial — the per-run primitive behind the selection-collision
// matrix (added in adeec45). It calls whichSkillsFired internally, so these two
// fake-runner trials cover both: the success path with a deliberate tool-call mix
// (dedup + exclude errored/no-id/non-Skill) and the errored-run exclusion.
const NO_USAGE_RUN = {
  costUsd: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
} as const;

test("runSkillSelectionTrial reports which skills fired — deduped, excluding errored/no-id/non-Skill", async () => {
  const runner = (a: AgentRunArgs): Promise<{ code: number; stdout: string }> =>
    Promise.resolve({ code: 0, stdout: a.task });
  const parse: ModelOutputParser = (): ParsedModelRun => ({
    turns: 1,
    output: "",
    toolCalls: [
      {
        name: "Skill",
        input: { skill: "p:a" },
        resultText: "",
        isError: false,
      },
      {
        name: "Skill",
        input: { skill: "p:a" },
        resultText: "",
        isError: false,
      }, // dup
      { name: "Skill", input: { skill: "p:b" }, resultText: "", isError: true }, // errored → excluded
      { name: "Read", input: {}, resultText: "", isError: false }, // non-Skill → skip
      { name: "Skill", input: {}, resultText: "", isError: false }, // no id → skip
    ],
    hooks: [],
    subagents: [],
    usage: NO_USAGE_RUN,
  });
  const r = await runSkillSelectionTrial({
    prompt: "go",
    pluginDir: "/p",
    runner,
    parse,
    model: "sonnet",
    fixture: { "seed.txt": "x" }, // also exercises the fixture-seeding branch
  });
  assert.equal(r.errored, false);
  assert.deepEqual([...r.fired].sort(), ["p:a"]);
});

test("runSkillSelectionTrial flags an errored run (excluded, not a clean miss)", async () => {
  const r = await runSkillSelectionTrial({
    prompt: "x",
    pluginDir: "/p",
    runner: () => Promise.resolve({ code: 0, stdout: "BOOM" }),
    parse: (): ParsedModelRun => ({
      turns: 0,
      output: "",
      toolCalls: [],
      hooks: [],
      subagents: [],
      usage: NO_USAGE_RUN,
    }),
    model: "sonnet",
    runError: (o) => (o.stdout.includes("BOOM") ? "rate limited" : null),
  });
  assert.deepEqual(r, { fired: [], errored: true });
});

// ---- unregisteredSkillFiles: the dead-SKILL.md footgun guard --------------
// A SKILL.md dropped into a run's cwd via `files` never registers as a skill
// (only pluginDir/skillsDir do), so the arm silently measures nothing. The
// benchmark hit exactly this. High-precision: flags only a real skill file.
const SKILL_MD =
  "---\nname: caveman\ndescription: talk terse\n---\n\nRespond terse.";

test("unregisteredSkillFiles flags a SKILL.md with skill frontmatter", () => {
  assert.deepEqual(unregisteredSkillFiles({ "SKILL.md": SKILL_MD }), [
    "SKILL.md",
  ]);
  // nested path, same basename
  assert.deepEqual(unregisteredSkillFiles({ "skills/x/SKILL.md": SKILL_MD }), [
    "skills/x/SKILL.md",
  ]);
});

test("unregisteredSkillFiles does NOT flag CLAUDE.md (auto-loaded) or a scratch SKILL.md", () => {
  // CLAUDE.md IS loaded as project memory — legitimate via `files`.
  assert.deepEqual(unregisteredSkillFiles({ "CLAUDE.md": SKILL_MD }), []);
  // an empty scratch SKILL.md a task is asked to AUTHOR (no frontmatter) — no cry wolf.
  assert.deepEqual(
    unregisteredSkillFiles({ "SKILL.md": "# scratch\n\ntodo" }),
    [],
  );
  // a SKILL.md-named file whose --- block carries no name/description.
  assert.deepEqual(
    unregisteredSkillFiles({ "SKILL.md": "---\nfoo: bar\n---\nbody" }),
    [],
  );
  assert.deepEqual(unregisteredSkillFiles(undefined), []);
});

test("formatTriggerRateReport: a TOTAL zero names the setup causes, not the description", () => {
  // Measured 2026-08-11 while building a consumer's trigger suite: three separate
  // wiring mistakes each produced a confident, well-formed 0%, and two were
  // briefly written up as findings about the skills before being caught. A zero
  // that looks exactly like a result is worth a sentence about why it usually
  // isn't one.
  const zero = {
    rate: 0,
    n: 4,
    perPrompt: [
      { prompt: "a", fired: 0, trials: 1, rate: 0 },
      { prompt: "b", fired: 0, trials: 1, rate: 0 },
    ],
    competitors: 37,
    usage: zeroUsage,
  };
  const out = formatTriggerRateReport(zero);
  assert.match(out, /nothing fired on ANY prompt/);
  assert.match(out, /NAMESPACED id/); // cause 1
  assert.match(out, /skillsDir/); // cause 2
  assert.match(out, /fixture/); // cause 3
});

test("formatTriggerRateReport: a PARTIAL rate is left alone", () => {
  // The hedge must not appear on real measurements. A checker that second-guesses
  // good data gets ignored, and then it is not there for the case it exists for.
  const partial = {
    rate: 0.5,
    n: 4,
    perPrompt: [
      { prompt: "a", fired: 1, trials: 1, rate: 1 },
      { prompt: "b", fired: 0, trials: 1, rate: 0 },
    ],
    competitors: 37,
    usage: zeroUsage,
  };
  assert.doesNotMatch(formatTriggerRateReport(partial), /nothing fired/);
});

test("spawnAgent refuses to spend model calls when a foreign test runner owns the process", () => {
  // 🔴 THIS TEST WORKS BECAUSE OF WHERE IT RUNS. Under vitest, `process.argv[1]`
  // is `…/node_modules/vitest/dist/workers/forks.js` — so the guard fires here by
  // construction, and asserting the throw costs nothing and spawns nothing. The
  // same property is the whole point of the guard: a skill test that a foreign
  // runner collects can no longer reach the model.
  //
  // Covering it through the real `spawnAgent` rather than the pure helper is
  // deliberate. `foreignRunner`/`foreignRunnerRefusal` are unit-tested next door;
  // what is NOT provable there is that the composition root actually calls them.
  // Wiring is the half that silently rots.
  assert.throws(
    () =>
      spawnAgent({
        task: "anything",
        cwd: ".",
      } as unknown as AgentRunArgs),
    /running under vitest/,
    "the paid tier started under a foreign runner — a collected eval would bill on every push",
  );
});

// claudeCodeLiveDriver — the EXECUTING tiers' port for this harness (#263). The
// adapter contract asserts the object is coherent (its firing signal agrees with
// `EvalDriver.experimental`, `access` lands inside the union); what it cannot
// assert is the PREDICATE, because that needs a trace. These two cover it.
test("claudeCodeLiveDriver.firedFor NAMESPACES the skill when the plugin has a manifest name", () => {
  // Claude Code records a plugin's skill as `<plugin>:<skill>`, so the bare name
  // must NOT match — a false negative here reads as a skill that never fired,
  // which is the measurement the whole trigger tier reports.
  const trace = (id: string): Trace => ({
    turns: 1,
    output: "",
    hooks: [],
    modelRequests: [],
    file: () => null,
    toolCalls: [
      { name: "Skill", input: { skill: id }, isError: false, resultText: "" },
    ],
  });
  const fired = claudeCodeLiveDriver.firedFor("foo", { name: "myplugin" });
  assert.equal(fired(trace("myplugin:foo")), true);
  assert.equal(fired(trace("foo")), false);
  assert.equal(fired(trace("myplugin:bar")), false);
});

test("claudeCodeLiveDriver.firedFor uses the BARE name when there is no manifest name", () => {
  // A standalone skill directory has no plugin manifest to namespace it. The
  // manifest name is handed in by the DOMAIN precisely so this method reads no
  // disk, so `null` is a value it must handle rather than go looking for.
  const trace = (id: string): Trace => ({
    turns: 1,
    output: "",
    hooks: [],
    modelRequests: [],
    file: () => null,
    toolCalls: [
      { name: "Skill", input: { skill: id }, isError: false, resultText: "" },
    ],
  });
  const fired = claudeCodeLiveDriver.firedFor("foo", { name: null });
  assert.equal(fired(trace("foo")), true);
  assert.equal(fired(trace("myplugin:foo")), false);
});
