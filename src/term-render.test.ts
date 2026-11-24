/**
 * The terminal layout's contract: when colour is on (the two conventions other
 * CLIs honour, in their order), that colour never changes the text, and a
 * finding group is three lines — problem after its mark, edit, units — so a
 * reader sees the edit apart from the problem it fixes.
 */
import { describe, it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  colourEnabled,
  fileBlocks,
  groupBlock,
  plain,
  terminalPaint,
} from "./term-render.js";
import { NAMES_SHOWN, type FindingGroup } from "./core/finding-groups.js";

describe("colourEnabled", () => {
  it.each([
    // [isTTY, env, expected]
    [true, {}, true],
    [false, {}, false],
    [true, { TERM: "dumb" }, false],
    [true, { NO_COLOR: "1" }, false],
    [true, { NO_COLOR: "" }, true],
    [false, { FORCE_COLOR: "1" }, true],
    [true, { FORCE_COLOR: "0" }, false],
    [false, { NO_COLOR: "1", FORCE_COLOR: "1" }, false],
  ] as const)("isTTY=%s env=%j → %s", (isTTY, env, expected) => {
    expect(colourEnabled(isTTY, env)).toBe(expected);
  });
});

describe("terminalPaint", () => {
  it("with colour off, returns the text untouched", () => {
    expect(terminalPaint(false, {})("bad", "x")).toBe("x");
  });

  it("with colour on, adds escapes and nothing else", () => {
    const painted = terminalPaint(false, { FORCE_COLOR: "1" })("bad", "x");
    expect(painted).not.toBe("x");
    expect(stripVTControlCharacters(painted)).toBe("x");
  });
});

describe("groupBlock", () => {
  const group = (names: readonly string[]): FindingGroup => ({
    problem: "P",
    edit: "E",
    names,
  });

  it("lays a group out as problem, edit, units — each under the indent", () => {
    const lines = groupBlock(group(["a", "b"]), {
      indent: "  ",
      mark: "⚠",
      tone: "warn",
      paint: plain,
    });
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith("  "))).toBe(true);
    expect(lines[0]).toMatch(/^ {2}⚠ P$/);
    expect(lines[1]).toContain("E");
    expect(lines[1]).not.toContain("P");
    expect(lines[2]?.trim().split(" · ")).toEqual(["a", "b"]);
  });

  it("caps the units it spells out, and counts the rest", () => {
    const names = Array.from({ length: NAMES_SHOWN + 3 }, (_, i) => `u${i}`);
    const [, , units] = groupBlock(group(names), {
      indent: "",
      mark: "✗",
      tone: "bad",
      paint: plain,
    });
    for (const n of names.slice(0, NAMES_SHOWN)) expect(units).toContain(n);
    expect(units).not.toContain(`u${NAMES_SHOWN}`);
    expect(units).toContain("3");
  });

  it("colour changes no character of the layout", () => {
    const o = { indent: "  ", mark: "⚠", tone: "warn" } as const;
    const g = group(["a"]);
    expect(
      groupBlock(g, {
        ...o,
        paint: terminalPaint(false, { FORCE_COLOR: "1" }),
      }).map(stripVTControlCharacters),
    ).toEqual(groupBlock(g, { ...o, paint: plain }));
  });
});

describe("fileBlocks", () => {
  const f = (path: string, problem: string) =>
    ({
      path,
      mark: "⚠",
      tone: "warn",
      problem,
      edit: `fix ${problem}`,
    }) as const;

  it("prints every finding under its file, one block per file, in first-seen order", () => {
    const lines = fileBlocks(
      [f("a.md", "p1"), f("b.md", "p2"), f("a.md", "p3")],
      "",
      plain,
    );
    const headers = lines.filter((l) => l !== "" && !l.startsWith(" "));
    expect(headers).toEqual(["a.md", "b.md"]);
    // Same problem in two files is still two findings: nothing merges.
    for (const p of ["p1", "p2", "p3"]) {
      expect(
        lines.filter((l) => l.includes(p) && !l.includes("fix")),
      ).toHaveLength(1);
      expect(lines.filter((l) => l.includes(`fix ${p}`))).toHaveLength(1);
    }
    expect(lines.indexOf("b.md")).toBeGreaterThan(
      lines.findIndex((l) => l.includes("fix p3")),
    );
  });

  it("does not merge the same finding across files", () => {
    const lines = fileBlocks([f("a.md", "p"), f("b.md", "p")], "", plain);
    expect(lines.filter((l) => l.includes("fix p"))).toHaveLength(2);
  });
});
