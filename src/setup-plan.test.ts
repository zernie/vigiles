/** Unit tests for the pure `vigiles init` plan logic. */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  parseSetupArgs,
  defaultPlan,
  shouldPrompt,
  resolvePlan,
  planPluginInstall,
  codexPluginHooks,
  applyCodexPluginHooks,
  mergeProjectConfig,
  collectSetupAnswers,
  gateOnlyInvitation,
  STRUCTURAL_RULES,
  WORKFLOW_RULES,
  SHIPPED_SKILLS,
  type AskFn,
} from "./setup-plan.js";

test("defaults: both pillars, CI, plugin, non-strict", () => {
  assert.deepEqual(defaultPlan(), {
    lint: true,
    test: true,
    gha: true,
    plugin: true,
    scaffoldSpecs: true, // tracks the lint pillar; only the wizard "gate" turns it off
    strict: false,
    force: false,
  });
});

test("resolvePlan: scaffoldSpecs tracks the lint pillar (off when --no-lint)", () => {
  assert.equal(resolvePlan(parseSetupArgs([])).scaffoldSpecs, true);
  assert.equal(resolvePlan(parseSetupArgs(["--no-lint"])).scaffoldSpecs, false);
  // The wizard "gate" answer overrides it to false even with lint on.
  assert.equal(
    resolvePlan(parseSetupArgs([]), { lint: true, scaffoldSpecs: false })
      .scaffoldSpecs,
    false,
  );
});

test("parseSetupArgs reads --force; resolvePlan carries it", () => {
  assert.equal(parseSetupArgs(["--force"]).force, true);
  assert.equal(parseSetupArgs([]).force, false);
  assert.equal(resolvePlan(parseSetupArgs(["--force"])).force, true);
  assert.equal(resolvePlan(parseSetupArgs([])).force, false);
});

test("parseSetupArgs reads flags", () => {
  const p = parseSetupArgs([
    "--test",
    "--no-gha",
    "--no-plugin",
    "--strict",
    "-y",
  ]);
  assert.equal(p.test, true);
  assert.equal(p.lint, undefined);
  assert.equal(p.gha, false);
  assert.equal(p.plugin, false);
  assert.equal(p.strict, true);
  assert.equal(p.yes, true);
  assert.equal(p.reportOnly, false);
});

test("parseSetupArgs reads --report-only", () => {
  assert.equal(parseSetupArgs(["--report-only"]).reportOnly, true);
  assert.equal(parseSetupArgs([]).reportOnly, false);
});

test("parseSetupArgs reads --lint / --no-test / --harness", () => {
  const p = parseSetupArgs(["--lint", "--no-test", "--harness=claude,codex"]);
  assert.equal(p.lint, true);
  assert.equal(p.test, false);
  assert.equal(p.harness, "claude,codex");
  assert.equal(parseSetupArgs([]).lint, undefined);
  assert.equal(parseSetupArgs([]).test, undefined);
});

test("--ci-only: the explicit gate-only opt-in (no plugin, no spec, no test)", () => {
  assert.equal(parseSetupArgs(["--ci-only"]).ciOnly, true);
  assert.equal(parseSetupArgs([]).ciOnly, false);

  const plan = resolvePlan(parseSetupArgs(["--ci-only"]));
  assert.equal(plan.lint, true, "gate keeps the lint GATE");
  assert.equal(plan.test, false);
  assert.equal(plan.plugin, false);
  assert.equal(plan.scaffoldSpecs, false, "gate scaffolds no spec");
  assert.equal(plan.strict, false);
  // The gate-only invitation fires (it's a pure lint gate → invite to full later).
  assert.ok(gateOnlyInvitation(plan));

  // --ci-only wins over a conflicting default-strict: still minimal.
  assert.equal(
    resolvePlan(parseSetupArgs(["--ci-only", "--strict"])).strict,
    false,
  );

  // Bare `init` is UNCHANGED — full stays the default (gate is opt-in, no flip).
  assert.equal(resolvePlan(parseSetupArgs([])).scaffoldSpecs, true);

  // --ci-only settles the fork → never prompt over it (even at a TTY).
  assert.equal(shouldPrompt(parseSetupArgs(["--ci-only"]), true), false);
});

test("parseSetupArgs: the old --verify/--testing/--pillars flags are gone", () => {
  // Clean break — they no longer select a pillar (treated as unknown flags).
  const p = parseSetupArgs(["--verify", "--testing"]);
  assert.equal(p.lint, undefined);
  assert.equal(p.test, undefined);
  const q = parseSetupArgs(["--pillars=test"]);
  assert.equal(q.lint, undefined);
  assert.equal(q.test, undefined);
});

test("resolvePlan: a positive pillar flag selects exactly that pillar", () => {
  assert.deepEqual(resolvePlan(parseSetupArgs(["--lint"])), {
    lint: true,
    test: false,
    gha: true,
    plugin: true,
    scaffoldSpecs: true,
    strict: false,
    force: false,
  });
  const t = resolvePlan(parseSetupArgs(["--test"]));
  assert.equal(t.lint, false);
  assert.equal(t.test, true);
  // both named → both on
  const both = resolvePlan(parseSetupArgs(["--lint", "--test"]));
  assert.equal(both.lint, true);
  assert.equal(both.test, true);
  // --no-* drops one from the default-both
  const noTest = resolvePlan(parseSetupArgs(["--no-test"]));
  assert.equal(noTest.lint, true);
  assert.equal(noTest.test, false);
});

test("resolvePlan: --no-gha / --no-plugin / --strict / --target", () => {
  const p = resolvePlan(
    parseSetupArgs(["--no-gha", "--no-plugin", "--strict"]),
  );
  assert.equal(p.gha, false);
  assert.equal(p.plugin, false);
  assert.equal(p.strict, true);
  // --target pins a bare lint-pillar spec → no harness scaffold
  assert.equal(resolvePlan(parseSetupArgs(["--target=AGENTS.md"])).test, false);
});

test("resolvePlan: interactive answers override flags/defaults", () => {
  const p = resolvePlan(parseSetupArgs([]), { test: false, plugin: false });
  assert.equal(p.test, false);
  assert.equal(p.plugin, false);
  assert.equal(p.lint, true); // untouched
});

test("resolvePlan: an interactive 'yes' to strict opts into the workflow tier", () => {
  // The recommended-default opt-out: a TTY human says yes → strict; a bare
  // non-interactive run (no answers) stays non-strict (structural-only floor).
  assert.equal(resolvePlan(parseSetupArgs([]), { strict: true }).strict, true);
  assert.equal(
    resolvePlan(parseSetupArgs([]), { strict: false }).strict,
    false,
  );
  assert.equal(resolvePlan(parseSetupArgs([])).strict, false); // no human asked
});

test("planPluginInstall: claude uses the marketplace and never vendors", () => {
  const [withCli] = planPluginInstall(["claude"], { hasClaude: true });
  assert.equal(withCli.harness, "claude");
  assert.equal(withCli.vendors, false); // the whole point of issue #1
  assert.deepEqual(withCli.commands, [
    "claude plugin marketplace add zernie/vigiles",
    "claude plugin install vigiles@vigiles",
  ]);

  // No claude CLI → no auto-run commands, but the manual /plugin steps print.
  const [noCli] = planPluginInstall(["claude"], { hasClaude: false });
  assert.deepEqual(noCli.commands, []);
  assert.ok(
    noCli.manualSteps.some((s) => s.includes("/plugin install vigiles")),
  );
  assert.equal(noCli.vendors, false);
});

test("planPluginInstall: codex installs skills GLOBALLY (-g) + wires repo hooks", () => {
  const [codex] = planPluginInstall(["codex"], { hasClaude: false });
  assert.equal(codex.harness, "codex");
  // The cross-agent skills CLI with -g → ~/.agents/skills/, not the repo.
  assert.ok(codex.commands.some((c) => /skills add .* -a codex .* -g/.test(c)));
  // #dogfood-I2 + PR #114 CI: MUST scope with `-s <shipped>` so it doesn't leak
  // the repo's contributor-only .claude/skills/ into the user's global store —
  // AND the real `skills` CLI parses `-s` SPACE-separated (it consumes
  // consecutive non-dash args); a COMMA list is read as one literal skill name,
  // matches nothing, and the install exits 1. Parse the flag the SAME way the CLI
  // does and assert the tokens are EXACTLY the shipped skills, so a comma
  // regression or a bad name fails HERE (no network) rather than only in the e2e
  // tier that needs it.
  const cmd = codex.commands.find((c) => c.includes("skills add"));
  assert.ok(cmd, "codex plan includes a skills-add command");
  // Tokens start with a word char (a flag like `-g` starts with `-`), so the
  // capture stops at the next flag — otherwise `[\w-]` would swallow `-g`.
  const scoped = /-s ((?:[\w][\w-]* )*[\w][\w-]*) -/.exec(cmd);
  assert.ok(
    scoped,
    `-s must be a SPACE-separated skill list (comma is parsed as one bad name), got: ${cmd}`,
  );
  assert.deepEqual(
    scoped[1].split(" "),
    [...SHIPPED_SKILLS],
    "the -s list must be exactly the shipped skills",
  );
  // Skills are global, but the nudge hooks are written to .codex/config.toml
  // (repo-committed, the Codex norm) → this method now touches the repo.
  assert.equal(codex.vendors, true);
  assert.ok(codex.notes.some((n) => /config\.toml/.test(n))); // names where hooks land
  assert.ok(codex.notes.some((n) => /Still manual/.test(n))); // honest about what's deferred
});

test("planPluginInstall: both harnesses → one plan each; only codex touches the repo", () => {
  const plans = planPluginInstall(["claude", "codex"], { hasClaude: true });
  assert.deepEqual(
    plans.map((p) => p.harness),
    ["claude", "codex"],
  );
  // Claude installs to the global marketplace (no repo files); Codex writes the
  // repo's .codex/config.toml hooks.
  const byName = Object.fromEntries(plans.map((p) => [p.harness, p.vendors]));
  assert.equal(byName.claude, false);
  assert.equal(byName.codex, true);
});

test("codexPluginHooks: the two PostToolUse nudges run as direct npx hook-runtime commands", () => {
  const hooks = codexPluginHooks();
  assert.equal(hooks.length, 2);
  assert.ok(hooks.every((h) => h.event === "PostToolUse"));
  // additionalContext is honored on PostToolUse (confirmed) — these reach the agent.
  assert.ok(
    hooks.some((h) => h.command.includes("hook-runtime eval-lock-nudge")),
  );
  assert.ok(hooks.some((h) => h.command.includes("hook-runtime refs")));
  // Direct npx, no plugin root / vendored script path.
  assert.ok(
    hooks.every((h) => h.command.startsWith("npx --no-install vigiles")),
  );
  // Codex's edit tool is `apply_patch` (NOT Claude's Edit/Write) — a CC-named
  // matcher would never fire on Codex.
  assert.ok(hooks.every((h) => h.matcher === "^apply_patch$"));
});

test("applyCodexPluginHooks: adds the nudges, is idempotent, preserves the user's config", () => {
  // Fresh config → both nudges added.
  const fresh = applyCodexPluginHooks({}) as {
    hooks: { PostToolUse: { command: string }[] };
  };
  assert.equal(fresh.hooks.PostToolUse.length, 2);

  // Re-run → still 2, never duplicated (idempotent re-merge keyed by command).
  const again = applyCodexPluginHooks(fresh) as typeof fresh;
  assert.equal(again.hooks.PostToolUse.length, 2);

  // Preserves the user's own hook AND unrelated top-level keys.
  const withUser = {
    model: "gpt-5",
    hooks: { PostToolUse: [{ matcher: "^Bash$", command: "my-own-hook" }] },
  };
  const merged = applyCodexPluginHooks(withUser) as {
    model: string;
    hooks: { PostToolUse: { command: string }[] };
  };
  assert.equal(merged.model, "gpt-5");
  assert.equal(merged.hooks.PostToolUse.length, 3); // 1 user + 2 vigiles
  assert.ok(merged.hooks.PostToolUse.some((e) => e.command === "my-own-hook"));
});

test("shouldPrompt: only a TTY human with unpinned choices", () => {
  const bare = parseSetupArgs([]);
  assert.equal(shouldPrompt(bare, true), true); // human, nothing pinned → ask
  assert.equal(shouldPrompt(bare, false), false); // agent/CI/pipe → never
  assert.equal(shouldPrompt(parseSetupArgs(["-y"]), true), false); // --yes
  assert.equal(
    shouldPrompt(parseSetupArgs(["--target=CLAUDE.md"]), true),
    false,
  ); // explicit target
  // every choice pinned via flags → nothing to ask
  assert.equal(
    shouldPrompt(
      parseSetupArgs(["--lint", "--test", "--no-gha", "--no-plugin"]),
      true,
    ),
    false,
  );
});

// --- mergeProjectConfig: what `vigiles init` writes to .vigilesrc.json ---

test("mergeProjectConfig: default init gates the FP-safe structural rules + harness", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: false },
  );
  const expected = Object.fromEntries(
    STRUCTURAL_RULES.map((r) => [r, "error"]),
  );
  assert.deepEqual(out, { harnesses: { "claude-code": {} }, rules: expected });
});

test("mergeProjectConfig: default does NOT gate require-instructions-spec (stays opt-in)", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: false },
  );
  const rules = (out as { rules: Record<string, string> }).rules;
  assert.equal(
    rules["require-instructions-spec"],
    undefined,
    "require-instructions-spec is --strict-only",
  );
  assert.equal(
    rules["untested-skill"],
    undefined,
    "untested-* is --strict-only",
  );
});

test("mergeProjectConfig: --report-only writes the structural gate at warn, not error", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: false, reportOnly: true },
  );
  const expected = Object.fromEntries(STRUCTURAL_RULES.map((r) => [r, "warn"]));
  assert.deepEqual(out, { harnesses: { "claude-code": {} }, rules: expected });
});

test("mergeProjectConfig: --report-only composes with --strict (workflow tier at warn)", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: true, reportOnly: true },
  );
  const expected = Object.fromEntries(
    [...STRUCTURAL_RULES, ...WORKFLOW_RULES].map((r) => [r, "warn"]),
  );
  assert.deepEqual(out, { harnesses: { "claude-code": {} }, rules: expected });
});

test("mergeProjectConfig: test-only (lint:false) records harness but writes NO lint rules", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: false, lint: false },
  );
  // Honors the positive-flag contract: `init --test` selects only the test
  // pillar, so the lint rule gate is not written.
  assert.deepEqual(out, { harnesses: { "claude-code": {} } });
});

test("mergeProjectConfig: lint:false with --strict still writes no rules", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["codex"], strict: true, lint: false },
  );
  assert.deepEqual(out, { harnesses: { codex: {} } });
});

test("mergeProjectConfig: array harness is recorded as-is (with default gates)", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code", "codex"], strict: false },
  );
  assert.deepEqual(Object.keys((out as { harnesses: object }).harnesses), [
    "claude-code",
    "codex",
  ]);
});

test("mergeProjectConfig: never clobbers an existing harness key", () => {
  // harness already set, but the default gate rules are still added → writes.
  const out = mergeProjectConfig(
    { harnesses: { codex: {} } },
    { harnesses: ["claude-code"], strict: false },
  );
  assert.deepEqual(
    Object.keys((out as { harnesses: object }).harnesses),
    ["codex"],
    "kept",
  );
});

test("mergeProjectConfig: preserves other existing keys", () => {
  const out = mergeProjectConfig(
    { maxRules: 50 },
    { harnesses: ["codex"], strict: false },
  );
  assert.equal((out as { maxRules: number }).maxRules, 50);
  assert.deepEqual(Object.keys((out as { harnesses: object }).harnesses), [
    "codex",
  ]);
});

test("mergeProjectConfig: --strict adds the workflow-forcing tier on top of the gates", () => {
  const out = mergeProjectConfig(
    {},
    { harnesses: ["claude-code"], strict: true },
  );
  const expected = Object.fromEntries(
    [...STRUCTURAL_RULES, ...WORKFLOW_RULES].map((r) => [r, "error"]),
  );
  assert.deepEqual(out, { harnesses: { "claude-code": {} }, rules: expected });
});

test("WORKFLOW_RULES is require-instructions-spec + untested-*; nudge rules are NOT gated", () => {
  assert.ok(WORKFLOW_RULES.includes("require-instructions-spec"));
  assert.ok(WORKFLOW_RULES.includes("untested-skill"));
  // frontmatter-valid / skill-frontmatter are nudge-group — never gated, even --strict.
  assert.ok(
    !(WORKFLOW_RULES as readonly string[]).includes("frontmatter-valid"),
  );
  assert.ok(
    !(WORKFLOW_RULES as readonly string[]).includes("skill-frontmatter"),
  );
});

test("mergeProjectConfig: never clobbers a user-set severity, fills the rest", () => {
  const out = mergeProjectConfig(
    { harness: "codex", rules: { "subagent-tool-contract": "warn" } },
    { harnesses: ["codex"], strict: false },
  );
  const rules = (out as { rules: Record<string, string> }).rules;
  assert.equal(rules["subagent-tool-contract"], "warn", "user severity kept");
  assert.equal(rules["description-overlap"], "error", "others gated");
});

test("mergeProjectConfig: fully-satisfied config returns null (no write)", () => {
  const rules = Object.fromEntries(
    [...STRUCTURAL_RULES, ...WORKFLOW_RULES].map((r) => [r, "error"]),
  );
  assert.equal(
    mergeProjectConfig(
      { harnesses: { codex: {} }, rules },
      { harnesses: ["codex"], strict: true },
    ),
    null,
  );
});

// --- collectSetupAnswers: the interactive Q&A, unit-tested via a fake ask ---

/** A fake `ask` that returns the scripted answer per matched question substring,
 *  else the default (simulating the user hitting Enter). Records the prompts. */
function fakeAsk(scripted: Record<string, string>): {
  ask: AskFn;
  asked: string[];
} {
  const asked: string[] = [];
  const ask: AskFn = (q, def) => {
    asked.push(q);
    const hit = Object.keys(scripted).find((k) => q.includes(k));
    return Promise.resolve(hit ? scripted[hit] : def);
  };
  return { ask, asked };
}

test("collectSetupAnswers: all defaults (user hits Enter) → full mode, both pillars, all on, strict", async () => {
  const { ask, asked } = fakeAsk({});
  assert.deepEqual(await collectSetupAnswers(ask), {
    lint: true,
    test: true,
    gha: true,
    plugin: true,
    strict: true,
    scaffoldSpecs: true, // "full" + strict scaffolds the invited spec
  });
  assert.equal(asked.length, 5, "asks mode, pillars, CI, plugin, strict");
});

test("gateOnlyInvitation: fires only for a pure gate (no plugin, no specs)", () => {
  // A pure gate (the wizard "gate" choice) → the one-line invitation to graduate.
  const gate = { ...defaultPlan(false), plugin: false, scaffoldSpecs: false };
  assert.match(gateOnlyInvitation(gate) ?? "", /choose 'full'/);
  // Plugin installed → not a pure gate → no invitation.
  assert.equal(gateOnlyInvitation(defaultPlan(false)), null);
  // Specs scaffolded but no plugin → still not a pure gate → no invitation.
  assert.equal(
    gateOnlyInvitation({ ...defaultPlan(false), plugin: false }),
    null,
  );
});

test("collectSetupAnswers: 'gate' mode → lint-only gate, nothing installed, one question", async () => {
  const { ask, asked } = fakeAsk({ "Setup mode": "gate" });
  assert.deepEqual(await collectSetupAnswers(ask), {
    lint: true,
    test: false,
    plugin: false,
    scaffoldSpecs: false,
    strict: false,
  });
  // Gate short-circuits: only the mode question is asked (no pillar/plugin/strict).
  assert.equal(asked.length, 1, "gate mode asks nothing further");
});

test("collectSetupAnswers: 'full' + declining strict → plugin + specs on, gate rules off", async () => {
  const { ask } = fakeAsk({ "Setup mode": "full", "enforce specs": "n" });
  const a = await collectSetupAnswers(ask);
  assert.equal(a.plugin, true);
  assert.equal(a.strict, false, "the workflow RULES are opt-out");
  // strict is a separate axis from whether a spec is scaffolded — full mode always
  // creates the spec (that's the full setup); strict only gates the workflow rules.
  assert.equal(a.scaffoldSpecs, true);
});

test("collectSetupAnswers: 'lint' pillar → test off", async () => {
  const { ask } = fakeAsk({ "which pillars": "lint" });
  const a = await collectSetupAnswers(ask);
  assert.equal(a.lint, true);
  assert.equal(a.test, false);
});

test("collectSetupAnswers: 'test' pillar → lint off", async () => {
  const { ask } = fakeAsk({ "which pillars": "test" });
  const a = await collectSetupAnswers(ask);
  assert.equal(a.lint, false);
  assert.equal(a.test, true);
});

test("collectSetupAnswers: declining CI / plugin / strict is honored", async () => {
  const { ask } = fakeAsk({
    "Wire CI": "n",
    "Install the Claude Code plugin": "n",
    "enforce specs": "n",
  });
  const a = await collectSetupAnswers(ask);
  assert.equal(a.gha, false);
  assert.equal(a.plugin, false);
  assert.equal(a.strict, false, "opts OUT of the workflow tier");
  assert.equal(a.lint, true, "structural gating still set up");
});
