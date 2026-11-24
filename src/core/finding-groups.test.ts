/**
 * `groupFindings` is the one place every report decides what "the same
 * finding" is: the same problem and the same edit share one group,
 * first-seen order holds, and a name is never listed twice in one group.
 */
import { describe, expect, it } from "vitest";
import { groupFindings, groupLine, namesLine } from "./finding-groups.js";

const f = (name: string, problem: string, edit = "e") => ({
  name,
  problem,
  edit,
});

describe("groupFindings", () => {
  it("groups by problem and edit, keeping first-seen order", () => {
    const groups = groupFindings([
      f("a", "x"),
      f("b", "y"),
      f("c", "x"),
      f("a", "x"),
      f("d", "x", "other edit"),
    ]);
    expect(groups.map((g) => [g.problem, g.edit, g.names])).toEqual([
      ["x", "e", ["a", "c"]],
      ["y", "e", ["b"]],
      ["x", "other edit", ["d"]],
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
    expect(namesLine(names.slice(0, 2), " · ")).toBe("a · b");
  });

  it("puts the names first, then the problem and the edit", () => {
    expect(groupLine({ problem: "p", edit: "e", names: ["a"] })).toBe(
      "a: p → e",
    );
  });
});
