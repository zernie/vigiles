/**
 * Tests for subagent spec compilation (src/spec.ts `experimental_agent()` + src/compile.ts
 * `compileAgent`). A subagent is a delegated worker with a contract — a tool
 * "rail" and rules — so compilation verifies the tool list and the body's
 * references, and emits frontmatter + an integrity hash. Model-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  experimental_agent,
  experimental_skill,
  prose,
  experimental_effect,
  file,
  cmd,
  enforce,
  guidance,
} from "./spec.js";
import { compileAgent, compileSkill, adoptDiff } from "./compile.js";
import { readFrontmatter, frontmatterScalar } from "./frontmatter-read.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";

test("experimental_agent() sets the spec type", () => {
  const a = experimental_agent({
    name: "reviewer",
    description: "Review a diff.",
  });
  assert.equal(a._specType, "agent");
  assert.equal(a.name, "reviewer");
});

test("compileAgent renders frontmatter (name/description/model/tools) + hash", async () => {
  const { markdown, errors } = await compileAgent(
    experimental_agent({
      name: "reviewer",
      description: "Review a diff for correctness.",
      model: "sonnet",
      tools: ["Read", "Grep", "Bash"],
      body: "You are a careful code reviewer.",
    }),
    { specFile: "agents/reviewer.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  // The frontmatter — not the stamp — leads the file, and a READER must find the
  // contract inside it. Asserting the text merely appears is what let the old
  // placement ship: `name: reviewer` was present in both versions, while a `^---`
  // parser found no frontmatter at all in the broken one.
  assert.match(markdown, /^---\r?\n/);
  const fm = readFrontmatter(markdown);
  assert.notEqual(
    fm.block,
    null,
    "a frontmatter reader must find a block here",
  );
  assert.equal(frontmatterScalar(fm, "name"), "reviewer");
  assert.equal(
    frontmatterScalar(fm, "description"),
    "Review a diff for correctness.",
  );
  // The stamp still exists — below the frontmatter, which is the whole change.
  assert.match(markdown, /\n<!-- vigiles:sha256:[a-f0-9]+ compiled from/);
  assert.match(markdown, /\nname: reviewer\n/);
  assert.match(markdown, /\ndescription: Review a diff for correctness\.\n/);
  assert.match(markdown, /\nmodel: sonnet\n/);
  assert.match(markdown, /\ntools: Read, Grep, Bash\n/);
  assert.match(markdown, /You are a careful code reviewer\./);
});

test("compileAgent renders color + disallowedTools (deny-side, no allowlist)", async () => {
  // disallowedTools is the inherit-all-minus-a-few form — used INSTEAD of a `tools`
  // allowlist (with an allowlist it would be redundant), so no `tools` here.
  const { markdown, errors } = await compileAgent(
    experimental_agent({
      name: "broad-worker",
      description: "Does most things but never shells out.",
      model: "opus",
      color: "pink",
      disallowedTools: ["Bash"], // subtract from inherit-all
      body: "Work, but no Bash.",
    }),
    { specFile: "agents/broad-worker.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  assert.match(markdown, /\ncolor: pink\n/);
  assert.match(markdown, /\ndisallowedTools: Bash\n/);
});

test("compileAgent flags a disallowedTools entry that's a close typo (blocks nothing)", async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "x",
      description: "y",
      tools: ["Read"],
      disallowedTools: ["Wrte"], // typo of Write → would block nothing
      body: "b",
    }),
    { specFile: "agents/x.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.ok(
    errors.some((e) => /Wrte/.test(e.message) && /Write/.test(e.message)),
  );
});

test("compileAgent: minimal agent omits model/tools and has no rules section", async () => {
  const { markdown, errors } = await compileAgent(
    experimental_agent({
      name: "echo",
      description: "Echo things.",
      body: "Just echo.",
    }),
    { specFile: "agents/echo.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  assert.doesNotMatch(markdown, /\nmodel:/);
  assert.doesNotMatch(markdown, /\ntools:/);
  assert.doesNotMatch(markdown, /## Rules/);
});

test("compileAgent accepts built-in and MCP tools, flags unknown with a hint", async () => {
  const ok = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      tools: ["Read", "Task", "Skill", "mcp__github__issue_write"],
      body: "b",
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(ok.errors, []);

  // a near-miss → "did you mean", and a far token → no hint
  const bad = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      tools: ["Reed", "xyzzy123"],
      body: "b",
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.equal(bad.errors.length, 2);
  const reed = bad.errors.find((e) => e.message.includes('"Reed"'));
  assert.ok(reed && reed.type === "unknown-tool");
  assert.match(reed.message, /Did you mean "Read"\?/);
  const far = bad.errors.find((e) => e.message.includes('"xyzzy123"'));
  assert.ok(far && !/Did you mean/.test(far.message)); // no close match → no hint
});

test("compileAgent flags tools that are never available to a subagent", async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      // Unconditionally removed by the platform's first filter, whatever the
      // list says. `Agent`/`ExitPlanMode` are deliberately NOT here: the vendor
      // removes those only under a condition, so they are legitimate to declare
      // — see the next test.
      tools: ["Read", "AskUserQuestion", "Workflow"],
      body: "b",
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every((e) => /never available to a subagent/.test(e.message)),
  );
});

test("compileAgent accepts Agent — the docs' own delegating example compiles", async () => {
  // `tools: Agent(worker, researcher), Read, Bash` ships in the vendor docs and
  // failed to compile until 2026-08-17, because vigiles had the 2.1.63 rename
  // backwards and treated the current name as never-available.
  const { errors } = await compileAgent(
    experimental_agent({
      name: "coordinator",
      description: "Coordinates work across specialized agents",
      tools: ["Agent", "Read", "Bash"],
      body: "b",
    }),
    { specFile: "coordinator.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    errors.filter((e) => e.type === "unknown-tool"),
    [],
  );
});

test("compileAgent verifies body references against the filesystem", async () => {
  const dir = makeTmpDir("agent");
  try {
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    const ok = await compileAgent(
      experimental_agent({
        name: "a",
        description: "d",
        body: prose`Read ${file("real.ts")}.`,
      }),
      { basePath: dir, specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
    );
    assert.deepEqual(ok.errors, []);

    const stale = await compileAgent(
      experimental_agent({
        name: "a",
        description: "d",
        body: prose`Read ${file("missing.ts")} and run ${cmd("npm run nope")}.`,
      }),
      { basePath: dir, specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
    );
    assert.ok(stale.errors.some((e) => e.type === "stale-file"));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("compileAgent renders a Rules section the worker must follow", async () => {
  const { markdown, errors } = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      rules: {
        "no-floating": enforce(
          "@typescript-eslint/no-floating-promises",
          "Await promises.",
        ),
        "research-first": guidance("Check the docs before guessing."),
      },
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
  assert.match(markdown, /## Rules/);
  assert.match(
    markdown,
    /\*\*Enforced by:\*\* `@typescript-eslint\/no-floating-promises`/,
  );
  assert.match(
    markdown,
    /\*\*Guidance only\*\* — Check the docs before guessing\./,
  );
});

test("compileAgent flags a bad spec filename", async () => {
  const notSpec = await compileAgent(
    experimental_agent({ name: "a", description: "d" }),
    {
      specFile: "agents/reviewer.md",
      dialect: claudeCodeDialect,
    },
  );
  assert.ok(notSpec.errors.some((e) => e.type === "spec-name-mismatch"));

  const notMd = await compileAgent(
    experimental_agent({ name: "a", description: "d" }),
    {
      specFile: "reviewer.spec.ts",
      dialect: claudeCodeDialect,
    },
  );
  assert.ok(notMd.errors.some((e) => e.type === "spec-name-mismatch"));
});

test("dogfood: a real OSS subagent as a spec, with the tool rail it shipped WITHOUT", async () => {
  // Reproduces the shape of wshobson's real `ui-visual-validator` subagent
  // (test/dogfood/wshobson-accessibility@.../agents/ui-visual-validator.md):
  // model: sonnet, a multi-`##`-section role contract, and — critically — it
  // ships with NO `tools:` line, so it inherits EVERY tool (the #1 footgun). A
  // spec ADDS the least-privilege rail (read + run visual tests; never Edit/Write),
  // which compile verifies. This is the value-add over the hand-written original.
  const reviewer = experimental_agent({
    name: "ui-visual-validator",
    description:
      "Rigorous visual validation expert. Use PROACTIVELY to verify UI modifications achieved their goals.",
    model: "sonnet",
    tools: ["Read", "Grep", "Glob", "Bash"], // the rail the original omits
    body: "You are an experienced UI visual validation expert.",
    sections: {
      Purpose:
        "Verify UI modifications, design-system compliance, and accessibility through systematic visual analysis.",
      "Core Principles": [
        "- Default assumption: the goal has NOT been achieved until proven.\n",
        "- Base judgments solely on visual evidence, never code hints.",
      ],
      "Forbidden Behaviors":
        "- Assuming code changes automatically produce visual results.\n- Accepting 'looks different' as 'looks correct'.",
    },
  });

  const { markdown, errors } = await compileAgent(reviewer, {
    specFile: "agents/ui-visual-validator.md.spec.ts",
    dialect: claudeCodeDialect,
  });

  assert.deepEqual(errors, []); // real content compiles clean; tools verified
  assert.match(markdown, /\nname: ui-visual-validator\n/);
  assert.match(markdown, /\nmodel: sonnet\n/);
  assert.match(markdown, /\ntools: Read, Grep, Glob, Bash\n/); // the added rail
  assert.doesNotMatch(markdown, /\btools:.*Edit/); // least-privilege: no Edit/Write
  assert.match(markdown, /## Purpose/);
  assert.match(markdown, /## Forbidden Behaviors/);
  assert.match(
    markdown,
    /You are an experienced UI visual validation expert\./,
  );
});

test("compileAgent rejects a section that clashes with the rules field", async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "a",
      description: "d",
      sections: { rules: "this should be the rules field" },
    }),
    { specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.ok(errors.some((e) => e.type === "reserved-section-key"));
});

test("compileAgent verifies refs inside sections", async () => {
  const dir = makeTmpDir("agent-sections");
  try {
    const { errors } = await compileAgent(
      experimental_agent({
        name: "a",
        description: "d",
        sections: {
          Workflow: prose`First read ${file("missing.ts")}.`, // stale file
        },
      }),
      { basePath: dir, specFile: "a.md.spec.ts", dialect: claudeCodeDialect },
    );
    assert.ok(errors.some((e) => e.type === "stale-file"));
  } finally {
    cleanupTmpDir(dir);
  }
});

test("adoptDiff round-trips a compiled agent (valid hash, no changes)", async () => {
  const dir = makeTmpDir("agent-adopt");
  try {
    const spec = experimental_agent({
      name: "reviewer",
      description: "Review a diff.",
      tools: ["Read", "Grep"],
      body: "Review carefully.",
    });
    const { markdown } = await compileAgent(spec, {
      basePath: dir,
      specFile: "agents/reviewer.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    writeFileSync(join(dir, "agents-reviewer.md"), markdown);
    const res = await adoptDiff(
      "agents-reviewer.md",
      spec,
      dir,
      claudeCodeDialect,
    );
    assert.equal(res.changed, false);
    assert.equal(res.hasHash, true);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// purity floor contract — compileAgent
// ---------------------------------------------------------------------------

test('purity: "pure" agent with read-only tools compiles clean', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "analyzer",
      description: "Analyze code without mutating.",
      purity: "pure",
      tools: ["Read", "Grep", "Glob"],
      body: "Analyze only.",
    }),
    { specFile: "agents/analyzer.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(errors, []);
});

test('purity: "pure" agent with a side-effecting tool errors, naming the tool', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "bad",
      description: "Tries to write.",
      purity: "pure",
      tools: ["Read", "Write"],
      body: "b",
    }),
    { specFile: "agents/bad.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.equal(pureErrors.length, 1);
  assert.match(pureErrors[0].message, /"Write"/);
  assert.match(pureErrors[0].message, /side-effecting/);
});

test('purity: "pure" agent with Bash errors', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "bad",
      description: "Runs bash.",
      purity: "pure",
      tools: ["Read", "Bash"],
      body: "b",
    }),
    { specFile: "agents/bad.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /"Bash"/);
});

test('purity: "pure" agent with an unknown/MCP tool errors', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "bad",
      description: "Uses MCP.",
      purity: "pure",
      tools: ["Read", "mcp__github__issue_write"],
      body: "b",
    }),
    { specFile: "agents/bad.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /unknown effect class/);
});

test('purity: "pure" agent with wildcard tools errors', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "bad",
      description: "Inherits all.",
      purity: "pure",
      tools: ["*"],
      body: "b",
    }),
    { specFile: "agents/bad.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /inherits-all/);
});

test('purity: "pure" agent with NO tools list errors (absent = inherits-all)', async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "bad",
      description: "Pure but no tools — inherits everything.",
      purity: "pure",
      body: "b",
    }),
    { specFile: "agents/bad.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /inherits-all/);
});

test('purity: "bounded" allows decidable side-effecting tools AND Bash (runtime-gated)', async () => {
  // Write/Edit are fine in a bounded unit — effects confined to the boundary.
  const ok = await compileAgent(
    experimental_agent({
      name: "editor",
      description: "Edits within a boundary.",
      purity: "bounded",
      tools: ["Read", "Write", "Edit"],
      body: "b",
    }),
    { specFile: "agents/editor.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    ok.errors.filter((e) => e.type === "purity-violation"),
    [],
  );

  // Bash is decidable at the COMMAND level (isReadOnlyBash), so a bounded unit
  // may declare it — the runtime `decidePurityGate` confines it (read-only Bash
  // allowed, mutating Bash denied), not compile.
  const withBash = await compileAgent(
    experimental_agent({
      name: "editor2",
      description: "Observes via Bash.",
      purity: "bounded",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    { specFile: "agents/editor2.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    withBash.errors.filter((e) => e.type === "purity-violation"),
    [],
  );

  // But MCP / unknown-effect tools stay barred at the bounded floor.
  const bad = await compileAgent(
    experimental_agent({
      name: "editor3",
      description: "Tries an MCP tool.",
      purity: "bounded",
      tools: ["Read", "mcp__srv__tool"],
      body: "b",
    }),
    { specFile: "agents/editor3.md.spec.ts", dialect: claudeCodeDialect },
  );
  const boundedErrors = bad.errors.filter((e) => e.type === "purity-violation");
  assert.ok(boundedErrors.length > 0);
});

test("compileAgent emits a vigiles:purity marker the runtime gate reads", async () => {
  const { markdown } = await compileAgent(
    experimental_agent({
      name: "editor",
      description: "Edits within a boundary.",
      purity: "bounded",
      tools: ["Read", "Write"],
      body: "b",
    }),
    { specFile: "agents/editor.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.match(markdown, /<!--\s*vigiles:purity:bounded\s*-->/);

  // dangerously-unrestricted maps to the neutral runtime level `unrestricted`.
  const loud = await compileAgent(
    experimental_agent({
      name: "writer",
      description: "Writes.",
      purity: "dangerously-unrestricted",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    { specFile: "agents/writer.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.match(loud.markdown, /<!--\s*vigiles:purity:unrestricted\s*-->/);

  // no purity declared → no marker.
  const plain = await compileAgent(
    experimental_agent({ name: "plain", description: "No floor.", body: "b" }),
    { specFile: "agents/plain.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.doesNotMatch(plain.markdown, /vigiles:purity/);
});

test('purity: "dangerously-unrestricted" / omitted + side-effecting tools compiles (no enforcement)', async () => {
  // omitted
  const omitted = await compileAgent(
    experimental_agent({
      name: "writer",
      description: "Writes files.",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    { specFile: "agents/writer.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    omitted.errors.filter((e) => e.type === "purity-violation"),
    [],
  );

  // explicit escape hatch
  const escaped = await compileAgent(
    experimental_agent({
      name: "writer2",
      description: "Writes files.",
      purity: "dangerously-unrestricted",
      tools: ["Read", "Write", "Bash"],
      body: "b",
    }),
    { specFile: "agents/writer2.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    escaped.errors.filter((e) => e.type === "purity-violation"),
    [],
  );
});

// ---------------------------------------------------------------------------
// purity floor contract — compileSkill
// ---------------------------------------------------------------------------

test('purity: "pure" skill with read-only tools compiles clean', async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "review",
      description: "Review code.",
      purity: "pure",
      tools: ["Read", "Grep"],
      body: "Review.",
    }),
    { specFile: "SKILL.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.deepEqual(
    errors.filter((e) => e.type === "purity-violation"),
    [],
  );
});

test('purity: "pure" skill with a side-effecting tool errors', async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "bad",
      description: "Writes stuff.",
      purity: "pure",
      tools: ["Read", "Write"],
      body: "b",
    }),
    { specFile: "SKILL.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.equal(pureErrors.length, 1);
  assert.match(pureErrors[0].message, /"Write"/);
});

test('purity: "pure" skill with no tools declared errors (absent = inherits-all)', async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "noop",
      description: "Claims pure but inherits all tools.",
      purity: "pure",
      body: "Just think.",
    }),
    { specFile: "SKILL.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /inherits-all/);
});

test('purity: "pure" skill with wildcard tools errors', async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "bad",
      description: "Wildcard.",
      purity: "pure",
      tools: ["*"],
      body: "b",
    }),
    { specFile: "SKILL.md.spec.ts", dialect: claudeCodeDialect },
  );
  const pureErrors = errors.filter((e) => e.type === "purity-violation");
  assert.ok(pureErrors.length > 0);
  assert.match(pureErrors[0].message, /inherits-all/);
});

test("experimental_effect() body compiles to <!-- vigiles:effect --> markers in an agent", async () => {
  const { markdown } = await compileAgent(
    experimental_agent({
      name: "releaser",
      description: "Cut a release.",
      body: prose`
        ## Prepare (pure)
        Read ${file("package.json")} first.

        ## Apply
        ${experimental_effect`
          Side effects allowed ONLY here:
          - write the changelog
          - tag the version
        `}
      `,
    }),
    { specFile: "agents/releaser.md.spec.ts", dialect: claudeCodeDialect },
  );
  assert.ok(
    markdown.includes("<!-- vigiles:effect -->"),
    "should include effect open marker",
  );
  assert.ok(
    markdown.includes("<!-- /vigiles:effect -->"),
    "should include effect close marker",
  );
  assert.ok(
    markdown.includes("`package.json`"),
    "should still render outer file ref",
  );
});

test("experimental_effect() with a bad inner file ref reports stale-file error", async () => {
  const { errors } = await compileAgent(
    experimental_agent({
      name: "releaser",
      description: "Cut a release.",
      body: prose`
        ${experimental_effect`write ${file("nonexistent-xyz.md")}`}
      `,
    }),
    { specFile: "agents/releaser.md.spec.ts", dialect: claudeCodeDialect },
  );
  const stale = errors.filter((e) => e.type === "stale-file");
  assert.ok(
    stale.length > 0,
    "should report stale-file for bad ref inside experimental_effect()",
  );
});

test("experimental_effect() in a SKILL is a compile error (subagent-only primitive)", async () => {
  const { errors } = await compileSkill(
    experimental_skill({
      name: "release",
      description: "Cut a release.",
      body: prose`
        ## Apply
        ${experimental_effect`write the changelog`}
      `,
    }),
    { basePath: process.cwd() },
  );
  assert.ok(
    errors.some((e) => e.type === "effect-in-skill"),
    "experimental_effect() in a skill body should report effect-in-skill",
  );
});
