/**
 * Fixed-context suite (vitest, unit tier, nothing spawned).
 *
 * Harness-agnostic: a fake layout and dialect, so what is proven here is the
 * SUM and the distinctions between the part states. Each adapter's own suite
 * (`src/adapters/<h>/fixed-context.test.ts`) proves its renderer and selection
 * against real file shapes.
 *
 * The load-bearing case is the evasion one, as for the instruction weight:
 * text moved from the instruction file into the selected style must leave the
 * total where it was.
 */
import { describe, expect, it } from "vitest";

import { jsonSettingsCodec } from "./settings-codec.js";
import type { OutputStyleRules } from "./output-style.js";
import type { SkillListingRules } from "./skill-listing.js";
import {
  partTotal,
  sessionSkills,
  weighFixedContext,
  type FixedContextInput,
} from "./fixed-context.js";

const weight = (committedTotal: number) =>
  ({ unit: "chars", committedTotal }) as const;

const styles: OutputStyleRules = {
  dir: "styles",
  isStyleFile: (p) => p.endsWith(".md"),
  read: (path, text) => ({
    path,
    name: path.split("/").at(-1)?.replace(/\.md$/, "") ?? null,
    body: text,
  }),
  select: (name) => ({ style: name }),
  selectNone: { style: "default" },
  reached: () => false,
  selected: (s) => {
    const name = s["style"];
    if (typeof name !== "string") return { kind: "unset" };
    return name === "default" ? { kind: "default" } : { kind: "named", name };
  },
};

const descriptionOf = (
  fm: Readonly<Record<string, unknown>> | null,
): string => {
  const d = fm?.["description"];
  return typeof d === "string" ? d : "";
};

const listing: SkillListingRules = {
  entry: (skill) =>
    skill.frontmatter?.["hidden"] === true
      ? null
      : `- ${skill.dirName}: ${descriptionOf(skill.frontmatter)}`,
  capturedFrom: "test",
};

const input = (
  files: Record<string, string>,
  over: Partial<FixedContextInput> = {},
): FixedContextInput => ({
  weight: weight(100),
  files,
  layout: {
    outputStyles: styles,
    userSurfaceRoot: ".h",
    surfaces: { skill: "skills" },
    settings: jsonSettingsCodec,
    settingsPath: ".h/settings.json",
  },
  dialect: { skillListing: listing },
  ...over,
});

describe("weighFixedContext", () => {
  it("sums the instructions, the selected style and the listing", () => {
    const f = weighFixedContext(
      input({
        ".h/settings.json": JSON.stringify({ style: "terse" }),
        ".h/styles/terse.md": "x".repeat(40),
        ".h/styles/other.md": "y".repeat(900),
        ".h/skills/a/SKILL.md": "---\ndescription: abc\n---\nbody",
        ".h/skills/b/SKILL.md": "---\nhidden: true\n---\nbody",
      }),
    );
    expect(f.outputStyle).toEqual({
      kind: "counted",
      total: 40,
      files: [{ path: ".h/styles/terse.md", size: 40 }],
    });
    // "- a: abc" = 8; the hidden skill is not listed at all.
    expect(f.skillListing).toEqual({
      kind: "counted",
      total: 8,
      files: [{ path: ".h/skills/a/SKILL.md", size: 8 }],
    });
    expect(f.total).toBe(148);
  });

  it("nets out text moved from the instructions into the selected style", () => {
    const files = (styleChars: number): Record<string, string> => ({
      ".h/settings.json": JSON.stringify({ style: "terse" }),
      ".h/styles/terse.md": "x".repeat(styleChars),
    });
    const before = weighFixedContext(input(files(10), { weight: weight(500) }));
    const after = weighFixedContext(input(files(310), { weight: weight(200) }));
    expect(after.total).toBe(before.total);
  });
});

describe("weighFixedContext — each absence is its own state", () => {
  it("keeps none, unresolved, not-supported and not-modelled apart", () => {
    expect(weighFixedContext(input({})).outputStyle).toEqual({ kind: "none" });
    const defaulted = { ".h/settings.json": '{"style":"default"}' };
    expect(weighFixedContext(input(defaulted)).outputStyle.kind).toBe("none");
    const typo = { ".h/settings.json": '{"style":"Terse"}' };
    expect(weighFixedContext(input(typo)).outputStyle).toEqual({
      kind: "unresolved",
      name: "Terse",
    });
    const base = input({});
    const noStyles = weighFixedContext({
      ...base,
      layout: { ...base.layout, outputStyles: undefined },
    });
    expect(noStyles.outputStyle).toEqual({ kind: "not-supported" });
    const noSelected = weighFixedContext({
      ...base,
      layout: {
        ...base.layout,
        outputStyles: { ...styles, selected: undefined },
      },
    });
    expect(noSelected.outputStyle).toEqual({ kind: "not-modelled" });
    expect(weighFixedContext(input({}, { dialect: {} })).skillListing).toEqual({
      kind: "not-modelled",
    });
    expect(weighFixedContext(input({})).skillListing).toEqual({ kind: "none" });
  });
});

describe("weighFixedContext — what is not counted", () => {
  it("adds nothing for a part that is not counted", () => {
    const f = weighFixedContext(input({}));
    expect(f.total).toBe(100);
    expect(partTotal({ kind: "unresolved", name: "x" })).toBe(0);
  });

  it("reads a style only from the session's own folder, not a plugin root", () => {
    const f = weighFixedContext(
      input({
        ".h/settings.json": JSON.stringify({ style: "terse" }),
        "styles/terse.md": "x".repeat(40),
      }),
    );
    expect(f.outputStyle).toEqual({ kind: "unresolved", name: "terse" });
  });

  it("reads unparseable settings as no settings", () => {
    const f = weighFixedContext(input({ ".h/settings.json": "{not json" }));
    expect(f.outputStyle).toEqual({ kind: "none" });
  });
});

describe("sessionSkills", () => {
  it("reads one level under the skills folder, sorted, malformed YAML as null", () => {
    const skills = sessionSkills(input({}).layout, {
      ".h/skills/b/SKILL.md": "---\nname: [\n---\nx",
      ".h/skills/a/SKILL.md": "no frontmatter",
      ".h/skills/a/deep/SKILL.md": "---\nname: deep\n---\n",
      "skills/c/SKILL.md": "---\nname: plugin\n---\n",
    });
    expect(skills.map((s) => [s.path, s.frontmatter])).toEqual([
      [".h/skills/a/SKILL.md", {}],
      [".h/skills/b/SKILL.md", null],
    ]);
  });

  it("reads nothing when the harness has no skills folder", () => {
    const layout = { ...input({}).layout, surfaces: {} };
    expect(sessionSkills(layout, { ".h/skills/a/SKILL.md": "x" })).toEqual([]);
  });
});
