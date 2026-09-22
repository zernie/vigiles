/**
 * Dialect freshness / drift detection against the INSTALLED Claude Code.
 *
 * Claude Code is a black box (only `settings.json` has an official schema), so
 * `claudeCodeDialect` is hand-maintained — see the licensing decision in
 * research/code-adapter-architecture.md. But the installed `@anthropic-ai/claude-code`
 * package ships a semi-machine source: `sdk-tools.d.ts` (the tool-input type set). We
 * READ THE USER'S LOCAL INSTALL (ToS-clean — no copying, no redistribution; same
 * posture as driving the user's own `claude` CLI) to ALARM when CC's surface drifts
 * from our catalog. We never ship or vendor their types — only diff against them at
 * test/runtime.
 *
 * Why not `import type` from the SDK? `@anthropic-ai/claude-code` and
 * `@anthropic-ai/claude-agent-sdk` DO ship a clean `ToolInputSchemas` union (on a
 * types-only `./sdk-tools` subpath), but both are "© Anthropic PBC. All rights
 * reserved." — proprietary. vigiles is MIT and multi-harness, so taking a hard dep
 * and re-exporting their types into our published `.d.ts` would (a) bake a
 * proprietary package into an MIT dep tree, (b) couple the harness-agnostic core to
 * a Claude-Code-only package, and (c) not even give us `builtinAgentTools` (the SDK
 * union is input-SCHEMA names like `FileReadInput`/`CronCreateInput` — a superset in
 * a different vocabulary than the subagent `tools:` catalog). Reading the local file
 * + a hand-authored list of bare identifiers (facts) is the deliberate ToS-clean
 * design; this drift alarm is what keeps the hand-list honest.
 *
 * NOTE (CC ≥ ~2.1.18x): CC switched to a NATIVE-BINARY distribution — the npm
 * package ships `bin/claude.exe` (from a platform `optionalDependencies` package),
 * NOT a readable `cli.js` JS bundle. So the old "grep hook-event string literals out
 * of cli.js" check has no bundle to read and degrades to a LOUD SKIP (see
 * `findClaudeCodeBundle`); `sdk-tools.d.ts` is still shipped, so the tool-type drift
 * alarm keeps working. But the native binary means a box can carry a STALE leftover
 * `@anthropic-ai/claude-code` JS package (readable `sdk-tools.d.ts`, months old) in a
 * global `node_modules` while the real, newer CC runs from the native binary — so
 * `findClaudeCodePackage` can locate a package that ISN'T what's running. The runtime
 * alarm (`checkDialectDrift`/`formatDialectDrift`) reconciles the located package
 * version against the on-PATH `claude --version` and SUPPRESSES the warning on a
 * mismatch (the located types don't describe the running CC — crying wolf otherwise).
 *
 * Pure parsers (testable with fixtures) + a local-install locator. TWO consumers:
 * the gated CI test in `dialect-drift.test.ts` (fails loud on tool/event drift), and
 * `vigiles audit` at runtime via `checkDialectDrift`/`formatDialectDrift` (a best-effort,
 * read-local freshness WARN when the installed CC's tool surface drifts from ours).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * The Claude Code version `ACKNOWLEDGED_TOOL_INPUT_TYPES` + the dialect were last
 * validated against. SINGLE SOURCE OF TRUTH for the pin: CI installs
 * `@anthropic-ai/claude-code@<this>` (grepped from this line) in every job that
 * drives the real binary, so the dialect-drift alarm fires only on a DELIBERATE
 * bump — not on every unpinned CC release landing on an unrelated PR — and the
 * real-`claude` harness/eval tests stay reproducible. Bump this together with
 * `ACKNOWLEDGED_TOOL_INPUT_TYPES` (the gated test cross-checks them).
 */
export const VALIDATED_CC_VERSION = "2.1.187";

/**
 * The `<X>Input` interface names we've ACKNOWLEDGED from `sdk-tools.d.ts` (Claude
 * Code 2.1.187). The drift test fails when the installed set differs — a loud nudge
 * to re-check `claudeCodeDialect` (and update this set) when CC adds/removes a tool.
 * NOT a redistribution of their file: a list of bare identifiers (facts), authored here.
 *
 * 2.1.187 added the agent-PLATFORM surface (cron/scheduling/worktrees/web-app):
 * Artifact, Cron{Create,Delete,List}, Enter/ExitWorktree, EnterPlanMode, Monitor,
 * Projects, PushNotification, REPL, ReadMcpResourceDir, RemoteTrigger,
 * ScheduleWakeup, ShowOnboardingRolePicker, Task{Create,Get,List,Update}, Workflow;
 * and removed Config. These are HOST/platform tools, NOT subagent-grantable, so
 * `claudeCodeDialect.builtinAgentTools` (the `tools:` frontmatter catalog) is
 * intentionally unchanged — they're acknowledged here as facts, nothing more.
 */
export const ACKNOWLEDGED_TOOL_INPUT_TYPES: readonly string[] = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "FileEdit",
  "FileRead",
  "FileWrite",
  "Glob",
  "Grep",
  "ListMcpResources",
  "Mcp",
  "Monitor",
  "NotebookEdit",
  "Projects",
  "PushNotification",
  "REPL",
  "ReadMcpResource",
  "ReadMcpResourceDir",
  "RemoteTrigger",
  "ScheduleWakeup",
  "ShowOnboardingRolePicker",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
];

/** Parse `export interface <X>Input {` names from sdk-tools.d.ts → sorted [<X>]. Pure. */
export function parseToolInputTypes(dts: string): string[] {
  const out = new Set<string>();
  for (const m of dts.matchAll(/export\s+interface\s+(\w+)Input\b/g))
    out.add(m[1]);
  return [...out].sort();
}

/**
 * Locate a READABLE JavaScript bundle inside the installed CC package, or null.
 * Older CC shipped `cli.js` — a readable JS bundle whose hook-event names appear as
 * string literals, greppable by `eventsMissingFromBundle`. CC ≥ ~2.1.18x switched to
 * a NATIVE-BINARY distribution (`bin/claude.exe` copied from a platform
 * `optionalDependencies` package) with NO readable JS bundle, so there is nothing to
 * text-scan. Returns the bundle path when present, else null — callers then SKIP the
 * event-drift check loudly rather than crash on a missing `cli.js`.
 */
export function findClaudeCodeBundle(pkg: string): string | null {
  const cli = join(pkg, "cli.js");
  return existsSync(cli) ? cli : null;
}

/** Which of `events` do NOT appear as a whole-word literal in the bundle. Pure. */
export function eventsMissingFromBundle(
  bundle: string,
  events: readonly string[],
): string[] {
  return events.filter((e) => !new RegExp(`\\b${e}\\b`).test(bundle));
}

/**
 * Locate the user's installed `@anthropic-ai/claude-code` package dir, or null.
 * Tries the global npm root, then the `claude` binary's real path. Read-only —
 * we only read files the user already installed under their own CC license.
 */
export function findClaudeCodePackage(): string | null {
  const tryDir = (dir: string): string | null =>
    existsSync(join(dir, "sdk-tools.d.ts")) ? dir : null;

  const candidates: (() => string | null)[] = [
    () => {
      const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
      return tryDir(join(root, "@anthropic-ai", "claude-code"));
    },
    () => {
      const bin = execSync('readlink -f "$(command -v claude)"', {
        encoding: "utf-8",
      }).trim();
      const marker = "/@anthropic-ai/claude-code/";
      const i = bin.indexOf(marker);
      return i >= 0 ? tryDir(bin.slice(0, i + marker.length - 1)) : null;
    },
  ];

  for (const probe of candidates) {
    try {
      const hit = probe();
      if (hit) return hit;
    } catch {
      /* probe unavailable (no npm / no claude) — try the next */
    }
  }
  return null;
}

/**
 * Extract the semver core from a `claude --version` line
 * (e.g. `"2.1.211 (Claude Code)"` → `"2.1.211"`). Pure; null when absent.
 */
export function parseClaudeVersion(raw: string): string | null {
  const m = raw.match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : null;
}

/**
 * The version of the `claude` binary actually on PATH — which can DIFFER from the
 * package {@link findClaudeCodePackage} locates. In the native-binary era CC ships
 * as a platform binary with no readable `sdk-tools.d.ts`, so a box can carry a
 * stale leftover `@anthropic-ai/claude-code` in a global `node_modules` (readable,
 * but months old and NOT what's running) beside the real, newer CC. Reconciling
 * against this stops the drift alarm crying wolf on that leftover. Real IO; null
 * when `claude` isn't runnable.
 */
export function onPathClaudeVersion(): string | null {
  try {
    return parseClaudeVersion(
      execSync("claude --version", { encoding: "utf-8" }),
    );
  } catch {
    return null;
  }
}

/** A runtime drift report: how the INSTALLED CC's tool surface compares to ours. */
export interface DialectDriftReport {
  /** Version of the located `@anthropic-ai/claude-code` package (its types we read). */
  readonly installedVersion: string;
  /** Version of the `claude` binary on PATH, or null — the actually-running CC. */
  readonly runningVersion: string | null;
  readonly validatedVersion: string;
  /** Tool-input types present in the install but not in ACKNOWLEDGED (CC added). */
  readonly newToolTypes: string[];
  /** Acknowledged types absent from the install (CC removed/renamed). */
  readonly removedToolTypes: string[];
}

/**
 * Best-effort, read-local drift check for `scan` (and other runtime callers). Reads
 * only the small `sdk-tools.d.ts` (fast — no `cli.js` bundle scan; events are the
 * CI test's job). Returns null when CC isn't installed or anything is unreadable —
 * NEVER throws, so it can't break the command. ToS-clean: reads the user's own
 * install, ships nothing.
 */
export function checkDialectDrift(): DialectDriftReport | null {
  const pkg = findClaudeCodePackage();
  if (!pkg) return null;
  try {
    const installed = new Set(
      parseToolInputTypes(readFileSync(join(pkg, "sdk-tools.d.ts"), "utf-8")),
    );
    const ack = new Set(ACKNOWLEDGED_TOOL_INPUT_TYPES);
    let installedVersion = "unknown";
    try {
      installedVersion =
        (
          JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8")) as {
            version?: string;
          }
        ).version ?? "unknown";
    } catch {
      /* version optional */
    }
    return {
      installedVersion,
      runningVersion: onPathClaudeVersion(),
      validatedVersion: VALIDATED_CC_VERSION,
      newToolTypes: [...installed].filter((t) => !ack.has(t)).sort(),
      removedToolTypes: [...ack].filter((t) => !installed.has(t)).sort(),
    };
  } catch {
    return null;
  }
}

/** A one-line freshness warning if the dialect drifted from the install, else null. */
export function formatDialectDrift(
  r: DialectDriftReport | null,
): string | null {
  if (!r) return null;
  // The located `sdk-tools.d.ts` belongs to a DIFFERENT install than the CC
  // actually running (a stale leftover npm package beside a newer native binary),
  // so its tool set says nothing about the CC you're on — don't cry wolf. The
  // pinned CI drift TEST is where real drift is gated.
  if (r.runningVersion && r.runningVersion !== r.installedVersion) return null;
  if (r.newToolTypes.length === 0 && r.removedToolTypes.length === 0)
    return null;
  const parts: string[] = [];
  if (r.newToolTypes.length > 0)
    parts.push(`CC added tool type(s): ${r.newToolTypes.join(", ")}`);
  if (r.removedToolTypes.length > 0)
    parts.push(`removed: ${r.removedToolTypes.join(", ")}`);
  return (
    `⚠ dialect freshness: vigiles's tool catalog was validated against ` +
    `claude-code ${r.validatedVersion}, you have ${r.installedVersion} — ` +
    `${parts.join("; ")}. Tool/contract checks may be stale; a vigiles update may be needed.`
  );
}
