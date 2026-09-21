/**
 * Category-scoring suite (vitest): pure over a hand-built ScanReport (no fs/model)
 * — each finding buckets into the right deterministic category, the overall
 * excludes n/a categories, an empty machine is empty (but an instruction-only
 * repo is NOT), and the formatter renders rings + the overall. Safety is fed by
 * the STATIC lethal-trifecta check (the EXECUTING disaster-battery is still not
 * an `audit` ring).
 *
 * Tested and Evaluated are two rings on purpose (defect #9): a harness and an
 * eval differ on cost, cadence and the question they answer, and `Evaluated` has
 * a THIRD state (`not measured`) that must stay distinguishable from a measured 0.
 */
import { describe, it, expect } from "vitest";
import {
  auditScore,
  categoryScoreLabel,
  formatAuditScore,
} from "./audit-score.js";
import type { CategoryScore } from "./audit-score.js";
import type { ScanReport } from "./scan.js";

/** A clean, loaded report; override fields per test. */
function makeReport(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "/x",
    instructions: null,
    // 🔴 ONE skill, not zero — and it is the fixture's whole point. `triggering()`
    // answers an empty `skills` list with `null` (#240: a score over nothing is not
    // a score), so a fixture with no skill could no longer assert "100 on every
    // category" without asserting the very lie that guard exists to stop. The skill
    // is `userInvoked` so `trifectaExposure` still counts 0 assessable surfaces and
    // the Safety ring stays n/a, which is what the assertion below reads.
    skills: [
      { name: "clean", hasDescription: true, userInvoked: true },
    ] as unknown as ScanReport["skills"],
    agents: [],
    hooks: [],
    inlineHooks: 0,
    manualHookCount: 0,
    commands: 1, // a surface, so it's not the empty machine
    mcp: false,
    danglingRefs: [],
    hookEventIssues: [],
    frontmatterIssues: [],
    frontmatterValueIssues: [],
    skillMetaIssues: [],
    mcpIssues: [],
    mcpHookIssues: [],
    descriptionOverlaps: [],
    descriptionBudgetIssues: [],
    trifectaFindings: [],
    skillResourceIssues: [],
    skillFenceIssues: [],
    pluginLayoutIssues: [],
    unclaimedSurfaces: [],
    delegationTrifecta: [],
    hookBlockFindings: [],
    hookMatcherFindings: [],
    malformedFrontmatter: [],
    warnings: [],
    untested: 0,
    puritySummary: { pure: 0, bounded: 0, unrestricted: 0 },
    ...over,
  } as ScanReport;
}

const cat = (s: ReturnType<typeof auditScore>, key: string) =>
  s.categories.find((c) => c.key === key);

/** `cat`, but it fails loudly instead of yielding `undefined` — for assertions
 *  that pass the ring itself to a helper (no non-null assertions in tests). */
const ring = (s: ReturnType<typeof auditScore>, key: string): CategoryScore => {
  const c = cat(s, key);
  if (!c) throw new Error(`no ${key} ring`);
  return c;
};

describe("auditScore", () => {
  it("a clean report scores 100 on every (deterministic) category", () => {
    const s = auditScore(makeReport());
    expect(cat(s, "Truthfulness")?.score).toBe(100);
    expect(cat(s, "Triggering")?.score).toBe(100);
    expect(cat(s, "Structure")?.score).toBe(100);
    expect(cat(s, "Tested")?.score).toBe(100);
    // No tool-bearing surface (no agents, no model-invocable skills) → Safety n/a.
    expect(cat(s, "Safety")?.score).toBeNull();
    expect(s.overall).toBe(100);
    expect(s.grade).toBe("A");
  });

  it("has six rings — Safety fed by the static lethal-trifecta check, Tested and Evaluated split", () => {
    const keys = auditScore(makeReport()).categories.map((c) => c.key);
    expect(keys).toEqual([
      "Truthfulness",
      "Triggering",
      "Structure",
      "Safety",
      "Tested",
      "Evaluated",
    ]);
  });

  it("buckets a dangling ref into Truthfulness; the overall is the summed score, CAPPED because a broken ref is a confident breakage", () => {
    const s = auditScore(makeReport({ danglingRefs: ["hooks/missing.sh"] }));
    expect(cat(s, "Truthfulness")?.score).toBe(92); // -8, ring
    expect(cat(s, "Structure")?.score).toBe(100);
    // headline = 100 - Σ penalties = 92 (NOT the average of the rings), so the
    // single dangling ref shows up undiluted in the overall.
    // 100 − 8 (W_DANGLING_REF) = 92 by the sum, but a broken intra-plugin
    // reference means a path is DEAD, so the confident-breakage cap holds the
    // headline at 89 — it may not read as the healthy band while something is
    // definitively broken. See score-core.ts::applyBreakageCap.
    expect(s.overall).toBe(89);
  });

  it("buckets a description overlap + no-description into Triggering; overall summed", () => {
    const s = auditScore(
      makeReport({
        skills: [
          { name: "a", hasDescription: false, userInvoked: false },
        ] as unknown as ScanReport["skills"],
        descriptionOverlaps: [
          { a: "x", b: "y", ncd: 0.1 },
        ] as unknown as ScanReport["descriptionOverlaps"],
      }),
    );
    // -10 (no-desc) -8 (overlap) = 82, in the ring AND the headline overall.
    expect(cat(s, "Triggering")?.score).toBe(82);
    expect(cat(s, "Triggering")?.findings.length).toBe(2);
    expect(s.overall).toBe(82);
  });

  it("the headline overall is SUMMED across categories, not the ring average", () => {
    // A plugin whose only issues are in Structure (six agents each referencing a
    // tool that doesn't exist, −8 apiece = −48) shows Structure 52 in the breakdown
    // AND overall 52 — averaging the four rings would dilute that to ~88 and hide
    // the real broken-contract problem.
    const agent = {
      name: "a",
      path: "p",
      tools: ["Ghost"],
      toolIssues: [{ tool: "Ghost", suggestion: "Glob" }],
      mcpToolIssues: [],
      disallowedToolIssues: [],
      purity: "unrestricted" as const,
      effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
    };
    const s = auditScore(
      makeReport({
        agents: Array.from(
          { length: 6 },
          () => agent,
        ) as unknown as ScanReport["agents"],
      }),
    );
    expect(cat(s, "Structure")?.score).toBe(52); // -6*8
    expect(cat(s, "Truthfulness")?.score).toBe(100);
    expect(cat(s, "Triggering")?.score).toBe(100);
    expect(s.overall).toBe(52); // summed, NOT averaged to ~88
    expect(s.grade).toBe("F");
  });

  it("a misplaced-plugin-dir deduction lands on the Structure ring (rings sum to the headline)", () => {
    // Regression: pluginLayoutIssues (e.g. `skills/` nested inside `.claude-plugin/`
    // where the harness can't load it) is graded in the overall but was attributed to
    // NO ring — so a real F could show Structure/Safety adding to less than the
    // headline, leaving an unexplained score (Codex P2 on the davila7 demo fixture).
    const s = auditScore(
      makeReport({
        pluginLayoutIssues: [
          { dir: "skills", message: "skills/ is inside .claude-plugin/" },
        ],
      }),
    );
    // −10 (W_NO_DESCRIPTION) shows on Structure, and the ring sums to the overall.
    // 100 − 10 (W_NO_DESCRIPTION) = 90 by the sum; a functional dir misplaced
    // inside `.claude-plugin/` is INVISIBLE to the harness, i.e. breakage, so
    // the ring is capped at 89 rather than sitting on the healthy boundary.
    expect(cat(s, "Structure")?.score).toBe(89);
    expect(cat(s, "Structure")?.findings.some((f) => /misplaced/.test(f))).toBe(
      true,
    );
    expect(s.overall).toBe(90);
  });

  it("inherit-all (no tool contract) is ADVISORY — shown on Structure, never graded", () => {
    // Decision (2026-06-28): omitting the `tools:` line is a near-universal,
    // legitimate authoring style (an OSS sweep of 122 real plugins found 109 whose
    // ONLY finding was this), so it must not drag the grade — a least-privilege
    // NUDGE, not breakage. See reportDeductions / scoreReport for the rationale.
    const agent = {
      name: "a",
      path: "p",
      tools: null,
      toolIssues: [],
      mcpToolIssues: [],
      disallowedToolIssues: [],
      purity: "unrestricted" as const,
      effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
    };
    const s = auditScore(
      makeReport({
        agents: Array.from(
          { length: 6 },
          () => agent,
        ) as unknown as ScanReport["agents"],
      }),
    );
    // Structure stays clean (not graded) but the note is still surfaced.
    expect(cat(s, "Structure")?.score).toBe(100);
    expect(
      cat(s, "Structure")?.findings.some(
        (f) => f.includes("inherit all tools") && f.includes("advisory"),
      ),
    ).toBe(true);
    expect(s.overall).toBe(100);
    expect(s.grade).toBe("A");
  });

  it("untested surfaces are ADVISORY — shown on Tested, but never drag the grade", () => {
    const s = auditScore(makeReport({ untested: 3 }));
    expect(cat(s, "Tested")?.score).toBe(91); // -9, shown
    expect(cat(s, "Tested")?.advisory).toBe(true);
    expect(cat(s, "Structure")?.score).toBe(100);
    // the overall ignores the advisory Tested ring — a clean-but-untested repo is A
    expect(s.overall).toBe(100);
    expect(s.grade).toBe("A");
    // The finding names the vigiles-native tier, not a bare "untested" (honesty),
    // and names the DETERMINISTIC tier specifically — no "test/eval" slash, which
    // spanned two prescriptions three orders of magnitude apart in one sentence.
    expect(
      cat(s, "Tested")?.findings.some((f) => /vigiles harness/.test(f)),
    ).toBe(true);
    expect(
      cat(s, "Tested")?.findings.some((f) => f.includes("test/eval")),
    ).toBe(false);
  });

  it("own-test signal contextualizes Tested — never reads as 'you don't test'", () => {
    // A repo with its OWN tests + surfaces vigiles doesn't cover → the ring stays
    // advisory, but adds an honest "your own tests count, vigiles-native is optional".
    const s = auditScore(makeReport({ untested: 3, ownTestSignal: true }));
    expect(cat(s, "Tested")?.advisory).toBe(true);
    expect(
      cat(s, "Tested")?.findings.some((f) => /your own test setup/.test(f)),
    ).toBe(true);
    // No own-test signal → no context note.
    const bare = auditScore(makeReport({ untested: 3 }));
    expect(
      cat(bare, "Tested")?.findings.some((f) => /your own test setup/.test(f)),
    ).toBe(false);
  });

  // ── Tested vs Evaluated: two tiers, not one number ────────────────────────
  // A harness (`*.harness.mjs`, `*.test.*`) is free, runs on every push, and asks
  // "does this gate still catch what it claims?". An eval (`*.eval.mjs`) costs
  // real model calls, runs on a schedule, and asks "does this skill FIRE at all?".
  // Collapsed into one ring, a repo with complete deterministic coverage and no
  // evals scored IDENTICALLY to a repo with neither.

  it("Tested reads the DETERMINISTIC tier, not the union — eval-only coverage is not a harness", () => {
    // 4 surfaces: 3 have no harness, only 1 has neither harness nor eval. The old
    // single count would have read 1 (the union) and called the repo nearly clean.
    const s = auditScore(
      makeReport({
        untested: 1,
        untestedHarness: 3,
        evaluable: 4,
        unevaluated: 2,
      }),
    );
    expect(cat(s, "Tested")?.score).toBe(91); // 100 − 3×3
    expect(cat(s, "Evaluated")?.score).toBe(50); // 2 of 4 covered
    // Two different sentences, two different prescriptions.
    expect(cat(s, "Tested")?.findings[0]).toMatch(/no vigiles harness/);
    expect(cat(s, "Evaluated")?.findings[0]).toMatch(
      /firing was never measured/,
    );
    // Neither sentence carries the old "test/eval" slash.
    for (const c of s.categories)
      for (const f of c.findings) expect(f).not.toContain("test/eval");
  });

  it("Tested falls back to the union count for a report predating the split", () => {
    const s = auditScore(makeReport({ untested: 3 }));
    expect(cat(s, "Tested")?.score).toBe(91);
  });

  it("Evaluated is plain n/a when there is no surface whose firing could be measured", () => {
    const e = ring(auditScore(makeReport({ evaluable: 0 })), "Evaluated");
    expect(e.score).toBeNull();
    // n/a is NOT the "nobody asked" state — nothing was there to ask about.
    expect(e.notMeasured).toBeUndefined();
    expect(categoryScoreLabel(e)).toBe("n/a");
  });

  it("🔴 Evaluated: `not measured` is a THIRD state, distinguishable from a measured 0", () => {
    // The SAME report, differing only in whether this run asked the question.
    const report = makeReport({ evaluable: 4, unevaluated: 4 });

    // (a) headless read — the executing checks never ran, no eval file on disk.
    //     The audit knows NOTHING about firing. Reporting 0 here would present
    //     the ABSENCE of a check as the RESULT of one.
    const unasked = ring(auditScore(report), "Evaluated");
    expect(unasked.score).toBeNull();
    expect(unasked.notMeasured).toBe(true);
    expect(categoryScoreLabel(unasked)).toBe("not measured");

    // (b) the firing tier RAN and found nothing covered → an earned, literal 0.
    const asked = ring(
      auditScore(report, { firingMeasured: true }),
      "Evaluated",
    );
    expect(asked.score).toBe(0);
    expect(asked.notMeasured).toBeUndefined();
    expect(categoryScoreLabel(asked)).toBe("0");

    // The whole point: these two must not be the same value OR the same label.
    expect(unasked.score).not.toBe(asked.score);
    expect(categoryScoreLabel(unasked)).not.toBe(categoryScoreLabel(asked));
  });

  it("Evaluated nudges with the COMMAND when it wasn't measured (no bare zero)", () => {
    const e = cat(
      auditScore(makeReport({ evaluable: 2, unevaluated: 2 })),
      "Evaluated",
    );
    expect(e?.findings.some((f) => f.startsWith("not measured —"))).toBe(true);
    expect(e?.findings.some((f) => f.includes("npx vigiles audit"))).toBe(true);
    expect(e?.findings.some((f) => f.includes("measureTriggerRate"))).toBe(
      true,
    );
    // And it still NAMES the gap in skills-whose-firing terms.
    expect(e?.findings[0]).toBe("2 surfaces whose firing was never measured");
  });

  it("Evaluated is a real number as soon as ANY eval exists — the read doesn't have to run", () => {
    // One of four covered by an on-disk `*.eval.mjs`: something DOES measure
    // firing here, so the ring reports coverage rather than "not measured".
    const e = cat(
      auditScore(makeReport({ evaluable: 4, unevaluated: 3 })),
      "Evaluated",
    );
    expect(e?.score).toBe(25);
    expect(e?.notMeasured).toBeUndefined();
    expect(e?.findings[0]).toBe("3 surfaces whose firing was never measured");
  });

  it("Evaluated is a clean 100 with no findings when every surface has an eval", () => {
    const e = cat(
      auditScore(makeReport({ evaluable: 3, unevaluated: 0 })),
      "Evaluated",
    );
    expect(e?.score).toBe(100);
    expect(e?.notMeasured).toBeUndefined();
    expect(e?.findings).toEqual([]);
  });

  it("both tiers are ADVISORY — the split moves NO grade, in any of the three states", () => {
    const base = auditScore(makeReport()).overall;
    for (const over of [
      { untestedHarness: 9, evaluable: 9, unevaluated: 9 }, // not measured
      { untestedHarness: 9, evaluable: 9, unevaluated: 0 }, // fully evaluated
      { untestedHarness: 0, evaluable: 0, unevaluated: 0 }, // n/a
    ]) {
      for (const firingMeasured of [false, true]) {
        const s = auditScore(makeReport(over), { firingMeasured });
        expect(cat(s, "Tested")?.advisory).toBe(true);
        expect(cat(s, "Evaluated")?.advisory).toBe(true);
        expect(s.overall).toBe(base);
        expect(s.grade).toBe("A");
      }
    }
  });

  it("RENDERED: the terminal keeps `not measured`, `n/a` and `0` apart", () => {
    const report = makeReport({ evaluable: 4, unevaluated: 4 });
    const unasked = formatAuditScore(auditScore(report));
    const asked = formatAuditScore(
      auditScore(report, { firingMeasured: true }),
    );

    const line = (out: string, key: string): string =>
      out.split("\n").find((l) => l.includes(key)) ?? "";

    // The unasked run says so, in the ring itself — not only in tail prose.
    expect(line(unasked, "Evaluated")).toContain("not measured");
    expect(line(unasked, "Evaluated")).toMatch(/^\s*\?/); // its own glyph
    // The asked run renders a real 0 with a real (empty) bar and the ✗ band.
    expect(line(asked, "Evaluated")).toMatch(/Evaluated\s+0\s+░+/);
    expect(line(asked, "Evaluated")).not.toContain("not measured");
    expect(line(asked, "Evaluated")).toMatch(/^\s*✗/);
    // Plain n/a is a third, distinct rendering.
    const na = formatAuditScore(auditScore(makeReport({ evaluable: 0 })));
    expect(line(na, "Evaluated")).toContain("n/a");
    expect(line(na, "Evaluated")).not.toContain("not measured");
    expect(line(na, "Evaluated")).toMatch(/^\s*○/);
    // The nudge names the command right under the ring.
    expect(unasked).toContain("npx vigiles audit");
  });

  it("categoryScoreLabel is total over the three states", () => {
    expect(
      categoryScoreLabel({
        key: "Evaluated",
        score: 0,
        weight: 1,
        findings: [],
      }),
    ).toBe("0");
    expect(
      categoryScoreLabel({
        key: "Evaluated",
        score: null,
        weight: 1,
        findings: [],
      }),
    ).toBe("n/a");
    expect(
      categoryScoreLabel({
        key: "Evaluated",
        score: null,
        notMeasured: true,
        weight: 1,
        findings: [],
      }),
    ).toBe("not measured");
  });

  it("Safety is clean (100) when there IS a tool-bearing surface but no trifecta", () => {
    const s = auditScore(
      makeReport({
        agents: [
          {
            name: "a",
            path: "p",
            tools: ["Read"],
            toolIssues: [],
            mcpToolIssues: [],
            disallowedToolIssues: [],
            trifecta: null,
          },
        ] as unknown as ScanReport["agents"],
      }),
    );
    expect(cat(s, "Safety")?.score).toBe(100);
    expect(s.overall).toBe(100);
  });

  it("a HARD trifecta finding grades Safety AND drops the overall by W_TRIFECTA (10)", () => {
    const s = auditScore(
      makeReport({
        agents: [
          {
            name: "exfil-bot",
            path: "agents/exfil-bot.md",
            tools: ["Bash", "WebFetch"],
            toolIssues: [],
            mcpToolIssues: [],
            disallowedToolIssues: [],
            trifecta: { severity: "hard" },
          },
        ] as unknown as ScanReport["agents"],
        trifectaFindings: [
          {
            path: "agents/exfil-bot.md",
            kind: "subagent",
            name: "exfil-bot",
            finding: { severity: "hard" },
          },
        ] as unknown as ScanReport["trifectaFindings"],
      }),
    );
    expect(cat(s, "Safety")?.score).toBe(90); // 100 - 10 (half the old 20 — a ding, not a fail)
    expect(cat(s, "Safety")?.findings.length).toBe(1);
    // Safety is GRADED into the overall (the summed model) — a clean repo would be
    // 100, this drops by exactly W_TRIFECTA.
    expect(s.overall).toBe(90);
    expect(s.grade).toBe("A");
  });

  it("three HARD trifecta units (the feature-dev shape) → C, not F — a ding not a catastrophe", () => {
    // Mirrors the official `feature-dev` plugin: 3 subagents each holding all three
    // legs → 3 × −10 = −30 → 70 → C. A ding that surfaces the risk in the grade,
    // NOT the old catastrophic F(40) at weight 20.
    const agents = [1, 2, 3].map((i) => ({
      name: `agent-${i}`,
      path: `agents/agent-${i}.md`,
      tools: ["Read", "WebFetch", "WebSearch"],
      toolIssues: [],
      mcpToolIssues: [],
      disallowedToolIssues: [],
      trifecta: { severity: "hard" },
    })) as unknown as ScanReport["agents"];
    const trifectaFindings = [1, 2, 3].map((i) => ({
      path: `agents/agent-${i}.md`,
      kind: "subagent",
      name: `agent-${i}`,
      finding: { severity: "hard" },
    })) as unknown as ScanReport["trifectaFindings"];
    const s = auditScore(makeReport({ agents, trifectaFindings }));
    expect(cat(s, "Safety")?.score).toBe(70); // 100 - 3×10
    // One summary finding line with the count embedded ("3 unit(s) …").
    expect(cat(s, "Safety")?.findings.length).toBe(1);
    expect(cat(s, "Safety")?.findings[0]).toContain("3");
    expect(s.overall).toBe(70);
    expect(s.grade).toBe("C"); // NOT F — the whole point of halving the weight
  });

  it("an INHERITS-ALL trifecta is graded like an explicit one (never cheaper)", () => {
    const s = auditScore(
      makeReport({
        agents: [
          {
            name: "broad",
            path: "agents/broad.md",
            tools: null, // inherits all
            toolIssues: [],
            mcpToolIssues: [],
            disallowedToolIssues: [],
            trifecta: { severity: "advisory" },
          },
        ] as unknown as ScanReport["agents"],
        trifectaFindings: [
          {
            path: "agents/broad.md",
            kind: "subagent",
            name: "broad",
            finding: { severity: "advisory" },
          },
        ] as unknown as ScanReport["trifectaFindings"],
      }),
    );
    // Same −10 as the explicit all-three contract above: an inherits-all unit holds
    // the three legs implicitly AND every other capability, so it can never be the
    // cheaper of the two.
    expect(cat(s, "Safety")?.score).toBe(90);
    expect(
      cat(s, "Safety")?.findings.some((f) => f.includes("inherits all tools")),
    ).toBe(true);
    expect(s.overall).toBe(90);
  });

  // -------------------------------------------------------------------------
  // The measured dogfooding regression (2026-08-03, a 35-skill repo): grading the
  // EXPLICIT all-three contract while leaving the strictly-worse inherits-all case
  // ungraded made the tool report a HARDENED harness as worse than its unhardened
  // self — Safety 70 before (only 3 declared units counted, the 31 inheriting
  // everything counted zero) → 0 after `allowed-tools` was added everywhere and the
  // units holding the full trifecta fell 35/35 → 17/35.
  //
  // NB (2026-08-11): the SCENARIO behind these numbers changed; the numbers and the
  // property did not. What moves a SKILL out of the exposed set is a
  // `disallowed-tools:` fence that closes a whole leg — NOT an `allowed-tools:`
  // list, which pre-approves and restricts nothing (measured; see
  // `src/core/lethal-trifecta.ts`). Read "hardened" below as "fenced".
  // -------------------------------------------------------------------------
  /** N model-invocable skills, the first `exposed` of them holding the trifecta. */
  function harness(
    total: number,
    exposed: number,
    severity: "hard" | "advisory",
  ): ScanReport {
    const skills = Array.from({ length: total }, (_, i) => ({
      name: `skill-${String(i)}`,
      path: `skills/skill-${String(i)}/SKILL.md`,
      hasDescription: true,
      userInvoked: false,
      resourceIssues: [],
      trifecta: i < exposed ? { severity } : null,
    })) as unknown as ScanReport["skills"];
    const trifectaFindings = skills.slice(0, exposed).map((s) => ({
      path: s.path,
      kind: "skill",
      name: s.name,
      finding: { severity },
    })) as unknown as ScanReport["trifectaFindings"];
    return makeReport({ skills, trifectaFindings });
  }

  it("hardening a 35-unit harness RAISES Safety (the measured 70 → 0 inversion)", () => {
    // Before: every unit inherits all tools → the whole surface is an exfil path.
    const before = auditScore(harness(35, 35, "advisory"));
    // After: 18 units fenced a leg off with `disallowed-tools`; 17 still hold all three.
    const after = auditScore(harness(35, 17, "hard"));

    expect(cat(before, "Safety")?.score).toBe(70); // 35/35 exposed → capped −30
    expect(cat(after, "Safety")?.score).toBe(85); // 17/35 exposed → −15
    // The property, independent of the exact weights: hardening cannot lower it.
    expect(after.overall).toBeGreaterThan(before.overall);
  });

  it("the penalty is monotone: dropping exposed units never lowers Safety", () => {
    const scores = [35, 30, 20, 17, 5, 1, 0].map(
      (exposed) => auditScore(harness(35, exposed, "hard")).overall,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] ?? 0).toBeGreaterThanOrEqual(scores[i - 1] ?? 0);
    }
    expect(scores.at(-1)).toBe(100); // nothing exposed → clean
  });

  it("a large harness never saturates to 0 on the trifecta alone", () => {
    // A flat per-unit weight put 35 AND 17 exposed units both past the clamp, so
    // halving the exposure showed up as no change at all.
    expect(cat(auditScore(harness(35, 35, "advisory")), "Safety")?.score).toBe(
      70,
    );
    expect(cat(auditScore(harness(200, 200, "hard")), "Safety")?.score).toBe(
      70,
    );
  });

  it("unfenced skills are ONE Safety finding, not one per skill — but still count", () => {
    // 🔴 A skill's `allowed-tools:` pre-approves rather than restricts, so EVERY
    // skill without a `disallowed-tools:` fence is exposed — i.e. ~100% of every
    // real corpus. Naming 35 of them one at a time would bury the subagent
    // findings under a list as long as the skill directory, and a ring that always
    // reads like a wall of identical text stops being read. The SCORE is untouched
    // by the collapse: exposure counts units, presentation counts lines.
    const skills = Array.from({ length: 35 }, (_, i) => ({
      name: `skill-${String(i)}`,
      path: `skills/skill-${String(i)}/SKILL.md`,
      hasDescription: true,
      userInvoked: false,
      resourceIssues: [],
      trifecta: { severity: "advisory", fence: "none" },
    })) as unknown as ScanReport["skills"];
    const s = auditScore(
      makeReport({
        skills,
        trifectaFindings: skills.map((k) => ({
          path: k.path,
          kind: "skill",
          name: k.name,
          finding: { severity: "advisory", fence: "none" },
        })) as unknown as ScanReport["trifectaFindings"],
      }),
    );
    const findings = cat(s, "Safety")?.findings ?? [];
    // One headline ("35 of 35 …") + one aggregate line. Never 35 named lines.
    expect(findings.length).toBe(2);
    expect(findings.some((f) => f.includes("35 skill(s) declare no"))).toBe(
      true,
    );
    expect(findings.some((f) => f.includes("skill-7"))).toBe(false);
    // …and the collapse cost the score nothing: 35/35 exposed → capped −30.
    expect(cat(s, "Safety")?.score).toBe(70);
  });

  it("Safety is n/a when there's no tool-bearing surface (no agents, no model-invocable skills)", () => {
    // A user-invoked skill carries no model-driven trifecta risk → not assessable.
    const s = auditScore(
      makeReport({
        skills: [
          {
            name: "u",
            hasDescription: true,
            userInvoked: true,
            trifecta: null,
          },
        ] as unknown as ScanReport["skills"],
      }),
    );
    expect(cat(s, "Safety")?.score).toBeNull();
  });

  it("a model-invocable skill IS an assessable Safety surface (clean → 100)", () => {
    const s = auditScore(
      makeReport({
        skills: [
          {
            name: "m",
            hasDescription: true,
            userInvoked: false,
            trifecta: null,
          },
        ] as unknown as ScanReport["skills"],
      }),
    );
    expect(cat(s, "Safety")?.score).toBe(100);
  });

  it("an empty machine (no surface, no instructions) is empty — overall 0, all n/a", () => {
    // `skills: []` is stated HERE, not inherited: the shared fixture now carries one
    // skill, and "empty machine" means every surface count is zero — naming them all
    // is what makes this test a test of emptiness rather than of the fixture.
    const s = auditScore(makeReport({ commands: 0, mcp: false, skills: [] }));
    expect(s.empty).toBe(true);
    expect(s.overall).toBe(0);
    expect(s.categories.every((c) => c.score === null)).toBe(true);
    // Safety is included in the empty-machine null list (6 categories, all n/a).
    expect(s.categories.map((c) => c.key)).toContain("Safety");
    expect(s.categories.map((c) => c.key)).toContain("Evaluated");
    expect(s.categories.length).toBe(6);
    // An empty machine has nothing to measure — that's plain n/a, NOT the
    // "nobody asked" state (which is reserved for a real surface + no answer).
    expect(s.categories.every((c) => c.notMeasured)).toBe(false);
  });

  it("an inline-hook-only harness is NOT empty (inline hooks are a real surface)", () => {
    // A harness that defines only inline hook commands (no script file, no skills
    // /agents/commands/mcp) has a real loadable hook surface — it must score, not
    // be graded F/0. Regression: `inlineHooks` was excluded from the surface count.
    const s = auditScore(
      makeReport({ commands: 0, mcp: false, inlineHooks: 2 }),
    );
    expect(s.empty).toBe(false);
  });

  it("an instruction-only repo is NOT empty (a CLAUDE.md is a loadable surface)", () => {
    // Just a top-level instruction file, no plugin surface — must still score,
    // not be graded F/0 "no loadable surface".
    const s = auditScore(
      makeReport({
        commands: 0,
        mcp: false,
        instructions: {
          file: "CLAUDE.md",
          managed: false,
        } as unknown as ScanReport["instructions"],
      }),
    );
    expect(s.empty).toBe(false);
    expect(s.overall).toBe(100); // nothing broken
  });
});

describe("formatAuditScore", () => {
  it("renders each category ring + the weighted overall", () => {
    const out = formatAuditScore(auditScore(makeReport()));
    expect(out).toMatch(/Truthfulness/);
    expect(out).toMatch(/Structure/);
    expect(out).toMatch(/Safety/); // Safety IS a ring (static lethal-trifecta)
    expect(out).toMatch(/Harness health: A \(100\/100\)/);
  });
});

/**
 * The execution tier, asserted. Coverage evidence has two kinds and only one of them is a
 * measurement: `executed` means a recorded run exercised the surface, `colocated` means a
 * file with the right name sits in the right place. The report's provenance line has always
 * said so; nobody reads a provenance line, and a real consumer sat at 26 colocated /
 * 0 executed while its CI skipped every one of those harnesses and reported success.
 */
describe("Tested — coverage that rests on a filename says so", () => {
  const find = (over: Partial<ScanReport>) =>
    ring(auditScore(makeReport(over)), "Tested").findings;
  const placementOnly = (f: readonly string[]) =>
    f.some((x) => /PLACEMENT only/.test(x));

  it("names the count when NOTHING has an execution record", () => {
    const f = find({
      coverageEvidence: { executed: 0, colocated: 26, configured: 0 },
    });
    expect(placementOnly(f)).toBe(true);
    expect(f.join(" ")).toMatch(/26 surface\(s\)/);
  });

  it("goes quiet as soon as ONE run is on record — the tier exists, the warning is spent", () => {
    expect(
      placementOnly(
        find({
          coverageEvidence: { executed: 1, colocated: 25, configured: 0 },
        }),
      ),
    ).toBe(false);
  });

  it("says nothing when the report carries no evidence at all — absent is not zero", () => {
    expect(placementOnly(find({}))).toBe(false);
  });
});

/**
 * CONFIDENT-BREAKAGE CAP — a summed score dilutes one real breakage among clean
 * siblings, so a definitively-dead surface could render as a healthy `●` / `A`.
 * MEASURED before the fix on a fixture of 10 distinct-description skills plus one
 * agent naming a never-available tool: Structure scored 92 with a green dot.
 *
 * Both halves are asserted on purpose: the cap must BITE on a breakage and stay
 * SILENT on a clean report — a cap that only ever fires is indistinguishable from
 * a broken weight, and one that never fires is indistinguishable from absent.
 */
describe("confident-breakage cap", () => {
  it("caps Structure below the healthy band when an agent names a dead tool", () => {
    const s = auditScore(
      makeReport({
        agents: [
          {
            name: "broken",
            tools: ["Read", "AskUserQuestion"],
            toolIssues: ["AskUserQuestion is never available to a subagent"],
            mcpToolIssues: [],
            disallowedToolIssues: [],
          } as unknown as ScanReport["agents"][number],
        ],
      }),
    );
    const structure = s.categories.find((c) => c.key === "Structure");
    expect(structure?.score).not.toBeNull();
    expect(structure?.score).toBeLessThan(90);
    expect(s.overall).toBeLessThan(90);
    expect(s.grade).not.toBe("A");
  });

  it("stays silent on a clean report — no cap, no dent", () => {
    const s = auditScore(makeReport());
    const structure = s.categories.find((c) => c.key === "Structure");
    expect(structure?.score).toBe(100);
    expect(s.overall).toBe(100);
    expect(s.grade).toBe("A");
  });

  it("does NOT cap on a heuristic finding — a description overlap is a proxy, not breakage", () => {
    // Capping on the heuristic rings is how a gate earns the reputation that gets
    // it switched off: an external 517-skill catalog run disabled its gate for
    // exactly that reason. Overlap dents the score; it must not cap it.
    const s = auditScore(
      makeReport({
        descriptionOverlaps: [
          { a: "one", b: "two", distance: 0.1 },
        ] as unknown as ScanReport["descriptionOverlaps"],
      }),
    );
    const structure = s.categories.find((c) => c.key === "Structure");
    expect(structure?.score).toBe(100); // untouched: overlap is a Triggering signal
  });
});

/**
 * INEFFECTIVE-FENCE COLLAPSE — a `disallowed-tools:` that closes no leg keeps its
 * own line while there are few of them (the documented intent: it is a genuine
 * mistake and naming the skill is actionable). Past a threshold it becomes one
 * fact about the harness, not N facts about N skills.
 *
 * MEASURED 2026-08-28: the shape's premise — that this state is "Rare" — does not
 * hold. A fixture where every skill carried a naive `disallowed-tools: WebFetch`
 * printed the same ~450-character paragraph ten times (~4,500 chars into the
 * terminal report).
 */
describe("ineffective-fence collapse", () => {
  const fence = (name: string) => ({
    path: `skills/${name}/SKILL.md`,
    kind: "skill" as const,
    name,
    finding: {
      severity: "advisory" as const,
      fence: "ineffective" as const,
      message: "`disallowed-tools: WebFetch` closes no lethal-trifecta leg — …",
    },
  });

  it("names them individually while there are few", () => {
    const s = auditScore(
      makeReport({
        trifectaFindings: [
          fence("alpha"),
          fence("beta"),
        ] as unknown as ScanReport["trifectaFindings"],
      }),
    );
    const found = cat(s, "Safety")?.findings ?? [];
    expect(found.some((f) => f.startsWith("alpha:"))).toBe(true);
    expect(found.some((f) => f.startsWith("beta:"))).toBe(true);
  });

  it("collapses into ONE line past the threshold, keeping every name", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const s = auditScore(
      makeReport({
        trifectaFindings: names.map(
          fence,
        ) as unknown as ScanReport["trifectaFindings"],
      }),
    );
    const found = cat(s, "Safety")?.findings ?? [];
    // One aggregate line, not six per-skill ones.
    expect(
      found.filter((f) => /closes no lethal-trifecta leg/.test(f)),
    ).toHaveLength(1);
    // Nothing is lost — every skill is still named in it.
    const line =
      found.find((f) => /closes no lethal-trifecta leg/.test(f)) ?? "";
    for (const n of names) expect(line).toContain(n);
    // And the repetition is gone: the old shape was ~450 chars × 6.
    expect(line.length).toBeLessThan(900);
  });
});
