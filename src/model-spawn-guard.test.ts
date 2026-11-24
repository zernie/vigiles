/**
 * EVERY REAL-MODEL SPAWN IS GUARDED — checked over the source, so a future
 * adapter cannot silently skip it.
 *
 * 🔴 WHY A SOURCE CHECK AND NOT THREE MORE CALLS. The guard was believed to sit
 * at "the composition root", where every paid path funnels. Measured 2026-08-12:
 * it funnelled one of four. `measureTriggerRate(spec, { evalDriver })` calls the
 * injected driver's runner DIRECTLY, and `judge` / `deriveAttackReal` are reached
 * from inside a user's `measure` callback — none of them passes the root at all.
 * So "add it in the other three places" is correct today and silently wrong the
 * next time an adapter ships a runner.
 *
 * The trigger GENERALISES instead of listing: any spawn whose program expression
 * mentions `agentBinary` is a model spawn, because that is the field every
 * `HarnessRuntime` declares for its binary — a new adapter spawning
 * `fooRuntime.agentBinary` is caught the day it is written, without this file
 * knowing `foo` exists. The two binaries currently spawned by literal name are
 * covered too.
 *
 * A site passes by CALLING the guard in the same function, or by carrying a
 * free-tier marker with a reason. An unclassified spawn fails: silence is not an
 * option.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { globSync } from "glob";

const ROOT = resolve(import.meta.dirname, "..");

/** Declares a spawn free — a `--version` probe, or the mock-wired harness tier. */
const FREE_TIER = "vigiles:free-tier";
const GUARD = "refuseUnderForeignRunner(";

/**
 * A spawn whose program is a model backend.
 *
 * 🔴 `\s*` AFTER THE PAREN, AND THE FIRST DRAFT OF THIS FILE LACKED IT. All three
 * previously-unguarded spawns are written multi-line — `spawnSync(\n  "codex",` —
 * so a same-line pattern found four sites and MISSED exactly the three the
 * finding was about. A check that cannot see the bug it was written for is worse
 * than none, which is why the count assertion below exists.
 */
const MODEL_SPAWN =
  /\bspawn(?:Sync)?\(\s*(?:(?:[A-Za-z_$][\w.]*\.)?agentBinary|["'](?:claude|codex)["'])/g;

/**
 * Blank a comment line to SPACES OF THE SAME LENGTH.
 *
 * 🔴 Not `""`. Replacing a comment with the empty string preserves the line count
 * but shifts every character OFFSET after it, so a match index taken from the
 * blanked copy lands somewhere else in the raw text — and the guard lookup, which
 * reads the raw text, found nothing. First draft did exactly that and reported
 * all seven sites unguarded, including the four this round had just fixed.
 */
function blankComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trimStart();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")
        ? " ".repeat(l.length)
        : l;
    })
    .join("\n");
}

/**
 * The enclosing function around `at`. Generous on purpose: the guard MUST sit
 * well above the spawn where a `try` would otherwise swallow it.
 */
function enclosing(text: string, at: number): string {
  const a = text.lastIndexOf("\nexport function ", at);
  const b = text.lastIndexOf("\nfunction ", at);
  return text.slice(Math.max(a, b, 0), at);
}

/** Every model-spawn site in the source, with the text around it. */
function spawnSites(): { where: string; context: string }[] {
  const out: { where: string; context: string }[] = [];
  for (const rel of globSync("src/**/*.ts", { cwd: ROOT })
    .filter((p) => !p.endsWith(".test.ts"))
    .sort()) {
    const raw = readFileSync(join(ROOT, rel), "utf-8");
    // Comments blanked to FIND a site (this file's own prose names them); the
    // RAW text is what the guard/marker lookup reads, because the free-tier
    // marker is itself a comment — searching the blanked copy would erase
    // exactly what it looks for. The first draft did, and three real sites
    // reported as unguarded.
    const code = blankComments(raw);
    MODEL_SPAWN.lastIndex = 0;
    for (let m = MODEL_SPAWN.exec(code); m; m = MODEL_SPAWN.exec(code)) {
      out.push({
        where: `${rel}:${String(code.slice(0, m.index).split("\n").length)}`,
        context: enclosing(raw, m.index) + raw.slice(m.index, m.index + 400),
      });
    }
  }
  return out;
}

test("every real-model spawn calls the foreign-runner guard, or declares itself free", () => {
  const sites = spawnSites();
  // The scan must FIND things — a pattern that matched nothing would pass
  // vacuously, which is the failure mode this whole review keeps meeting.
  assert.ok(
    sites.length >= 7,
    `expected the model-spawn scan to find sites; found ${String(sites.length)}`,
  );
  const unguarded = sites
    .filter((s) => !s.context.includes(GUARD) && !s.context.includes(FREE_TIER))
    .map((s) => s.where);
  assert.deepEqual(
    unguarded,
    [],
    `real-model spawn(s) with neither a guard nor a \`${FREE_TIER}\` marker:\n${unguarded.join("\n")}`,
  );
});

test("…and the four money doors are each present and guarded", () => {
  // Named explicitly, so removing a guard fails HERE with the file that lost it
  // rather than only through the generic scan.
  for (const [path, what] of [
    ["src/eval.ts", "spawning `claude`"],
    ["src/adapters/codex/eval.ts", "driving `codex exec`"],
    ["src/judge.ts", "grading with `claude`"],
    ["src/scan-behavioral.ts", "deriving an adversarial prompt"],
  ] as const) {
    const text = readFileSync(join(ROOT, path), "utf-8");
    assert.ok(
      text.includes(`${GUARD}"${what}`),
      `${path} must call the guard with its own description`,
    );
  }
});
