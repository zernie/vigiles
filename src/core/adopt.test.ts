/**
 * Faithful adoption suite — the deterministic markdown → spec converter.
 *
 * The load-bearing claim is ROUND-TRIP fidelity: `compile(adopt(file)) ≈ file`.
 * So beyond the structural unit checks, the `round-trip` block adopts a file,
 * compiles the resulting spec via the REAL `compileClaude`, and asserts the
 * original content is reproduced with no compile errors.
 */
import { describe, it, expect } from "vitest";

import { adoptMarkdown, adoptToSpec } from "./adopt.js";
import { compileClaude } from "./compile.js";

/** Compile an adopted file the way `vigiles init` does, returning the markdown
 *  + errors. Pure (sections-only specs touch no linter/fs). */
async function recompile(markdown: string, target = "CLAUDE.md") {
  const spec = adoptToSpec(markdown, target);
  return await compileClaude(
    {
      _specType: "claude",
      target: spec.target,
      sections: spec.sections,
      maxSectionLines: spec.maxSectionLines,
      rules: {},
    },
    { specFile: `${target}.spec.ts` },
  );
}

describe("adoptToSpec — structure", () => {
  it("maps a clean h1 + ## file 1:1 to sections (structured tier)", () => {
    const md = `# CLAUDE.md

## Positioning

What this does.

## Commands

- \`npm test\` — run tests
`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(spec.tier).toBe("structured");
    expect(Object.keys(spec.sections)).toEqual(["Positioning", "Commands"]);
    expect(spec.sections["Positioning"]).toBe("What this does.");
    // "Commands" is kept as a faithful prose section (verbatim), NOT routed to
    // the structured commands field — adoption never validates, just reproduces.
    expect(spec.sections["Commands"]).toBe("- `npm test` — run tests");
  });

  it("drops the title h1 (the compiler re-renders it from the filename)", () => {
    const spec = adoptToSpec(
      `# My Project Guide\n\n## A\n\nbody\n`,
      "CLAUDE.md",
    );
    // No "My Project Guide" / "CLAUDE.md" section — the h1 is consumed.
    expect(Object.keys(spec.sections)).toEqual(["A"]);
  });

  it("keeps ### subheadings INSIDE a section body (compiler allows them)", () => {
    const md = `# CLAUDE.md

## Rules

### No console

Use the logger.

### No any

Type it.
`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(Object.keys(spec.sections)).toEqual(["Rules"]);
    expect(spec.sections["Rules"]).toContain("### No console");
    expect(spec.sections["Rules"]).toContain("### No any");
  });

  it("capitalizes a reserved lowercase heading key (no compile clash)", () => {
    const spec = adoptToSpec(`# CLAUDE.md\n\n## rules\n\nx\n`, "CLAUDE.md");
    expect(Object.keys(spec.sections)).toEqual(["Rules"]); // not the reserved "rules"
  });

  it("does NOT split on a ## inside a fenced code block", () => {
    const md = `# CLAUDE.md

## Shell

\`\`\`sh
## not a heading
echo hi
\`\`\`
`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(Object.keys(spec.sections)).toEqual(["Shell"]);
    expect(spec.sections["Shell"]).toContain("## not a heading");
  });

  it("does NOT mis-split on a ## inside a NESTED / UNBALANCED fence (the toggle-bug regression)", () => {
    // A stray single ``` inside a 4-backtick block is an ODD number of
    // fence-looking lines — the old naive `inFence = !inFence` toggle flipped to
    // "outside" and promoted the following `##` to a bogus section, swallowing
    // the real `## Rules` after it. The shared markdown-it oracle keeps the whole
    // outer block fenced, so only Setup + Rules are real sections.
    const md = `# CLAUDE.md

## Setup

\`\`\`\`markdown
To open a code block, type:
\`\`\`
## Heading INSIDE the outer block
\`\`\`\`

## Rules

Be nice.
`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(Object.keys(spec.sections)).toEqual(["Setup", "Rules"]);
    // The in-block `##` rides along verbatim in Setup; Rules survives as its own.
    expect(spec.sections["Setup"]).toContain(
      "## Heading INSIDE the outer block",
    );
    expect(spec.sections["Rules"]).toBe("Be nice.");
  });

  it("round-trips a nested-fence file through compile with zero drift", async () => {
    const md = `# CLAUDE.md

## Setup

\`\`\`\`markdown
To open a code block, type:
\`\`\`
## Heading INSIDE the outer block
\`\`\`\`

## Rules

Be nice.
`;
    const { markdown, errors } = await recompile(md);
    expect(errors).toEqual([]);
    // The exact source of the outer block is reproduced (no blank lines injected
    // around the in-block `##`, which the mis-split used to do).
    expect(markdown).toContain(
      "````markdown\nTo open a code block, type:\n```\n## Heading INSIDE the outer block\n````",
    );
  });

  it("dedupes duplicate headings instead of dropping content", () => {
    const md = `# CLAUDE.md\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(Object.keys(spec.sections)).toEqual(["Notes", "Notes (2)"]);
    expect(spec.sections["Notes"]).toBe("first");
    expect(spec.sections["Notes (2)"]).toBe("second");
  });

  it("wraps a heading-less file under a synthesized Overview (raw tier)", () => {
    const spec = adoptToSpec(`Just some prose.\n\nMore prose.\n`, "AGENTS.md");
    expect(spec.tier).toBe("raw");
    expect(Object.keys(spec.sections)).toEqual(["Overview"]);
    expect(spec.sections["Overview"]).toBe("Just some prose.\n\nMore prose.");
  });

  it("routes intro prose under the h1 into Overview (raw tier)", () => {
    const md = `# CLAUDE.md\n\nIntro paragraph.\n\n## Section\n\nbody\n`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    expect(spec.tier).toBe("raw");
    expect(Object.keys(spec.sections)).toEqual(["Overview", "Section"]);
    expect(spec.sections["Overview"]).toBe("Intro paragraph.");
  });

  it("does not drop intro text when a literal ## Overview already exists", () => {
    // Intro prose (→ synthesized Overview) PLUS a real `## Overview` heading must
    // not collide on one key — both contents are preserved (the later wins the
    // key otherwise, silently dropping the intro).
    const md = `# CLAUDE.md\n\nIntro lead-in.\n\n## Overview\n\nReal overview body.\n`;
    const spec = adoptToSpec(md, "CLAUDE.md");
    const values = Object.values(spec.sections).join("\n");
    expect(values).toContain("Intro lead-in.");
    expect(values).toContain("Real overview body.");
    expect(Object.keys(spec.sections).length).toBe(2); // two distinct keys
  });

  /**
   * Adoption must not fail on prose the user already has, so the guard is
   * raised — but to EXACTLY the longest section, never above it. The old
   * `longest + 50` pre-approved the next fifty lines of growth for the one
   * population whose file is already oversized, which is the opposite of what
   * a guard is for. Asserting the exact value is the whole point: any headroom
   * at all is the defect.
   */
  it("raises maxSectionLines to exactly the longest section, with no headroom", () => {
    const long = Array.from({ length: 220 }, (_, i) => `line ${i}`).join("\n");
    const spec = adoptToSpec(`# CLAUDE.md\n\n## Big\n\n${long}\n`, "CLAUDE.md");
    expect(spec.maxSectionLines).toBe(220);
  });

  it("leaves the guard alone when every section fits", () => {
    const spec = adoptToSpec(`# CLAUDE.md\n\n## Small\n\nshort\n`, "CLAUDE.md");
    expect(spec.maxSectionLines).toBeUndefined();
  });
});

describe("adoptMarkdown — generated source", () => {
  /**
   * The raised guard ships with its debt in words. A bare number reads as a
   * considered setting; without the comment nobody can tell that the value was
   * accepted as-is, or by how much it exceeds the budget.
   */
  it("renders the raised guard as a stated debt, not a bare number", () => {
    const long = Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n");
    const { source } = adoptMarkdown(
      `# CLAUDE.md\n\n## Big\n\n${long}\n`,
      "CLAUDE.md",
    );
    expect(source).toContain("maxSectionLines: 260,");
    expect(source).toContain("Adopted as-is");
    expect(source).toContain("60 over the 200-line budget");
    expect(source).toContain("it is a debt, not a setting");
  });

  it("emits a target line only for a non-CLAUDE.md target", () => {
    expect(
      adoptMarkdown(`# CLAUDE.md\n\n## A\n\nx\n`, "CLAUDE.md").source,
    ).not.toContain("target:");
    expect(
      adoptMarkdown(`# AGENTS.md\n\n## A\n\nx\n`, "AGENTS.md").source,
    ).toContain('target: "AGENTS.md"');
  });

  it("imports claude, emits empty rules, and never infers a rule", () => {
    const { source } = adoptMarkdown(`# CLAUDE.md\n\n## A\n\nx\n`, "CLAUDE.md");
    expect(source).toContain('import { instructionFile } from "vigiles/spec"');
    expect(source).toContain("rules: {},");
    // No rule is INFERRED — only `claude` is imported (no enforce/guidance import).
    expect(source).not.toContain("import { claude, ");
    expect(source).not.toContain('"vigiles/spec";\nimport');
  });

  it("escapes backticks and ${} so the generated template literal is valid", () => {
    const md = "# CLAUDE.md\n\n## Cmds\n\nRun `npm test` and `${X}` now.\n";
    const { source } = adoptMarkdown(md, "CLAUDE.md");
    expect(source).toContain("\\`npm test\\`");
    expect(source).toContain("\\${X}");
  });
});

describe("round-trip — compile(adopt(file)) ≈ file", () => {
  it("reproduces a clean structured file with no compile errors", async () => {
    const md = `# CLAUDE.md

## Positioning

What this project does and why.

## Architecture

- \`src/index.ts\` — entry point

## Rules

### No console

Use the structured logger, not console.log.
`;
    const out = await recompile(md);
    expect(out.errors).toEqual([]);
    expect(out.markdown).toContain("## Positioning");
    expect(out.markdown).toContain("What this project does and why.");
    expect(out.markdown).toContain("### No console");
    expect(out.markdown).toContain(
      "Use the structured logger, not console.log.",
    );
    // The canonical h1 is the filename (below the integrity header).
    expect(out.markdown).toContain("\n# CLAUDE.md\n");
  });

  it("preserves backtick-heavy content verbatim through the round-trip", async () => {
    const md =
      "# CLAUDE.md\n\n## Commands\n\n- `npm run build` — compile\n- `npm test` — test\n";
    const out = await recompile(md);
    expect(out.errors).toEqual([]);
    expect(out.markdown).toContain("- `npm run build` — compile");
    expect(out.markdown).toContain("- `npm test` — test");
  });

  it("reproduces a raw-tier (heading-less) file under Overview, no errors", async () => {
    const out = await recompile(
      "Plain agent instructions.\n\nDo the thing.\n",
      "AGENTS.md",
    );
    expect(out.errors).toEqual([]);
    expect(out.markdown).toContain("## Overview");
    expect(out.markdown).toContain("Plain agent instructions.");
    expect(out.markdown).toContain("Do the thing.");
  });
});

/* ── adoption extracts refs that RESOLVE (2026-09-02) ──────────────────────── */
/*
 * The measured problem: adoption transcribed faithfully and extracted NOTHING, so
 * the price (build artifact, blocked hand edits, escaped backticks) was paid at
 * once while the payoff waited on a manual pass nobody ran. The filter is not a
 * heuristic about what LOOKS like our path — it is whether the path RESOLVES here
 * and now, which is exactly what makes a described third-party repo's path
 * unemittable rather than a false positive.
 */
describe("adoption emits verified refs for paths that resolve", () => {
  const here = new Set(["docs/guide.md", "scripts/lint.sh"]);
  const exists = (p: string) => here.has(p);

  it("emits file() for a backticked path that resolves today", () => {
    const r = adoptMarkdown(
      "## Setup\n\nRead `docs/guide.md` first.\n",
      "CLAUDE.md",
      { exists },
    );
    expect(r.source).toMatch(/\$\{file\("docs\/guide\.md"\)\}/);
    expect(r.adoptedRefs).toEqual(["docs/guide.md"]);
    expect(r.source).toMatch(/import \{ instructionFile, file \}/);
  });

  it("leaves a path that does NOT resolve as inert prose", () => {
    // The 907-unresolvable half of the adopter's corpus: paths inside the repo a
    // skill DESCRIBES. Emitting these is what would make compile start red.
    const r = adoptMarkdown(
      "## X\n\nSee `internal/checkout/service.go`.\n",
      "CLAUDE.md",
      { exists },
    );
    expect(r.source).not.toMatch(/\$\{file\(/);
    expect(r.adoptedRefs).toEqual([]);
    expect(r.source).toMatch(/import \{ instructionFile \}/);
  });

  it("never emits a URL, an absolute path, a home path or an escape", () => {
    const md =
      "## X\n\n`https://ex.com/a/b` `/etc/passwd` `~/.ssh/id_rsa` `../../etc/x`\n";
    const r = adoptMarkdown(md, "CLAUDE.md", { exists: () => true });
    expect(r.adoptedRefs).toEqual([]);
  });

  it("ignores a path inside a fenced block — it is example code, not a claim", () => {
    // The path inside the fence is BACKTICKED — a markdown example. Without that
    // the matcher never reaches it and the fence guard is not exercised at all
    // (measured: a mutation removing the guard stayed green on the earlier fixture).
    const md =
      "## X\n\n````md\nSee `docs/guide.md` in the guide\n````\n\nAnd `docs/guide.md` in prose.\n";
    const r = adoptMarkdown(md, "CLAUDE.md", { exists });
    // Exactly one: the prose mention, never the fenced one.
    expect(r.adoptedRefs).toEqual(["docs/guide.md"]);
  });

  it("without an exists predicate the behaviour is unchanged (extract nothing)", () => {
    const r = adoptMarkdown("## X\n\nRead `docs/guide.md`.\n", "CLAUDE.md");
    expect(r.source).not.toMatch(/\$\{file\(/);
    expect(r.source).toMatch(/import \{ instructionFile \}/);
  });
});
