/**
 * vigiles CLI — verify your agent harness is real, and prove it works.
 *
 * The verbs and their one-liners live in ONE place, `COMMAND_HELP` + `HELP_GROUPS`
 * near the bottom of this file, and `--help` prints from that table. A second list
 * here would be a copy that rots — this docblock WAS that copy: it named four
 * commands and omitted `audit`, `test`, `eval` and `eject`, four of the eight, and
 * `self-command-refs.test.ts` did not catch it because it guards against refs to
 * REMOVED commands, not against a list that merely stops growing.
 */

import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import {
  resolve,
  dirname,
  basename,
  relative,
  isAbsolute,
  sep as pathSep,
  join,
} from "node:path";
import { repoRelative, type RepoRelativePath } from "./core/repo-path.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { globSync } from "glob";
import { excludeSet, type ExcludeSet } from "./exclude.js";
import { generateTypes } from "./core/generate-types.js";
import {
  loadHarnessModel,
  generateHarness,
  computeHarnessCapabilities,
  labelFor,
  HARNESS_GEN_FILENAME,
} from "./core/generate-harness.js";
import {
  diffCapabilities,
  formatCapabilityDiff,
} from "./core/capability-diff.js";
import { validate, loadConfig } from "./core/validate.js";
import {
  anyLocksCommitted,
  evalLockNudge,
  DEFAULT_LOCK_DIR,
  countLocks,
} from "./eval-lock.js";
import { applyConfigFlags } from "./cli-flags.js";
import { VERBS, type Verb } from "./cli-commands.js";
import {
  formatUnknownFlag,
  knownFlagsFor,
  unknownFlags,
} from "./cli-flag-check.js";
import {
  parseSetupArgs,
  shouldPrompt,
  resolvePlan,
  planPluginInstall,
  applyCodexPluginHooks,
  mergeProjectConfig,
  collectSetupAnswers,
  gateOnlyInvitation,
  type SetupPlan,
  type SetupAnswers,
  type AskFn,
  type ParsedSetupArgs,
} from "./setup-plan.js";
import type {
  VigilesConfig,
  CoverageThresholds,
  TestCoverageConfig,
  RuleSeverity,
} from "./core/types.js";
import { ruleSeverity, ruleOptions } from "./core/types.js";
import type { SurfaceKind, TestCoverageOptions } from "./test-coverage.js";
import {
  findUntestedSurfaces,
  formatUntestedReport,
  skillTestNudge,
} from "./test-coverage.js";
import {
  scanPlugin,
  formatScanReport,
  inspectMarketplace,
  type MarketplaceInfo,
  verifyLiveMcpTools,
  formatMcpContractReport,
  preferCompiledHooksMessage,
} from "./scan.js";
import type { ScanReport } from "./scan.js";
import {
  hasModelAccess,
  isMeteredAccess,
  decideExecute,
  formatExecuteSkip,
  type ExecuteDecision,
} from "./scan-trigger-suggest.js";
import { checkDialectDrift, formatDialectDrift } from "./dialect-drift.js";
import {
  checkSkillReachability,
  formatSkillReachability,
} from "./skill-reachability.js";
import { addVigilesDeclaration } from "./plugin-declaration.js";
import {
  probePluginTriggers,
  formatBehavioralReport,
  measurePluginSelection,
  formatSelectionReport,
  measureGateAdversarial,
  formatGateReport,
  detectGateSkills,
  type TriggerPromptSet,
  type ProbeHarness,
} from "./scan-behavioral.js";
import {
  ADAPTERS,
  defaultAdapter,
  resolveHarnessSelection,
  resolveHarnessAdapters,
  normalizeHarnessName,
  normalizeHarnessList,
  getAdapter,
  adapterForInstructionFile,
} from "./adapter-registry.js";
import type { PluginLayout } from "./core/layout.js";
import type { HarnessSelection } from "./adapter-registry.js";
import type { HarnessDialect } from "./core/dialect.js";
import type { HarnessAdapter } from "./core/adapter.js";
import { skillFrontmatterDropWarnings } from "./skill-harness.js";
import {
  rankPlugins,
  formatLeaderboard,
  formatLeaderboardMarkdown,
} from "./leaderboard.js";
import { optimize, formatRecommendations } from "./optimize.js";
import { shareLinkForRemote } from "./share-link.js";
import { formatAuditScore } from "./audit-score.js";
import {
  autoTriggerPrompts,
  AUTO_RECALL_COUNT,
  AUTO_MIN_DISTANCE,
  type PromptSkill,
} from "./audit-prompts.js";
import { renderAuditHtml } from "./audit-html.js";
import {
  serveAudit,
  decideServeGate,
  newToken,
  type AdoptOutcome,
} from "./audit-serve.js";
import {
  buildAuditReport,
  buildLeaderboardReport,
  buildMarketplaceReport,
  type AuditReport,
} from "./audit-report.js";
import {
  buildRuleInventory,
  type RuleInventoryItem,
} from "./rule-inventory.js";
import {
  routeRules,
  mergeRoutings,
  LANE_META,
  type RuleRouting,
  type RuleCategory,
} from "./rule-routing.js";
import {
  isFixturePath,
  dedupeInstructionFiles,
  type RawInstructionFile,
} from "./instruction-sources.js";
import {
  enumerateEslintCatalog,
  enumeratePylintCatalog,
  mergeCatalogs,
} from "./core/rule-catalog.js";
import {
  runAdoptabilityTier,
  formatAdoptability,
  type AdoptabilityResult,
} from "./adoptability.js";

import {
  compileClaude,
  compileSkill,
  compileAgent,
  compileRailway,
  checkFileHash,
  addHash,
  validateFileRef,
  validateCommandRef,
  type StampedMarkdown,
} from "./core/compile.js";
import type { CompileError } from "./core/compile.js";
import type { ClaudeSpec, SkillSpec, AgentSpec, Railway } from "./core/spec.js";
import { findSimilarRules } from "./core/proofs.js";
import { parseInlineRules } from "./core/inline.js";
import { parseFrontmatterRules } from "./core/frontmatter.js";
import { generateSchema } from "./core/generate-schema.js";
import {
  detectInstructionMirror,
  composeCollisions,
  detectSyncTools,
} from "./core/compose.js";
import type { InstructionMirror } from "./core/compose.js";
import { compileGeneratorSkill } from "./core/compile-generator.js";
import { evaluateAction, loadActionGates } from "./action-gate.js";
import { runGuardHook } from "./core/guards.js";
import {
  compileHookProgram,
  checkHookImports,
  HookCompileError,
  dispatchKind,
  hookRouting,
  type DispatchKind,
} from "./core/hook-program.js";
import {
  discoverHookFiles,
  discoverProviderFiles,
  mergeHooksJson,
  mergeHooksToml,
  hookGateRef,
  normalizeHookRef,
  serializeConfig,
} from "./hook-install.js";
import { unsafeProvider } from "./core/hook-providers.js";
import { parse as parseToml } from "@iarna/toml";
// The named-state STORE. Lifted out of this file so a TEST can seed a fact
// through the SAME writer the runtime uses (`experimental_hookState`) — the
// private path a stateful hook's test used to hard-code is what kept the hook
// vocabulary experimental. Same move as `loadHook`, for the same reason.
import {
  evaluatePreToolUse,
  readActiveAgent,
  pushActiveAgent,
  popActiveAgent,
  decideTaskDispatch,
} from "./adapters/claude-code/agent-runtime.js";
import {
  appendObservation,
  readObservations,
  formatLedgerSummary,
  summarizeObservations,
} from "./observe.js";
import {
  setEffectActive,
  clearEffectActive,
} from "./adapters/claude-code/effect-region.js";
import {
  interceptHookDecision,
  parseIntercepts,
  INTERCEPT_TOOLS_ENV,
} from "./tool-intercept.js";
import {
  verifySymbolRefs,
  collectRefIssues,
  refsHookAction,
} from "./core/refs.js";
import { verifyMcpRefs, loadMcpServers, mcpRefMessage } from "./core/mcp.js";
import {
  parseSkillGates,
  runSkillGates,
  setActiveSkill,
  clearActiveSkill,
  evaluateStopHook,
  evaluateSkillPreToolUse,
  gateLabel,
} from "./adapters/claude-code/skill-runtime.js";
import { checkLinterRule } from "./core/linters.js";
import { claudeAvailable } from "./harness-test.js";
import {
  discoverScripts,
  runScripts,
  formatScriptSummary,
  anyFailed,
  scriptGlob,
  decideRunScripts,
  type ScriptRunResult,
} from "./adapters/claude-code/run-scripts.js";
import {
  COVERAGE_ARTIFACT_VERSION,
  executedScripts,
  mergeRuns,
  readCoverageArtifact,
  recordsFrom,
  runsFromResults,
  writeCoverageArtifact,
  type CoverageRun,
  type CoverageTierName,
} from "./coverage-artifact.js";
import {
  checkIntegrity,
  ejectMarkdown,
  findIntegrityHeader,
  parseIntegrityHeader,
  REQUIRE_INSTRUCTIONS_SPEC_DISABLE,
} from "./core/integrity.js";
import { adoptMarkdown, adoptSkill, adoptAgent } from "./core/adopt.js";
import { computeScriptCoverage } from "./core/coverage.js";
import { findOrphanDocs, formatOrphanReport } from "./core/orphans.js";
import { findDocRefs, formatDocRefReport } from "./core/doc-refs.js";
import type { DocRefReport } from "./core/doc-refs.js";
import {
  loadHookProgram,
  loadProvider,
  hookStampPath,
  runHookProgramCommand,
} from "./hook-runtime.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The always-excluded floor (node_modules/dist/.git/.vigiles) lives in
// src/exclude.ts, folded into every ExcludeSet — no walk carries a private copy.

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

/**
 * Every `*.md.spec.ts` under cwd that `.vigilesrc.json#exclude` does not drop.
 *
 * 🔴 `excludes` IS REQUIRED, NOT DEFAULTED (#192). This function hard-coded its
 * own ignore list for a year while the loaded config's `exclude` never reached
 * it — so a repo that excluded a directory of frozen, un-loadable fixtures got
 * "Compilation complete with errors" on every recompile hook. Eight call sites
 * each had the config in scope; none passed it. An optional parameter is how
 * that happens again; a required one makes the ninth call site a tsc error.
 */
function findSpecs(excludes: ExcludeSet, pattern?: string): string[] {
  const glob = pattern ?? "**/*.md.spec.ts";
  return globSync(glob, {
    // `dot: true` so specs that live in a sync tool's source slot (e.g.
    // `.ruler/AGENTS.md.spec.ts`, the redirect target) are discovered by
    // compile/lint/the recompile hook — not just root-level specs.
    dot: true,
    ignore: excludes.globIgnore,
    cwd: process.cwd(),
  });
}

type AnySpec = ClaudeSpec | SkillSpec | AgentSpec | Railway;

/**
 * Why the last `loadSpec()` returned null.
 *
 * Kept as module state rather than a widened return type: `loadSpec` has six
 * call sites and only one of them reports to a human.
 */
let lastSpecLoadFailure: string | null = null;

/** Reason the most recent `loadSpec()` returned null, or null if it succeeded. */
export function specLoadFailureReason(): string | null {
  return lastSpecLoadFailure;
}

/**
 * How long one spec may take to evaluate before the host is killed.
 *
 * Overridable because 15s is a guess that fits the specs we have seen, not a
 * law; a repo with genuinely slow specs should be able to raise it rather than
 * discover the number by hitting it.
 */
const SPEC_DEADLINE_MS = Number(process.env.VIGILES_SPEC_TIMEOUT_MS) || 15_000;

type HostReply =
  | { path: string; phase: "start" }
  | { path: string; ok: true; value: AnySpec }
  | { path: string; ok: false; error: string };

type Settle = (reply: HostReply | "timeout" | "died") => void;

type Host = {
  child: ChildProcessWithoutNullStreams;
  /**
   * Outstanding requests keyed BY PATH.
   *
   * 🔴 This was a single slot until a `--trace-warnings` run showed
   * `checkCoverageThresholds` calling `loadSpec` through `Array.map`, i.e.
   * concurrently. A single slot is overwritten by each new caller, so a reply
   * settles whichever request happened to be last — `loadSpec` could return
   * ANOTHER spec's value for the path it was asked about.
   *
   * ⚠️ **Honest scope of that claim.** The mispairing is wrong by construction,
   * but it is NOT observable today: the one concurrent caller aggregates and
   * never asks which spec it got. Measured — the same `vigiles lint` run with a
   * last-wins dispatch produces byte-identical output. So this is a latent
   * defect closed before it had consequences, not a bug anyone hit; the visible
   * symptom was only the MaxListeners warning. I could not construct an
   * end-to-end test that fails without keying by path, and the test beside this
   * file says so rather than implying otherwise. The next concurrent caller
   * that DOES care about identity is the one this protects.
   */
  pending: Map<string, Settle>;
  /** Last spec the host said it had STARTED — the culprit when a deadline fires. */
  started: string | null;
  buffered: string;
};

let host: Host | null = null;

/** The compiled host entry, beside this file in `dist/`. */
function hostEntry(): string {
  return resolve(__dirname, "spec-host.mjs");
}

/**
 * This package's own root — `dist/`'s parent, since this file compiles to
 * `dist/cli.js`. Handed to the host so its resolve hook can serve the spec's
 * `vigiles/spec` import from OUR install (see `src/self-resolve.mts`), which is
 * what lets a repo with no `node_modules/vigiles` — a Python or Rust repo has
 * no `package.json` to install into at all — compile a spec.
 */
function selfRoot(): string {
  return resolve(__dirname, "..");
}

function startHost(): Host {
  const child = spawn(process.execPath, [hostEntry()], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VIGILES_SELF_ROOT: selfRoot() },
  });
  const h: Host = { child, pending: new Map(), started: null, buffered: "" };

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    h.buffered += chunk;
    let nl: number;
    while ((nl = h.buffered.indexOf("\n")) >= 0) {
      const line = h.buffered.slice(0, nl).trim();
      h.buffered = h.buffered.slice(nl + 1);
      if (!line) continue;
      let reply: HostReply;
      try {
        reply = JSON.parse(line) as HostReply;
      } catch {
        continue; // not ours; a spec writing to stdout cannot corrupt the stream
      }
      if ("phase" in reply) {
        h.started = reply.path;
        continue;
      }
      const done = h.pending.get(reply.path);
      h.pending.delete(reply.path);
      done?.(reply);
    }
  });

  // Anything the child says on stderr is the spec's own noise; keep it out of
  // our stdout so `--json` consumers are not corrupted, but do not lose it.
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));

  // 🔴 Unreferenced, or the CLI never exits. A piped child and its three
  // streams each hold the event loop open, so `compile` finished its work and
  // then hung forever waiting on a host that had nothing left to say. The
  // in-flight deadline timer keeps the loop alive while a request is pending,
  // which is exactly as long as we need it.
  // ONE exit listener per host, not one per request: with concurrent callers the
  // per-request version added a listener each time and Node warned at eleven.
  // It fails every outstanding request, because a dead host answers none of them.
  child.once("exit", () => {
    const waiting = [...h.pending.values()];
    h.pending.clear();
    for (const settle of waiting) settle("died");
  });

  // The stdio types are Readable/Writable, which do not declare `unref` — the
  // objects are pipes and do have it. Optional-called so this stays correct if
  // a platform ever hands back a stream that genuinely lacks it.
  const unref = (s: unknown) => (s as { unref?: () => void })?.unref?.();
  child.unref();
  unref(child.stdin);
  unref(child.stdout);
  unref(child.stderr);

  return h;
}

/**
 * Kill the host and forget it; the next request starts a fresh one.
 *
 * Outstanding requests are failed rather than dropped: a killed host will never
 * answer them, and a promise nobody settles is a hang wearing a different hat.
 */
function dropHost(): void {
  if (!host) return;
  const dying = host;
  host = null;
  const waiting = [...dying.pending.values()];
  dying.pending.clear();
  dying.child.kill("SIGKILL");
  for (const settle of waiting) settle("died");
}

process.on("exit", dropHost);

/**
 * Load one spec in the spec host.
 *
 * 🔴 **Why a child process rather than `import()` here.** A module evaluation
 * cannot be cancelled once started — `Promise.race` hands control back but the
 * evaluation keeps running and holds the event loop — so an in-process loader
 * gives a stalled spec an unbounded hang in `compile`, `test` and `audit`. It
 * also cannot tell whether a failed spec already ran (Node reports
 * `ERR_MODULE_NOT_FOUND` and `SyntaxError` both before and during evaluation),
 * which is what made the previous two-loader arrangement unfixable rather than
 * merely buggy: it had to guess whether re-running was safe.
 *
 * The host is spawned with `process.execPath` — never `npx` — so nothing is
 * fetched and nothing needs installing.
 */
async function loadSpec(specPath: string): Promise<AnySpec | null> {
  const fullPath = resolve(process.cwd(), specPath);
  lastSpecLoadFailure = null;

  if (!existsSync(fullPath)) {
    lastSpecLoadFailure = `no such file: ${specPath}`;
    return null;
  }

  host ??= startHost();
  const h = host;

  const reply = await new Promise<HostReply | "timeout" | "died">((done) => {
    let settled = false;
    const finish: Settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      h.pending.delete(fullPath);
      done(r);
    };
    const timer = setTimeout(() => {
      finish("timeout");
    }, SPEC_DEADLINE_MS);
    h.pending.set(fullPath, finish);
    h.child.stdin.write(JSON.stringify({ path: fullPath }) + "\n");
  });

  if (reply === "timeout") {
    // The host's last `start` names the spec that stalled. Without it a hang
    // produced N identical failures and no culprit.
    const culprit = h.started ?? fullPath;
    dropHost();
    lastSpecLoadFailure =
      `evaluating ${relative(process.cwd(), culprit)} exceeded ` +
      `${SPEC_DEADLINE_MS}ms and was killed. Set VIGILES_SPEC_TIMEOUT_MS to ` +
      `raise the limit, or look for a top-level await that never settles.`;
    return null;
  }
  if (reply === "died") {
    dropHost();
    lastSpecLoadFailure = "the spec host exited unexpectedly.";
    return null;
  }
  if (!("ok" in reply) || !reply.ok) {
    lastSpecLoadFailure = `the spec did not load. ${
      "error" in reply ? reply.error : "no reason given"
    }`;
    return null;
  }
  return reply.value;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printErrors(specFile: string, errors: CompileError[]): void {
  for (const err of errors) {
    const pathInfo = err.path ? ` (${err.path})` : "";
    console.log(`  [${err.type}] ${err.message}${pathInfo}`);
    console.log(`::error file=${specFile}::${err.message}`);
  }
}

/** Non-blocking advisories — printed, but never fail the compile. */
function printWarnings(specFile: string, warnings: CompileError[]): void {
  for (const w of warnings) {
    const pathInfo = w.path ? ` (${w.path})` : "";
    console.log(`  ⚠ [${w.type}] ${w.message}${pathInfo}`);
    console.log(`::warning file=${specFile}::${w.message}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Compile a generator-skill spec from source → SKILL.md. Returns validity. */
function compileGeneratorSkillToFile(
  specPath: string,
  source: string,
): boolean {
  const outputPath = specPath.replace(/\.spec\.ts$/, "");
  const { artifact, errors } = compileGeneratorSkill(source, {
    basePath: process.cwd(),
    specFile: specPath,
  });
  // Written only when the compile is clean: `artifact` is null otherwise, and
  // `writeArtifact` takes nothing else.
  if (artifact) writeArtifact(outputPath, artifact);
  if (errors.length === 0) {
    console.log(`\n✓ ${specPath} → ${outputPath} (generator skill)`);
    return true;
  }
  console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
  for (const e of errors) console.log(`  ${e.type}: ${e.message}`);
  return false;
}

/** Compile a ClaudeSpec → its primary + any additional targets. */
function compileClaudeToFile(
  spec: ClaudeSpec,
  specPath: string,
  config: VigilesConfig,
  dialect: HarnessDialect,
): boolean {
  const basePath = process.cwd();
  const { markdown, errors, linterResults, targets } = compileClaude(spec, {
    basePath,
    specFile: specPath,
    dialect,
    maxRules: config.maxRules,
    maxTokens: config.maxTokens,
    maxSectionLines: config.maxSectionLines,
    catalogOnly: config.catalogOnly,
    linters: config.linters,
  });
  const primaryOutput = specPath.replace(/\.spec\.ts$/, "");
  if (errors.length > 0) {
    console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
    printErrors(specPath, errors);
    // 🔴 NOTHING IS WRITTEN ON A FAILED COMPILE (#173).
    //
    // It used to write the artifact anyway, and the result was the exact
    // false-confidence object this tool exists to prevent: a `CLAUDE.md`
    // carrying refs already KNOWN to be dead, stamped with a VALID integrity
    // hash. `lint` then verified the hash, found it intact, and exited 0 — so
    // the command the README calls "the CI gate … broken refs" went green over
    // breakage `compile` had printed minutes earlier. Compile locally, get
    // distracted, commit: CI never mentions it again.
    //
    // Not writing leaves the LAST GOOD artifact in place, which is strictly
    // better than replacing it with a broken one: the error is on screen, the
    // exit code is 1, and no green hash is minted over a known-bad file.
    console.log(
      `  → ${primaryOutput} was NOT written; the previous version is left in place.`,
    );
    return false;
  }
  writeFileSync(resolve(basePath, primaryOutput), markdown);
  const outputNames = [primaryOutput];
  for (const t of targets.slice(1)) {
    const body = markdown
      .replace(/^<!-- vigiles:[^\n]+\n\n?/, "")
      .replace(/^# [^\n]+/, `# ${t}`);
    const dir = primaryOutput.substring(0, primaryOutput.lastIndexOf("/") + 1);
    const targetPath = dir + t;
    writeFileSync(resolve(basePath, targetPath), addHash(body, specPath));
    outputNames.push(targetPath);
  }
  const linterCount = linterResults.filter((r) => r.exists).length;
  console.log(`\n✓ ${specPath} → ${outputNames.join(", ")}`);
  console.log(
    `  ${String(Object.keys(spec.rules).length)} rules (${String(linterCount)} linter-verified)`,
  );
  return true;
}

/**
 * Branch 3 of the mirror story (research/multi-harness-compile.md): when a repo
 * declares ≥2 harnesses and nothing else fans out the instruction file, write a
 * byte-identical copy to each other harness's instruction file (e.g. CLAUDE.md →
 * AGENTS.md). A copy — not a symlink — because it works everywhere and carries
 * the source's embedded integrity hash by construction, so a hand-edit of the
 * mirror trips the existing `integrity` check. Never fights a sync tool or
 * clobbers a target that owns its own spec.
 */
function writeInstructionMirrors(
  primaryOutput: string,
  harnesses: string[],
): void {
  if (harnesses.length < 2) return;
  const cwd = process.cwd();
  // A sync tool (Ruler/rulesync) owns fan-out — don't fight it.
  if (detectSyncTools(cwd).length > 0) return;
  const primaryName = basename(primaryOutput);
  const primaryAbs = resolve(cwd, primaryOutput);
  if (!existsSync(primaryAbs)) return;
  const content = readFileSync(primaryAbs, "utf-8");
  for (const name of harnesses) {
    const adapter = getAdapter(name);
    if (!adapter) continue;
    const target = adapter.layout.instructionFile;
    if (target === primaryName) continue; // the file we just compiled
    // Never clobber a target that has its own spec (a genuinely separate file).
    if (existsSync(resolve(cwd, `${target}.spec.ts`))) continue;
    const targetAbs = resolve(cwd, target);
    if (existsSync(targetAbs) && readFileSync(targetAbs, "utf-8") === content) {
      continue; // already byte-identical
    }
    writeFileSync(targetAbs, content);
    console.log(`  ↳ mirrored ${primaryName} → ${target} (byte-identical)`);
  }
}

/** Compile a declarative SkillSpec → SKILL.md. */
function compileSkillToFile(
  spec: SkillSpec,
  specPath: string,
  dialect: HarnessDialect,
): boolean {
  const outputPath = specPath.replace(/\.spec\.ts$/, "");
  const { artifact, errors, warnings } = compileSkill(spec, {
    basePath: process.cwd(),
    specFile: specPath,
    // The SKILL.md frontmatter profile comes from the resolved harness — a Codex
    // repo gets a minimal (name + description) SKILL.md; CC gets the full set.
    dialect,
  });
  // Written only when the compile is clean: `artifact` is null otherwise, and
  // `writeArtifact` takes nothing else.
  if (artifact) writeArtifact(outputPath, artifact);
  if (errors.length === 0) {
    console.log(`\n✓ ${specPath} → ${outputPath}`);
    printWarnings(specPath, warnings);
    return true;
  }
  console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
  printErrors(specPath, errors);
  printWarnings(specPath, warnings);
  return false;
}

/** Compile a subagent spec → agents/<name>.md (with its result-contract section). */
function compileAgentToFile(
  spec: AgentSpec,
  specPath: string,
  dialect: HarnessDialect,
): boolean {
  const outputPath = specPath.replace(/\.spec\.ts$/, "");
  const { artifact, errors, warnings } = compileAgent(spec, {
    basePath: process.cwd(),
    specFile: specPath,
    dialect,
  });
  // Written only when the compile is clean: `artifact` is null otherwise, and
  // `writeArtifact` takes nothing else.
  if (artifact) writeArtifact(outputPath, artifact);
  if (errors.length === 0) {
    console.log(`\n✓ ${specPath} → ${outputPath}`);
    printWarnings(specPath, warnings);
    return true;
  }
  console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
  printErrors(specPath, errors);
  printWarnings(specPath, warnings);
  return false;
}

/**
 * Compile a railway spec → the orchestrator command markdown. `knownAgents` is
 * the set of compiled agent names in the project, so every `delegate()` target
 * is resolved at compile time (an unknown target is a stale-ref error).
 */
function compileRailwayToFile(
  spec: Railway,
  specPath: string,
  knownAgents: readonly string[],
): boolean {
  const outputPath = specPath.replace(/\.spec\.ts$/, "");
  const { artifact, errors } = compileRailway(spec, {
    specFile: specPath,
    knownAgents,
  });
  // Written only when the compile is clean: `artifact` is null otherwise, and
  // `writeArtifact` takes nothing else.
  if (artifact) writeArtifact(outputPath, artifact);
  if (errors.length === 0) {
    console.log(`\n✓ ${specPath} → ${outputPath}`);
    return true;
  }
  console.log(`\n✗ ${specPath} — ${String(errors.length)} error(s)`);
  printErrors(specPath, errors);
  return false;
}

/** Names of every compiled agent spec in the project — resolves delegate() targets. */
async function collectAgentNames(excludes: ExcludeSet): Promise<string[]> {
  const names: string[] = [];
  for (const p of findSpecs(excludes)) {
    const s = await loadSpec(p);
    if (s && s._specType === "agent") names.push(s.name);
  }
  return names;
}

async function compile(
  specPaths: string[],
  config: VigilesConfig,
  excludes: ExcludeSet,
  opts: { harnessFlag?: string } = {},
): Promise<boolean> {
  let allValid = true;
  // Parse the declared harness set ONCE (alias-normalized) and feed both the
  // dialect pick and the mirror from it — no re-parsing, no cwd-sniffing in the
  // helpers. A loud notice (never a silent guess) on a multi-harness or
  // ambiguous-detection pick.
  const declaredHarnesses = normalizeHarnessList(config.harness);
  const selection = resolveHarnessSelection({
    root: process.cwd(),
    flag: opts.harnessFlag,
    configHarness: declaredHarnesses,
  });
  if (selection.kind === "notice") console.log(`⚠ ${selection.notice}`);
  const dialect = selection.adapter.dialect;
  // Resolved lazily on the first railway spec — every delegate() target is
  // checked against the agents defined anywhere in the project.
  let knownAgents: string[] | null = null;
  for (const specPath of specPaths) {
    // Generator skills can't be executed to markdown — compile from source.
    const source = readFileSync(resolve(process.cwd(), specPath), "utf-8");
    if (/\bgenSkill\s*\(/.test(source)) {
      if (!compileGeneratorSkillToFile(specPath, source)) allValid = false;
      continue;
    }
    const spec = await loadSpec(specPath);
    if (!spec) {
      console.log(`\n✗ ${specPath} — failed to load`);
      console.log(`  ${specLoadFailureReason() ?? "reason unavailable"}`);
      allValid = false;
      continue;
    }
    if (spec._specType === "claude") {
      // Spec-target disambiguation: a CLAUDE.md.spec.ts is a claude-code file, an
      // AGENTS.md.spec.ts a codex one — the strongest dialect signal for THIS
      // spec. The flag still overrides; absent one, the spec's own target wins
      // over config/detect. (Skill/agent targets don't name a harness, so they
      // keep the run-level dialect.)
      const targetFile = basename(specPath).replace(/\.spec\.ts$/, "");
      const specDialect =
        opts.harnessFlag === undefined
          ? (adapterForInstructionFile(targetFile)?.dialect ?? dialect)
          : dialect;
      if (compileClaudeToFile(spec, specPath, config, specDialect)) {
        writeInstructionMirrors(
          specPath.replace(/\.spec\.ts$/, ""),
          declaredHarnesses,
        );
      } else {
        allValid = false;
      }
    } else if (spec._specType === "skill") {
      // Cross-harness verify: flag CC-only frontmatter a declared minimal-profile
      // harness (Codex/OpenCode) would silently drop.
      const forHarnesses =
        declaredHarnesses.length > 0
          ? declaredHarnesses
          : [selection.adapter.name];
      for (const w of skillFrontmatterDropWarnings(spec, forHarnesses)) {
        console.log(`⚠ ${w}`);
      }
      if (!compileSkillToFile(spec, specPath, dialect)) allValid = false;
    } else if (spec._specType === "agent") {
      if (!compileAgentToFile(spec, specPath, dialect)) allValid = false;
    } else if (spec._specType === "railway") {
      knownAgents ??= await collectAgentNames(excludes);
      if (!compileRailwayToFile(spec, specPath, knownAgents)) allValid = false;
    }
  }
  return allValid;
}

/** True when running inside a GitHub Actions workflow. */
function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/**
 * Emit a GitHub Actions annotation for the inline PR experience.
 * No-op outside GitHub Actions.
 */
function ghAnnotate(
  level: "error" | "warning",
  message: string,
  file?: string,
  line?: number,
): void {
  if (!isGitHubActions()) return;
  const locParts: string[] = [];
  if (file) locParts.push(`file=${file}`);
  if (line !== undefined) locParts.push(`line=${String(line)}`);
  const loc = locParts.length > 0 ? " " + locParts.join(",") : "";
  console.log(`::${level}${loc}::${message}`);
}

interface HashCheckResult {
  valid: boolean;
  errorCount: number;
}

function verifyHashes(filePaths: string[], silent = false): HashCheckResult {
  let errorCount = 0;
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);

    // If the file doesn't exist at all (typo, deleted), that's an error —
    // not a "no hash" informational message. Without this check, a scoped
    // lint like `vigiles lint typo.md` would silently exit clean.
    if (!existsSync(fullPath)) {
      log(`\n✗ ${filePath} — file not found`);
      if (!silent) {
        ghAnnotate("error", `File not found: ${filePath}`, filePath);
      }
      errorCount++;
      continue;
    }

    const result = checkFileHash(fullPath);

    if (!result.hasHash) {
      log(`\n- ${filePath} — no vigiles hash (hand-written or pre-v2)`);
      continue;
    }

    if (result.valid) {
      log(`\n✓ ${filePath} — hash valid (from ${result.specFile})`);
      continue;
    }

    log(`\n✗ ${filePath} — hash mismatch (manually edited after compilation)`);
    log(
      `  Re-run \`vigiles compile\` to regenerate from ${result.specFile ?? "spec"}.`,
    );
    if (!silent) {
      ghAnnotate(
        "error",
        "Hash mismatch — file was manually edited after compilation",
        filePath,
      );
    }
    errorCount++;
  }
  return { valid: errorCount === 0, errorCount };
}

function validateSpecs(
  filePaths: string[],
  rulesConfig?: import("./core/types.js").RulesConfig,
  silent = false,
): boolean {
  let allValid = true;
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  for (const filePath of filePaths) {
    const fullPath = resolve(process.cwd(), filePath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    // Multi-target: if file has a "compiled from" hash, it has a spec
    // even if it's not named <file>.spec.ts (e.g., AGENTS.md from CLAUDE.md.spec.ts)
    const hashMatch = content.match(
      /<!-- vigiles:sha256:[a-f0-9]+ compiled from (.+) -->/,
    );
    if (hashMatch) {
      // Verify the referenced spec still exists
      const specRef = resolve(process.cwd(), hashMatch[1]);
      if (!existsSync(specRef)) {
        log(
          `  ✗ [require-instructions-spec] ${filePath} references "${hashMatch[1]}" but that spec no longer exists.`,
        );
        allValid = false;
      }
      continue;
    }

    const result = validate(content, {
      filePath: fullPath,
      rules: rulesConfig,
    });
    for (const err of result.errors) {
      log(`  ✗ [${err.rule}] ${err.message}`);
      allValid = false;
    }
    for (const warn of result.warnings) {
      log(`  ⚠ [${warn.rule}] ${warn.message}`);
    }
  }
  return allValid;
}

interface CombinedCheckResult {
  valid: boolean;
  hashErrors: number;
  validationErrors: number;
}

function check(filePaths: string[], silent = false): CombinedCheckResult {
  const hashes = verifyHashes(filePaths, silent);
  const vConfig = loadConfig();
  const specsValid = validateSpecs(filePaths, vConfig.rules, silent);
  return {
    valid: hashes.valid && specsValid,
    hashErrors: hashes.errorCount,
    // `validateSpecs` only returns a boolean today, so we collapse
    // failures to 1 until it starts reporting counts. Kept in its own
    // counter so lint's "stale hash — run vigiles compile" remediation
    // doesn't misreport a require-instructions-spec / other validation failure.
    validationErrors: specsValid ? 0 : 1,
  };
}

interface DuplicateResult {
  valid: boolean;
  pairCount: number;
}

/**
 * Find near-duplicate rules within each spec using NCD similarity.
 * Catches spec bloat — rules that likely say the same thing in different words.
 * Uses information-theoretic distance (gzip-based) — no LLM, fully deterministic.
 */
async function findDuplicateRules(
  excludes: ExcludeSet,
  threshold: number = 0.3,
  silent = false,
  scopeFiles?: string[],
): Promise<DuplicateResult> {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  const allSpecs = findSpecs(excludes);
  // If lint was invoked with explicit file arguments, only scan the specs
  // for those files — otherwise an unrelated duplicate elsewhere in the
  // repo would fail a targeted CI check (e.g. `vigiles lint path/foo.md`).
  //
  // Resolve each requested file to its real source spec by reading the
  // compiled-from header. Multi-target projects compile one spec to
  // several targets (e.g. CLAUDE.md.spec.ts → CLAUDE.md + AGENTS.md), so
  // naive `${file}.spec.ts` concatenation would miss the real source for
  // the secondary targets. Fall back to the concatenation rule if the
  // file has no hash header (e.g. freshly hand-written).
  const specs =
    scopeFiles && scopeFiles.length > 0
      ? (() => {
          const wanted = new Set<string>();
          const compiledFromRe =
            /<!--\s*vigiles:sha256:[a-f0-9]+\s+compiled from (.+?)\s*-->/;
          for (const f of scopeFiles) {
            let resolved: string | undefined;
            try {
              const content = readFileSync(resolve(process.cwd(), f), "utf-8");
              const m = compiledFromRe.exec(content);
              if (m) {
                resolved = resolve(process.cwd(), m[1].trim());
              }
            } catch {
              // File unreadable — fall through to the naming convention
            }
            if (!resolved) {
              resolved = resolve(process.cwd(), `${f}.spec.ts`);
            }
            wanted.add(resolved);
          }
          return allSpecs.filter((specPath) =>
            wanted.has(resolve(process.cwd(), specPath)),
          );
        })()
      : allSpecs;
  if (specs.length === 0) return { valid: true, pairCount: 0 };

  let totalPairs = 0;
  let specsWithDuplicates = 0;

  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec || spec._specType !== "claude") continue;

    const rules = spec.rules;
    const ruleCount = Object.keys(rules).length;
    if (ruleCount < 2) continue;

    const pairs = findSimilarRules(rules, threshold);
    if (pairs.length === 0) continue;

    if (specsWithDuplicates === 0) {
      log(`Found near-duplicate rules (NCD < ${String(threshold)}):\n`);
    }
    specsWithDuplicates++;
    totalPairs += pairs.length;

    log(`  ${specPath}`);
    for (const pair of pairs.slice(0, 5)) {
      log(
        `    ${pair.idA}  ↔  ${pair.idB}  (distance: ${pair.distance.toFixed(3)})`,
      );
    }
    if (pairs.length > 5) {
      log(`    ... and ${String(pairs.length - 5)} more`);
    }
  }

  if (totalPairs === 0) {
    log("No near-duplicate rules detected.");
    return { valid: true, pairCount: 0 };
  }

  log(
    `\n  ${String(totalPairs)} duplicate pair(s) in ${String(specsWithDuplicates)} spec(s). Consider merging or rewording.`,
  );
  return { valid: false, pairCount: totalPairs };
}

/**
 * Structured lint report used by --json, --summary, and exit-code logic.
 */
interface LintReport {
  hashErrors: number;
  validationErrors: number;
  inlineErrors: number;
  inlineRules: number;
  frontmatterErrors: number;
  frontmatterRules: number;
  specRefIssues: number;
  specRefErrors: number;
  duplicatePairs: number;
  /** Severity of `duplicate-instructions` — carried so the exit code can tier it. */
  duplicateSeverity: RuleSeverity;
  coverageEnabled: number;
  coverageDocumented: number;
  strengthenSuggestions: number;
  integrityErrors: number;
  coverageErrors: number;
  orphanCount: number;
  /** Severity of `orphan-docs` — carried so the exit code can tier it (#181). */
  orphanSeverity: RuleSeverity;
  untestedSurfaces: number;
  untestedErrors: number;
  toolContractIssues: number;
  toolContractErrors: number;
  hookEventIssues: number;
  hookEventErrors: number;
  frontmatterSchemaIssues: number;
  frontmatterSchemaErrors: number;
  mcpConfigIssues: number;
  mcpConfigErrors: number;
  skillFrontmatterIssues: number;
  skillFrontmatterErrors: number;
  mcpToolIssues: number;
  mcpToolErrors: number;
  hookScriptIssues: number;
  hookScriptErrors: number;
  disallowedToolIssues: number;
  disallowedToolErrors: number;
  descriptionOverlapIssues: number;
  descriptionOverlapErrors: number;
  descriptionBudgetIssues: number;
  descriptionBudgetErrors: number;
  frontmatterValidIssues: number;
  frontmatterValidErrors: number;
  mcpHookIssues: number;
  mcpHookErrors: number;
  preferCompiledHookIssues: number;
  preferCompiledHookErrors: number;
  lethalTrifectaIssues: number;
  lethalTrifectaErrors: number;
  skillResourceIssues: number;
  skillResourceErrors: number;
  skillFenceIssues: number;
  skillFenceErrors: number;
  pluginLayoutIssues: number;
  pluginLayoutErrors: number;
  delegationTrifectaIssues: number;
  delegationTrifectaErrors: number;
  hookBlockIssues: number;
  hookBlockErrors: number;
  hookMatcherIssues: number;
  hookMatcherErrors: number;
  docRefErrors: number;
  symbolRefErrors: number;
  mcpRefErrors: number;
  files: string[];
  /**
   * Findings / errors / warnings for the whole run — the same numbers the
   * human-readable summary line prints, so a consumer never has to reconstruct
   * them by counting output lines (#183, and the generic-consumer half of #181).
   */
  totals?: { findings: number; errors: number; warnings: number };
}

/**
 * Verify the file-qualified symbol references (`path.ext#symbol`) in instruction
 * files: the named file must exist and define the named symbol. The author
 * names the file, so this is a *declared* reference — a broken one is an error.
 * Each named file is parsed on demand; there is no project-wide index. Returns
 * the count of broken references.
 */
function verifyMarkdownSymbols(files: string[], silent: boolean): number {
  if (files.length === 0) return 0;
  const cwd = process.cwd();
  let printedHeader = false;
  let errors = 0;
  for (const f of files) {
    let markdown: string;
    try {
      markdown = readFileSync(resolve(cwd, f), "utf-8");
    } catch {
      continue;
    }
    const broken = verifySymbolRefs(markdown, dirname(resolve(cwd, f)));
    if (broken.length === 0) continue;
    if (!silent) {
      if (!printedHeader) {
        console.log("\nSymbol reference check:\n");
        printedHeader = true;
      }
      for (const b of broken) {
        console.log(`  ✗ ${f}:${String(b.line)} ${b.reason}`);
        ghAnnotate("error", b.reason, f, b.line);
      }
    }
    errors += broken.length;
  }
  return errors;
}

/**
 * Verify `vigiles:mcp server#tool` marks in instruction files against the live
 * MCP servers declared in `.mcp.json` — the referenced tool must exist on the
 * server (it gets started for the check). No `.mcp.json` ⇒ skipped; a server is
 * only started if a mark actually references it. Returns the count of broken
 * references. Async because it speaks to real servers.
 */
async function verifyMarkdownMcpRefs(
  files: string[],
  silent: boolean,
): Promise<number> {
  const cwd = process.cwd();
  const servers = loadMcpServers(cwd);
  if (files.length === 0 || Object.keys(servers).length === 0) return 0;
  let printedHeader = false;
  let errors = 0;
  for (const f of files) {
    let markdown: string;
    try {
      markdown = readFileSync(resolve(cwd, f), "utf-8");
    } catch {
      continue;
    }
    const broken = await verifyMcpRefs(markdown, servers);
    if (broken.length === 0) continue;
    if (!silent) {
      if (!printedHeader) {
        console.log("\nMCP reference check:\n");
        printedHeader = true;
      }
      for (const b of broken) {
        const msg = mcpRefMessage(b);
        console.log(`  ✗ ${f}:${String(b.line)} ${msg}`);
        ghAnnotate("error", msg, f, b.line);
      }
    }
    errors += broken.length;
  }
  return errors;
}

/** Exit codes: 0 clean, 1 warnings only, 2 hard errors. */
/**
 * The run's totals, derived from the report itself.
 *
 * 🔴 ONE SOURCE, because the two numbers disagreeing IS the bug (#183). The
 * human-readable log had no total, and counting its `⚠` lines gave a different
 * number from the JSON — 21 against 88 on a real repo — because some checks print
 * one line per finding and others one line carrying a count. Both numbers were
 * right and nothing said why they differed, so "vigiles reports 21 warnings" and
 * "88 warnings" were equally defensible readings of one run.
 *
 * Counted GENERICALLY off the `*Issues` / `*Errors` / count keys rather than a
 * hand-maintained list, so a rule added later is included by existing, not by
 * somebody remembering. `orphanCount` and `duplicatePairs` are named explicitly
 * only because they predate the `*Issues` convention (#181).
 */
export function lintTotals(report: LintReport): {
  findings: number;
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let findings = 0;
  for (const [key, value] of Object.entries(report)) {
    if (typeof value !== "number" || value === 0) continue;
    if (key === "files") continue;
    // Informational counters: not findings, they describe the corpus.
    if (
      key === "inlineRules" ||
      key === "frontmatterRules" ||
      key === "coverageEnabled" ||
      key === "coverageDocumented" ||
      key === "strengthenSuggestions"
    )
      continue;
    if (key.endsWith("Errors")) {
      errors += value;
      findings += value;
      continue;
    }
    // `*Issues` counts EVERY finding of that rule; when the rule is at "error"
    // the same findings are also in `*Errors`, so they must not be counted twice.
    if (key.endsWith("Issues")) {
      const paired = (report as unknown as Record<string, number>)[
        `${key.slice(0, -"Issues".length)}Errors`
      ];
      findings += paired && paired > 0 ? 0 : value;
      continue;
    }
    if (
      key === "orphanCount" ||
      key === "duplicatePairs" ||
      key === "untestedSurfaces"
    )
      findings += value;
  }
  return { findings, errors, warnings: findings - errors };
}

function lintExitCode(report: LintReport): 0 | 1 | 2 {
  if (
    report.hashErrors > 0 ||
    report.validationErrors > 0 ||
    report.inlineErrors > 0 ||
    report.frontmatterErrors > 0 ||
    report.integrityErrors > 0 ||
    report.coverageErrors > 0 ||
    report.untestedErrors > 0 ||
    report.toolContractErrors > 0 ||
    report.hookEventErrors > 0 ||
    report.frontmatterSchemaErrors > 0 ||
    report.mcpConfigErrors > 0 ||
    report.skillFrontmatterErrors > 0 ||
    report.mcpToolErrors > 0 ||
    report.hookScriptErrors > 0 ||
    report.disallowedToolErrors > 0 ||
    report.descriptionOverlapErrors > 0 ||
    report.descriptionBudgetErrors > 0 ||
    report.frontmatterValidErrors > 0 ||
    report.mcpHookErrors > 0 ||
    report.preferCompiledHookErrors > 0 ||
    report.lethalTrifectaErrors > 0 ||
    report.skillResourceErrors > 0 ||
    report.skillFenceErrors > 0 ||
    report.pluginLayoutErrors > 0 ||
    report.delegationTrifectaErrors > 0 ||
    report.hookBlockErrors > 0 ||
    report.hookMatcherErrors > 0 ||
    report.symbolRefErrors > 0 ||
    report.mcpRefErrors > 0 ||
    // `doc-refs` is opt-in and this counter is only non-zero when the user set
    // it to "error", so it belongs in the hard tier with every other explicit
    // error — it used to sit at exit 1 because it fired unasked and could not be
    // turned off.
    report.docRefErrors > 0 ||
    report.specRefErrors > 0
  )
    return 2;
  // Tierable now: a `warn` orphan/duplicate finding is reported and does NOT
  // change the exit code. Both used to feed the exit directly, which is what
  // made them the only untierable findings in the tool.
  if (report.orphanCount > 0 && report.orphanSeverity === "error") return 1;
  if (report.duplicatePairs > 0 && report.duplicateSeverity === "error")
    return 1;
  // Guidance counts are informational, not failures
  return 0;
}

/**
 * Verify inline `<!-- vigiles:enforce ... -->` comments in an instruction
 * file. Each comment's linter rule goes through the same verification as
 * spec-declared enforce rules (existence, enabled status, closest-match
 * suggestions on typo).
 */
type LinterOptions = {
  catalogOnly?: boolean;
  linters?: Record<string, { rulesDir?: string | string[] }>;
};

interface RuleVerifyResult {
  ok: boolean;
  errorCount: number;
  ruleCount: number;
  /** Linter rule references that were verified (for cross-source dedup). */
  ruleNames: string[];
}

/**
 * Verify one parsed enforce rule against the linter catalog/config, logging
 * and annotating on failure. Returns true when the rule is valid+enabled.
 */
function verifyOneRule(
  rule: { linterRule: string; line: number },
  filePath: string,
  silent: boolean,
  linterOptions?: LinterOptions,
): boolean {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  const result = checkLinterRule(rule.linterRule, process.cwd(), linterOptions);
  if (!result.exists) {
    const message = result.error ?? `Rule "${rule.linterRule}" not found`;
    log(`  ✗ line ${String(rule.line)}: ${message}`);
    if (!silent) ghAnnotate("error", message, filePath, rule.line);
    return false;
  }
  if (result.enabled === "disabled") {
    const message = `Rule "${rule.linterRule}" exists but is disabled in ${result.linter} config`;
    log(`  ✗ line ${String(rule.line)}: ${message}`);
    if (!silent) ghAnnotate("error", message, filePath, rule.line);
    return false;
  }
  log(`  ✓ line ${String(rule.line)}: ${rule.linterRule}`);
  return true;
}

/**
 * Verify the `vigiles:file` / `vigiles:cmd` references a markdown file declares
 * (inline comments or frontmatter lists), using the same engine spec mode uses:
 * file paths via existsSync, npm scripts and script-runner commands via
 * package.json / the filesystem. References resolve relative to the markdown
 * file's own directory. Returns the number of stale references found.
 */
function verifyMarkdownRefs(
  files: readonly { path: string; line: number }[],
  commands: readonly { command: string; line: number }[],
  filePath: string,
  silent: boolean,
): number {
  const basePath = dirname(resolve(process.cwd(), filePath));
  let errorCount = 0;
  const report = (err: CompileError, line: number): void => {
    if (!silent) {
      console.log(`  ✗ line ${String(line)}: ${err.message}`);
      ghAnnotate("error", err.message, filePath, line);
    }
    errorCount++;
  };
  for (const f of files) {
    const err = validateFileRef(f.path, basePath);
    if (err) report(err, f.line);
  }
  for (const c of commands) {
    const err = validateCommandRef(c.command, basePath);
    if (err) report(err, c.line);
  }
  return errorCount;
}

function verifyInlineRules(
  filePath: string,
  silent: boolean,
  linterOptions?: LinterOptions,
): RuleVerifyResult {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };

  let content: string;
  try {
    content = readFileSync(resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return { ok: true, errorCount: 0, ruleCount: 0, ruleNames: [] };
  }

  const {
    rules,
    files,
    commands,
    errors: parseErrors,
  } = parseInlineRules(content);
  if (
    rules.length === 0 &&
    files.length === 0 &&
    commands.length === 0 &&
    parseErrors.length === 0
  ) {
    return { ok: true, errorCount: 0, ruleCount: 0, ruleNames: [] };
  }

  let errorCount = 0;
  log(`\n${filePath} (inline mode):`);

  for (const err of parseErrors) {
    log(`  ✗ line ${String(err.line)}: ${err.message}`);
    errorCount++;
    if (!silent) {
      ghAnnotate("error", err.message, filePath, err.line);
    }
  }

  for (const rule of rules) {
    if (!verifyOneRule(rule, filePath, silent, linterOptions)) errorCount++;
  }
  errorCount += verifyMarkdownRefs(files, commands, filePath, silent);

  return {
    ok: errorCount === 0,
    errorCount,
    ruleCount: rules.length + files.length + commands.length,
    ruleNames: rules.map((r) => r.linterRule),
  };
}

/**
 * Verify `vigiles.enforce` rules declared in a file's YAML frontmatter.
 * Same engine as inline/spec rules. Rules whose reference already appeared
 * in `exclude` (e.g. declared inline in the same file) are skipped so a
 * rule present in both sources is reported once, not twice.
 */
function verifyFrontmatterRules(
  filePath: string,
  silent: boolean,
  exclude: ReadonlySet<string>,
  linterOptions?: LinterOptions,
): RuleVerifyResult {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };

  let content: string;
  try {
    content = readFileSync(resolve(process.cwd(), filePath), "utf-8");
  } catch {
    return { ok: true, errorCount: 0, ruleCount: 0, ruleNames: [] };
  }

  const {
    rules: allRules,
    files,
    commands,
    errors: parseErrors,
  } = parseFrontmatterRules(content);
  const rules = allRules.filter((r) => !exclude.has(r.linterRule));
  if (
    rules.length === 0 &&
    files.length === 0 &&
    commands.length === 0 &&
    parseErrors.length === 0
  ) {
    return { ok: true, errorCount: 0, ruleCount: 0, ruleNames: [] };
  }

  let errorCount = 0;
  log(`\n${filePath} (frontmatter mode):`);

  for (const err of parseErrors) {
    log(`  ✗ line ${String(err.line)}: ${err.message}`);
    errorCount++;
    if (!silent) {
      ghAnnotate("error", err.message, filePath, err.line);
    }
  }

  for (const rule of rules) {
    if (!verifyOneRule(rule, filePath, silent, linterOptions)) errorCount++;
  }
  errorCount += verifyMarkdownRefs(files, commands, filePath, silent);

  return {
    ok: errorCount === 0,
    errorCount,
    ruleCount: rules.length + files.length + commands.length,
    ruleNames: rules.map((r) => r.linterRule),
  };
}

interface MarkdownModeTotals {
  inlineErrors: number;
  inlineRules: number;
  frontmatterErrors: number;
  frontmatterRules: number;
}

/**
 * Frontmatter mode (Level 1 — a `vigiles:` YAML block) is DISABLED in lint:
 * KEPT IN CODE (`src/core/frontmatter.ts`, `verifyFrontmatterRules`,
 * `vigiles generate schema`), but INERT — lint no longer reads or verifies a
 * `vigiles:` block, so it never fires and never fails a build.
 *
 * WHY disabled-not-removed: the three-rung adoption ladder (inline / frontmatter
 * / typed spec) collapsed to TWO on-ramps — inline comments (the zero-TS floor)
 * and the typed `.spec.ts` (the source of truth). Frontmatter mode was the
 * weakest middle rung and an undocumented-but-live surface that muddied the
 * spec-first story (it literally confused a review). With ~no users to break,
 * gating it off makes lint coherent (verify compiled output + inline marks +
 * specs, nothing else) while preserving the code so the decision is reversible:
 * flip this to `true` to re-enable. See `research/pre-release-focus.md` and the
 * parked note in `docs/markdown-mode.md`.
 */
const FRONTMATTER_MODE_ENABLED: boolean = false;

/**
 * Verify inline `<!-- vigiles:enforce -->` comments (and, when
 * {@link FRONTMATTER_MODE_ENABLED}, `vigiles:` YAML frontmatter) in instruction
 * files that aren't managed by a spec.
 *
 * Spec mode is the source of truth when it exists, so a literal
 * `<!-- vigiles:enforce ... -->` snippet that survived into compiled
 * markdown (or an example in a spec-managed file) must not trip lint. A
 * file is spec-managed iff it has a sibling `<file>.spec.ts` OR its own
 * `<!-- vigiles:sha256:... compiled from <spec> -->` header. A rule
 * declared both inline and in frontmatter is verified once (inline wins as
 * the first source). See docs/markdown-mode.md.
 */
function verifyMarkdownModeRules(
  files: string[],
  silent: boolean,
  config?: VigilesConfig,
): MarkdownModeTotals {
  const totals: MarkdownModeTotals = {
    inlineErrors: 0,
    inlineRules: 0,
    frontmatterErrors: 0,
    frontmatterRules: 0,
  };
  if (!silent && files.length > 0) {
    console.log("\nInline + frontmatter rule verification:");
  }
  const linterOptions: LinterOptions = {
    catalogOnly: config?.catalogOnly,
    linters: config?.linters,
  };
  const compiledFromRe =
    /<!--\s*vigiles:sha256:[a-f0-9]+\s+compiled from .+?\s*-->/;
  for (const filePath of files) {
    const abs = resolve(process.cwd(), filePath);
    if (existsSync(`${abs}.spec.ts`)) continue; // managed by sibling spec
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (compiledFromRe.test(content)) continue; // managed via hash header
    const inline = verifyInlineRules(filePath, silent, linterOptions);
    totals.inlineErrors += inline.errorCount;
    totals.inlineRules += inline.ruleCount;
    // Frontmatter mode is DISABLED (kept in code, inert in lint) — a `vigiles:`
    // block is ignored, never verified. See FRONTMATTER_MODE_ENABLED.
    if (FRONTMATTER_MODE_ENABLED) {
      const fm = verifyFrontmatterRules(
        filePath,
        silent,
        new Set(inline.ruleNames),
        linterOptions,
      );
      totals.frontmatterErrors += fm.errorCount;
      totals.frontmatterRules += fm.ruleCount;
    }
  }
  if (
    !silent &&
    files.length > 0 &&
    totals.inlineRules === 0 &&
    totals.frontmatterRules === 0
  ) {
    console.log(
      "  (no inline vigiles:enforce comments or vigiles: frontmatter found)",
    );
  }
  return totals;
}

/**
 * Unified lint command: verify hashes, report coverage gaps, detect duplicates,
 * suggest improvements.
 *
 * Flags:
 *   --summary   Print a single-line summary (for SessionStart hooks)
 *   --json      Print structured JSON report (for CI integration)
 */
/**
 * The repo root that `sharedDirs` resolve against. The caller's cwd (where
 * `.vigilesrc.json` lives) is used ONLY when the scan target is INSIDE it — e.g.
 * `lint packages/foo` from the repo root, where the shared tree is an ancestor of
 * the scoped subdir. When the target is NOT under cwd (`lint path/to/other-repo`),
 * we resolve against the TARGET itself, so a foreign-repo lint never lets the
 * caller's own files satisfy the target's bundled resources (scoped-lint integrity).
 */
function sharedDirsRootFor(scanTarget: string): string {
  const cwd = process.cwd();
  const target = resolve(scanTarget);
  const rel = relative(cwd, target);
  const underCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return underCwd ? cwd : target;
}

/**
 * Nested plugin bundles under a lint root — a directory that is itself a harness
 * (its own `.claude-plugin/plugin.json`, or its own skills dir) and is NOT the
 * root being linted.
 *
 * 🔴 WHY THIS EXISTS. Every per-surface check reads ONE root, so in a monorepo
 * holding `skills/` plus `plugins/  * /skills/` the nested skills were never scored
 * and nothing said so. Measured on a fixture: 4 skills over the description
 * budget, `lint .` reported 2, exit 0 — a repo reads that as green-with-2 while
 * the other 2 carry the same defect (#185). The failure is silent, which is the
 * shape this repo treats as worse than a loud one.
 *
 * Deliberately shallow (one level under a container dir): deep recursion would
 * sweep vendored corpora — this repo's own `test/dogfood/` holds real pinned
 * third-party plugins — and scoring someone else's vendored plugin as if it were
 * yours is the false-positive that gets a gate switched off.
 */
export function discoverNestedBundles(
  root: string,
  excludes: ExcludeSet,
): string[] {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "coverage",
    ".vigiles",
  ]);
  const isBundle = (dir: string): boolean =>
    existsSync(join(dir, ".claude-plugin", "plugin.json")) ||
    existsSync(join(dir, "skills"));
  // Root-relative to the REPO (excludes.root), not to `root`: `lint some/dir`
  // still honours a repo-root `exclude`. One predicate for every walk (#192).
  const excluded = (dir: string): boolean =>
    excludes.matches(relative(excludes.root, dir));

  let entries: string[];
  try {
    // eslint-disable-next-line no-restricted-syntax -- the nested-bundle walk: every entry is filtered by excludes.matches() below
    entries = readdirSync(root, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith("."),
      )
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = join(root, name);
    if (excluded(dir)) continue;
    // A container (`plugins/`) holds bundles; a bundle may also sit directly.
    if (isBundle(dir)) {
      out.push(dir);
      continue;
    }
    let inner: string[];
    try {
      // eslint-disable-next-line no-restricted-syntax -- the nested-bundle walk: every entry is filtered by excludes.matches() below
      inner = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const child of inner) {
      const sub = join(dir, child);
      if (excluded(sub)) continue;
      if (isBundle(sub)) out.push(sub);
    }
  }
  return out.sort();
}

/**
 * Run one per-surface check over EVERY root and sum its counters.
 *
 * The checks all share `(config, silent, adapter, root)` and return a small
 * record of numbers, so one wrapper covers all twenty rather than twenty edits —
 * and a check added later is swept in by using it, not by remembering to.
 */
function overBundles<T extends Record<string, number>>(
  fn: (
    config: VigilesConfig | undefined,
    silent: boolean,
    adapter: HarnessAdapter,
    root: string,
  ) => T,
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  roots: readonly string[],
): T {
  const [first, ...rest] = roots;
  const total = { ...fn(config, silent, adapter, first) };
  for (const root of rest) {
    const next = fn(config, silent, adapter, root);
    for (const key of Object.keys(next) as (keyof T)[])
      (total as Record<keyof T, number>)[key] =
        (total[key] ?? 0) + (next[key] ?? 0);
  }
  return total;
}

/**
 * Re-derive a compiled artifact's references from its SPEC, and report the dead
 * ones — the half of #173 that deleting the write-on-error did not close.
 *
 * 🔴 THE HOLE. `lint` verifies the integrity HASH, which answers "is this file
 * still what the spec compiled to" and says nothing about whether the things it
 * NAMES still exist. So a `CLAUDE.md` committed while its refs were live stays
 * green forever after the referenced file is deleted: `compile` errors, `lint`
 * prints "hash valid — All compiled files intact" and exits 0. Reproduced:
 *
 *     $ vigiles compile CLAUDE.md.spec.ts
 *     ✗ [stale-file] File not found: "docs/guide.md"
 *     $ vigiles lint .
 *     ✓ CLAUDE.md — hash valid       # exit 0
 *
 * The reporter named this residue himself when filing #173 and I deferred it;
 * it is the gap between what `README.md` promises of `lint` ("the CI gate …
 * broken refs") and what it checked. A hash is an integrity claim, not a
 * reference claim, and the two were being read as one.
 *
 * Cost is bounded: only specs whose compiled target actually EXISTS are loaded,
 * so a repo with no specs does no extra work at all.
 */
async function checkSpecRefs(
  excludes: ExcludeSet,
  config: VigilesConfig | undefined,
  silent: boolean,
  dialect: HarnessDialect,
): Promise<{ issues: number; errors: number }> {
  const sev = ruleSeverity(config?.rules?.["spec-refs"]) ?? "error";
  if (!sev) return { issues: 0, errors: 0 };
  const found: string[] = [];
  let knownAgents: readonly string[] | undefined;
  for (const specPath of findSpecs(excludes)) {
    const target = specPath.replace(/\.spec\.ts$/, "");
    if (!existsSync(target)) continue; // never compiled — `compile` reports it
    const spec = await loadSpec(specPath);
    if (!spec) continue;
    try {
      // Railway is the one type whose validation needs the sibling agent names;
      // collected lazily so a repo with no railway spec never pays for the walk.
      if (spec._specType === "railway")
        knownAgents ??= await collectAgentNames(excludes);
      const errors = specCompileErrors(
        spec,
        specPath,
        dialect,
        config,
        knownAgents ?? [],
      );
      for (const e of errors)
        found.push(`${target}: ${e.message} (from ${specPath})`);
    } catch {
      // A spec that will not load is `compile`'s finding, not this one's —
      // reporting it here would double-report and blame the wrong command.
      continue;
    }
  }
  if (found.length > 0 && !silent) {
    console.log("\nSpec reference check:\n");
    for (const msg of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${msg}`);
      ghAnnotate(sev === "error" ? "error" : "warning", msg);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * The ONE spec-type dispatcher, in the only shape both directions can share:
 * errors, no writing. `compile` reaches its compilers through the
 * `compile*ToFile` wrappers (which write and print); `checkSpecRefs` reaches the
 * SAME compilers through this, because a read must never write.
 *
 * Why it exists (#190): `checkSpecRefs` used to call `compileClaude` directly and
 * skip every other spec type, so a SKILL.md / subagent / railway artifact
 * committed with a since-deleted reference hashed cleanly against its own header
 * forever — `lint` green, `compile` red. Measured on this repo:
 * `examples/SKILL.md.spec.ts` names `skills/enforce-rules-format/SKILL.md`, which
 * does not exist (the skill lives under `.claude/skills/`), and `lint` reported
 * `hash valid`.
 *
 * A switch rather than a per-type "ref accessor": all four compilers already
 * return the same `errors: CompileError[]`, so there is nothing to normalize —
 * only the options differ. Exhaustive over `_specType`, so a FIFTH spec type is
 * a tsc error here instead of a silent skip, which is the failure this closes.
 */
function specCompileErrors(
  spec: AnySpec,
  specPath: string,
  dialect: HarnessDialect,
  config: VigilesConfig | undefined,
  knownAgents: readonly string[],
): readonly CompileError[] {
  const basePath = process.cwd();
  switch (spec._specType) {
    case "claude":
      return compileClaude(spec, {
        basePath,
        specFile: specPath,
        dialect,
        maxRules: config?.maxRules,
        maxTokens: config?.maxTokens,
        maxSectionLines: config?.maxSectionLines,
        catalogOnly: config?.catalogOnly,
        linters: config?.linters,
      }).errors;
    case "skill":
      return compileSkill(spec, { basePath, specFile: specPath, dialect })
        .errors;
    case "agent":
      return compileAgent(spec, { basePath, specFile: specPath, dialect })
        .errors;
    case "railway":
      return compileRailway(spec, { specFile: specPath, knownAgents }).errors;
    default:
      // A `pipeline` spec compiles through its underlying railway, so it has no
      // artifact of its own to re-derive refs for.
      return [];
  }
}

/**
 * Write a compiled artifact. Accepts ONLY a {@link StampedMarkdown}, so a body
 * that failed to compile cannot reach the disk — there is no stamp to pass.
 *
 * This replaces four copies of `writeFileSync(path, markdown)` that ran BEFORE
 * their error check (#173, reproduced in the skill/subagent/railway/generator
 * compilers after the CLAUDE.md one was fixed). Guarding four call sites would
 * have left the fifth writable; the type leaves nothing to remember.
 */
function writeArtifact(outputPath: string, artifact: StampedMarkdown): void {
  writeFileSync(resolve(process.cwd(), outputPath), artifact);
}

async function runLint(
  restArgs: string[],
  flags: string[],
  excludes: ExcludeSet,
  config?: VigilesConfig,
): Promise<LintReport> {
  const summary = flags.includes("--summary");
  const json = flags.includes("--json");
  const silent = summary || json;

  // P0-2: scope the surface checks (subagent contracts, skill resources, MCP, …)
  // to an explicit DIRECTORY target when one is given, instead of always scanning
  // the whole working dir and reporting surfaces the user didn't point at. Only a
  // SINGLE existing directory narrows; a file / several paths / none → cwd, so
  // bare `vigiles lint` (the CI-common case) stays byte-identical. scanPlugin
  // reads only under this root, so a surface outside it can never enter the report.
  // Computed BEFORE the harness resolves so auto-detection keys on the TARGET, not
  // cwd — `lint path/to/codex-repo` picks that repo's harness, not the caller's.
  const positional = restArgs.filter((a) => !a.startsWith("--"));
  const scanRoot =
    positional.length === 1 &&
    existsSync(positional[0]) &&
    lstatSync(positional[0]).isDirectory()
      ? resolve(positional[0])
      : process.cwd();

  // Resolve the active harness ONCE so the harness-specific checks below run
  // against the right adapter's dialect (tool/event catalogs) and surfaces —
  // not a hard-coded Claude Code default. A subagent-surface rule reports n/a
  // on a harness without subagents (Codex) rather than scanning nothing. Detect
  // against `scanRoot` (the target), so a scoped scan of another-harness repo
  // uses that repo's layout/dialect. Resolved BEFORE discovering instruction
  // files so the integrity sweep can include the harness's subagent dir (E2).
  const harnessFlag = harnessFlagFrom(flags);
  const lintSelection = resolveHarnessSelection({
    root: scanRoot,
    flag: harnessFlag,
    configHarness: normalizeHarnessList(config?.harness),
  });
  const adapter = lintSelection.adapter;

  // 🔴 WHICH ROOTS GET SCORED, and saying so either way (#185).
  //
  // Every per-surface check reads ONE root, so a monorepo with `skills/` plus
  // `plugins/*/skills/` scored only the first and said nothing — measured at 2
  // findings reported against 4 real ones, exit 0. A skipped surface that is not
  // announced reads as a clean surface.
  //
  // Default stays ROOT-ONLY on purpose: descending by default would start
  // scoring vendored third-party corpora (this repo's own `test/dogfood/` holds
  // pinned real plugins), and scoring someone else's plugin as if it were yours
  // is the false positive that gets a gate turned off. So the DEFAULT fixes the
  // SILENCE, and `bundles: "all"` fixes the COVERAGE — one exit code over the
  // whole repo, which is what a CI gate needs.
  const nestedBundles = discoverNestedBundles(scanRoot, excludes);
  const scoreAll = flags.includes("--bundles=all") || config?.bundles === "all";
  const lintRoots = scoreAll ? [scanRoot, ...nestedBundles] : [scanRoot];
  if (!silent && nestedBundles.length > 0) {
    const rel = nestedBundles.map((b) => relative(scanRoot, b) || b);
    console.log(
      scoreAll
        ? `\nScoring ${String(lintRoots.length)} bundles: the root + ${rel.join(", ")}`
        : `\n⚠ ${String(nestedBundles.length)} nested bundle(s) discovered but NOT scored: ${rel.join(", ")}\n` +
            `  Their skills/agents/hooks are not in the counters below. Add \`"bundles": "all"\` to ` +
            `.vigilesrc.json (or pass --bundles=all) to score them in this run.`,
    );
  }

  // Discover the compiled files whose integrity is verified. Include the active
  // harness's subagent dir (dogfood E2): a compiled `agents/<name>.md` carries a
  // vigiles hash, but the default glob only matched CLAUDE/AGENTS/SKILL, so a
  // hand-edit of a compiled subagent slipped past `lint`. A hand-written agent
  // (no hash header) stays a no-op, and require-instructions-spec is filename-
  // scoped to CLAUDE/AGENTS so agents are never falsely flagged as spec-less.
  const files = findInstructionFiles(
    restArgs,
    excludes,
    adapter.layout.agentDir,
  );

  // 1. Verify hashes and structure
  if (!silent) {
    if (files.length > 0) {
      console.log("Verifying compiled files...\n");
    } else {
      console.log("No compiled instruction files found.\n");
    }
  }
  const hashResult =
    files.length > 0
      ? check(files, silent)
      : { valid: true, hashErrors: 0, validationErrors: 0 };

  // 1b. Verify inline + frontmatter rules in instruction files not managed
  // by a spec. See verifyMarkdownModeRules / docs/markdown-mode.md.
  const md = verifyMarkdownModeRules(files, silent, config);
  const { inlineErrors, inlineRules, frontmatterErrors, frontmatterRules } = md;

  // 2. Coverage gaps (discover)
  if (!silent) console.log("\nLinter rule coverage:\n");
  const coverage = discover(excludes, silent);

  // 3. Duplicate rule detection (NCD). Scope to the requested files when
  // lint was invoked with explicit paths, so targeted CI checks don't
  // fail on unrelated duplicates elsewhere in the repo.
  if (!silent) console.log("\nDuplicate rule detection:\n");
  const dups = await findDuplicateRules(
    excludes,
    0.3,
    silent,
    restArgs.length > 0 ? files : undefined,
  );

  // 4. Guidance rule count (strengthen suggestions moved to /strengthen skill)
  const guidanceCount = await countGuidanceRules(excludes, silent);

  // 5. Integrity check (hand-edit detection via SHA-256 hash)
  const integritySeverity = config?.rules.integrity ?? "warn";
  let integrityErrors = 0;
  if (integritySeverity) {
    if (!silent) console.log("\nIntegrity check:\n");
    integrityErrors = checkIntegrityForFiles(files, integritySeverity, silent);
  }

  // 6. Coverage thresholds (gates CI when severity is "error")
  const coverageErrors = await checkCoverageThresholds(
    excludes,
    coverage,
    config,
    silent,
  );

  // 7. Orphan docs check — OPT-IN (the `orphans` block in .vigilesrc.json is
  // the on-switch). "Unreferenced" only means "rot" for a hand-cross-linked
  // corpus; on a nav-managed doc site (Docusaurus/MkDocs) the page graph lives
  // in config, not inline links, so an unconditional scan is ~all false
  // positives there (an OSS sweep confirmed it). So we scan only when the repo
  // declares the block; its `include` defaults to docs/ (research/ etc. are
  // opted into explicitly). `enforce("vigiles/orphan-docs")` in a spec only
  // validates the rule NAME — the block is what drives the scan.
  // 🔴 SEVERITY IS READ, not just the block's presence (#181). `orphan-docs` had
  // a RULE_META entry and a documented severity, and nothing ever read it: both
  // `"warn"` and `"off"` still exited 1, so a repo could only choose between an
  // always-blocking check and deleting the `orphans` block. `warn` now reports
  // without touching the exit code and `false`/`"off"` skips the scan, exactly
  // like every other rule.
  const orphanSeverity = ruleSeverity(config?.rules?.["orphan-docs"]) ?? "warn";
  const orphansCfg = orphanSeverity ? config?.orphans : undefined;
  if (!silent) console.log("\nOrphan docs check:\n");
  let orphanReport: ReturnType<typeof findOrphanDocs> = {
    include: [],
    totalDocs: 0,
    referencedDocs: [],
    orphans: [],
  };
  if (orphansCfg) {
    orphanReport = findOrphanDocs({
      basePath: process.cwd(),
      include: orphansCfg.include,
      exclude: orphansCfg.exclude,
      // The repo-wide `exclude` is the FLOOR under the rule's own `exclude`
      // (union, never override): an excluded corpus is neither an orphan
      // candidate nor a source of references that keep a doc alive (#192).
      repoExclude: excludes.ignore,
      // Exempt every registered harness's surface files (instruction file,
      // SKILL.md, subagents, commands) as orphan candidates — layout-driven so
      // core carries no harness literal (see src/core/orphans.ts).
      layouts: ADAPTERS.map((a) => a.layout),
    });
    if (!silent) {
      for (const line of formatOrphanReport(orphanReport).split("\n")) {
        console.log(`  ${line}`);
      }
    }
  } else if (!silent) {
    console.log(
      "  ⊘ not enabled — add an `orphans` block to .vigilesrc.json to opt in (scans docs/ by default)",
    );
  }

  // 7b. Untested-surface check — skills/agents/hooks shipping without a test or
  // eval. Warning by default (a nudge, exit 0); set rules.untested-{skill,agent,
  // hook} to "error" to gate CI. See src/test-coverage.ts and docs/rules/.
  // A compiled artifact's refs, re-derived from its spec — the hash says the file
  // is unchanged, not that what it names still exists (#173).
  const specRefs = await checkSpecRefs(
    excludes,
    config,
    silent,
    adapter.dialect,
  );

  const untested = overBundles(
    (c, s, a, r) => checkUntestedSurfaces(excludes, c, s, a, r),
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7c. Subagent tool-contract check — cross-reference each subagent's `tools:`
  // rail against the harness catalog (the moat). n/a on a harness with no
  // subagents. Off by default unless a severity is configured; warning surfaces
  // a typo/never-available tool, error gates CI.
  const toolContract = overBundles(
    checkSubagentToolContracts,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7d. Hook-event check — a hook registered under an event the harness doesn't
  // define never fires. High-precision (close typos only). Off unless configured.
  const hookEvents = overBundles(
    checkHookEvents,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7e. Subagent-frontmatter check — a subagent missing required frontmatter
  // (name + description) won't register. n/a on a harness with no subagents.
  const frontmatter = overBundles(
    checkFrontmatterSchema,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7f. MCP-config check — a declared MCP server with no command/url can't start.
  const mcpConfig = overBundles(
    checkMcpConfig,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7g. Skill-frontmatter — RECOMMEND explicit name/description on skills (a
  // reliable trigger surface). Best-practice nudge; skills load without it.
  const skillFm = overBundles(
    checkSkillFrontmatter,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7h. MCP tool-resolution — an `mcp__server__tool` in a contract whose server
  // the plugin doesn't declare can't resolve (the MCP half of the tool moat).
  const mcpToolResolves = overBundles(
    checkMcpToolResolves,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7i. Hook-script existence — a hook command referencing a missing script file
  // never runs. This comment used to add "matches Anthropic's own `claude plugin
  // validate`"; measured false on 2026-09-08 (Claude Code 2.1.263) — see
  // docs/rules/hook-script-exists.md and tools/measure-validate-overlap.mjs.
  const hookScripts = overBundles(
    checkHookScriptExists,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7j. Disallowed-tools — a `disallowedTools:` block-list typo blocks nothing
  // (the deny-side mirror of subagent-tool-contract; close-typo only).
  const disallowedTools = overBundles(
    checkDisallowedTools,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7k. Description-overlap — two model-invocable skills with near-identical
  // descriptions collide in the selector (deterministic NCD precision proxy).
  const descriptionOverlap = overBundles(
    checkDescriptionOverlap,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7k². Skill-description-budget — a model-invocable skill whose description is
  // so long the trigger signal is buried (heuristic proxy; degrades recall +
  // precision). Generous 500-char budget; warn-tier, never gates.
  const descriptionBudget = overBundles(
    checkDescriptionBudget,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7l. Frontmatter-valid — a `---` block that isn't valid YAML (warn; js-yaml is
  // stricter than some loaders, so verify before enforcing).
  const frontmatterValid = overBundles(
    checkFrontmatterValid,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7m. MCP hook-target — a `type: mcp_tool` hook action that's incomplete or
  // targets an undeclared server (the moat applied to the hook surface).
  const mcpHookTargets = overBundles(
    checkMcpHookTargets,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7n. Prefer-compiled-hooks — ONE discovery nudge (not per-hook) toward
  // compiled `vigiles/hook` artifacts when hand-written hooks ship. Recommendation.
  const preferCompiledHooks = overBundles(
    checkPreferCompiledHooks,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7o. Lethal-trifecta — a unit (subagent / model-invocable skill) whose tools
  // hold all three legs (read-private + ingest-untrusted + exfiltrate) is a
  // prompt-injection exfil path (Rule of Two). Capability SET-intersection.
  const lethalTrifecta = overBundles(
    checkLethalTrifecta,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7p. Skill-resource — a SKILL.md body referencing a bundled file that doesn't
  // exist on disk under the skill dir (the agent gets nothing). FP-safe.
  const skillResources = overBundles(
    checkSkillResourceResolves,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7q. Skill-missing-fence — a SKILL.md opening with `name:`/`description:` but no
  // `---` fence loads as plain body (invisible — no name/description/trigger).
  const skillFence = overBundles(
    checkSkillMissingFence,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7r. Plugin-dir-layout — functional surface dirs (skills/agents/commands) nested
  // inside the `.claude-plugin/` manifest dir where the harness can't see them.
  const pluginLayout = overBundles(
    checkPluginDirLayout,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7s. Delegation-trifecta — a lethal trifecta that emerges across a delegation
  // edge (a subagent's own ∪ delegated-to capability) though no single unit trips it.
  const delegationTrifecta = overBundles(
    checkDelegationTrifecta,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7t. Hook-block-ineffective — a hook that looks like it blocks but silently
  // doesn't (block decision on a non-blocking event, or the legacy `decision`
  // field on a permission-gated event). The #1 verified hook pain (#19009).
  const hookBlock = overBundles(
    checkHookBlockIneffective,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 7u. Hook-matcher — a hook `matcher` that doesn't fire as written (tool-name
  // typo, an uncompilable or unreachable MCP pattern, one too narrow for real
  // server naming, or an undeclared MCP server).
  const hookMatcher = overBundles(
    checkHookMatcher,
    config,
    silent,
    adapter,
    lintRoots,
  );

  // 8. Validate vigiles builder calls inside markdown code blocks — the
  // `doc-refs` rule, DEFAULT OFF. Illustrative blocks opt out via
  // `<!-- vigiles:ignore -->` (single block) or `<!-- vigiles:ignore-file -->`
  // (whole file). Same engine as spec.ts.
  //
  // 🔴 WHY OFF BY DEFAULT — the measurement, not a preference. Run across two
  // real repositories on 2026-08-19: 2 582 markdown files, 52 builder refs,
  // **0 true positives**, and every error it had ever raised was false — a
  // design note writing `cmd("npm test")` for a package that doesn't have that
  // script yet, a third-party `CLAUDE.md` captured verbatim as benchmark data.
  // The cause is structural: a fenced block in prose is a DRAWING of config, and
  // this pass read it as config. The consumer repo reached a clean `lint` only by
  // excluding a third of itself, after which the pass walked 604 files and found
  // 0 refs — fully inert, still paying for the walk. So it is now opt-in, and
  // when off the walk does not happen at all (that is the whole subtraction).
  //
  // ⚠️ Known gap for whoever improves it before flipping this back: the walker
  // globs without `dot`, so `.claude/**` — where real skills and agents live —
  // has never been scanned. The rule has never once looked at a deployed
  // instruction file; every ref it has ever judged was in prose.
  const docRefSeverity = ruleSeverity(config?.rules?.["doc-refs"]);
  if (!silent && docRefSeverity) console.log("\nMarkdown code block refs:\n");
  // 🔴 `config.exclude` REACHES THIS PASS. It did not, and that single omission is
  // why `lint` could not exit 0 on a repository that vendors other people's
  // markdown: this walker globs `**/*.md` from the repo root, so a third-party
  // `CLAUDE.md` captured verbatim as benchmark data was held to the same ref
  // validation as the repo's own docs — and the one config field documented to
  // stop exactly that ("vendored or benchmark fixtures the repo's own lint
  // shouldn't police") was never handed over.
  //
  // Measured on a consumer repo 2026-08-19: 9 broken refs, 8 of them inside a
  // directory the user had explicitly listed in `exclude`, all 9 still reported.
  // With no way to reach 0 the step was made `continue-on-error: true`, and a lint
  // whose exit code is discarded gates nothing — after which hand-written CI steps
  // grew to do the gating instead. One unpassed argument, that whole chain.
  const docRefReport: DocRefReport = docRefSeverity
    ? findDocRefs({ basePath: process.cwd(), ignore: excludes.ignore })
    : {
        filesScanned: 0,
        filesIgnored: 0,
        blocksIgnored: 0,
        refs: [],
        errors: [],
        unverified: 0,
        placeholders: 0,
      };
  if (!silent && docRefSeverity) {
    const rendered = formatDocRefReport(
      docRefReport,
      docRefSeverity === "error" ? "error" : "warn",
    );
    for (const line of rendered.split("\n")) {
      console.log(`  ${line}`);
    }
  }
  // Per-line GitHub annotations for each broken doc ref — each carries file+line,
  // so GitHub renders it INLINE on the PR diff (not just in the summary blob).
  // Previously this check reported to stdout only; the inline/spec checks already
  // annotate per-line, so this closes the gap that left doc-ref findings invisible
  // on the PR. CI-only (isGitHubActions); skipped under --json/--summary.
  if (isGitHubActions() && !silent && docRefSeverity) {
    for (const e of docRefReport.errors) {
      ghAnnotate(
        docRefSeverity === "error" ? "error" : "warning",
        `${e.kind}("${e.value}") — ${e.message}`,
        e.file,
        e.line,
      );
    }
  }

  // 9. Verify code-shaped symbol references live (see src/refs.ts).
  const symbolRefErrors = verifyMarkdownSymbols(files, silent);

  // 10. Verify `vigiles:mcp server#tool` marks against live MCP servers
  // (only when a .mcp.json declares them). See src/mcp.ts.
  const mcpRefErrors = await verifyMarkdownMcpRefs(files, silent);

  const report: LintReport = {
    hashErrors: hashResult.hashErrors,
    validationErrors: hashResult.validationErrors,
    inlineErrors,
    inlineRules,
    frontmatterErrors,
    frontmatterRules,
    specRefIssues: specRefs.issues,
    specRefErrors: specRefs.errors,
    duplicatePairs: dups.pairCount,
    duplicateSeverity:
      ruleSeverity(config?.rules?.["duplicate-rules"]) ?? "warn",
    coverageEnabled: coverage.enabled,
    coverageDocumented: coverage.documented,
    strengthenSuggestions: guidanceCount,
    integrityErrors,
    coverageErrors,
    orphanCount: orphanReport.orphans.length,
    orphanSeverity: orphanSeverity,
    untestedSurfaces: untested.untested,
    untestedErrors: untested.errors,
    toolContractIssues: toolContract.issues,
    toolContractErrors: toolContract.errors,
    hookEventIssues: hookEvents.issues,
    hookEventErrors: hookEvents.errors,
    frontmatterSchemaIssues: frontmatter.issues,
    frontmatterSchemaErrors: frontmatter.errors,
    mcpConfigIssues: mcpConfig.issues,
    mcpConfigErrors: mcpConfig.errors,
    skillFrontmatterIssues: skillFm.issues,
    skillFrontmatterErrors: skillFm.errors,
    mcpToolIssues: mcpToolResolves.issues,
    mcpToolErrors: mcpToolResolves.errors,
    hookScriptIssues: hookScripts.issues,
    hookScriptErrors: hookScripts.errors,
    disallowedToolIssues: disallowedTools.issues,
    disallowedToolErrors: disallowedTools.errors,
    descriptionOverlapIssues: descriptionOverlap.issues,
    descriptionOverlapErrors: descriptionOverlap.errors,
    descriptionBudgetIssues: descriptionBudget.issues,
    descriptionBudgetErrors: descriptionBudget.errors,
    frontmatterValidIssues: frontmatterValid.issues,
    frontmatterValidErrors: frontmatterValid.errors,
    mcpHookIssues: mcpHookTargets.issues,
    mcpHookErrors: mcpHookTargets.errors,
    preferCompiledHookIssues: preferCompiledHooks.issues,
    preferCompiledHookErrors: preferCompiledHooks.errors,
    lethalTrifectaIssues: lethalTrifecta.issues,
    lethalTrifectaErrors: lethalTrifecta.errors,
    skillResourceIssues: skillResources.issues,
    skillResourceErrors: skillResources.errors,
    skillFenceIssues: skillFence.issues,
    skillFenceErrors: skillFence.errors,
    pluginLayoutIssues: pluginLayout.issues,
    pluginLayoutErrors: pluginLayout.errors,
    delegationTrifectaIssues: delegationTrifecta.issues,
    delegationTrifectaErrors: delegationTrifecta.errors,
    hookBlockIssues: hookBlock.issues,
    hookBlockErrors: hookBlock.errors,
    hookMatcherIssues: hookMatcher.issues,
    hookMatcherErrors: hookMatcher.errors,
    // Only the "error" tier gates. At "warn" the findings are printed and
    // annotated, and the exit code is untouched — same contract as every other
    // opt-in rule here.
    docRefErrors: docRefSeverity === "error" ? docRefReport.errors.length : 0,
    symbolRefErrors,
    mcpRefErrors,
    files,
  };

  // The totals both surfaces quote, computed ONCE (#183). Attaching them to the
  // report is what makes the log line and `--json` incapable of disagreeing —
  // the previous gap was not a wrong number, it was two right numbers with
  // nothing explaining the difference.
  const totals = lintTotals(report);
  const reported: LintReport = { ...report, totals };

  // `--json-out=<file>` writes the JSON to disk while stdout keeps the
  // human-readable run — one scan, both artefacts (#182). A CI job needed both
  // (the log is what a human opens; the JSON is what the PR comment is built
  // from) and had to scan the repo TWICE to get them, which is the same work
  // done twice and grows with the corpus.
  const jsonOutFlag = flags.find((f) => f.startsWith("--json-out="));
  if (jsonOutFlag) {
    const dest = resolve(jsonOutFlag.slice("--json-out=".length));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `${JSON.stringify(reported, null, 2)}\n`);
    if (!silent) console.log(`\n✓ JSON report written to ${dest}`);
  }

  if (summary) {
    printLintSummary(reported);
  } else if (json) {
    console.log(JSON.stringify(reported, null, 2));
  } else {
    // The one number a reader can quote. Counting `⚠` lines gives a DIFFERENT
    // number, because some checks print one line per finding and others one line
    // carrying a count — so the log now states the finding total outright rather
    // than leaving the reader to infer it from line shapes.
    const code = lintExitCode(reported);
    console.log(
      `\n${String(totals.findings)} finding(s): ${String(totals.errors)} error, ` +
        `${String(totals.warnings)} warning — exit ${String(code)}`,
    );
  }

  return reported;
}

/** Single-line lint summary for SessionStart hooks — minimal token cost. */
function printLintSummary(report: LintReport): void {
  const parts: string[] = [];
  if (report.hashErrors > 0) parts.push(`${String(report.hashErrors)} stale`);
  if (report.validationErrors > 0)
    parts.push(`${String(report.validationErrors)} validation errors`);
  if (report.inlineErrors > 0)
    parts.push(`${String(report.inlineErrors)} inline errors`);
  if (report.frontmatterErrors > 0)
    parts.push(`${String(report.frontmatterErrors)} frontmatter errors`);
  if (report.duplicatePairs > 0)
    parts.push(`${String(report.duplicatePairs)} duplicates`);
  if (report.orphanCount > 0)
    parts.push(`${String(report.orphanCount)} orphan docs`);
  if (report.untestedSurfaces > 0)
    parts.push(`${String(report.untestedSurfaces)} untested surfaces`);
  if (report.docRefErrors > 0)
    parts.push(`${String(report.docRefErrors)} broken doc refs`);
  if (report.symbolRefErrors > 0)
    parts.push(`${String(report.symbolRefErrors)} broken symbol refs`);
  if (report.mcpRefErrors > 0)
    parts.push(`${String(report.mcpRefErrors)} broken MCP refs`);
  const undocumented = report.coverageEnabled - report.coverageDocumented;
  if (undocumented > 0)
    parts.push(`${String(undocumented)} undocumented rules`);
  if (report.strengthenSuggestions > 0)
    parts.push(
      `${String(report.strengthenSuggestions)} guidance (run /strengthen to upgrade)`,
    );
  if (report.integrityErrors > 0)
    parts.push(
      `${String(report.integrityErrors)} tampered (edit the .spec.ts source)`,
    );
  if (parts.length === 0) {
    console.log("vigiles: clean");
  } else {
    console.log(`vigiles: ${parts.join(" / ")}`);
  }
}

function collectDocumentedRules(excludes: ExcludeSet): Set<string> {
  const documented = new Set<string>();
  const mdFiles = globSync("**/CLAUDE.md", {
    ignore: excludes.globIgnore,
    cwd: process.cwd(),
  });
  for (const mdFile of mdFiles) {
    const content = readFileSync(resolve(process.cwd(), mdFile), "utf-8");
    const enforcedRe = /\*\*Enforced by:\*\*\s*`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = enforcedRe.exec(content)) !== null) {
      documented.add(m[1]);
    }
  }
  return documented;
}

interface CoverageTotals {
  enabled: number;
  documented: number;
}

function printLinterCoverage(
  linter: { linter: string; rules: string[] },
  documentedRules: Set<string>,
  silent = false,
): CoverageTotals {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  const documented = linter.rules.filter((r) =>
    documentedRules.has(`${linter.linter}/${r}`),
  );
  const undocumented = linter.rules.filter(
    (r) => !documentedRules.has(`${linter.linter}/${r}`),
  );
  const pct =
    linter.rules.length > 0
      ? Math.round((documented.length / linter.rules.length) * 100)
      : 0;

  log(
    `  ${linter.linter}: ${String(documented.length)}/${String(linter.rules.length)} rules documented (${String(pct)}%)`,
  );

  if (documented.length > 0 && documented.length <= 10) {
    for (const r of documented) {
      log(`    ✓ ${linter.linter}/${r}`);
    }
  }

  if (undocumented.length > 0) {
    const show = undocumented.slice(0, 5);
    log(`    Top undocumented:`);
    for (const r of show) {
      log(`    ✗ ${linter.linter}/${r}`);
    }
    if (undocumented.length > 5) {
      log(`    ... and ${String(undocumented.length - 5)} more`);
    }
  }
  log("");

  return { enabled: linter.rules.length, documented: documented.length };
}

function discover(excludes: ExcludeSet, silent = false): CoverageTotals {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };
  log("Scanning project for linter rules...\n");

  const result = generateTypes({ basePath: process.cwd() });
  const documentedRules = collectDocumentedRules(excludes);

  log("Detected linters:\n");

  let totalEnabled = 0;
  let totalDocumented = 0;

  for (const linter of result.linters) {
    const totals = printLinterCoverage(linter, documentedRules, silent);
    totalEnabled += totals.enabled;
    totalDocumented += totals.documented;
  }

  if (result.linters.length === 0) {
    log("  No linters detected.\n");
  }

  const totalPct =
    totalEnabled > 0 ? Math.round((totalDocumented / totalEnabled) * 100) : 0;
  log(
    `Coverage: ${String(totalDocumented)}/${String(totalEnabled)} rules documented (${String(totalPct)}%)`,
  );

  if (totalDocumented < totalEnabled) {
    log(
      `\nConsider adding enforce() rules for frequently-triggered undocumented rules.`,
    );
    log(`The agent encounters these rules but has no context about WHY.`);
  }

  return { enabled: totalEnabled, documented: totalDocumented };
}

/** This package's own version (from the installed package.json). */
function getVersion(): string {
  try {
    // dist/cli.js → ../package.json (the package root).
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The dependency range to pin `vigiles` to (the running CLI's major, e.g.
 * `^3`). Falls back to `latest` for the unreleased dev placeholder version. */
function vigilesDepSpec(): string {
  const major = parseInt(getVersion(), 10);
  return Number.isFinite(major) && major > 0 ? `^${String(major)}` : "latest";
}

/** True when the file carries a vigiles integrity hash (i.e. it is a compiled artifact we own,
 * safe to overwrite — not hand-written prose).
 *
 * 🔴 This used to read the FIRST LINE only. A compiled SKILL.md carries the header after its
 * frontmatter, so the first line is `---` and this returned false — vigiles would have treated
 * its own compiled skill as hand-written prose and refused to overwrite it. The whole-file read
 * is the cost of not encoding the header's position in a fourth place. */
function targetHasHash(absPath: string): boolean {
  try {
    return findIntegrityHeader(readFileSync(absPath, "utf-8")) !== null;
  } catch {
    return false;
  }
}

/**
 * Single-target spec scaffolder — the small building block behind the `init`
 * verb, NOT the wizard. Creates exactly one sibling `<target>.spec.ts`: it
 * faithfully ADOPTS an existing hand-written instruction file (non-destructive —
 * never overwrites the markdown) or writes a blank starter for a greenfield
 * target. Called directly for `vigiles init --target=<file>`, and once per
 * target by `setupPillar1`. The full onboarding (both layers, deps, CI, plugin)
 * is `setup()`.
 */
/** Classify an adoption target by its path: a `SKILL.md` is a skill, a file under
 * an `agents/` dir is a subagent, everything else is an instruction file. Used to
 * pick the right adopt function so `init --target=skills/x/SKILL.md` (the
 * per-surface path the audit report points at) makes a `skill()`/`experimental_agent()` spec. */
function surfaceKind(target: string): "skill" | "agent" | "instruction" {
  if (/^SKILL\.md$/i.test(basename(target))) return "skill";
  if (/(^|[/\\])agents[/\\]/.test(target)) return "agent";
  return "instruction";
}

function logAdoptedSurface(
  target: string,
  specPath: string,
  label: string,
  unmappedKeys: string[],
): void {
  const note =
    unmappedKeys.length > 0
      ? ` (review the // NOTE — unmapped frontmatter: ${unmappedKeys.join(", ")})`
      : "";
  console.log(
    `Adopted ${label} ${target} → ${specPath}${note}. ` +
      `Run \`vigiles compile\` and review the diff.`,
  );
}

/** Discover existing skill (`skills/<x>/SKILL.md`) and subagent (`agents/<x>.md`)
 * surfaces — under the bare or `.claude/` roots — that don't yet have a spec, so
 * bare `vigiles init` creates a spec for EVERY surface it can, not just the
 * instruction file. Shallow (top-level only) so it never walks node_modules or a
 * vendored plugin. CC paths are intentional here — `init` is the one composition
 * point allowed to know them (see adapter-aware-lint-rules). */
function discoverAdoptableSurfaces(cwd: string): string[] {
  const out: string[] = [];
  const unspecced = (rel: string): boolean =>
    existsSync(resolve(cwd, rel)) &&
    !existsSync(resolve(cwd, `${rel}.spec.ts`));
  for (const root of ["skills", ".claude/skills"]) {
    const abs = resolve(cwd, root);
    if (!existsSync(abs)) continue;
    // eslint-disable-next-line no-restricted-syntax -- init's shallow adoptable-surface sweep, top level only (exclude.ts exceptions)
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${root}/${e.name}/SKILL.md`;
      if (e.isDirectory() && unspecced(rel)) out.push(rel);
    }
  }
  for (const root of ["agents", ".claude/agents"]) {
    const abs = resolve(cwd, root);
    if (!existsSync(abs)) continue;
    // eslint-disable-next-line no-restricted-syntax -- init's shallow adoptable-surface sweep, top level only (exclude.ts exceptions)
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${root}/${e.name}`;
      if (e.isFile() && e.name.endsWith(".md") && unspecced(rel)) out.push(rel);
    }
  }
  return out;
}

/** The full adoptable-surface list `audit` reports: the instruction file (when it
 * exists hand-written, no spec) PLUS every skill/subagent surface without a spec.
 * Same notion `init` adopts; surfaced in the AuditReport + the terminal nudge so
 * the report's "Create spec" / "Create all specs" affordances have their paths.
 * Composition-root only — CC paths are intentional here (like discoverAdoptableSurfaces). */
function discoverAdoptableForAudit(
  root: string,
  instructionFile: string,
): string[] {
  const out: string[] = [];
  const instrAbs = resolve(root, instructionFile);
  if (
    existsSync(instrAbs) &&
    !targetHasHash(instrAbs) &&
    !existsSync(resolve(root, `${instructionFile}.spec.ts`))
  ) {
    out.push(instructionFile);
  }
  out.push(...discoverAdoptableSurfaces(root));
  return out;
}

/** Lint-config file BASENAMES whose CONTENTS (textual, NEVER executed) reveal
 * which rules a repo has configured — read best-effort for the rule-inventory
 * teaser. Deliberately not resolved/executed (that would be the RCE path); we
 * grep the raw text. Includes oxlint + biome (same rule names as ESLint) since
 * modern TS repos lint with them. */
const RULE_INVENTORY_CONFIG_FILES = new Set([
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".oxlintrc.json",
  ".oxlintrc.jsonc",
  "oxlint.json",
  "biome.json",
  "biome.jsonc",
  "ruff.toml",
  ".ruff.toml",
  "pyproject.toml",
  ".pylintrc",
  "clippy.toml",
  ".clippy.toml",
  ".rubocop.yml",
  ".stylelintrc",
  ".stylelintrc.json",
]);

/** Dirs never worth walking for a config file. */
const RULE_INVENTORY_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".yarn",
]);

/** readdir that returns [] instead of throwing (perms, races). */
function safeReaddir(dir: string) {
  try {
    // eslint-disable-next-line no-restricted-syntax -- lint-config collection for the linter catalog, not repo policing (exclude.ts exceptions)
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Collect lint-config CONTENTS from the repo root AND nested subdirs (depth ≤ 2)
 * — textual only, never executed. Nested because monorepos/webapps keep their
 * eslint/oxlint config under `web/`, `frontend/`, `packages/*`, etc. Bounded
 * (skips heavy dirs; caps files) so it stays cheap on huge repos. */
function collectLintConfigText(root: string): string {
  let text = "";
  let filesRead = 0;
  const visit = (dir: string, depth: number): void => {
    if (filesRead >= 60) return;
    for (const e of safeReaddir(dir)) {
      if (e.isFile() && RULE_INVENTORY_CONFIG_FILES.has(e.name)) {
        try {
          text += readFileSync(resolve(dir, e.name), "utf-8") + "\n";
          filesRead++;
        } catch {
          /* best-effort */
        }
      } else if (
        e.isDirectory() &&
        depth < 2 &&
        !e.name.startsWith(".") &&
        !RULE_INVENTORY_SKIP_DIRS.has(e.name)
      ) {
        visit(resolve(dir, e.name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return text;
}

/** The deterministic rule-inventory teaser for `audit`: read the instruction
 * file(s) + lint-config TEXT (never executed) and map documented intents to
 * off-the-shelf rules + whether they're already configured. Best-effort, fs-only;
 * NO model, NO config execution — safe on any repo. Composition-root. */
function computeRuleInventory(
  root: string,
  instructionFile: string,
  excludes: ExcludeSet,
): RuleInventoryItem[] {
  try {
    // The inventory maps intents → rules; it has no per-file line provenance, so
    // the concatenated text is fine here (unlike the routing preview below).
    const instructionText = gatherInstructionFiles(
      root,
      instructionFile,
      excludes,
    )
      .map((f) => f.text)
      .join("\n");
    if (!instructionText.trim()) return [];
    return buildRuleInventory(instructionText, collectLintConfigText(root));
  } catch {
    return [];
  }
}

/** Gather EVERY agent instruction file present (not just the harness-native one) —
 * rules are often documented in AGENTS.md even under a claude-code harness — as a
 * list of {path, text} so each is routed SEPARATELY and keeps its OWN provenance
 * (concatenating first would corrupt per-file line numbers). Reads the ROOT
 * instruction files PLUS nested subdirectory-memory (`src/CLAUDE.md`,
 * `research/CLAUDE.md`, …), skipping fixture/demo/build/test dirs (`isFixturePath`)
 * so a repo's real memory is read without the test-fixture noise. `.claude/` rule
 * sources remain a future source. research/rule-enforcer-multilang-design.md §0. */
function gatherInstructionFiles(
  root: string,
  instructionFile: string,
  excludes: ExcludeSet,
): { path: string; text: string }[] {
  const raw: RawInstructionFile[] = [];
  const collect = (rel: string): void => {
    const p = resolve(root, rel);
    if (!existsSync(p)) return;
    raw.push({
      path: rel,
      canonical: realpathSync(p),
      text: readFileSync(p, "utf-8"),
    });
  };
  // Root instruction files first (stable, deterministic order).
  for (const name of new Set([instructionFile, "CLAUDE.md", "AGENTS.md"]))
    collect(name);
  // Nested subdirectory memory, minus fixture/demo/build/test noise. Two
  // filters, deliberately: `isFixturePath` is the zero-config floor (audit
  // reads any repo with no .vigilesrc.json), and the configured `exclude` is
  // unioned ON TOP for the dirs the heuristic cannot guess (#192).
  try {
    const nested = globSync(["**/CLAUDE.md", "**/AGENTS.md"], {
      cwd: root,
      ignore: excludes.globIgnore,
    })
      .filter((rel) => !isFixturePath(rel))
      .sort();
    for (const rel of nested) collect(rel);
  } catch {
    // best-effort — a glob failure just means root-only, never breaks the audit
  }
  // Dedup a CLAUDE.md⇄AGENTS.md mirror (symlink or byte-identical sync) to ONE
  // artifact so its rules aren't double-counted (compose-with-sync-tools).
  return dedupeInstructionFiles(raw);
}

/** The deterministic State-B routing preview for `audit`: segment the instruction
 * file(s) into atomic rules and route each (reuse / hook / meta / semantic / unrouted) —
 * NO model, fs-only. `undefined` when there's nothing to segment (kept off the
 * report). Best-effort; a routing failure never breaks the audit.
 *
 * The DYNAMIC catalog (every rule the repo's ESLint actually has + its enabled
 * state) sharpens matching — but enumerating it EXECUTES the linter, so it is an
 * OWN-REPO / CONSENTED capability (audit-side-effect-free): gated on the same
 * sticky `audit.measure` consent as the other executing checks AND on own-repo
 * (never a stranger's toolchain). The textual routing is the foreign-safe default;
 * the catalog only ADDS enabled-state nudges and matches named-but-`/`-broken rules. */
/** Does the repo actually USE Pylint — i.e. is there a real Pylint config to run
 * against? A DEDICATED pylintrc file (`.pylintrc`, `pylintrc`, `.pylintrc.toml`,
 * `pylintrc.toml`) is unambiguous. A SHARED file (`pyproject.toml`, `setup.cfg`,
 * `tox.ini`) counts ONLY when it carries a Pylint section — otherwise a Ruff-only
 * / packaging-only `pyproject.toml` would falsely make us spawn pylint and route
 * docs as `reuse`/`enabled` against a linter the repo doesn't use. Mirrors
 * Pylint's own config search order. */
function hasPythonSurface(root: string): boolean {
  const dedicated = [
    ".pylintrc",
    "pylintrc",
    ".pylintrc.toml",
    "pylintrc.toml",
  ];
  if (dedicated.some((f) => existsSync(resolve(root, f)))) return true;
  // A pylint section: `[tool.pylint...]` (pyproject) or `[pylint...]` / `[MASTER]`
  // / `[MESSAGES CONTROL]` (setup.cfg / tox.ini, incl. case variants).
  const pylintSection =
    /(\[tool\.pylint)|(\[pylint)|(\[MASTER\])|(\[MESSAGES CONTROL\])/i;
  for (const f of ["pyproject.toml", "setup.cfg", "tox.ini"]) {
    const p = resolve(root, f);
    if (existsSync(p)) {
      try {
        if (pylintSection.test(readFileSync(p, "utf-8"))) return true;
      } catch {
        /* unreadable — treat as no pylint config */
      }
    }
  }
  return false;
}

function computeRuleRouting(
  root: string,
  instructionFile: string,
  excludes: ExcludeSet,
): RuleRouting | undefined {
  try {
    const files = gatherInstructionFiles(root, instructionFile, excludes);
    if (files.every((f) => !f.text.trim())) return undefined;
    // Own-repo + consented → enumerate the live rule catalog of whichever
    // linter(s) the repo has: ESLint (JS/TS) and/or Pylint (Python), merged so a
    // polyglot repo matches against both. NOT gated on the agent harness — a
    // catalog is a property of the repo's LINTER (its config on disk), not of
    // Claude-Code-vs-Codex (adapter-aware-lint-rules: never gate a harness-
    // agnostic capability on CC). Each enumerate returns null when its linter
    // doesn't apply, so a repo with neither falls back to the foreign-safe textual
    // routing. Enumerating EXECUTES the linter (plugin code loads), hence own-repo
    // + consent — same posture for both.
    const ownRepo = resolve(root) === resolve(process.cwd());
    const consented = loadConfig().audit?.measure === true;
    const availableRules =
      ownRepo && consented
        ? mergeCatalogs(
            enumerateEslintCatalog(root),
            // Only spawn pylint when the repo actually has a Python surface —
            // avoids a needless (and possibly noisy) pylint run on a pure-JS repo.
            hasPythonSurface(root) ? enumeratePylintCatalog(root) : null,
          )
        : undefined;
    // Route each source SEPARATELY (each rule keeps its own file + line numbers),
    // then merge — so a CLAUDE.md rule and an AGENTS.md rule carry correct
    // provenance instead of line numbers offset by a concatenation.
    const routing = mergeRoutings(
      files.map((f) => routeRules(f.text, f.path, { availableRules })),
    );
    // Keep the routing if it found ANY confident rule, possible rule, or skipped
    // bullet — so the two-tier + skipped report surfaces even a doc with 0
    // confident rules (all its bullets landed in possible/skipped).
    return routing.segmented > 0 ||
      routing.possible.length > 0 ||
      routing.skipped.length > 0
      ? routing
      : undefined;
  } catch {
    return undefined;
  }
}

/** The terminal "adoptable surfaces" nudge — N un-spec'd surfaces + the create-all
 * command and up to ~5 per-surface commands (then "+K more"). "" when nothing to
 * adopt (a fully spec-managed repo says nothing). */
function formatAdoptableNudge(surfaces: readonly string[]): string {
  if (surfaces.length === 0) return "";
  const n = surfaces.length;
  // Lead with the VALUE, not the chore: a spec is the pull up from the gate to
  // the richer layer, so say what it BUYS (drift-proof references + testable),
  // not just "create one". The invitation is where richer-feature adoption is
  // won — keep it compelling, never a bare to-do (research/adoption-design.md §1).
  const lines = [
    `ℹ ${String(n)} surface${n === 1 ? "" : "s"} could be spec-managed — a spec re-verifies its references on every change (a hand-edit can't silently break them) and makes it testable.`,
    `  Adopt now, or one at a time with \`npx vigiles init --target=<path>\`:`,
  ];
  const shown = surfaces.slice(0, 5);
  for (const s of shown) lines.push(`    • npx vigiles init --target=${s}`);
  const more = n - shown.length;
  if (more > 0) lines.push(`    • +${String(more)} more`);
  // The remembered-decline affordance (non-evil contract): one keystroke to
  // silence, stated where it's shown so it's never a surprise nag.
  lines.push(`  (set "nudge": "dismissed" in .vigilesrc.json to hide this)`);
  return lines.join("\n");
}

/** A small, terse behavioral nudge — the deterministic read can't tell whether a
 * skill actually FIRES. "" when there are no model-invocable skills. */
function formatTriggerNudge(triggerableSkills: number): string {
  if (triggerableSkills <= 0) return "";
  const n = triggerableSkills;
  return (
    `ℹ Do your ${String(n)} skill${n === 1 ? "" : "s"} actually fire? The deterministic read can't tell — ` +
    `run \`audit\` interactively to measure, or add a \`*.eval.mjs\` declaring \`measureTriggerRate\` (vigiles).`
  );
}

/** A terminal summary of the rule map: the CONFIDENT lane counts + the POSSIBLE
 * (review) and SKIPPED tiers, with the honest caveat that detection is a
 * heuristic filter. The full per-rule map + skipped list live in the HTML/JSON
 * report; this is the "be clear about what was detected" headline. "" when there
 * is nothing to show. */
function formatRuleMapSummary(routing: RuleRouting | undefined): string {
  if (!routing) return "";
  const { counts, possible, skipped } = routing;
  const confident =
    counts.reuse +
    counts.hook +
    counts.unrouted +
    counts.semantic +
    counts.meta;
  if (confident === 0 && possible.length === 0 && skipped.length === 0)
    return "";
  // Lane counts, rendered from the single-source LANE_META (glyph + label).
  const lane = (c: RuleCategory): string =>
    `${LANE_META[c].glyph} ${String(counts[c])} ${LANE_META[c].label}`;
  const lines = [
    "Rule map [experimental] — how your prose rules could be enforced (heuristic, precision-first; misses some rules):",
    `  ${lane("reuse")} · ${lane("hook")} · ${lane("unrouted")} · ${lane("semantic")}` +
      (counts.meta > 0 ? ` · ${lane("meta")}` : ""),
  ];
  if (possible.length > 0)
    lines.push(
      `  ? ${String(possible.length)} possible — rule-ish, but below the confidence bar (review these)`,
    );
  if (skipped.length > 0)
    lines.push(
      `  ⊘ ${String(skipped.length)} skipped — not treated as rules (setup steps, descriptions, index entries, no norm signal)`,
    );
  lines.push(
    "  Detection is a best-effort filter — it won't catch every rule. Full map + skipped list in the report (or --json).",
  );
  return lines.join("\n");
}

function scaffoldSpec(args: string[]): void {
  const targetFlag = args.find((a) => a.startsWith("--target="));
  const target = targetFlag ? targetFlag.split("=")[1] : "CLAUDE.md";
  const specPath = `${target}.spec.ts`;
  const specAbs = resolve(process.cwd(), specPath);

  if (existsSync(specAbs)) {
    console.log(`${specPath} already exists.`);
    return;
  }

  // Auto-adopt: when the target file already exists with hand-written content
  // (no integrity header), faithfully convert it into a spec instead of
  // scaffolding a blank one — so `init` leaves you with a spec, not homework, and
  // `require-instructions-spec` is satisfied by construction. The compile that
  // follows reproduces the file (+ the header); review the diff. `vigiles eject`
  // reverses it. See research/install-enforcement-dx.md.
  const targetAbs = resolve(process.cwd(), target);
  if (existsSync(targetAbs) && !targetHasHash(targetAbs)) {
    const md = readFileSync(targetAbs, "utf-8");
    mkdirSync(dirname(specAbs), { recursive: true });
    const kind = surfaceKind(target);
    if (kind === "skill") {
      const { source, unmappedKeys } = adoptSkill(
        md,
        basename(dirname(target)),
      );
      writeFileSync(specAbs, source);
      logAdoptedSurface(target, specPath, "skill", unmappedKeys);
    } else if (kind === "agent") {
      const { source, unmappedKeys } = adoptAgent(md, basename(target, ".md"));
      writeFileSync(specAbs, source);
      logAdoptedSurface(target, specPath, "subagent", unmappedKeys);
    } else {
      const { source, tier, sectionCount, adoptedRefs } = adoptMarkdown(
        md,
        basename(target),
        // RESOLVE-NOW, not a heuristic. The undecidable question is "is this OUR
        // path or one inside the repo this document DESCRIBES" — the wall that
        // disabled `doc-refs`. Asking "does it resolve here, right now?" sidesteps
        // it: a described repo's path does not exist locally, so only already-green
        // refs are emitted and adoption can never turn a passing file red.
        { exists: (ref) => existsSync(resolve(process.cwd(), ref)) },
      );
      writeFileSync(specAbs, source);
      console.log(
        `Adopted ${target} → ${specPath} (${tier}, ${String(sectionCount)} section${sectionCount === 1 ? "" : "s"}). ` +
          (adoptedRefs && adoptedRefs.length > 0
            ? `${String(adoptedRefs.length)} reference${adoptedRefs.length === 1 ? "" : "s"} resolved and became verified \`file()\` calls — they now fail the build if the file moves. `
            : "") +
          `Run \`vigiles compile\` and review the diff; the \`/strengthen\` skill upgrades prose to verified rules.`,
      );
      // Adoption infers NO RULES (that stays `strengthen`'s job) but it DOES now
      // extract refs that resolve — measured 2026-08-28 on a 51-skill monorepo,
      // where extracting nothing meant the cost landed at once (build artifact,
      // edits into TS) while the payoff waited on a manual pass nobody ran.
      if (tier === "raw")
        console.log(
          `  ℹ 0 refs extracted — this spec verifies nothing yet. Wrap paths in \`file()\` ` +
            `and commands in \`cmd()\` to make \`compile\` check them.`,
        );
    }
    return;
  }

  // The compiled output is derived from the spec FILE path; the spec's `target`
  // field is the h1 + the name the compiler validates against, so it must be the
  // bare filename even when the spec lives in a subdir (e.g. a sync tool's
  // `.ruler/AGENTS.md.spec.ts` source slot → target "AGENTS.md").
  const targetName = basename(target);
  const targetLine =
    targetName !== "CLAUDE.md" ? `\n  target: "${targetName}",` : "";
  // Import ONLY what the scaffold uses (`claude`) — a strict ESLint with
  // \`no-unused-vars\` + \`--max-warnings=0\` (common in CI) would otherwise fail
  // the moment this is committed, because the enforce()/guidance() examples
  // below are commented out. The commented import shows what to add when you
  // write a real rule.
  const template = `import { instructionFile } from "vigiles/spec";
// When you add rules below, import the builders you use, e.g.:
// import { instructionFile, enforce, guidance } from "vigiles/spec";

export default instructionFile({${targetLine}
  sections: {
    // Prose sections become ## headings in the compiled output.
    // Do not add # or ## headers inside sections.
    // positioning: "What this project does and why.",

    // This section is included in the compiled output to help agents
    // understand how to work with specs. Remove it once your team is familiar.
    "how-to-edit": "This file is compiled from a .spec.ts file. Do not edit it directly — edit the spec and run 'npx vigiles compile'. To add a rule: add to the rules object in the spec.",
  },

  commands: {
    // Commands are verified against package.json at compile time.
    // "npm run build": "Compile the project",
    // "npm test": "Run all tests",
  },

  keyFiles: {
    // File paths are verified to exist at compile time.
    // "src/index.ts": "Main entry point",
  },

  rules: {
    // enforce() — backed by a linter rule, verified to exist AND be enabled:
    // "no-console": enforce("eslint/no-console", "Use structured logger."),
    //
    // guidance() — prose only, no enforcement:
    // "research-first": guidance("Google unfamiliar APIs before implementing."),
  },
});
`;
  mkdirSync(dirname(specAbs), { recursive: true });
  writeFileSync(specAbs, template);
  console.log(`Created ${specPath} — edit it and run \`vigiles compile\`.`);
}

/**
 * `vigiles eject [file]` — the inverse of `compile`: hand a compiled instruction
 * file back to the user as plain, hand-owned markdown. Strips the `vigiles:sha256`
 * integrity header, adds a `require-instructions-spec` disable marker so `lint` stays quiet,
 * and removes the spec that managed it (`--keep-spec` to leave it). The
 * "managed-but-ejectable" escape hatch: adopting a typed spec is never a one-way
 * door.
 */
function eject(args: string[]): void {
  const keepSpec = args.includes("--keep-spec");
  const file = args.find((a) => !a.startsWith("-")) ?? "CLAUDE.md";
  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    console.error(`✗ ${file}: no such file.`);
    process.exitCode = 1;
    return;
  }
  const ejected = ejectMarkdown(readFileSync(abs, "utf-8"));
  if (!ejected) {
    console.log(
      `${file} is not vigiles-managed (no integrity header) — nothing to eject.`,
    );
    return;
  }
  writeFileSync(abs, ejected.markdown);
  console.log(`✓ Ejected ${file} — it's now plain, hand-owned markdown.`);
  const specAbs = resolve(process.cwd(), ejected.specFile);
  // SAFETY: the `compiled from <path>` header is untrusted text — a hand-edited /
  // forged header could name `package.json` or `../../secret`, and a blind rmSync
  // would delete it. Only ever remove a `.spec.ts` that resolves INSIDE the
  // project (no `..` escape).
  const relSpec = relative(resolve(process.cwd()), specAbs);
  const isSafeSpecTarget =
    ejected.specFile.endsWith(".spec.ts") &&
    relSpec !== "" &&
    !relSpec.startsWith("..");
  if (existsSync(specAbs)) {
    if (!isSafeSpecTarget) {
      console.log(
        `  ⚠ Kept ${ejected.specFile} — the integrity header names a path that isn't a .spec.ts inside this project (it may have been hand-edited); refusing to delete it. Remove it yourself if that's intended.`,
      );
    } else if (keepSpec) {
      console.log(
        `  Kept ${ejected.specFile} (--keep-spec) — but \`vigiles compile\` would re-manage ${file}.`,
      );
    } else if (specReferencedElsewhere(ejected.specFile, file)) {
      // A multi-target spec (e.g. `target: ["CLAUDE.md", "docs/AGENTS.md"]`, or a
      // mirror) compiles to several files — possibly in other directories — that
      // all name the SAME source in their header. Deleting it while ANY of them is
      // still managed would orphan that file. So keep the spec until its last
      // consumer is ejected.
      console.log(
        `  Kept ${ejected.specFile} — another compiled file in this project is still managed by it (a multi-target / mirrored spec); deleting it would orphan that file. Eject the others too, or remove the spec by hand once it's unused.`,
      );
    } else {
      rmSync(specAbs);
      console.log(`  Removed ${ejected.specFile} (the spec that managed it).`);
    }
  }
  // The disable marker is only added to instruction files (not skills/agents),
  // so only mention it when it was actually written.
  if (ejected.markdown.startsWith(REQUIRE_INSTRUCTIONS_SPEC_DISABLE)) {
    console.log(
      `  Left a \`${REQUIRE_INSTRUCTIONS_SPEC_DISABLE}\` marker so \`vigiles lint\` won't ask for a spec; delete it if you remove vigiles entirely.`,
    );
  }
}

/**
 * Whether another compiled markdown file ANYWHERE under the project still carries
 * an integrity header naming `specFile` — i.e. the spec has OTHER compiled outputs
 * (a multi-target `target: [...]` spec or a CLAUDE.md⇄AGENTS.md mirror, possibly
 * in a different directory like `docs/AGENTS.md`), so removing it would orphan
 * them. Walks the project tree from cwd, skipping heavy/irrelevant dirs; the
 * ejected file itself is skipped (its header was already stripped). Matches on the
 * RESOLVED spec path (not basename), so two unrelated specs that happen to share a
 * filename — `src/CLAUDE.md.spec.ts` vs `CLAUDE.md.spec.ts`, common in a monorepo —
 * don't collide; genuine sibling outputs of one compile carry the identical
 * recorded spec path. Best-effort: an unreadable file is ignored.
 */
function specReferencedElsewhere(
  specFile: string,
  ejectedFile: string,
): boolean {
  const root = resolve(process.cwd());
  const ejectedAbs = resolve(root, ejectedFile);
  const specAbs = resolve(root, specFile);
  const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    "out",
  ]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      // eslint-disable-next-line no-restricted-syntax -- eject's is-this-spec-compiled-elsewhere safety check; wider is safer (exclude.ts exceptions)
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(p);
        continue;
      }
      if (!e.name.endsWith(".md") || p === ejectedAbs) continue;
      try {
        const header = parseIntegrityHeader(readFileSync(p, "utf-8"));
        if (header && resolve(root, header.specFile) === specAbs) return true;
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

/** Full GitHub Actions workflow that wires the production `zernie/vigiles@v1`
 * Action (lint pillar) and, when the test pillar is set up, a deterministic
 * harness job. */
/** The npm package(s) that provide each harness's CLI binary — the deterministic
 * harness tier spawns the real agent CLI against a mock model (no API key). A repo
 * targeting both harnesses installs both. */
function harnessTestBinaries(harnesses: string[]): string {
  const pkgs: string[] = [];
  if (harnesses.includes("claude")) pkgs.push("@anthropic-ai/claude-code");
  if (harnesses.includes("codex")) pkgs.push("@openai/codex");
  // Fall back to Claude Code if the set is somehow empty (back-compatible default).
  return (pkgs.length > 0 ? pkgs : ["@anthropic-ai/claude-code"]).join(" ");
}

function vigilesWorkflow(
  plan: SetupPlan,
  harnesses: string[],
  hasPackageJson: boolean,
): string {
  // The lint job — ONLY when the lint pillar is selected (dogfood I4: a
  // `--test`-only setup must not wire a lint job).
  const lint = plan.lint
    ? `
  lint:
    # Lint pillar — verify the references in your instruction files (composite
    # Action over the published CLI). Posts a sticky PR comment + a \`valid\` output.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: zernie/vigiles@v1
`
    : "";
  // The test pillar's harness job runs `*.harness.mjs` files that
  // `import "vigiles"`, so it needs vigiles RESOLVABLE — a package.json +
  // install. A repo with no package.json can't run the JS test tier in CI at all
  // (the import won't resolve even though the CLI itself came from npx), so the
  // harness job is emitted ONLY when a package.json exists (Codex review / #111 /
  // dogfood I1) — otherwise the whole job fails, not just the install step. A
  // non-JS repo uses `audit`/`lint` (which need no toolchain — see
  // docs/non-js-harnesses.md); it opts into the JS test tier by adding a
  // package.json and re-running `init`.
  const harness =
    plan.test && hasPackageJson
      ? `
  harness:
    # Test pillar — run your *.harness.{mjs,ts} tests against the real agent CLI and
    # a scripted mock model (deterministic, no API key). Drop this job if you only
    # author runHook unit tests, or keep it for the deterministic tier.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: npm i -g ${harnessTestBinaries(harnesses)} # mock tier needs the binary, no API key
      - run: npx vigiles test

  eval-check:
    # Eval staleness gate — real-model evals run LOCALLY on your subscription
    # (\`npx vigiles eval --update\`, which commits a lock); this job VERIFIES those
    # committed results against the current inputs with NO model call. It stays a
    # green no-op until you commit your first lock. See docs/harness-testing.md.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: zernie/vigiles@v1
        with:
          command: eval-check
`
      : "";
  // No selectable jobs (e.g. `--no-lint --no-test`, or `--test` on a repo with no
  // package.json) → emit NOTHING, so `wireGha` writes no workflow. A `jobs:` with
  // no children is rejected by GitHub Actions and would leave the repo with broken
  // CI (Codex review). The generator never produces an invalid workflow.
  if (lint === "" && harness === "") return "";
  return `name: vigiles
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # for the sticky PR comment

jobs:${lint}${harness}`;
}

/**
 * Detect a workflow that drives vigiles through an OLD API — a bare `npx vigiles`
 * (a no-op help screen in v2+) rather than the `zernie/vigiles@` Action or a real
 * subcommand (`lint`/`test`/…). Upgrading users whose workflow predates the
 * subcommand split silently lose CI validation, so we flag it loudly.
 */
function workflowUsesStaleApi(content: string): boolean {
  if (content.includes("zernie/vigiles@")) return false; // uses the Action — fine
  if (!/\bvigiles\b/.test(content)) return false; // not a vigiles workflow
  const hasModernCmd =
    /vigiles\s+(lint|test|eval|compile|audit|generate-types|generate-schema|init)\b/.test(
      content,
    );
  return !hasModernCmd;
}

/**
 * Subcommands removed/renamed across majors → the replacement to suggest. A
 * workflow that still calls one is a silently-broken CI step (the removed
 * subcommand exits non-zero / no-ops), and this stays true even when the file
 * ALSO uses the Action or a modern command — so it is checked independently of
 * the bare-API heuristic above, which an Action reference short-circuits.
 */
const REMOVED_SUBCOMMANDS: Record<string, string> = {
  scan: "audit", // renamed: the Lighthouse report verb is `audit`
};

/** The first removed/renamed `vigiles <sub>` a workflow still calls, if any. */
function workflowRemovedSubcommand(
  content: string,
): { sub: string; replacement: string } | null {
  for (const [sub, replacement] of Object.entries(REMOVED_SUBCOMMANDS)) {
    if (new RegExp(`vigiles\\s+${sub}\\b`).test(content))
      return { sub, replacement };
  }
  return null;
}

/** Rewrite removed/renamed `vigiles <sub>` invocations in place (scan → audit).
 * Surgical — preserves the rest of the user's workflow. */
function rewriteRemovedSubcommands(content: string): string {
  let out = content;
  for (const [sub, replacement] of Object.entries(REMOVED_SUBCOMMANDS)) {
    out = out.replace(
      new RegExp(`(vigiles\\s+)${sub}\\b`, "g"),
      `$1${replacement}`,
    );
  }
  return out;
}

/** Create `.github/workflows/vigiles.yml`. Returns the files it wrote (for the
 * commit hint). An existing workflow is never clobbered unless `--force`, but a
 * STALE one (old bare-`npx vigiles` API, or a removed subcommand) is reported
 * loudly instead of silently skipped — and rewritten in place with `--force`. */
function wireGha(plan: SetupPlan, harnesses: string[]): string[] {
  const dir = resolve(process.cwd(), ".github", "workflows");
  const path = resolve(dir, "vigiles.yml");
  const rel = ".github/workflows/vigiles.yml";
  const hasPackageJson = existsSync(resolve(process.cwd(), "package.json"));
  if (existsSync(path)) {
    const content = readFileSync(path, "utf-8");
    const removed = workflowRemovedSubcommand(content);
    if (removed) {
      if (plan.force) {
        writeFileSync(path, rewriteRemovedSubcommands(content));
        console.log(
          `✓ Rewrote ${rel} (vigiles ${removed.sub} → ${removed.replacement})`,
        );
        return [rel];
      }
      console.log(
        `⚠ ${rel} is STALE — it runs \`vigiles ${removed.sub}\`,\n` +
          `  which was removed/renamed (now \`vigiles ${removed.replacement}\`). That CI\n` +
          "  step is silently broken. Fix it:\n" +
          `    - re-run \`vigiles init --force\` to rewrite it in place (vigiles ${removed.sub} → ${removed.replacement}), or\n` +
          "    - switch the run step to `uses: zernie/vigiles@v1` (the composite Action).",
      );
    } else if (workflowUsesStaleApi(content)) {
      if (plan.force) {
        const regenerated = vigilesWorkflow(plan, harnesses, hasPackageJson);
        if (regenerated === "") return []; // no jobs → leave the stale file, don't write an empty one
        writeFileSync(path, regenerated);
        console.log(`✓ Regenerated ${rel} (was a stale bare \`npx vigiles\`)`);
        return [rel];
      }
      console.log(
        `⚠ ${rel} is STALE — it runs a bare \`npx vigiles\`,\n` +
          "  which is a no-op help screen now. CI is silently not validating anything. Fix it:\n" +
          "    - re-run `vigiles init --force` to regenerate the workflow, or\n" +
          "    - replace its run step with `uses: zernie/vigiles@v1` + `run: npx vigiles test`.",
      );
    } else {
      console.log(`✓ ${rel} already exists (up to date)`);
    }
    return [];
  }
  const workflow = vigilesWorkflow(plan, harnesses, hasPackageJson);
  if (workflow === "") {
    // No selectable jobs (no-pillar setup, or a test-only run on a repo with no
    // package.json) → don't write an invalid empty-`jobs:` workflow.
    return [];
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, workflow);
  console.log(
    "✓ Created .github/workflows/vigiles.yml (uses zernie/vigiles@v1)",
  );
  return [".github/workflows/vigiles.yml"];
}

const STARTER_HARNESS = `/**
 * Starter harness test (Pillar 2) — scaffolded by \`vigiles init\`.
 * Proves a hook actually FIRES, deterministically and with no API key.
 *
 *   npm i -D vigiles          # the testing API this imports
 *   npx vigiles test          # or: node vigiles.harness.mjs
 *
 * Guide: https://github.com/zernie/vigiles/blob/main/docs/harness-testing.md
 */
import { runHook } from "vigiles";
import assert from "node:assert/strict";

// EXAMPLE — replace with one of YOUR hooks. This PreToolUse Bash guard blocks a
// destructive command; runHook pipes it a fake event and checks the decision.
const guard =
  \`CMD=$(cat | jq -r '.tool_input.command // empty'); \` +
  \`case "$CMD" in *"rm -rf /"*) echo blocked >&2; exit 2 ;; esac; exit 0\`;

const blocked = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf / --no-preserve-root" },
});
assert.ok(blocked.blocked, "guard should block \\\`rm -rf /\\\`");

const allowed = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
});
assert.ok(!allowed.blocked, "guard should allow a safe command");

console.log("\\u2713 hook blocks rm -rf / and allows safe commands");
`;

/** Pillar 2 — scaffold a starter harness test the user adapts to their hooks.
 * Returns the files it wrote (for the commit hint). */
function scaffoldPillar2(): string[] {
  const path = resolve(process.cwd(), "vigiles.harness.mjs");
  if (existsSync(path)) {
    console.log("✓ vigiles.harness.mjs already exists");
    return [];
  }
  writeFileSync(path, STARTER_HARNESS);
  console.log(
    "✓ Scaffolded vigiles.harness.mjs — Pillar 2 starter (npx vigiles test)",
  );
  return ["vigiles.harness.mjs"];
}

/** Interactive prompts (TTY only): the readline IO shell over the pure
 *  `collectSetupAnswers` (the Q&A logic is unit-tested in setup-plan.test.ts). */
async function promptSetup(): Promise<SetupAnswers> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask: AskFn = (q, def) =>
    new Promise((res) => {
      rl.question(q, (a) => {
        res(a.trim() || def);
      });
    });
  try {
    return await collectSetupAnswers(ask);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Project detection for setup wizard
// ---------------------------------------------------------------------------

interface DetectedProject {
  /** Instruction files found (with or without specs). */
  instructionFiles: { path: string; hasSpec: boolean; isSymlink: boolean }[];
  /** Agent tools detected. */
  agents: string[];
  /** Sync tools detected in package.json. */
  syncTools: string[];
  /** Non-markdown agent config files. */
  otherConfigs: string[];
  /** Whether Claude Code project config exists. */
  hasClaude: boolean;
}

const KNOWN_INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
const KNOWN_OTHER_CONFIGS: Record<string, string> = {
  ".cursorrules": "Cursor",
  ".github/copilot-instructions.md": "GitHub Copilot",
  ".windsurfrules": "Windsurf",
};
const KNOWN_SYNC_TOOLS = [
  "rule-porter",
  "rulesync",
  "vibe-cli",
  "@nichochar/rule-porter",
];

function detectProject(): DetectedProject {
  const cwd = process.cwd();
  const instructionFiles: DetectedProject["instructionFiles"] = [];
  const agents: string[] = [];
  const otherConfigs: string[] = [];

  // Check known instruction files
  for (const f of KNOWN_INSTRUCTION_FILES) {
    const full = resolve(cwd, f);
    if (existsSync(full)) {
      let isSymlink = false;
      try {
        isSymlink = lstatSync(full).isSymbolicLink();
      } catch {
        // ignore
      }
      const hasSpec = existsSync(resolve(cwd, `${f}.spec.ts`));
      instructionFiles.push({ path: f, hasSpec, isSymlink });
    }
  }

  // Detect agents from files
  if (
    instructionFiles.some((f) => f.path === "CLAUDE.md") ||
    existsSync(resolve(cwd, ".claude"))
  ) {
    agents.push("Claude Code");
  }
  if (instructionFiles.some((f) => f.path === "AGENTS.md")) {
    agents.push("Codex / GitHub Copilot");
  }

  // Check non-markdown configs
  for (const [path, agent] of Object.entries(KNOWN_OTHER_CONFIGS)) {
    if (existsSync(resolve(cwd, path))) {
      otherConfigs.push(`${path} (${agent})`);
      if (!agents.includes(agent)) agents.push(agent);
    }
  }

  // Check for sync tools in package.json
  const syncTools: string[] = [];
  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const tool of KNOWN_SYNC_TOOLS) {
        if (tool in allDeps) syncTools.push(tool);
      }
    } catch {
      // ignore
    }
  }

  return {
    instructionFiles,
    agents,
    syncTools,
    otherConfigs,
    hasClaude: existsSync(resolve(cwd, ".claude")),
  };
}

/** What Pillar-1 setup produced. */
interface Pillar1Result {
  /** Spec targets to mention in the summary (e.g. CLAUDE.md). */
  specTargets: string[];
  /** Files actually written (for the commit hint). */
  written: string[];
  /** Existing hand-written targets `init` faithfully adopted into a spec (the
   *  compiled output replaced them — the user reviews the diff). */
  adopted: string[];
}

/** The instruction-file targets Pillar 1 will create specs for — the harness's
 * native instruction file (CLAUDE.md for Claude Code, AGENTS.md for Codex),
 * plus any existing instruction file that lacks a spec. */
function determineTargets(
  detected: DetectedProject,
  targetValue: string | undefined,
  harnesses: string[],
): string[] {
  if (targetValue) return [targetValue];
  const targets: string[] = [];
  if (harnesses.includes("claude")) targets.push("CLAUDE.md");
  if (harnesses.includes("codex")) targets.push("AGENTS.md");
  if (targets.length === 0) targets.push("CLAUDE.md");
  // Any existing instruction file without a spec also gets one.
  for (const f of detected.instructionFiles) {
    if (!f.hasSpec && !targets.includes(f.path)) targets.push(f.path);
  }
  return targets;
}

/**
 * When CLAUDE.md and AGENTS.md are ONE artifact — a symlink, or kept
 * byte-identical by rulesync/Ruler — collapse them to a single canonical spec
 * target. Two specs would fight over one file and collide on the integrity hash
 * (see the "Compose With Sync Tools" rule). The mirror is distributed from the
 * canonical, not compiled separately.
 */
function collapseMirroredTargets(
  targets: string[],
  mirror: InstructionMirror | null,
): string[] {
  if (!mirror) return targets;
  // The compile source slot: the real file for a symlink, else CLAUDE.md (the
  // one Claude Code reads natively; the sync tool fans out to AGENTS.md).
  const canonical =
    mirror.kind === "symlink"
      ? (mirror.realTarget ?? "CLAUDE.md")
      : "CLAUDE.md";
  const mirrored = mirror.files.find((f) => f !== canonical);
  if (!mirrored) return targets;
  if (!targets.includes(canonical) && !targets.includes(mirrored)) {
    return targets; // neither file is a target — nothing to collapse
  }
  const collapsed = targets.filter((t) => t !== mirrored);
  if (!collapsed.includes(canonical)) collapsed.push(canonical);
  console.log(
    `Note: CLAUDE.md and AGENTS.md are one artifact (${mirror.kind}). ` +
      `Scaffolding a single spec for ${canonical}; ${mirrored} is its mirror ` +
      `(don't add a second spec — it would collide on the integrity hash).`,
  );
  return collapsed;
}

/**
 * When a detected rule-sync tool (rulesync / Ruler) regenerates a file vigiles
 * would compile to, REDIRECT the compile target to the tool's source slot
 * (`.ruler/AGENTS.md`, `.rulesync/rules/vigiles.md`). vigiles compiles upstream;
 * the tool distributes to CLAUDE.md/AGENTS.md/Cursor/… — so the integrity hash
 * never collides with the tool's output (the "Compose With Sync Tools" rule).
 */
function redirectSyncToolTargets(cwd: string, targets: string[]): string[] {
  const collisions = composeCollisions(cwd, targets);
  if (collisions.length === 0) return targets;
  const slotFor = new Map(collisions.map((c) => [c.target, c.redirectTo]));
  const out: string[] = [];
  for (const t of targets) {
    const redirected = slotFor.get(t) ?? t;
    if (!out.includes(redirected)) out.push(redirected);
  }
  const tool = collisions[0].tool;
  const slots = [...new Set(collisions.map((c) => c.redirectTo))].join(", ");
  const from = [...slotFor.keys()].join(", ");
  console.log(
    `Note: ${tool} detected — scaffolding the spec to compile into its source ` +
      `slot (${slots}) instead of ${from}, so ${tool} distributes it without ` +
      `staling the integrity hash.`,
  );
  return out;
}

/** Pillar 1 — specs + types + schema + compile. Scaffolds a spec for every
 * instruction file (so `--lint` always delivers a spec), but never compiles
 * OVER a hand-written file — that is left to the adopt-spec skill. */
async function setupPillar1(
  detected: DetectedProject,
  targetValue: string | undefined,
  harnesses: string[],
): Promise<Pillar1Result> {
  const cwd = process.cwd();
  const written: string[] = [];
  const adopted: string[] = [];
  // An explicit --target is honoured as-is; otherwise collapse a CLAUDE.md⇄
  // AGENTS.md mirror (symlink or synced) to one canonical spec, then redirect
  // into a sync tool's source slot when one would own the output.
  const instructionTargets = targetValue
    ? determineTargets(detected, targetValue, harnesses)
    : redirectSyncToolTargets(
        cwd,
        collapseMirroredTargets(
          determineTargets(detected, targetValue, harnesses),
          detectInstructionMirror(cwd),
        ),
      );
  // Bare `init` (no explicit --target) also adopts every existing skill +
  // subagent surface — "create all the specs it can", not just the instruction
  // file. An explicit --target stays scoped to that one surface.
  const targets = targetValue
    ? instructionTargets
    : [...instructionTargets, ...discoverAdoptableSurfaces(cwd)];

  // Create specs. An existing hand-written target is faithfully ADOPTED into a
  // spec (scaffoldSpec() does the convert), not clobbered with a blank one — so the
  // compile below reproduces it (the user reviews the diff). A greenfield target
  // gets a blank starter spec.
  for (const target of targets) {
    const specPath = `${target}.spec.ts`;
    const targetAbs = resolve(cwd, target);
    const willAdopt =
      existsSync(targetAbs) &&
      !targetHasHash(targetAbs) &&
      !existsSync(resolve(cwd, specPath));
    if (existsSync(resolve(cwd, specPath))) {
      console.log(`✓ ${specPath} already exists`);
    } else {
      scaffoldSpec(["--target=" + target]); // adopts existing content, else blank scaffold
      written.push(specPath);
      if (willAdopt) adopted.push(target);
    }
  }

  // Generate types + schema.
  console.log("\nScanning linters and project files...");
  const typesResult = generateTypes({ basePath: cwd });
  const outDir = resolve(cwd, ".vigiles");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(cwd, ".vigiles/generated.d.ts"), typesResult.dts);
  for (const l of typesResult.linters) {
    console.log(`  ${l.linter}: ${String(l.rules.length)} rules`);
  }
  if (typesResult.scripts.length > 0) {
    console.log(`  npm scripts: ${String(typesResult.scripts.length)}`);
  }
  console.log("✓ Generated .vigiles/generated.d.ts");
  written.push(".vigiles/generated.d.ts");

  const schemaResult = generateSchema({
    basePath: cwd,
    linters: loadConfig().linters,
  });
  writeFileSync(resolve(cwd, ".vigiles/schema.json"), schemaResult.json);
  console.log("✓ Generated .vigiles/schema.json (YAML-LSP frontmatter schema)");
  written.push(".vigiles/schema.json");

  // Compile — but NEVER overwrite an existing hand-written file during `init`:
  // we compile only GREENFIELD targets (the file doesn't exist yet) and targets
  // we already manage (carry our hash). An ADOPTED file is left untouched — the
  // user reviews the generated spec and runs `vigiles compile` themselves to
  // switch it to spec-managed (non-destructive by default; the compile is
  // byte-faithful, but it's the user's call to make, with a diff to review).
  //
  // There is no longer an "only if vigiles resolves" gate here. The spec host
  // serves a spec's `vigiles/spec` import from the CLI's OWN install (the
  // resolve hook in src/self-resolve.mts), so compiling needs no
  // `node_modules/vigiles` in the user's repo — and a repo with no
  // `package.json` at all (Python, Rust, Go) has no install to run.
  const initConfig = loadConfig();
  const excludes = excludeSet(cwd, initConfig.exclude);
  const specs = findSpecs(excludes).filter((s) => {
    const tf = resolve(cwd, s.replace(/\.spec\.ts$/, ""));
    return !existsSync(tf) || targetHasHash(tf);
  });
  if (specs.length > 0) {
    console.log("\nCompiling specs...");
    await compile(specs, initConfig, excludes);
  }

  return { specTargets: targets, written, adopted };
}

/** Whether a harness binary (`claude`, `codex`) is on PATH. */
function harnessBinaryPresent(bin: string): boolean {
  try {
    const { execSync: exec } =
      require("node:child_process") as typeof import("node:child_process");
    exec(`${bin} --version`, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

type InstallOutcome = "ok" | "failed" | "no-cli";

/** Run a plan's auto-install commands; classify the result. */
function runInstall(
  plan: ReturnType<typeof planPluginInstall>[number],
  exec: typeof import("node:child_process").execSync,
): InstallOutcome {
  if (plan.commands.length === 0) return "no-cli";
  try {
    for (const cmd of plan.commands) {
      exec(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    }
    return "ok";
  } catch {
    return "failed";
  }
}

/**
 * Report a plan's outcome. On anything but success, be LOUD — when an AGENT runs
 * `init` (no human at the TTY), a quiet "Install vigiles:" hint followed by
 * `/plugin` slash commands is a trap: the agent can't run a TUI slash command,
 * so the plugin silently never installs. Surface the failure as a warning AND
 * lead with the shell-runnable CLI form (which an agent CAN run), keeping the
 * slash commands clearly labelled as the in-TUI alternative for a human.
 */
function reportInstall(
  plan: ReturnType<typeof planPluginInstall>[number],
  outcome: InstallOutcome,
): void {
  if (outcome === "ok") {
    console.log(plan.successMessage);
    for (const note of plan.notes) console.log(`  ${note}`);
    return;
  }
  console.log(
    outcome === "failed"
      ? `⚠ vigiles plugin auto-install for ${plan.harness} FAILED — the plugin (hooks + skills) is NOT installed.`
      : `⚠ vigiles plugin for ${plan.harness} was NOT installed (the ${plan.harness} CLI isn't on PATH here).`,
  );
  if (plan.commands.length > 0) {
    console.log("  Finish from a shell (an agent can run these):");
    for (const cmd of plan.commands) console.log(`    ${cmd}`);
  }
  if (plan.manualSteps.length > 0) {
    console.log("  Or inside the Claude Code TUI (a human, not an agent):");
    for (const step of plan.manualSteps) console.log(`    ${step}`);
  }
  for (const note of plan.notes) console.log(`  ${note}`);
}

/**
 * Install vigiles's skills/hooks for the chosen harness(es) via the per-harness
 * `planPluginInstall` decision — Claude Code through the GLOBAL plugin
 * marketplace (nothing vendored into the repo), Codex via AGENTS.md-direct (no
 * global store). The decision is pure and unit-tested; this is the thin IO.
 */
function installPlugins(harnesses: string[]): void {
  const { execSync: exec } =
    require("node:child_process") as typeof import("node:child_process");
  const plans = planPluginInstall(harnesses, {
    hasClaude: harnesses.includes("claude") && harnessBinaryPresent("claude"),
  });

  for (const plan of plans) {
    console.log("");
    reportInstall(plan, runInstall(plan, exec));
  }
  // Claude Code gets its hooks from the global marketplace plugin; Codex has no
  // global store, so wire vigiles's proactive nudge hooks into the repo's
  // .codex/config.toml directly (the idiomatic, repo-committed place).
  if (harnesses.includes("codex")) wireCodexHooks();
  // Claude Code additionally gets a committed DECLARATION, so a collaborator who
  // clones and never runs `init` is told the project wants this plugin instead
  // of hitting the silence that costs a day. It does not install anything.
  if (harnesses.includes("claude")) declareVigilesPlugin();
}

/**
 * Write the project-level plugin declaration into `.claude/settings.json`.
 *
 * 🔴 **The honest claim.** This does NOT make the plugin available to a
 * collaborator: an external-source plugin declared project-level does not load
 * until each person installs it on their own machine (the boundary is
 * deliberate — plugins run arbitrary code with the user's privileges). What it
 * buys is that Claude Code then PROMPTS them with the install command, instead
 * of the silence a fresh clone gets today. Silent absence → a prompt.
 *
 * MERGES, never clobbers: this file holds the user's hooks, permissions and
 * other plugins. The merge rules are the pure, unit-tested
 * `addVigilesDeclaration`; this is only the IO around it. Invalid JSON is a loud
 * skip, never a rewrite — mirrors `wireCodexHooks`.
 */
function declareVigilesPlugin(): void {
  const path = resolve(process.cwd(), ".claude", "settings.json");
  // The vigiles repo IS the plugin — it must not declare itself as a consumer.
  const pkgPath = resolve(process.cwd(), "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
      };
      if (pkg.name === "vigiles") return;
    } catch {
      /* unreadable package.json — fall through, the declaration is harmless */
    }
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      console.log(
        "⚠ .claude/settings.json is not valid JSON — skipping the project plugin declaration (fix it, then re-run `vigiles init`).",
      );
      return;
    }
  }

  const edit = addVigilesDeclaration(settings);
  if (!edit.changed) {
    console.log(
      "  .claude/settings.json already declares the vigiles plugin — left as-is.",
    );
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(edit.settings, null, 2) + "\n");
  console.log(
    "✓ Declared the vigiles plugin in .claude/settings.json (commit it)\n" +
      "  This does NOT install it for anyone else — Claude Code will PROMPT a\n" +
      "  collaborator to run `claude plugin install vigiles@vigiles`, instead of\n" +
      "  the silence a fresh clone gets today.\n" +
      "  Nothing is vendored: the entry is a reference; the plugin still lives in\n" +
      "  the global cache, one copy shared across your repos.",
  );
}

/**
 * Wire vigiles's proactive nudge hooks into `.codex/config.toml` (idempotently).
 * Codex honors `additionalContext` on `PostToolUse`, and these run as direct
 * `npx vigiles hook-runtime …` commands (no plugin root / vendored script), so a
 * Codex user gets the same eval-lock + refs nudges a Claude Code user gets from
 * the marketplace plugin. The pure merge is `applyCodexPluginHooks` (unit-tested
 * in setup-plan.test.ts) — this only does the read/parse/write IO.
 */
function wireCodexHooks(): void {
  const path = resolve(process.cwd(), ".codex", "config.toml");
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = parseToml(readFileSync(path, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      console.log(
        "⚠ .codex/config.toml is not valid TOML — skipping Codex hook wiring (fix it, then re-run `vigiles init`).",
      );
      return;
    }
  }
  const merged = applyCodexPluginHooks(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeConfig(merged, "toml"));
  console.log(
    "✓ Wired the eval-lock + refs nudge hooks into .codex/config.toml (commit it)",
  );
}

/** Add/upgrade `vigiles` in the project's `devDependencies` (and move it out of
 * `dependencies` if it's there). Returns the files it wrote (for the commit
 * hint). No-op in the vigiles repo itself and when there is no package.json. */
function ensureVigilesDevDep(): string[] {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    return [];
  }
  if (pkg.name === "vigiles") return []; // don't self-depend in this repo

  const spec = vigilesDepSpec();
  let changed = false;

  // Move a stale/misplaced runtime dependency (e.g. a `github:zernie/vigiles`
  // git pin, or vigiles sitting in `dependencies`) into devDependencies.
  if (pkg.dependencies && "vigiles" in pkg.dependencies) {
    delete pkg.dependencies.vigiles;
    changed = true;
  }
  const dev = (pkg.devDependencies ??= {});
  if (dev.vigiles !== spec) {
    dev.vigiles = spec;
    changed = true;
  }
  if (!changed) return [];

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(
    `✓ Set vigiles@${spec} in devDependencies — run \`npm install\` to fetch it`,
  );
  return ["package.json"];
}

/** Map a canonical harness name (as stored in `.vigilesrc.json`, e.g.
 * `claude-code`) back to the SHORT working form the install/plan path keys on
 * (`claude`). Everything else passes through trimmed + lowercased. */
function shortHarness(name: string): string {
  const n = name.trim().toLowerCase();
  return n === "claude-code" ? "claude" : n;
}

/** Which harnesses to set up, in precedence order: an explicit `--harness=`
 * list, else an EXISTING `.vigilesrc.json` `harness` key, else auto-detected
 * from the repo (Claude Code / Codex), defaulting to Claude Code. */
function resolveHarnesses(
  parsed: ParsedSetupArgs,
  detected: DetectedProject,
  configHarness?: string | readonly string[],
): string[] {
  if (parsed.harness) {
    return parsed.harness.split(",").map(shortHarness).filter(Boolean);
  }
  // Honor an EXISTING config `harness` before re-detecting (dogfood I3):
  // re-running `init` on a repo that already declares its harness must target
  // that, not silently re-detect a different set. Config stores the CANONICAL
  // name (`claude-code`); the install/plan path keys on the SHORT form
  // (`claude`), so map it back.
  const fromConfig = [
    ...new Set(normalizeHarnessList(configHarness).map(shortHarness)),
  ];
  if (fromConfig.length > 0) return fromConfig;
  const set = new Set<string>();
  if (
    detected.hasClaude ||
    detected.agents.includes("Claude Code") ||
    detected.instructionFiles.some((f) => f.path === "CLAUDE.md")
  ) {
    set.add("claude");
  }
  if (
    detected.agents.includes("Codex / GitHub Copilot") ||
    detected.instructionFiles.some((f) => f.path === "AGENTS.md")
  ) {
    set.add("codex");
  }
  if (set.size === 0) set.add("claude");
  return [...set];
}

/** Print the project-detection summary line(s). */
function printDetection(detected: DetectedProject, harnesses: string[]): void {
  if (detected.agents.length > 0) {
    console.log(`Detected: ${detected.agents.join(", ")}`);
  }
  if (detected.otherConfigs.length > 0) {
    console.log(`Other agent configs: ${detected.otherConfigs.join(", ")}`);
  }
  if (detected.syncTools.length > 0) {
    console.log(`Sync tools: ${detected.syncTools.join(", ")}`);
  }
  for (const f of detected.instructionFiles) {
    if (f.isSymlink) console.log(`Note: ${f.path} is a symlink`);
  }
  console.log(`Harness: ${harnesses.join(", ")}`);
}

/** Print the closing next-steps list + an honest commit hint (only files
 * actually written this run). */
function printSetupSummary(opts: {
  plan: SetupPlan;
  strict: boolean;
  targets: string[];
  adopted: string[];
  written: string[];
}): void {
  const { plan, strict, targets, adopted, written } = opts;
  const specPathsList = targets.map((t) => `${t}.spec.ts`);
  console.log("\n---\nSetup complete.\n");

  // Next steps in the order a reader should do them. `npm install` is NOT a
  // prerequisite of `compile` any more (the spec host resolves `vigiles/spec`
  // from the CLI's own install) — it is listed because we just declared the
  // devDep, so installing it is what gives the editor the spec's types.
  const nextSteps: string[] = [];
  if (written.includes("package.json")) {
    nextSteps.push("Run `npm install` to fetch the vigiles dev dependency");
  }
  if (adopted.length > 0) {
    // Adoption is NON-DESTRUCTIVE: the file is untouched until you compile, so
    // the diff to review is what compile WOULD produce (byte-faithful).
    nextSteps.push(
      `Run \`npx vigiles compile\` to put ${adopted.join(", ")} under spec management — it reproduces the file + adds an integrity header, so review the diff (\`vigiles eject\` reverses it)`,
    );
    nextSteps.push(
      "Run the `/strengthen` skill to upgrade prose rules to verified enforce()/guard()",
    );
  } else if (specPathsList.length > 0) {
    nextSteps.push(
      `Edit ${specPathsList.join(", ")} — add your conventions, then \`npx vigiles compile\` (and \`/strengthen\`)`,
    );
  }
  if (plan.test) {
    nextSteps.push(
      "Edit vigiles.harness.mjs to test a real hook, then `npx vigiles test`",
    );
  }
  if (!strict) {
    nextSteps.push(
      "When ready, enforce specs + tests in CI: `npx vigiles init --strict`",
    );
  }
  nextSteps.forEach((s, i) => {
    console.log(`  ${String(i + 1)}. ${s}`);
  });

  // Only list files actually written this run (deduped, in a stable order).
  const files = [...new Set(written)];
  if (files.length > 0) {
    console.log(
      `\n  Commit:\n    git add ${files.join(" ")} && git commit -m "Add vigiles"`,
    );
  }
}

async function setup(args: string[]): Promise<void> {
  const parsed = parseSetupArgs(args);

  // Plan: defaults → flags → interactive prompts (only a human at a TTY).
  let plan = resolvePlan(parsed);
  const prompted = shouldPrompt(parsed, process.stdin.isTTY ?? false);
  if (prompted) {
    plan = resolvePlan(parsed, await promptSetup());
  }
  // Read strict from the RESOLVED plan, not the raw flag — an interactive "yes"
  // to the workflow tier (no `--strict` flag) sets plan.strict, and the config
  // write + summary must honor it.
  const strict = plan.strict;

  const pillars = [plan.lint && "lint", plan.test && "test"]
    .filter(Boolean)
    .join(" + ");
  console.log(
    `vigiles setup${strict ? " (strict)" : ""} — pillars: ${pillars}\n`,
  );

  // Detect project. An existing `.vigilesrc.json` `harness` (from a prior init /
  // a hand-authored config) wins over auto-detection (dogfood I3).
  const detected = detectProject();
  const harnesses = resolveHarnesses(parsed, detected, loadConfig().harness);
  printDetection(detected, harnesses);

  // Files actually written, accumulated for an honest commit hint.
  const written: string[] = [];

  // Lint pillar. The integrity GATE (structural rules on your raw files + CI +
  // devDep, written below) is what `lint` needs — it reads skills/agents/hooks
  // as-is, no spec required. Scaffolding typed specs (setupPillar1) is the INVITED
  // layer (`scaffoldSpecs`, on under `--strict` / the wizard's "full"), so a
  // gate-first `init` (or `init --no-plugin --no-test`) never forces a spec + a
  // compiled artifact on an existing harness. See `gate-first-adoption`.
  let targets: string[] = [];
  let adopted: string[] = [];
  if (plan.lint && plan.scaffoldSpecs) {
    console.log("");
    const p1 = await setupPillar1(detected, parsed.target, harnesses);
    targets = p1.specTargets;
    adopted = p1.adopted;
    written.push(...p1.written);
  }

  // Test pillar — test the harness.
  if (plan.test) {
    console.log("");
    written.push(...scaffoldPillar2());
  }

  // Add/upgrade the vigiles dev dependency (both pillars import from it).
  if (plan.lint || plan.test) {
    written.push(...ensureVigilesDevDep());
  }

  // CI — the production Action (+ a harness job when Pillar 2 is on).
  if (plan.gha) {
    console.log("");
    written.push(...wireGha(plan, harnesses));
  }

  // Plugin/skill install — per-harness (Claude marketplace / Codex direct).
  if (plan.plugin) {
    installPlugins(harnesses);
  }

  // Agent-specific guidance.
  if (targets.includes("AGENTS.md")) {
    console.log(
      "\n  Codex / Copilot reads AGENTS.md directly — no hooks needed.",
    );
    console.log(
      "  Run `npx vigiles compile` after spec edits. CI enforces freshness.",
    );
  }
  if (detected.otherConfigs.length > 0 && detected.syncTools.length === 0) {
    console.log(
      "\n  Non-markdown agent configs detected. Use a sync tool to convert:",
    );
    console.log("    npm install -D rule-porter");
  }

  // Project config — record the harness(es) so compile/lint select the dialect
  // deterministically (no cwd sniffing), plus strict rule severities on --strict
  // (or all-warn under --report-only).
  writeProjectConfig({
    harnesses,
    strict,
    reportOnly: parsed.reportOnly,
    lint: plan.lint,
    written,
  });

  printSetupSummary({ plan, strict, targets, adopted, written });

  // Surface the OTHER mode so both directions are discoverable — the two branches
  // are mutually exclusive (a run is either gate-only or full):
  //   • a gate-only setup → a ONE-LINE nudge to graduate to the full layer;
  //   • a NON-INTERACTIVE full setup → name `--ci-only`, because an agent/CI took the
  //     full default WITHOUT seeing the wizard's "gate vs full" fork, so it would
  //     otherwise never learn the flag exists (the discovery gap for the agent path).
  // Both are informational, never a prompt (a headless run must not hang), and the
  // interactive human who already chose "full" isn't re-nudged. See `gate-first-adoption`.
  const invite = gateOnlyInvitation(plan);
  if (invite) {
    console.log(`\n${invite}`);
  } else if (!prompted) {
    console.log(
      "\nℹ Ran the standard setup. Already have a harness, or not a JS/Python repo, and want only the CI integrity gate (nothing installed)? Re-run `npx vigiles init --ci-only`.",
    );
  }
}

/** Canonical, de-duplicated harness list → a config value (string when one). */
function harnessConfigValue(harnesses: string[]): string | string[] {
  const canon = [...new Set(harnesses.map(normalizeHarnessName))];
  return canon.length === 1 ? canon[0] : canon;
}

/**
 * Merge the resolved harness(es) (and strict rule severities) into
 * `.vigilesrc.json` without clobbering existing keys — an existing `harness`
 * stays, a missing one is added, a malformed file is left untouched.
 */
function writeProjectConfig(opts: {
  harnesses: string[];
  strict: boolean;
  reportOnly: boolean;
  /** Lint pillar on — gates writing the lint rule severities (test-only setups
   * record only the harness). */
  lint: boolean;
  written: string[];
}): void {
  const configPath = resolve(process.cwd(), ".vigilesrc.json");
  const existed = existsSync(configPath);
  let existing: Record<string, unknown> = {};
  if (existed) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      return; // user-owned malformed config — never clobber it
    }
  }
  const merged = mergeProjectConfig(existing, {
    harness: harnessConfigValue(opts.harnesses),
    strict: opts.strict,
    reportOnly: opts.reportOnly,
    lint: opts.lint,
  });
  if (!merged) return;
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✓ ${existed ? "Updated" : "Created"} .vigilesrc.json`);
  if (!opts.written.includes(".vigilesrc.json")) {
    opts.written.push(".vigilesrc.json");
  }
}

// ---------------------------------------------------------------------------
// Strengthen: guidance() → enforce() suggestions
// ---------------------------------------------------------------------------

function checkIntegrityForFiles(
  files: string[],
  severity: "warn" | "error",
  silent: boolean,
): number {
  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };

  let errorCount = 0;
  const basePath = process.cwd();

  for (const filePath of files) {
    const abs = resolve(basePath, filePath);
    if (!existsSync(abs)) continue;
    const result = checkIntegrity(readFileSync(abs, "utf-8"));

    if (!result.intact) {
      errorCount++;
      const marker = severity === "error" ? "✗" : "⚠";
      log(`  ${marker} ${filePath} — ${result.reason ?? "tampered"}`);
    } else if (!silent) {
      log(`  ✓ ${filePath}`);
    }
  }

  if (errorCount === 0) {
    log("  All compiled files intact.");
  }

  return severity === "error" ? errorCount : 0;
}

/**
 * The layout of the harness this repo actually targets — `--harness=`/config/
 * auto-detect, the SAME precedence `lint`, `compile` and `audit` use.
 *
 * 🔴 ONE RESOLVER, BECAUSE THE OTHER CALLERS DEFAULTED. `lint` threads
 * `adapter.layout` into `findUntestedSurfaces`; two entry points that call the very
 * same detector passed only a path, so `test-coverage.ts` fell back to
 * `claudeCodeLayout`. Reproduced 2026-08-12 on a `.codex/config.toml` fixture whose
 * only surface is `.codex/skills/foo/SKILL.md`: with the layout, one surface is
 * discovered; without it, ZERO — and a zero-surface scan is not an error, it is a
 * silence. The edit-time nudge said nothing, and `vigiles test`'s coverage
 * recorder threw away every probe an execution had legitimately produced, because
 * `recordsFrom` cannot resolve a probe against a surface list that is empty.
 *
 * Non-throwing on purpose: an unknown `--harness=` is a hard error where the user
 * typed it, but these callers are a hook and a post-run recorder, and neither may
 * turn a bad config key into a failed edit or a red test run.
 */
function harnessLayoutFor(
  root: string,
  config: VigilesConfig | undefined,
  flag?: string,
): PluginLayout {
  try {
    return resolveHarnessSelection({
      root,
      flag,
      configHarness: normalizeHarnessList(config?.harness),
    }).adapter.layout;
  } catch {
    return defaultAdapter.layout;
  }
}

/**
 * The `untested-*` rules AS THE DETECTOR TAKES THEM: which kinds this repo
 * enabled, and the discovery options merged from whichever of the three rules
 * carries them (`include` / `exclude` / `testExtension` are shared).
 *
 * 🔴 ONE READER, BECAUSE THE SECOND ONE DRIFTED. `vigiles lint` read the config
 * here; the PostToolUse nudge (`evalLockNudgeHookCommand`) called the same
 * detector with nothing but `basePath`. Reproduced 2026-08-12 on a two-file
 * fixture: with `"untested-skill": false` lint printed nothing and the nudge
 * still told the agent the skill was untested; with a configured
 * `include: ["**\/*.check.mjs"]` lint printed "all 1 surface(s) have a test"
 * while the nudge said "no test or eval covers it". A nudge contradicting the
 * linter of the same repo, in the same second, teaches people to ignore both.
 */
function untestedRules(config: VigilesConfig | undefined): {
  /** Per-kind severities — `false` means the kind is not scanned at all. */
  readonly severity: (kind: SurfaceKind) => RuleSeverity;
  /** True when at least one of the three rules is on. */
  readonly anyEnabled: boolean;
  /** The detector options the config asks for (no basePath/layout — the caller's). */
  readonly options: TestCoverageOptions;
} {
  const rules = config?.rules;
  const skillSev = ruleSeverity(rules?.["untested-skill"]);
  const agentSev = ruleSeverity(rules?.["untested-subagent"]);
  const hookSev = ruleSeverity(rules?.["untested-hook"]);
  const opts: TestCoverageConfig = {
    ...ruleOptions<TestCoverageConfig>(rules?.["untested-skill"]),
    ...ruleOptions<TestCoverageConfig>(rules?.["untested-subagent"]),
    ...ruleOptions<TestCoverageConfig>(rules?.["untested-hook"]),
  };
  return {
    severity: (kind) =>
      kind === "skill" ? skillSev : kind === "agent" ? agentSev : hookSev,
    anyEnabled: skillSev !== false || agentSev !== false || hookSev !== false,
    options: {
      skills: skillSev !== false,
      agents: agentSev !== false,
      hooks: hookSev !== false,
      include: opts.include,
      exclude: opts.exclude,
      // Without this the `testExtension` documented on TestCoverageOptions was a
      // config key nothing read: a TypeScript-shaped repo got `.ts` suggestions
      // however the author configured it. Prose isn't policy, in our own CLI.
      testExtension: opts.testExtension,
    },
  };
}

/**
 * Apply the per-kind `untested-skill` / `untested-subagent` / `untested-hook` rules:
 * find skills/agents/hooks with no test or eval (see src/test-coverage.ts). Each
 * kind is gated by its OWN rule severity — a kind set to `false` is not scanned;
 * "warn" prints but never fails CI; "error" fails (exit 2). Returns the raw
 * untested count plus the severity-gated error count.
 */
function checkUntestedSurfaces(
  excludes: ExcludeSet,
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { untested: number; errors: number } {
  const { severity: sevFor, anyEnabled, options } = untestedRules(config);
  if (!anyEnabled) return { untested: 0, errors: 0 };
  const report = findUntestedSurfaces({
    ...options,
    basePath: scanRoot,
    layout: adapter.layout,
    // The rule's own `exclude` NARROWS; the repo-wide one is the floor under
    // it. Union, never override — a rule option must not re-admit a vendored
    // corpus the repo excluded (#192).
    exclude: [...(options.exclude ?? []), ...excludes.ignore],
  });

  if (!silent) {
    console.log("\nUntested surfaces:\n");
    for (const line of formatUntestedReport(report).split("\n")) {
      console.log(`  ${line}`);
    }
    for (const s of report.untested) {
      ghAnnotate(
        sevFor(s.kind) === "error" ? "error" : "warning",
        `${s.kind} ${s.path} ships without a test or eval`,
        s.path,
      );
    }
  }

  return {
    untested: report.untested.length,
    errors: report.untested.filter((s) => sevFor(s.kind) === "error").length,
  };
}

/**
 * A surface-scoped rule (subagent / shell-hook) is configured, but the active
 * harness doesn't have that surface. Report it as **n/a** — loud, not silent (the
 * no-silent-skips ethos): the rule isn't failing and isn't passing, it simply
 * doesn't apply to this harness. Never counts toward issues/errors.
 */
function reportNotApplicable(
  check: string,
  surface: string,
  adapter: HarnessAdapter,
  silent: boolean,
): void {
  if (silent) return;
  console.log(`\n${check}:\n`);
  console.log(`  – n/a — ${adapter.name} has no ${surface}`);
}

/**
 * Apply the `subagent-tool-contract` rule: cross-reference every subagent's `tools:`
 * rail against the harness tool catalog (the moat — "valid is not true"). Flags
 * only the HIGH-CONFIDENCE issues (a never-available tool, or a close typo) via
 * the shared `confidentToolIssues` detector — the same code `scan` and
 * `compileAgent` use (one-detector-no-drift), so a bare unrecognized tool
 * (plugin/MCP-provided) is never a false alarm. Warning by default; set
 * `subagent-tool-contract: "error"` to gate CI. Returns the issue + error counts.
 */
function checkSubagentToolContracts(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["subagent-tool-contract"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.subagents) {
    reportNotApplicable(
      "Subagent tool-contract check",
      "subagents",
      adapter,
      silent,
    );
    return { issues: 0, errors: 0 };
  }
  // Reuse the loader's already-resolved, layout+dialect-driven agents (the same
  // `scan` detector — one-detector-no-drift) instead of re-globbing a hard-coded
  // `agents/` path, so a harness with a different subagent dir Just Works.
  let agents: readonly {
    path: string;
    toolIssues: readonly { message: string }[];
  }[];
  try {
    agents = scanPlugin(scanRoot, adapter.layout, adapter.dialect).agents;
  } catch {
    return { issues: 0, errors: 0 };
  }
  let issues = 0;
  let printedHeader = false;
  for (const agent of agents) {
    if (agent.toolIssues.length === 0) continue;
    issues += agent.toolIssues.length;
    if (!silent) {
      if (!printedHeader) {
        console.log("\nSubagent tool-contract check:\n");
        printedHeader = true;
      }
      for (const issue of agent.toolIssues) {
        console.log(
          `  ${sev === "error" ? "✗" : "⚠"} ${agent.path}: ${issue.message}`,
        );
        ghAnnotate(
          sev === "error" ? "error" : "warning",
          issue.message,
          agent.path,
        );
      }
    }
  }
  return { issues, errors: sev === "error" ? issues : 0 };
}

/**
 * Apply the `hook-events` rule: flag a hook registered under an event name the
 * harness doesn't define (a typo → the hook never fires). Reuses `scanPlugin`'s
 * `hookEventIssues` (the shared detector, high-precision: close typos only, never
 * a framework/custom event). Warning by default; "error" gates CI.
 */
function checkHookEvents(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["hook-events"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.shellHooks) {
    reportNotApplicable("Hook-event check", "shell hooks", adapter, silent);
    return { issues: 0, errors: 0 };
  }
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).hookEventIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nHook-event check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", issue.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `subagent-frontmatter` rule. Two kinds of subagent-frontmatter defect, one
 * rule: (1) a subagent MISSING a required field (`name`/`description`) — it won't
 * register; (2) a subagent with an INVALID `model:`/`color:` value (a close typo
 * of a real one) — it silently falls back / is ignored. Reuses `scanPlugin`'s
 * `frontmatterIssues` + `frontmatterValueIssues`. Warning by default; "error" gates CI.
 */
function checkFrontmatterSchema(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["subagent-frontmatter"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.subagents) {
    reportNotApplicable(
      "Subagent-frontmatter check",
      "subagents",
      adapter,
      silent,
    );
    return { issues: 0, errors: 0 };
  }
  let found: readonly { message: string; path: string }[];
  try {
    const r = scanPlugin(scanRoot, adapter.layout, adapter.dialect);
    found = [...r.frontmatterIssues, ...r.frontmatterValueIssues];
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nFrontmatter-schema check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        issue.message,
        issue.path,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `skill-frontmatter` rule: RECOMMEND (not require) that a SKILL.md
 * declares an explicit `name` + `description` rather than relying on the
 * dir-name / first-paragraph fallbacks — a more reliable trigger surface. The
 * skill still LOADS without them, so this is a best-practice nudge: warn by
 * default; set "error" to enforce it on your own skills. Reuses `scanPlugin`'s
 * `skillMetaIssues`.
 */
function checkSkillFrontmatter(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["skill-frontmatter"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { message: string; path: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).skillMetaIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nSkill-frontmatter check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        issue.message,
        issue.path,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `prefer-compiled-hooks` rule: a SINGLE repo-level recommendation
 * (one finding regardless of hook count) nudging hand-written hooks toward
 * compiled `vigiles/hook` artifacts. A discovery nudge, not a defect — the shell
 * lane stays first-class — so it fires once and the message links the guide.
 * Reuses `scanPlugin`'s `manualHookCount` (one-detector-no-drift).
 */
function checkPreferCompiledHooks(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["prefer-compiled-hooks"]);
  if (!sev) return { issues: 0, errors: 0 };
  let count: number;
  try {
    count = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).manualHookCount;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (count === 0) return { issues: 0, errors: 0 };
  const message = preferCompiledHooksMessage(count);
  if (!silent) {
    console.log("\nCompiled-hooks check:\n");
    console.log(`  ${sev === "error" ? "✗" : "ℹ"} ${message}`);
    ghAnnotate(sev === "error" ? "error" : "warning", message);
  }
  return { issues: 1, errors: sev === "error" ? 1 : 0 };
}

/**
 * Apply the `mcp-config` rule: a declared MCP server with neither a `command`
 * (stdio) nor a `url` (http/sse) can't start. Reuses `scanPlugin`'s `mcpIssues`.
 * Warning by default; "error" gates CI.
 */
function checkMcpConfig(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["mcp-config"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(scanRoot, adapter.layout, adapter.dialect).mcpIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nMCP-config check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", issue.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `disallowed-tools-contract` rule: a subagent's `disallowedTools:`
 * block-list entry that's a close typo of a real tool blocks NOTHING — the tool
 * it was meant to deny stays available, silently. Reuses `scanPlugin`'s per-agent
 * `disallowedToolIssues` (close-typo only — high-precision). Warning by default;
 * "error" gates CI.
 */
function checkDisallowedTools(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["disallowed-tools-contract"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.subagents) {
    reportNotApplicable("Disallowed-tools check", "subagents", adapter, silent);
    return { issues: 0, errors: 0 };
  }
  let found: { message: string; path: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).agents.flatMap((a) =>
      a.disallowedToolIssues.map((i) => ({ message: i.message, path: a.path })),
    );
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nDisallowed-tools check:\n");
    for (const issue of found) {
      console.log(
        `  ${sev === "error" ? "✗" : "⚠"} ${issue.path}: ${issue.message}`,
      );
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        issue.message,
        issue.path,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `frontmatter-valid` rule: a skill/agent `---` block that EXISTS but
 * isn't valid YAML — fields may not parse as intended. Reuses `scanPlugin`'s
 * `malformedFrontmatter`. HONEST caveat (see docs/rules/frontmatter-valid.md):
 * js-yaml is stricter than some loaders, so a one-line `description:` with a
 * colon / `<example>` is flagged though it may still load — hence WARN by default
 * (verify before setting "error").
 */
function checkFrontmatterValid(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["frontmatter-valid"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { message: string; path: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).malformedFrontmatter;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nFrontmatter-validity check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        issue.message,
        issue.path,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `description-overlap` rule: two model-invocable skills with
 * near-identical descriptions collide in the selector — the wrong one fires. A
 * deterministic NCD proxy for a `--trigger`-class precision bug. Reuses
 * `scanPlugin`'s `descriptionOverlaps` (calibrated FP-safe: only basically
 * identical text). Warning by default; "error" gates CI.
 */
function checkDescriptionOverlap(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["description-overlap"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).descriptionOverlaps;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nDescription-overlap check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", issue.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `skill-description-budget` rule: a model-invocable skill whose
 * description is so long the trigger signal is buried — the selector weighs the
 * opening most, so a bloated description hurts recall + precision. A
 * deterministic heuristic proxy (generous 500-char budget). Reuses `scanPlugin`'s
 * `descriptionBudgetIssues`. Warning by default; "error" gates CI.
 */
function checkDescriptionBudget(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["skill-description-budget"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).descriptionBudgetIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nSkill-description-budget check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", issue.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `lethal-trifecta` rule: a unit (subagent / model-invocable skill)
 * holding all three legs (read-private + ingest-untrusted + exfiltrate) is a
 * prompt-injection exfil path (Meta's Rule of Two). Reuses `scanPlugin`'s
 * `trifectaFindings` (one detector, no drift). Warning by default; "error" gates
 * CI. Surfaces across BOTH subagents and skills, so it is NOT gated on the
 * `subagents` capability — a skill-only harness still has the surface.
 *
 * 🔴 The unfenced-skill group is printed ONCE and gets NO per-file GitHub
 * annotation. A skill's `allowed-tools:` pre-approves rather than restricts
 * (measured 2026-08-11), so every skill without a `disallowed-tools:` fence is in
 * this state — annotating each of them would stamp the same sentence on every
 * SKILL.md in the repo on every CI run, which is how a rule gets switched off. The
 * COUNT is unchanged (units, not lines), so exit codes and the CI gate are
 * unaffected by the collapse.
 */
function checkLethalTrifecta(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["lethal-trifecta"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly {
    path: string;
    kind: string;
    name: string;
    finding: { message: string; fence?: string };
  }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).trifectaFindings;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    const mark = sev === "error" ? "✗" : "⚠";
    const level = sev === "error" ? "error" : "warning";
    console.log("\nLethal-trifecta check:\n");
    const unfenced = found.filter(
      (t) => t.kind === "skill" && t.finding.fence === "none",
    );
    for (const t of found) {
      if (unfenced.includes(t)) continue;
      const msg = `${t.kind} ${t.name}: ${t.finding.message}`;
      console.log(`  ${mark} ${t.path}: ${msg}`);
      ghAnnotate(level, msg, t.path);
    }
    if (unfenced.length > 0) {
      console.log(
        `  ${mark} ${String(unfenced.length)} skill(s) declare no \`disallowed-tools:\` fence, so each ` +
          `inherits every tool the session grants and holds all three legs. ` +
          `\`allowed-tools:\` pre-approves, it does not restrict. ` +
          `Add one \`disallowed-tools:\` line per skill to drop a leg: ` +
          unfenced.map((t) => t.name).join(", "),
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `skill-resource-resolves` rule: a SKILL.md body referencing a bundled
 * file (`scripts/`/`references/`/`assets/` or a relative markdown link with an
 * extension) that doesn't exist on disk — the agent reads the instruction and gets
 * nothing. Reuses `scanPlugin`'s `skillResourceIssues` (high-precision / FP-safe,
 * one detector, no drift). Warning by default; "error" gates CI.
 */
function checkSkillResourceResolves(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["skill-resource-resolves"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly {
    path: string;
    name: string;
    finding: { ref: string; line: number };
  }[];
  try {
    found = scanPlugin(scanRoot, adapter.layout, adapter.dialect, {
      sharedDirs: config?.sharedDirs,
      // sharedDirs live at the repo root that OWNS the scan target — cwd for a
      // scoped subdir of this repo, the target itself for a foreign-repo lint.
      sharedDirsRoot: sharedDirsRootFor(scanRoot),
    }).skillResourceIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nSkill-resource check:\n");
    for (const s of found) {
      const msg =
        `${s.name}: bundled resource "${s.finding.ref}" (line ${String(s.finding.line)}) is referenced but missing — the agent reads the instruction and gets nothing.` +
        // The main false-positive source in a skills monorepo, where a SKILL.md
        // legitimately names a repo-root path. The fix already exists and works;
        // it was documented only in docs/skills-monorepo.md, so a CI log gave no
        // hint and the rule read as broken rather than misconfigured.
        ` If it resolves from the repo root instead, add its directory to \`sharedDirs\` in .vigilesrc.json.`;
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${s.path}: ${msg}`);
      ghAnnotate(sev === "error" ? "error" : "warning", msg, s.path);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `skill-missing-fence` rule: a SKILL.md that opens with
 * frontmatter-looking keys (`name:`/`description:`) but no `---` fence loads as
 * pure body — no name, no description, no trigger (the skill is invisible).
 * Reuses `scanPlugin`'s `skillFenceIssues` (one detector, no drift). Warning by
 * default; "error" gates CI.
 */
function checkSkillMissingFence(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["skill-missing-fence"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly {
    path: string;
    name: string;
    finding: { key: string; message: string };
  }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).skillFenceIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nSkill-missing-fence check:\n");
    for (const s of found) {
      const msg = `${s.name}: ${s.finding.message}`;
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${s.path}: ${msg}`);
      ghAnnotate(sev === "error" ? "error" : "warning", msg, s.path);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `plugin-dir-layout` rule: functional surface dirs (skills/agents/
 * commands) nested inside the `.claude-plugin/` manifest dir where the harness
 * can't see them (the #1 plugin-author mistake). Reuses `scanPlugin`'s
 * `pluginLayoutIssues` (one detector, no drift). Warning by default; "error"
 * gates CI.
 */
function checkPluginDirLayout(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["plugin-dir-layout"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly { dir: string; message: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).pluginLayoutIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nPlugin-dir-layout check:\n");
    for (const p of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${p.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", p.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `delegation-trifecta` rule: a lethal trifecta that EMERGES across a
 * delegation edge — a subagent whose effective (own ∪ delegated-to) capability
 * holds all three legs though no single unit does. Reuses `scanPlugin`'s
 * `delegationTrifecta` (one detector, no drift). Warning by default; "error"
 * gates CI. Surfaces across the subagent graph, so it is NOT gated on a
 * capability the way a surface-specific rule is.
 */
function checkDelegationTrifecta(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["delegation-trifecta"]);
  if (!sev) return { issues: 0, errors: 0 };
  let found: readonly {
    path: string;
    finding: { name: string; message: string };
  }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).delegationTrifecta;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nDelegation-trifecta check:\n");
    for (const d of found) {
      const msg = `${d.finding.name}: ${d.finding.message}`;
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${d.path}: ${msg}`);
      ghAnnotate(sev === "error" ? "error" : "warning", msg, d.path);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `hook-block-ineffective` rule: a hook that LOOKS like it blocks but
 * silently doesn't — a block decision (`exit 2` / `decision` / `permissionDecision`)
 * on a non-blocking event, or the legacy top-level `decision` field on a
 * permission-gated event (#19009, the #1 verified hook pain). Reuses `scanPlugin`'s
 * `hookBlockFindings` (one detector, no drift). Warning by default; "error" gates CI.
 */
function checkHookBlockIneffective(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["hook-block-ineffective"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.shellHooks) {
    reportNotApplicable("Hook-block check", "shell hooks", adapter, silent);
    return { issues: 0, errors: 0 };
  }
  let found: readonly {
    event: string;
    scriptPath: string | null;
    message: string;
  }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).hookBlockFindings;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nHook-block check:\n");
    for (const h of found) {
      const where = h.scriptPath ?? "(inline)";
      const msg = `[${h.event}] ${where}: ${h.message}`;
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${msg}`);
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        msg,
        h.scriptPath ?? undefined,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `hook-matcher` rule: a hook `matcher` string that doesn't fire as
 * written — a tool-name typo (`bash`→`Bash`), a matcher that doesn't compile, an
 * MCP pattern that reaches no tool name or is too narrow for real server naming,
 * or an undeclared MCP server.
 * Reuses `scanPlugin`'s `hookMatcherFindings` (one detector, no drift). Warning
 * by default; "error" gates CI.
 */
function checkHookMatcher(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["hook-matcher"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.shellHooks) {
    reportNotApplicable("Hook-matcher check", "shell hooks", adapter, silent);
    return { issues: 0, errors: 0 };
  }
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).hookMatcherFindings;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nHook-matcher check:\n");
    for (const m of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${m.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", m.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `mcp-hook-target-resolves` rule: a `type: "mcp_tool"` hook action
 * that's incomplete (no `server`/`tool`) or targets a server the plugin doesn't
 * declare — the hook silently never dispatches. Reuses `scanPlugin`'s
 * `mcpHookIssues` (high-precision: declared-set gated, built-ins allowlisted).
 * Warning by default; "error" gates CI.
 */
function checkMcpHookTargets(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["mcp-hook-target-resolves"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.shellHooks) {
    reportNotApplicable(
      "MCP hook-target check",
      "shell hooks",
      adapter,
      silent,
    );
    return { issues: 0, errors: 0 };
  }
  let found: readonly { message: string }[];
  try {
    found = scanPlugin(scanRoot, adapter.layout, adapter.dialect).mcpHookIssues;
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nMCP hook-target check:\n");
    for (const issue of found) {
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${issue.message}`);
      ghAnnotate(sev === "error" ? "error" : "warning", issue.message);
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the `hook-script-exists` rule: a hook command references a script file
 * that doesn't exist on disk (with `${CLAUDE_PLUGIN_ROOT}` resolved) → the hook
 * silently never runs. Reuses `scanPlugin`'s `hooks` (status "missing"); the
 * shared resolver already excludes the FP-prone cases (unresolved vars,
 * existence-guarded one-liners, inline commands). Matches Anthropic's own
 * `claude plugin validate`. Warning by default; "error" gates CI.
 */
function checkHookScriptExists(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["hook-script-exists"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.shellHooks) {
    reportNotApplicable(
      "Hook-script existence check",
      "shell hooks",
      adapter,
      silent,
    );
    return { issues: 0, errors: 0 };
  }
  let missing: { script: string }[];
  try {
    missing = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).hooks.filter((h) => h.status === "missing");
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (missing.length > 0 && !silent) {
    console.log("\nHook-script existence check:\n");
    for (const h of missing) {
      const msg = `hook script "${h.script}" is referenced but missing — the hook never runs.`;
      console.log(`  ${sev === "error" ? "✗" : "⚠"} ${msg}`);
      ghAnnotate(sev === "error" ? "error" : "warning", msg);
    }
  }
  return {
    issues: missing.length,
    errors: sev === "error" ? missing.length : 0,
  };
}

/**
 * Apply the `mcp-tool-resolves` rule: an `mcp__server__tool` in a subagent's
 * contract whose server isn't in the plugin's declared `mcpServers` can't resolve
 * (the MCP half of the tool moat). Reuses `scanPlugin`'s per-agent `mcpToolIssues`
 * — high-precision (gated on a declared set, built-ins allowlisted, the
 * plugin-namespaced form skipped). Warning by default; "error" gates CI.
 */
function checkMcpToolResolves(
  config: VigilesConfig | undefined,
  silent: boolean,
  adapter: HarnessAdapter,
  scanRoot: string,
): { issues: number; errors: number } {
  const sev = ruleSeverity(config?.rules?.["mcp-tool-resolves"]);
  if (!sev) return { issues: 0, errors: 0 };
  if (!adapter.capabilities.subagents) {
    reportNotApplicable(
      "MCP tool-resolution check",
      "subagents",
      adapter,
      silent,
    );
    return { issues: 0, errors: 0 };
  }
  let found: { message: string; path: string }[];
  try {
    found = scanPlugin(
      scanRoot,
      adapter.layout,
      adapter.dialect,
    ).agents.flatMap((a) =>
      a.mcpToolIssues.map((i) => ({ message: i.message, path: a.path })),
    );
  } catch {
    return { issues: 0, errors: 0 };
  }
  if (found.length > 0 && !silent) {
    console.log("\nMCP tool-resolution check:\n");
    for (const issue of found) {
      console.log(
        `  ${sev === "error" ? "✗" : "⚠"} ${issue.path}: ${issue.message}`,
      );
      ghAnnotate(
        sev === "error" ? "error" : "warning",
        issue.message,
        issue.path,
      );
    }
  }
  return { issues: found.length, errors: sev === "error" ? found.length : 0 };
}

/**
 * Apply the configured coverage thresholds. Returns the number of failing
 * thresholds (so the lint can fail CI when severity is "error").
 *
 * Loads specs directly via loadSpec() when the scripts threshold is set —
 * avoids depending on a pre-built `dist/` tree, which the setup-generated
 * CI step doesn't guarantee.
 */
async function checkCoverageThresholds(
  excludes: ExcludeSet,
  coverage: { enabled: number; documented: number },
  config: VigilesConfig | undefined,
  silent: boolean,
): Promise<number> {
  const severity = ruleSeverity(config?.rules.coverage);
  if (!severity) return 0;

  const opts = ruleOptions<CoverageThresholds>(config?.rules.coverage);
  if (!opts) return 0;

  const log = (msg: string): void => {
    if (!silent) console.log(msg);
  };

  let failing = 0;
  if (!silent) console.log("\nCoverage thresholds:\n");

  if (opts.linterRules !== undefined) {
    const pct =
      coverage.enabled > 0
        ? Math.round((coverage.documented / coverage.enabled) * 100)
        : 100;
    const ok = pct >= opts.linterRules;
    if (!ok) failing++;
    const marker = ok ? "✓" : severity === "error" ? "✗" : "⚠";
    log(
      `  ${marker} linterRules: ${String(pct)}% (threshold: ${String(opts.linterRules)}%)`,
    );
  }

  if (opts.scripts !== undefined) {
    // Load all claude specs so coverage doesn't depend on a built dist/.
    const loaded = await Promise.all(findSpecs(excludes).map(loadSpec));
    const claudeSpecs = loaded.filter(
      (s): s is ClaudeSpec => s?._specType === "claude",
    );
    const metric = computeScriptCoverage(
      process.cwd(),
      opts.scripts,
      claudeSpecs,
      excludes.ignore,
    );
    const ok = metric.passing;
    if (!ok) failing++;
    const marker = ok ? "✓" : severity === "error" ? "✗" : "⚠";
    log(
      `  ${marker} scripts: ${String(metric.percent)}% (threshold: ${String(opts.scripts)}%)`,
    );
  }

  return severity === "error" ? failing : 0;
}

async function countGuidanceRules(
  excludes: ExcludeSet,
  silent = false,
): Promise<number> {
  const specs = findSpecs(excludes);
  if (specs.length === 0) return 0;

  let count = 0;
  for (const specPath of specs) {
    const spec = await loadSpec(specPath);
    if (!spec || spec._specType !== "claude") continue;
    for (const rule of Object.values(spec.rules)) {
      if (rule._kind === "guidance") count++;
    }
  }

  if (!silent && count > 0) {
    console.log(
      `${String(count)} guidance rule(s) — run /strengthen to find enforce() upgrades\n`,
    );
  }
  return count;
}

// ---------------------------------------------------------------------------
// Command handlers for main()
// ---------------------------------------------------------------------------

/**
 * An explicitly named path is processed even when `exclude` matches it, and ONE
 * line says so. `exclude` filters DISCOVERY; an argument is an instruction.
 * Measured 2026-09-03: ripgrep and tsc do this silently, ESLint skips the file
 * with a warning, prettier skips it and reports "all files use Prettier code
 * style" — the silent no-op. We take rg/tsc's semantics with ESLint's loudness.
 * Returns the path unchanged so it composes inside a `.map`.
 */
function noteExplicitOverride(
  excludes: ExcludeSet,
  path: string,
  verb: string,
): string {
  const pattern = excludes.explain(relative(excludes.root, resolve(path)));
  if (pattern !== null) {
    console.log(
      `note: ${path} matches exclude "${pattern}" — ${verb} because you named it`,
    );
  }
  return path;
}

function findInstructionFiles(
  restArgs: string[],
  excludes: ExcludeSet,
  agentDir = "",
): string[] {
  const patterns = ["**/CLAUDE.md", "**/AGENTS.md", "**/SKILL.md"];
  // Include the active harness's subagent dir so a COMPILED `agents/<name>.md`
  // (a vigiles-hashed file) is integrity-checked (dogfood E2). Empty for a
  // harness without subagents (Codex agentDir === ""), so nothing is added there.
  if (agentDir !== "") patterns.push(`**/${agentDir}/*.md`);
  // `exclude` (from .vigilesrc.json) drops vendored/benchmark fixtures the repo's
  // own lint shouldn't police — a third-party CLAUDE.md isn't held to
  // require-instructions-spec. The FUNCTION face of the ExcludeSet, not the
  // string list: `discoverIn` may glob from a subdirectory (`vigiles lint
  // some/dir`), where a root-relative string pattern would match nothing.
  // Discover instruction files under one directory, as paths relative to cwd.
  const discoverIn = (dirAbs: string): string[] =>
    patterns
      .flatMap((p) =>
        globSync(p, {
          ignore: excludes.globIgnore,
          cwd: dirAbs,
          absolute: true,
        }),
      )
      .map((abs) => relative(process.cwd(), abs));
  if (restArgs.length === 0) return discoverIn(process.cwd());
  // Explicit args: expand a DIRECTORY to the instruction files inside it (so
  // `vigiles lint .` works), keep a file arg as-is, and pass a non-existent arg
  // through unchanged (lint reports it as not-found rather than crashing).
  const out: string[] = [];
  for (const arg of restArgs) {
    const abs = resolve(process.cwd(), arg);
    noteExplicitOverride(excludes, arg, "linting");
    if (existsSync(abs) && lstatSync(abs).isDirectory()) {
      out.push(...discoverIn(abs));
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** Value of a `--flag=value` arg (the `=` form, so it never collides with a positional). */
function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * The MODEL-GATED behavioral half of `vigiles audit` (the model trigger tier; the
 * deterministic core of `audit` stays free). Loads the author-supplied per-skill
 * prompt sets (`--prompts`) and reports BOTH behavioral columns: trigger-rate (does
 * each skill actually FIRE — recall + precision) and the selection-collision matrix
 * (does one skill HIJACK a sibling's prompt — the behavioral confirmation of the
 * deterministic `description-overlap` rule). Needs the harness CLI + model auth;
 * degrades honestly ("unavailable") when absent. The OSS-testing front door:
 * `vigiles audit ./plugin --prompts=p.json` (interactive — say yes when asked).
 */
/**
 * Resolve the adapter for a COMMAND, honouring the full precedence: `--harness=`
 * flag → `.vigilesrc.json` `harness` → auto-detect (dogfood A/I3). This is the
 * ONE resolution path a command may use — resolving via the raw auto-detect
 * alone silently ignores config.harness, which is the exact bug this closes.
 * A dogfood test (src/cli-harness-resolution.test.ts) asserts cli.ts routes all
 * command harness resolution through here, so a future command can't regress.
 */
function resolveCommandHarness(
  dir: string,
  harnessFlag: string | undefined,
): HarnessSelection {
  return resolveHarnessSelection({
    root: dir,
    flag: harnessFlag,
    configHarness: normalizeHarnessList(loadConfig().harness),
  });
}

async function handleMeasure(
  restArgs: string[],
  args: string[],
): Promise<void> {
  const dir = resolve(restArgs[0] ?? ".");
  const json = args.includes("--json");
  const harnessFlag = harnessFlagFrom(args);
  const adapter = resolveCommandHarness(dir, harnessFlag).adapter;
  const harness: ProbeHarness =
    adapter.name === "codex" ? "codex" : "claude-code";

  const promptsPath = flagValue(args, "--prompts");
  if (!promptsPath) {
    console.error(
      "measure needs --prompts=<file.json> (a map of skill name → { prompts, irrelevant }).",
    );
    process.exitCode = 2;
    return;
  }
  let promptSet: TriggerPromptSet;
  try {
    promptSet = JSON.parse(
      readFileSync(resolve(promptsPath), "utf-8"),
    ) as TriggerPromptSet;
  } catch (e) {
    console.error(
      `measure: could not read --prompts file "${promptsPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 2;
    return;
  }
  const num = (f: string): number | undefined => {
    const v = flagValue(args, f);
    return v ? Number(v) : undefined;
  };
  const model = flagValue(args, "--model");
  const concurrency = num("--concurrency");
  // Trigger-rate (recall + precision) AND the selection-collision matrix — the two
  // behavioral columns, one report. Collisions report n/a where they don't apply
  // (a single skill, or Codex — no skill-selection event), never a false pass.
  const trigger = await probePluginTriggers(dir, promptSet, {
    concurrency,
    minPrompts: num("--min-prompts"),
    model,
    harness,
  });
  const collisions = await measurePluginSelection(dir, promptSet, {
    concurrency,
    trials: num("--trials"),
    model,
    harness,
  });
  if (json) {
    console.log(JSON.stringify({ trigger, collisions }, null, 2));
    return;
  }
  console.log(`\n${formatBehavioralReport(trigger)}`);
  console.log(`\n${formatSelectionReport(collisions)}`);
}

/**
 * `vigiles generate <kind>` — one verb over the three dev-toolchain generators
 * (types/schema/harness). Each emits a file YOUR editor/tsc reads, not the agent
 * — grouped under one verb instead of N hyphenated siblings (cohesive-cli-surface,
 * high-bar-for-new-commands). The kind is the first positional; the rest passes
 * through to the per-kind handler (out path / dir).
 */
async function handleGenerate(
  restArgs: string[],
  args: string[],
): Promise<void> {
  const kind = restArgs[0];
  const rest = restArgs.slice(1);
  switch (kind) {
    case "types":
      handleGenerateTypes(args, rest);
      break;
    case "schema":
      handleGenerateSchema(args, rest);
      break;
    case "harness":
      await handleGenerateHarness(args, rest);
      break;
    default:
      console.error(
        "Usage: vigiles generate <types|schema|harness> [out] [--check]",
      );
      process.exit(2);
  }
}

function handleGenerateTypes(args: string[], restArgs: string[]): void {
  const checkOnly = args.includes("--check");
  const outPath = restArgs[0] ?? ".vigiles/generated.d.ts";
  const fileGlobs = args
    .filter((a) => a.startsWith("--files="))
    .map((a) => a.split("=")[1])
    .filter(Boolean);

  console.log("Scanning project...\n");
  const result = generateTypes({
    basePath: process.cwd(),
    fileGlobs: fileGlobs.length > 0 ? fileGlobs : undefined,
  });

  for (const l of result.linters) {
    console.log(
      `  ${l.linter}: ${String(l.rules.length)} enabled rules (via ${l.via})`,
    );
  }
  if (result.scripts.length > 0) {
    console.log(`  npm scripts: ${String(result.scripts.length)}`);
  }
  console.log(`  project files: ${String(result.files.length)}`);

  const fullOut = resolve(process.cwd(), outPath);

  if (checkOnly) {
    // --check: compare against existing file, exit 1 if stale
    if (!existsSync(fullOut)) {
      console.log(
        `\n✗ ${outPath} does not exist. Run \`vigiles generate types\` to create it.`,
      );
      process.exit(1);
    }
    const existing = readFileSync(fullOut, "utf-8");
    // Normalize for formatter differences (trailing whitespace, blank lines)
    const normalize = (s: string): string =>
      s
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (normalize(existing) === normalize(result.dts)) {
      console.log(`\n✓ ${outPath} is up to date`);
    } else {
      console.log(
        `\n✗ ${outPath} is stale. Run \`vigiles generate types\` to update.`,
      );
      process.exit(1);
    }
    return;
  }

  const outDir = fullOut.substring(0, fullOut.lastIndexOf("/"));
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(fullOut, result.dts);
  console.log(`\n✓ Generated ${outPath}`);
}

function handleGenerateSchema(args: string[], restArgs: string[]): void {
  const checkOnly = args.includes("--check");
  const outPath = restArgs[0] ?? ".vigiles/schema.json";

  console.log("Scanning linters...\n");
  const result = generateSchema({
    basePath: process.cwd(),
    linters: loadConfig().linters,
  });

  for (const l of result.linters) {
    console.log(`  ${l.linter}: ${String(l.count)} rules`);
  }
  console.log(`  schema enum: ${String(result.ruleNames.length)} rule names`);

  const fullOut = resolve(process.cwd(), outPath);

  if (checkOnly) {
    if (!existsSync(fullOut)) {
      console.log(
        `\n✗ ${outPath} does not exist. Run \`vigiles generate schema\` to create it.`,
      );
      process.exit(1);
    }
    const existing = readFileSync(fullOut, "utf-8");
    if (existing.trim() === result.json.trim()) {
      console.log(`\n✓ ${outPath} is up to date`);
    } else {
      console.log(
        `\n✗ ${outPath} is stale. Run \`vigiles generate schema\` to update.`,
      );
      process.exit(1);
    }
    return;
  }

  const outDir = fullOut.substring(0, fullOut.lastIndexOf("/"));
  if (outDir && !existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(fullOut, result.json);
  console.log(`\n✓ Generated ${outPath}`);
  console.log(
    "  Add to your markdown frontmatter:\n" +
      `    # yaml-language-server: $schema=./${outPath}`,
  );
}

/**
 * `vigiles generate harness [dir] [out]` — emit one typed registry over every
 * `*.spec.ts` under `dir`, so a single `tsc --noEmit` cross-checks the whole
 * harness (dangling delegates → a tsc error; duplicate names → this command
 * exits non-zero; the capability lattice → a computed export). The third
 * generated artifact beside `generate-types` / `generate-schema`. See
 * docs/cli.md and research/whole-harness-codegen.md.
 */
/**
 * Keep an EXISTING `harness.gen.ts` fresh as a side effect of `compile`, so the
 * whole-harness registry tracks the specs without a separate manual
 * `generate-harness` run (the user almost never calls that verb by hand). Gated
 * on the file already existing: compile keeps a registry the user opted into
 * (committed like a lockfile) up to date — it never imposes one on a repo that
 * didn't ask for it. Cheap by construction: `generate-harness` only PARSES specs
 * (no linter spawning), unlike `generate-types`/`generate-schema` (which spawn
 * every linter and so stay on the config-change guard, off the hot compile path).
 * Returns false on a duplicate-name collision so it fails the compile.
 */
async function refreshHarnessGenIfPresent(
  harnessFlag: string | undefined,
): Promise<boolean> {
  const dir = process.cwd();
  const fullOut = resolve(dir, HARNESS_GEN_FILENAME);
  if (!existsSync(fullOut)) return true; // opt-in: nothing to refresh

  const adapter = resolveCommandHarness(dir, harnessFlag).adapter;
  const model = await loadHarnessModel(
    dir,
    (abs) =>
      loadSpec(abs) as Promise<{
        _specType?: string;
        name?: string;
        tools?: readonly string[];
      } | null>,
  );
  const result = generateHarness(model, {
    dialect: adapter.dialect,
    outDir: dirname(fullOut),
  });
  if (result.duplicate) {
    console.log(`\n✗ ${result.duplicate.message}`);
    console.log(`::error::${result.duplicate.message}`);
    return false;
  }
  writeFileSync(fullOut, result.gen);
  console.log(
    `  ↻ refreshed ${HARNESS_GEN_FILENAME} (${String(result.agentCount)} agent(s))`,
  );
  return true;
}

async function handleGenerateHarness(
  args: string[],
  restArgs: string[],
): Promise<void> {
  const checkOnly = args.includes("--check");
  const dir = resolve(restArgs[0] ?? ".");
  const outPath = restArgs[1] ?? resolve(dir, HARNESS_GEN_FILENAME);
  const fullOut = resolve(process.cwd(), outPath);
  const specImport =
    args
      .filter((a) => a.startsWith("--spec-import="))
      .map((a) => a.split("=")[1])
      .filter(Boolean)[0] ?? undefined;

  // Resolve the harness ONCE (honour --harness / config / auto-detect) so the
  // capability lattice is computed against the right dialect — never defaulting
  // to Claude Code in core. The dialect is INJECTED into the generator.
  const harnessFlag = harnessFlagFrom(args);
  const adapter = resolveCommandHarness(dir, harnessFlag).adapter;

  console.log(`Scanning ${labelFor(process.cwd(), dir)} for *.spec.ts...\n`);

  const model = await loadHarnessModel(
    dir,
    (abs) =>
      loadSpec(abs) as Promise<{
        _specType?: string;
        name?: string;
        tools?: readonly string[];
      } | null>,
  );

  const result = generateHarness(model, {
    dialect: adapter.dialect,
    outDir: dirname(fullOut),
    specImport,
  });

  console.log(
    `  ${String(result.agentCount)} agent(s), ${String(result.edgeCount)} delegate edge(s)` +
      (result.handoffCount > 0
        ? `, ${String(result.handoffCount)} handoff check(s)`
        : ""),
  );
  console.log(
    `  capabilities: ${result.capabilities.purity} (` +
      `${String(result.capabilities.sideEffecting.length)} side-effecting, ` +
      `${String(result.capabilities.unknown.length)} unknown)`,
  );

  // DUPLICATE NAME — the O(N) JS check (never a type). Exit non-zero, no write.
  if (result.duplicate) {
    console.log(`\n✗ ${result.duplicate.message}`);
    console.log(`::error::${result.duplicate.message}`);
    process.exit(2);
  }

  if (checkOnly) {
    if (!existsSync(fullOut)) {
      console.log(
        `\n✗ ${outPath} does not exist. Run \`vigiles generate harness\` to create it.`,
      );
      process.exit(1);
    }
    const existing = readFileSync(fullOut, "utf-8");
    const normalize = (s: string): string =>
      s
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (normalize(existing) === normalize(result.gen)) {
      console.log(`\n✓ ${outPath} is up to date`);
    } else {
      console.log(
        `\n✗ ${outPath} is stale. Run \`vigiles generate harness\` to update.`,
      );
      process.exit(1);
    }
    return;
  }

  const outDir = dirname(fullOut);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(fullOut, result.gen);
  console.log(`\n✓ Generated ${labelFor(process.cwd(), fullOut)}`);
  console.log(
    "  `tsc --noEmit` over this file now checks every delegate target resolves.",
  );
}

/** Minimal TTY yes/no prompt (readline). Returns true only on an explicit y/yes. */
async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((res) => {
      rl.question(question, res);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * `vigiles test` / `vigiles eval` — discover and run the two-tier harness
 * scripts (deterministic `*.harness.mjs` / real-model `*.eval.mjs`) as child
 * `node` processes, aggregating exit codes so they work as a CI command. See
 * src/run-scripts.ts. A bare `vigiles eval` (no target) asks before fanning out
 * over the whole tree — it spends model quota (see `decideRunScripts`).
 *
 * `vigiles test` skips clean when the `claude` CLI is absent (the deterministic
 * tier needs it, just like the node:test suite). `--trials=N` is forwarded to
 * eval scripts via the `VIGILES_TRIALS` env var.
 */
/**
 * Resolve the eval LOCK env from the `eval` flags. `--update` records each named
 * eval's report to a committed `.vigiles/eval-locks/<name>.lock.json` (run locally
 * on your subscription); `--check` (CI) verifies the committed result against the
 * current inputs WITHOUT a model call. `--check` is a green NO-OP until the first
 * lock is committed (smooth adoption). Returns the env to thread, or `"skip"` to
 * exit green now. `--check`+`--update` together is a usage error (exit 2). The
 * behavior epoch comes from `.vigilesrc.json` `eval.apiVersion` (committed).
 */
function resolveEvalLockEnv(args: string[]): Record<string, string> | "skip" {
  const wantCheck = args.includes("--check");
  const wantUpdate = args.includes("--update");
  if (wantCheck && wantUpdate) {
    console.error(
      "vigiles eval: --check and --update are mutually exclusive (one verifies, one records).",
    );
    process.exit(2);
  }
  if (
    wantCheck &&
    !anyLocksCommitted(resolve(process.cwd(), DEFAULT_LOCK_DIR))
  ) {
    console.log(
      "ℹ vigiles eval --check: no committed eval locks found — nothing to verify.\n" +
        "  Run `vigiles eval --update` locally (on your subscription) and commit the\n" +
        "  lock to enable the CI staleness gate.",
    );
    return "skip";
  }
  const env: Record<string, string> = {};
  if (wantCheck) env.VIGILES_EVAL_LOCK = "check";
  if (wantUpdate) env.VIGILES_EVAL_LOCK = "update";
  if (wantCheck || wantUpdate) {
    const apiVersion = loadConfig().eval?.apiVersion;
    if (apiVersion !== undefined)
      env.VIGILES_EVAL_API_VERSION = String(apiVersion);
  }
  return env;
}

/**
 * Turn a completed run into `.vigiles/coverage.json` — the composition root for
 * the execution tier of coverage (`coverage-artifact.ts`).
 *
 * It resolves here, and nowhere earlier, because resolution needs DISCOVERY: a
 * script reports the reference it saw (`hooks/pre-edit.sh`, `plugin:my-skill`)
 * and only the repo can say whether that is a surface. Doing it inside the test
 * process would mean scanning a user's repo from inside their test.
 *
 * Best-effort throughout: a repo that cannot be scanned or a `.vigiles/` that
 * cannot be written must never turn a green run red.
 *
 * 🔴 A RUN RETRACTS AS WELL AS RECORDS. The scripts that executed are handed to
 * `mergeRuns` so their previous records go before the new ones land — otherwise
 * a script edited to stop exercising a surface leaves that surface permanently
 * "measured by a run" (see the retraction note on `mergeRuns`). This is why the
 * cheap early return on "nothing new to record" is gone: a run that now reports
 * NOTHING is exactly the case worth writing down.
 */
/**
 * Resolve this run's probes against the repo's discovered surfaces.
 *
 * `harnessFlag` is the `--harness=` the user typed on THIS run — see the layout
 * note below for why the flag has to travel this far.
 */
function resolveRecords(
  cwd: string,
  runs: ReturnType<typeof runsFromResults>,
  tier: CoverageTierName,
  harnessFlag: string | undefined,
): CoverageRun[] {
  // 🔴 DISCOVERY MUST USE THE ACTIVE LAYOUT, or resolution silently resolves
  // nothing. This called the detector with a path alone, so a Codex repo (surfaces
  // only under `.codex/skills/`) discovered ZERO surfaces, `recordsFrom` matched
  // every successful probe against an empty list and dropped it, and `vigiles
  // test` / `vigiles eval` never granted execution coverage there — while
  // `vigiles lint`, which passes `adapter.layout` to the same function, saw the
  // surfaces perfectly well. Empty discovery does not fail; it just quietly means
  // "nothing ran".
  //
  // 🔴 AND THE ACTIVE LAYOUT INCLUDES THE FLAG. The first fix passed only
  // `(cwd, loadConfig())`, so `--harness=` — which `resolveHarnessSelection` ranks
  // ABOVE config and auto-detect, and which `cli-flag-check.ts` accepts on every
  // verb — was dropped exactly here. `vigiles test --harness=codex` in a repo that
  // auto-detects (or is configured) as Claude Code then discovered the Claude
  // surfaces, matched the run's Codex probes against them, resolved none, and
  // recorded no execution coverage: the same silent empty set as before, reached
  // through the one input that exists to override the other two.
  /**
   * The plugin namespaces that mean THIS repo, for {@link resolveProbe}.
   *
   * A skill activation is reported as `plugin:skill` and a subagent dispatch as
   * `plugin:agent`, so resolving one needs to know which plugin we ARE — otherwise
   * `other-plugin:foo` credits a local `foo` (that was the defect). Two sources,
   * and both are needed:
   *
   *   1. `.claude-plugin/plugin.json#name` — the repo's own declared name, used
   *      when the run installed the repo AS a plugin (`pluginDir`).
   *   2. `vigiles-loose-skills` — the synthetic name OUR OWN packaging gives a
   *      loose `.claude/skills` dir (`packageSkillsDir`, and `underTestSource`'s
   *      fallback when a plugin manifest has no name). A repo that is not a plugin
   *      still reports namespaced ids under it, so omitting it would drop every
   *      trigger-rate record for the documented one-liner.
   *
   * An unreadable or nameless manifest contributes nothing rather than a guess.
   */
  function selfNamespaces(cwd: string): readonly string[] {
    const names = new Set<string>(["vigiles-loose-skills"]);
    try {
      const raw = readFileSync(
        resolve(cwd, ".claude-plugin", "plugin.json"),
        "utf-8",
      );
      const name = (JSON.parse(raw) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    } catch {
      /* no manifest, or unreadable → the synthetic name alone */
    }
    return [...names];
  }

  const recordsConfig = loadConfig();
  const scan = findUntestedSurfaces({
    basePath: cwd,
    layout: harnessLayoutFor(cwd, recordsConfig, harnessFlag),
    // The repo-wide `exclude` only — the per-rule severities/include stay out
    // of record resolution on purpose (a run's probes must map to a surface
    // whether or not the untested-* rule for its kind is on).
    exclude: excludeSet(cwd, recordsConfig.exclude).ignore,
  });
  return recordsFrom({
    runs,
    surfaces: [...scan.covered, ...scan.untested],
    tier,
    at: new Date().toISOString(),
    selfNamespaces: selfNamespaces(cwd),
    // The root an ABSOLUTE command ref must lie beneath to be OURS. Without it a
    // harness that executed `/tmp/fixture/hooks/pre.sh` credited this repo's own
    // `hooks/pre.sh`, because the tail matched. See the ladder note on
    // `resolveProbe`; absent a root, absolute refs abstain rather than guess.
    root: cwd,
    readSurface: (p) => {
      try {
        return readFileSync(resolve(cwd, p), "utf-8");
      } catch {
        return null;
      }
    },
  });
}

/**
 * Merge one run's records into `.vigiles/coverage.json`, retractions included.
 *
 * The verb's `kind` maps to the coverage TIER here, so the one call site stays a
 * single line. `harnessFlag` is the caller's `--harness=` — a SHARED flag (`cli-flag-check.ts`)
 * that every verb accepts and that `resolveHarnessSelection` ranks above config
 * and auto-detection. It has to travel all the way to discovery: see the layout
 * note on {@link resolveRecords} for what dropping it silently did.
 */
function recordRunCoverage(
  cwd: string,
  results: readonly ScriptRunResult[],
  kind: "test" | "eval",
  harnessFlag: string | undefined,
): void {
  const tier: CoverageTierName = kind === "test" ? "harness" : "eval";
  try {
    const previous = readCoverageArtifact(cwd);
    // `root` so an ABSOLUTE target (`vigiles test /abs/x.harness.mjs`) retracts
    // what the same file recorded when the default glob found it relatively —
    // `discoverScripts` passes an existing file's argument through verbatim, so
    // the spelling that reaches `by` is whatever the person typed.
    const executed = { scripts: executedScripts(results), tier, root: cwd };
    const runs = runsFromResults(results);
    // Discovery is only needed to RESOLVE new probes; a pure retraction needs
    // nothing but the artifact, so a repo scan is skipped when there are none.
    const records =
      runs.length === 0 ? [] : resolveRecords(cwd, runs, tier, harnessFlag);
    const merged = mergeRuns(previous?.runs ?? [], records, executed);
    // Nothing to add and nothing withdrawn — leave the file exactly as it is, so
    // a repo with no artifact still gets none (the "absent artifact = today's
    // behaviour" property) and a green no-op run doesn't churn the timestamp.
    if (records.length === 0 && merged.length === (previous?.runs.length ?? 0))
      return;
    const commit = gitHead(cwd);
    writeCoverageArtifact(cwd, {
      v: COVERAGE_ARTIFACT_VERSION,
      generated: new Date().toISOString(),
      ...(commit ? { commit } : {}),
      runs: merged,
    });
  } catch {
    /* recording is never allowed to fail a run */
  }
}

/** Short HEAD of the checkout, or "" when this is not a git repo. */
function gitHead(cwd: string): string {
  try {
    const { spawnSync } =
      require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 ? (r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

async function handleRunScripts(
  kind: "test" | "eval",
  args: string[],
  restArgs: string[],
  excludes: ExcludeSet,
): Promise<void> {
  const cwd = process.cwd();
  // Harness/eval scripts may be authored in JS or TS (see run-scripts.ts).
  const defaultGlob = scriptGlob(kind === "test" ? "harness" : "eval");

  // The eval LOCK flags (`--check`/`--update`) are resolved BEFORE file discovery
  // so mutual-exclusion + the cold-start no-op are honored regardless of file
  // count. Returns the env to thread to scripts, or `"skip"` to exit green now.
  let lockEnv: Record<string, string> = {};
  if (kind === "eval") {
    const r = resolveEvalLockEnv(args);
    if (r === "skip") return;
    lockEnv = r;
  }

  // A script under an excluded path is not DISCOVERED (a vendored corpus's own
  // harness must not run as ours), but a script you NAME still runs (#192).
  const files = discoverScripts(
    restArgs.map((p) => noteExplicitOverride(excludes, p, "running")),
    defaultGlob,
    cwd,
    excludes.ignore,
  );

  // `--min=N`: a CI gate asserts at least N scripts actually RAN — so a bad path,
  // a renamed file, or a glob that matched nothing fails LOUD instead of passing
  // green with zero evals executed. Default 0 (off) keeps local runs ergonomic.
  const minFlag = args.find((a) => a.startsWith("--min="));
  const minRequired = minFlag
    ? Math.max(0, Number.parseInt(minFlag.split("=")[1] ?? "", 10) || 0)
    : 0;
  if (files.length < minRequired) {
    console.error(
      `✗ vigiles ${kind}: --min=${String(minRequired)} but only ${String(files.length)} ${kind} file(s) matched — ` +
        "evals never executed (check the paths/globs, or that the run was reached).",
    );
    process.exit(1);
  }

  if (files.length === 0) {
    // 🔴 ASKING FOR SOMETHING AND GETTING NOTHING IS A FAILURE; FINDING NOTHING IS NOT.
    // The two cases were collapsed into one silent exit 0, and the collapse cost a real
    // repository three days of green CI verifying zero files: a named step ran
    // `vigiles test .claude/pipeline/skills.harness.mjs` after that file had been split
    // into one-per-skill, printed "No **/*.harness.* files found" and passed, right next
    // to a step that was red for the same root cause.
    //
    // They are different states. A POSITIONAL argument is a claim that something is there —
    // when nothing matches it, the path is stale, the glob is wrong, or the run never
    // reached its target, and every one of those is a defect. Bare discovery finding
    // nothing is just an empty repository, which is a legitimate place to stand and must
    // stay quiet.
    //
    // This is the default the field settled on: Jest and Vitest FAIL on no tests found and
    // make you opt in with `--passWithNoTests`; pytest exits 5. `--min=0` remains the
    // explicit opt-out here, so no new flag is introduced by this change.
    // `minFlag`, not `minRequired`: 0 is both the DEFAULT and the explicit opt-out, so the
    // VALUE cannot tell them apart — only the flag's presence can. (Caught by a control:
    // the first version read `minRequired === 0` and made `--min=0` do nothing.)
    if (restArgs.length > 0 && minFlag === undefined) {
      console.error(
        `✗ vigiles ${kind}: ${String(restArgs.length)} target(s) given and NOTHING matched — ` +
          `${restArgs.join(", ")}\n` +
          `  Nothing ran. A stale path, a wrong glob, or a moved file all look like this.\n` +
          `  If an empty match is expected here, say so with --min=0.`,
      );
      process.exit(1);
    }
    console.log(`No ${defaultGlob} files found.`);
    return;
  }

  // Consent gate for a bare `vigiles eval`: it runs the REAL model on your
  // subscription, and a no-target run discovered the whole tree — so never fan out
  // over an unbounded glob without explicit intent. Mirrors audit's read-vs-run
  // consent. `test` is free → always runs (decideRunScripts returns "run").
  const runDecision = decideRunScripts({
    kind,
    explicitTargets: restArgs.length > 0,
    matchedCount: files.length,
    isTTY: (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false),
    all: args.includes("--all"),
    yes: args.includes("--yes") || args.includes("--no-interactive"),
    lockCheck: args.includes("--check"),
  });
  if (runDecision.kind === "refuse") {
    console.error(
      `✗ vigiles eval: ${String(runDecision.count)} eval file(s) matched the whole tree, and each ` +
        "runs the real model on your subscription. Refusing to fire them all non-interactively.\n" +
        "  → name the eval(s):    vigiles eval path/to/x.eval.mjs\n" +
        "  → or opt in to all:    vigiles eval --all",
    );
    process.exit(2);
  }
  if (runDecision.kind === "confirm") {
    const ok = await promptYesNo(
      `About to run ${String(runDecision.count)} eval file(s) against the real model on your ` +
        "subscription (uses your Claude quota). Continue? [y/N] ",
    );
    if (!ok) {
      console.log(
        "Aborted. Name specific eval(s), or pass --all to run them all.",
      );
      return;
    }
  }

  // No blanket skip: unit-tier (runHook) tests need no `claude`, so always run.
  // A script whose tier DOES need `claude` self-reports `⊘ SKIPPED` (exit 77) —
  // loud, never a silent green. Just flag up front that some may skip.
  if (kind === "test" && !claudeAvailable()) {
    console.log(
      "ℹ `claude` CLI not found — unit-tier tests run; tests that need it report SKIPPED.\n",
    );
  }

  // `--trials=N` (a run knob: cost/precision, doesn't change WHAT is measured) is
  // forwarded to scripts via env. The MODEL is deliberately NOT a CLI/env knob —
  // it's part of the measurement definition, so it belongs in the spec
  // (`model` / `minModel`), version-controlled, not a hidden override.
  const trialsFlag = args.find((a) => a.startsWith("--trials="));
  const env: NodeJS.ProcessEnv = { ...lockEnv };
  if (trialsFlag) env.VIGILES_TRIALS = trialsFlag.split("=")[1];

  console.log(`Running ${String(files.length)} ${kind} file(s):\n`);
  // An eval file DESCRIBES its eval; `dist/eval-entry.js` is what imports the
  // description and runs what it declares. A harness script is still its own
  // program (it is free, so "import spends money" never applied to it).
  const results = await runScripts(files, cwd, env, {
    ...(kind === "eval" ? { entry: resolve(__dirname, "eval-entry.js") } : {}),
  });
  // Write down WHAT the run exercised, so `lint`/`audit` can answer "tested?"
  // from execution instead of from a matching file name. Not a new verb and not
  // a flag: the run already happened, and this is the runner recording what it
  // saw — the same shape as the flight-recorder ledger it already appends to.
  recordRunCoverage(cwd, results, kind, harnessFlagFrom(args));
  console.log("\n" + formatScriptSummary(results));

  if (anyFailed(results)) process.exit(1);

  // `--no-skip`: in a context that ASSERTS the capability is present (a CI job),
  // a skipped tier is untested surface — fail loudly instead of passing green.
  if (args.includes("--no-skip") && results.some((r) => r.status === "skip")) {
    const n = results.filter((r) => r.status === "skip").length;
    console.log(
      `\n✗ --no-skip: ${String(n)} tier(s) SKIPPED — untested surface here. ` +
        "Install the missing capability (e.g. the `claude` CLI) or scope the run.",
    );
    process.exit(1);
  }
}

/** Parse the `--harness=<name>` override out of an argv list (the one definition). */
function harnessFlagFrom(argv: string[]): string | undefined {
  return argv
    .find((a) => a.startsWith("--harness="))
    ?.slice("--harness=".length);
}

/**
 * Whole-harness capability lattice from a scanned plugin's agents (no `tools:` line →
 * inherits-all). The substrate `scan --capability-diff` diffs. Reused for both the
 * already-scanned "after" report and the freshly-scanned "before" dir.
 */
function capabilitiesOfReport(
  report: ScanReport,
  dialect: Parameters<typeof computeHarnessCapabilities>[1],
): ReturnType<typeof computeHarnessCapabilities> {
  const agents = report.agents.map((a) => ({
    name: a.name,
    tools: a.tools ?? undefined,
    file: a.path,
  }));
  return computeHarnessCapabilities(agents, dialect);
}

/**
 * The help text, ONE entry per verb, so `vigiles --help` (all of them) and
 * `vigiles <verb> --help` (one of them) cannot drift apart. `vigiles audit
 * --help` used to RUN AN AUDIT — help lived only on the bare invocation — which
 * is the least helpful possible response to someone asking what a flag is
 * called, and part of the same defect as silently swallowing an unknown flag.
 */
interface CommandHelp {
  /** The signature line, aligned with its description in the banner. */
  readonly usage: string;
  /** Continuation lines (flags, caveats), indented under the signature. */
  readonly detail?: readonly string[];
}

const COMMAND_HELP: Record<Verb, CommandHelp> = {
  init: {
    usage:
      "  vigiles init [flags]       Set up this repo — specs, plugin, and CI.",
  },
  compile: { usage: "  vigiles compile [files...] Compile .spec.ts → .md" },
  eject: {
    usage:
      "  vigiles eject [file]       Hand a compiled file back as plain markdown.",
  },
  lint: {
    usage:
      "  vigiles lint  [files...]   Gate it in CI. The same checks — but a finding fails the build.",
  },
  audit: {
    // "Reports everything, fails nothing" states always-exit-0 as the FEATURE it is. The line
    // it replaces had to end with "NOT a CI step — use `vigiles lint` in CI", and a help text
    // that must say what a command ISN'T is a description that failed. Deleting that sentence
    // was the checkable success criterion for this rewrite.
    usage:
      "  vigiles audit [dir...]     Grade it on your machine. Reports everything, fails nothing.",
    detail: [
      "  2+ dirs → a leaderboard. Writes vigiles-report.html + .json (auto-gitignored).",
      "  --single                   audit this dir as ONE harness, even if it holds many bundles",
      "  The executing checks (run your hooks · live MCP · do skills fire?) run only",
      "  interactively — audit asks once and remembers; automation uses the testing API.",
    ],
  },
  test: {
    // "Free, no API key" is the CONSEQUENCE; "deterministic" was the mechanism, and a reader
    // deciding whether to put this in CI needs the cost, not the implementation.
    usage:
      "  vigiles test  [files...]   Against a scripted stand-in model. Free, no API key — every commit.",
  },
  eval: {
    usage:
      "  vigiles eval  [files...]   Against a real model. Spends your subscription — on demand.",
    detail: [
      "  --update records each named eval's result to a committed lock (run it locally).",
      "  --check verifies those committed results against current inputs with NO model —",
      "  the CI-safe half.",
    ],
  },
  generate: {
    usage:
      "  vigiles generate <kind>    Emit a dev-toolchain artifact: types · schema · harness",
    detail: [
      "  vigiles generate <kind> --check  Verify the generated file is up to date",
    ],
  },
  "hook-runtime": {
    usage:
      "  vigiles hook-runtime <kind>   (emitted into hooks configs — never typed by hand)",
  },
};

/** Display order of the human-facing verbs in the banner's "Commands:" block. */
/**
 * The top-level help, as GROUPS. One table, so the printer cannot drift from the
 * grouping and a new verb cannot quietly land outside both.
 */
const HELP_GROUPS: readonly { heading: string; verbs: readonly Verb[] }[] = [
  {
    heading: "Set up and manage your specs:",
    verbs: ["init", "compile", "eject"],
  },
  {
    heading: "Check your harness (reads your files — nothing is executed):",
    verbs: ["audit", "lint"],
  },
  {
    heading: "Run your harness (drives it and watches what happens):",
    verbs: ["test", "eval"],
  },
];

/**
 * One command's line. `detail` is the per-flag prose and appears ONLY in
 * `vigiles <verb> --help`, never in the top-level list.
 *
 * That split is the second half of this rewrite. `audit`'s entry used to carry four
 * wrapped lines naming nine flags inline, and that single entry was most of the felt
 * crowding in a CLI whose verb count (8) is the smallest of every comparable tool
 * measured — vitest ships 8 verbs and 164 flags, cargo 48 verbs, git 166. None of them
 * thinned their surface by removing verbs; they tiered the help. This does the same.
 */
function printHelpEntry(v: Verb, opts: { detail?: boolean } = {}): void {
  console.log(COMMAND_HELP[v].usage);
  if (opts.detail)
    for (const line of COMMAND_HELP[v].detail ?? []) console.log(line);
}

/**
 * The loud "there is nothing here to audit" block. Deliberately says WHAT was
 * looked at and WHY it found nothing, because the commonest cause is that the
 * target isn't the directory the operator thinks it is.
 *
 * Two causes are named apart from the generic one, because they are the two the
 * generic wording actively MISDESCRIBES:
 *
 *   - the path does not exist — "no surface was found there" reads as a verdict
 *     on a real directory, so a typo'd dir in a multi-dir leaderboard run looked
 *     like a legitimately empty repo. One `existsSync` separates them.
 *   - the path is a CURATED marketplace — it has members, they are all external,
 *     and the useful next step is to clone one. This advice used to live in a
 *     branch that pre-empted the audit entirely (see the `audit` case); it
 *     belongs here, where the directory has genuinely been looked at first.
 */
function formatNothingToAudit(
  root: string,
  harness: string,
  market?: MarketplaceInfo | null,
): string {
  if (!existsSync(root)) {
    return [
      `✗ vigiles audit: ${root} does not exist`,
      "  Nothing was scanned — this is NOT a grade, and NOT an empty repo.",
      "  Check the path, and that a flag didn't swallow it",
      "  (flags take values with `=`: `--out=dir`, never `--out dir`).",
    ].join("\n");
  }
  const lines = [
    `✗ vigiles audit: nothing to audit in ${root}`,
    `  No instruction file and no ${harness} surface (skills / subagents / hooks / commands / MCP) was found there.`,
    "  This is NOT a grade — there was nothing to measure, so no score is reported.",
  ];
  if (market && market.onDisk.length === 0 && market.total > 0) {
    lines.push(
      `  It is the marketplace "${market.name}": ${String(market.total)} plugin(s), all external (url/git sources, not on disk).`,
      "  Clone a member plugin and scan that, or scan a marketplace that vendors its plugins in-tree.",
    );
  }
  lines.push(
    "  Check that the path is the repo you meant, and that a flag didn't swallow it",
    "  (flags take values with `=`: `--out=dir`, never `--out dir`).",
  );
  return lines.join("\n");
}

/** `vigiles <verb> --help` — that verb's entry plus its complete flag list. */
function printCommandHelp(command: Verb): void {
  printHelpEntry(command, { detail: true });
  const flags = knownFlagsFor(command);
  console.log("");
  console.log(`Flags: ${[...flags].sort().join(" ")}`);
  console.log("(`vigiles --help` lists every command.)");
}

/**
 * The top-level help, grouped. The grouping is load-bearing, not cosmetic: four verbs
 * (`audit`, `lint`, `test`, `eval`) all read as "check my stuff", and a flat list left the
 * reader to work out the difference from four independent sentences. The headings state the
 * shared trait, which frees each verb's own line to state only what makes it different, so
 * the four form a 2x2 that survives one pass:
 *
 *                    no consequence          has a consequence
 *   read the files   audit (fails nothing)   lint (fails the build)
 *   run the harness  test  (free)            eval (spends money)
 */
function printUsage(command: string | undefined): void {
  console.log(
    "vigiles — verify your agent harness is real, and prove it works",
  );
  console.log("");
  for (const g of HELP_GROUPS) {
    console.log(g.heading);
    for (const v of g.verbs) printHelpEntry(v);
    console.log("");
  }
  console.log("Plumbing:");
  printHelpEntry("generate");
  console.log("  vigiles --version          Print the version number");
  console.log("");
  console.log("Flags live in `vigiles <command> --help`.");
  console.log("New here? Start with `vigiles audit .`");
  if (command && command !== "--help") {
    console.log(`\nUnknown command: "${command}"`);
    // 2, not 1 — `docs/cli.md` fixes the contract as 1 = "I ran, and what you
    // asked about is bad", 2 = "I could not do what you asked". A typo'd verb is
    // the second, and the unknown-FLAG path (cli-flag-check.ts) already exits 2.
    // A script telling "found problems" from "could not start" by exit code read
    // a mistyped command as a finding.
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Emit GitHub Actions annotations for an lint report. Skipped when --json or
 * --summary is active — those modes promise clean machine-readable stdout, and
 * ::error/::warning lines would contaminate output parsed as JSON.
 */
function annotateLintForGitHub(report: LintReport, flags: string[]): void {
  const structuredOutput =
    flags.includes("--json") || flags.includes("--summary");
  if (!isGitHubActions() || structuredOutput) return;
  if (report.hashErrors > 0) {
    ghAnnotate(
      "error",
      `${String(report.hashErrors)} compiled file(s) with stale hash — run vigiles compile`,
    );
  }
  if (report.validationErrors > 0) {
    ghAnnotate(
      "error",
      `${String(report.validationErrors)} spec validation failure(s) — see lint output`,
    );
  }
  if (report.duplicatePairs > 0) {
    ghAnnotate(
      "warning",
      `${String(report.duplicatePairs)} near-duplicate rule pair(s) detected — consider merging`,
    );
  }
}

/**
 * Run a compiled skill's deterministic gate ladder: execute each step gate in
 * order (short-circuiting on the first failure), then the result gate. This is
 * the v0 runtime — it enforces the `vigiles:gate`/`vigiles:result` markers a
 * compiled SKILL.md carries. It does not yet drive the model through the prose
 * steps (that needs a live harness).
 */
function runSkillCommand(target: string | undefined): void {
  if (!target) {
    console.error("Usage: vigiles hook-runtime run-skill <SKILL.md>");
    process.exit(2);
  }
  const path = resolve(process.cwd(), target);
  if (!existsSync(path)) {
    console.error(`Not found: ${target}`);
    process.exit(2);
  }
  const gates = parseSkillGates(readFileSync(path, "utf-8"));
  if (gates.steps.length === 0 && !gates.result) {
    console.log(`No vigiles:gate / vigiles:result markers in ${target}.`);
    return;
  }
  console.log(`Running gate ladder for ${target}:\n`);
  const report = runSkillGates(gates, process.cwd());
  for (const r of report.results) {
    const label = r.at === "result" ? "result" : `step ${String(r.at)}`;
    console.log(`  ${r.ok ? "✓" : "✗"} ${label} — ${gateLabel(r.gate)}`);
    if (!r.ok && r.output) {
      console.log(
        r.output
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n"),
      );
    }
  }
  if (report.ok) {
    console.log("\n✓ All gates passed.");
  } else {
    const where =
      report.blockedAt === "result"
        ? "the result gate"
        : `step ${String(report.blockedAt)}`;
    console.log(`\n✗ Blocked at ${where} — fix it before the skill is done.`);
    process.exit(2);
  }
}

/**
 * Stop-hook entrypoint: run the active skill's result gate and decide whether
 * the agent may stop. Exit 2 (with the reason on stderr) blocks the stop and
 * feeds the message back to the model; exit 0 allows it and clears the marker.
 */
function skillHookCommand(): void {
  const decision = evaluateStopHook(process.cwd());
  if (decision.allow) {
    if (decision.message) console.log(decision.message);
    clearActiveSkill(process.cwd());
    return;
  }
  console.error(decision.message);
  process.exit(2);
}

/** Mark a skill active so the Stop hook enforces its result gate. */
function skillStartCommand(target: string | undefined): void {
  if (!target) {
    console.error("Usage: vigiles hook-runtime skill-start <SKILL.md>");
    process.exit(2);
  }
  setActiveSkill(process.cwd(), target);
  // Record the fire in the flight recorder: the skill NAME is the parent dir of
  // its SKILL.md (skills/<name>/SKILL.md), falling back to the raw target.
  const parts = target.replace(/\\/g, "/").split("/").filter(Boolean);
  const name =
    parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? target);
  appendObservation({ kind: "skill", name, fired: true });
  console.log(`Active skill: ${target}`);
}

/**
 * PreToolUse-hook entrypoint: enforce the active skill's declared purity floor.
 * Reads the tool event on stdin, parses the `vigiles:purity:` marker from the
 * active skill's compiled SKILL.md, and blocks (exit 2 + reason on stderr) any
 * tool call that violates the declared floor — refining `Bash` by the live
 * command via `isReadOnlyBash`. Skills have no tools-allowlist rail; this gate
 * is purity-only. Mirrors `agentHookCommand` for skills.
 */
function skillToolHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  let tool = "";
  let command: string | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      tool_name?: string;
      tool_input?: { command?: unknown };
    };
    tool = parsed.tool_name ?? "";
    if (typeof parsed.tool_input?.command === "string") {
      command = parsed.tool_input.command;
    }
  } catch {
    /* malformed input → no tool, allow */
  }
  if (!tool) return;
  const decision = evaluateSkillPreToolUse(process.cwd(), tool, command);
  if (!decision.allow) {
    console.error(decision.message);
    process.exit(2);
  }
}

/**
 * PreToolUse-hook entrypoint: enforce the active subagent's allowed-tools
 * contract. Reads the tool event on stdin, parses the active agent's compiled
 * `.md` tool rail, and blocks (exit 2 + reason on stderr) any tool outside it —
 * the deterministic boundary `tools:` alone can't provide (Claude Code #4740/#21460, SDK #172).
 */
function agentHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  let tool = "";
  let command: string | undefined;
  let event = "";
  let toolInput: unknown;
  try {
    const parsed = JSON.parse(raw) as {
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: { command?: unknown };
    };
    event = parsed.hook_event_name ?? "";
    tool = parsed.tool_name ?? "";
    toolInput = parsed.tool_input;
    if (typeof parsed.tool_input?.command === "string") {
      command = parsed.tool_input.command;
    }
  } catch {
    /* malformed input → no tool, allow */
  }

  const cwd = process.cwd();

  // EXPERIMENTAL (parked P3 — do NOT auto-wire). The spawn/SubagentStop bracketing
  // is now nesting-safe: a depth-aware STACK (push on dispatch, POP on SubagentStop)
  // closes the contract-escape the flat single-slot model allowed under CC v2.1.172
  // depth-5 nesting. See research/effect-boundary-design.md + AgentWindowStack.tla.
  //
  // SubagentStop → CLOSE the window deterministically (no model `agent-done`): the
  // subagent returned, so POP its frame — control returns to its PARENT, whose
  // contract the gate enforces again (NOT a full clear, which would drop the parent).
  if (event === "SubagentStop") {
    popActiveAgent(cwd);
    clearEffectActive(cwd);
    return;
  }

  // PreToolUse(spawn) → OPEN the window deterministically (no model `agent-start` /
  // `effect-enter`): the parent is dispatching a subagent, so PUSH that subagent's
  // compiled contract for the tool calls it is about to make. Recognize both spawn
  // tool names — `Task` (top-level dispatch) and `Agent` (nested-spawn, CC v2.1.172)
  // — gated on a resolvable `subagent_type` so a non-spawn call never opens a frame.
  // The dispatch itself is the PARENT's action — don't gate it; just open + allow.
  if (tool === "Task" || tool === "Agent") {
    const agentPath = decideTaskDispatch(
      toolInput,
      cwd,
      process.env.CLAUDE_PLUGIN_ROOT,
    );
    if (agentPath) {
      pushActiveAgent(cwd, agentPath);
      setEffectActive(cwd);
    }
    return;
  }

  if (!tool) return;
  const decision = evaluatePreToolUse(cwd, tool, command);
  if (!decision.allow) {
    appendObservation({
      kind: "agent",
      name: readActiveAgent(cwd) ?? "unknown",
      tool,
      allowed: false,
      reason: decision.message,
    });
    console.error(decision.message);
    process.exit(2);
  }
}

/**
 * `vigiles hook-runtime intercept-tool` — the PreToolUse interception hook for the
 * tool-call spy. Reads the intercept list from `VIGILES_INTERCEPT_TOOLS`, decides
 * whether the called tool should be intercepted, and if so denies the real
 * execution (exit 2) with a block message — the call is intercepted (prevented),
 * NOT executed. Allowing (return) lets the tool run for real. The model still
 * emits the `tool_use`, so its arguments land in the Trace for `toolWith` /
 * `notTool` to assert on. See src/tool-intercept.ts.
 */
function interceptToolHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  const intercepts = parseIntercepts(process.env[INTERCEPT_TOOLS_ENV] ?? "");
  const decision = interceptHookDecision(raw, intercepts);
  if (decision.intercept) {
    console.error(decision.denyReason);
    process.exit(2);
  }
}

/**
 * `vigiles hook-runtime guard` — the PreToolUse gate for typed safe-by-construction guards
 * (EXPERIMENTAL). Reads the live event on stdin, runs the declared guard set
 * (`.vigiles/guards.json`) against the session ledger (`.vigiles/guard-ledger.json`),
 * and blocks (exit 2 + reason) or records the allowed call. The command in the
 * generated hooks block IS this gate — not user shell — so the enforcement is
 * safe-by-construction. See src/core/guards.ts.
 */
function guardHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  const { decision } = runGuardHook(process.cwd(), raw);
  if (!decision.allow) {
    console.error(decision.reason ?? "Blocked by a vigiles guard.");
    process.exit(2);
  }
}

/** Mark a subagent active so the PreToolUse hook enforces its tool contract. */
function agentStartCommand(target: string | undefined): void {
  if (!target) {
    console.error("Usage: vigiles hook-runtime agent-start <agents/<name>.md>");
    process.exit(2);
  }
  pushActiveAgent(process.cwd(), target);
  console.log(`Active agent: ${target}`);
}

/** Dispatch the skill-runtime subcommands. Returns false if unrecognized. */
/**
 * `vigiles hook-runtime <kind> [args]` — the hidden umbrella for RUNTIME
 * entrypoints: the executables the harness invokes via a block `vigiles compile`
 * emits into your hooks config, NEVER typed by a human. They stay off the help
 * surface by design — verbs are typed, runtime entrypoints are emitted (the
 * cohesive-cli-surface rule). Renaming a `<kind>` breaks every already-emitted
 * block, so it is a breaking change.
 */
export async function handleHookRuntime(
  kind: string | undefined,
  restArgs: string[],
): Promise<void> {
  switch (kind) {
    case "run-program":
      await runHookProgramCommand(restArgs[0]);
      return;
    case "agent":
      agentHookCommand();
      return;
    case "agent-start":
      agentStartCommand(restArgs[0]);
      return;
    case "agent-done":
      popActiveAgent(process.cwd());
      return;
    case "skill":
      skillHookCommand();
      return;
    case "skill-tool":
      skillToolHookCommand();
      return;
    case "skill-start":
      skillStartCommand(restArgs[0]);
      return;
    case "skill-done":
      clearActiveSkill(process.cwd());
      return;
    case "run-skill":
      runSkillCommand(restArgs[0]);
      return;
    case "intercept-tool":
      interceptToolHookCommand();
      return;
    case "guard":
      guardHookCommand();
      return;
    case "action":
      actionHookCommand();
      return;
    case "refs":
      refsHookCommand();
      return;
    case "eval-lock-nudge":
      evalLockNudgeHookCommand();
      return;
    case "effect-enter":
      setEffectActive(process.cwd());
      console.log("Effect boundary entered.");
      return;
    case "effect-exit":
      clearEffectActive(process.cwd());
      return;
    default:
      console.error(
        `vigiles hook-runtime: unknown runtime entrypoint "${kind ?? ""}". ` +
          `These are emitted into your hooks config by \`vigiles compile\` — ` +
          `you don't run them by hand.`,
      );
      process.exit(2);
  }
}

/**
 * PostToolUse-hook entrypoint for action gates. Reads the tool event on stdin,
 * runs the matching action gates from `.vigiles/action-gates.json`, and blocks
 * (exit 2 + reason on stderr) if any fails — plan-agnostic, so it works inside
 * dynamic workflows where there is no static step to attach a gate to.
 */
function actionHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  let event: { tool: string; input?: Record<string, unknown> } = { tool: "" };
  try {
    const j = JSON.parse(raw) as {
      tool_name?: string;
      tool_input?: Record<string, unknown>;
    };
    event = { tool: j.tool_name ?? "", input: j.tool_input };
  } catch {
    /* malformed input → no event, allow */
  }
  const decision = evaluateAction(
    event,
    loadActionGates(process.cwd()),
    process.cwd(),
  );
  if (!decision.allow) {
    console.error(decision.message);
    process.exit(2);
  }
}

const INSTRUCTION_FILE = /^(SKILL|CLAUDE|AGENTS)\.md$/;

function isInstructionFile(file: string): boolean {
  return INSTRUCTION_FILE.test(basename(file));
}

/**
 * PostToolUse-hook entrypoint for the two edit-time test reminders. When the agent
 * edits a skill/agent surface or an `*.eval.*` script it injects, NON-BLOCKING:
 *
 *  1. `skillTestNudge` — the surface has no test/eval at all, or has a harness but
 *     was never EVALUATED (so nothing has measured that its description fires).
 *     Reuses the `untested-skill` detector and hands off to the `test-harness`
 *     skill for the tier→API table — the agent knows it needs a test, not which
 *     runner. Fires at edit time, closing the gap that `untested-skill` only ran
 *     when someone typed `vigiles lint`.
 *  2. `evalLockNudge` — a committed lock may now be stale; re-run `eval --update`.
 *
 * Never blocks, never runs an eval — reminders, not gates (the gate is
 * `eval --check` in CI). Both CC and Codex deliver these as `additionalContext`
 * on `PostToolUse` (confirmed — see docs/harness-testing-codex.md).
 */
function evalLockNudgeHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin → nothing to do */
  }
  let file = "";
  try {
    const j = JSON.parse(raw) as { tool_input?: { file_path?: string } };
    file = j.tool_input?.file_path ?? "";
  } catch {
    /* malformed → nothing to do */
  }
  if (!file) return;
  const cwd = process.cwd();
  const target = relative(cwd, resolve(cwd, file)) || file;
  // 🔴 THE SAME CONFIG `vigiles lint` READS. This used to pass `basePath` alone,
  // so a repo that had switched `untested-skill` off, or pointed `include` at
  // its own test names, got a nudge asserting the opposite of what its own
  // linter said (see `untestedRules`). A rule the author DISABLED must not come
  // back through a hook; a test the author CONFIGURED must count here too.
  //
  // The disable travels inside `options` — a kind whose rule is off arrives as
  // `skills: false` / `agents: false` and is not scanned, so the detector has
  // nothing to report. No extra "is anything enabled" guard here on purpose: a
  // second gate saying the same thing is a branch no test can distinguish from
  // its absence (measured — the mutation passed), i.e. the dead-fragment class
  // this same change removed from the runner table.
  const config = loadConfig();
  const { options } = untestedRules(config);
  // 🔴 THE SAME LAYOUT `vigiles lint` RESOLVES, for the same reason as the config
  // above. This used to pass `basePath` alone, so the detector fell back to the
  // Claude Code layout: in a Codex repo whose surfaces live at
  // `.codex/skills/foo/SKILL.md`, it discovered NOTHING, found the edited skill in
  // nothing, and stayed silent — while `vigiles lint`, one `adapter.layout` away,
  // reported that very skill as untested. A hook that contradicts the linter by
  // omission is worse than no hook: nobody is looking for the message that never
  // came.
  const layout = harnessLayoutFor(cwd, config);
  // Two nudges, one entry, most-urgent first. The lock reminder is SELF-GATING:
  // silent until a lock is committed — so a repo that has never written a test
  // heard nothing at all, while a repo that already tests got reminded. That is
  // backwards, and `untested-skill` already stated the missing half correctly;
  // it just lived in `vigiles lint`, which someone has to run by hand.
  const msg =
    skillTestNudge(target, {
      ...options,
      basePath: cwd,
      layout,
      // Same union `vigiles lint` applies: the rule's exclude narrows, the
      // repo-wide exclude is the floor (#192) — the nudge must not report a
      // vendored skill the linter would never list.
      exclude: [
        ...(options.exclude ?? []),
        ...excludeSet(cwd, config.exclude).ignore,
      ],
    }) ?? evalLockNudge(target, resolve(cwd, DEFAULT_LOCK_DIR));
  if (!msg) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: msg,
      },
    }) + "\n",
  );
}

/**
 * PostToolUse-hook entrypoint: when the agent edits an instruction file, force
 * every code reference to carry a file-qualified mark (`path.ext#symbol`) and
 * verify the marked ones against the named file. Exit 2 (reason on stderr)
 * blocks the edit and feeds the fix back to the agent — the harness makes the
 * agent mark its references, at write time, with full context. `vigiles:ignore`
 * opts a prose span out.
 */
function refsHookCommand(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  let file = "";
  try {
    const j = JSON.parse(raw) as { tool_input?: { file_path?: string } };
    file = j.tool_input?.file_path ?? "";
  } catch {
    /* malformed → nothing to do */
  }
  if (!file || !isInstructionFile(file)) return;
  const severity = ruleSeverity(loadConfig().rules["unmarked-refs"]);
  if (severity === false) return;
  const cwd = process.cwd();
  const target = relative(cwd, resolve(cwd, file)) || file;
  let markdown: string;
  try {
    markdown = readFileSync(resolve(cwd, file), "utf-8");
  } catch {
    return;
  }
  const issues = collectRefIssues(markdown, dirname(resolve(cwd, file)));
  const action = refsHookAction(issues.length, severity);
  if (action === "ok") return;

  if (action === "block") {
    // Opt-in (`unmarked-refs: "error"`): exit 2 feeds stderr to the model.
    console.error(`vigiles: fix the code references in ${target}:`);
    for (const m of issues) console.error(`  ✗ ${m}`);
    process.exit(2);
  }

  // Default ("warn"): a non-blocking nudge injected into the agent's context.
  const context =
    `vigiles: ${target} has reference(s) that won't be verified unless they ` +
    `are vigiles marks:\n` +
    issues.map((m) => `  - ${m}`).join("\n") +
    `\nExpress references as marks (\`enforce()\` / \`file()\` / \`cmd()\` / a ` +
    `\`vigiles:symbol\` span / an inline \`<!-- vigiles:enforce -->\` comment) so ` +
    `\`vigiles lint\` can check them — or add \`<!-- vigiles:ignore -->\` if it ` +
    `is prose, not a reference.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Compiled hooks (`vigiles/hook`) — author a hook as a pure typed program,
// compile it to a harness block, run it as the hooks-block command.
// ---------------------------------------------------------------------------

/**
 * Compile (validate) the registered providers under `.vigiles/providers/`: each
 * must load and be read-only unless it opted into `dangerous`. Returns the set of
 * valid provider NAMES (so a hook's `provider()` ref can resolve at compile).
 * Throws HookCompileError on an unsafe provider — the same fail-the-build contract
 * as a hook.
 */
async function compileProviders(): Promise<string[]> {
  const names: string[] = [];
  for (const file of discoverProviderFiles(process.cwd())) {
    const def = await loadProvider(file);
    if (unsafeProvider(def)) {
      throw new HookCompileError(
        `provider ${file} ("${def.run}") is not provably read-only — ` +
          `pass dangerous:true to defineProvider to acknowledge it.`,
      );
    }
    names.push(def.name);
  }
  return names;
}

/** What installing one hook did — for the `compile` summary line. */
interface HookInstallResult {
  readonly role: DispatchKind;
  readonly settingsPath: string;
  /** Loud, non-CC inject/react caveat (the no-silent-skips gap). */
  readonly warning?: string;
}

/**
 * Compile ONE typed hook program (authored against `vigiles/hook`) and MERGE it
 * into the active harness's native config — the hook half of `vigiles compile`
 * (there is no `compile-hook` verb; the cohesive-cli-surface rule). An import
 * outside the sanctioned API does NOT compile (capability = API surface). The
 * emitted block routes the live event to `hook-runtime run-program`; a
 * tamper-evident stamp sidecar lets the runtime refuse a hand-edited artifact.
 * The merge is idempotent (keyed by the hook FILE via `normalizeHookRef`, not by
 * the string the user typed — `x.hook.ts` and `./x.hook.ts` are the same wiring),
 * so recompiling updates in place and never clobbers the user's own hooks.
 */
async function installHookFile(
  file: string,
  adapter: HarnessAdapter,
  registeredProviders: readonly string[] = [],
): Promise<HookInstallResult> {
  const source = readFileSync(resolve(process.cwd(), file), "utf-8");
  const program = await loadHookProgram(file);
  // Emit the CANONICAL path so two spellings of the same file produce the same
  // command — the merge key and the emitted command must agree, or recompiling
  // appends a duplicate block instead of replacing the existing one.
  const ref = normalizeHookRef(file);
  const compiled = compileHookProgram(source, program, {
    // 🔴 ANCHORED AT THE PROJECT ROOT. A hook command does not run with a stable cwd —
    // this codebase says so twice (`bareToken`'s header, `PluginLayout.projectRootTokens`)
    // and `projectRootOf` relies on the anchored spelling "by construction", but the
    // emitter never produced it. Measured 2026-09-10 in a consumer repo: after a compile,
    // one `cd` into a subdirectory made a PreToolUse gate fail to load, and a gate that
    // cannot load must block — the repo seized, every command refused including the repair.
    gateCommand: `npx vigiles hook-runtime run-program ${hookGateRef(ref, adapter.layout.projectRootTokens)}`,
    dialect: adapter.dialect,
    hookProtocol: adapter.hookProtocol,
    settingsFormat: adapter.layout.settingsFormat,
    registeredProviders,
  });

  // Tamper-evident stamp beside the source (one dir → basename is unique).
  mkdirSync(dirname(hookStampPath(file)), { recursive: true });
  writeFileSync(
    hookStampPath(file),
    JSON.stringify({ file, stamp: compiled.stamp }, null, 2) + "\n",
  );

  // Merge into the harness's native config, idempotently.
  const format = adapter.layout.settingsFormat;
  const settingsAbs = resolve(process.cwd(), adapter.layout.settingsPath);
  const existing: Record<string, unknown> = existsSync(settingsAbs)
    ? format === "toml"
      ? (parseToml(readFileSync(settingsAbs, "utf-8")) as Record<
          string,
          unknown
        >)
      : (JSON.parse(readFileSync(settingsAbs, "utf-8")) as Record<
          string,
          unknown
        >)
    : {};
  const merged =
    format === "toml"
      ? mergeHooksToml(existing, compiled.hooks, ref)
      : mergeHooksJson(existing, compiled.hooks, ref);
  mkdirSync(dirname(settingsAbs), { recursive: true });
  writeFileSync(settingsAbs, serializeConfig(merged, format));

  // No silent skips: warn loudly only where a hook's OUTPUT genuinely may not
  // apply on this harness. INJECT's `additionalContext` shape is now CONFIRMED
  // shared with Codex (per the official hooks docs), so an inject hook only
  // warns when its event isn't in the harness's `injectableEvents`. REACT's
  // output is still Claude-Code-confirmed only. The gate (deny→exit 2) path is
  // cross-harness and never warns.
  const role = dispatchKind(program);
  const event = typeof program.on === "string" ? program.on : "";
  const injectable = adapter.hookProtocol?.injectableEvents ?? [];
  const matcher = hookRouting(program).matcher;
  let warning: string | undefined;
  // A react on an event this harness does NOT inject can still call `notice()`,
  // and that text would reach NOBODY (stderr at exit 0 is the debug log only).
  // Say so at INSTALL time: a runtime warning would go to the same stderr the
  // notice is stuck in, which is the defect one level up.
  if (role === "react" && !injectable.includes(event)) {
    warning =
      `a react on "${event}" may emit notice(...), but ${adapter.name} does not ` +
      `honor additionalContext for that event — the text would reach NOBODY ` +
      `(stderr at exit 0 goes to the debug log, not the transcript, and the model ` +
      `never sees it). Injectable here: ${injectable.join(", ") || "(none)"}. ` +
      `Move the hook to one of those events, or use run() if you meant an action.`;
  } else if (adapter.name !== "claude-code") {
    if (role === "inject" && !injectable.includes(event)) {
      warning =
        `this inject hook targets "${event}", which ${adapter.name} does not ` +
        `honor for additionalContext — the injected text won't reach the agent. ` +
        `Use an event ${adapter.name} supports: ${injectable.join(", ")}.`;
    } else if (role === "react") {
      warning =
        `react output is confirmed only for Claude Code; on ${adapter.name} this ` +
        `hook's react output is unverified (the gate deny→exit 2 path IS ` +
        `cross-harness). Confirm against the real binary first.`;
    } else if (matcher !== undefined) {
      // A tool-matched gate carries TOOL NAMES in its matcher. vigiles does not
      // yet translate tool vocabularies across dialects, so a matcher authored
      // with Claude Code names (`Edit`/`Write`/`Bash`) won't fire on a harness
      // that names the same tools differently (Codex: `apply_patch`/`shell`).
      // Warn LOUDLY rather than report a silently-non-firing success.
      warning =
        `this hook matches tool(s) "${matcher}" — if those are Claude Code tool ` +
        `names, they may not match ${adapter.name}'s vocabulary (e.g. ` +
        `apply_patch/shell), so the hook may not fire. Verify the matcher uses ` +
        `${adapter.name}'s tool names (cross-dialect matcher translation is not ` +
        `yet automatic).`;
    }
  }
  return { role, settingsPath: adapter.layout.settingsPath, warning };
}

/**
 * Compile + install every hook (explicit paths, else discovered under
 * `.vigiles/hooks/`) into EVERY enabled harness's config. A typed hook is
 * harness-neutral, so when a repo targets both harnesses the SAME hook is merged
 * into `.claude/settings.json` AND `.codex/config.toml` (each in its native
 * format, with per-harness warnings) — never just the first. The harness set is
 * resolved from the `--harness=` flag, else `config.harness`, else auto-detect.
 * Returns false if any hook failed to compile for any harness.
 */
async function installHooks(
  hookFiles: string[],
  harnessFlag: string | undefined,
  configHarness: string | readonly string[] | undefined,
): Promise<boolean> {
  if (hookFiles.length === 0) return true;
  const adapters = resolveHarnessAdapters({
    root: process.cwd(),
    flag: harnessFlag,
    configHarness,
  });
  // Validate registered providers first → the names a hook's provider() ref may
  // resolve to (an unsafe provider fails the whole compile, like a bad hook).
  let registeredProviders: string[];
  try {
    registeredProviders = await compileProviders();
  } catch (e) {
    if (e instanceof HookCompileError) {
      console.error(`✗ ${e.message}`);
      return false;
    }
    throw e;
  }
  let ok = true;
  for (const file of hookFiles) {
    try {
      // Fan out: the same compiled hook lands in each enabled harness's config.
      for (const adapter of adapters) {
        const r = await installHookFile(file, adapter, registeredProviders);
        console.log(
          `✓ ${file} → ${r.settingsPath} (role: ${r.role}, harness: ${adapter.name})`,
        );
        if (r.warning) console.warn(`⚠ ${r.warning}`);
      }
    } catch (e) {
      if (e instanceof HookCompileError) {
        console.error(`✗ ${file} — ${e.message}`);
        const src = (() => {
          try {
            return readFileSync(resolve(process.cwd(), file), "utf-8");
          } catch {
            return "";
          }
        })();
        if (checkHookImports(src).length > 0) {
          console.error(
            "  A compiled hook may import ONLY `vigiles/hook` — that is its " +
              "entire capability surface.",
          );
        }
        ok = false;
      } else {
        throw e;
      }
    }
  }
  return ok;
}

/**
 * Idempotently keep the generated report artifacts OUT of git — the tool that
 * writes a build artifact keeps it ignored (the `next build` → `.next` pattern),
 * so `vigiles audit` (which runs zero-config, without `init`) never leaves
 * surprise untracked files in `git status`. Appends only the MISSING entries
 * under a labelled block if a `.gitignore` exists; if none exists, prints a
 * one-line nudge rather than creating one silently. Best-effort — a failure here
 * never breaks the audit. `entries` are paths relative to the git root (cwd).
 */
function ensureReportGitignored(
  cwd: string,
  entries: readonly RepoRelativePath[],
): void {
  if (entries.length === 0) return;
  // 🔴 THE GUARD THAT USED TO BE HERE IS GONE, and its absence is the point.
  // It checked at the write site that no entry escaped the repo (#176.8) — which
  // worked, and left the bug writable: the next caller to build an entry list
  // still got a bare `string[]`. `RepoRelativePath` moves the check into the
  // TYPE, so an escaping path cannot be handed to this function at all. One
  // place mints them (`repoRelative`), and it returns null instead.
  const gi = resolve(cwd, ".gitignore");
  try {
    if (!existsSync(gi)) {
      console.log(
        `\nℹ tip: add ${entries.join(" + ")} to a .gitignore (generated report artifacts)`,
      );
      return;
    }
    const content = readFileSync(gi, "utf-8");
    const present = new Set(content.split("\n").map((l) => l.trim()));
    const missing = entries.filter((e) => !present.has(e));
    if (missing.length === 0) return;
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    writeFileSync(
      gi,
      `${content}${sep}\n# vigiles audit report (generated)\n${missing.join("\n")}\n`,
    );
    console.log(`✓ Added ${missing.join(" + ")} to .gitignore`);
  } catch {
    /* best-effort — a read-only or missing .gitignore never breaks the audit */
  }
}

/**
 * Write the versioned JSON artifact (`vigiles-report.json`) — the upload/CI
 * boundary a hosted dashboard ingests. Stamps `meta.generatedAt` here (at write
 * time, not in the pure builder, so the HTML-embedded form stays deterministic).
 */
function writeAuditJson(report: AuditReport, outDir: string): void {
  const jsonPath = resolve(outDir, "vigiles-report.json");
  const stamped: AuditReport = {
    ...report,
    meta: { ...report.meta, generatedAt: new Date().toISOString() },
  };
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(stamped, null, 2) + "\n");
    console.log("✓ Wrote vigiles-report.json — the upload/CI artifact");
  } catch (e) {
    console.log(
      `\n⚠ could not write vigiles-report.json: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Best-effort open the report in the default browser (TTY-only caller). */
function openBestEffort(file: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  void import("node:child_process")
    .then(({ spawn }) => {
      const child = spawn(cmd, [file], {
        stdio: "ignore",
        detached: true,
        shell: process.platform === "win32",
      });
      child.on("error", () => undefined);
      child.unref();
    })
    .catch(() => undefined);
}

/**
 * Write the self-contained HTML audit report to `vigiles-report.html` (cwd) and,
 * for a human at a TTY, open it best-effort. The shareable Lighthouse artifact;
 * never spawns a browser for an agent / CI run.
 */
function writeAuditHtml(
  report: AuditReport,
  outDir: string,
  open: boolean,
): void {
  const htmlPath = resolve(outDir, "vigiles-report.html");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(htmlPath, renderAuditHtml(report));
    console.log("\n✓ Wrote vigiles-report.html — open it for the full report");
    // Great DX: pop the report open in the browser for a human at a TTY (the
    // `lighthouse --view` behaviour). `--no-open` suppresses it; an agent / CI
    // run (no TTY) never spawns a browser.
    if (open && process.stdout.isTTY) openBestEffort(htmlPath);
  } catch (e) {
    // No template (unbuilt checkout) or a write error — skip the HTML; the JSON
    // artifact + terminal report don't depend on it.
    console.log(
      `\n⚠ skipped vigiles-report.html: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * The audited repo's `origin` remote URL, or null when there's no remote / it
 * isn't a git tree. Offline, best-effort — feeds the `audit` share deep-link. The
 * pure parse lives in src/share-link.ts; this is the local read.
 */
/* v8 ignore start — thin git-config read; the parse is unit-tested in share-link.test.ts */
function readOriginRemote(root: string): string | null {
  try {
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const git = (cmd: string): string =>
      execSync(cmd, {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    // Only share a link when the audited dir IS the git repo ROOT. For a subdir
    // audit (`vigiles audit packages/foo` in a monorepo, or a vendored plugin)
    // git walks UP to the enclosing repo, so `origin` names the PARENT owner/repo
    // — the deep-link would rerun a DIFFERENT audit for the recipient and show a
    // different grade. Suppress it there (Codex review); the link carries only
    // owner/repo, so it can't disambiguate a subdirectory anyway.
    if (resolve(git("git rev-parse --show-toplevel")) !== resolve(root)) {
      return null;
    }
    return git("git config --get remote.origin.url") || null;
  } catch {
    return null;
  }
}
/* v8 ignore stop */

/**
 * Start the live (`--serve`) adoption server: render the report with a per-run
 * token, serve it on loopback, and run `init` in-process when a button POSTs. The
 * security model lives in src/audit-serve.ts (token + Origin + allowlist). Blocks
 * until the user stops it (Ctrl-C or the page's Done). Own-repo only — the caller
 * gates this via decideServeGate, so adopt always writes into the current repo.
 */
async function runAuditServe(
  report: AuditReport,
  adoptable: AuditReport["adoptable"],
  cliErr: (e: unknown) => string,
): Promise<void> {
  const token = newToken();
  const surfaces = new Set((adoptable?.surfaces ?? []).map((s) => s.path));
  let html: string;
  try {
    html = renderAuditHtml(report, { token });
  } catch (e) {
    console.log(`\n⚠ can't serve the live report: ${cliErr(e)}`);
    return;
  }
  const adoptOne = (target: string): Promise<AdoptOutcome> => {
    try {
      scaffoldSpec(["--target=" + target]); // in-process; writes into cwd (own repo)
      return Promise.resolve({
        ok: true,
        message: `created spec for ${target}`,
      });
    } catch (e) {
      return Promise.resolve({ ok: false, message: cliErr(e) });
    }
  };
  console.log(
    "\n  Live report — create specs with one click. Ctrl-C to stop.\n",
  );
  await serveAudit({
    token,
    surfaces,
    html,
    runAdopt: adoptOne,
    runAdoptAll: () => {
      try {
        for (const p of surfaces) scaffoldSpec(["--target=" + p]);
        return Promise.resolve({
          ok: true,
          message: `created ${String(surfaces.size)} spec(s)`,
        });
      } catch (e) {
        return Promise.resolve({ ok: false, message: cliErr(e) });
      }
    },
    onListening: (url) => {
      console.log(`  ${url}`);
      if (process.stdout.isTTY) openBestEffort(url);
    },
  });
  console.log("\n✓ live report closed");
}

/**
 * Run the model trigger tier with no `--prompts`: auto-generate diverse probe
 * prompts from each skill's description and measure trigger-rate (recall +
 * precision) — zero-setup. `--prompts=<file>` (handled by handleMeasure)
 * overrides for a curated benchmark + the collision matrix. Model-gated: the
 * probes are deterministic, but RUNNING them needs the harness CLI + model auth
 * (degrades to "unavailable" otherwise).
 */
async function runAutoTrigger(
  dir: string,
  report: ScanReport,
  adapter: HarnessAdapter,
  args: string[],
): Promise<void> {
  const json = args.includes("--json");
  const harness: ProbeHarness =
    adapter.name === "codex" ? "codex" : "claude-code";
  const skills: PromptSkill[] = report.skills
    .filter((s) => s.hasDescription && !s.userInvoked && s.description)
    .map((s) => ({ name: s.name, description: s.description ?? "" }));
  if (skills.length === 0) {
    if (!json) {
      console.log(
        "\nℹ no model-invocable skills with a description to measure.",
      );
    }
    return;
  }
  const promptSet = autoTriggerPrompts(skills);
  if (!json) {
    console.log(
      "\nℹ auto-generated probe prompts from skill descriptions (pass --prompts=<file> for a curated set).",
    );
  }
  const model = flagValue(args, "--model");
  const trigger = await probePluginTriggers(dir, promptSet, {
    minPrompts: AUTO_RECALL_COUNT,
    minDistance: AUTO_MIN_DISTANCE,
    model,
    harness,
    // Discover candidates with the resolved adapter's layout/dialect — a Codex
    // repo's skills live under the Codex layout, not the default CC one.
    layout: adapter.layout,
    dialect: adapter.dialect,
  });
  // Second behavioral eval (same consent): the selection-collision matrix — does
  // one skill HIJACK a sibling's prompt? This is the MEASURED confirmation of the
  // deterministic description-overlap proxy (the Triggering ring flags look-alikes;
  // this proves the wrong one actually fires). Only meaningful with ≥2 model-
  // invocable skills (a lone skill can't collide); reuses the same auto prompts.
  const collisions =
    skills.length >= 2
      ? await measurePluginSelection(dir, promptSet, { model, harness })
      : null;
  // Third behavioral eval (same consent): adversarial-gate — do enforcement-gate
  // skills HOLD when the agent is told to violate them? Auto-derives its own
  // attacks; a no-op (no model calls) when the plugin declares no gate skills.
  const gates = await measureGateAdversarial(dir, {
    model,
    harness,
    layout: adapter.layout,
    dialect: adapter.dialect,
  });
  // Show the gate section when gate skills were DETECTED — even if the eval
  // couldn't RUN (a Codex audit, or no `claude` CLI) it returns available:false
  // with empty results, and `formatGateReport` renders the "unavailable" note.
  // The consent prompt already advertised these gate skills, so a skipped check
  // must be reported LOUDLY, never silently omitted as if there were none.
  const hasGates =
    gates.results.length > 0 || detectGateSkills(report.skills).length > 0;
  if (json) {
    console.log(
      JSON.stringify(
        {
          trigger,
          ...(collisions ? { collisions } : {}),
          ...(hasGates ? { gates } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("\n" + formatBehavioralReport(trigger));
    if (collisions) console.log("\n" + formatSelectionReport(collisions));
    if (hasGates) console.log("\n" + formatGateReport(gates));
  }
}

/**
 * What `audit`'s executing checks (safety battery + live MCP + trigger-rate) need
 * — used to decide whether there's anything to run, and to disclose it at consent.
 */
interface ExecutableSurfaces {
  readonly hasMcp: boolean; // own-repo + declares MCP server(s)
  readonly triggerableSkills: number; // model-invocable, described skills
  readonly gateSkills: number; // enforcement-gate skills (the adversarial-gate eval)
  // An instruction file whose refs the adoption preview can draft+verify. Harness-
  // aware: Claude Code only in v1 (drafting drives the `claude` CLI), so a bare
  // CLAUDE.md repo is consent-eligible but a Codex AGENTS.md repo isn't (it gets a
  // loud deferral note instead).
  readonly adoptableRefs: boolean;
}

/**
 * The ONE read-vs-run decision for a single-plugin `audit`. A plain `audit` is a
 * deterministic READ; the executing checks are opt-in via a single consent —
 * `decideExecute` resolves it (run / ask / skip). At a TTY we ASK ONCE (bundled,
 * with a confinement + cost DISCLOSURE) and remember the answer in `.vigilesrc.json`;
 * headless we stay a read (the `note` is the loud nudge, printed by the caller
 * AFTER the report). Never hangs an agent / CI run (`great-agent-flow`).
 *
 * Returns `execute` (run the executing checks?) + a `note` to print at the end.
 */
async function resolveExecution(
  s: ExecutableSurfaces,
  decision: ExecuteDecision,
  json: boolean,
  harness: string,
): Promise<{ execute: boolean; note: string | null }> {
  if (decision.kind === "run") return { execute: true, note: null };
  if (decision.kind === "skip")
    return {
      execute: false,
      note: json ? null : formatExecuteSkip(decision.reason),
    };
  // ask — prompt once, then remember the answer.
  const answer = await askOnce(buildExecuteDisclosure(s, harness));
  const yes = /^y(es)?$/i.test(answer); // default NO (executes your hooks / servers)
  rememberAuditMeasure(yes);
  return {
    execute: yes,
    note: yes
      ? null
      : "  Skipped (remembered — edit .vigilesrc.json `audit.measure` to change).",
  };
}

/** The bundled consent prompt — discloses exactly what will execute (and what it
 *  costs) so the yes is informed. Default NO. Harness-aware: a Codex repo measures
 *  via the codex CLI (not a Claude env var), so the cost wording must not falsely
 *  read "no model access" in exactly the case the prompt is meant to disclose. */
function buildExecuteDisclosure(
  s: ExecutableSurfaces,
  harness: string,
): string {
  const lines = ["\nRun the executing checks against your harness?"];
  if (s.hasMcp)
    lines.push("  · start your MCP servers — connects to their backends");
  if (s.triggerableSkills > 0) {
    // ≥2 model-invocable skills also get the selection-collision matrix (does one
    // skill hijack a sibling's prompt) — disclose it so the consent stays honest.
    const what =
      s.triggerableSkills >= 2
        ? "measure whether skills fire and collide"
        : "measure whether skills fire";
    lines.push(`  · ${what} (${triggerCostWording(harness)})`);
  }
  if (s.gateSkills > 0) {
    // The adversarial-gate eval runs the FULL (unstubbed) skill — the most
    // expensive check — so disclose it separately when gate skills are present.
    lines.push(
      `  · test whether ${String(s.gateSkills)} enforcement-gate skill${s.gateSkills === 1 ? "" : "s"} hold under pressure — runs the full skill (${triggerCostWording(harness)})`,
    );
  }
  if (s.adoptableRefs) {
    lines.push(
      `  · draft + verify your instruction file's references (${triggerCostWording(harness)})`,
    );
  }
  lines.push("Asked once — remembered in .vigilesrc.json. [y/N] ");
  return lines.join("\n");
}

/** Cost/availability wording for the trigger tier, per harness. Codex runs on the
 *  codex CLI (its own auth/plan), so it's never gated on a Claude env var. */
function triggerCostWording(harness: string): string {
  if (harness === "codex")
    return "your Codex CLI, $0 metered — skips if `codex` isn't on PATH";
  return !hasModelAccess(process.env)
    ? "needs model access — none detected, will skip"
    : isMeteredAccess(process.env)
      ? "⚠ spends API credits"
      : "your subscription, $0 metered";
}

/** Run the trigger tier: a curated `--prompts` file, else auto-generated probes. */
async function runTriggerTier(
  dir: string,
  report: ScanReport,
  adapter: HarnessAdapter,
  args: string[],
): Promise<void> {
  if (flagValue(args, "--prompts")) {
    await handleMeasure([dir], args);
  } else {
    await runAutoTrigger(dir, report, adapter, args);
  }
}

/** Ask one question on a fresh readline, closing it after (the codebase pattern). */
async function askOnce(q: string): Promise<string> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((res) => {
      rl.question(q, (a) => {
        res(a.trim());
      });
    });
  } finally {
    rl.close();
  }
}

/**
 * Persist the audit consent (`audit.measure`) into `.vigilesrc.json` without
 * clobbering existing keys — the "ask once, remember" sticky choice. Best-effort:
 * a malformed user config is left untouched, a write error is non-fatal (the
 * measurement already ran / was skipped; only the memory is lost).
 */
function rememberAuditMeasure(value: boolean): void {
  const configPath = resolve(process.cwd(), ".vigilesrc.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      return; // user-owned malformed config — never clobber it
    }
  }
  const prevAudit =
    typeof existing.audit === "object" && existing.audit !== null
      ? (existing.audit as Record<string, unknown>)
      : {};
  const merged = { ...existing, audit: { ...prevAudit, measure: value } };
  try {
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    /* non-fatal — the run already happened; only the remembered choice is lost */
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // `--version` / `-v` / `version` prints the version number, not the help
  // banner — so `npx vigiles --version` reports e.g. `3.0.0`.
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(getVersion());
    return;
  }

  // Refuse an argument we did not understand, BEFORE anything runs. Every verb
  // parses its own flags by asking `args.includes("--x")` and ignoring the rest,
  // so `audit --this-flag-does-not-exist` used to run a complete audit and exit
  // 0. audit's flags govern what LEAVES the machine (`--no-html`, `--no-json`,
  // `--out=`, `--serve`), so a typo silently produced the opposite of what was
  // asked for. `<verb> --help` is handled here too: it used to fall through and
  // RUN the verb, the least useful answer to "what is this flag called?".
  // `hook-runtime` is exempt — its argv comes from the harness, not a human.
  if (VERBS.includes(command as Verb) && command !== "hook-runtime") {
    const flagArgs = args.slice(1);
    if (flagArgs.includes("--help")) {
      printCommandHelp(command as Verb);
      return;
    }
    const bad = unknownFlags(command, flagArgs);
    if (bad.length > 0) {
      for (const flag of bad) console.error(formatUnknownFlag(command, flag));
      // 2, not 1. Across this CLI, 1 means "I ran, and the thing you asked about
      // is bad" (lint findings, a failing harness script); 2 means "I could not
      // do what you asked" (the top-level error handler, `eval`'s refusal,
      // `generate` with an unknown kind). A misspelled flag is the second.
      process.exit(2);
    }
  }

  const restArgs = args.slice(1).filter((a) => !a.startsWith("--"));
  // Shared flags (--max-rules, --catalog-only) override the loaded config so
  // every GitHub Action input maps to a real CLI flag. See src/cli-flags.ts.
  const config = applyConfigFlags(loadConfig(), args);
  // `.vigilesrc.json#exclude`, parsed ONCE here and threaded to every walk that
  // polices the repo (src/exclude.ts). Built where the config is loaded so a
  // command cannot re-derive it differently — the drift #192 measured.
  const excludes = excludeSet(process.cwd(), config.exclude);

  switch (command) {
    // --- Primary commands ---

    case "init": {
      // Explicit --target bypasses the setup wizard and always creates a
      // bare spec, so `npx vigiles init --target=<file>` is a reliable
      // remediation for the require-instructions-spec validator. Bare `vigiles init`
      // still runs the full wizard (project detection + auto-targets).
      const hasTarget = args.some((a) => a.startsWith("--target="));
      if (hasTarget) {
        scaffoldSpec(args.slice(1));
      } else {
        await setup(args);
      }
      break;
    }

    case "compile": {
      const harnessFlag = harnessFlagFrom(args);
      // One verb compiles every typed authoring artifact: a .spec.ts → markdown,
      // a hook program → its harness config + stamp (cohesive-cli-surface). With
      // explicit args, partition by extension; bare, discover both.
      const specs =
        restArgs.length > 0
          ? restArgs
              .filter((f) => f.endsWith(".spec.ts"))
              .map((f) => noteExplicitOverride(excludes, f, "compiling"))
          : findSpecs(excludes);
      const hooks =
        restArgs.length > 0
          ? restArgs.filter((f) => !f.endsWith(".spec.ts"))
          : discoverHookFiles(process.cwd());
      if (specs.length === 0 && hooks.length === 0) {
        console.log("No .spec.ts or .vigiles/hooks/ hook files found.");
        console.log("Run `vigiles init` to create one.");
        process.exit(0);
      }
      let valid = true;
      if (specs.length > 0)
        valid =
          (await compile(specs, config, excludes, { harnessFlag })) && valid;
      valid = (await installHooks(hooks, harnessFlag, config.harness)) && valid;
      // Keep an existing whole-harness registry in sync (cheap, opt-in) so the
      // user never hand-runs `generate-harness`. Skipped when no harness.gen.ts.
      if (specs.length > 0)
        valid = (await refreshHarnessGenIfPresent(harnessFlag)) && valid;
      console.log("");
      if (valid) {
        console.log("Compilation complete.");
      } else {
        console.log("Compilation complete with errors.");
        process.exit(1);
      }
      break;
    }

    case "eject":
      // Inverse of compile: un-manage a compiled file → plain hand-owned
      // markdown (the "always ejectable" escape hatch).
      eject(args.slice(1));
      break;

    case "lint": {
      // lint = verify references + discover + guidance count
      const flags = args.slice(1).filter((a) => a.startsWith("--"));
      const report = await runLint(restArgs, flags, excludes, config);
      annotateLintForGitHub(report, flags);
      const exitCode = lintExitCode(report);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      break;
    }

    case "test":
      await handleRunScripts("test", args, restArgs, excludes);
      break;

    case "eval":
      await handleRunScripts("eval", args, restArgs, excludes);
      break;

    case "audit": {
      // The Lighthouse run: a plain `audit` is a deterministic READ — rings, each
      // finding's fix inline, HTML/JSON report — safe + identical on every OS,
      // nothing executes. Like Lighthouse it's a LOCAL report, NOT a CI step (CI
      // uses `vigiles lint`). The executing checks (safety battery + live MCP +
      // skill firing) run only on consent: at a TTY `audit` asks once (remembered
      // in `.vigilesrc.json`), headless it stays a read + a one-line nudge. There
      // is NO execution flag — automation tests the harness via the vigiles testing
      // API + skills, not the report verb. See the `audit-side-effect-free` rule.
      const dirs =
        restArgs.length > 0
          ? restArgs.map((d) => noteExplicitOverride(excludes, d, "auditing"))
          : ["."];
      const json = args.includes("--json");
      // A single dir that's a marketplace (e.g. wshobson/agents' 80+ plugins
      // under one marketplace.json) expands into its members and ranks them.
      const market =
        dirs.length === 1 ? inspectMarketplace(resolve(dirs[0])) : null;
      // A marketplace whose members are all EXTERNAL expands to nothing, and the
      // fallback below already says what to do about that: the target is the
      // directory itself.
      //
      // 🔴 THERE USED TO BE A BRANCH HERE that printed "nothing to scan" and
      // returned at exit 0 whenever the expansion came back empty — before
      // looking at the directory at all. A `marketplace.json` is a statement
      // about OTHER directories; it says nothing about this one, and a directory
      // is free to be a plugin AND ship a marketplace listing external members.
      // Measured 2026-08-18 on `nyldn/claude-octopus` @ `57cfb9b0` (3,979 stars):
      // the branch suppressed the whole audit — 59 skills, 50 subagents — because
      // `.claude-plugin/` held a `marketplace.json` NEXT TO the `plugin.json`
      // naming that same directory. It now grades D (60/100), and the check that
      // this branch is really gone is that deleting the `marketplace.json` gives
      // the byte-identical report: the file no longer changes the outcome at all.
      //
      // (An earlier journal recorded that delete-one-file experiment as B (85/100).
      // That was measured before `agents/` was read recursively, when all 50 of
      // this plugin's subagents lived in subdirectories and none were visible. Both
      // numbers are real; they differ by the other fix, not by this one.)
      //
      // Exit 0 was the other half: a repo that was never scanned exited
      // byte-identically to a repo that was scanned and found clean, so an
      // automated leaderboard dropped it silently and CI went green. A genuinely
      // curated marketplace now reaches the `score.empty` branch below, which
      // carries `market` into its explanation and exits 2 — this repo's own rule
      // that 1 is "I measured, and it's bad" and 2 is "I could not do what you
      // asked". Nothing was measured here, so it is a 2.
      // `--single` pins the SINGLE-harness reading of the given directory, whatever
      // is nested inside it. Without it, a repo holding many bundles auto-switches
      // to the leaderboard and there is no way back — so the full ring report for
      // the ROOT was simply unreachable, and the reported workaround was a CI job
      // looping `audit` over 29 directories. The mode branch already existed; this
      // only stops it being decided for you.
      const single = args.includes("--single");
      // `--single` names ONE harness, so more than one explicit directory is a
      // contradiction. Refuse it (exit 2 = "could not do what you asked") rather
      // than auditing the first and dropping the rest — silently honouring half
      // an argument list is the same defect class as the ignored `--out` above.
      if (single && dirs.length > 1) {
        console.error(
          `--single audits ONE directory as one harness, but ${String(dirs.length)} were given. ` +
            `Drop --single for a leaderboard, or pass a single directory.`,
        );
        process.exit(2);
      }
      const targets =
        !single && market && market.onDisk.length > 0
          ? [...market.onDisk]
          : dirs;
      if (!single && targets.length > 1) {
        // Multiple targets → rank them (the leaderboard engine). `--md` emits the
        // publishable Markdown table (a README / gist / the leaderboard site).
        //
        // `--out` writes nothing here: the per-bundle HTML/JSON report is built
        // in the single-target branch below, and this one only prints a table.
        // SAY SO. A silent no-op is how a CI job ships an empty artifact and
        // stays green — which is exactly how this was found, and the same
        // never-fail-silently shape as the rest of this file.
        if (args.some((a) => a.startsWith("--out=")) && !json)
          console.log(
            `⚠ --out is ignored here: ${String(targets.length)} bundles → leaderboard mode, ` +
              `which produces no per-bundle report. Run audit per directory to write one.`,
          );
        const scores = rankPlugins(targets);
        const text = args.includes("--md")
          ? formatLeaderboardMarkdown(scores)
          : formatLeaderboard(scores);
        console.log(
          json
            ? JSON.stringify(
                buildLeaderboardReport(scores, {
                  vigilesVersion: getVersion(),
                  dir: resolve(dirs[0]),
                }),
                null,
                2,
              )
            : text,
        );
      } else {
        const root = resolve(targets[0]);
        const harnessFlag = harnessFlagFrom(args);
        // Honor the SAME precedence as lint/compile (dogfood A): --harness= flag,
        // else the `.vigilesrc.json` `harness` key, else auto-detect. Previously
        // audit auto-detected and IGNORED config.harness, so a repo that
        // config-declares `"harness": "codex"` but carries a CLAUDE.md was still
        // scanned as Claude Code. `resolveHarnessSelection` also carries the
        // ambiguity/multi-target `notice` so the warning stays consistent.
        const selection = resolveHarnessSelection({
          root,
          flag: harnessFlag,
          configHarness: normalizeHarnessList(config.harness),
        });
        const adapter = selection.adapter;
        const report = scanPlugin(targets[0], adapter.layout, adapter.dialect, {
          sharedDirs: config.sharedDirs,
          sharedDirsRoot: sharedDirsRootFor(targets[0]),
        });
        if (!json) {
          console.log(`Detected harness: ${adapter.name}`);
          if (selection.kind === "notice") {
            console.log(`⚠ ${selection.notice}`);
          }
          // Freshness: warn if our hand-maintained CC catalog drifted from the
          // user's INSTALLED claude-code (read-local, best-effort, never throws).
          if (adapter.name === "claude-code") {
            const drift = formatDialectDrift(checkDialectDrift());
            if (drift) console.log(drift);
            // Adoption: this repo depends on vigiles, but can the agent SEE the
            // skills it ships? `npm install` drops them in node_modules, which
            // Claude Code never scans — the plugin install is what wires them,
            // and until it runs the whole teaching surface is silently absent.
            // Advisory only (machine state, not repo state) — never scored.
            const reach = formatSkillReachability(checkSkillReachability(root));
            if (reach) console.log(reach);
          }
          console.log("");
        }
        // The versioned AuditReport is the product boundary — the same JSON the
        // HTML renders, `--json` emits, and (later) a hosted dashboard ingests.
        // Built ONCE; the rings + fix list are read off it. Pure deterministic —
        // nothing executes to produce it.
        // Surfaces that exist but aren't spec-managed yet — the same notion
        // `init` adopts (layout-driven instruction file + skill/subagent sweep).
        // Surfaced in the AuditReport (the report's "Create spec" command-emit
        // buttons read it) and the terminal nudge below.
        const adoptableSurfaces = discoverAdoptableForAudit(
          root,
          adapter.layout.instructionFile,
        );
        // Read the local flight recorder ONCE — feeds both the JSON report
        // (structured summary, the product boundary) and the terminal render.
        const ledgerRecords = readObservations(root);
        // What the EXECUTING checks would have to work with. Computed BEFORE the
        // report is built (it's a pure read off the scan) because the report's
        // `Evaluated` ring needs to know whether this run will ever ask the
        // skill-firing question — see `firingMeasured` below.
        const isForeign = root !== process.cwd();
        const surfaces: ExecutableSurfaces = {
          hasMcp: report.mcp && !isForeign,
          triggerableSkills: report.skills.filter(
            (s) => s.hasDescription && !s.userInvoked,
          ).length,
          gateSkills: detectGateSkills(report.skills).length,
          adoptableRefs:
            adapter.name === "claude-code" &&
            existsSync(resolve(root, adapter.layout.instructionFile)),
        };
        // `decideExecute` is PURE and prompt-free, so the read-vs-run outcome can
        // be known before anything prints. Only a settled `run` (a remembered yes)
        // means the firing question actually gets asked on this run; a `skip`
        // (headless / `--json` / a remembered no) means it never does, and an
        // `ask` isn't resolved until after the read has printed. Anything but a
        // certain `run` → the `Evaluated` ring reports "not measured" rather than
        // scoring a 0 it never earned.
        const execDecision = decideExecute({
          hasExecutable:
            surfaces.hasMcp ||
            surfaces.triggerableSkills > 0 ||
            surfaces.adoptableRefs,
          isTTY: process.stdout.isTTY && process.stdin.isTTY,
          json,
          noInteractive:
            args.includes("--no-interactive") || args.includes("--yes"),
          remembered: config.audit?.measure,
        });
        const firingMeasured =
          execDecision.kind === "run" &&
          surfaces.triggerableSkills > 0 &&
          (adapter.name === "codex" || hasModelAccess(process.env));
        // The report scaffold WITHOUT the rule map — the map's catalog
        // enrichment (enabled-state / "documented but OFF") enumerates the repo's
        // linter, which is gated on the SAME audit.measure consent as the
        // executing checks. So the map is routed AFTER consent (resolved below)
        // and folded into the report there, so a first-time "yes" enriches THIS
        // run — not the next one.
        const auditReportBase = buildAuditReport(report, {
          harness: adapter.name,
          vigilesVersion: getVersion(),
          adoptableSurfaces,
          observations: summarizeObservations(ledgerRecords),
          rulesInventory: computeRuleInventory(
            root,
            adapter.layout.instructionFile,
            excludes,
          ),
          firingMeasured,
        });
        const sc = auditReportBase.score;
        // NOTHING TO AUDIT is not a bad grade — and it used to be reported as
        // one. `score.empty` means the target has no instruction file AND no
        // surface: there was never anything to measure. That printed as rings of
        // `F (0)` at exit 0, which is BYTE-INDISTINGUISHABLE from a genuine audit
        // of a harness that scores badly. The way it actually bit: `vigiles audit
        // --json /some/path` — `--json` takes no value, so the path fell through
        // to the positional scan dir, the audit ran over a directory with no
        // harness in it, and reported `skills: 0`, grade F, exit 0. A confident
        // measurement of the wrong object, silently. The flag check added
        // alongside this does NOT catch that one — `--json` is a real flag and
        // `audit --json ./dir` is legitimate — so THIS branch is what makes it
        // visible, and it covers every other way of pointing at the wrong place
        // too (a moved repo, a bad `$PWD`, a path that doesn't exist).
        //
        // Exit 2, matching the unknown-flag decision above: 1 is "I measured, and
        // it's bad"; 2 is "I could not do what you asked". A script that greps for
        // a grade needs those to differ, and a grade is exactly what this run does
        // NOT have. `--json` still emits the report (it self-describes with
        // `score.empty: true`), so a machine consumer keeps its contract; the
        // human-readable explanation goes to stderr either way.
        if (sc.empty) {
          // A curated marketplace lands here now that the early return is gone:
          // it really has nothing of its own to audit, which is what this branch
          // is for. `--json` keeps emitting the `kind:"marketplace"` envelope for
          // exactly that case, so the discriminant still describes what it always
          // described — a marketplace with no on-disk members — and no longer
          // doubles as "a directory we declined to look at".
          if (json)
            console.log(
              JSON.stringify(
                market && market.onDisk.length === 0 && market.total > 0
                  ? buildMarketplaceReport(market, {
                      vigilesVersion: getVersion(),
                      dir: root,
                    })
                  : auditReportBase,
                null,
                2,
              ),
            );
          console.error(formatNothingToAudit(root, adapter.name, market));
          process.exit(2);
        }
        const plan = optimize(report);
        // The deterministic READ leads: rings + report + fixes + nudges print
        // BEFORE the consent prompt, so a plain `audit` shows its findings first.
        // (JSON stays silent until the single blob below, after consent.)
        if (!json) {
          // The Lighthouse rings: per-category 0–100 + the weighted overall,
          // shown before the detailed report so the headline signal leads.
          console.log(formatAuditScore(sc));
          console.log("");
          console.log(formatScanReport(report));
          // Fold each finding's fix inline (replaces the former --fix-plan/--explain
          // flags): the deterministic, free recommendation list under the report.
          const fixes = formatRecommendations(plan);
          if (fixes) console.log("\n" + fixes);
          // Adoption nudge: surfaces that exist but aren't spec-managed yet, with
          // the create-all + per-surface `init` commands (the JSON carries the
          // data in `adoptable` instead — the terminal stays human-readable).
          // Suppressed by `nudge: "dismissed"` — the remembered-decline half of
          // the non-evil adoption contract (a gate-only team isn't nagged).
          const adoptNudge =
            config.nudge === "dismissed"
              ? ""
              : formatAdoptableNudge(adoptableSurfaces);
          if (adoptNudge) console.log("\n" + adoptNudge);
          // A small behavioral nudge — the deterministic read can't tell whether
          // skills actually FIRE; point at the interactive measure + the API.
          const fireNudge = formatTriggerNudge(
            report.skills.filter((s) => s.hasDescription && !s.userInvoked)
              .length,
          );
          if (fireNudge) console.log("\n" + fireNudge);
        }
        // ONE read-vs-run decision for the EXECUTING checks (live MCP + skill
        // firing) AND the rule map's catalog enrichment (enumerating the repo's
        // linter also executes it). A plain `audit` is a deterministic READ;
        // these run only on consent — ASK once at a TTY (remembered); headless
        // stays a read + a nudge (no execution flag — automation uses the
        // vigiles testing API). Resolved AFTER the report (so the read leads) but
        // BEFORE the rule map is routed, so a first-time "yes" enriches THIS run.
        // (The safety battery is NOT here — it needs cross-platform confinement
        // that isn't shipped, so it lives in the vigiles testing API.)
        // `surfaces` + `execDecision` were resolved above (the ring needed them);
        // this only turns an `ask` into a prompt and remembers the answer.
        const { execute, note: execNote } = await resolveExecution(
          surfaces,
          execDecision,
          json,
          adapter.name,
        );
        // Consent is now settled (and remembered via .vigilesrc.json, which
        // computeRuleRouting re-reads) — route the prose rules, enumerating the
        // live catalog when consented + own-repo. Feeds the JSON report, the
        // written artifacts, and the terminal rule-map summary.
        const ruleRouting = computeRuleRouting(
          root,
          adapter.layout.instructionFile,
          excludes,
        );
        const auditReport: AuditReport = ruleRouting
          ? { ...auditReportBase, ruleRouting }
          : auditReportBase;
        if (json) {
          console.log(JSON.stringify(auditReport, null, 2));
        } else {
          // The rule map — what audit detected in your instruction file and how
          // each rule could be enforced (confident / possible / skipped tiers).
          const ruleMap = formatRuleMapSummary(ruleRouting);
          if (ruleMap) console.log("\n" + ruleMap);
          // The flight recorder: a compact summary of what the harness actually
          // DID in real sessions (hook/agent decisions), read off the local
          // agent-readable ledger. Empty (skipped) until something is recorded.
          const ledgerSummary = formatLedgerSummary(
            ledgerRecords,
            countLocks(resolve(root, DEFAULT_LOCK_DIR)),
          );
          if (ledgerSummary) console.log("\n" + ledgerSummary);
        }
        // LIVE MCP tool resolution STARTS each declared MCP server — a server is
        // exactly what connects to a real Postgres / authenticates a real API on
        // boot. So it runs only under consent (`execute`) AND own-repo (never
        // spawn a stranger's server).
        if (execute && surfaces.hasMcp) {
          const mcpErrs = await verifyLiveMcpTools(
            report,
            adapter.layout,
            adapter.dialect,
          );
          console.log(
            json
              ? JSON.stringify({ mcpContractTools: mcpErrs }, null, 2)
              : "\n" + formatMcpContractReport(mcpErrs),
          );
        }
        const capBase = flagValue(args, "--capability-diff");
        if (capBase) {
          // Did this version WIDEN the agent's blast radius vs <before>? Diffs the
          // two whole-harness capability lattices (moat #2). Informational by
          // default; `--fail-on-widen` exits non-zero (the opt-in CI gate).
          const beforeReport = scanPlugin(
            resolve(capBase),
            adapter.layout,
            adapter.dialect,
          );
          const diff = diffCapabilities(
            capabilitiesOfReport(beforeReport, adapter.dialect),
            capabilitiesOfReport(report, adapter.dialect),
          );
          // Feed the flight recorder: the blast-radius change (moat #2) as a record.
          // Write to the AUDITED root's ledger (not the caller's cwd) — the same
          // `root` the audit reads back via `readObservations(root)`, so a
          // `vigiles audit ./after --capability-diff=./before` from a parent dir
          // records into ./after/.vigiles/, not the parent workspace.
          appendObservation(
            {
              kind: "capability-diff",
              added: [
                ...diff.addedSideEffecting,
                ...diff.addedUnknown,
                ...diff.addedReadOnly,
              ],
              removed: [...diff.removed],
              widened: diff.widened,
            },
            root,
          );
          console.log(
            json
              ? JSON.stringify({ capabilityDiff: diff }, null, 2)
              : "\n" + formatCapabilityDiff(diff),
          );
          if (args.includes("--fail-on-widen") && diff.widened)
            process.exitCode = 1;
        }
        // The model trigger tier — "do your skills actually FIRE?" — runs as part
        // of the same consent (`execute`), and only when a model is reachable;
        // otherwise it's a one-line note (never a hang).
        if (execute && surfaces.triggerableSkills > 0) {
          // Model-access detection is per-harness: `hasModelAccess` reads Claude
          // env (claude CLI / ANTHROPIC_API_KEY). A Codex repo authenticates the
          // codex CLI instead, so we DON'T gate it on a Claude var — the Codex
          // probe checks `codexDriver.available()` internally and self-reports
          // unavailable. (harness-parity: never block Codex behind a CC check.)
          const modelReachable =
            adapter.name === "codex" || hasModelAccess(process.env);
          if (modelReachable) {
            await runTriggerTier(targets[0], report, adapter, args);
          } else if (!json) {
            console.log(
              "\nℹ skill firing not measured — no model access (authenticate the `claude` CLI or set ANTHROPIC_API_KEY).",
            );
          }
        }
        // The adoption preview — "what would vigiles catch in YOUR repo?" The model
        // DRAFTS the verifiable refs in the instruction file; the cross-ref engine
        // VERIFIES each, so "M broken right now" is trustworthy though the extraction
        // is probabilistic. Same consent as the trigger tier (`surfaces.adoptableRefs`
        // makes a bare instruction-file repo consent-eligible — the prime adoption
        // target). v1: instruction-file only; drafting drives the `claude` CLI, so
        // `adoptableRefs` is Claude Code only (the Codex deferral note is printed
        // below as a LOUD harness-parity deferral, never a silent CC-only path).
        let adoptabilityResult: AdoptabilityResult | undefined;
        if (execute && surfaces.adoptableRefs) {
          if (hasModelAccess(process.env)) {
            const instrPath = resolve(root, adapter.layout.instructionFile);
            adoptabilityResult = await runAdoptabilityTier({
              instructionContent: readFileSync(instrPath, "utf-8"),
              basePath: root,
            });
            if (!json)
              console.log(
                "\n" +
                  formatAdoptability(
                    adoptabilityResult,
                    adapter.layout.instructionFile,
                  ),
              );
          } else if (!json && surfaces.triggerableSkills === 0) {
            // Only when the trigger tier didn't already print the same note.
            console.log(
              "\nℹ adoptability not measured — no model access (authenticate the `claude` CLI or set ANTHROPIC_API_KEY).",
            );
          }
        }
        // LOUD harness-parity deferral: adoptability drafting drives the `claude`
        // CLI, so a Codex repo with an instruction file is told it's a follow-up,
        // never silently skipped (research/adoption-gateway-preview.md, increment 4).
        if (
          !json &&
          adapter.name === "codex" &&
          existsSync(resolve(root, adapter.layout.instructionFile))
        ) {
          console.log(
            "\nℹ adoptability preview (what vigiles would catch in your repo) is Claude Code only for now — Codex support is a follow-up.",
          );
        }
        // The loud read-vs-run nudge for a headless / remembered-no skip — printed
        // AFTER the report so the deterministic read leads.
        if (execNote) console.log(execNote);
        // The final report folds in the adoptability preview (when the model-gated
        // tier ran) so the written HTML/JSON carry it; a deterministic read omits it.
        const finalReport: AuditReport = adoptabilityResult
          ? { ...auditReport, adoptability: adoptabilityResult }
          : auditReport;
        // Where the report artifacts land: cwd by default, or `--out=<dir>` (for
        // CI upload / a custom location). The dir is created if missing.
        const outFlag = args.find((a) => a.startsWith("--out="));
        const outDir = outFlag
          ? resolve(process.cwd(), outFlag.slice("--out=".length))
          : process.cwd();
        const openReport = !args.includes("--no-open");
        const wroteReports: string[] = [];
        // The versioned JSON artifact — the upload/CI boundary (a hosted dashboard
        // ingests this). Written by default in the human path; --no-json to skip.
        if (!json && !args.includes("--no-json")) {
          writeAuditJson(finalReport, outDir);
          wroteReports.push("vigiles-report.json");
        }
        // The HTML report has two deliveries. STATIC (default): write the
        // shareable file whose buttons copy the `init` command. LIVE (`--serve`,
        // or a TTY "yes"): start a loopback server whose buttons run `init` for
        // you. The gate keeps the default a terminating, headless-safe read and
        // restricts the write-server to your own repo (decideServeGate).
        const serveGate = decideServeGate({
          serveFlag: args.includes("--serve"),
          noServeFlag: args.includes("--no-serve"),
          json,
          isTTY: process.stdout.isTTY && process.stdin.isTTY,
          ownRepo: !isForeign,
          adoptableCount: finalReport.adoptable?.surfaces.length ?? 0,
        });
        let serveLive = serveGate === "serve";
        if (serveGate === "ask") {
          const ans = (
            await askOnce(
              "\nOpen the live report to create specs with one click? [y/N] ",
            )
          ).toLowerCase();
          serveLive = ans === "y" || ans === "yes";
        }
        const errMsg = (e: unknown): string =>
          e instanceof Error ? e.message : String(e);
        if (serveLive) {
          await runAuditServe(finalReport, finalReport.adoptable, errMsg);
        } else if (!json && !args.includes("--no-html")) {
          writeAuditHtml(finalReport, outDir, openReport);
          wroteReports.push("vigiles-report.html");
        }
        // Keep the generated artifacts out of git so a zero-config `audit` leaves
        // a clean `git status` (works without `init`). Entries are relative to the
        // git root (cwd); a custom --out dir is ignored by its relative path.
        // .gitignore patterns are POSIX-separated, so normalize away Windows
        // backslashes (`relative()` yields `reports\x` on Windows, which would
        // never match `reports/x`).
        if (wroteReports.length > 0) {
          // Only paths that PROVABLY sit inside the repo can be minted, so an
          // `--out` pointing elsewhere yields nothing to write rather than a
          // dead `../../..` entry.
          const rel = wroteReports
            .map((f) =>
              repoRelative(process.cwd(), resolve(outDir, f), {
                relative,
                resolve,
                isAbsolute,
                sep: pathSep,
              }),
            )
            .filter((p): p is RepoRelativePath => p !== null);
          ensureReportGitignored(process.cwd(), rel);
        }
        // A shareable deep-link for a public GitHub repo: the in-browser demo
        // re-runs the audit LIVE for whoever opens it, so a local result is
        // shareable with zero upload/backend (the "can't share from localhost"
        // gap). Offline + best-effort — read the audited repo's origin remote;
        // print nothing when it isn't a GitHub repo (self-hosted / no remote /
        // not a git tree). A suggestion only, never an auto-share, honest about
        // the public requirement (the non-evil sharing contract).
        if (!json) {
          const share = shareLinkForRemote(readOriginRemote(root) ?? "");
          if (share) {
            console.log(`\nShare this grade → ${share}`);
            console.log(
              "  public repos — opens a live re-run for anyone, no upload",
            );
          }
        }
      }
      break;
    }

    // --- Plumbing ---

    case "generate":
      await handleGenerate(restArgs, args);
      break;

    // Hidden umbrella for runtime entrypoints emitted into hooks configs — never
    // typed by a human. See handleHookRuntime / the cohesive-cli-surface rule.
    case "hook-runtime":
      await handleHookRuntime(restArgs[0], restArgs.slice(1));
      break;

    default:
      printUsage(command);
      break;
  }
}
