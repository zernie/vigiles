/**
 * The check report `measure` / `measureArms` return — its shape, a check's
 * significance between two arms, and its console rendering. Pure: the run
 * pipeline in `src/eval.ts` builds the report, this reads it.
 */
import type { CheckJSON } from "./check.js";
import type { ArmUsage } from "./core/eval-report.js";
import { welchTTest, type Comparison } from "./stats.js";
import { proportionVerdict } from "./core/evidence.js";

/** The env `measure` / `measureArms` pass on: they have no `env` field yet. */
export const MEASURE_INHERIT_REASON =
  "measure and measureArms have no `env` field; they run with your HOME and environment (docs/safety.md)";

/**
 * One check's measured rate across the trials.
 *
 * @public
 */
export interface CheckRate {
  readonly check: CheckJSON;
  /** Fraction of trials the check passed (0..1). */
  readonly rate: number;
  /** Standard error of the rate. */
  readonly se: number;
  /** pass^k — 1 iff the check passed on EVERY trial. */
  readonly passK: number;
  /** Trials observed. */
  readonly n: number;
}

/** @public */
export interface CheckReport {
  readonly n: number;
  readonly perCheck: readonly CheckRate[];
  /** Cost / latency / token totals for the run (the same source as `runEval`). */
  readonly usage: ArmUsage;
  /**
   * The plugin namespace the skills actually installed under — the `<plugin>`
   * half of the `<plugin>:<skill>` id a `skill()` check matches. Undefined when
   * the run installed nothing (no `pluginDir` / `skillsDir`). Reported because
   * with `skillsDir` the name is chosen by the packager, not the caller, so the
   * most common cause of a 0% `skill()` rate was a value the caller never saw.
   * Mirrors {@link TriggerRateReport.namespace}.
   */
  readonly namespace?: string;
}

/**
 * Per-arm {@link CheckReport}s — `arms[name].perCheck[i]` aligns across arms.
 *
 * @public
 */
export interface ArmsCheckReport {
  readonly arms: Record<string, CheckReport>;
}

/**
 * Welch significance on one check's rate between two arms (`arm` vs `baseline`),
 * by index in `perCheck`. So "the gated arm resolves the skill significantly more
 * than vanilla" is a verdict, not a vibe: `significant` is the disjoint-Wilson
 * verdict on the k/n pass tally, the numbers are Welch's from stats.ts.
 */
export function compareCheck(
  report: ArmsCheckReport,
  baseline: string,
  arm: string,
  checkIndex: number,
): Comparison {
  const b = report.arms[baseline]?.perCheck[checkIndex];
  const a = report.arms[arm]?.perCheck[checkIndex];
  if (!a || !b) {
    throw new Error(
      `compareCheck: unknown arm or check index (baseline="${baseline}", arm="${arm}", i=${String(checkIndex)})`,
    );
  }
  // A check passes or fails per trial, so its rate is a k/n tally: the
  // decision is the Wilson verdict, the numbers stay Welch's.
  const kind = proportionVerdict(tallyOf(a), tallyOf(b)).kind;
  return {
    ...welchTTest(
      { mean: a.rate, se: a.se, n: a.n },
      { mean: b.rate, se: b.se, n: b.n },
    ),
    significant: kind === "better" || kind === "worse",
  };
}

const tallyOf = (
  r: Readonly<CheckRate>,
): { readonly k: number; readonly n: number } => ({
  k: Math.round(r.rate * r.n),
  n: r.n,
});

/** A readable label for a check from its serialized form, e.g. `tool(Bash)`. */
export function checkLabel(json: CheckJSON): string {
  const arg = json.name ?? json.id ?? json.event ?? json.path ?? json.matcher;
  if (
    typeof arg === "string" ||
    typeof arg === "number" ||
    typeof arg === "boolean"
  ) {
    return `${json.kind}(${String(arg)})`;
  }
  return json.kind;
}

/** The report line that says a run used your real HOME and environment, and why. */
export const inheritLine = (reason: string): string =>
  `  env: inherited your HOME and environment — ${reason}`;

/**
 * Format a {@link CheckReport}: one line per check with its rate ± se and
 * pass^k, and the line saying `measure` ran with your HOME and environment
 * (it has no `env` field; `INHERITED_BY_MEASURE`).
 */
export function formatCheckReport(report: CheckReport): string {
  return [formatChecks(report), inheritLine(MEASURE_INHERIT_REASON)].join("\n");
}

/**
 * Format an {@link ArmsCheckReport}: each arm's checks under `[arm: name]`, and
 * the inherit line ONCE at the end — every arm ran the same way.
 */
export function formatArmsCheckReport(report: ArmsCheckReport): string {
  const arms = Object.entries(report.arms).map(
    ([name, arm]) => `\n[arm: ${name}]\n${formatChecks(arm)}`,
  );
  return [...arms, inheritLine(MEASURE_INHERIT_REASON)].join("\n");
}

function formatChecks(report: CheckReport): string {
  const lines = [`measured ${String(report.n)} run(s):`];
  for (const c of report.perCheck) {
    lines.push(
      `  ${(c.rate * 100).toFixed(0)}% ± ${(c.se * 100).toFixed(0)}%  ${checkLabel(c.check)}` +
        `  (pass^k ${String(c.passK)})`,
    );
  }
  // The `skill()` twin of the trigger-rate TOTAL-zero note (see
  // formatTriggerRateReport): every skill() check at 0% over real runs is far
  // more often a wiring mistake — a bare id where the namespaced one is matched,
  // `pluginDir` handed a loose dir, an empty cwd — than a finding, and it reads
  // exactly like a finding. Only when EVERY skill check is at zero: a partial rate
  // is a real measurement, and a note that hedges on good data gets ignored.
  const skillChecks = report.perCheck.filter((c) => c.check.kind === "skill");
  if (
    report.n > 0 &&
    skillChecks.length > 0 &&
    skillChecks.every((c) => c.rate === 0)
  )
    lines.push(
      "⚠ nothing resolved for ANY skill() check. That is usually SETUP, not the skill — check, in order:\n" +
        (report.namespace !== undefined
          ? "  1. the id in `check.skill()` — your skills installed under " +
            `\`${report.namespace}\`, so \`check.skill()\` matches ` +
            `\`${report.namespace}:<skill>\`; a bare name silently never matches;\n`
          : "  1. the id in `check.skill()` — it matches the NAMESPACED id " +
            "(`<plugin>:<skill>`); a bare name silently never matches;\n") +
        "  2. the install field — a loose `.claude/skills` dir needs `skillsDir`, " +
        "not `pluginDir` (which wants a full plugin manifest);\n" +
        "  3. the `fixture` — a run starts in an EMPTY cwd, so a prompt about a " +
        "file that does not exist is one the model is right to decline.\n" +
        "  Rule out all three before recording this as a fact about the skill.",
    );
  return lines.join("\n");
}
