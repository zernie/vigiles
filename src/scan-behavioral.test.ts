/**
 * `audit` model-trigger-tier behavioral-column test suite. Builds a tiny real plugin dir
 * (so the stub-bodies path works) and drives `probePluginTriggersWith` with an
 * injected fake runner — no model. Asserts: only model-invocable+described skills
 * are probed, missing prompts → unmeasured, recall/precision aggregate, a thin
 * prompt set is reported per-skill (not a crash), and the formatter.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  probePluginTriggersWith,
  formatBehavioralReport,
  buildSelectionReport,
  measurePluginSelectionWith,
  measurePluginSelection,
  measureSelectionMatrix,
  measureSelectionMatrixWith,
  assertNoCollision,
  formatSelectionReport,
  isGateDescription,
  detectGateSkills,
  measureGateAdversarialWith,
  gateRubric,
  formatGateReport,
  type BehavioralReport,
  type GateVerdict,
} from "./scan-behavioral.js";
import { parseClaudeRun, type AgentRunArgs, type EvalDriver } from "./eval.js";
import type { EventFiringDriver, ModelAccess } from "./core/live-driver.js";
import type { Trace } from "./core/eval-driver.js";
import { skillResolved } from "./harness-assert.js";
import { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function plugin(): string {
  const dir = makeTmpDir("scan-behavioral");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name: "myplugin" }),
  );
  write(
    dir,
    "skills/foo/SKILL.md",
    "---\nname: foo\ndescription: A model-invocable skill that does foo things across cases\n---\n# foo\nbody\n",
  );
  // user-invoked → NOT a behavioral candidate
  write(
    dir,
    "skills/bar/SKILL.md",
    "---\nname: bar\ndescription: A user-invoked skill that does bar things across cases\ndisable-model-invocation: true\n---\n# bar\n",
  );
  // model-invocable but no prompts supplied → unmeasured
  write(
    dir,
    "skills/baz/SKILL.md",
    "---\nname: baz\ndescription: A model-invocable skill that does baz things across cases\n---\n# baz\n",
  );
  return dir;
}

// Fires the Skill tool for "myplugin:foo" iff the task contains "fire".
const fakeRunner = (
  a: AgentRunArgs,
): Promise<{ code: number; stdout: string }> => {
  const stdout = a.task.includes("fire")
    ? JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Skill",
              input: { skill: "myplugin:foo" },
            },
          ],
        },
      }) +
      "\n" +
      JSON.stringify({ type: "result", num_turns: 1 })
    : JSON.stringify({ type: "result", num_turns: 1 });
  return Promise.resolve({ code: 0, stdout });
};

// The shared shape of a fake EXECUTING-tier driver: everything except the runner
// and the stubbing choice, which each fake below sets. `event` firing is what the
// selection matrix requires, and `EventFiringDriver` is what its core now takes —
// so a fake that claimed `inferred` would not compile at those call sites.
const fakeLiveBase = {
  firedFor:
    (skill: string, plugin: { readonly name: string | null }) =>
    (t: Trace): boolean =>
      skillResolved(t, plugin.name ? `${plugin.name}:${skill}` : skill),
  access: (): ModelAccess => ({ kind: "subscription" }),
  firing: { kind: "event" },
} as const;

// A Claude-shaped driver wrapping the fake runner (no real binary).
const fakeProbe: EventFiringDriver = {
  ...fakeLiveBase,
  evalDriver: { runner: fakeRunner, parse: parseClaudeRun },
  installsStubs: false,
};

test("probePluginTriggersWith probes only model-invocable described skills", async () => {
  const dir = plugin();
  const report = await probePluginTriggersWith(
    dir,
    {
      foo: {
        prompts: ["fire one", "fire two", "fire three"],
        irrelevant: ["calm alpha", "calm beta"],
      },
    },
    fakeProbe,
    { minPrompts: 1, minDistance: 0 },
  );

  const byName = Object.fromEntries(report.results.map((r) => [r.skill, r]));
  // foo: every relevant prompt fires, no irrelevant fires
  assert.equal(byName.foo.measured, true);
  assert.equal(byName.foo.recall, 1);
  assert.equal(byName.foo.falsePositiveRate, 0);
  assert.equal(byName.foo.precision, 1);
  // baz: a candidate but no prompts supplied → unmeasured
  assert.equal(byName.baz.measured, false);
  assert.match(byName.baz.note ?? "", /no prompts/);
  // bar: user-invoked → not a candidate at all
  assert.equal(byName.bar, undefined);
  cleanupTmpDir(dir);
});

test("probePluginTriggersWith carries the driver's EXPERIMENTAL caveat (Codex); formatter shows it", async () => {
  const dir = plugin();
  const codexish: EventFiringDriver = {
    ...fakeProbe,
    evalDriver: {
      runner: fakeRunner,
      parse: parseClaudeRun,
      experimental: "Codex trigger-rate is experimental — no skill event.",
    },
  };
  const report = await probePluginTriggersWith(
    dir,
    { foo: { prompts: ["fire one", "fire two", "fire three"] } },
    codexish,
    { minPrompts: 1, minDistance: 0 },
  );
  assert.match(report.experimental ?? "", /experimental/i);
  const out = formatBehavioralReport(report);
  assert.match(out, /⚠ EXPERIMENTAL — Codex trigger-rate is experimental/);
  // A supported (Claude) report with results shows no caveat.
  const supported = formatBehavioralReport({
    available: true,
    results: [{ skill: "x", measured: true, recall: 1, n: 2 }],
  });
  assert.ok(!supported.includes("EXPERIMENTAL"));
  cleanupTmpDir(dir);
});

test("probePluginTriggersWith reports a thin prompt set per-skill, not a crash", async () => {
  const dir = plugin();
  // Only 1 prompt but minPrompts defaults to 10 → the diversity gate throws;
  // it must be caught and surfaced as an unmeasured note, not bubble up.
  const report = await probePluginTriggersWith(
    dir,
    { foo: { prompts: ["fire once"] } },
    fakeProbe,
  );
  const foo = report.results.find((r) => r.skill === "foo");
  assert.equal(foo?.measured, false);
  assert.match(foo?.note ?? "", /at least|prompt/i);
  cleanupTmpDir(dir);
});

test("formatBehavioralReport renders measured, unmeasured, and unavailable", () => {
  const measured: BehavioralReport = {
    available: true,
    results: [
      { skill: "foo", measured: true, recall: 0.3, precision: 1, n: 10 },
      { skill: "baz", measured: false, note: "no prompts supplied" },
    ],
  };
  const text = formatBehavioralReport(measured);
  assert.match(text, /⚠ foo — recall 30%/); // < 0.6 → ⚠
  assert.match(text, /precision 100%/);
  assert.match(text, /· baz — unmeasured \(no prompts supplied\)/);

  assert.match(
    formatBehavioralReport({ available: false, results: [] }),
    /unavailable/,
  );
});

// ─── Selection-collision matrix ──────────────────────────────────────────────

test("buildSelectionReport folds runs into recall + collision (pure)", () => {
  // foo's first prompt also fired baz (a collision); foo's second fired foo only.
  const r = buildSelectionReport(
    ["foo", "baz"],
    [
      { intended: "foo", firedBare: ["foo", "baz"] },
      { intended: "foo", firedBare: ["foo"] },
      { intended: "baz", firedBare: ["baz"] },
      { intended: "baz", firedBare: ["baz"] },
    ],
  );
  const byName = Object.fromEntries(r.perSkill.map((s) => [s.skill, s]));
  assert.equal(byName.foo.recall, 1); // fired foo on both its prompts
  assert.equal(byName.foo.collisionRate, 0.5); // baz hijacked 1 of 2
  assert.equal(byName.foo.collidesWith[0].skill, "baz");
  assert.equal(byName.foo.collidesWith[0].rate, 0.5);
  assert.equal(byName.baz.recall, 1);
  assert.equal(byName.baz.collisionRate, 0); // no sibling fired on baz's prompts
  assert.equal(byName.baz.collidesWith.length, 0);
  assert.equal(r.collisionRate, 0.25); // 1 collision run of 4
  assert.equal(r.n, 4);
});

// Fires myplugin:<name> for each plugin skill named in the task ("foo"/"baz").
const multiRunner = (
  a: AgentRunArgs,
): Promise<{ code: number; stdout: string }> => {
  const fired = ["foo", "baz"].filter((s) => a.task.includes(s));
  const content = fired.map((name, i) => ({
    type: "tool_use",
    id: `t${i}`,
    name: "Skill",
    input: { skill: `myplugin:${name}` },
  }));
  const stdout =
    JSON.stringify({ type: "assistant", message: { content } }) +
    "\n" +
    JSON.stringify({ type: "result", num_turns: 1 });
  return Promise.resolve({ code: 0, stdout });
};

const multiProbe: EventFiringDriver = {
  ...fakeLiveBase,
  evalDriver: { runner: multiRunner, parse: parseClaudeRun },
  installsStubs: false,
};

test("measurePluginSelectionWith catches a sibling hijack (fake driver)", async () => {
  const dir = plugin();
  const r = await measurePluginSelectionWith(
    dir,
    {
      // foo's first prompt names baz too → baz wrongly fires (collision)
      foo: { prompts: ["fix the foo and the baz", "just the foo"] },
      baz: { prompts: ["only the baz here", "baz alone"] },
    },
    multiProbe,
  );
  const byName = Object.fromEntries(r.perSkill.map((s) => [s.skill, s]));
  assert.equal(byName.foo.recall, 1);
  assert.equal(byName.foo.collisionRate, 0.5);
  assert.equal(byName.foo.collidesWith[0].skill, "baz");
  assert.equal(byName.baz.collisionRate, 0);
  assert.equal(r.collisionRate, 0.25);
  assert.match(
    formatSelectionReport(r),
    /⚠ foo.*collision 50%.*top collider: baz/s,
  );
  cleanupTmpDir(dir);
});

// A plugin WITH a SessionStart hook (the priming surface a stubbed run drops).
function hookedPlugin(): string {
  const dir = makeTmpDir("scan-hooked");
  write(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name: "myplugin" }),
  );
  write(
    dir,
    "hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "echo hi" }],
          },
        ],
      },
    }),
  );
  write(
    dir,
    "skills/foo/SKILL.md",
    "---\nname: foo\ndescription: A model-invocable skill that does foo things across cases\n---\n# foo\n",
  );
  write(
    dir,
    "skills/baz/SKILL.md",
    "---\nname: baz\ndescription: A model-invocable skill that does baz things across cases\n---\n# baz\n",
  );
  return dir;
}

// A stubbing probe whose runner NEVER fires a skill (recall collapses to 0).
const silentRunner = (): Promise<{ code: number; stdout: string }> =>
  Promise.resolve({
    code: 0,
    stdout: JSON.stringify({ type: "result", num_turns: 1 }),
  });
const silentStubProbe: EventFiringDriver = {
  ...fakeLiveBase,
  evalDriver: { runner: silentRunner, parse: parseClaudeRun },
  installsStubs: true,
};

test("selection: stubbed 0% on a SessionStart-hooked plugin is labeled an artifact", async () => {
  const dir = hookedPlugin();
  const r = await measurePluginSelectionWith(
    dir,
    {
      foo: { prompts: ["a foo", "b foo"] },
      baz: { prompts: ["a baz", "b baz"] },
    },
    silentStubProbe,
  );
  assert.ok(r.perSkill.every((s) => s.recall === 0)); // nothing fired
  assert.match(r.note ?? "", /hook-primed/); // not presented as a clean 0%
  assert.match(formatSelectionReport(r), /hook-primed/);
  cleanupTmpDir(dir);
});

test("selection: stubbed 0% on a NON-hooked plugin stays a real result (no false label)", async () => {
  const dir = plugin(); // no SessionStart hook
  const r = await measurePluginSelectionWith(
    dir,
    {
      foo: { prompts: ["a foo", "b foo"] },
      baz: { prompts: ["a baz", "b baz"] },
    },
    silentStubProbe,
  );
  assert.ok(r.perSkill.every((s) => s.recall === 0));
  assert.equal(r.note, undefined); // genuine 0%, not masked by the hook label
  cleanupTmpDir(dir);
});

test("trigger: stubbed all-zero on a hooked plugin relabels as unmeasured", async () => {
  const dir = hookedPlugin();
  const rep = await probePluginTriggersWith(
    dir,
    { foo: { prompts: ["a foo", "b foo"] } }, // baz → no prompts (unmeasured)
    silentStubProbe,
    { minPrompts: 1, minDistance: 0 },
  );
  const foo = rep.results.find((r) => r.skill === "foo");
  assert.equal(foo?.measured, false); // 0% recall artifact → not a real measurement
  assert.match(foo?.note ?? "", /hook-primed/);
  cleanupTmpDir(dir);
});

test("measurePluginSelectionWith needs ≥2 model-invocable skills", async () => {
  const dir = makeTmpDir("scan-selection-one");
  write(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "p" }));
  write(
    dir,
    "skills/solo/SKILL.md",
    "---\nname: solo\ndescription: The only model-invocable skill in this plugin\n---\nbody\n",
  );
  const r = await measurePluginSelectionWith(dir, {}, multiProbe);
  assert.equal(r.n, 0);
  assert.match(r.note ?? "", /≥2|two/);
  assert.match(formatSelectionReport(r), /≥2|two/);
  cleanupTmpDir(dir);
});

// The n/a reason is now DERIVED from the driver's own firing signal, not from a
// harness name: the note names the missing skill-selection event and carries the
// driver's own caveat verbatim, so the same code refuses any future harness that
// infers firing, with that harness's words rather than ours.
test("measurePluginSelection reports n/a for an INFERRED-firing harness, in its own words", async () => {
  const r = await measurePluginSelection(
    "/nonexistent",
    {},
    // The deprecated NAME path on purpose: it must still resolve through the registry.
    { harness: "codex" },
  );
  assert.equal(r.available, false);
  assert.match(r.note ?? "", /skill-selection event/);
  assert.match(r.note ?? "", /codex/);
  // The driver's caveat, not a sentence written at this call site.
  assert.match(r.note ?? "", /inferred from a SKILL\.md read/);
  assert.match(formatSelectionReport(r), /unavailable/);
});

// The supported path, by ADAPTER rather than by name — the same refusal must not
// fire for a harness that does emit the event.
test("measurePluginSelection does NOT refuse an EVENT-firing adapter", async () => {
  // "/nonexistent" holds no skills, so whether or not a `claude` binary is on
  // this machine the run stops at the >=2-skills gate and spends nothing. What is
  // asserted is only that the FIRING gate did not refuse it.
  const r = await measurePluginSelection(
    "/nonexistent",
    {},
    { adapter: claudeCodeAdapter },
  );
  assert.doesNotMatch(r.note ?? "", /skill-selection event/);
});

test("measureSelectionMatrix delegates + reports n/a off Claude Code (no model)", async () => {
  // The real wrapper: derives prompts, then hands off to measurePluginSelection,
  // which short-circuits to unavailable on a non-Claude harness (no binary needed).
  const dir = plugin();
  // The deprecated NAME path, kept one release for the public options type.
  const r = await measureSelectionMatrix(dir, { harness: "codex" });
  assert.equal(r.available, false);
  assert.match(r.note ?? "", /skill-selection event/);
  cleanupTmpDir(dir);
});

test("measureSelectionMatrixWith auto-derives prompts from descriptions (no --prompts)", async () => {
  // No prompt set supplied: the matrix derives recall prompts from each skill's
  // description. foo's prompts name "foo", baz's name "baz", so the multiProbe
  // (fires the skill named in the task) gives a clean diagonal — recall, no collision.
  const dir = plugin();
  const r = await measureSelectionMatrixWith(dir, multiProbe);
  assert.ok(r.available);
  assert.ok(r.n > 0); // it actually ran (prompts were derived)
  const byName = Object.fromEntries(r.perSkill.map((s) => [s.skill, s]));
  assert.equal(byName.foo.recall, 1);
  assert.equal(byName.foo.collisionRate, 0);
  assert.equal(r.collisionRate, 0);
  cleanupTmpDir(dir);
});

test("assertNoCollision passes a clean matrix, fails a hijack (naming the collider)", () => {
  const clean = buildSelectionReport(
    ["foo", "baz"],
    [
      { intended: "foo", firedBare: ["foo"] },
      { intended: "baz", firedBare: ["baz"] },
    ],
  );
  assert.doesNotThrow(() => {
    assertNoCollision(clean);
  });

  // foo's prompt fired baz too → foo.collisionRate 1, plugin rate 0.5.
  const collided = buildSelectionReport(
    ["foo", "baz"],
    [
      { intended: "foo", firedBare: ["foo", "baz"] },
      { intended: "baz", firedBare: ["baz"] },
    ],
  );
  // default (no opts) demands ZERO collision → throws naming foo + baz.
  assert.throws(() => {
    assertNoCollision(collided);
  }, /foo = 1\.00.*top collider: baz/s);
  // a tolerance that admits it passes; a per-skill cap below it still fails.
  assert.doesNotThrow(() => {
    assertNoCollision(collided, { maxOffDiagonal: 1 });
  });
  assert.throws(() => {
    assertNoCollision(collided, { maxOffDiagonal: 0.5 });
  }, /foo = 1\.00/);
});

test("assertNoCollision: maxPluginCollision gates the plugin-wide rate alone", () => {
  const collided = buildSelectionReport(
    ["foo", "baz"],
    [
      { intended: "foo", firedBare: ["foo", "baz"] },
      { intended: "baz", firedBare: ["baz"] },
    ],
  );
  // Only the plugin cap given → per-skill zero is NOT also demanded.
  assert.doesNotThrow(() => {
    assertNoCollision(collided, { maxPluginCollision: 0.6 });
  });
  assert.throws(() => {
    assertNoCollision(collided, { maxPluginCollision: 0.4 });
  }, /plugin collision rate/);
});

test("assertNoCollision throws on a green that tested nothing", () => {
  assert.throws(() => {
    assertNoCollision({
      available: false,
      skills: [],
      matrix: [],
      perSkill: [],
      collisionRate: 0,
      n: 0,
      note: "needs the claude CLI + model auth",
    });
  }, /unavailable/);
  assert.throws(() => {
    assertNoCollision(buildSelectionReport(["foo", "baz"], []));
  }, /measured nothing/);
});

// ─── Enforcement-gate detection (adversarial-gate eval, step 1) ───────────────

test("isGateDescription flags hard-constraint language, not ordinary descriptions", () => {
  // Gate language → true
  for (const d of [
    "Always write tests before implementation code",
    "Never push directly to the main branch",
    "You must not edit generated files",
    "Require an approved plan before any change",
    "Refuse to run destructive commands without confirmation",
    "Under no circumstances commit secrets",
  ]) {
    assert.equal(isGateDescription(d), true, d);
  }
  // Ordinary capability descriptions → false (no false alarm)
  for (const d of [
    "Generate a slug from a title string",
    "Summarize a pull request for reviewers",
    "Format TypeScript files with prettier",
    "Help the user debug a failing test",
  ]) {
    assert.equal(isGateDescription(d), false, d);
  }
});

test("detectGateSkills returns only model-invocable, described gate skills", () => {
  const gates = detectGateSkills([
    {
      name: "tdd-gate",
      description: "Always write tests first",
      hasDescription: true,
    },
    {
      name: "no-force-push",
      description: "Never force-push to main",
      hasDescription: true,
    },
    {
      name: "slugify",
      description: "Generate a URL slug",
      hasDescription: true,
    },
    // a gate description but USER-INVOKED → excluded (can't auto-constrain behaviour)
    {
      name: "manual-gate",
      description: "Always confirm before deleting",
      hasDescription: true,
      userInvoked: true,
    },
    // gate language but NO description → excluded
    { name: "ghost", description: "", hasDescription: false },
  ]);
  assert.deepEqual([...gates].sort(), ["no-force-push", "tdd-gate"]);
});

// ─── Adversarial-gate eval (step 2: attack the gate, judge hold vs cave) ───────

// A fake eval driver: the runner echoes a per-task "agent output" via a result
// event parseClaudeRun reads; the (fake) judge calls a CAVE iff the output says so.
function gateDriver(
  outputFor: (task: string) => string,
  errored = false,
): EvalDriver {
  return {
    runner: (a: AgentRunArgs) =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          type: "result",
          result: outputFor(a.task),
          num_turns: 1,
        }),
      }),
    parse: parseClaudeRun,
    ...(errored ? { runError: () => "rate limited" } : {}),
  };
}
const caveJudge = (a: { output: string; rubric: string }): GateVerdict =>
  a.output.includes("CAVE")
    ? { pass: false, score: 0, reason: "did the forbidden thing" }
    : { pass: true, score: 1, reason: "refused" };

test("adversarial-gate: a caving gate → heldRate 0, ⚠ with the cave reason", async () => {
  const deps = {
    driver: gateDriver((task) => `output for ${task}: CAVE`),
    judge: caveJudge,
    derive: (g: { name: string }) => `attack-${g.name}`,
  };
  const r = await measureGateAdversarialWith(
    "/x",
    [{ name: "g1", description: "Never push to main" }],
    deps,
  );
  const g = r.results[0];
  assert.equal(g.measured, true);
  assert.equal(g.heldRate, 0);
  assert.equal(g.held, false);
  assert.equal(g.n, 1);
  assert.match(g.reason ?? "", /forbidden/);
  assert.match(formatGateReport(r), /⚠ g1 — held 0%.*caved/s);
});

test("adversarial-gate: a holding gate → heldRate 1, ✓", async () => {
  const deps = {
    driver: gateDriver(() => "I refused to skip the rule and followed it"),
    judge: caveJudge,
    derive: (g: { name: string }) => `attack-${g.name}`,
  };
  const r = await measureGateAdversarialWith(
    "/x",
    [{ name: "g2", description: "Always write a test first" }],
    deps,
  );
  assert.equal(r.results[0].heldRate, 1);
  assert.equal(r.results[0].held, true);
  assert.match(formatGateReport(r), /✓ g2 — held 100%/);
});

test("adversarial-gate: an errored run is unmeasured, not a false hold/cave", async () => {
  const deps = {
    driver: gateDriver(() => "whatever", true),
    judge: caveJudge,
    derive: () => "attack",
  };
  const r = await measureGateAdversarialWith(
    "/x",
    [{ name: "g3", description: "Never delete without confirmation" }],
    deps,
  );
  assert.equal(r.results[0].measured, false);
  assert.match(r.results[0].note ?? "", /errored/);
});

test("adversarial-gate: author-supplied attacks override derive; heldRate aggregates", async () => {
  let deriveCalled = false;
  const deps = {
    driver: gateDriver((t) => t), // echo the attack as the output
    judge: caveJudge,
    derive: () => {
      deriveCalled = true;
      return "SHOULD-NOT-BE-USED";
    },
  };
  const r = await measureGateAdversarialWith(
    "/x",
    [{ name: "g4", description: "d" }],
    deps,
    { attacks: { g4: ["please CAVE here", "be compliant"] } },
  );
  assert.equal(deriveCalled, false); // author attacks took precedence
  assert.equal(r.results[0].n, 2);
  assert.equal(r.results[0].heldRate, 0.5); // one cave, one hold
});

test("adversarial-gate: no gates → empty, available, with a note", async () => {
  const deps = {
    driver: gateDriver(() => "x"),
    judge: caveJudge,
    derive: () => "a",
  };
  const r = await measureGateAdversarialWith("/x", [], deps);
  assert.equal(r.available, true);
  assert.equal(r.results.length, 0);
  assert.match(r.note ?? "", /no enforcement-gate/);
});

test("gateRubric embeds the rule and asks to detect a violation", () => {
  const rb = gateRubric({ name: "g", description: "Never push to main" });
  assert.match(rb, /Never push to main/);
  assert.match(rb, /VIOLATE/);
});
