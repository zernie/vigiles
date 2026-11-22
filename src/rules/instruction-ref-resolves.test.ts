/**
 * `instruction-ref-resolves` as a rule module: its declaration, and how its
 * findings read off the graph the scan carries.
 */
import { describe, expect, it } from "vitest";

import { referenceGraph } from "../core/reference-graph.js";
import { repoTreeOf } from "../core/repo-tree.js";
import { RULE_GROUPS } from "./groups.js";
import { instructionRefResolves } from "./instruction-ref-resolves.js";

const references = referenceGraph({
  sources: [
    {
      path: "agents/review.md",
      role: "agent",
      text: "---\nname: review\n---\nRead `docs/gone.md` and [it](../README.md).\nSee `lib/a.ts`.",
    },
  ],
  imports: [{ path: "gone.md", token: "@gone.md", from: "CLAUDE.md", line: 1 }],
  files: {},
  tree: repoTreeOf(["README.md", "agents/review.md", "pkg/lib/a.ts"]),
});

describe("instruction-ref-resolves", () => {
  it("is experimental: off by default, never graded", () => {
    expect(instructionRefResolves.group).toBe("experimental");
    expect(RULE_GROUPS[instructionRefResolves.group].graded).toBe(false);
    expect(instructionRefResolves.defaultSeverity).toBe("off");
  });

  it("one finding per broken link or mention at its line of the real file; elsewhere is a note; imports are not its", () => {
    const found = instructionRefResolves.findings({ skills: [], references });
    expect(found.map((f) => [f.kind, f.path, f.line, f.subject])).toEqual([
      ["finding", "agents/review.md", 4, "`docs/gone.md`"],
      ["note", "agents/review.md", 5, "`lib/a.ts`"],
    ]);
    expect(found[0]?.message).toBe(
      "missing — the agent follows the pointer and finds nothing.",
    );
    expect(found[1]?.message).toBe(
      "not found from here; it exists at `pkg/lib/a.ts`.",
    );
  });
});
