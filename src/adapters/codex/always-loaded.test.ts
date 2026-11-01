/**
 * The always-loaded context as Codex loads it (vitest, unit tier, nothing spawned):
 * bytes, not characters; no output styles at all; and its own skill-listing
 * entry shape. The Claude Code twin is
 * `src/adapters/claude-code/always-loaded.test.ts`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { weighAlwaysLoaded } from "../../core/always-loaded.js";
import { sizeIn } from "../../core/harness-unit.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { excludeSet } from "../../exclude.js";
import { measureAlwaysLoaded, scanPlugin } from "../../scan.js";
import { scanFiles } from "../../scan-files.js";
import { codexAdapter } from "./adapter.js";
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
  return weighAlwaysLoaded({
    weight: {
      unit: "bytes",
      committedTotal: root === undefined ? 0 : sizeIn(root, "bytes"),
    },
    files,
    layout: codexLayout,
    dialect: codexDialect,
  });
}

describe("Codex always-loaded context", () => {
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

  it("cuts a description over 1,024 characters to 1,021 and '...'", () => {
    const line = codexSkillListing.entry(
      read({ description: "d".repeat(2000) }),
      {},
    );
    expect(line).toBe(
      `- x: ${"d".repeat(1021)}... (file: .agents/skills/x/SKILL.md)`,
    );
    // Exactly at the cap: kept whole, no suffix.
    expect(
      codexSkillListing.entry(read({ description: "d".repeat(1024) }), {}),
    ).toBe(`- x: ${"d".repeat(1024)} (file: .agents/skills/x/SKILL.md)`);
  });

  it("counts the cap in code points, so an emoji is one character", () => {
    const line = codexSkillListing.entry(
      read({ description: "😀".repeat(1100) }),
      {},
    );
    expect(line).toBe(
      `- x: ${"😀".repeat(1021)}... (file: .agents/skills/x/SKILL.md)`,
    );
  });

  it("collapses whitespace in the name and the description to single spaces", () => {
    expect(
      codexSkillListing.entry(
        read({ name: " my\n  skill ", description: "line one\n  line\ttwo\n" }),
        {},
      ),
    ).toBe("- my skill: line one line two (file: .agents/skills/x/SKILL.md)");
  });
});

describe("codexSkillListing.entry: skills Codex does not list", () => {
  const read = (fm: Record<string, unknown> | null) => ({
    path: ".agents/skills/x/SKILL.md",
    dirName: "x",
    frontmatter: fm,
    body: "",
  });

  it("does not list a skill Codex fails to parse", () => {
    // No frontmatter block, a block that is not YAML, no description, a
    // description that is only whitespace, a name over 64 characters.
    expect(codexSkillListing.entry(read({}), {})).toBeNull();
    expect(codexSkillListing.entry(read(null), {})).toBeNull();
    expect(codexSkillListing.entry(read({ name: "x" }), {})).toBeNull();
    expect(
      codexSkillListing.entry(read({ description: " \n\t" }), {}),
    ).toBeNull();
    expect(
      codexSkillListing.entry(
        read({ name: "n".repeat(65), description: "d" }),
        {},
      ),
    ).toBeNull();
    expect(
      codexSkillListing.entry(
        read({ name: "n".repeat(64), description: "d" }),
        {},
      ),
    ).toBe(`- ${"n".repeat(64)}: d (file: .agents/skills/x/SKILL.md)`);
  });

  it("falls back to the directory name when the frontmatter has none", () => {
    expect(codexSkillListing.entry(read({ description: "d" }), {})).toBe(
      "- x: d (file: .agents/skills/x/SKILL.md)",
    );
  });
});

describe("Codex always-loaded context through scanPlugin and scanFiles", () => {
  const fixture: Record<string, string> = {
    "AGENTS.md": "# Rules\nÜbersicht\n",
    ".agents/skills/review/SKILL.md":
      "---\nname: review\ndescription: Prüft einen Diff\n---\nbody",
  };

  it("measures the same bytes on disk and in the map", () => {
    const tmp = makeTmpDir("always-loaded-codex");
    for (const [rel, body] of Object.entries(fixture)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), body);
    }
    const disk = scanPlugin(tmp, codexLayout, codexDialect);
    const map = scanFiles(fixture, codexLayout, codexDialect);
    expect(disk.alwaysLoaded).toEqual(map.alwaysLoaded);
    expect(measureAlwaysLoaded(tmp, codexAdapter).alwaysLoaded).toEqual(
      disk.alwaysLoaded,
    );
    const line =
      "- review: Prüft einen Diff (file: .agents/skills/review/SKILL.md)";
    expect(disk.alwaysLoaded).toEqual({
      unit: "bytes",
      instructions: Buffer.byteLength(fixture["AGENTS.md"] ?? "", "utf8"),
      outputStyle: { kind: "not-supported" },
      skillListing: {
        kind: "counted",
        total: Buffer.byteLength(line, "utf8"),
        files: [
          {
            path: ".agents/skills/review/SKILL.md",
            size: Buffer.byteLength(line, "utf8"),
          },
        ],
      },
      total:
        Buffer.byteLength(fixture["AGENTS.md"] ?? "", "utf8") +
        Buffer.byteLength(line, "utf8"),
      // No committed `[skills] max_context_tokens`: the thread-start budget.
      skillListingLimit: { kind: "limit", limit: 8000 },
    });
    cleanupTmpDir(tmp);
  });
});

describe("Codex walks its skills folder recursively", () => {
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: d\n---\nbody`;
  // Measured on codex-cli 0.153.0: the first four are listed, the last two not.
  const fixture: Record<string, string> = {
    "AGENTS.md": "# Rules\n",
    ".agents/skills/SKILL.md": skill("top"),
    ".agents/skills/group/nested/SKILL.md": skill("nested"),
    ".agents/skills/p/SKILL.md": skill("parent"),
    ".agents/skills/a/b/c/d/e/f/SKILL.md": skill("six"),
    ".agents/skills/a/b/c/d/e/f/g/SKILL.md": skill("seven"),
    ".agents/skills/.hidden/h/SKILL.md": skill("hidden"),
  };
  // In `localeCompare` order, as the part lists them.
  const listed = [
    ".agents/skills/a/b/c/d/e/f/SKILL.md",
    ".agents/skills/group/nested/SKILL.md",
    ".agents/skills/p/SKILL.md",
    ".agents/skills/SKILL.md",
  ];

  it("counts a nested skill on disk and in the map, and skips what Codex skips", () => {
    const tmp = makeTmpDir("always-loaded-codex-nested");
    for (const [rel, body] of Object.entries(fixture)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), body);
    }
    const disk = scanPlugin(tmp, codexLayout, codexDialect).alwaysLoaded;
    const map = scanFiles(fixture, codexLayout, codexDialect).alwaysLoaded;
    cleanupTmpDir(tmp);
    expect(disk).toEqual(map);
    const part = disk?.skillListing;
    expect(
      part?.kind === "counted" ? part.files.map((f) => f.path) : [],
    ).toEqual(listed);
  });

  it("names a SKILL.md directly in the folder after the folder", () => {
    const f = weigh({
      ".agents/skills/SKILL.md": "---\ndescription: d\n---\n",
    });
    const line = "- skills: d (file: .agents/skills/SKILL.md)";
    expect(f.skillListing).toEqual({
      kind: "counted",
      total: Buffer.byteLength(line, "utf8"),
      files: [
        {
          path: ".agents/skills/SKILL.md",
          size: Buffer.byteLength(line, "utf8"),
        },
      ],
    });
  });
});

describe("Codex skill folders linked in", () => {
  it("the audit's skill count and the listing agree on symlinked skill folders", () => {
    // The Claude Code twin's fixture, in Codex's layout: one walk classifier
    // for both readers, and `exclude` as the one stated reason they differ.
    const tmp = makeTmpDir("always-loaded-codex-link-count");
    const skill = (dir: string, name: string): void => {
      mkdirSync(join(tmp, dir), { recursive: true });
      writeFileSync(
        join(tmp, dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: The ${name} skill\n---\n`,
      );
    };
    skill(".agents/skills/own", "own");
    skill("shared/linked", "linked");
    skill("shared/vendored", "vendored");
    symlinkSync(join(tmp, "shared/linked"), join(tmp, ".agents/skills/linked"));
    symlinkSync(
      join(tmp, "shared/vendored"),
      join(tmp, ".agents/skills/vendored"),
    );
    // A link back over the skills folder is a cycle: neither walk enters it.
    symlinkSync(
      join(tmp, ".agents/skills"),
      join(tmp, ".agents/skills/own/back"),
    );
    writeFileSync(join(tmp, "AGENTS.md"), "# Rules\n");
    const excludes = excludeSet(tmp, [".agents/skills/vendored"]);

    const audited = scanPlugin(tmp, codexLayout, codexDialect, {
      excludes,
    }).skills.map((s) => s.name);
    const listing = measureAlwaysLoaded(tmp, codexAdapter).alwaysLoaded
      ?.skillListing;
    const listed =
      listing?.kind === "counted" ? listing.files.map((f) => f.path) : [];
    const withoutExclude = scanPlugin(
      tmp,
      codexLayout,
      codexDialect,
    ).skills.map((s) => s.name);
    cleanupTmpDir(tmp);

    expect(listed).toEqual([
      ".agents/skills/linked/SKILL.md",
      ".agents/skills/own/SKILL.md",
      ".agents/skills/vendored/SKILL.md",
    ]);
    expect(audited.sort()).toEqual(["linked", "own"]);
    expect(withoutExclude.sort()).toEqual(["linked", "own", "vendored"]);
  });
});
