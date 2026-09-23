/**
 * Tests for file-qualified symbol reference verification: inline-span extraction
 * (fenced blocks skipped), the `vigiles:symbol path#symbol` mark, verifying the
 * named file defines the symbol, and the unmarked-code enforcement.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inlineSpans,
  symbolRefs,
  verifySymbolRefs,
  unmarkedCodeRefs,
  collectRefIssues,
  refsHookAction,
} from "./refs.js";

test("inlineSpans skips fenced code blocks (R1)", () => {
  const spans = inlineSpans("Use `a` here.\n```ts\n`inside`\n```\nAnd `b`.\n");
  assert.deepEqual(
    spans.map((s) => s.text),
    ["a", "b"],
  );
  assert.equal(spans[0].line, 1);
  assert.equal(spans[1].line, 5);
});

test("symbolRefs matches the vigiles:symbol mark, ignores everything else", () => {
  const refs = symbolRefs(
    "See `vigiles:symbol src/config.ts#parseConfig` and `vigiles:symbol app/user.rb::full_name`.\n" +
      "Prose `parseConfig`, bare `src/config.ts#parseConfig`, file `src/x.ts`.\n",
  );
  assert.deepEqual(
    refs.map((r) => `${r.file}#${r.symbol}`),
    ["src/config.ts#parseConfig", "app/user.rb#full_name"],
  );
});

test("verifies the named file defines the marked symbol (error otherwise)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-symref-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "config.ts"),
      "export function parseConfig(x){return x}\n",
    );
    assert.equal(
      (
        await verifySymbolRefs(
          "Use `vigiles:symbol src/config.ts#parseConfig`.\n",
          dir,
        )
      ).length,
      0,
    );
    const missing = await verifySymbolRefs(
      "Use `vigiles:symbol src/config.ts#loadConfig`.\n",
      dir,
    );
    assert.equal(missing.length, 1);
    assert.match(missing[0].reason, /"loadConfig" is not defined/);
    const noFile = await verifySymbolRefs(
      "Use `vigiles:symbol src/gone.ts#parseConfig`.\n",
      dir,
    );
    assert.equal(noFile.length, 1);
    assert.match(noFile[0].reason, /File not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename surfaces live (re-parses the named file each time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-symref-rename-"));
  try {
    mkdirSync(join(dir, "src"));
    const src = join(dir, "src", "config.ts");
    const md = "Call `vigiles:symbol src/config.ts#parseConfig`.\n";
    writeFileSync(src, "export function parseConfig(){}\n");
    assert.equal((await verifySymbolRefs(md, dir)).length, 0);
    writeFileSync(src, "export function loadConfig(){}\n");
    assert.equal((await verifySymbolRefs(md, dir)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-language: resolves a Ruby vigiles:symbol mark", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-symref-rb-"));
  try {
    mkdirSync(join(dir, "app"));
    writeFileSync(
      join(dir, "app", "user.rb"),
      "class User\n  def full_name\n  end\nend\n",
    );
    assert.equal(
      (
        await verifySymbolRefs(
          "See `vigiles:symbol app/user.rb#full_name`.\n",
          dir,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await verifySymbolRefs(
          "See `vigiles:symbol app/user.rb#display_name`.\n",
          dir,
        )
      ).length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unmarkedCodeRefs flags linter-rule names, NOT identifiers/paths/prose", () => {
  const md =
    "Enforce `eslint/no-console` and `@typescript-eslint/no-explicit-any`.\n" + // rule-shaped → flagged
    "API `runHook`, `MAX_RETRIES`, `chargeCard(token, amount)`, prose `name`.\n" + // bare identifiers → NOT
    "Paths `src/config.ts`, `docs/guide.md`.\n" + // paths (have extensions) → NOT
    "Ignored `ruff/E501`. <!-- vigiles:ignore -->\n"; // rule-shaped but opted out
  const flagged = unmarkedCodeRefs(md)
    .map((s) => s.text)
    .sort();
  assert.deepEqual(flagged, [
    "@typescript-eslint/no-explicit-any",
    "eslint/no-console",
  ]);
});

test("vigiles:ignore-file opts the whole file out", () => {
  const md =
    "<!-- vigiles:ignore-file -->\nEnforce `eslint/no-console` freely.\n";
  assert.equal(unmarkedCodeRefs(md).length, 0);
});

test("collectRefIssues lists unmarked rule refs with enforce() guidance", async () => {
  const issues = await collectRefIssues(
    "Enforce `eslint/no-console` here.\n",
    ".",
  );
  assert.equal(issues.length, 1);
  assert.match(
    issues[0] ?? "",
    /`eslint\/no-console` is an unmarked linter-rule/,
  );
  assert.match(issues[0] ?? "", /enforce\("eslint\/no-console"\)/);
});

test("collectRefIssues is empty for identifiers, paths, prose, and ignored spans", async () => {
  assert.deepEqual(
    await collectRefIssues("Call `runHook` before commit.\n", "."),
    [],
  );
  assert.deepEqual(
    await collectRefIssues("See `src/config.ts` and `docs/x.md`.\n", "."),
    [],
  );
  assert.deepEqual(
    await collectRefIssues(
      "Use `eslint/no-console`. <!-- vigiles:ignore -->\n",
      ".",
    ),
    [],
  );
});

test("refsHookAction maps issue-count + severity to ok/nudge/block", () => {
  assert.equal(refsHookAction(0, "warn"), "ok"); // nothing to say
  assert.equal(refsHookAction(0, "error"), "ok");
  assert.equal(refsHookAction(3, false), "ok"); // rule off
  assert.equal(refsHookAction(3, "warn"), "nudge"); // default
  assert.equal(refsHookAction(1, "error"), "block"); // opt-in
});
