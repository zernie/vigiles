/**
 * This repository's OWN compiled hook, tested — `.vigiles/hooks/test-tier-nudge.hook.mjs`.
 *
 * Two halves, cheapest tier first (`pick-the-test-tier`):
 *
 *   1. PURE / in-process. The hook's `react` is a pure function, so its whole
 *      classification + throttle logic is decided by `runHookProgram` with a
 *      hand-built `StateFact` — no subprocess, no filesystem, no model. Every
 *      question that can be answered here IS answered here.
 *   2. E2E against the REAL runtime (`node dist/cli.js hook-runtime run-program`),
 *      with the fact seeded ONLY through the public `experimental_hookState`
 *      handle. That half exists because the throttle's behaviour depends on
 *      where the runtime READS state, which no pure test can observe: it must
 *      SPEAK on an old fact and STAY QUIET on a fresh one, and both directions
 *      are asserted rather than one.
 *
 * Harness scope (`test-both-harnesses`): ONE run covers both. The hook is a
 * `react`, and a react's `notice` is Claude-Code-confirmed output only — which is
 * why `installHookFile` emits a loud warning when a react is compiled for any
 * other harness. This hook is wired into THIS repo's `.claude/settings.json` for
 * Claude Code, so a Codex arm would assert a path the product itself declines to
 * claim. The harness-neutral part it does exercise (named state, the exit-0
 * react runtime) is already covered per-harness elsewhere.
 *
 * State isolation: the E2E half runs the REAL hook file but with `process.cwd()`
 * pointed at a throwaway dir, so `hookStateDir` resolves outside the repo and the
 * test cannot clobber (or be confused by) a contributor's live throttle state.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { resolve } from "node:path";

import { loadHook } from "./load-hook.js";
import { runHookProgram, type AnyHook } from "./core/hook-program.js";
import { stateFact, type StateFact } from "./core/hook-state.js";
import { experimental_hookState } from "./hook-state-store.js";
import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
/** The surface under test, spelled as the wiring spells it. */
const HOOK = ".vigiles/hooks/test-tier-nudge.hook.mjs";
const HOOK_ABS = resolve(REPO_ROOT, HOOK);
const KEY = "tier.reminded";

let hook: AnyHook;
beforeAll(async () => {
  hook = await loadHook(HOOK_ABS);
});

/** A `PostToolUse` payload as Claude Code sends one, with the repo as its root. */
const edit = (path: string, tool = "Edit") => ({
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: { file_path: resolve(REPO_ROOT, path) },
  cwd: REPO_ROOT,
});

/** A recorded fact, built purely — `null` means never recorded. */
const fact = (opts?: { value: string; agoSeconds: number }): StateFact =>
  stateFact(
    opts === undefined
      ? null
      : {
          value: opts.value,
          at: new Date(Date.now() - opts.agoSeconds * 1000).toISOString(),
        },
    Date.now(),
  );

/** The hook's Reaction for one edit, given one state of the world. */
function react(path: string, last?: { value: string; agoSeconds: number }) {
  const out = runHookProgram(hook, edit(path), { [KEY]: fact(last) });
  if (out.kind !== "reaction") throw new Error(`not a react: ${out.kind}`);
  return out.reaction;
}

describe("what it classifies (pure)", () => {
  test.each([
    ["src/scan.test.ts", "unit"],
    ["src/docker.integration.test.ts", "integration"],
    ["src/egress.e2e.test.ts", "e2e"],
    ["examples/harness/policy-gate.harness.mjs", "harness"],
    ["examples/harness/skill-outcome.eval.mjs", "eval"],
  ])("%s is a %s-tier test", (path, tier) => {
    const r = react(path);
    expect(r.kind).toBe("notice");
    // The tier NAME is the load-bearing half of the message: `.integration.test.ts`
    // and `.e2e.test.ts` both end in `.test.ts`, so a reordered TIERS table would
    // classify them as `unit` while still producing a notice.
    expect(r.kind === "notice" && r.message).toContain(
      `is a ${tier}-tier test`,
    );
  });

  test.each([
    "docs/compiled-hooks.md",
    "site/src/App.tsx",
    "src/scan.ts",
    "CONTRIBUTING.md",
    ".vigiles/hooks/test-tier-nudge.hook.mjs",
  ])("stays SILENT on %s", (path) => {
    // A reminder that fires on everything is muted on day one, so silence on a
    // non-test file is asserted as hard as the firing is.
    expect(react(path).kind).toBe("none");
  });

  test("ignores a tool that does not edit files", () => {
    const out = runHookProgram(
      hook,
      { ...edit("src/scan.test.ts"), tool_name: "Bash" },
      { [KEY]: fact() },
    );
    expect(out.kind === "reaction" && out.reaction.kind).toBe("none");
  });
});

describe("the throttle (pure)", () => {
  test("speaks when the fact was never recorded", () => {
    expect(react("src/scan.test.ts").kind).toBe("notice");
  });

  test("stays quiet a minute later, for the SAME tier", () => {
    expect(
      react("src/other.test.ts", { value: "unit", agoSeconds: 60 }).kind,
    ).toBe("none");
  });

  test("speaks again after an hour, for the same tier", () => {
    expect(
      react("src/other.test.ts", { value: "unit", agoSeconds: 2 * 3600 }).kind,
    ).toBe("notice");
  });

  test("speaks IMMEDIATELY when the tier changes — the moment it is worth reading", () => {
    const r = react("examples/harness/x.harness.mjs", {
      value: "unit",
      agoSeconds: 60,
    });
    expect(r.kind).toBe("notice");
    expect(r.kind === "notice" && r.message).toContain("harness-tier");
  });

  test("records the tier it just spoke about, so the next edit can compare", () => {
    const r = react("src/scan.test.ts");
    expect(r.records).toEqual([{ kind: "record", name: KEY, value: "unit" }]);
    // And a throttled turn records NOTHING — re-stamping on silence is how a
    // throttle turns into permanent silence.
    expect(
      react("src/scan.test.ts", { value: "unit", agoSeconds: 60 }).records,
    ).toEqual([]);
  });
});

describe("what it points at (pure)", () => {
  test("names the live sources instead of restating them", () => {
    const r = react("src/scan.test.ts");
    const message = r.kind === "notice" ? r.message : "";
    // Each of these is a place that MAINTAINS itself: the rule, the doc the
    // doc-test-script-coverage test binds to package.json, and the command that
    // prints its own not-covered list from a CI-bound constant.
    expect(message).toContain("pick-the-test-tier");
    expect(message).toContain("CONTRIBUTING.md");
    expect(message).toContain("npm run check");
    // A second copy of the tier map is the thing this hook must not become.
    expect(message).not.toMatch(/npm run test:(unit|harness|e2e|integration)/);
    expect(message.split("\n").length).toBeLessThanOrEqual(6);
  });
});

describe("against the REAL runtime, seeded through the public handle", () => {
  const drive = (dir: string, path: string) =>
    runHook(`node ${CLI} hook-runtime run-program ${HOOK_ABS}`, edit(path), {
      cwd: dir,
    });

  const withStore = (
    fn: (dir: string, st: ReturnType<typeof experimental_hookState>) => void,
  ) => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState(HOOK_ABS, { cwd: dir });
      st.clear();
      fn(dir, st);
    } finally {
      cleanupTmpDir(dir);
    }
  };

  test("SPEAKS when the seeded fact is a day old", () => {
    withStore((dir, st) => {
      st.seed(KEY, { ago: "1d", value: "unit" });
      const r = drive(dir, "src/scan.test.ts");
      expect(r.exitCode).toBe(0);
      expect(r.blocked).toBe(false);
      expect(r.stderr).toContain("is a unit-tier test");
    });
  });

  test("STAYS QUIET when the seeded fact is ten minutes old", () => {
    withStore((dir, st) => {
      st.seed(KEY, { ago: "10m", value: "unit" });
      const r = drive(dir, "src/scan.test.ts");
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("-tier test");
    });
  });

  test("with NO fact at all it speaks, and RECORDS the tier the runtime saw", () => {
    withStore((dir, st) => {
      expect(st.read(KEY).recorded).toBe(false);
      expect(drive(dir, "src/scan.test.ts").stderr).toContain("unit-tier test");
      // Read back through the handle: this is the direction that catches a hook
      // whose write never lands, which would silently disable the throttle.
      const after = st.read(KEY);
      expect(after.recorded).toBe(true);
      expect(after.value).toBe("unit");
    });
  });

  test("never blocks, and says nothing at all, on a non-test edit", () => {
    withStore((dir) => {
      const r = drive(dir, "docs/compiled-hooks.md");
      expect(r.exitCode).toBe(0);
      expect(r.blocked).toBe(false);
      expect(r.stderr.trim()).toBe("");
    });
  });
});

/**
 * WHERE THE NOTICE GOES — measured, because the answer decides what this hook
 * can honestly claim to do.
 *
 * 🔴 THIS BLOCK USED TO ASSERT THE OPPOSITE, AND FINDING OUT WHY IS THE POINT.
 * Written 2026-09-07, it pinned `stdout === ""` — a react's `notice` went to
 * stderr and nowhere else. That looked like "the reminder is for the human".
 * It was not: per Claude Code's hooks docs, stderr from a hook that exits 0
 * "goes to the debug log only, never the transcript, and Claude never sees it",
 * and a react ALWAYS exits 0 because its type has no `deny`. So the notice
 * reached NOBODY — not the model, not the user. `docs/compiled-hooks.md` stated
 * the MECHANIC ("notice writes to stderr") and never the CONSEQUENCE, which is
 * exactly the false-confidence shape compiled hooks exist to eliminate, found
 * inside compiled hooks by this repo's own first compiled hook.
 *
 * The runtime now emits the same `hookSpecificOutput.additionalContext` the
 * shipped refs nudge uses, gated on the active adapter's `injectableEvents`
 * (`noticeDelivery`, pinned per-harness in `src/core/hook-program.test.ts`; the
 * non-injectable path and the loud compile warning in `src/hook.test.ts`).
 *
 * Pinned at the UNIT tier deliberately. The harness tier is the natural home for
 * "did it reach the model?" (`requestContains`), but its CONTROL —
 * `examples/harness/refs-nudge.harness.mjs`, the repo's own shipped nudge —
 * FAILS on this machine's `claude` 2.1.263 against the pinned
 * `VALIDATED_CC_VERSION` 2.1.187. A tier whose control cannot land its own nudge
 * cannot speak about a second one, so this is measured at the protocol bytes,
 * where no binary is involved.
 */
describe("how the notice is DELIVERED (measured, not assumed)", () => {
  test("the notice REACHES the agent as additionalContext, and still hits stderr", () => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState(HOOK_ABS, { cwd: dir });
      st.clear();
      const r = runHook(
        `node ${CLI} hook-runtime run-program ${HOOK_ABS}`,
        edit("src/scan.test.ts"),
        { cwd: dir },
      );
      // The half that was broken: stdout is where a hook speaks to the MODEL.
      const out = r.json as {
        hookSpecificOutput?: { additionalContext?: string };
      } | null;
      expect(out?.hookSpecificOutput?.additionalContext).toContain(
        "is a unit-tier test",
      );
      // The debug-log copy is kept on purpose — existing probes read it.
      expect(r.stderr).toContain("is a unit-tier test");
      // And it is still a react: it cannot block.
      expect(r.blocked).toBe(false);
      expect(r.exitCode).toBe(0);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("a throttled turn says NOTHING to the model either", () => {
    const dir = makeTmpDir();
    try {
      const st = experimental_hookState(HOOK_ABS, { cwd: dir });
      st.clear();
      st.seed(KEY, { ago: "10m", value: "unit" });
      const r = runHook(
        `node ${CLI} hook-runtime run-program ${HOOK_ABS}`,
        edit("src/scan.test.ts"),
        { cwd: dir },
      );
      // Silence has to be silent on BOTH channels, or the throttle only
      // throttles the channel nobody was reading.
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr.trim()).toBe("");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
