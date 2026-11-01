/**
 * The always-loaded context as Claude Code loads it (vitest, unit tier, nothing
 * spawned): its output-style selection and its skill-listing entry, run
 * through the core sum on a fixture repo.
 *
 * The Codex twin is `src/adapters/codex/always-loaded.test.ts`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyRules } from "../../core/apply-rules.js";
import { weighAlwaysLoaded } from "../../core/always-loaded.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { excludeSet } from "../../exclude.js";
import {
  formatScanReport,
  measureAlwaysLoaded,
  scanPlugin,
} from "../../scan.js";
import { scanFiles } from "../../scan-files.js";
import { claudeCodeAdapter } from "./adapter.js";
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
  return weighAlwaysLoaded({
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

describe("Claude Code always-loaded context", () => {
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
      review: "- review: Review a diff - before merge",
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
});

describe("Claude Code output-style selection", () => {
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

  it("cuts the combined text past 1,536 UTF-16 units, or the configured cap, with '…'", () => {
    const at = (n: number) => read({ description: "d".repeat(n) });
    expect(claudeCodeSkillListing.entry(at(1536), {})).toBe(
      `- x: ${"d".repeat(1536)}`,
    );
    expect(claudeCodeSkillListing.entry(at(1537), {})).toBe(
      `- x: ${"d".repeat(1535)}…`,
    );
    expect(
      claudeCodeSkillListing.entry(at(2000), { skillListingMaxDescChars: 10 }),
    ).toBe(`- x: ${"d".repeat(9)}…`);
  });
});

describe("claudeCodeSkillListing.entry: the text, as measured on 2.1.187 (the pin)", () => {
  const read = (fm: Record<string, unknown> | null, body = "") => ({
    path: ".claude/skills/x/SKILL.md",
    dirName: "x",
    frontmatter: fm,
    body,
  });

  it("joins when_to_use with ' - ' and caps the joined text", () => {
    expect(
      claudeCodeSkillListing.entry(
        read({ description: "Review", when_to_use: "before merge" }),
        {},
      ),
    ).toBe("- x: Review - before merge");
    expect(
      claudeCodeSkillListing.entry(
        read({ description: "abcdefgh", when_to_use: "ijkl" }),
        { skillListingMaxDescChars: 10 },
      ),
    ).toBe("- x: abcdefgh …");
  });

  it("leaves angle brackets and ampersands as written", () => {
    // 2.1.316 escapes them to `&lt;`/`&gt;` — see the module header.
    expect(
      claudeCodeSkillListing.entry(
        read({ description: "Run <cmd> now & then", when_to_use: "on <go>" }),
        {},
      ),
    ).toBe("- x: Run <cmd> now & then - on <go>");
  });

  it("trims the text and keeps control and format characters as written", () => {
    // 2.1.316 turns each into one space — see the module header.
    const text = "  a    b  \u0001c\u007fd​e f\n";
    expect(claudeCodeSkillListing.entry(read({ description: text }), {})).toBe(
      `- x: ${text.trim()}`,
    );
    expect(text.trim()).toContain("\u0001");
  });
});

describe("claudeCodeSkillListing.entry: the label and its fallbacks", () => {
  const read = (fm: Record<string, unknown> | null, body = "") => ({
    path: ".claude/skills/x/SKILL.md",
    dirName: "x",
    frontmatter: fm,
    body,
  });

  it("labels a skill by its directory, and keys overrides by the directory", () => {
    // 2.1.316 adds a differing name in parentheses — see the module header.
    expect(
      claudeCodeSkillListing.entry(read({ name: "X", description: "d" }), {}),
    ).toBe("- x: d");
    expect(
      claudeCodeSkillListing.entry(read({ name: "y", description: "d" }), {
        skillOverrides: { y: "off" },
      }),
    ).toBe("- x: d");
    expect(
      claudeCodeSkillListing.entry(read({ name: "y", description: "d" }), {
        skillOverrides: { x: "name-only" },
      }),
    ).toBe("- x");
  });

  it("falls back to the directory name, the first body line, then 'Skill'", () => {
    expect(
      claudeCodeSkillListing.entry(read({}, "\n\n  First <a>.\nSecond"), {}),
    ).toBe("- x: First <a>.");
    expect(claudeCodeSkillListing.entry(read({}), {})).toBe("- x: Skill");
    expect(claudeCodeSkillListing.entry(read({ when_to_use: "w" }), {})).toBe(
      "- x: Skill - w",
    );
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

/**
 * The same fixture through the two ENGINES: `scanPlugin` reads it from disk,
 * `scanFiles` from a map — the browser demo's input. They must agree field for
 * field, and the text report must print the rows.
 */
describe("Claude Code always-loaded context through scanPlugin and scanFiles", () => {
  const fixture: Record<string, string> = {
    "CLAUDE.md": "# Rules\n" + "a".repeat(200),
    ".claude/settings.json": '{"outputStyle":"Terse"}',
    ".claude/output-styles/Terse.md": "Answer in one line.",
    ".claude/output-styles/nested/Other.md": "never read",
    ".claude/skills/review/SKILL.md":
      "---\nname: review\ndescription: Review a diff\n---\nbody",
    // One folder per skill (measured on 2.1.316): neither of these is listed.
    ".claude/skills/SKILL.md": "---\ndescription: top\n---\n",
    ".claude/skills/group/nested/SKILL.md": "---\ndescription: nested\n---\n",
  };

  it("measures the same always-loaded context on disk and in the map, and prints it", () => {
    const tmp = makeTmpDir("always-loaded-cc");
    for (const [rel, body] of Object.entries(fixture)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), body);
    }
    const disk = scanPlugin(tmp, claudeCodeLayout, claudeCodeDialect);
    const map = scanFiles(fixture, claudeCodeLayout, claudeCodeDialect);
    expect(disk.alwaysLoaded).toEqual(map.alwaysLoaded);
    expect(measureAlwaysLoaded(tmp, claudeCodeAdapter).alwaysLoaded).toEqual(
      disk.alwaysLoaded,
    );
    expect(disk.alwaysLoaded?.outputStyle).toEqual({
      kind: "counted",
      total: "Answer in one line.".length,
      files: [{ path: ".claude/output-styles/Terse.md", size: 19 }],
    });
    // No rules: the weight block is printed whatever rules are on.
    const text = formatScanReport(
      applyRules([], {}, { mayFire: () => false }, disk),
    );
    expect(text).toContain(
      "+ output style:  19 chars  .claude/output-styles/Terse.md",
    );
    expect(text).toContain("+ skill listing: 23 chars  1 skill(s) listed");
    expect(text).toMatch(
      /= always loaded: [\d,]+ chars loaded at session start/,
    );
    cleanupTmpDir(tmp);
  });

  it("counts a skill folder that is a symlink, as `vigiles init` writes them", () => {
    const tmp = makeTmpDir("always-loaded-cc-link");
    mkdirSync(join(tmp, "shared/linked"), { recursive: true });
    writeFileSync(
      join(tmp, "shared/linked/SKILL.md"),
      "---\nname: linked\ndescription: Linked in\n---\n",
    );
    mkdirSync(join(tmp, ".claude/skills"), { recursive: true });
    symlinkSync(join(tmp, "shared/linked"), join(tmp, ".claude/skills/linked"));
    writeFileSync(join(tmp, "CLAUDE.md"), "# Rules\n");
    const part = measureAlwaysLoaded(tmp, claudeCodeAdapter).alwaysLoaded
      ?.skillListing;
    cleanupTmpDir(tmp);
    expect(part).toEqual({
      kind: "counted",
      total: "- linked: Linked in".length,
      files: [{ path: ".claude/skills/linked/SKILL.md", size: 19 }],
    });
  });
  it("the audit's skill count and the listing agree on symlinked skill folders", () => {
    // On a real repository the audit printed `Skills (58)` while the listing it
    // weighs carried 83: the loader refused every linked skill folder, the
    // listing reader followed them. Both now classify through one function, so
    // the only difference left is a stated reason — `exclude`, which hides a
    // skill from the audit and not from the harness.
    const tmp = makeTmpDir("always-loaded-cc-link-count");
    const skill = (dir: string, name: string): void => {
      mkdirSync(join(tmp, dir), { recursive: true });
      writeFileSync(
        join(tmp, dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: The ${name} skill\n---\n`,
      );
    };
    skill(".claude/skills/own", "own");
    skill("shared/linked", "linked");
    skill("shared/vendored", "vendored");
    symlinkSync(join(tmp, "shared/linked"), join(tmp, ".claude/skills/linked"));
    symlinkSync(
      join(tmp, "shared/vendored"),
      join(tmp, ".claude/skills/vendored"),
    );
    // A link back over the skills folder is a cycle: neither walk enters it.
    symlinkSync(join(tmp, ".claude/skills"), join(tmp, ".claude/skills/back"));
    writeFileSync(join(tmp, "CLAUDE.md"), "# Rules\n");
    const excludes = excludeSet(tmp, [".claude/skills/vendored"]);

    const audited = scanPlugin(tmp, claudeCodeLayout, claudeCodeDialect, {
      excludes,
    }).skills.map((s) => s.name);
    const listing = measureAlwaysLoaded(tmp, claudeCodeAdapter).alwaysLoaded
      ?.skillListing;
    const listed =
      listing?.kind === "counted" ? listing.files.map((f) => f.path) : [];
    const withoutExclude = scanPlugin(
      tmp,
      claudeCodeLayout,
      claudeCodeDialect,
    ).skills.map((s) => s.name);
    cleanupTmpDir(tmp);

    expect(listed).toEqual([
      ".claude/skills/linked/SKILL.md",
      ".claude/skills/own/SKILL.md",
      ".claude/skills/vendored/SKILL.md",
    ]);
    expect(audited.sort()).toEqual(["linked", "own"]);
    // The one skill apart is the excluded one, and only because of `exclude`.
    expect(withoutExclude.sort()).toEqual(["linked", "own", "vendored"]);
  });
});
