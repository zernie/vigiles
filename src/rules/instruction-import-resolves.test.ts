/**
 * `instruction-import-resolves` — its policy, and how each unresolved import
 * reads: located in the file that WRITES the import, at the token's line.
 */
import { describe, it, expect } from "vitest";

import type { UnresolvedImport } from "../core/instruction-imports.js";
import { RULE_GROUPS } from "./groups.js";
import { instructionImportResolves } from "./instruction-import-resolves.js";

const ISSUE: UnresolvedImport = {
  path: "sub/notes.md",
  token: "@notes.md",
  from: "sub/RULES.md",
  line: 4,
  fromScope: "repo",
  resolution: { kind: "missing" },
  seenIn: "both",
};

const findingsOf = (issues: readonly UnresolvedImport[]) =>
  instructionImportResolves.findings({
    skills: [],
    instructionImportIssues: issues,
  });

describe("instruction-import-resolves", () => {
  it("is a graded, decidable rule on at warn, scored from the issues it fires at", () => {
    expect(instructionImportResolves.id).toBe("instruction-import-resolves");
    expect(instructionImportResolves.bucket).toBe("external-decidable");
    expect(instructionImportResolves.defaultSeverity).toBe("warn");
    expect(RULE_GROUPS[instructionImportResolves.group].graded).toBe(true);
    // Narrowed per importing file: an override that turns it off for a path
    // takes that path's imports out of what the grade counts.
    expect(
      instructionImportResolves.scored
        .narrow(
          {
            skills: [],
            instructionImportIssues: [ISSUE, { ...ISSUE, from: "kept.md" }],
          },
          (path) => path === "kept.md",
        )
        .instructionImportIssues?.map((i) => i.from),
    ).toEqual(["kept.md"]);
  });

  it("a finding sits at the importing file and the token's line, named by the token", () => {
    expect(findingsOf([ISSUE])).toEqual([
      expect.objectContaining({
        kind: "finding",
        path: "sub/RULES.md",
        line: 4,
        subject: "@notes.md",
      }),
    ]);
  });

  it("a case mismatch names the file's real spelling", () => {
    const [f] = findingsOf([
      {
        ...ISSUE,
        resolution: { kind: "case-mismatch", actual: "sub/Notes.md" },
      },
    ]);
    expect(f?.message).toContain("sub/Notes.md");
  });

  it("no unresolved import, no finding", () => {
    expect(findingsOf([])).toEqual([]);
  });
});

describe("instruction-import-resolves — scope and kinds", () => {
  it("prints this copy's view and scores the committed one", () => {
    // An import in one machine's file is printed, never scored; one in a
    // committed file this copy does not load (a `CLAUDE.local.md` supersedes
    // it) is scored, not printed — `ImportView` in core says why.
    const local: UnresolvedImport = {
      ...ISSUE,
      from: "CLAUDE.local.md",
      fromScope: "local",
      seenIn: "effective",
    };
    const hidden: UnresolvedImport = {
      ...ISSUE,
      from: "AGENTS.md",
      seenIn: "committed",
    };
    const scan = {
      skills: [],
      instructionImportIssues: [ISSUE, local, hidden],
    };
    expect(
      instructionImportResolves.scored
        .narrow(scan, () => true)
        .instructionImportIssues?.map((i) => i.from),
    ).toEqual(["sub/RULES.md", "AGENTS.md"]);
    expect(findingsOf([ISSUE, local, hidden]).map((f) => f.path)).toEqual([
      "sub/RULES.md",
      "CLAUDE.local.md",
    ]);
  });

  it("an import naming something that is not a file says what it is", () => {
    const [dir] = findingsOf([
      { ...ISSUE, resolution: { kind: "not-a-file", is: "dir" } },
    ]);
    expect(dir?.message).toContain("directory");
    const [other] = findingsOf([
      { ...ISSUE, resolution: { kind: "not-a-file", is: "other" } },
    ]);
    expect(other?.message).not.toContain("directory");
    expect(other?.message).not.toContain("does not exist");
  });
});
