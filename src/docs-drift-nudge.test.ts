/**
 * This repository's OWN compiled hook #2, tested — `.vigiles/hooks/docs-drift-nudge.hook.mjs`.
 *
 * PURE / in-process only, and that is a decision rather than a shortcut. The
 * hook's `react` is a pure function of (path, two `StateFact`s), so every
 * question it can be asked is decided by `runHookProgram` with hand-built facts —
 * no subprocess, no filesystem, no model (`pick-the-test-tier`: push each
 * question down to the cheapest tier that can decide it).
 *
 * What an E2E half would add here, and why it is not duplicated: that the
 * RUNTIME reads named state from the place the hook writes it. That is a
 * property of the runtime, not of this hook, and `src/test-tier-nudge.test.ts`
 * already pins it end-to-end through `experimental_hookState` in both
 * directions. A second copy would re-measure the runtime and call it coverage of
 * this file.
 *
 * Harness scope (`test-both-harnesses`): ONE run covers both, for the same
 * reason as the tier nudge — a react's `notice` is Claude-Code-confirmed output
 * only, so a Codex arm would assert a path the product declines to claim.
 *
 * THE TWO SILENCES ARE ASSERTED SEPARATELY, which is the point of the hook
 * having two facts. "Quiet because docs are being edited" is success; "quiet
 * because I just spoke" is a rate limit. A test that only checked `nothing()`
 * would pass with the two collapsed into one fact, and the hook would then go
 * quiet for two hours after a single doc edit — the failure it exists to avoid.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { resolve } from "node:path";

import { loadHook } from "./load-hook.js";
import { runHookProgram, type AnyHook } from "./core/hook-program.js";
import { stateFact, type StateFact } from "./core/hook-state.js";

const REPO_ROOT = resolve(__dirname, "..");
const HOOK = ".vigiles/hooks/docs-drift-nudge.hook.mjs";

let hook: AnyHook;
beforeAll(async () => {
  hook = await loadHook(resolve(REPO_ROOT, HOOK));
});

const edit = (path: string, tool = "Edit") => ({
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: { file_path: resolve(REPO_ROOT, path) },
  cwd: REPO_ROOT,
});

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

const HOUR = 3600;
/** Never recorded — the state a fresh clone is in. */
const never = { "docs.followed": fact(), "docs.nudged": fact() };

/** The hook's Reaction for one edit, given one state of the world. */
function run(path: string, ctx: Record<string, StateFact> = never) {
  const out = runHookProgram(hook, edit(path), ctx);
  if (out.kind !== "reaction") throw new Error(`not a react: ${out.kind}`);
  return out.reaction;
}

describe("docs-drift-nudge — it speaks", () => {
  test("product source edited, no doc touched, never nudged", () => {
    const r = run("src/core/linters.ts");
    expect(r.kind).toBe("notice");
    if (r.kind !== "notice") return;
    // The message must name BOTH tiers — the whole ask it answers.
    expect(r.message).toContain("docs/**");
    expect(r.message).toContain("CLAUDE.md");
    // …and point at the live sources rather than restating them.
    expect(r.message).toContain("public-vs-internal-docs");
  });

  test("a STALE doc edit does not buy silence", () => {
    const r = run("src/core/linters.ts", {
      "docs.followed": fact({ value: "docs/cli.md", agoSeconds: 3 * HOUR }),
      "docs.nudged": fact(),
    });
    expect(r.kind).toBe("notice");
  });
});

describe("docs-drift-nudge — the two silences are different", () => {
  test("QUIET because docs are being edited (success)", () => {
    const r = run("src/core/linters.ts", {
      "docs.followed": fact({ value: "docs/cli.md", agoSeconds: 60 }),
      "docs.nudged": fact(),
    });
    expect(r.kind).toBe("none");
  });

  test("QUIET because it just spoke (rate limit)", () => {
    const r = run("src/core/linters.ts", {
      "docs.followed": fact(),
      "docs.nudged": fact({ value: "src/scan.ts", agoSeconds: 60 }),
    });
    expect(r.kind).toBe("none");
  });
});

describe("docs-drift-nudge — what it does not fire on", () => {
  test("a test-only edit changes no documented behaviour", () => {
    expect(run("src/core/linters.test.ts").kind).toBe("none");
  });

  test("a file outside src/", () => {
    expect(run("scripts/check.mjs").kind).toBe("none");
  });

  test.each([
    ["docs/cli.md"],
    ["README.md"],
    ["CLAUDE.md.spec.ts"],
    ["src/CLAUDE.md.spec.ts"],
    ["CONTRIBUTING.md"],
  ])("a doc edit records that docs followed, and says nothing: %s", (p) => {
    const r = run(p);
    expect(r.kind).toBe("none");
    expect(r.records.map((w) => w.name)).toContain("docs.followed");
  });
});
