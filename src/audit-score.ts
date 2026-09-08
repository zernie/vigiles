/**
 * Category scoring for `vigiles audit` — the Lighthouse rings.
 *
 * A single structural-health number (the leaderboard's `scoreReport`) ranks
 * plugins, but it hides WHERE a harness is weak. This buckets the SAME
 * deterministic findings into six categories — Truthfulness, Triggering,
 * Structure, Safety, Tested, Evaluated — each a 0–100 ring, as a DIAGNOSTIC breakdown
 * beneath one headline `overall` = `100 − Σ(all graded penalties)` (the SAME
 * summed model as the leaderboard's single health number, via the shared
 * `computeIntegrityScore` — so the two surfaces never disagree). Same detectors,
 * no re-detection (one-detector-no-drift); all deterministic, no execution.
 *
 * SAFETY is fed by the STATIC lethal-trifecta capability check
 * (`lethalTrifectaIssues` → `report.trifectaFindings`): a unit holding all three
 * capability legs is a prompt-injection exfil path detectable from the tool-SET
 * alone — nothing executes, so it sidesteps the confinement blocker. A `"hard"`
 * (explicit all-three) finding AND an `"advisory"` (inherits-all) one are BOTH
 * graded — an inherited contract holds the three legs implicitly and every other
 * capability besides, so grading only the explicit case made hardening LOWER the
 * score. The cost is capped against the SHARE of the surface exposed
 * (`W_TRIFECTA=10` per unit, `W_TRIFECTA_MAX=30` total — a DING, not a fail: it
 * dents the grade without a catastrophic F for a pattern official plugins ship by
 * design). NB the EXECUTING
 * "do your hooks actually block?" disaster-battery is STILL not an `audit` ring:
 * running arbitrary hooks safely needs cross-platform confinement that isn't
 * shipped yet, so the battery lives in the `vigiles` testing API via
 * `guardrail-check`/`assertBlocksDisasters`, where you opt in explicitly.
 *
 * TESTED vs EVALUATED are two rings, not one, because a harness and an eval differ
 * on COST (free vs paid model calls), on CADENCE (every push vs scheduled) and on
 * the QUESTION ANSWERED (does this gate still catch what it claims? vs does this
 * skill fire at all?). Folded together, a repo with complete deterministic coverage
 * and no evals scored identically to a repo with neither.
 *
 * A category that can't be assessed scores `null` (n/a) and is EXCLUDED from the
 * overall — never a false 0. `Evaluated` adds a THIRD state on top of that
 * (`notMeasured`): the run never asked the firing question, which is not the same
 * fact as "asked and got zero". Pure over the `ScanReport`, so it's fully testable.
 */
import {
  gradeFor,
  applyBreakageCap,
  CONFIDENT_BREAKAGE_CAP,
  computeIntegrityScore,
  reportDeductions,
  isEmptyMachine,
  W_MISSING_HOOK,
  W_NO_DESCRIPTION,
  W_DANGLING_REF,
  W_OVERLAP,
  W_NO_CONTRACT,
  TRIFECTA_LABEL,
  trifectaExposure,
  type PluginScore,
} from "./score-core.js";
import type { ScanReport } from "./scan.js";

export type CategoryKey =
  | "Truthfulness"
  | "Triggering"
  | "Structure"
  | "Safety"
  | "Tested"
  | "Evaluated";

export interface CategoryScore {
  readonly key: CategoryKey;
  /** 0–100, or `null` when the category isn't assessable (n/a — excluded from overall). */
  readonly score: number | null;
  /** Relative weight in the overall (equal by default — tune later). */
  readonly weight: number;
  /**
   * `score: null` because this run never ASKED the question — as distinct from
   * `null` because there was nothing to ask about (plain n/a) and from a measured
   * `0`. Reporting the absence of a check as the result of a check is exactly what
   * this tool flags in other people's harnesses; the `Evaluated` ring would do it
   * if a headless read scored 0 for "no firing measured". A `notMeasured` ring
   * carries a finding NAMING the command that would measure it.
   */
  readonly notMeasured?: boolean;
  /**
   * Advisory categories are shown but EXCLUDED from the overall grade. An untested
   * surface (or any best-practice gap) is a HARDENING signal, not a broken harness
   * — it must never drag the grade down, so `audit` doesn't read as F on a clean
   * repo that simply hasn't written tests yet. The grade reflects what's BROKEN.
   */
  readonly advisory?: boolean;
  /** Human-readable deductions / notes, worst first; empty when clean. */
  readonly findings: readonly string[];
}

export interface AuditScore {
  /**
   * The headline score — `100 − Σ(all graded penalties)`, clamped to [0,100]
   * (the SAME summed model as the leaderboard's single health number, computed by
   * the shared {@link computeIntegrityScore}, so the two surfaces never disagree).
   * The per-category rings below are a DIAGNOSTIC breakdown, not the headline: a
   * plugin whose only issue is Structure −30 shows Structure 70 in the breakdown
   * AND overall 70 (averaging the rings would dilute that to ~90). 0 when empty.
   */
  readonly overall: number;
  readonly grade: PluginScore["grade"];
  readonly categories: readonly CategoryScore[];
  /** No loadable surface at all — overall 0, every category n/a. */
  readonly empty: boolean;
}

// Per-item penalties are the SHARED leaderboard weights (imported above) so the
// category rings and the single health number can never drift. W_UNTESTED is
// audit-only — untested surfaces are advisory (shown, never scored into overall).
const W_UNTESTED = 3;

/** The command that answers the firing question — named, not alluded to. */
const MEASURE_FIRING_COMMAND =
  "run `npx vigiles audit` interactively to measure, or add a `*.eval.mjs` " +
  "(`export default defineEval({ measureTriggerRate: … })`, vigiles)";

export interface AuditScoreOptions {
  /**
   * Did THIS run actually execute the skill-firing tier? A plain `audit` is a
   * deterministic read: headless (`--json`, `--no-interactive`, a pipe) it never
   * runs the executing checks and prints "Executing checks (safety battery · live
   * MCP · skill firing) skipped". That skip is a real signal and it is threaded
   * here, so the `Evaluated` ring can say "not measured" instead of scoring a 0 it
   * did not earn. Default false — the honest default for a pure read.
   */
  readonly firingMeasured?: boolean;
}

/** One deduction: a count, its per-item weight, and the label if non-zero. */
interface Deduction {
  readonly n: number;
  readonly weight: number;
  readonly label: string;
}

/** Resolve the terse "thing(s)" plural placeholder against a count:
 * n===1 drops the "(s)" ("1 tool"); otherwise it becomes "s" ("3 tools"). */
function pluralizeLabel(n: number, label: string): string {
  return label.replace(/\(s\)/g, n === 1 ? "" : "s");
}

/** Apply deductions to a 100 base, clamped to [0,100], collecting non-zero labels. */
function scoreFrom(deductions: readonly Deduction[]): {
  score: number;
  findings: string[];
} {
  let penalty = 0;
  const findings: { n: number; text: string }[] = [];
  for (const d of deductions) {
    if (d.n <= 0) continue;
    penalty += d.n * d.weight;
    findings.push({
      n: d.n,
      text: `${String(d.n)} ${pluralizeLabel(d.n, d.label)}`,
    });
  }
  findings.sort((a, b) => b.n - a.n);
  return {
    score: Math.max(0, 100 - penalty),
    findings: findings.map((f) => f.text),
  };
}

function truthfulness(r: ScanReport): CategoryScore {
  const missingHooks = r.hooks.filter((h) => h.status === "missing").length;
  const { score, findings } = scoreFrom([
    {
      n: r.danglingRefs.length,
      weight: W_DANGLING_REF,
      label: "broken intra-plugin reference(s)",
    },
    {
      // Same weight and same category as the path-shaped one above: both are a
      // reference that resolves to nothing. Counted separately only because the
      // labels must read differently — "a path that isn't there" and "a skill
      // that isn't there" send the reader to different fixes.
      n: r.skillRefIssues?.length ?? 0,
      weight: W_DANGLING_REF,
      label: "skill(s) naming a sibling skill that does not exist",
    },
    {
      n: missingHooks,
      weight: W_MISSING_HOOK,
      label: "hook script(s) missing (never run)",
    },
  ]);
  return { key: "Truthfulness", score, weight: 1, findings };
}

function triggering(r: ScanReport): CategoryScore {
  const noDesc = r.skills.filter((s) => !s.hasDescription).length;
  const { score, findings } = scoreFrom([
    {
      n: noDesc,
      weight: W_NO_DESCRIPTION,
      label: "skill(s) with no usable description (can't trigger)",
    },
    {
      n: r.descriptionOverlaps.length,
      weight: W_OVERLAP,
      label: "near-identical skill description(s) (wrong one fires)",
    },
  ]);
  return { key: "Triggering", score, weight: 1, findings };
}

function structure(r: ScanReport): CategoryScore {
  const noContract = r.agents.filter((a) => a.tools === null).length;
  const deadTools = r.agents.reduce((n, a) => n + a.toolIssues.length, 0);
  const deadMcpTools = r.agents.reduce((n, a) => n + a.mcpToolIssues.length, 0);
  const deadDisallowed = r.agents.reduce(
    (n, a) => n + a.disallowedToolIssues.length,
    0,
  );
  const { score, findings } = scoreFrom([
    {
      n: deadTools,
      weight: W_DANGLING_REF,
      label: "unavailable agent tool(s) (typo / never-available)",
    },
    {
      n: deadMcpTools,
      weight: W_DANGLING_REF,
      label: "agent MCP tool(s) whose server isn't declared",
    },
    {
      n: r.hookEventIssues.length,
      weight: W_MISSING_HOOK,
      label: "hook(s) on an unknown event (never fire)",
    },
    {
      n: r.mcpIssues.length,
      weight: W_DANGLING_REF,
      label: "MCP server(s) that can't start (no command/url)",
    },
    {
      n: r.mcpHookIssues.length,
      weight: W_DANGLING_REF,
      label: "mcp_tool hook(s) incomplete / undeclared server",
    },
    {
      n: r.frontmatterIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "surface(s) missing required frontmatter",
    },
    {
      n: r.frontmatterValueIssues.length,
      weight: W_NO_CONTRACT,
      label: "agent(s) with an invalid model/color (silent fallback)",
    },
    {
      n: deadDisallowed,
      weight: W_NO_CONTRACT,
      label: "disallowedTools typo(s) that block nothing",
    },
    // These four are graded in the overall (reportDeductions) but were previously
    // attributed to NO ring — so the Structure ring didn't sum to the headline and a
    // real finding (e.g. a `skills/` dir misplaced inside `.claude-plugin/`, invisible
    // to the harness) went unexplained. They're structural-malformation defects, so
    // they belong on the Structure ring — keep the labels/weights identical to
    // reportDeductions so the ring and the headline agree.
    {
      n: r.pluginLayoutIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "functional dir(s) misplaced inside `.claude-plugin/` (invisible)",
    },
    {
      n: r.skillFenceIssues.length,
      weight: W_NO_DESCRIPTION,
      label: "invisible skill(s) (frontmatter with no opening `---` fence)",
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
  ]);
  // inherit-all (no `tools:` line) is ADVISORY, not graded: it's surfaced as a
  // least-privilege NUDGE but never lowers the Structure ring. WHY: omitting the
  // tool contract is a near-universal, legitimate authoring style (a measured OSS
  // sweep of 122 real plugins found 109 whose only finding was this), so grading
  // it would make `audit` cry wolf on idiomatic subagents. See reportDeductions.
  const advisory =
    noContract > 0
      ? [
          `${String(noContract)} agent(s) inherit all tools (no contract) (advisory)`,
        ]
      : [];
  // A confident breakage caps this ring too, so the breakdown can't render a
  // healthy `●` over a dead surface — the defect this fixes was measured as
  // "Structure 92 ●" while an agent named a never-available tool. Only the
  // rows that mean a surface is DEAD count; the typo'd `disallowedTools` and
  // invalid model/color rows are footguns, not breakage, so they stay out.
  const breakage =
    deadTools +
    deadMcpTools +
    r.hookEventIssues.length +
    r.mcpIssues.length +
    r.mcpHookIssues.length +
    r.frontmatterIssues.length +
    r.pluginLayoutIssues.length +
    r.skillFenceIssues.length +
    r.hookBlockFindings.length +
    r.hookMatcherFindings.length;
  return {
    key: "Structure",
    score: breakage > 0 ? Math.min(score, CONFIDENT_BREAKAGE_CAP) : score,
    weight: 1,
    findings: [...findings, ...advisory],
  };
}

/**
 * SAFETY — fed by the STATIC lethal-trifecta check (`report.trifectaFindings`), a
 * GRADED ring. EVERY unit holding all three capability legs counts, whether a
 * subagent's `tools:` NAMED them (`"hard"`) or the unit INHERITED them
 * (`"advisory"` — a subagent with no `tools:` line, or a skill with no
 * `disallowed-tools:` fence, which is every skill by default: `allowed-tools:` is
 * a pre-approval and restricts nothing). Grading only the explicit case made the
 * ring non-monotone:
 * declaring a tool contract — a genuine risk REDUCTION — could only ever lower the
 * score. The penalty is the shared {@link trifectaExposure} (capped against the
 * share of the surface exposed), the SAME number `reportDeductions` sums into the
 * overall, so the ring and the headline agree.
 *
 * Scores `null` (n/a, excluded from the overall) when there's NO tool-bearing
 * surface to assess at all — no subagents AND no model-invocable skills. A
 * user-invoked skill carries no model-driven trifecta risk, so it doesn't count
 * as an assessable surface. When there ARE assessable surfaces but no trifecta,
 * the ring is a clean 100.
 */
function safety(r: ScanReport): CategoryScore {
  const exposure = trifectaExposure(r);
  if (exposure.assessable === 0) {
    return {
      key: "Safety",
      score: null,
      weight: 1,
      findings: ["no tool-bearing surface to assess"],
    };
  }
  const findings: string[] = [];
  if (exposure.exposed > 0) {
    findings.push(
      `${String(exposure.exposed)} of ${String(exposure.assessable)} ` +
        pluralizeLabel(exposure.exposed, TRIFECTA_LABEL),
    );
  }
  // NAME the inherited ones: they're both the worst (every capability, not just
  // the three legs) and the cheapest to fix — declare a contract that drops a leg.
  //
  // EXCEPT the unfenced skills, which collapse into ONE line. A skill's
  // `allowed-tools:` pre-approves rather than restricts (measured 2026-08-11), so
  // EVERY skill without a `disallowed-tools:` line is in this state — naming them
  // one at a time would bury the subagent findings under a list as long as the
  // skill corpus. Same reasoning as the report section; see `trifectaLines`.
  const unfenced = r.trifectaFindings.filter(
    (f) => f.kind === "skill" && f.finding.fence === "none",
  );
  // An INEFFECTIVE fence (`disallowed-tools:` that closes no leg) keeps its own
  // line while there are FEW of them — that is the documented intent in
  // core/lethal-trifecta.ts: it is a genuine mistake, the author believed they had
  // fenced, so naming the skill is what a reader acts on.
  //
  // MEASURED 2026-08-28 that the premise behind that shape — "Rare" — does not
  // hold: a fixture where every skill carried a naive `disallowed-tools: WebFetch`
  // put ALL of them in this state, and the ring printed the same ~450-character
  // paragraph ten times, ~4,500 characters into the terminal report. Past the
  // threshold it stops being N facts about N skills and becomes one fact about the
  // harness — exactly the reasoning the `fence: "none"` aggregate already uses.
  // Names are kept as detail, so nothing is lost, only repetition.
  const ineffective = r.trifectaFindings.filter(
    (f) =>
      f.finding.severity === "advisory" &&
      !unfenced.includes(f) &&
      f.kind === "skill" &&
      f.finding.fence === "ineffective",
  );
  const collapseIneffective = ineffective.length > MAX_NAMED_INEFFECTIVE_FENCES;
  for (const f of r.trifectaFindings) {
    if (f.finding.severity !== "advisory") continue;
    if (unfenced.includes(f)) continue;
    if (collapseIneffective && ineffective.includes(f)) continue;
    findings.push(
      f.kind === "skill"
        ? `${f.name}: ${f.finding.message}`
        : `${f.name} inherits all tools — the "lethal trifecta" (reads data, reaches the web, runs commands) plus every other capability, so a prompt injection could exfiltrate secrets`,
    );
  }
  if (collapseIneffective) {
    findings.push(
      `${String(ineffective.length)} skill(s) declare a \`disallowed-tools:\` that closes no lethal-trifecta leg — a leg is closed only when EVERY built-in supplying it is denied: ` +
        `${ineffective.map((f) => f.name).join(", ")}. ` +
        `Name every supplier of the leg you mean to close — private-data read = Read, Grep, Glob, Bash; untrusted intake = WebFetch, WebSearch, Bash; exfiltration = WebFetch, WebSearch, Bash.`,
    );
  }
  if (unfenced.length > 0) {
    findings.push(
      `${String(unfenced.length)} skill(s) declare no \`disallowed-tools:\` fence, so each inherits every tool the session grants — reads data, reaches the web, runs commands. \`allowed-tools:\` pre-approves, it does not restrict, so narrowing it does not reduce this; one \`disallowed-tools:\` line per skill drops a leg.`,
    );
  }
  return {
    key: "Safety",
    score: Math.max(0, 100 - exposure.penalty),
    weight: 1,
    findings,
  };
}

/**
 * TESTED — DETERMINISTIC harness coverage only (`*.harness.*`, plus any custom
 * `include`):
 * free, milliseconds, every push. It answers "does this gate still catch what it
 * claims?" The real-model tier is a SEPARATE ring ({@link evaluated}) because it
 * differs on cost, on cadence AND on the question it answers — folding both into
 * one number made "complete deterministic coverage, no evals" score identically
 * to "neither", and made the prescription ("add a test/eval") span three orders of
 * magnitude in cost without saying which.
 *
 * Falls back to the union `untested` when a producer predates the split, so the
 * ring never silently reports 0 for a report that simply doesn't carry the field.
 */
function tested(r: ScanReport): CategoryScore {
  const untestedHarness = r.untestedHarness ?? r.untested;
  const { score, findings } = scoreFrom([
    {
      n: untestedHarness,
      // Say VIGILES-NATIVE explicitly — this counts `.harness.mjs`/`.test.*`, not
      // whether a surface is tested at all, so the label must not read as "untested".
      // No slash: this sentence is about the FREE tier and nothing else.
      weight: W_UNTESTED,
      label: "surface(s) with no vigiles harness (deterministic, free)",
    },
  ]);
  // ADVISORY: a hardening gap, not breakage — shown but EXCLUDED from the overall
  // grade (so a clean-but-untested repo is never graded F). And because it counts
  // only vigiles-native tests, a repo with its OWN test setup gets an honest context
  // note so the number is read as "optional", not "you don't test" (G3 — don't
  // measure the wrong thing).
  const contextualized =
    r.ownTestSignal && untestedHarness > 0
      ? [
          ...findings,
          "your own test setup detected — vigiles-native skill coverage is optional",
        ]
      : findings;
  // 🔴 COVERED BY PLACEMENT ALONE — the execution tier, finally said out loud.
  //
  // `colocated` evidence means a test file NAMED after the surface sits BESIDE it. That is
  // a claim about the filesystem, and the provenance line already admits it ("this says the
  // file EXISTS, not that it ran"). Nobody reads a provenance line. When `executed` is zero
  // across the whole corpus, EVERY surface counted here rests on a filename, and the number
  // above reads as health it has not earned.
  //
  // Measured in a real consumer 2026-08-18: 26 colocated, 0 executed — while its CI invoked
  // exactly those harnesses in a job that never installed the `claude` CLI, so each one
  // called `skip()` and the step reported success. Coverage looked fine the entire time.
  //
  // Deliberately NOT "your CI does not run these": that needs parsing CI config, and the
  // grep-shaped version accuses a healthy repo, because real workflows invoke harnesses by
  // GLOB and name no file. This says only what the run records say, so it cannot be wrong
  // about a repo it has not looked at.
  //
  // ⚠️ KNOWN LIMIT, stated rather than hidden: the threshold is CORPUS-WIDE, so ONE recorded
  // run anywhere silences it for every surface. That is what the data supports — the evidence
  // this receives is an aggregate tally, not a per-surface verdict — and the same consumer
  // demonstrates the cost: it read 0 executed / 26 colocated in the morning and 16 / 26 by
  // evening, after which twenty-six surfaces resting on a filename would no longer be named.
  // Sharpening this means carrying evidence per surface, which is a change to the producer,
  // not to this sentence. Until then it catches the state that actually shipped (a corpus
  // where the tier is entirely absent) and stays quiet the moment the tier exists at all.
  const ev = r.coverageEvidence;
  const placementOnly =
    ev && ev.executed === 0 && ev.colocated > 0
      ? [
          ...contextualized,
          `${String(ev.colocated)} surface(s) counted as covered by PLACEMENT only — ` +
            `no run on record ever exercised one`,
        ]
      : contextualized;
  return {
    key: "Tested",
    score,
    weight: 1,
    advisory: true,
    findings: placementOnly,
  };
}

/**
 * EVALUATED — REAL-MODEL coverage (`*.eval.mjs`): paid, minutes, scheduled. It
 * answers the one question the deterministic read cannot — does a skill FIRE at
 * all? Advisory, like Tested.
 *
 * THREE states, not two, and the third is the point:
 *
 *   - a NUMBER  — measured: evals exist here, this is their coverage percentage.
 *   - `0`       — the firing tier RAN this session and nothing covers these
 *                 surfaces. A real, earned zero.
 *   - NOT MEASURED (`score: null` + `notMeasured`) — nothing asked. No evals on
 *                 disk AND the executing checks were skipped (headless / `--json`
 *                 / a remembered no). The audit knows NOTHING about firing here.
 *
 * Collapsing the third into the first would report the ABSENCE of a check as the
 * RESULT of a check — precisely the pattern this product exists to name in other
 * people's repositories. The report already states the distinction in prose ("Do
 * your N skills actually fire? The deterministic read can't tell…") and used to
 * fold it into one score anyway. In the `notMeasured` state the ring NUDGES with
 * the command that would answer the question.
 *
 * `null` WITHOUT `notMeasured` is the ordinary n/a: no surface to evaluate at all.
 */
function evaluated(r: ScanReport, firingMeasured: boolean): CategoryScore {
  const evaluable = r.evaluable ?? 0;
  if (evaluable === 0) {
    return {
      key: "Evaluated",
      score: null,
      weight: 1,
      advisory: true,
      findings: ["no surface whose firing could be measured"],
    };
  }
  const unevaluated = r.unevaluated ?? evaluable;
  const evalCovered = evaluable - unevaluated;
  const gap = `${String(unevaluated)} ${pluralizeLabel(
    unevaluated,
    "surface(s) whose firing was never measured",
  )}`;
  // Nothing on disk measures firing AND nothing ran this session → the question
  // was never asked. Say that, and name the command — do NOT score it a 0.
  if (evalCovered === 0 && !firingMeasured) {
    return {
      key: "Evaluated",
      score: null,
      weight: 1,
      advisory: true,
      notMeasured: true,
      findings: [gap, `not measured — ${MEASURE_FIRING_COMMAND}`],
    };
  }
  // A straight coverage percentage, so the zero state is a LITERAL 0 — "the
  // firing tier was available and nothing covers these surfaces" — and can never
  // be confused with the null above.
  return {
    key: "Evaluated",
    score: Math.round((100 * evalCovered) / evaluable),
    weight: 1,
    advisory: true,
    findings: unevaluated > 0 ? [gap] : [],
  };
}

/**
 * An instruction-only repo (just a CLAUDE.md/AGENTS.md, no plugin surface) is NOT
 * empty — the scan records `instructions` precisely so it isn't graded F/0 "no
 * loadable surface". Only a dir with NO instruction file AND no surface is empty.
 * (The shared `isEmptyMachine` ignores `instructions`; audit additionally treats
 * an instruction file as a surface.)
 */
function isEmptyAudit(r: ScanReport): boolean {
  return isEmptyMachine(r) && !r.instructions;
}

/**
 * Bucket a scan report into the six Lighthouse categories as a DIAGNOSTIC
 * breakdown, with the headline `overall` = `100 − Σ(all graded penalties)` (the
 * shared summed model — NOT the average of the rings — so it equals the
 * leaderboard's single health number). The advisory Tested / Evaluated rings and
 * any n/a ring are shown but excluded from the headline — the grade weighting is
 * UNCHANGED by the Tested/Evaluated split.
 */
export function auditScore(
  report: ScanReport,
  opts: AuditScoreOptions = {},
): AuditScore {
  if (isEmptyAudit(report)) {
    const categories: CategoryKey[] = [
      "Truthfulness",
      "Triggering",
      "Structure",
      "Safety",
      "Tested",
      "Evaluated",
    ];
    return {
      overall: 0,
      grade: gradeFor(0),
      categories: categories.map((key) => ({
        key,
        score: null,
        weight: 1,
        findings: ["no loadable plugin surface"],
      })),
      empty: true,
    };
  }
  const categories: CategoryScore[] = [
    truthfulness(report),
    triggering(report),
    structure(report),
    safety(report),
    tested(report),
    evaluated(report, opts.firingMeasured === true),
  ];
  // The headline is the SUMMED model (the shared integrity score), NOT the average
  // of the rings — averaging would let a real problem in one category be diluted
  // by clean siblings. The rings above stay a diagnostic breakdown; Tested and
  // Evaluated (both advisory) are never summed in (neither drags the grade).
  const { score: summed } = computeIntegrityScore(reportDeductions(report));
  // A confident breakage caps the headline too, so it can never read `A` while a
  // surface is definitively dead (score-core.ts::applyBreakageCap).
  const overall = applyBreakageCap(summed, report);
  return { overall, grade: gradeFor(overall), categories, empty: false };
}

/**
 * How many INEFFECTIVE `disallowed-tools:` fences are named one at a time before
 * the Safety ring collapses them into a single line. Past this it is one fact
 * about the harness, not N facts about N skills — see the measurement in
 * {@link safety}.
 */
const MAX_NAMED_INEFFECTIVE_FENCES = 3;

// A 22-cell bar gauge ("ring" in the terminal; the real rings are the HTML).
const BAR_CELLS = 22;

/** A glyph that signals the band at a glance (green/amber/red, no ANSI needed).
 *  `?` is its own glyph: an UNASKED question is not the same as "not applicable"
 *  (`○`) and emphatically not the same as a measured failure (`✗`). */
function bandGlyph(c: CategoryScore): string {
  if (c.score === null) return c.notMeasured ? "?" : "○";
  if (c.score >= 90) return "●";
  if (c.score >= 70) return "◑";
  return "✗";
}

function bar(c: CategoryScore): string {
  if (c.score === null) return c.notMeasured ? "not measured" : "n/a";
  const filled = Math.round((c.score / 100) * BAR_CELLS);
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/**
 * The ring's number as the reader sees it — THREE distinct labels, never two.
 * A measured `0` and an unasked question are different facts and must not render
 * the same; `n/a` (nothing to assess) is a third, also distinct.
 */
export function categoryScoreLabel(c: CategoryScore): string {
  if (c.score !== null) return String(c.score);
  return c.notMeasured ? "not measured" : "n/a";
}

/** Render the category rings (diagnostic) + the summed overall for the terminal. */
export function formatAuditScore(s: AuditScore): string {
  const lines: string[] = ["Harness audit", ""];
  for (const c of s.categories) {
    const glyph = bandGlyph(c);
    const label = c.key.padEnd(13);
    const num = categoryScoreLabel(c).padStart(4);
    const tag = c.advisory ? "  · advisory (not graded)" : "";
    lines.push(`  ${glyph} ${label} ${num}  ${bar(c)}${tag}`);
    if (c.findings.length > 0) {
      lines.push(`       └ ${c.findings.join("; ")}`);
    }
  }
  lines.push("");
  lines.push(`Harness health: ${s.grade} (${String(s.overall)}/100)`);
  return lines.join("\n");
}
