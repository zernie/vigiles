/**
 * Structural-health SCORING core — extracted as a NODE-FREE leaf.
 *
 * The scoring functions (`scoreReport`/`reportDeductions`/`computeIntegrityScore`/
 * `gradeFor` + the penalty weights) are pure: they take a {@link ScanReport} and
 * return numbers/labels, touching no filesystem. They lived in `leaderboard.ts`,
 * but that module ALSO holds the node-only `rankPlugins`/`pluginLabel` (which call
 * `scanPlugin` + `node:fs`), so importing ANY symbol from it eagerly pulled the
 * whole `scan.ts` → `@ast-grep/napi` (a native binary) + `node:fs` chain into the
 * graph — tainting `buildAuditReport` and blocking the in-browser audit engine
 * (`scanFiles` is node-free, but the report BUILDER re-tainted it via
 * audit-score/optimize/audit-verdict → leaderboard → scan).
 *
 * Splitting the pure core out here — exactly like `core/ncd.ts` was extracted from
 * `proofs.ts` to keep `node:crypto` out of the browser graph — lets the report
 * builder import scoring WITHOUT the node-only leaderboard code. `leaderboard.ts`
 * re-exports these for its own consumers (rankPlugins/formatters), so nothing that
 * imported them from `./leaderboard.js` breaks. The `ScanReport` import is
 * TYPE-ONLY (elided at build), so no runtime `scan.ts` dependency enters this leaf.
 * See src/scan-files.ts (BROWSER_ROOT) and research/report-view-and-browser-demo.md.
 */
import type { ScanReport } from "./scan.js";

export interface PluginScore {
  readonly dir: string;
  readonly name: string;
  /** 0–100 structural-health score (100 = no structural issues found). */
  readonly score: number;
  readonly grade: "A" | "B" | "C" | "D" | "F";
  /** Human-readable deductions, worst first. */
  readonly issues: readonly string[];
  readonly report: ScanReport;
}

// Penalty weights — broken-at-runtime costs most, footguns less, nudges least.
// Exported so the category view (audit-score.ts) reuses the SAME weights and the
// two surfaces can never drift on a per-item cost.
export const W_MISSING_HOOK = 15; // a hook script that doesn't exist → never runs
export const W_NO_DESCRIPTION = 10; // a skill with no usable description → can't trigger
export const W_DANGLING_REF = 8; // a referenced intra-plugin file that's missing → broken path
export const W_OVERLAP = 8; // a description collision → the wrong skill fires
export const W_NO_CONTRACT = 5; // generic small-footgun weight (disallowedTools typo, invalid model/color)
export const W_TRIFECTA = 10; // per-unit cost of a lethal-trifecta unit (all three legs, explicit OR inherited) → a prompt-injection exfil path. HALF the old 20: a DING, not a fail — a trifecta is a real risk worth surfacing in the grade, but official plugins ship the pattern by design, so it dents the score (e.g. feature-dev's 3-of-3 hard units → −30 → C) without a catastrophic F.
/**
 * CAP on the TOTAL lethal-trifecta penalty, charged against the SHARE of the
 * model-invocable surface that holds the trifecta (see {@link trifectaExposure}).
 * A pure per-unit count saturates the clamp on any sizeable harness — which is
 * how the old model reported a HARDENED harness as strictly worse than its
 * unhardened self. Same value as the `feature-dev` anchor (3-of-3 units → −30),
 * so a fully-exposed harness still lands on a C-band ding, never an automatic F.
 */
export const W_TRIFECTA_MAX = 30;
/**
 * The one canonical, jargon-free finding string for a HARD lethal-trifecta unit —
 * shared by the Safety category card (audit-score) AND the verdict sentence / overall
 * deduction (reportDeductions here), so the plain-language copy can't drift between
 * surfaces (one-detector-no-drift). It NAMES the three legs and the consequence in
 * plain words instead of the old "holding all three lethal-trifecta legs
 * (prompt-injection exfil path)" shorthand a first-time reader can't parse. The
 * `(s)` placeholder is resolved by the caller's pluralizer against the count.
 */
export const TRIFECTA_LABEL =
  'unit(s) can read data, reach the web, and run commands — the "lethal trifecta", so a prompt injection could exfiltrate secrets';

// Two things are advisory, NOT graded penalties (shown, never scored — see scoreReport):
//   - untested surfaces — a hardening gap, not breakage.
//   - an agent that inherits all tools (no `tools:` line) — see reportDeductions for why.
// NB: an inherits-all TRIFECTA finding (severity "advisory") IS graded — see
// trifectaExposure. Only the tool-CONTRACT nudge above stays ungraded.

/** Map a 0–100 structural-health score to its letter grade (A ≥90 … F <60). */
export function gradeFor(score: number): PluginScore["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * The health score a report may NOT exceed while it carries a CONFIDENT BREAKAGE
 * — one point below the healthy band, so a definitively-broken harness can never
 * render as `●` / grade `A`.
 *
 * WHY a cap and not a heavier weight: the score is a SUM of deductions, so one
 * real breakage among many clean surfaces is diluted by its siblings. MEASURED
 * 2026-08-28 on a fixture (10 distinct-description skills + one agent naming a
 * never-available tool): Structure scored **92 with a `●` green dot** while
 * carrying a dead tool contract, and the grade was driven instead by the
 * lethal-trifecta pattern that {@link W_TRIFECTA} deliberately calls a ding and
 * not a fail. A weight big enough to fix that would cry wolf on a large clean
 * plugin; a cap fixes the reading without touching the arithmetic.
 *
 * The same defect, with higher stakes, is documented in an external 517-skill
 * catalog run of a different scanner: its weighted aggregate returned MEDIUM for
 * a skill carrying THREE HIGH findings, so gating on the aggregate would have
 * admitted exactly the skill the gate existed to stop. That team's conclusion —
 * judge by the worst finding, not the aggregate — is what this encodes.
 */
export const CONFIDENT_BREAKAGE_CAP = 89;

/**
 * The findings that CAP the score — each one means a surface is definitively
 * dead, not merely risky: it will silently not run, not resolve, or not register.
 *
 * ENUMERATED on purpose, never derived from "severity". Two properties decide
 * membership, and both must hold: the finding is DECIDABLE from the artifact plus
 * the world (the `structural-closed` / `external-decidable` buckets of the
 * lint-rule-calibration rule), and its consequence is BREAKAGE rather than
 * exposure. So the heuristic rings stay out by construction — a lethal-trifecta
 * unit and a description overlap are real signals but are a capability PATTERN
 * and a calibrated PROXY, and capping on either is how a gate earns the reputation
 * that gets it switched off.
 *
 * Adding a row here is a deliberate act: it makes a finding grade-capping for
 * every consumer, so it belongs only to a check whose false-positive rate is
 * already known to be ~0.
 */
export function confidentBreakages(
  r: ScanReport,
): { readonly n: number; readonly label: string }[] {
  const rows = [
    {
      n: r.hooks.filter((h) => h.status === "missing").length,
      label: "hook script missing",
    },
    { n: r.hookEventIssues.length, label: "hook on an unknown event" },
    { n: r.danglingRefs.length, label: "broken intra-plugin reference" },
    {
      n: r.agents.reduce((n, a) => n + a.toolIssues.length, 0),
      label: "unavailable agent tool",
    },
    {
      n: r.agents.reduce((n, a) => n + a.mcpToolIssues.length, 0),
      label: "agent MCP tool whose server isn't declared",
    },
    { n: r.mcpIssues.length, label: "MCP server that can't start" },
    {
      n: r.mcpHookIssues.length,
      label: "mcp_tool hook incomplete / undeclared server",
    },
    {
      n: r.skillResourceIssues.length,
      label: "skill bundled-resource ref that doesn't resolve",
    },
    {
      n: r.skillFenceIssues.length,
      label: "invisible skill (no opening `---` fence)",
    },
    {
      n: r.frontmatterIssues.length,
      label: "surface missing required frontmatter",
    },
  ];
  return rows.filter((row) => row.n > 0);
}

/**
 * Cap a health score at {@link CONFIDENT_BREAKAGE_CAP} when the report carries any
 * {@link confidentBreakages} finding. Applied to the OVERALL and to the ring that
 * owns the finding, so the headline and the breakdown cannot disagree.
 */
export function applyBreakageCap(score: number, r: ScanReport): number {
  return confidentBreakages(r).length > 0
    ? Math.min(score, CONFIDENT_BREAKAGE_CAP)
    : score;
}

/** One deduction: a count, its per-item weight, and the label if non-zero. */
export interface Deduction {
  readonly n: number;
  readonly weight: number;
  readonly label: string;
  /**
   * TOTAL penalty for this deduction, overriding the default `n × weight`. Only
   * used where the cost is not linear in the count — today that's the trifecta
   * exposure penalty, which is capped against the share of the surface affected
   * (see {@link trifectaExposure}). `n` still drives the human-readable label.
   */
  readonly points?: number;
}

/** The graded lethal-trifecta exposure of a report. */
export interface TrifectaExposure {
  /** Units holding all three legs — EXPLICIT (`hard`) and INHERITED alike. */
  readonly exposed: number;
  /** Model-invocable units that could hold them (subagents + non-user-invoked skills). */
  readonly assessable: number;
  /** The graded penalty, `min(W_TRIFECTA × exposed, W_TRIFECTA_MAX × exposed/assessable)`. */
  readonly penalty: number;
}

/**
 * The lethal-trifecta exposure a report incurs — the ONE number the Safety ring
 * and the overall grade both read.
 *
 * TWO properties this model must have, both learned the hard way from dogfooding
 * (2026-08-03, a 35-skill repo):
 *
 * 1. **MONOTONE in risk.** A unit that INHERITS all tools holds the full trifecta
 *    *implicitly* and is strictly WORSE than one whose explicit `allowed-tools`
 *    happens to name all three legs — it holds every other capability too. The old
 *    model graded the explicit case at −10 and left the inherited case UNGRADED, so
 *    declaring a tool contract (a genuine risk reduction) could only ever LOWER the
 *    score: a repo measured 70 with 31 of 35 units inheriting everything, then 0
 *    after `allowed-tools` was added to all 35 and the units holding the full
 *    trifecta fell 35/35 → 17/35. The tool called the safer configuration strictly
 *    worse and said nothing about the unsafe one. So BOTH severities count here.
 *
 * 2. **Non-saturating.** With a flat per-unit weight, 35 exposed units and 17
 *    exposed units both blow past the clamp and score 0 — halving your exposure
 *    shows up as no change at all. So the total is ALSO capped against the SHARE
 *    of the model-invocable surface that is exposed: a 35-unit harness with 3
 *    exposed units is genuinely safer than a 3-unit harness where all 3 are.
 *
 * The `min` of the two keeps every existing calibration anchor for small harnesses
 * (1 exposed unit of 1 → −10; the `feature-dev` 3-of-3 shape → −30 → C) while
 * giving a large harness real resolution (34/35 → −29, 17/35 → −15).
 */
export function trifectaExposure(r: ScanReport): TrifectaExposure {
  const exposed = r.trifectaFindings.length;
  // The assessable surface mirrors the Safety ring's own n/a rule: subagents plus
  // model-invocable skills (a user-invoked skill can't be hijacked by attacker
  // content, so it is neither exposed nor assessable). Never below the exposed
  // count — a finding always comes FROM a unit, so a report that carries findings
  // without the units (a hand-built fixture) still charges for them.
  const assessable = Math.max(
    r.agents.length + r.skills.filter((s) => !s.userInvoked).length,
    exposed,
  );
  if (exposed === 0 || assessable === 0) {
    return { exposed, assessable, penalty: 0 };
  }
  const perUnit = W_TRIFECTA * exposed;
  // Never round a real finding away to a free 0 on a very large harness.
  const share = Math.max(
    1,
    Math.round((W_TRIFECTA_MAX * exposed) / assessable),
  );
  return { exposed, assessable, penalty: Math.min(perUnit, share) };
}

/**
 * The COMPLETE graded-penalty list a report incurs — the single source of truth
 * BOTH the leaderboard's single health number and the audit's category rings
 * read, so the overall can never drift between the two surfaces. Each entry is a
 * graded penalty; untested surfaces are deliberately ABSENT (they're advisory,
 * surfaced separately, never scored).
 */
export function reportDeductions(r: ScanReport): Deduction[] {
  const missingHooks = r.hooks.filter((h) => h.status === "missing").length;
  const noDesc = r.skills.filter((s) => !s.hasDescription).length;
  const deadTools = r.agents.reduce((n, a) => n + a.toolIssues.length, 0);
  const deadMcpTools = r.agents.reduce((n, a) => n + a.mcpToolIssues.length, 0);
  const deadDisallowed = r.agents.reduce(
    (n, a) => n + a.disallowedToolIssues.length,
    0,
  );
  // Lethal-trifecta EXPOSURE — every unit holding all three legs, whether it
  // declared them (`hard`) or inherited them (an inherits-all contract holds them
  // implicitly AND everything else, so it can't be the cheaper of the two). Capped
  // against the share of the surface affected so the model stays monotone in risk
  // and doesn't saturate — see trifectaExposure for the measured failure this fixes.
  const trifecta = trifectaExposure(r);

  return [
    {
      n: trifecta.exposed,
      weight: W_TRIFECTA,
      points: trifecta.penalty,
      label: TRIFECTA_LABEL,
    },
    {
      n: missingHooks,
      weight: W_MISSING_HOOK,
      label: "hook script(s) MISSING",
    },
    {
      n: r.hookEventIssues.length,
      weight: W_MISSING_HOOK,
      label: "hook(s) on an unknown event (never fire)",
    },
    {
      n: noDesc,
      weight: W_NO_DESCRIPTION,
      label: "skill(s) with no usable description",
    },
    {
      n: r.descriptionOverlaps.length,
      weight: W_OVERLAP,
      label: "near-identical skill description(s) (wrong one fires)",
    },
    {
      n: r.danglingRefs.length,
      weight: W_DANGLING_REF,
      label: "broken intra-plugin reference(s)",
    },
    {
      n: deadTools,
      weight: W_DANGLING_REF,
      label: "unavailable agent tool(s) (typo / never-available)",
    },
    {
      n: deadMcpTools,
      weight: W_DANGLING_REF,
      label: "agent MCP tool(s) whose server isn't declared (can't resolve)",
    },
    {
      n: deadDisallowed,
      weight: W_NO_CONTRACT,
      label: "agent disallowedTools typo(s) that block nothing",
    },
    // NB: an agent that inherits all tools (no `tools:` line) is ADVISORY, not a
    // graded penalty — it's surfaced by scoreReport / the Structure ring but never
    // drags the score. WHY: omitting the `tools:` line is a near-universal,
    // legitimate authoring style (a measured OSS sweep of 122 real plugins found
    // 109 whose ONLY finding was this), so penalizing it makes the grade cry wolf
    // on idiomatic subagents. A health score should mean "something is BROKEN", and
    // a broad-by-default tool surface is a hardening/least-privilege NUDGE, not
    // breakage. The count is re-derived where the advisory note is built.
    {
      n: r.frontmatterIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "surface(s) missing required frontmatter (name/description)",
    },
    {
      n: r.frontmatterValueIssues.length,
      weight: W_NO_CONTRACT,
      label: "agent(s) with an invalid model/color (typo → silent fallback)",
    },
    {
      n: r.mcpIssues.length,
      weight: W_DANGLING_REF,
      label: "MCP server(s) that can't start (no command/url)",
    },
    {
      n: r.mcpHookIssues.length,
      weight: W_DANGLING_REF,
      label: "mcp_tool hook(s) incomplete / targeting an undeclared server",
    },
    {
      n: r.skillResourceIssues.length,
      weight: W_DANGLING_REF,
      label: "skill bundled-resource ref(s) that don't resolve on disk",
    },
    {
      n: r.skillFenceIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "invisible skill(s) (frontmatter with no opening `---` fence)",
    },
    {
      n: r.pluginLayoutIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "functional dir(s) misplaced inside `.claude-plugin/` (invisible)",
    },
    // A surface dir NO registered harness reads (#240). Same weight and label as
    // the Structure ring's row by construction — the two are kept identical on
    // purpose, so the headline and the breakdown cannot disagree about it.
    {
      n: r.unclaimedSurfaces.length,
      weight: W_NO_DESCRIPTION,
      label: "surface dir(s) no harness reads (not in this grade)",
    },
    {
      n: r.hookBlockFindings.length,
      weight: W_MISSING_HOOK,
      label: "hook(s) that look like they block but silently don't",
    },
    {
      n: r.hookMatcherFindings.length,
      weight: W_MISSING_HOOK,
      label:
        "hook matcher(s) that don't fire as written (dead, or too narrow for real MCP names)",
    },
    // NB: delegationTrifecta (like the advisory per-unit/inherits-all trifecta) is a
    // ⚠ RISK, surfaced but NOT graded — only the HARD per-unit trifecta above scores.
    // NB: untested surfaces are NOT a penalty — an untested surface is a hardening
    // gap, not breakage, so it never drags the health score (it's appended as an
    // advisory note below). The score ranks what's BROKEN.
  ];
}

/**
 * True when a report has no loadable plugin surface at all (the empty machine).
 *
 * 🔴 THE ONE PLACE the surface set is enumerated, and every scorer must ask it
 * rather than write the list again. `scoreReport` used to keep its own copy and
 * that copy had dropped `inlineHooks` — so a plugin whose entire contribution is
 * hooks declared inline in `plugin.json` scored 0 / F with "no loadable plugin
 * surface" while the same report printed `inlineHooks: 2` (#199). Measured on a
 * two-inline-hook fixture: this predicate said `false` and `scoreReport` said
 * `0`, against `auditScore`'s `100` — a 100-point disagreement between two
 * numbers documented to be equal.
 *
 * A hooks-only plugin is a legitimate shape, the same way a command-only or
 * MCP-only one is: a repo can ship gates and nothing else. Zero has to mean "no
 * surface of any kind", because it reads as "this plugin is broken" — a
 * different statement from "this plugin has no skills or subagents".
 *
 * Hooks count in BOTH forms: `hooks[]` is the script-backed ones, `inlineHooks`
 * the shell one-liners that carry no script file to path-check. The second is
 * still a gate that runs.
 */
export function isEmptyMachine(r: ScanReport): boolean {
  const surfaces =
    r.skills.length +
    r.agents.length +
    r.hooks.length +
    r.inlineHooks +
    r.commands;
  return surfaces === 0 && !r.mcp;
}

/**
 * THE shared integrity score — `100 − Σ(all graded penalties)`, clamped to
 * [0,100]. Both the leaderboard's single health number AND the audit's headline
 * overall read this, so the two can never disagree (the summed model is the
 * honest one — averaging rings would dilute a real problem). Returns the score
 * plus the per-item deductions so callers render their own issue/finding lists.
 */
export function computeIntegrityScore(deductions: readonly Deduction[]): {
  score: number;
  penalty: number;
} {
  let penalty = 0;
  for (const d of deductions) {
    if (d.n <= 0) continue;
    penalty += d.points ?? d.n * d.weight;
  }
  return { score: Math.max(0, 100 - penalty), penalty };
}

/** Resolve the terse "thing(s)" plural placeholder against a count:
 * n===1 drops the "(s)" ("1 tool"); otherwise it becomes "s" ("3 tools").
 * (Kept local — audit-score.ts has its own copy to avoid a circular import.) */
function pluralizeLabel(n: number, label: string): string {
  return label.replace(/\(s\)/g, n === 1 ? "" : "s");
}

/** Deterministic structural-health score for one scanned plugin. */
export function scoreReport(r: ScanReport): {
  score: number;
  issues: string[];
} {
  // An empty/unloadable machine isn't healthy — it's a non-plugin or a broken
  // load. A command-only, MCP-only or HOOKS-only plugin IS a legitimate plugin,
  // though — Anthropic ships command-only plugins in its own marketplace, and a
  // repo can reasonably ship gates and nothing else — so none of them scores 0.
  //
  // 🔴 Asked of `isEmptyMachine`, never re-enumerated here. The hand-written copy
  // that used to sit on this line had dropped `inlineHooks`, so a hooks-only
  // plugin scored 0 while `auditScore` — which does ask the predicate — scored the
  // same report 100 (#199). Two lists mean two answers.
  if (isEmptyMachine(r)) {
    return { score: 0, issues: ["no loadable plugin surface"] };
  }

  const deductions = reportDeductions(r);
  const { score: summed } = computeIntegrityScore(deductions);
  // A confident breakage caps the score — a summed model dilutes one real
  // breakage among clean siblings. See applyBreakageCap for the measurement.
  const score = applyBreakageCap(summed, r);

  const issues: string[] = [];
  for (const d of deductions) {
    if (d.n === 0) continue;
    issues.push(`${String(d.n)} ${pluralizeLabel(d.n, d.label)}`);
  }
  // Sort issues by cost (worst first) so the report leads with what matters.
  issues.sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0]));
  // Advisory notes are surfaced for visibility but DON'T affect the score, so they
  // come AFTER the real (score-affecting) issues:
  //   - inherit-all (no tool contract): a least-privilege NUDGE, not breakage —
  //     see reportDeductions for the full rationale.
  //   - untested surfaces: a hardening gap, not breakage.
  const noContract = r.agents.filter((a) => a.tools === null).length;
  if (noContract > 0) {
    issues.push(
      `${String(noContract)} ${pluralizeLabel(noContract, "agent(s) inherit all tools (no contract) (advisory)")}`,
    );
  }
  if (r.untested > 0) {
    issues.push(
      `${String(r.untested)} ${pluralizeLabel(r.untested, "untested surface(s) (advisory)")}`,
    );
  }
  return { score, issues };
}
