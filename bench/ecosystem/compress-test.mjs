/**
 * caveman-compress input-token test — the FAIR companion to the output benchmark.
 *
 * Caveman doesn't only shrink output; it ships `/caveman-compress`, which rewrites a
 * memory file (CLAUDE.md, todos, preferences) into caveman-speak and claims to cut
 * ~46% of the file's INPUT tokens "every session after". Input is a bigger slice of
 * the bill than output, so this is caveman's stronger, fairer lever — and it deserves
 * the same metric triple, not a hand-wave.
 *
 * We A/B the SAME task under two project-memory files: the verbose conventions doc
 * vs a faithful caveman-compressed version that keeps every rule + all code (the
 * steelman compression — exactly what the skill claims: "preserves all technical
 * substance"). Then we measure THREE things, not one:
 *   1. the file reduction itself (does it hit ~46%?),
 *   2. the real session bill (input + cache + cost — is the saving meaningful once
 *      the memory file is a sliver of a session's cache-read pile?),
 *   3. rule ADHERENCE — the blast radius: does a terser, article-stripped instruction
 *      file make the agent obey the conventions LESS reliably? A cheaper memory file
 *      that the model follows worse is a false saving.
 *
 *   VIGILES_TRIALS=5 VIGILES_MODEL=sonnet node bench/ecosystem/compress-test.mjs
 *
 * Real model, on the subscription ($0 metered). Raw JSON dumped for the article.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runEval } from "../../dist/eval.js";
import { welchTTest } from "../../dist/stats.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const verbose = readFileSync(here("./compress/CLAUDE.verbose.md"), "utf-8");
const caveman = readFileSync(here("./compress/CLAUDE.caveman.md"), "utf-8");

const trials = Number(process.env.VIGILES_TRIALS || 5);
const model = process.env.VIGILES_MODEL || "sonnet";
const concurrency = Number(process.env.VIGILES_CONCURRENCY || 4);

// rough token estimate for the file-reduction headline (the real per-run token
// counts come from the model usage below; this is just the "size of the file" claim).
const estTokens = (s) => Math.round(s.length / 4);

// The five conventions the memory file states — each deterministically checkable in
// the written money.js. adherence = fraction followed (the blast-radius signal).
const RULES = [
  { id: "both-fns", ok: (f) => /addTax/.test(f) && /applyDiscount/.test(f) },
  { id: "jsdoc", ok: (f) => /@param/.test(f) && /@returns/.test(f) },
  { id: "range-error", ok: (f) => /throw new RangeError/.test(f) },
  {
    id: "commonjs",
    ok: (f) =>
      /module\.exports/.test(f) &&
      !/\bexport\s+(const|function|default|\{)/.test(f),
  },
  { id: "no-console", ok: (f) => !/console\.log/.test(f) },
];

const u = (ctx, k) => Number(ctx.usage?.[k] ?? 0);
const task =
  "Read CLAUDE.md — the project conventions. Then create money.js with two exported " +
  "functions: `addTax(cents, ratePct)` returns the amount plus tax rounded to whole " +
  "cents, and `applyDiscount(cents, pct)` returns the amount minus a percentage rounded " +
  "to whole cents. Follow EVERY convention in CLAUDE.md. Stop when money.js is written.";

const measure = (ctx) => {
  const f = ctx.file("money.js") ?? "";
  const passed = RULES.filter((r) => r.ok(f)).length;
  return {
    inputTokens: u(ctx, "inputTokens"),
    cacheTokens: u(ctx, "cacheReadTokens") + u(ctx, "cacheCreationTokens"),
    costUsd: u(ctx, "costUsd"),
    adherence: passed / RULES.length, // 0..1 — the blast radius
    followedAll: passed === RULES.length ? 1 : 0,
  };
};

console.log(
  `\n=== caveman-compress input test (model: ${model}, ${trials} trials/arm) ===`,
);
console.log(
  `File size: verbose ${verbose.length} chars (~${estTokens(verbose)} tok) → ` +
    `caveman ${caveman.length} chars (~${estTokens(caveman)} tok) = ` +
    `${(((verbose.length - caveman.length) / verbose.length) * 100).toFixed(0)}% smaller file ` +
    `(claim: ~46% input-token cut).\n`,
);

const report = await runEval({
  name: "caveman-compress: verbose vs compressed memory",
  env: { kind: "ephemeral" },
  fixture: {},
  arms: {
    verbose: { files: { "CLAUDE.md": verbose } },
    compressed: { files: { "CLAUDE.md": caveman } },
  },
  task,
  measure,
  trials,
  model,
  concurrency,
});

const A = report.arms.verbose,
  B = report.arms.compressed;
const cmp = (m) =>
  welchTTest(
    { mean: B.stats[m].mean, se: B.stats[m].se, n: B.stats[m].n },
    { mean: A.stats[m].mean, se: A.stats[m].se, n: A.stats[m].n },
  );
const pct = (a, b) => (a > 0 ? ((a - b) / a) * 100 : 0);
const row = (label, m, unit = "") => {
  const c = cmp(m);
  console.log(
    `  ${label.padEnd(16)} verbose ${A.metrics[m].toFixed(unit === "$" ? 4 : 2).padStart(9)}` +
      ` → compressed ${B.metrics[m].toFixed(unit === "$" ? 4 : 2).padStart(9)}` +
      `   Δ ${pct(A.metrics[m], B.metrics[m]) >= 0 ? "-" : "+"}${Math.abs(pct(A.metrics[m], B.metrics[m])).toFixed(0)}%` +
      `   ${c.pValue < 0.05 ? `p=${c.pValue.toFixed(3)}*` : `p=${c.pValue.toFixed(2)}`}`,
  );
};
console.log("Per-run session cost (the number you actually pay):");
row("input tokens", "inputTokens");
row("cache tokens", "cacheTokens");
row("cost $", "costUsd", "$");
console.log(
  "Blast radius (did the compressed memory degrade rule-following?):",
);
row("adherence 0-1", "adherence");
row("followed all", "followedAll");

const outDir = here("./results/");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = `${outDir}${stamp}_compress_${model}.json`;
writeFileSync(
  outFile,
  JSON.stringify(
    {
      model,
      trials,
      file: {
        verboseChars: verbose.length,
        cavemanChars: caveman.length,
        verboseEstTokens: estTokens(verbose),
        cavemanEstTokens: estTokens(caveman),
      },
      arms: {
        verbose: { metrics: A.metrics, stats: A.stats },
        compressed: { metrics: B.metrics, stats: B.stats },
      },
    },
    null,
    2,
  ),
);
console.log(`\nData held at: ${outFile.replace(process.cwd() + "/", "")}`);
