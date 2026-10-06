/**
 * `untested-output-style` on Claude Code, through the real built CLI — the rule's severity and
 * on/off switch, as `.vigilesrc.json` carries them into `vigiles lint`.
 *
 * Both halves of the check: it fires on an output style with no test beside it,
 * and is silent once a colocated harness exists. Its severity is ITS OWN, not a
 * sibling's: before this rule existed the per-kind severity lookup fell through
 * to the hook rule for any kind it did not name, so a style would have been
 * gated by `untested-hook` without anyone having asked for that.
 *
 * Deterministic, model-free, offline → the free unit tier.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { makeTmpDir, cleanupTmpDir } from "../../core/test-utils.js";

const CLI = resolve(process.cwd(), "dist", "cli.js");
const STYLE = ".claude/output-styles/status-block.md";

let dir: string;

function write(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function lint(): { code: number; out: string } {
  const r = spawnSync("node", [CLI, "lint"], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 60000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function rules(r: Record<string, unknown>): void {
  write(".vigilesrc.json", JSON.stringify({ rules: r }));
}

beforeEach(() => {
  dir = makeTmpDir("cli-untested-style");
  write("package.json", JSON.stringify({ name: "demo-repo" }));
  write(
    STYLE,
    "---\nname: Status Block\nkeep-coding-instructions: true\n---\n\nClose every reply with one status block.\n",
  );
});

afterEach(() => {
  cleanupTmpDir(dir);
});

test("fires on an output style with no test beside it (default: warn)", () => {
  const { out } = lint();
  assert.match(
    out,
    /output-style \.claude\/output-styles\/status-block\.md — add e\.g\. \.claude\/output-styles\/status-block\.harness\./,
  );
});

test("is silent once a colocated harness covers the style", () => {
  write(".claude/output-styles/status-block.harness.mjs", "// covered\n");
  const { out } = lint();
  assert.doesNotMatch(out, /output-style \.claude/);
});

test('"error" fails the run on an untested style, and the hook rule does not decide it', () => {
  rules({ "untested-output-style": "error", "untested-hook": "warn" });
  const { code, out } = lint();
  // The finding itself, not merely a non-zero exit: an UNKNOWN rule key also
  // exits 2 (a config error), and that would pass this test for no reason.
  assert.match(out, /output-style \.claude\/output-styles\/status-block\.md/);
  assert.equal(code, 2, out);
});

test("its own severity, not the hook rule's: hook at error does not gate a style", () => {
  rules({ "untested-output-style": "warn", "untested-hook": "error" });
  const { code, out } = lint();
  assert.notEqual(code, 2, out);
});

test("false switches the kind off: the style is not scanned at all", () => {
  rules({ "untested-output-style": false });
  assert.doesNotMatch(lint().out, /output-style/);
});

test("the audit inventory counts the style", () => {
  const r = spawnSync("node", [CLI, "audit", "."], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 60000,
  });
  assert.match(`${r.stdout}${r.stderr}`, /Output styles: 1/);
});
