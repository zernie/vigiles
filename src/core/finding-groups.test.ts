/**
 * `groupFindings` is the one place every renderer decides what "the same
 * finding" is: identical messages share a line, first-seen order holds, and a
 * name is never listed twice in one group.
 */
import { describe, expect, it } from "vitest";
import { groupFindings, groupLine, namesLine } from "./finding-groups.js";

describe("groupFindings", () => {
  it("groups by exact message, keeping first-seen order", () => {
    const groups = groupFindings([
      { name: "a", message: "x" },
      { name: "b", message: "y" },
      { name: "c", message: "x" },
      { name: "a", message: "x" },
    ]);
    expect(groups).toEqual([
      { message: "x", names: ["a", "c"] },
      { message: "y", names: ["b"] },
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("namesLine and groupLine", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];

  it("spells out the first few, then counts the rest", () => {
    expect(namesLine(names)).toBe("a, b, c, d, e +2 more");
    expect(namesLine(names.slice(0, 2))).toBe("a, b");
  });

  it("puts the names before the message", () => {
    expect(groupLine({ message: "m", names })).toBe("a, b, c, d, e +2 more: m");
    expect(groupLine({ message: "m", names: ["a"] })).toBe("a: m");
  });
});
