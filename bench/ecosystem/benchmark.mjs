/**
 * A1 — the ecosystem benchmark v0: A/B every skill in the manifest over the
 * neutral coding corpus and report the metric triple (bill / target / blast
 * radius), leading with the debunks (claimed ≫ measured).
 *
 * This is the generalized loop the caveman investigation validated on ONE skill
 * (the corrected canonical run in bench/ecosystem/FINDINGS.md): same
 * A/B-over-one-real-task unit, same whole-session token accounting, same
 * deterministic correctness gate — now over a SET of skills
 * (bench/ecosystem/skills.mjs) on the SAME corpus (bench/corpus/coding-tasks.mjs),
 * so the rows are directly comparable. Skills install the faithful way
 * (--plugin-dir + activation hook), so the treatment actually loads.
 *
 *   PILOT (cheap, do this first — minds the sub bill):
 *     VIGILES_SKILLS=caveman VIGILES_TASKS=2 VIGILES_TRIALS=2 \
 *       node bench/ecosystem/benchmark.mjs
 *
 *   One quality plugin:
 *     VIGILES_SKILLS=superpowers VIGILES_TASKS=2 VIGILES_TRIALS=2 \
 *       node bench/ecosystem/benchmark.mjs
 *
 *   Full v0 sweep (every manifest skill, 5 tasks × 3 trials — EXPENSIVE):
 *     node bench/ecosystem/benchmark.mjs
 *
 * Real model → real cost, on the Pro/Max subscription (apiKeySource:"none").
 * Default model: haiku (cheap v0). VIGILES_MODEL=sonnet for the rigorous pass.
 *
 * Output: an incremental per-skill table (so a timeout still yields partial data)
 * + a final leaderboard + a JSON dump under bench/ecosystem/results/ (the held
 * data; no report is published from here — the writeup is a separate, gated step).
 *
 * See research/benchmark-methodology.md (the method) and
 * research/measurement-authority.md (why this is the viral artifact).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runEval } from "../../dist/eval.js";
import { CODING_TASKS } from "../corpus/coding-tasks.mjs";
import { selectSkills } from "./skills.mjs";

const trials = Number(process.env.VIGILES_TRIALS || 3);
const taskLimit = Number(process.env.VIGILES_TASKS || 5);
const model = process.env.VIGILES_MODEL || "haiku";
const concurrency = Number(process.env.VIGILES_CONCURRENCY || 4);

const SKILLS = selectSkills(process.env.VIGILES_SKILLS);
// VIGILES_TASK_NAMES (comma list) targets specific tasks by name (e.g. the heavy
// `review-doc` task for a focused sonnet pass); else the first `taskLimit` tasks.
const TASKS = process.env.VIGILES_TASK_NAMES
  ? (() => {
      const want = new Set(
        process.env.VIGILES_TASK_NAMES.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      return CODING_TASKS.filter((t) => want.has(t.name));
    })()
  : CODING_TASKS.slice(0, taskLimit);

if (TASKS.length === 0) {
  console.error(
    `No tasks matched VIGILES_TASK_NAMES=${process.env.VIGILES_TASK_NAMES}. ` +
      `Known: ${CODING_TASKS.map((t) => t.name).join(", ")}.`,
  );
  process.exit(1);
}

if (SKILLS.length === 0) {
  console.error(
    `No skills matched VIGILES_SKILLS=${process.env.VIGILES_SKILLS}. ` +
      `Known ids: see bench/ecosystem/skills.mjs.`,
  );
  process.exit(1);
}

// usage fields are optional per harness/model; default missing to 0.
const u = (ctx, k) => Number(ctx.usage?.[k] ?? 0);
const pct = (from, to) => (from > 0 ? ((from - to) / from) * 100 : 0);
const whole = (m) => m.inputTokens + m.outputTokens + m.cacheTokens;

console.log(
  `\n=== vigiles ecosystem benchmark v0 (model: ${model}, ` +
    `${SKILLS.length} skill(s) × ${TASKS.length} task(s) × ${trials} trial(s)) ===`,
);
console.log(
  "Metric triple: BILL (cost$) · TARGET (output tokens) · BLAST RADIUS (correctness).\n",
);

let runningCost = 0;
const leaderboard = [];

// Restart-resilient output: write the JSON after EVERY skill, not just at the end,
// so a container restart mid-run leaves a valid partial file (completed skills) to
// analyze instead of nothing. Same path the whole run, overwritten as it grows.
const outDir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = `${outDir}${stamp}_${model}.json`;
const dumpJson = () =>
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        model,
        trials,
        tasks: TASKS.map((t) => t.name),
        runningCost,
        leaderboard,
      },
      null,
      2,
    ),
  );

for (const skill of SKILLS) {
  console.log(
    `\n### ${skill.title}  [${skill.category}]  — ${skill.source}` +
      (skill.stars ? `  (${skill.stars.toLocaleString()}★)` : ""),
  );
  console.log(`    claim: ${skill.claim.text}`);
  console.log(
    "    task            out_base  out_skl  out_cut%   $_base   $_skl  cost_cut%  out%sess  correct(b/s)",
  );

  let sumOutCut = 0,
    sumCostCut = 0,
    sumOutShare = 0,
    anyRegress = false,
    taskN = 0;
  const taskRows = [];

  for (const t of TASKS) {
    let report;
    try {
      report = await runEval({
        name: `ecosystem: ${skill.id}/${t.name}`,
        env: { kind: "ephemeral" },
        fixture: { ...t.files }, // both arms get the task seed
        arms: {
          baseline: {}, // task only
          skill: skill.arm, // + SKILL.md (files) OR --plugin-dir (pluginDir)
        },
        task: t.task,
        measure: (ctx) => ({
          inputTokens: u(ctx, "inputTokens"),
          outputTokens: u(ctx, "outputTokens"),
          cacheTokens:
            u(ctx, "cacheReadTokens") + u(ctx, "cacheCreationTokens"),
          costUsd: u(ctx, "costUsd"), // the honest bill (cache ~0.1×, output 1×)
          correct: t.check(ctx),
        }),
        trials,
        model,
        concurrency,
      });
    } catch (e) {
      console.log(`    ${t.name.padEnd(15)} ERROR: ${e.message}`);
      continue;
    }
    runningCost += report.totalCostUsd;
    const b = report.arms.baseline.metrics;
    const s = report.arms.skill.metrics;
    // Per-metric mean/std/se/n/passK from the harness — the CONFIDENCE the means
    // alone hide. We persist the full MetricStat records so the archived JSON is
    // "readily shareable with the article details": a reader can put an error bar
    // on every number and see whether an A/B gap clears the noise floor.
    const bStats = report.arms.baseline.stats ?? {};
    const sStats = report.arms.skill.stats ?? {};
    const se = (stats, k) => Number(stats?.[k]?.se ?? 0);

    const outCut = pct(b.outputTokens, s.outputTokens);
    const costCut = pct(b.costUsd, s.costUsd);
    const outShare = whole(b) > 0 ? (b.outputTokens / whole(b)) * 100 : 0;
    const regress = s.correct < b.correct;
    sumOutCut += outCut;
    sumCostCut += costCut;
    sumOutShare += outShare;
    if (regress) anyRegress = true;
    taskN++;
    taskRows.push({
      task: t.name,
      baseline: b,
      skill: s,
      baselineStats: bStats, // full mean/std/se/n/passK per metric (both arms)
      skillStats: sStats,
      outCut,
      costCut,
      outShare,
      regress,
    });

    console.log(
      `    ${t.name.padEnd(15)} ${b.outputTokens.toFixed(0).padStart(8)} ` +
        `${s.outputTokens.toFixed(0).padStart(8)} ${outCut.toFixed(0).padStart(7)}%  ` +
        `${b.costUsd.toFixed(4).padStart(7)} ${s.costUsd.toFixed(4).padStart(7)} ` +
        `${costCut.toFixed(0).padStart(8)}%  ${outShare.toFixed(1).padStart(7)}%   ` +
        `${b.correct.toFixed(1)}/${s.correct.toFixed(1)}`,
    );
    // A second, quieter line: the ±1se error bars on the two absolute numbers the
    // article leans on (output tokens, dollars), per arm, over n trials. If the
    // arms' bars overlap, the "cut" is inside the noise — say so with the data.
    console.log(
      `      ${"".padEnd(13)} out ±se  base ${se(bStats, "outputTokens").toFixed(0)}` +
        ` / skill ${se(sStats, "outputTokens").toFixed(0)}   ·   ` +
        `$ ±se  base ${se(bStats, "costUsd").toFixed(4)}` +
        ` / skill ${se(sStats, "costUsd").toFixed(4)}   (n=${trials})`,
    );
  }

  const n = taskN || 1;
  const meanOutCut = sumOutCut / n;
  const meanCostCut = sumCostCut / n;
  const meanOutShare = sumOutShare / n;
  const claimGap =
    skill.claim.pct != null ? skill.claim.pct - meanOutCut : null;

  // ---- Per-task SPREAD: the mean hides that a skill can help on one task and
  // HURT on another (the real caveman finding: review-doc −45% / debounce −1%).
  // Surface min/max + the help/hurt split instead of collapsing to one number.
  const cuts = taskRows.map((r) => r.outCut);
  const outCutMin = cuts.length ? Math.min(...cuts) : 0;
  const outCutMax = cuts.length ? Math.max(...cuts) : 0;
  const helped = cuts.filter((c) => c > 0).length;
  const hurt = cuts.filter((c) => c < 0).length;
  const mixed = helped > 0 && hurt > 0; // direction is not even consistent

  leaderboard.push({
    id: skill.id,
    title: skill.title,
    category: skill.category,
    claim: skill.claim,
    meanOutCut,
    meanCostCut,
    meanOutShare,
    outCutMin,
    outCutMax,
    helped,
    hurt,
    mixed,
    claimGap,
    anyRegress,
    tasks: taskRows,
  });
  dumpJson(); // persist after each skill (restart-resilient)

  console.log(
    `    -> mean output cut ${meanOutCut.toFixed(0)}%  ·  ` +
      `mean cost cut ${meanCostCut.toFixed(0)}%  ·  ` +
      `output share ${meanOutShare.toFixed(1)}%  ·  ` +
      `correctness regression: ${anyRegress ? "YES" : "no"}` +
      `\n    -> per-task output cut spread ${outCutMin.toFixed(0)}%..${outCutMax.toFixed(0)}% ` +
      `(helped ${helped}/${taskN}, hurt ${hurt}/${taskN}${mixed ? " — MIXED direction" : ""})` +
      (claimGap != null
        ? `\n    -> CLAIM ${skill.claim.pct}% vs MEASURED ${meanOutCut.toFixed(0)}% on the target ` +
          `=> overclaim gap ${claimGap.toFixed(0)} points`
        : ""),
  );
  console.log(`    (running bill so far: $${runningCost.toFixed(4)})`);
}

// ---- Leaderboard: debunks first (largest overclaim gap), then quality by cost ----
const debunks = leaderboard
  .filter((r) => r.claimGap != null)
  .sort((a, b) => b.claimGap - a.claimGap);
const quality = leaderboard
  .filter((r) => r.claimGap == null)
  .sort((a, b) => a.meanCostCut - b.meanCostCut); // most cost ADDED first (most negative cut)

console.log("\n\n========== LEADERBOARD (v0) ==========");
if (debunks.length) {
  console.log("\n-- Debunks (a published % claim vs what we measured) --");
  for (const r of debunks) {
    const verdict =
      r.meanOutCut < r.claim.pct * 0.5
        ? "DEBUNKED"
        : r.meanOutCut < r.claim.pct
          ? "overstated"
          : "held up";
    console.log(
      `  ${r.title.padEnd(22)} claim ${String(r.claim.pct + "%").padStart(4)} · ` +
        `measured ${r.meanOutCut.toFixed(0).padStart(4)}% (range ${r.outCutMin.toFixed(0)}..${r.outCutMax.toFixed(0)}%${r.mixed ? ", MIXED" : ""}) · ` +
        `bill ${r.meanCostCut >= 0 ? "-" : "+"}${Math.abs(r.meanCostCut).toFixed(0)}% · ` +
        `${r.anyRegress ? "BROKE correctness" : "no regression"} · ${verdict}`,
    );
  }
}
if (quality.length) {
  console.log(
    "\n-- Quality plugins (no single % claim — the bill they add on neutral tasks) --",
  );
  for (const r of quality) {
    console.log(
      `  ${r.title.padEnd(22)} bill ${r.meanCostCut >= 0 ? "-" : "+"}${Math.abs(
        r.meanCostCut,
      ).toFixed(0)}% · ` +
        `output ${r.meanOutCut >= 0 ? "-" : "+"}${Math.abs(r.meanOutCut).toFixed(0)}% · ` +
        `${r.anyRegress ? "BROKE correctness" : "no regression"}`,
    );
  }
}
console.log(`\nTotal measured bill: $${runningCost.toFixed(4)}`);

// ---- Hold the data: final dump (already written incrementally per skill above) ----
dumpJson();
console.log(`\nData held at: ${outFile.replace(process.cwd() + "/", "")}`);
console.log(
  "(v0 engine — no report published from here; the writeup is a separate gated step.)",
);
