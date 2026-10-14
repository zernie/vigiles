/**
 * The rule GROUPS — keyed by CONFIDENCE, so a rule's group says how far its
 * findings may be trusted, and everything a group means is a field here:
 * whether it is graded, the preset that turns it up, what `init` writes for it,
 * and how a report heads it. A rule's membership is its own `group` field
 * (`./index.ts`, `./<id>.ts`); every list of a group's rules is derived from
 * that. Core reads only the `RuleGroupSpec` fields and never a group's name.
 *
 * The four groups and why (`docs/contributing/rules.md#install-enforcement-model`):
 *
 * - `structural` — FP-safe structural defects: each fires only on a genuine
 *   defect (a typo'd tool or hook event, a missing file a compiled hook needs, a
 *   broken MCP reference). `vigiles:recommended` gates them at `error`, and
 *   `init` writes that preset into `extends`. Raising a rule into this group
 *   can turn a consumer's CI red, so it is a semver major.
 * - `workflow` — work you have not done yet (a test per surface). Opt-in:
 *   `init --strict` writes its on-by-default rules at `error`.
 * - `nudge` — recommendations and acknowledged-noisy checks that never gate.
 * - `experimental` — shipped, but measured below the precision a graded check
 *   must clear. Off by default, NEVER in the audit score, on at `warn` through
 *   `vigiles:experimental` (config `extends` or `--preset=experimental`).
 */
import type { RuleGroupSpec } from "../core/rule.js";

export const RULE_GROUPS = {
  structural: {
    graded: true,
    label: "Structural",
    preset: { name: "vigiles:recommended", severity: "error" },
    init: "extends",
  },
  workflow: {
    graded: true,
    label: "Workflow",
    init: "--strict",
  },
  nudge: {
    graded: true,
    label: "Nudge",
  },
  experimental: {
    graded: false,
    label: "Experimental — not graded",
    blurb:
      "Checks vigiles ships but has not measured as reliable enough to grade you on. They never move the score.",
    preset: { name: "vigiles:experimental", severity: "warn" },
  },
} as const satisfies Readonly<Record<string, RuleGroupSpec>>;

/** A group's name — a key of {@link RULE_GROUPS}. */
export type RuleGroupName = keyof typeof RULE_GROUPS;
