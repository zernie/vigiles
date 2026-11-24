/**
 * Codex has no import mechanism: its project doc is read as written, and an
 * `@path` line in `AGENTS.md` is text, not a pointer. So the Codex chain names
 * no import, and an instruction-import finding cannot appear for one — in
 * either engine, or through the built CLI. The rule reads the ADAPTER's
 * imports; a rule that scanned the token itself would report this line. The
 * Claude Code twin is `src/adapters/claude-code/instruction-imports.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { scanFiles } from "../../scan-files.js";
import { scanPlugin } from "../../scan.js";
import { codexDialect } from "./dialect.js";
import { codexLayout } from "./layout.js";

const CLI = resolve(import.meta.dirname, "..", "..", "..", "dist", "cli.js");
const FILES = { "AGENTS.md": "# Project\n\n@docs/missing.md\n" } as const;

let dir = "";
afterEach(() => {
  cleanupTmpDir(dir);
});

function repo(): string {
  dir = makeTmpDir("codex-imports");
  for (const [rel, body] of Object.entries(FILES))
    writeFileSync(join(dir, rel), body);
  writeFileSync(
    join(dir, ".vigilesrc.json"),
    JSON.stringify({ harnesses: { codex: {} } }),
  );
  return dir;
}

describe("an @path line in a Codex AGENTS.md", () => {
  it("is not an import, so neither engine reports it", () => {
    const abs = repo();
    expect(
      scanPlugin(abs, codexLayout, codexDialect).instructionImportIssues,
    ).toEqual([]);
    expect(
      scanFiles(FILES, codexLayout, codexDialect).instructionImportIssues,
    ).toEqual([]);
  });

  it("…and the built CLI's lint and audit say nothing about it", () => {
    const abs = repo();
    const lint = spawnSync("node", [CLI, "lint"], {
      cwd: abs,
      encoding: "utf8",
    });
    expect(lint.stdout).not.toMatch(/AGENTS\.md:3/);
    const audit = spawnSync("node", [CLI, "audit", "--json"], {
      cwd: abs,
      encoding: "utf8",
    });
    expect(JSON.parse(audit.stdout)).not.toHaveProperty("findings");
  });
});
