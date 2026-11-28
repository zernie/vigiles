/**
 * Console rendering of an eval report and a trigger-rate report. Pure: the run
 * pipeline in `src/eval.ts` produces the reports, `vigiles eval` prints them
 * through these.
 */
import type {
  ArmReport,
  ArmUsage,
  CaseArmResult,
  CaseResult,
  EvalReport,
  MetricStat,
  TriggerRateReport,
} from "./core/eval-report.js";
import { describeVerdict } from "./core/evidence.js";
import { experimental_verdict } from "./stats.js";
import { contextSummaryLines } from "./core/context-evidence.js";
import { inheritLine, skillZeroNote } from "./eval-check-report.js";

/** Render one metric: `name=mean±se pass^k=…` (se/pass^k shown when measured). */
function formatMetric(
  name: string,
  mean: number,
  stat: MetricStat | undefined,
): string {
  const base =
    stat && stat.se > 0
      ? `${name}=${mean.toFixed(2)}±${stat.se.toFixed(2)}`
      : `${name}=${mean.toFixed(2)}`;
  return stat && stat.n > 0 ? `${base} pass^k=${String(stat.passK)}` : base;
}

/** Compact tokens like `3.4k`; whole numbers under 1000 stay as-is. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A `($0.0123 · 1.2s/run · 3.4k tok)` suffix, or "" when no usage was reported. */
function formatUsage(u: ArmUsage): string {
  if (u.totalCostUsd === 0 && u.totalInputTokens + u.totalOutputTokens === 0) {
    return "";
  }
  const tok = fmtTokens(u.totalInputTokens + u.totalOutputTokens);
  return `  ($${u.totalCostUsd.toFixed(4)} · ${(u.meanDurationMs / 1000).toFixed(1)}s/run · ${tok} tok)`;
}

/** One `verdict` line per arm × metric against `baseline`; none without one. */
function verdictLines(
  report: EvalReport,
  baseline: string | undefined,
): readonly string[] {
  const base = baseline === undefined ? undefined : report.arms[baseline];
  if (baseline === undefined || base === undefined) return [];
  return Object.entries(report.arms)
    .filter(([arm]) => arm !== baseline)
    .flatMap(([arm, r]) =>
      Object.keys(r.stats).map(
        (metric) =>
          `  verdict    ${arm} vs ${baseline} on ${metric}: ${describeVerdict(experimental_verdict(report, baseline, arm, metric))}`,
      ),
    );
}

/**
 * Format an eval report as a compact table for the console (mean ± se, pass^k).
 * Name the `baseline` arm to add one verdict line per other arm and metric —
 * `BETTER` / `WORSE` / `NO SIGNAL`, the same verdict `compare` reads.
 */
/**
 * The header's cost: the reported total, and — when a run reported none (killed
 * by the timeout) — what was charged against the budget for it, named as a
 * charge: a killed run's cap is the most it could have spent, not what it did
 * spend, so it is never printed as a floor on spend (vigiles#416).
 */
function costLabel(report: EvalReport): string {
  const unknown = report.unknownCostRuns ?? 0;
  const usd = (n: number): string => `$${n.toFixed(4)}`;
  if (unknown === 0)
    return report.totalCostUsd > 0 ? `${usd(report.totalCostUsd)} total` : "";
  const runs = `${String(unknown)} run(s) reported no cost`;
  const charged = report.chargedUsd ?? report.totalCostUsd;
  const reported =
    report.totalCostUsd > 0 ? `${usd(report.totalCostUsd)} reported, ` : "";
  return charged > report.totalCostUsd
    ? `${reported}${usd(charged)} charged to the budget (${runs})`
    : `${reported}${runs}`;
}

/** The every-`skill()`-check-at-0% note under an arm of a `checks` run, if due. */
function skillZeroLines(
  report: EvalReport,
  name: string,
  arm: ArmReport,
): readonly string[] {
  const note =
    report.checks === undefined ? undefined : skillZeroNote(arm, report.checks);
  return note === undefined ? [] : [`  ${name}: ${note}`];
}

export function formatEvalReport(
  report: EvalReport,
  opts: { readonly baseline?: string } = {},
): string {
  const head = `${report.name} (${String(report.trials)} trials/arm)`;
  const cost = costLabel(report);
  const lines = [cost === "" ? head : `${head} — ${cost}`];
  for (const [arm, r] of Object.entries(report.arms)) {
    const parts = Object.entries(r.metrics)
      .map(([k, v]) => formatMetric(k, v, r.stats[k]))
      .join("  ");
    lines.push(
      `  ${arm.padEnd(10)} ${parts}${formatUsage(r.usage)}`,
      ...contextSummaryLines(r.context ?? []).map(
        (line) => `  ${arm.padEnd(10)} ${line}`,
      ),
      ...skillZeroLines(report, arm, r),
    );
    // One line: the calls themselves are printed once, by `runEval`
    // (`unansweredInReport`), not again under every arm of the table.
    if (r.unansweredStubCalls.length > 0)
      lines.push(
        `  ⚠ ${arm}: ${String(r.unansweredStubCalls.length)} stub call(s) went unanswered — the report is not a measurement`,
      );
  }
  return [
    ...lines,
    ...(report.experimental_regressionCases ?? []).map(caseLine),
    ...verdictLines(report, opts.baseline),
    ...inheritLines(report.env),
  ].join("\n");
}

/** The line an `inherit: "all"` run's report ends with; none for a throwaway HOME. */
function inheritLines(env: EvalReport["env"]): readonly string[] {
  return env?.kind === "local" && env.inherit === "all"
    ? [inheritLine(env.reason)]
    : [];
}

/** One line per regression case: its id, the head it ran at, and each arm's solved count. */
function caseLine(c: CaseResult): string {
  const arms = Object.entries(c.arms).map(([arm, r]) => caseArm(arm, r));
  return `  case ${c.id} @ ${c.head.slice(0, 7)}  ${arms.join("  ")}`;
}

/** `arm solved/scored solved`, plus the trials left unscored when there are any. */
function caseArm(arm: string, r: CaseArmResult): string {
  const solved = `${arm} ${String(r.solved)}/${String(r.scored)} solved`;
  return r.unscored === 0
    ? solved
    : `${solved}, ${String(r.unscored)} unscored`;
}

/** Format a trigger-rate report: overall %, then each prompt's rate. */
export function formatTriggerRateReport(report: TriggerRateReport): string {
  const pct = (report.rate * 100).toFixed(0);
  const lines: string[] = [];
  if (report.experimental) {
    lines.push(`⚠ EXPERIMENTAL — ${report.experimental}`);
  }
  lines.push(`trigger-rate: ${pct}% (${String(report.n)} runs)`);
  for (const p of report.perPrompt) {
    lines.push(`  ${p.rate.toFixed(2)}  ${p.prompt.slice(0, 60)}`);
  }
  if (report.falsePositiveRate !== undefined) {
    const fpr = (report.falsePositiveRate * 100).toFixed(0);
    const prec =
      report.precision === undefined
        ? "n/a"
        : `${(report.precision * 100).toFixed(0)}%`;
    lines.push(`false-positive: ${fpr}%  precision: ${prec}`);
    for (const p of report.perIrrelevant ?? []) {
      lines.push(
        `  ${p.rate.toFixed(2)}  [irrelevant] ${p.prompt.slice(0, 48)}`,
      );
    }
  }
  // Honest labelling: an isolated run measures the skill alone, with no competing
  // skills to evict or out-compete its description — so recall is an UPPER bound
  // and false-positive a LOWER bound. Say so, or point at the whole-harness count.
  lines.push(
    report.competitors > 0
      ? `whole-harness: measured against ${String(report.competitors)} competing skill(s)`
      : "isolated: no competing skills — recall is an upper bound, false-positive a lower bound (populate `installSet` for a release-gate measurement)",
  );
  // A TOTAL zero is far more often a wiring mistake than a finding, and it does
  // not look like one: the report is well-formed, the runs executed, and every
  // line reads 0.00 — which parses as "this description never fires". Measured
  // the hard way while building a consumer's trigger suite (2026-08-11): three
  // separate setup errors each produced a confident, plausible 0%, and two of
  // them were briefly written up as findings about the skills before being
  // caught. So when nothing fired at all, say what usually causes that.
  //
  // Deliberately only on the TOTAL zero. A partial rate is a real measurement and
  // must not be second-guessed; a checker that hedges on good data gets ignored.
  if (report.n > 0 && report.rate === 0)
    lines.push(
      "⚠ nothing fired on ANY prompt. That is usually SETUP, not the description — check, in order:\n" +
        // The runtime RESOLVED the namespace before spending a token, so it
        // prints the id that should have matched instead of telling the reader
        // to go work it out. With `skillsDir` the name is not even the user's
        // choice — the packager picks it — so "check the id" was advice about a
        // value they had never seen.
        (report.namespace !== undefined
          ? "  1. the id in `fired` — your skills installed under " +
            `\`${report.namespace}\`, so \`check.skill\` matches ` +
            `\`${report.namespace}:<skill>\`; a bare name silently never matches;\n`
          : "  1. the id in `fired` — `check.skill` matches the NAMESPACED id " +
            "(`<plugin>:<skill>`); a bare name silently never matches;\n") +
        "  2. the install field — a loose `.claude/skills` dir needs `skillsDir`, " +
        "not `pluginDir` (which wants a full plugin manifest);\n" +
        "  3. the `fixture` — a run starts in an EMPTY cwd, so a prompt about a " +
        "file that does not exist is one the model is right to decline.\n" +
        "  Rule out all three before recording this as a fact about the skill.",
    );
  return lines.join("\n");
}
