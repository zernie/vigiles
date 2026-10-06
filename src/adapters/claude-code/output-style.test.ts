import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ModelRequest } from "../../core/harness-driver.js";
import { claudeCodeOutputStyles as rules } from "./output-style.js";

const fixture = (name: string): string =>
  readFileSync(join("test/fixtures/output-styles", name), "utf8");

const frontmatter = (lines: string): string => `---\n${lines}\n---\n\nbody\n`;

const nameOf = (text: string): string | null =>
  rules.read(".claude/output-styles/dk.md", text).name;

describe("which files Claude Code loads as styles", () => {
  it("loads a lower-case .md file, nested folders and dotfiles included", () => {
    expect(rules.isStyleFile("status-footer.md")).toBe(true);
    expect(rules.isStyleFile("team/deep/terse.md")).toBe(true);
    expect(rules.isStyleFile(".hidden.md")).toBe(true);
  });

  it("does not load .MD or a file with no extension (measured on 2.1.291)", () => {
    expect(rules.isStyleFile("upper.MD")).toBe(false);
    expect(rules.isStyleFile("notes")).toBe(false);
  });
});

describe("the name Claude Code selects a style by", () => {
  // Each row was measured on Claude Code 2.1.291: setting `outputStyle` to the
  // name on the right loaded the style, and every other spelling tried did not.
  const MEASURED: readonly (readonly [string, string])[] = [
    ["name: A\nname: B", "B"],
    ["name: Status: Block", "Status: Block"],
    ["name: Trail: ", "Trail: "],
    ["name: A: b\nname: C", "C"],
    ['name: "Quoted: x"', "Quoted: x"],
    ["name: a # c", "a"],
    ["name: 42", "42"],
    ["name: true", "true"],
    ["name: yes", "yes"],
    ["name: 1.0", "1"],
    ["name: 0x10", "16"],
    ["name: 2024-01-01", "2024-01-01"],
    ["name: '  '", "  "],
    ["name: ''", "dk"],
    ["name: null", "dk"],
    ["name: ~", "dk"],
  ];
  it.each(MEASURED)("reads %j as %j", (front, want) => {
    expect(nameOf(frontmatter(front))).toBe(want);
  });

  it("uses the file name when there is no frontmatter", () => {
    expect(nameOf("Just a body.\n")).toBe("dk");
  });

  it("knows no name when the frontmatter cannot be read even after repair", () => {
    expect(nameOf(frontmatter("name: [unclosed"))).toBeNull();
  });

  it("reads our status footer style by its declared name", () => {
    const style = rules.read(
      ".claude/output-styles/status-footer.md",
      fixture("status-footer.md"),
    );
    expect(style.name).toBe("Status Footer");
    expect(style.body).toContain("One block per user message.");
  });
});

describe("selecting a style", () => {
  it("sets outputStyle to the exact name, case included", () => {
    expect(rules.select("Status Footer")).toEqual({
      outputStyle: "Status Footer",
    });
  });
});

describe("telling that the style reached the model", () => {
  const style = rules.read(
    ".claude/output-styles/status-footer.md",
    fixture("status-footer.md"),
  );
  const request = (text: string, system = ""): ModelRequest => ({
    system,
    messages: [{ role: "user", text }],
  });
  // The block Claude Code 2.1.291 sends, as measured: in the first user message.
  const wrapped = `<system-reminder>\n# Output Style: Status Footer\n${style.body}\n</system-reminder>`;

  it("finds the measured wrapper in a user message", () => {
    expect(rules.reached(style, request(wrapped))).toBe(true);
  });

  it("finds the wrapper in the system prompt too", () => {
    expect(rules.reached(style, request("hello", wrapped))).toBe(true);
  });

  it("does not count the body alone: a file that quotes it is not the style", () => {
    expect(rules.reached(style, request(style.body))).toBe(false);
  });

  it("does not count a wrapper with another style's name", () => {
    const other = wrapped.replace("Status Footer", "Show The Code");
    expect(rules.reached(style, request(other))).toBe(false);
  });
});
