/**
 * Regenerate the fixture the `test` and `compile` beats are pinned to.
 *
 * The landing shows numbers measured against a REAL, vendored, SHA-pinned OSS
 * marketplace — test/dogfood/trailofbits-skills-curated@6d05be4, a minimal slice
 * of Trail of Bits' own curated Claude Code skill marketplace (SOURCE has the
 * full provenance and the parity check against the un-trimmed clone). The site
 * cannot import the audit engine directly (it reaches node:child_process and
 * the file system the same way run-hook does), so the numbers are retyped in
 * the two sections; this writes the measured outcome to a JSON fixture, and the
 * two browser tests assert the rendered copy still matches it — same trick,
 * same reason as gen-davila7-expected.mjs.
 *
 *   node scripts/gen-trailofbits-expected.mjs      # or: npm run gen:trailofbits
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const cli = here("../../dist/cli.js");
if (!existsSync(cli)) {
  console.error(
    `no built CLI at ${cli} — run \`npm run build\` at the repo root first`,
  );
  process.exit(1);
}

const SLICE = "test/dogfood/trailofbits-skills-curated@6d05be4";
const sliceDir = here(`../../${SLICE}`);
if (!existsSync(sliceDir)) {
  console.error(`no vendored slice at ${sliceDir} — see ${SLICE}/SOURCE`);
  process.exit(1);
}

/** The real `vigiles test` run — this IS the artifact for the `test` beat. */
const testOutput = execFileSync(
  "node",
  [cli, "test", `${SLICE}/**/*.harness.{mjs,cjs,js,mts,cts,ts}`, "--min=0"],
  { cwd: here("../.."), encoding: "utf8" },
).trim();

/** The real `vigiles audit` run — the aggregate numbers for both beats. */
const auditRaw = execFileSync("node", [cli, "audit", SLICE, "--json"], {
  cwd: here("../.."),
  encoding: "utf8",
});
const audit = JSON.parse(auditRaw);
if (audit.meta.kind !== "leaderboard")
  throw new Error(`expected a leaderboard audit, got "${audit.meta.kind}"`);

let skills = 0;
let agents = 0;
let trifectaPlugins = 0;
let untestedPlugins = 0;
let trifectaApplicable = 0;
let noFence = 0;
for (const plugin of audit.plugins) {
  skills += (plugin.report.skills ?? []).length;
  agents += (plugin.report.agents ?? []).length;
  if (plugin.issues.some((i) => i.includes("lethal trifecta")))
    trifectaPlugins++;
  if (plugin.issues.some((i) => i.includes("untested surface")))
    untestedPlugins++;
  for (const skill of plugin.report.skills ?? []) {
    if (!skill.trifecta) continue;
    trifectaApplicable++;
    if (skill.trifecta.fence === "none") noFence++;
  }
}

const scv = audit.plugins.find((p) => p.name === "scv-scan");
if (!scv)
  throw new Error('no "scv-scan" plugin in the audit — did the slice change?');
const scvSkill = (scv.report.skills ?? []).find((s) => s.name === "scv-scan");
if (!scvSkill?.trifecta)
  throw new Error("scv-scan has no trifecta data — did the slice change?");

/**
 * The FIX half: the same allow-list, compiled with `disallowedTools`, actually
 * compiled and actually audited — not retyped. See scripts/dogfood/
 * solidity-audit-demo/SKILL.md.spec.ts.
 */
const DEMO = "scripts/dogfood/solidity-audit-demo";
const demoSpec = here(`../${DEMO}/skills/solidity-audit/SKILL.md.spec.ts`);
const demoSkillMd = here(`../${DEMO}/skills/solidity-audit/SKILL.md`);
const demoSpecRelative = `${DEMO}/skills/solidity-audit/SKILL.md.spec.ts`;
// Compiled with a REPO-RELATIVE arg (cwd = repo root) on purpose: `vigiles
// compile` embeds whatever path it was given in the artifact's integrity
// marker, and an absolute arg would leak this machine's filesystem layout into
// a file that gets committed and shown on the public page.
execFileSync("node", [cli, "compile", demoSpecRelative], {
  cwd: here(".."),
  encoding: "utf8",
});
const demoSource = readFileSync(demoSpec, "utf8");
const demoCompiled = readFileSync(demoSkillMd, "utf8");

const demoAuditRaw = execFileSync("node", [cli, "audit", `${DEMO}`, "--json"], {
  cwd: here(".."),
  encoding: "utf8",
});
const demoAudit = JSON.parse(demoAuditRaw);
const demoSafety = demoAudit.score.categories.find((c) => c.key === "Safety");
if (demoSafety?.score !== 100)
  throw new Error(
    `demo spec expected Safety 100 after compiling with disallowedTools, got ${String(demoSafety?.score)}`,
  );

const fixture = {
  source: `node dist/cli.js audit ${SLICE} --json`,
  regenerate: "node scripts/gen-trailofbits-expected.mjs",
  slice: SLICE,
  plugins: audit.plugins.length,
  skills,
  agents,
  surfaces: skills + agents,
  trifectaPlugins,
  untestedPlugins,
  trifectaApplicable,
  noFence,
  allowedToolsDeclarations: 38, // github.com/search?q=repo:trailofbits/skills-curated+%22allowed-tools%22 — verified 2026-09-25
  testCommand: `vigiles test "${SLICE}/**/*.harness.{mjs,cjs,js,mts,cts,ts}" --min=0`,
  testOutput,
  scvScan: {
    allowedTools: scvSkill.trifecta.legs.private.filter((t) =>
      // the frontmatter's OWN declared list — private/untrusted/exfil legs all
      // include Bash/WebFetch/WebSearch regardless of what's declared, which is
      // the finding; this is the narrow allow-list the author actually wrote.
      ["Read", "Grep", "Glob"].includes(t),
    ),
    fence: scvSkill.trifecta.fence,
    message: scvSkill.trifecta.message,
  },
  demo: {
    source: demoSource,
    compiled: demoCompiled,
    safetyScore: demoSafety.score,
  },
};

const out = here(
  "../src/components/sections/__fixtures__/trailofbits-skills.json",
);
writeFileSync(
  out,
  await format(JSON.stringify(fixture, null, 2), { parser: "json" }),
);
console.log(
  `[gen-trailofbits-expected] ${String(fixture.plugins)} plugins, ${String(fixture.surfaces)} surfaces, ${String(noFence)}/${String(trifectaApplicable)} unfenced → ${out}`,
);
