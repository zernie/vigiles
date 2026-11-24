/**
 * `hook-stamp-matches` — a compiled hook's source was edited after `vigiles
 * compile` stamped it, and was not recompiled. At run time the stamp no longer
 * matches: a tool gate refuses every call it sees, and any other hook (an
 * inject, a react, a prompt or stop gate) is skipped with a warning — either way
 * the hook no longer does what was compiled.
 *
 * WHY IT GATES CI: the runtime is the wrong place to find this out. Observed
 * 2026-11: an `inject` hook on `UserPromptSubmit` was edited without a
 * recompile, the runtime of the day exited 2 on every prompt, and `lint` stayed
 * green because nothing compared a hook to its stamp. The runtime no longer
 * blocks a prompt on it; this rule makes sure the mismatch never reaches one.
 *
 * The DETECTOR is core's `staleHookStamps` — the same `checkHookStamp` the
 * runtime runs, so `lint`, `audit` and the runtime cannot disagree on "stale"
 * (`one-detector-no-drift`). `external-decidable`: a SHA-256 of a file against
 * the one recorded beside it, no heuristic. In `structural` at `error`.
 * See docs/rules/hook-stamp-matches.md.
 */
import { defineRule, type Finding, type ScanInput } from "../core/rule.js";
import { stampFixCommand } from "../core/hook-stamp.js";

/** One finding per stale hook, at the source the author edited. */
function findings(scan: ScanInput): readonly Finding[] {
  return scan.hookStampIssues.map(
    (issue): Finding => ({
      kind: "finding",
      path: issue.source,
      subject: issue.source,
      message:
        `edited after it was compiled — it no longer matches its stamp in ${issue.sidecar}, ` +
        `so the runtime refuses it as a tool gate and skips it otherwise. ` +
        `Fix: run \`${stampFixCommand(issue.source)}\`.`,
    }),
  );
}

export const hookStampMatches = defineRule({
  id: "hook-stamp-matches",
  group: "structural",
  bucket: "external-decidable",
  surface: ["hook"],
  defaultSeverity: "error",
  cure: { cli: "compile" },
  summary:
    "A compiled hook's source still matches the stamp `compile` recorded for it.",
  detector: "staleHookStamps",
  upstreamPrevention: "compile stamps the hook; this catches later edits",
  scored: {
    narrow: (scan, firesAt) => ({
      hookStampIssues: scan.hookStampIssues.filter((issue) =>
        firesAt(issue.source),
      ),
    }),
  },
  findings,
});
