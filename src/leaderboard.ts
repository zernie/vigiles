/**
 * Plugin health leaderboard — rank many plugins by the deterministic structural
 * signals `scan` already computes (research/divergent-bets.md #9, the engine).
 *
 * This is the no-model half: a defensible health score from concrete facts
 * (missing hook scripts, skills that can't trigger, agents with no tool
 * contract, untested surfaces). It deliberately does NOT score on the loader's
 * free-text warnings — those include doc-mention false positives (see
 * src/scan.ts), and a ranking that penalizes a prose mention would be unfair.
 * The behavioural columns (real trigger-rate, observed egress, safety) need a
 * model and stack on top later; this part runs anywhere in CI for free.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { scanPlugin } from "./scan.js";
import { detectAdapter } from "./adapter-registry.js";
// The pure, node-free scoring core lives in ./score-core.js (extracted so the
// in-browser audit's report builder can import scoring WITHOUT this module's
// node-only scanPlugin/pluginLabel → scan.ts → @ast-grep/napi chain). Re-exported
// here so every existing `from "./leaderboard.js"` consumer keeps working.
import { type PluginScore, gradeFor, scoreReport } from "./score-core.js";
export {
  type PluginScore,
  type Deduction,
  W_MISSING_HOOK,
  W_NO_DESCRIPTION,
  W_DANGLING_REF,
  W_OVERLAP,
  W_NO_CONTRACT,
  W_TRIFECTA,
  gradeFor,
  reportDeductions,
  isEmptyMachine,
  computeIntegrityScore,
  scoreReport,
} from "./score-core.js";

/** The plugin's declared name (`.claude-plugin/plugin.json`), for a real label in
 * the ranking instead of a SHA-pinned dir basename. Falls back to the basename. */
function pluginLabel(dir: string): string {
  const p = join(dir, ".claude-plugin", "plugin.json");
  if (existsSync(p)) {
    try {
      const name = (JSON.parse(readFileSync(p, "utf-8")) as { name?: string })
        .name;
      if (typeof name === "string" && name.length > 0) return name;
    } catch {
      // fall through to the basename
    }
  }
  return basename(dir) || dir;
}

/**
 * Scan + score each directory, ranked best-first (ties broken by name).
 *
 * 🔴 PER-DIRECTORY HARNESS DETECTION, because a leaderboard is a list of OTHER
 * people's repos and they do not all target the same harness. `vigiles audit` on
 * ONE target resolves the adapter (`resolveHarnessSelection`) and threads
 * `adapter.layout` into `scanPlugin`; the multi-target branch of the same command
 * called `scanPlugin(dir)` bare, so every Codex plugin in a board was scanned with
 * the Claude Code layout — no surfaces found, nothing to deduct, and it ranked at
 * the TOP. A silent zero reads as a perfect score.
 *
 * Detection only (no `--harness=`/config override): the flag and the config key
 * describe the repo the user is standing in, not the N vendored directories being
 * compared, so forcing one harness onto all of them would be the same bug wearing
 * a different hat.
 */
export function rankPlugins(dirs: readonly string[]): PluginScore[] {
  const scored = dirs.map((dir) => {
    const adapter = detectAdapter(dir);
    const report = scanPlugin(dir, adapter.layout, adapter.dialect);
    const { score, issues } = scoreReport(report);
    return {
      dir,
      name: pluginLabel(dir),
      score,
      grade: gradeFor(score),
      issues,
      report,
    };
  });
  return scored.sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  );
}

/**
 * A note for the "all clean" leaderboard — the deterministic axis mostly grades
 * real plugins A/B, and the dramatic failures (skills that don't fire,
 * descriptions that collide) live in the model-gated trigger-rate tier the
 * ranking can't run. So a high-scoring board isn't "found nothing" — it's "the
 * next thing to check needs a model". Shown only when nothing scored below a B
 * (≥80) — a C or worse has a real structural finding to fix first. "" otherwise.
 */
function modelTierNote(scores: readonly PluginScore[]): string {
  if (scores.length === 0) return "";
  const minScore = Math.min(...scores.map((s) => s.score));
  if (minScore < 80) return ""; // there's a real structural finding to fix first
  return (
    "\nAll structurally clean on the deterministic axis — where real plugins usually pass. " +
    "The failures that hide here (do skills FIRE? do descriptions collide?) need the " +
    "model-gated tier: run `npx vigiles audit <dir>` interactively on one."
  );
}

/** Format a ranked leaderboard as human-readable text. */
export function formatLeaderboard(scores: readonly PluginScore[]): string {
  const n = scores.length;
  const out: string[] = [
    // Name the mode so a user who ran `audit ./plugins/*/` and expected one
    // report understands why they got a ranking — and how to drill in.
    `${String(n)} plugin${n === 1 ? "" : "s"} detected → leaderboard mode.`,
    "Ranked by deterministic structural health (no model). Audit a single directory for its full report.",
    "",
    "  #   score  grade  plugin",
  ];
  scores.forEach((s, i) => {
    const rank = String(i + 1).padStart(2);
    const score = String(s.score).padStart(3);
    const issue = s.issues.length > 0 ? ` — ${s.issues.join("; ")}` : "";
    out.push(`  ${rank}  ${score}    ${s.grade}      ${s.name}${issue}`);
  });
  // The drill-in affordance — a local dir has no URL, so the per-plugin "report
  // link" is the command that renders its full report.
  out.push("", "Full report for any plugin: npx vigiles audit <dir>");
  const note = modelTierNote(scores);
  if (note) out.push(note);
  out.push(
    "",
    "Structural health only (no model). Weights: missing hook -15, hard lethal-",
    "trifecta unit -10, no-description skill -10, dead tool/MCP ref -8.",
    "Inherit-all subagents, inherits-all trifecta and untested",
    "surfaces are advisory — shown, not scored.",
  );
  return out.join("\n");
}

const LEADERBOARD_METHOD =
  "_Structural health only (deterministic, no model): missing hook −15, hard " +
  "lethal-trifecta unit −10, no-description skill −10, dead-tool ref −8. " +
  "Inherit-all subagents, inherits-all trifecta and untested surfaces are advisory " +
  "(shown, not scored). Behavioural columns (trigger-rate, collisions, egress) stack on top._";

/**
 * Format a ranked leaderboard as a Markdown table — the PUBLISHABLE form (a README,
 * a gist, the leaderboard site). Shows the top 2 deductions per plugin; the full
 * breakdown is in `--json`. Sibling of the plain-text {@link formatLeaderboard}.
 */
export function formatLeaderboardMarkdown(
  scores: readonly PluginScore[],
): string {
  const lines = [
    `### Plugin health leaderboard (${String(scores.length)} scanned)`,
    "",
    "| # | grade | score | plugin | top issues |",
    "| --: | :--: | --: | :-- | :-- |",
  ];
  scores.forEach((s, i) => {
    const issues =
      s.issues.length > 0 ? s.issues.slice(0, 2).join("; ") : "— clean";
    lines.push(
      `| ${String(i + 1)} | ${s.grade} | ${String(s.score)} | \`${s.name}\` | ${issues} |`,
    );
  });
  const note = modelTierNote(scores);
  if (note) lines.push("", note.trim());
  lines.push("", LEADERBOARD_METHOD);
  return lines.join("\n");
}
