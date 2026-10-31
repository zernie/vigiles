/**
 * The fixed context as Codex loads it (vitest, unit tier, nothing spawned):
 * bytes, not characters; no output styles at all; and its own skill-listing
 * entry shape. The Claude Code twin is
 * `src/adapters/claude-code/fixed-context.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { weighFixedContext } from "../../core/fixed-context.js";
import { sizeIn } from "../../core/harness-unit.js";
import { codexDialect } from "./dialect.js";
import { codexLayout } from "./layout.js";
import { codexSkillListing } from "./skill-listing.js";

const INSTRUCTION_FILE = codexLayout.instructionFile;

/**
 * The instructions' committed total, sized the way the weight sizes it — the
 * chain itself is the instruction weight's own suite; here only the root file
 * exists, so its size IS the committed total.
 */
function weigh(files: Record<string, string>) {
  const root = files[INSTRUCTION_FILE];
  return weighFixedContext({
    weight: {
      unit: "bytes",
      committedTotal: root === undefined ? 0 : sizeIn(root, "bytes"),
    },
    files,
    layout: codexLayout,
    dialect: codexDialect,
  });
}

describe("Codex fixed context", () => {
  it("weighs instructions and listing in bytes; output styles are not supported", () => {
    const description = "Проверяет дифф"; // 14 chars, 27 bytes
    const f = weigh({
      "AGENTS.md": "a".repeat(100),
      ".agents/skills/review/SKILL.md": `---\nname: review\ndescription: ${description}\n---\nbody`,
    });
    const line = `- review: ${description} (file: .agents/skills/review/SKILL.md)`;
    expect(f.unit).toBe("bytes");
    expect(f.outputStyle).toEqual({ kind: "not-supported" });
    expect(f.skillListing).toEqual({
      kind: "counted",
      total: Buffer.byteLength(line, "utf8"),
      files: [
        {
          path: ".agents/skills/review/SKILL.md",
          size: Buffer.byteLength(line, "utf8"),
        },
      ],
    });
    expect(f.total).toBe(100 + Buffer.byteLength(line, "utf8"));
  });
});

describe("codexSkillListing.entry", () => {
  const read = (fm: Record<string, unknown> | null) => ({
    path: ".agents/skills/x/SKILL.md",
    dirName: "x",
    frontmatter: fm,
    body: "",
  });

  it("caps the description at 1,024 characters", () => {
    const line = codexSkillListing.entry(
      read({ description: "d".repeat(2000) }),
      {},
    );
    expect(line).toBe(
      `- x: ${"d".repeat(1024)} (file: .agents/skills/x/SKILL.md)`,
    );
  });

  it("renders an empty description without a dangling space", () => {
    expect(codexSkillListing.entry(read({}), {})).toBe(
      "- x: (file: .agents/skills/x/SKILL.md)",
    );
    expect(codexSkillListing.entry(read(null), {})).toBe(
      "- x: (file: .agents/skills/x/SKILL.md)",
    );
  });
});
