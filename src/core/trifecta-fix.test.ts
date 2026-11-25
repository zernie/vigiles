/**
 * `describeFix` turns the detector's decision into the one line a person
 * reads. The contract, never the wording: every kind renders one line of at
 * most 160 characters, carries that unit's own data (the shell, the tools, the
 * denies), never carries a unit's name (a renderer groups units by line), and
 * no two kinds read the same.
 */
import { describe, expect, it } from "vitest";
import {
  describeFix,
  fixLine,
  type TrifectaFix,
  type TrifectaLegs,
} from "./trifecta-fix.js";

// Realistic worst case: long MCP names on every leg.
const legs: TrifectaLegs = {
  private: ["Read", "Bash", "mcp__github__get_file_contents"],
  untrusted: ["WebFetch", "mcp__github__issue_read"],
  exfil: ["Bash", "mcp__github__create_pull_request", "WebFetch"],
};

/** Every kind, each with the data its line must show. */
const cases: readonly { fix: TrifectaFix; shows: readonly string[] }[] = [
  { fix: { kind: "declare-tools" }, shows: ["tools:"] },
  { fix: { kind: "remove-shell", shell: "Bash" }, shows: ["Bash"] },
  {
    fix: {
      kind: "narrowed-still-counts",
      grants: ["Bash(node ./scripts/x.mjs:*)"],
      shell: "Bash",
    },
    shows: ["Bash(node ./scripts/x.mjs:*)"],
  },
  { fix: { kind: "remove-a-tool" }, shows: ["WebFetch"] },
  { fix: { kind: "fix-yaml", field: "tools" }, shows: ["tools:"] },
  {
    fix: { kind: "fix-yaml", field: "disallowed-tools" },
    shows: ["disallowed-tools:"],
  },
  { fix: { kind: "drop-pre-approval", tools: ["Bash"] }, shows: ["Bash"] },
  {
    fix: {
      kind: "add-fence",
      leg: "untrusted",
      deny: ["WebFetch", "WebSearch", "Bash"],
    },
    shows: ["WebFetch", "WebSearch", "Bash"],
  },
  {
    fix: {
      kind: "extend-fence",
      declared: ["WebFetch", "Bash(curl:*)"],
      ignored: ["Bash(curl:*)"],
      leg: "untrusted",
      deny: ["WebSearch", "Bash"],
    },
    shows: ["Bash(curl:*)", "WebSearch"],
  },
  {
    fix: {
      kind: "extend-fence",
      declared: [],
      ignored: [],
      leg: "private",
      deny: ["Read", "Grep", "Glob", "Bash"],
    },
    shows: ["Grep", "Glob"],
  },
];

describe("describeFix", () => {
  it.each(cases)("$fix.kind is one short line with its own data", (c) => {
    const line = fixLine(describeFix(c.fix, legs));
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).not.toMatch(/\n/);
    for (const s of c.shows) expect(line).toContain(s);
  });

  it("no two fixes read the same", () => {
    const lines = cases.map((c) => fixLine(describeFix(c.fix, legs)));
    expect(new Set(lines).size).toBe(lines.length);
  });
});
