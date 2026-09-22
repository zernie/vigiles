import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeHarnessName,
  normalizeHarnessList,
  resolveHarnessSelection,
  resolveHarnessAdapters,
  adapterForInstructionFile,
  type HarnessSelection,
} from "./adapter-registry.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

/** Narrow a selection to its `notice` variant (asserts the discriminant). */
function noticeOf(sel: HarnessSelection): string {
  assert.equal(sel.kind, "notice");
  // The union makes `notice` reachable only on the "notice" variant.
  return sel.kind === "notice" ? sel.notice : "";
}

test("normalizeHarnessName lowercases, trims, and aliases claude → claude-code", () => {
  assert.equal(normalizeHarnessName("claude"), "claude-code");
  assert.equal(normalizeHarnessName("  Claude "), "claude-code");
  assert.equal(normalizeHarnessName("Codex"), "codex");
  assert.equal(normalizeHarnessName("claude-code"), "claude-code");
});

test("normalizeHarnessList normalizes string | string[] | undefined", () => {
  assert.deepEqual(normalizeHarnessList(undefined), []);
  assert.deepEqual(normalizeHarnessList("codex"), ["codex"]);
  assert.deepEqual(normalizeHarnessList(["claude", "codex"]), [
    "claude-code",
    "codex",
  ]);
  assert.deepEqual(normalizeHarnessList(["", "  "]), []);
  // Idempotent — already-canonical input is unchanged (the parse-once guarantee).
  assert.deepEqual(normalizeHarnessList(["claude-code", "codex"]), [
    "claude-code",
    "codex",
  ]);
});

test("adapterForInstructionFile maps a target filename to its harness", () => {
  assert.equal(adapterForInstructionFile("CLAUDE.md")?.name, "claude-code");
  assert.equal(adapterForInstructionFile("AGENTS.md")?.name, "codex");
  assert.equal(adapterForInstructionFile("DOCS.md"), undefined); // not an instruction file
});

test("resolveHarnessSelection: --harness flag wins over config, kind=ok", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({
      root: dir,
      flag: "codex",
      configHarness: "claude-code",
    });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "codex");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: flag alias (claude) resolves to claude-code", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({ root: dir, flag: "claude" });
    assert.equal(sel.adapter.name, "claude-code");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: unknown flag throws (no silent fallback)", () => {
  const dir = makeTmpDir();
  try {
    assert.throws(
      () => resolveHarnessSelection({ root: dir, flag: "nope" }),
      /Unknown harness/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: single config harness used, kind=ok (alias ok)", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({ root: dir, configHarness: "claude" });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "claude-code");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: single-element array behaves like a string", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({
      root: dir,
      configHarness: ["codex"],
    });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "codex");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: multiple config harnesses → first + loud notice", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({
      root: dir,
      configHarness: ["claude-code", "codex"],
    });
    assert.equal(sel.adapter.name, "claude-code");
    const notice = noticeOf(sel);
    assert.match(notice, /claude-code, codex/);
    assert.match(notice, /--harness=/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: empty array falls through to auto-detect", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({ root: dir, configHarness: [] });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "claude-code"); // empty-repo default
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: no config → auto-detect, kind=ok on an empty repo", () => {
  const dir = makeTmpDir();
  try {
    const sel = resolveHarnessSelection({ root: dir });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "claude-code"); // backwards-compatible default
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: auto-detect a Codex-only repo (AGENTS.md)", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# x\n");
    const sel = resolveHarnessSelection({ root: dir });
    assert.equal(sel.kind, "ok");
    assert.equal(sel.adapter.name, "codex");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: ambiguous repo (CLAUDE.md + a DIFFERENT AGENTS.md) warns", () => {
  const dir = makeTmpDir();
  try {
    // Genuinely different instruction files (not a mirror) → real ambiguity.
    writeFileSync(join(dir, "CLAUDE.md"), "# claude rules\n");
    writeFileSync(join(dir, "AGENTS.md"), "# agents rules — different\n");
    const sel = resolveHarnessSelection({ root: dir });
    const notice = noticeOf(sel);
    assert.match(notice, /matches/);
    assert.match(notice, /harness/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessSelection: a CLAUDE.md⇄AGENTS.md MIRROR collapses to Claude Code (no false 'both')", () => {
  const dir = makeTmpDir();
  try {
    // Byte-identical mirror (the Anthropic-sanctioned bridge) — ONE logical config,
    // not two harnesses; AGENTS.md is a cross-tool standard, not a Codex target.
    writeFileSync(join(dir, "CLAUDE.md"), "# shared rules\n");
    writeFileSync(join(dir, "AGENTS.md"), "# shared rules\n");
    const sel = resolveHarnessSelection({ root: dir });
    assert.equal(sel.kind, "ok"); // not a "matches both" notice
    assert.equal(sel.adapter.name, "claude-code");
  } finally {
    cleanupTmpDir(dir);
  }
});

// 🔴 BOTH SYMLINK DIRECTIONS, because a draft of the mirror-collapse read the
// direction as intent and silently reversed one of them. A repository whose
// `CLAUDE.md` is a link to `AGENTS.md` was resolved to the AGENTS-reading
// harness, and the audit then went looking for that harness's surfaces —
// `.claude/skills` vanished from a repo that has them. The link is a BRIDGE an
// AGENTS-first repository adds so Claude Code works, so its direction is not a
// statement about which harness was meant; the collapse breaks the tie by
// registry order either way. These two cases are what pins that down.
for (const [name, link, target] of [
  ["AGENTS.md -> CLAUDE.md", "AGENTS.md", "CLAUDE.md"],
  ["CLAUDE.md -> AGENTS.md", "CLAUDE.md", "AGENTS.md"],
] as const) {
  test(`resolveHarnessSelection: a SYMLINK mirror (${name}) collapses to Claude Code`, () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, target), "# shared rules\n");
      symlinkSync(join(dir, target), join(dir, link));
      const sel = resolveHarnessSelection({ root: dir });
      assert.equal(sel.kind, "ok"); // not a "matches both" notice
      assert.equal(sel.adapter.name, "claude-code");
    } finally {
      cleanupTmpDir(dir);
    }
  });
}

// resolveHarnessAdapters — the FULL fan-out set (unlike resolveHarnessSelection's
// single pick): an install writes the same artifact into EVERY enabled harness.
test("resolveHarnessAdapters: config harness list → ALL of them (the fan-out)", () => {
  const dir = makeTmpDir();
  try {
    const adapters = resolveHarnessAdapters({
      root: dir,
      configHarness: ["claude", "codex"],
    });
    assert.deepEqual(
      adapters.map((a) => a.name),
      ["claude-code", "codex"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessAdapters: --harness flag → just that one (explicit override is singular)", () => {
  const dir = makeTmpDir();
  try {
    const adapters = resolveHarnessAdapters({
      root: dir,
      flag: "codex",
      configHarness: ["claude", "codex"],
    });
    assert.deepEqual(
      adapters.map((a) => a.name),
      ["codex"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessAdapters: no config → auto-detect → the one detected", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# x\n");
    const adapters = resolveHarnessAdapters({ root: dir });
    assert.deepEqual(
      adapters.map((a) => a.name),
      ["codex"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("resolveHarnessAdapters: de-dupes an alias + its canonical (claude + claude-code → one)", () => {
  const dir = makeTmpDir();
  try {
    const adapters = resolveHarnessAdapters({
      root: dir,
      configHarness: ["claude", "claude-code", "codex"],
    });
    assert.deepEqual(
      adapters.map((a) => a.name),
      ["claude-code", "codex"],
    );
  } finally {
    cleanupTmpDir(dir);
  }
});
