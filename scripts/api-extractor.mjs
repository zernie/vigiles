/**
 * API Extractor driver — the public-API surface gate.
 *
 * Runs Microsoft API Extractor over EVERY public entry point in package.json
 * `exports` and writes a committed surface report per entry under `api-surface/`. Two
 * modes:
 *
 *   node scripts/api-extractor.mjs --local   # regenerate the reports (after an
 *                                            # intentional API change)
 *   node scripts/api-extractor.mjs           # CI gate: FAIL if the live surface
 *                                            # drifts from the committed report
 *
 * The committed `api-surface/*.api.md` files are the contract — a PR that adds/removes/
 * changes a public export shows up as a report diff, so the surface can't
 * silently regrow (the reason this exists; see research/roadmap.md). The
 * `temp/*.api.json` doc models feed `npm run docs:api` (API Documenter →
 * api-reference/, a gitignored derived artifact). Pure Node, no per-entry configs.
 */
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One report per public entry point, keyed by the report name; `dts` is the
// built type-entry the export maps to. Every subpath now resolves to its own
// module — the old aliasing (`.` + `./spec` on one file, `./e2e` on
// `./integration`) is gone, so the map here is 1:1 with package.json `exports`.
const ENTRIES = [
  { name: "vigiles", dts: "dist/test.d.ts" }, // "." — the free testing surface
  { name: "vigiles-spec", dts: "dist/core/spec.d.ts" }, // "./spec"
  { name: "vigiles-eval", dts: "dist/eval-surface.d.ts" }, // "./eval" — spends money
  { name: "vigiles-linting", dts: "dist/linting.d.ts" },
  { name: "vigiles-rule-proof", dts: "dist/entries/rule-proof.d.ts" },
  { name: "vigiles-hook", dts: "dist/hook.d.ts" },
  { name: "vigiles-claude-code", dts: "dist/claude-code.d.ts" },
  { name: "vigiles-codex", dts: "dist/codex.d.ts" },
  { name: "vigiles-adapter", dts: "dist/adapter.d.ts" },
  { name: "vigiles-vitest", dts: "dist/vitest.d.mts" },
  { name: "vigiles-jest", dts: "dist/jest.d.ts" },
];

// 🔴 THIS LIST IS HAND-MAINTAINED, so it can drift from `package.json` exports —
// and a drift in one direction is INVISIBLE without this assertion. Measured
// 2026-08-21: the `./experimental` subpath was deleted and its entry left here,
// and the gate reported "API surface verified for 11 entries — no drift",
// because `tsc` does not clean `dist/` and the previous build's
// `dist/experimental.d.ts` was still on disk. A green gate reading a file no
// build produces any more is the exact failure shape this repo keeps finding in
// other people's harnesses.
{
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const subpaths = Object.keys(pkg.exports).sort();
  const covered = ENTRIES.map((e) =>
    e.name === "vigiles" ? "." : "./" + e.name.replace(/^vigiles-/, ""),
  ).sort();
  const missing = subpaths.filter((s) => !covered.includes(s));
  const extra = covered.filter((c) => !subpaths.includes(c));
  if (missing.length || extra.length) {
    console.error(
      "api-extractor: ENTRIES is out of step with package.json exports.\n" +
        (missing.length
          ? `  exported but UNREPORTED: ${missing.join(", ")}\n`
          : "") +
        (extra.length
          ? `  reported but NOT exported: ${extra.join(", ")}\n`
          : "") +
        "  Fix ENTRIES in this file, and delete any orphaned api-surface/*.api.md.",
    );
    process.exit(1);
  }
}

const localBuild = process.argv.includes("--local");

/** Build an in-memory API Extractor config for one entry (no per-entry JSON). */
function configFor(entry) {
  return ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: path.join(root, entry.dts),
      compiler: { tsconfigFilePath: path.join(root, "tsconfig.json") },
      apiReport: {
        enabled: true,
        reportFolder: path.join(root, "api-surface"),
        reportFileName: `${entry.name}.api.md`,
        reportTempFolder: path.join(root, "temp"),
      },
      docModel: {
        enabled: true,
        apiJsonFilePath: path.join(root, "temp", `${entry.name}.api.json`),
      },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      // The repo's TSDoc comments predate API Extractor; their `>`/backtick/brace
      // quirks are non-fatal noise here. Silence parser + release-tag chatter so
      // the gate reports only real SURFACE changes.
      messages: {
        compilerMessageReporting: { default: { logLevel: "warning" } },
        extractorMessageReporting: {
          default: { logLevel: "none" },
          "ae-missing-release-tag": { logLevel: "none" },
        },
        tsdocMessageReporting: { default: { logLevel: "none" } },
      },
    },
    // A virtual config path — the file need not exist; only its directory is used
    // to resolve the (already-absolute) tokens above.
    configObjectFullPath: path.join(
      root,
      "config",
      `api-extractor.${entry.name}.json`,
    ),
    packageJsonFullPath: path.join(root, "package.json"),
    // Give each entry a DISTINCT package identity (every export otherwise reports
    // as "vigiles", which collides when API Documenter merges the doc models into
    // one reference site). The name is cosmetic — it only labels the report/page.
    packageJson: { name: entry.name, version: "1.0.0" },
  });
}

let failed = 0;
for (const entry of ENTRIES) {
  const result = Extractor.invoke(configFor(entry), {
    localBuild,
    showVerboseMessages: false,
  });
  if (!result.succeeded) {
    failed += 1;
    if (!localBuild && result.apiReportChanged) {
      console.error(
        `✗ ${entry.name}: public API surface changed vs api-surface/${entry.name}.api.md — ` +
          `run \`npm run api:report\`, review the diff, and commit it if intended.`,
      );
    }
  }
}

if (failed > 0) {
  console.error(`\nAPI Extractor: ${String(failed)} entr(y/ies) failed.`);
  process.exit(1);
}
console.log(
  localBuild
    ? `API surface reports regenerated for ${String(ENTRIES.length)} entries (api-surface/*.api.md).`
    : `API surface verified for ${String(ENTRIES.length)} entries — no drift.`,
);
