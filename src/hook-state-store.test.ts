/**
 * Named-state STORE suite (vitest) — the seam that makes a THROTTLED hook
 * testable at all.
 *
 * Two halves, and the second is the load-bearing one:
 *
 *   1. Unit — the path derivation, the read/write round-trip, and every way
 *      `seed` can be told WHEN a fact was recorded (or told wrongly).
 *   2. E2E, BOTH DIRECTIONS — a real compiled gate with
 *      `needs: [state("retro.nagged")]`, run through the REAL CLI runtime
 *      (`node dist/cli.js hook-runtime run-program`), seeded ONLY through the
 *      public handle: it FIRES on a four-day-old fact and STAYS QUIET on a fresh
 *      one. That pair is the whole point — a throttle has no other behaviour —
 *      and it is what proves the handle writes where the RUNTIME reads, rather
 *      than agreeing with a second copy of the path rule.
 *
 * Harness scope (`test-both-harnesses`): the store is harness-NEUTRAL — the
 * directory is vigiles's own `.vigiles/state/`, and the gather + exit-2 decision
 * path this exercises is byte-identical on Claude Code and Codex — so one run
 * covers both rather than a redundant per-harness loop.
 */
import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { HookStateError, record } from "./core/hook-state.js";
import {
  experimental_hookState,
  hookStateDir,
  readHookState,
  writeHookState,
} from "./hook-state-store.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = pathToFileURL(resolve(REPO_ROOT, "dist", "hook.js")).href;

describe("hookStateDir", () => {
  test("MIRRORS the hook's own directory when it lives under the root", () => {
    const cwd = "/proj";
    expect(hookStateDir("/proj/.claude/hooks/nag.hook.ts", cwd)).toBe(
      resolve("/proj/.vigiles/state/.claude/hooks"),
    );
    // The relative spelling of the same file lands in the same place — the
    // runtime and a test rarely spell a path the same way.
    expect(hookStateDir(".claude/hooks/nag.hook.ts", cwd)).toBe(
      hookStateDir("/proj/.claude/hooks/nag.hook.ts", cwd),
    );
  });

  test("falls back to a hashed, still-isolated dir for a hook OUTSIDE the root", () => {
    const outside = hookStateDir("/elsewhere/hooks/nag.mjs", "/proj");
    expect(outside).toMatch(/\.vigiles[/\\]state[/\\]external-[0-9a-f]+$/);
    // Stable across calls, and not the same bucket as another outside dir.
    expect(outside).toBe(hookStateDir("/elsewhere/hooks/other.mjs", "/proj"));
    expect(outside).not.toBe(hookStateDir("/somewhere/hooks/x.mjs", "/proj"));
  });

  test("defaults the root to the process cwd", () => {
    expect(hookStateDir("a/b/h.mjs")).toBe(
      resolve(process.cwd(), ".vigiles/state/a/b"),
    );
  });
});

describe("readHookState", () => {
  test("a never-recorded key reads as null (which the fact view turns into Infinity)", () => {
    const dir = makeTmpDir();
    try {
      expect(readHookState("h.mjs", "never.happened", dir)).toBeNull();
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("CORRUPT or wrong-shaped stored JSON reads as null, never as fresh", () => {
    const dir = makeTmpDir();
    try {
      const store = hookStateDir("h.mjs", dir);
      mkdirSync(store, { recursive: true });
      writeFileSync(resolve(store, "torn.json"), "{ not json");
      writeFileSync(resolve(store, "shaped.json"), JSON.stringify({ at: 7 }));
      expect(readHookState("h.mjs", "torn", dir)).toBeNull();
      expect(readHookState("h.mjs", "shaped", dir)).toBeNull();
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("defaults the root to the process cwd", () => {
    expect(readHookState("h.mjs", "definitely.not.recorded.here")).toBeNull();
  });
});

describe("writeHookState", () => {
  test("stores value + ISO instant + the hook that claimed it, atomically", () => {
    const dir = makeTmpDir();
    try {
      const at = new Date("2026-01-02T03:04:05.000Z");
      writeHookState("hooks/nag.mjs", record("retro.nagged", "main"), {
        cwd: dir,
        at,
      });
      const stored = JSON.parse(
        readFileSync(
          resolve(hookStateDir("hooks/nag.mjs", dir), "retro.nagged.json"),
          "utf-8",
        ),
      ) as { value: string; at: string; by: string };
      expect(stored).toEqual({
        value: "main",
        at: "2026-01-02T03:04:05.000Z",
        by: "hooks/nag.mjs",
      });
      // No temp file survives the rename.
      expect(readHookState("hooks/nag.mjs", "retro.nagged", dir)?.value).toBe(
        "main",
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("stamps NOW when no instant is given (the runtime's own path)", () => {
    const dir = makeTmpDir();
    try {
      const before = Date.now();
      writeHookState("h.mjs", record("just.now"), { cwd: dir });
      const at = Date.parse(readHookState("h.mjs", "just.now", dir)?.at ?? "");
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("with NO options at all — the exact shape the live runtime calls", () => {
    // `writeHookState(file, w)` is how `applyHookWrites` in the CLI calls it, so
    // the both-defaults path is production, not a convenience. A hook OUTSIDE the
    // repo keeps this out of any path a real hook would claim; the handle's
    // `clear()` removes the bucket again.
    const outside = resolve(makeTmpDir(), "hooks", "stray.mjs");
    const st = experimental_hookState(outside);
    try {
      writeHookState(outside, record("runtime.default", "v"));
      expect(readHookState(outside, "runtime.default")?.value).toBe("v");
      expect(st.read("runtime.default").fresherThan("1m")).toBe(true);
    } finally {
      st.clear();
    }
  });
});

describe("experimental_hookState", () => {
  test("seed BACKDATES a fact, and reads it back the way the hook will see it", () => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState("hooks/nag.mjs", { cwd: dir });
      const fact = st.seed("retro.nagged", { ago: "4d", value: "main" });
      expect(fact.recorded).toBe(true);
      expect(fact.value).toBe("main");
      expect(fact.olderThan("1d")).toBe(true);
      expect(fact.fresherThan("1d")).toBe(false);
      // ~4 days, allowing for the seconds the test itself takes.
      expect(fact.ageSeconds).toBeGreaterThan(4 * 86400 - 60);
      expect(fact.ageSeconds).toBeLessThan(4 * 86400 + 60);
      // `read` agrees with what `seed` returned — one reader, no second copy.
      expect(st.read("retro.nagged").at).toBe(fact.at);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("a FRESH seed is fresh, and an explicit instant is honoured", () => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState("hooks/nag.mjs", { cwd: dir });
      expect(st.seed("retro.nagged").fresherThan("1m")).toBe(true);
      expect(st.seed("retro.nagged").value).toBe("");

      const at = new Date(Date.now() - 90 * 1000);
      const exact = st.seed("retro.nagged", { at });
      expect(exact.at).toBe(at.toISOString());
      expect(exact.olderThan("1m")).toBe(true);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("a never-recorded key reads TOTAL — Infinity, not a throw and not fresh", () => {
    const dir = makeTmpDir();
    try {
      const fact = experimental_hookState("hooks/nag.mjs", { cwd: dir }).read(
        "never.recorded",
      );
      expect(fact.recorded).toBe(false);
      expect(fact.ageSeconds).toBe(Infinity);
      expect(fact.fresherThan("365d")).toBe(false);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("clear forgets this hook's facts, and is a no-op when there are none", () => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState("hooks/nag.mjs", { cwd: dir });
      st.seed("retro.nagged");
      expect(st.read("retro.nagged").recorded).toBe(true);
      st.clear();
      expect(st.read("retro.nagged").recorded).toBe(false);
      expect(() => {
        st.clear();
      }).not.toThrow();
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("clear leaves a CO-LOCATED hook's facts alone — they share one store", () => {
    // The store is keyed by directory on purpose (one hook reads another's
    // fact), so hooks that ship side by side share it. A `clear()` that deleted
    // the directory reset every one of them: the documented opener would wipe
    // an unrelated hook, and two tests seeding different hooks in one folder
    // would erase each other's seeded state.
    const dir = makeTmpDir();
    try {
      const nag = experimental_hookState("hooks/nag.mjs", { cwd: dir });
      const sibling = experimental_hookState("hooks/sibling.mjs", { cwd: dir });
      expect(nag.dir).toBe(sibling.dir);

      nag.seed("retro.nagged");
      sibling.seed("calendar.synced");
      // Same KEY from both, too: the surviving entry is the sibling's write.
      nag.seed("shared.fact", { value: "from-nag" });
      sibling.seed("shared.fact", { value: "from-sibling" });

      nag.clear();

      expect(nag.read("retro.nagged").recorded).toBe(false);
      expect(sibling.read("calendar.synced").recorded).toBe(true);
      expect(sibling.read("shared.fact").value).toBe("from-sibling");
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("clear leaves an entry it cannot attribute, rather than claiming it", () => {
    // Every write this module makes stamps an owner, so an entry without one
    // came from somewhere else. Deleting it is the collateral damage the scope
    // exists to remove; it reads back as another owner's fact instead.
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState("hooks/nag.mjs", { cwd: dir });
      st.seed("mine");
      writeFileSync(
        resolve(st.dir, "unattributed.json"),
        JSON.stringify({ value: "x", at: new Date().toISOString() }),
      );
      writeFileSync(resolve(st.dir, "torn.json"), "{ not json");

      // A torn `<key>.json.<pid>.tmp` from an interrupted write is not an entry
      // at all — clear must step over it rather than parse it.
      writeFileSync(resolve(st.dir, "mine.json.1234.tmp"), "{}");

      st.clear();

      expect(st.read("mine").recorded).toBe(false);
      expect(st.read("unattributed").recorded).toBe(true);
      expect(existsSync(resolve(st.dir, "torn.json"))).toBe(true);
      expect(existsSync(resolve(st.dir, "mine.json.1234.tmp"))).toBe(true);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("exposes WHERE the facts live, for a message — the same dir the runtime derives", () => {
    const dir = makeTmpDir();
    try {
      expect(experimental_hookState("hooks/nag.mjs", { cwd: dir }).dir).toBe(
        hookStateDir("hooks/nag.mjs", dir),
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("defaults the root to the process cwd", () => {
    // A hook OUTSIDE the repo, so the fallback bucket is used and nothing lands
    // in a path a real hook would claim; `clear()` removes it again.
    const outside = resolve(makeTmpDir(), "hooks", "stray.mjs");
    const st = experimental_hookState(outside);
    try {
      expect(st.dir).toBe(hookStateDir(outside));
      expect(st.seed("stray.fact", { value: "x" }).value).toBe("x");
    } finally {
      st.clear();
    }
  });

  describe("refuses what a hook would be refused", () => {
    const st = () =>
      experimental_hookState("hooks/nag.mjs", { cwd: makeTmpDir() });

    test("an invalid key — the SAME validator a hook's record()/state() uses", () => {
      expect(() => st().seed("../settings")).toThrow(HookStateError);
      expect(() => st().read("../settings")).toThrow(HookStateError);
    });

    test("ago AND at together — a JS caller gets the throw the type already forbids", () => {
      expect(() =>
        st().seed("retro.nagged", {
          ago: "1d",
          // @ts-expect-error the union makes this a tsc error too — the throw is
          // for `.mjs` harness tests, where the type never runs.
          at: new Date(),
        }),
      ).toThrow(/not both/);
    });

    test("a malformed duration, rather than silently seeding NOW", () => {
      expect(() =>
        // @ts-expect-error the Duration template type rejects this at compile time.
        st().seed("retro.nagged", { ago: "soonish" }),
      ).toThrow(/invalid duration/);
    });
  });
});

// ---------------------------------------------------------------------------
// The load-bearing half: a REAL stateful gate, driven by the REAL runtime, with
// its state seeded ONLY through the public handle. Both directions.
// ---------------------------------------------------------------------------

const THROTTLED_GATE = `import { experimental_defineHook, state, deny, allow } from "__HOOK__";
export default experimental_defineHook({
  on: "PreToolUse",
  needs: [state("retro.nagged")],
  decide: (e) =>
    e.ctx["retro.nagged"].olderThan("1d")
      ? deny("time for a retro before you ship again")
      : allow(),
});`;

describe("a throttled gate, seeded through the handle and run by the real runtime", () => {
  const setup = (dir: string) => {
    const file = resolve(dir, "retro-gate.mjs");
    writeFileSync(file, THROTTLED_GATE.replaceAll("__HOOK__", HOOK_DIST));
    const st = experimental_hookState(file, { cwd: dir });
    st.clear();
    const run = () =>
      runHook(
        `node ${CLI} hook-runtime run-program ${file}`,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push origin HEAD" },
        },
        { cwd: dir },
      );
    return { st, run };
  };

  test("FIRES when the seeded fact is four days old", () => {
    const dir = makeTmpDir();
    try {
      const { st, run } = setup(dir);
      st.seed("retro.nagged", { ago: "4d" });
      const r = run();
      expect(r.blocked).toBe(true);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/time for a retro/);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("STAYS QUIET when the seeded fact is ten minutes old", () => {
    const dir = makeTmpDir();
    try {
      const { st, run } = setup(dir);
      st.seed("retro.nagged", { ago: "10m" });
      const r = run();
      expect(r.blocked).toBe(false);
      expect(r.exitCode).toBe(0);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("and with NO fact at all it fires — never-recorded must not read as fresh", () => {
    const dir = makeTmpDir();
    try {
      const { st, run } = setup(dir);
      expect(st.read("retro.nagged").recorded).toBe(false);
      expect(run().blocked).toBe(true);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("the handle reads back — and clears — what the RUNTIME wrote", () => {
    const dir = makeTmpDir();
    try {
      // A react that RECORDS the fact, run by the runtime; the handle then reads
      // it. This is the direction that catches a handle pointing at the wrong
      // dir: nothing in the test ever writes the file.
      const file = resolve(dir, "recorder.mjs");
      writeFileSync(
        file,
        `import { experimental_defineReact, tools, notice, record } from "${HOOK_DIST}";
export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Bash"),
  react: () => notice("noted", record("retro.nagged", "by-the-runtime")),
});`,
      );
      const st = experimental_hookState(file, { cwd: dir });
      st.clear();
      expect(st.read("retro.nagged").recorded).toBe(false);

      runHook(
        `node ${CLI} hook-runtime run-program ${file}`,
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
        },
        { cwd: dir },
      );

      const fact = st.read("retro.nagged");
      expect(fact.recorded).toBe(true);
      expect(fact.value).toBe("by-the-runtime");
      expect(fact.fresherThan("1m")).toBe(true);

      // And the owner the RUNTIME stamped is the one `clear()` scopes on. If
      // the two derivations ever disagreed, clear() would quietly stop
      // clearing anything — a green test over a store that never resets.
      st.clear();
      expect(st.read("retro.nagged").recorded).toBe(false);
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
