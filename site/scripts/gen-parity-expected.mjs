/**
 * Regenerate the browser-parity EXPECTED fixture.
 *
 * Runs the engine in NODE (real `node:zlib`) over the sample file-map and writes
 * the resulting AuditReport — exactly what `runAudit` produces (same vigilesVersion
 * + the meta.dir slug override). The browser-parity test then computes the SAME
 * report in-browser via pako and asserts deep equality: if pako's gzip length ever
 * diverged from node's, the NCD-driven description-overlap grade would differ and
 * this test would fail. Run:  node site/scripts/gen-parity-expected.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { scanFiles } from "../../dist/scan-files.js";
import { buildAuditReport } from "../../dist/audit-report.js";
import { applyRules } from "../../dist/core/apply-rules.js";
import { defaultSeverities } from "../../dist/core/rule.js";
import { ruleResolver } from "../../dist/overrides.js";
import { RULES } from "../../dist/rules/index.js";

const SLUG = "acme/widgets";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const files = JSON.parse(
  readFileSync(
    here("../src/demo/__fixtures__/sample-repo.files.json"),
    "utf-8",
  ),
);

const report = scanFiles(files);
// The same rule set at its defaults that runAudit hands the engine.
const shown = applyRules(RULES, ruleResolver(defaultSeverities(RULES)), report);
const audit = buildAuditReport(shown, {
  harness: "claude-code",
  vigilesVersion: "live",
});
// Mirror runAudit's meta.dir override.
const withSlug = { ...audit, meta: { ...audit.meta, dir: SLUG } };

// Write through PRETTIER, not `JSON.stringify` alone. The repo gates CI on
// `prettier --check .`, and prettier's JSON printer is not `JSON.stringify(…, 2)`
// (it collapses short arrays onto one line). So every regeneration used to leave
// a committed file that fails the format check LATER and far from the cause —
// the same shape as the stale-prebundle defect this fixture's own test hit.
// Formatting here removes the state instead of asking the next person to
// remember a follow-up command. Not `.prettierignore`: the fixture is committed
// and reviewed, so its diffs should look like every other file's.
const out = here("../src/demo/__fixtures__/sample-repo.expected.json");
writeFileSync(
  out,
  await format(JSON.stringify(withSlug, null, 2), {
    parser: "json",
    filepath: out,
  }),
);
console.log(
  `wrote expected: grade ${withSlug.score.grade} (${withSlug.score.overall}), ${withSlug.recommendations.length} recs`,
);
