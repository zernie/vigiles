/**
 * The in-browser audit: run the SAME deterministic engine the CLI runs (the built
 * `dist/` code, via the `@engine/*` aliases) over a fetched file map, then build
 * the versioned `AuditReport` the shared `<Report>` renders. This is why the typed
 * result is INDISTINGUISHABLE in authority from the featured baked reports — it IS
 * the real artifact, computed client-side (`node:zlib` → pako is the one swap).
 */
import { scanFiles } from "@engine/scan-files";
import { buildAuditReport } from "@engine/audit-report";
import { applyRules } from "@engine/core/apply-rules";
import { defaultSeverities } from "@engine/core/rule";
import { ruleResolver } from "@engine/overrides";
import { RULES, RULE_GROUPS } from "@engine/rules/index";
import type { AuditReport } from "@vigiles/report-view";
import type { RepoFiles } from "./fetchRepo";

/** Cosmetic only — not rendered by `<Report>`; the live compute has no CLI version. */
const VIGILES_VERSION = "live";

/**
 * Produce the `AuditReport` for a fetched repo. `meta.dir` is overridden to the
 * `owner/repo` slug so the report header reads as THEIR repo (the engine roots at
 * a synthetic `BROWSER_ROOT`, which would otherwise show as the dir name).
 */
export function runAudit(files: RepoFiles, slug: string): AuditReport {
  // Pass the repo name so a nameless root SKILL.md is labeled after the repo (as
  // the CLI does from the dir basename), not the synthetic BROWSER_ROOT.
  const repoName = slug.split("/")[1];
  const report = scanFiles(files, undefined, undefined, repoName);
  // A composition root, like the CLI: it hands the shipped rule set to the
  // engine. The browser has no `.vigilesrc.json`, so every rule sits at its
  // shipped default.
  const shown = applyRules(
    RULES,
    RULE_GROUPS,
    ruleResolver(defaultSeverities(RULES)),
    report,
  );
  const audit = buildAuditReport(shown, {
    harness: "claude-code",
    vigilesVersion: VIGILES_VERSION,
  });
  // buildAuditReport's output is the engine's AuditReport; it's the SAME JSON shape
  // `@vigiles/report-view`'s schema mirrors, so the cast is structural, not a lie.
  return {
    ...audit,
    meta: { ...audit.meta, dir: slug },
  } as unknown as AuditReport;
}
