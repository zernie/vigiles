/**
 * The fixed context as Claude Code loads it (vitest, unit tier, nothing
 * spawned): its output-style selection and its skill-listing entry, run
 * through the core sum on a fixture repo.
 *
 * The Codex twin is `src/adapters/codex/fixed-context.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { weighFixedContext } from "../../core/fixed-context.js";
import { sizeIn } from "../../core/harness-unit.js";
import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeOutputStyles } from "./output-style.js";
import { claudeCodeSkillListing } from "./skill-listing.js";

const INSTRUCTION_FILE = claudeCodeLayout.instructionFile;

/**
 * The instructions' committed total, sized the way the weight sizes it — the
 * chain itself is the instruction weight's own suite; here only the root file
 * exists, so its size IS the committed total.
 */
function weigh(files: Record<string, string>) {
  const root = files[INSTRUCTION_FILE];
  return weighFixedContext({
    weight: {
      unit: "chars",
      committedTotal: root === undefined ? 0 : sizeIn(root, "chars"),
    },
    files,
    layout: claudeCodeLayout,
    dialect: claudeCodeDialect,
  });
}

const skill = (fm: string, body = "Body line.\n"): string =>
  `---\n${fm}\n---\n${body}`;

describe("Claude Code fixed context", () => {
  it("counts CLAUDE.md, the selected style's body and each listed entry", () => {
    const f = weigh({
      "CLAUDE.md": "a".repeat(1000),
      ".claude/settings.json": JSON.stringify({
        outputStyle: "Terse Talk",
        skillOverrides: { brief: "name-only" },
      }),
      ".claude/output-styles/terse.md":
        "---\nname: Terse Talk\n---\n" + "s".repeat(300),
      ".claude/skills/review/SKILL.md": skill(
        "name: review\ndescription: Review a diff\nwhen_to_use: before merge",
      ),
      ".claude/skills/brief/SKILL.md": skill("description: never shown"),
      ".claude/skills/manual/SKILL.md": skill(
        "description: x\ndisable-model-invocation: true",
      ),
      "skills/plugin-only/SKILL.md": skill("description: a plugin's user pays"),
    });
    expect(f.unit).toBe("chars");
    expect(f.instructions).toBe(1000);
    expect(f.outputStyle).toEqual({
      kind: "counted",
      total: 300,
      files: [{ path: ".claude/output-styles/terse.md", size: 300 }],
    });
    const entries = {
      brief: "- brief",
      review: "- review: Review a diff before merge",
    };
    expect(f.skillListing).toEqual({
      kind: "counted",
      total: entries.brief.length + entries.review.length,
      files: [
        { path: ".claude/skills/brief/SKILL.md", size: entries.brief.length },
        { path: ".claude/skills/review/SKILL.md", size: entries.review.length },
      ],
    });
    expect(f.total).toBe(
      1000 + 300 + entries.brief.length + entries.review.length,
    );
  });

  it("reads a style name in exact case: a wrong case is unresolved, not counted", () => {
    const f = weigh({
      ".claude/settings.json": '{"outputStyle":"terse talk"}',
      ".claude/output-styles/terse.md": "---\nname: Terse Talk\n---\nbody",
    });
    expect(f.outputStyle).toEqual({ kind: "unresolved", name: "terse talk" });
  });

  it("selects nothing for `default`, an absent key, or a per-machine file", () => {
    expect(
      claudeCodeOutputStyles.selected?.({ outputStyle: "Default" }),
    ).toEqual({ kind: "default" });
    expect(claudeCodeOutputStyles.selected?.({})).toEqual({ kind: "unset" });
    const local = weigh({
      ".claude/settings.local.json": '{"outputStyle":"Terse"}',
      ".claude/output-styles/Terse.md": "body",
    });
    expect(local.outputStyle).toEqual({ kind: "none" });
  });
});

describe("claudeCodeSkillListing.entry", () => {
  const read = (fm: Record<string, unknown> | null, body = "") => ({
    path: ".claude/skills/x/SKILL.md",
    dirName: "x",
    frontmatter: fm,
    body,
  });

  it("caps the combined text at 1,536 characters, or the configured cap", () => {
    const long = read({ description: "d".repeat(2000) });
    expect(claudeCodeSkillListing.entry(long, {})?.length).toBe(
      "- x: ".length + 1536,
    );
    const capped = claudeCodeSkillListing.entry(long, {
      skillListingMaxDescChars: 10,
    });
    expect(capped).toBe(`- x: ${"d".repeat(10)}`);
  });

  it("falls back to the directory name and the first body line", () => {
    expect(
      claudeCodeSkillListing.entry(read({}, "\n\n  First.\nSecond"), {}),
    ).toBe("- x: First.");
  });

  it("does not list malformed, hidden or overridden-off skills", () => {
    expect(claudeCodeSkillListing.entry(read(null), {})).toBeNull();
    for (const value of ["off", "user-invocable-only"]) {
      expect(
        claudeCodeSkillListing.entry(read({ description: "d" }), {
          skillOverrides: { x: value },
        }),
      ).toBeNull();
    }
  });
});
