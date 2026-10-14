/**
 * `skill-resource-resolves` as a rule module: its declaration, and how its
 * findings read. The detector (`skillResourceIssues`) has its own tests beside
 * it in core; here the input is the detector's output, as the scan carries it.
 */
import { describe, expect, it } from "vitest";

import { RULE_GROUPS } from "./groups.js";
import { skillResourceResolves } from "./skill-resource-resolves.js";

const SKILL = { name: "rca", path: "skills/rca/SKILL.md" };

describe("skill-resource-resolves", () => {
  it("is the experimental group's, off by default — never graded", () => {
    expect(skillResourceResolves.id).toBe("skill-resource-resolves");
    expect(skillResourceResolves.group).toBe("experimental");
    expect(skillResourceResolves.defaultSeverity).toBe("off");
    expect(RULE_GROUPS[skillResourceResolves.group].graded).toBe(false);
  });

  it("a ref that resolves nowhere is a finding; one that resolves only from the repo root is a note (#382)", () => {
    const found = skillResourceResolves.findings({
      skills: [
        {
          ...SKILL,
          resourceIssues: [
            {
              ref: "scripts/gone.py",
              resolved: "scripts/gone.py",
              kind: "path",
              line: 7,
              resolution: "missing",
            },
            {
              ref: "scripts/leak.py",
              resolved: "scripts/leak.py",
              kind: "path",
              line: 5,
              resolution: "repo-root-only",
            },
          ],
        },
      ],
    });
    expect(found.map((f) => [f.kind, f.subject, f.path, f.line])).toEqual([
      ["finding", "rca", SKILL.path, 7],
      ["note", "rca", SKILL.path, 5],
    ]);
    expect(found[0]?.message).toBe(
      'bundled resource "scripts/gone.py" (line 7) is referenced but missing — the agent reads the instruction and gets nothing.',
    );
    expect(found[1]?.message).toMatch(
      /^bundled resource "scripts\/leak\.py" \(line 5\) resolves only from the repo root/,
    );
  });

  it("a skill with no unresolved ref finds nothing", () => {
    expect(
      skillResourceResolves.findings({
        skills: [{ ...SKILL, resourceIssues: [] }],
      }),
    ).toEqual([]);
  });
});
