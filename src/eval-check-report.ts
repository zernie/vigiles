/**
 * The checks of an eval report — how a run scored with `checks` names its
 * metrics, and what the report says about them. Pure: the run pipeline in
 * `src/eval.ts` builds the report, this reads it.
 *
 * A run scored with `checks` returns the same `EvalReport` as one scored with
 * `measure(ctx)`: each check is one 0/1 metric keyed by its label, and
 * `EvalReport.checks` maps each key back to the check. So every reader
 * (`compare`, `assertImproves`, `assertRates`, `assertNoRegression`) takes it.
 */
import type { ArmReport, CheckJSON } from "./core/eval-report.js";

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

/**
 * Each check under the metric key its report uses: its label, with ` #2`, ` #3`
 * appended to a label already taken — two `output(…)` checks over different
 * text can share one, and a report keyed by label must not merge them.
 */
export function checkMetricKeys<C extends { toJSON(): CheckJSON }>(
  checks: readonly C[],
): readonly (readonly [string, C])[] {
  const labels = checks.map((c) => checkLabel(c.toJSON()));
  return checks.map((c, i) => {
    const label = labels[i] ?? "";
    const nth = labels.slice(0, i).filter((l) => l === label).length + 1;
    return [nth === 1 ? label : `${label} #${String(nth)}`, c] as const;
  });
}

/** The report line that says a run used your real HOME and environment, and why. */
export const inheritLine = (reason: string): string =>
  `  env: inherited your HOME and environment — ${reason}`;

/**
 * The note printed under an arm whose every `skill()` check scored 0% over
 * real runs, or undefined. That is far more often a wiring mistake — a bare id
 * where the namespaced one is matched, `pluginDir` handed a loose dir, an empty
 * cwd — than a finding, and it reads exactly like a finding. Only when EVERY
 * skill check is at zero: a partial rate is a real measurement, and a note
 * that hedges on good data gets ignored. The `skill()` twin of the trigger-rate
 * TOTAL-zero note (`formatTriggerRateReport`).
 */
export function skillZeroNote(
  arm: ArmReport,
  checks: Readonly<Record<string, CheckJSON>>,
): string | undefined {
  const skillKeys = Object.keys(checks).filter(
    (k) => checks[k]?.kind === "skill",
  );
  const allZero = skillKeys.every((k) => (arm.metrics[k] ?? 0) === 0);
  if (arm.runs === 0 || skillKeys.length === 0 || !allZero) return undefined;
  return (
    "⚠ nothing resolved for ANY skill() check. That is usually SETUP, not the skill — check, in order:\n" +
    namespaceAdvice(arm.namespace) +
    "  2. the install field — a loose `.claude/skills` dir needs `skillsDir`, " +
    "not `pluginDir` (which wants a full plugin manifest);\n" +
    "  3. the `fixture` — a run starts in an EMPTY cwd, so a prompt about a " +
    "file that does not exist is one the model is right to decline.\n" +
    "  Rule out all three before recording this as a fact about the skill."
  );
}

function namespaceAdvice(namespace: string | undefined): string {
  return namespace !== undefined
    ? "  1. the id in `check.skill()` — your skills installed under " +
        `\`${namespace}\`, so \`check.skill()\` matches ` +
        `\`${namespace}:<skill>\`; a bare name silently never matches;\n`
    : "  1. the id in `check.skill()` — it matches the NAMESPACED id " +
        "(`<plugin>:<skill>`); a bare name silently never matches;\n";
}
