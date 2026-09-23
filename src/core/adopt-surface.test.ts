/**
 * Skill / subagent adoption suite — the deferred harness-parity gap closed:
 * `init` adopts CLAUDE.md AND every SKILL.md / agents/<name>.md into a typed
 * spec. The load-bearing checks are ROUND-TRIPS: adopt a file, compile the
 * resulting spec via the REAL compileSkill/compileAgent, and assert the body +
 * standard frontmatter come back. Plus dogfood over the real vendored plugins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { adoptSkill, adoptAgent } from "./adopt.js";
import { compileSkill, compileAgent } from "./compile.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import type { SkillSpec, AgentSpec } from "./spec.js";

describe("adoptSkill", () => {
  it("round-trips a clean skill: standard frontmatter + verbatim body", async () => {
    const md = `---
name: my-skill
description: Do a useful thing on request
---

# My Skill

Use this when the user wants a useful thing.

## Usage

\`\`\`bash
/my-skill <arg>
\`\`\`
`;
    const r = adoptSkill(md, "my-skill");
    expect(r.kind).toBe("skill");
    const spec = r.spec as SkillSpec;
    expect(spec.name).toBe("my-skill");
    expect(spec.description).toBe("Do a useful thing on request");
    // body is carried verbatim (## headings stay in the skill body)
    expect(spec.body).toContain("## Usage");
    expect(spec.body).toContain("/my-skill <arg>");

    const { markdown, errors } = await compileSkill(spec, {
      specFile: "skills/my-skill/SKILL.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    expect(errors).toEqual([]);
    expect(markdown).toContain("name: my-skill");
    expect(markdown).toContain("description: Do a useful thing on request");
    expect(markdown).toContain("## Usage");
  });

  it("falls back to the first paragraph for description when frontmatter omits it", () => {
    const md = `---
name: advisor
---

# Advisor

Route a prompt through the local CLI and persist the result.

More detail here.
`;
    const spec = adoptSkill(md, "advisor").spec as SkillSpec;
    expect(spec.description).toBe(
      "Route a prompt through the local CLI and persist the result.",
    );
  });

  it("maps allowed-tools to the tools contract", () => {
    const md = `---
name: reader
description: read-only helper
allowed-tools: Read, Grep, Glob
---

Body.
`;
    const spec = adoptSkill(md, "reader").spec as SkillSpec;
    expect(spec.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("round-trips EVERY standard skill frontmatter field through adopt → compile → re-adopt (issue #107 class)", async () => {
    // The prevention for the #107 class — a field that compile EMITS but adopt
    // never READS (or vice versa) silently drops on the round-trip. Populate every
    // standard CC skill key and assert each one survives adopt → compile →
    // re-adopt. A new field added to one side but not the other fails here.
    const md = `---
name: full-skill
description: A fully specified skill covering every standard frontmatter field
allowed-tools: Read, Grep, Glob
context: fork
argument-hint: <file> [flag]
---

Do the work.
`;
    const first = adoptSkill(md, "full-skill").spec as SkillSpec;
    const { markdown, errors } = await compileSkill(first, {
      specFile: "skills/full-skill/SKILL.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    expect(errors).toEqual([]);
    const back = adoptSkill(markdown, "full-skill").spec as SkillSpec;
    // Every field the adopter reads must be identical after the round-trip.
    expect(back.name).toBe(first.name);
    expect(back.description).toBe(first.description);
    expect(back.tools).toEqual(first.tools);
    expect(back.context).toBe(first.context);
    expect(back.argumentHint).toBe(first.argumentHint);
    const bodyText = (b: SkillSpec["body"]): string =>
      (typeof b === "string" ? b : (b ?? []).map(String).join("")).trim();
    expect(bodyText(back.body)).toBe(bodyText(first.body));
  });

  it("round-trips allowed-tools + context: fork through adopt → compile (issue #107)", async () => {
    const md = `---
name: reviewer
description: Review a changed file for defects
allowed-tools: Read, Grep, Glob
context: fork
---

Review the file.
`;
    const r = adoptSkill(md, "reviewer");
    const spec = r.spec as SkillSpec;
    expect(spec.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(spec.context).toBe("fork");
    // context: fork is a known key → it must NOT surface as an unmapped-key note.
    expect(r.unmappedKeys).not.toContain("context");

    const { markdown, errors } = await compileSkill(spec, {
      specFile: "skills/reviewer/SKILL.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    expect(errors).toEqual([]);
    // The skill tool key is `allowed-tools` (NOT `tools:`), emitted as a real
    // YAML sequence, and `context: fork` survives.
    expect(markdown).toMatch(/allowed-tools: \[Read, Grep, Glob\]/);
    expect(markdown).not.toMatch(/\ntools: /); // never the subagent key for a skill
    expect(markdown).toContain("context: fork");

    // Re-reading the compiled skill yields the SAME tool contract (full round-trip).
    const back = adoptSkill(markdown, "reviewer").spec as SkillSpec;
    expect(back.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(back.context).toBe("fork");
  });

  it("reports a non-standard frontmatter key instead of silently dropping it", () => {
    const md = `---
name: x
description: y
license: MIT
---

Body.
`;
    const r = adoptSkill(md, "x");
    expect(r.unmappedKeys).toContain("license");
    expect(r.source).toContain("NOTE:");
    expect(r.source).toContain("license");
  });

  it("still reports unmapped keys when the frontmatter YAML is MALFORMED (dogfood E3)", () => {
    // An unquoted `: ` in a value makes the block invalid YAML, so js-yaml gives
    // no parsed map — the custom key would otherwise vanish silently. The raw
    // key-scan fallback must still surface it in the NOTE.
    const md = `---
name: x
description: breaks yaml: an unquoted colon
custom-key: keep me
---

Body.
`;
    const r = adoptSkill(md, "x");
    expect(r.unmappedKeys).toContain("custom-key");
    expect(r.source).toContain("NOTE:");
    expect(r.source).toContain("custom-key");
  });

  it("uses the directory name when frontmatter has no name", () => {
    const spec = adoptSkill("Just a body, no frontmatter.\n", "from-dir")
      .spec as SkillSpec;
    expect(spec.name).toBe("from-dir");
  });
});

describe("adoptAgent", () => {
  it("round-trips a clean subagent: splits ## headings into sections", async () => {
    const md = `---
name: reviewer
description: Reviews code for correctness
model: sonnet
tools: Read, Grep, Glob
---

You are a meticulous code reviewer.

## Method

Read the diff, then report findings by severity.
`;
    const r = adoptAgent(md, "reviewer");
    expect(r.kind).toBe("agent");
    const spec = r.spec as AgentSpec;
    expect(spec.name).toBe("reviewer");
    expect(spec.model).toBe("sonnet");
    expect(spec.tools).toEqual(["Read", "Grep", "Glob"]);
    // the lead prose becomes body; the ## heading becomes a section (agent
    // sections reject ## in the body)
    expect(spec.body).toContain("meticulous code reviewer");
    expect(spec.sections?.Method).toContain("report findings by severity");

    const { markdown, errors } = await compileAgent(spec, {
      specFile: "agents/reviewer.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    expect(errors).toEqual([]);
    expect(markdown).toContain("name: reviewer");
    expect(markdown).toContain("## Method");
  });

  it("maps model/color/disallowedTools and reports an unmappable key", () => {
    const md = `---
name: critic
description: final quality gate
model: opus
level: 3
disallowedTools: Write, Edit
---

You are the final quality gate.
`;
    const r = adoptAgent(md, "critic");
    const spec = r.spec as AgentSpec;
    expect(spec.model).toBe("opus");
    expect(spec.disallowedTools).toEqual(["Write", "Edit"]);
    expect(r.unmappedKeys).toContain("level");
    expect(spec.body).toContain("final quality gate");
  });

  it("surfaces a never-available tool on compile (it doesn't hide the bug)", async () => {
    const md = `---
name: tester
description: tests things
tools: Read, AskUserQuestion
---

You test things.
`;
    const spec = adoptAgent(md, "tester").spec as AgentSpec;
    const { errors } = await compileAgent(spec, {
      specFile: "agents/tester.md.spec.ts",
      dialect: claudeCodeDialect,
    });
    expect(errors.some((e) => e.message.includes("AskUserQuestion"))).toBe(
      true,
    );
  });
});

describe("dogfood: adopt real vendored surfaces", () => {
  const ask = "test/dogfood/oh-my-claudecode@deee3a4/skills/ask/SKILL.md";
  const critic = "test/dogfood/oh-my-claudecode@deee3a4/agents/critic.md";

  it.skipIf(!existsSync(ask))(
    "adopts a real SKILL.md that compiles clean",
    async () => {
      const spec = adoptSkill(readFileSync(ask, "utf8"), "ask")
        .spec as SkillSpec;
      expect(spec.name).toBe("ask");
      const { errors } = await compileSkill(spec, {
        specFile: "skills/ask/SKILL.md.spec.ts",
        dialect: claudeCodeDialect,
      });
      expect(errors).toEqual([]);
    },
  );

  it.skipIf(!existsSync(critic))(
    "adopts a real subagent (custom `level:` reported, body preserved)",
    async () => {
      const r = adoptAgent(readFileSync(critic, "utf8"), "critic");
      const spec = r.spec as AgentSpec;
      expect(spec.name).toBe("critic");
      expect(spec.disallowedTools).toEqual(["Write", "Edit"]);
      expect(r.unmappedKeys).toContain("level");
      const { errors } = await compileAgent(spec, {
        specFile: "agents/critic.md.spec.ts",
        dialect: claudeCodeDialect,
      });
      expect(errors).toEqual([]);
    },
  );
});
