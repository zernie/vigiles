/**
 * A style the user switched on for every project (`~/.claude/settings.json`)
 * loads in every run, so an eval arm "without the style" is not without it
 * unless the project switches styles off. Measured against the REAL `claude`
 * binary and the scripted mock, with a throwaway HOME. Skipped where the CLI is
 * absent.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { claudeAvailable } from "../../harness-test.js";
import type { ModelRequest } from "../../core/harness-driver.js";
import { scriptModel, startMock } from "../../mock-model.js";
import { claudeCodeOutputStyles as rules } from "./output-style.js";

const maybe = claudeAvailable() ? test : test.skip;
const STYLE_TEXT = "---\nname: Everywhere\n---\nUSER-WIDE-STYLE-7f3a\n";
const style = rules.read(".claude/output-styles/everywhere.md", STYLE_TEXT);

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A HOME whose user settings switch `Everywhere` on for every project. */
function homeWithUserStyle(): string {
  const home = scratch("vigiles-user-style-home-");
  mkdirSync(join(home, ".claude", rules.dir), { recursive: true });
  writeFileSync(join(home, ".claude", rules.dir, "everywhere.md"), STYLE_TEXT);
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(rules.select("Everywhere")),
  );
  return home;
}

let requests: ModelRequest[] = [];
let mock: Awaited<ReturnType<typeof startMock>> | undefined;
beforeAll(async () => {
  mock = await startMock(scriptModel([{ text: "ok" }]), {
    onRequest: (req) => requests.push(req),
  });
});
afterAll(() => mock?.close());

/** One `claude -p` run in a work dir with these project settings; its requests. */
async function run(
  projectSettings: Readonly<Record<string, unknown>> | null,
): Promise<readonly ModelRequest[]> {
  requests = [];
  const work = scratch("vigiles-user-style-work-");
  if (projectSettings !== null) {
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(
      join(work, ".claude", "settings.json"),
      JSON.stringify(projectSettings),
    );
  }
  const code = await new Promise<number | null>((done) => {
    const child = spawn("claude", ["-p", "hi"], {
      cwd: work,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: homeWithUserStyle(),
        ANTHROPIC_BASE_URL: mock?.url ?? "",
        ANTHROPIC_API_KEY: "sk-test",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    });
    child.on("close", done);
  });
  expect(code).toBe(0);
  return requests;
}

describe("a style the user set for every project (real binary)", () => {
  // Guards: the probe can see a user-wide style at all, so the next test's
  // "absent" is a finding, not a blind instrument.
  maybe(
    "reaches the model when the project says nothing",
    async () => {
      const seen = await run(null);
      expect(seen.some((r) => rules.reached(style, r))).toBe(true);
    },
    120_000,
  );

  maybe(
    "does not reach the model when the project selects no style",
    async () => {
      const seen = await run(rules.selectNone);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((r) => rules.reached(style, r))).toBe(false);
    },
    120_000,
  );
});
