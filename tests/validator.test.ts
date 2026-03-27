import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validate } from "../src/validator/index.js";

describe("CLAUDE.md Validator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lint-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeClaudeMd(content: string) {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), content);
  }

  it("should detect enforced rules", () => {
    writeClaudeMd(`
### Always use barrel file imports
**Enforced by:** \`eslint/force-barrel-imports\`
**Why:** Prevents import path drift during refactoring.
`);
    const result = validate({ projectRoot: tmpDir });
    expect(result.enforced).toBe(1);
    expect(result.guidanceOnly).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("should detect guidance-only rules", () => {
    writeClaudeMd(`
### Use Tailwind spacing scale
**Guidance only** — cannot be mechanically enforced
**Why:** Visual consistency.
`);
    const result = validate({ projectRoot: tmpDir });
    expect(result.enforced).toBe(0);
    expect(result.guidanceOnly).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("should flag rules missing enforcement annotations", () => {
    writeClaudeMd(`
### Always use barrel file imports
**Why:** Prevents import path drift during refactoring.
`);
    const result = validate({ projectRoot: tmpDir });
    expect(result.enforced).toBe(0);
    expect(result.missing).toBe(1);
    expect(result.valid).toBe(false);
  });

  it("should handle mixed rules", () => {
    writeClaudeMd(`
### Always use barrel file imports
**Enforced by:** \`eslint/force-barrel-imports\`
**Why:** Prevents import path drift.

### No console.log in production
**Enforced by:** \`eslint/no-console\`
**Why:** Use logger.error which routes to Datadog.

### Use Tailwind spacing scale, no magic numbers
**Guidance only** — cannot be mechanically enforced
**Why:** Ensures visual consistency.

### Some rule with no annotation
**Why:** Just a rule without enforcement info.
`);
    const result = validate({ projectRoot: tmpDir });
    expect(result.total).toBe(4);
    expect(result.enforced).toBe(2);
    expect(result.guidanceOnly).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.valid).toBe(false);
  });

  it("should throw if CLAUDE.md is missing", () => {
    expect(() => validate({ projectRoot: tmpDir + "/nonexistent" })).toThrow(
      "CLAUDE.md not found",
    );
  });

  it("should report line numbers", () => {
    writeClaudeMd(`
### First rule
**Enforced by:** \`some-rule\`

### Second rule
Missing annotation here
`);
    const result = validate({ projectRoot: tmpDir });
    expect(result.rules[0].line).toBe(2);
    expect(result.rules[0].enforcement).toBe("enforced");
    expect(result.rules[1].line).toBe(5);
    expect(result.rules[1].enforcement).toBe("missing");
  });

  it("should accept a custom path via claudeMdPath", () => {
    const customPath = path.join(tmpDir, "docs", "CLAUDE.md");
    fs.mkdirSync(path.join(tmpDir, "docs"));
    fs.writeFileSync(
      customPath,
      `### A rule\n**Enforced by:** \`some-rule\`\n`,
    );
    const result = validate({ claudeMdPath: customPath });
    expect(result.total).toBe(1);
    expect(result.valid).toBe(true);
  });
});
