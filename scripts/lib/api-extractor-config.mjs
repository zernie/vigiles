/**
 * The one API Extractor configuration, shared by the surface gate
 * (scripts/api-extractor.mjs) and the test that proves its release-tag gate fails
 * on an untagged export (scripts/api-extractor.test.ts).
 *
 * `ae-missing-release-tag` is an ERROR: every declaration an entry exports carries
 * @public, @beta, @alpha or @internal. See STABILITY.md and the
 * `public-exports-are-opt-in` rule.
 */
import { ExtractorConfig } from "@microsoft/api-extractor";
import path from "node:path";

/**
 * Build an in-memory API Extractor config for one entry (no per-entry JSON).
 * `entry.dts` is relative to `root`; `entry.name` names the report.
 */
export function configFor(root, entry) {
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
      // quirks are non-fatal noise here. Silence parser chatter so
      // the gate reports only real SURFACE changes.
      messages: {
        compilerMessageReporting: { default: { logLevel: "warning" } },
        extractorMessageReporting: {
          default: { logLevel: "none" },
          "ae-missing-release-tag": { logLevel: "error" },
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
