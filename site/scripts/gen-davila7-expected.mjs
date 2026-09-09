/**
 * Regenerate the fixture the "does the guard actually block?" section is pinned to.
 *
 * The landing shows THREE rows measured against a REAL, vendored, MIT, SHA-pinned
 * OSS guard (test/dogfood/davila7-force-push-blocker@869640b) plus the count of shell
 * re-spellings it withstands. The site cannot import the engine that produces them —
 * `verify-plugin-guards` pulls in `run-hook`, which spawns a process, and there is no
 * browser shim for that. So the rows are retyped in the section, and a retyped row is
 * a row that drifts.
 *
 * This writes the measured outcome to a JSON fixture; the browser test asserts the
 * rendered rows still match it. Same shape and the same reason as
 * gen-battery-expected.mjs, and it runs in the same `pretest:browser` step so CI
 * regenerates BEFORE asserting — a change in the vendored slice or in the engine
 * fails the test instead of passing quietly.
 *
 * WHY THIS PLUGIN. Its hook command is a bare `echo` of a deny decision, so a checker
 * that merely pipes commands through it certifies it as blocking `rm -rf /` and
 * `cat ~/.ssh/id_rsa` too. The honest reading is that Claude Code would never invoke
 * it for those, because its `if:` condition is `Bash(git push *--force*)`. This
 * fixture carries BOTH halves — what it really blocks, and what it is never asked
 * about — so the page can show a false green being refused.
 *
 *   node scripts/gen-davila7-expected.mjs      # or: npm run gen:davila7
 */
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);

const enginePath = here("../../dist/test.js");
if (!existsSync(enginePath)) {
  console.error(
    `no built engine at ${enginePath} — run \`npm run build\` at the repo root first`,
  );
  process.exit(1);
}
const engine = require(enginePath);
const PLUGIN = "test/dogfood/davila7-force-push-blocker@869640b";
const dir = here(`../../${PLUGIN}`);

const report = engine.experimental_verifyPluginGuards(dir);

/** The three rows the section shows: one real block, two never-asked. */
const WANTED = ["force-push", "rm-rf", "read-ssh-key"];
const byId = new Map();
for (const hook of report.hooks) {
  for (const r of hook.results ?? []) {
    const prev = byId.get(r.event.id);
    // A disaster counts as blocked if ANY declared hook blocked it.
    if (!prev || (r.blocked && !prev.blocked)) byId.set(r.event.id, r);
  }
}
const rows = WANTED.map((id) => {
  const r = byId.get(id);
  if (!r)
    throw new Error(`no measured result for "${id}" — did the catalog change?`);
  return {
    id,
    label: r.event.label,
    command: String(r.event.input.command ?? ""),
    blocked: Boolean(r.blocked),
    ran: Boolean(r.ran),
    reason: String(r.reason ?? ""),
  };
});

/** Fairness half: every shell re-spelling of a force push this guard withstands. */
const forcePush = report.events.filter((e) => e.id.startsWith("force-push"));
const spellings = engine.experimental_alternateSpellings(forcePush);
const all = [...forcePush, ...spellings];
const spellReport = engine.experimental_verifyPluginGuards(dir, {
  events: all,
});
let blockedCount = 0;
const seen = new Set();
for (const hook of spellReport.hooks) {
  for (const r of hook.results ?? []) {
    if (r.blocked) seen.add(r.event.id);
  }
}
blockedCount = seen.size;

const fixture = {
  source: `experimental_verifyPluginGuards("${PLUGIN}")`,
  regenerate: "node scripts/gen-davila7-expected.mjs",
  plugin: PLUGIN,
  rows,
  spellings: { fed: all.length, blocked: blockedCount },
};

const out = here("../src/components/sections/__fixtures__/davila7-guard.json");
writeFileSync(
  out,
  await format(JSON.stringify(fixture, null, 2), { parser: "json" }),
);
console.log(
  `[gen-davila7-expected] ${String(rows.length)} row(s), ${String(blockedCount)}/${String(all.length)} spellings blocked → ${out}`,
);
