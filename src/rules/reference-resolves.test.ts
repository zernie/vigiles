/**
 * `reference-resolves` as a rule module: its declaration, and how its findings
 * read off the graph the scan carries. The graph has its own tests in core.
 */
import { describe, expect, it } from "vitest";

import { brokenImports } from "../core/reference-graph.js";
import { referenceGraph } from "../core/reference-graph.js";
import { repoTreeOf } from "../core/repo-tree.js";
import { RULE_GROUPS } from "./groups.js";
import { referenceResolves } from "./reference-resolves.js";

const references = referenceGraph({
  sources: [{ path: "CLAUDE.md", role: "instruction", text: "`gone.md`" }],
  imports: [
    {
      path: "docs/style.md",
      token: "@docs/style.md",
      from: "CLAUDE.md",
      line: 3,
    },
    { path: "agents.md", token: "@agents.md", from: "CLAUDE.md", line: 4 },
    {
      path: "vendor/m/x.md",
      token: "@vendor/m/x.md",
      from: "CLAUDE.md",
      line: 5,
    },
    { path: "ok.md", token: "@ok.md", from: "CLAUDE.md", line: 6 },
  ],
  files: {},
  tree: repoTreeOf(["CLAUDE.md", "AGENTS.md", "ok.md"], ["vendor/m"]),
});

describe("reference-resolves", () => {
  it("is graded in the structural group, warn by default, scored through brokenImports", () => {
    expect(referenceResolves.group).toBe("structural");
    expect(RULE_GROUPS[referenceResolves.group].graded).toBe(true);
    expect(referenceResolves.defaultSeverity).toBe("warn");
    expect(referenceResolves.scoredBy).toBe(brokenImports.name);
  });

  it("one finding per broken import at its file and line; a submodule import is a note; links and mentions are not its", () => {
    const found = referenceResolves.findings({ skills: [], references });
    expect(found.map((f) => [f.kind, f.path, f.line, f.subject])).toEqual([
      ["finding", "CLAUDE.md", 3, "@docs/style.md"],
      ["finding", "CLAUDE.md", 4, "@agents.md"],
      ["note", "CLAUDE.md", 5, "@vendor/m/x.md"],
    ]);
    expect(found[0]?.message).toBe(
      "missing — the harness loads nothing for this import.",
    );
    expect(found[1]?.reference?.resolution).toEqual({
      status: "case-mismatch",
      actual: "AGENTS.md",
    });
  });
});
