/**
 * Every finding that says "too much always-loaded text" names where the text
 * can go. An error that only says "cut content" leaves one move — delete — and
 * the reader deletes rules that still matter instead of moving them to a
 * carrier that loads them only when they apply.
 */
import { describe, it, expect } from "vitest";

import {
  formatCeiling,
  formatRefusal,
  formatVerdict,
  type CeilingVerdict,
} from "./instruction-baseline.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MOVE_OUT_OF_ALWAYS_LOADED,
  adoptInstructionFileRemedy,
  excludeFolderRemedy,
  keepHandWrittenRemedy,
  handWrittenInstructionRemedy,
} from "./instruction-remedies.js";
import { configFor } from "./config-schema.js";
import { RULES, RULE_GROUPS } from "../rules/index.js";

/** The config built over the shipped rule set, as the CLI builds it. */
const CONFIG = configFor(RULES, RULE_GROUPS);

const over: CeilingVerdict = {
  total: 38_000,
  max: 20_000,
  unit: "chars",
  largest: [
    { path: "CLAUDE.md", size: 30_000 },
    { path: "a.md", size: 8_000 },
  ],
};

describe("the remedy list", () => {
  it("names each carrier an always-loaded rule can move to", () => {
    expect(MOVE_OUT_OF_ALWAYS_LOADED.split("\n")).toEqual([
      "Move what does not apply to every request:",
      "  - a rule for one folder → that folder's nested CLAUDE.md or AGENTS.md (loads only there)",
      "  - a step tied to one action → a hook",
      "  - a procedure for one kind of task → a skill",
      "  - a fact a machine can check → a lint rule or a test, then delete the prose",
      "  - history → git: link the commit, do not copy its text",
      "  - a measurement → next to the check that measures it",
      "  - text another file already says → delete it",
    ]);
  });
});

describe("every over-weight finding carries it", () => {
  it("the ceiling finding", () => {
    expect(formatCeiling(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("the refusal to record a baseline above the ceiling", () => {
    expect(formatRefusal(over, ".")).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });

  it("growth over the recorded baseline", () => {
    const msg = formatVerdict(
      { kind: "grew", from: 10, to: 20, unit: "chars", changes: [] },
      ".",
    );
    expect(msg).toContain(MOVE_OUT_OF_ALWAYS_LOADED);
  });
});

describe("the remedy for a hand-written instruction file", () => {
  const remedy = adoptInstructionFileRemedy("docs/CLAUDE.md");

  it("names the deterministic adopter with the file's own path", () => {
    expect(remedy).toContain("`npx vigiles init --target=docs/CLAUDE.md`");
  });

  it("names the agentic adopter, a skill vigiles really ships", () => {
    expect(remedy).toContain("`adopt-spec`");
    // __dirname is src/core → the repo root is two levels up.
    const skill = resolve(
      __dirname,
      "..",
      "..",
      "skills",
      "adopt-spec",
      "SKILL.md",
    );
    expect(existsSync(skill)).toBe(true);
    // User-invoked: the remedy must say to invoke it, since it never fires itself.
    expect(readFileSync(skill, "utf-8")).toMatch(
      /disable-model-invocation: true/,
    );
  });
});

// The first finding a new adopter sees on a repo with hand-written instruction
// files. It has to say what to do, in the order to try it.
describe("what a require-instructions-spec finding says to do", () => {
  const msg = handWrittenInstructionRemedy("vendor/kit/CLAUDE.md");

  it("adopt first, then exclude what is not yours, then turn the rule off", () => {
    const adopt = msg.indexOf(
      adoptInstructionFileRemedy("vendor/kit/CLAUDE.md"),
    );
    const exclude = msg.indexOf(excludeFolderRemedy("vendor/kit/CLAUDE.md"));
    const off = msg.indexOf(keepHandWrittenRemedy("vendor/kit/CLAUDE.md"));
    expect(adopt).toBeGreaterThanOrEqual(0);
    expect(exclude).toBeGreaterThan(adopt);
    expect(off).toBeGreaterThan(exclude);
  });

  it("the exclude snippet names the file's folder as a top-level exclude glob", () => {
    expect(excludeFolderRemedy("vendor/kit/CLAUDE.md")).toContain(
      '{ "exclude": ["vendor/kit/**"] }',
    );
  });

  it("the third way out turns the rule off for the folder, whole-repo off last", () => {
    const keep = keepHandWrittenRemedy("notes/CLAUDE.md");
    const folder =
      '{ "overrides": [{ "files": ["notes/**"], "rules": { "require-instructions-spec": "off" } }] }';
    const repo = '{ "rules": { "require-instructions-spec": "off" } }';
    expect(keep).toContain(folder);
    expect(keep.indexOf(repo)).toBeGreaterThan(keep.indexOf(folder));
  });

  it("every snippet it prints is a config the schema accepts", () => {
    const snippets = [
      ...handWrittenInstructionRemedy("notes/CLAUDE.md").matchAll(
        /\{ "[^\n]*\}/g,
      ),
    ].map((m): unknown => JSON.parse(m[0]));
    expect(snippets).toHaveLength(3);
    snippets.forEach((snippet) => {
      expect(CONFIG.parse(snippet).success).toBe(true);
    });
  });
});
