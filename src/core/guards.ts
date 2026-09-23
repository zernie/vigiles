/**
 * EXPERIMENTAL prototype — typed, safe-by-construction harness GUARDS.
 *
 * Dogfood finding (real OSS hooks: our pre-edit.sh, superpowers/OMC session-start,
 * OMC keyword-detector): a "hook" today is an arbitrary shell command in
 * settings.json — which is BOTH the enforcement vehicle AND the RCE footgun
 * (CVE-2025-59536: a malicious repo's hook runs before the trust dialog). Arbitrary
 * hook safety is UNDECIDABLE (Rice). So this prototype inverts it: you don't WRITE a
 * hook, you DECLARE a guard from a closed, audited vocabulary, and vigiles GENERATES
 * the hooks block — whose command is vigiles's OWN gate (`vigiles hook-runtime guard`), never
 * user shell. Safe-by-construction, not safe-by-analysis.
 *
 * Covers the real PreToolUse patterns + the new ORDER axis:
 *   - block:        deny a tool call matching args (reproduces pre-edit.sh's intent)
 *   - requireBefore: ORDER — deny a tool call until a prerequisite call has fired
 *                    (`terraform destroy` only after `terraform plan`; the moat)
 *   - confine:      deny a path-taking tool whose path escapes an allowlist (rm -rf /)
 *
 * EXPERIMENTAL — not on the public API. But the gate now RUNS end-to-end: the
 * `vigiles hook-runtime guard` CLI subcommand reads the live PreToolUse event, loads the
 * guard set (`.vigiles/guards.json`) + the session ledger (`.vigiles/guard-ledger.json`,
 * the reconstructed prior-call list `requireBefore` needs), runs `decideGuards`, and
 * blocks (exit 2 + reason) or records-the-allowed-call (so the next call sees it). The
 * pure `decideGuards` is the decision; `compileGuards` is the generator; the
 * serialization + ledger below are the IO seam the CLI calls.
 * See research/harness-protocol-flow-moat.md.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { matchesArgs, describeArgs, type ArgMatcher } from "../arg-match.js";
import {
  GUARD_LEDGER_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "../local-files.js";

/** A tool-call shape: a tool name + an optional argument matcher (the `when`). */
export interface ToolPattern {
  readonly tool: string;
  readonly when?: ArgMatcher;
}

export type Guard =
  | {
      readonly kind: "block";
      readonly target: ToolPattern;
      readonly reason: string;
    }
  | {
      readonly kind: "requireBefore";
      readonly target: ToolPattern;
      /** The prerequisite call that must have fired earlier this session. */
      readonly prerequisite: ToolPattern;
      readonly reason?: string;
    }
  | {
      readonly kind: "confine";
      readonly tools: readonly string[];
      /** Dot-path to the path argument (default `file_path`). */
      readonly pathKey?: string;
      /** Allowed path prefixes (a call outside ALL of them is denied). */
      readonly allow: readonly string[];
      readonly reason?: string;
    };

/** Ergonomic builders for the closed vocabulary. */
export const guard = {
  block: (target: ToolPattern, reason: string): Guard => ({
    kind: "block",
    target,
    reason,
  }),
  requireBefore: (
    target: ToolPattern,
    prerequisite: ToolPattern,
    reason?: string,
  ): Guard => ({ kind: "requireBefore", target, prerequisite, reason }),
  confine: (
    tools: readonly string[],
    allow: readonly string[],
    reason?: string,
    pathKey?: string,
  ): Guard => ({ kind: "confine", tools, allow, reason, pathKey }),
};

/** A tool call as seen at PreToolUse (and as recorded in the prior-call ledger). */
export interface ToolEvent {
  readonly tool: string;
  readonly input: unknown;
}

export interface GuardDecision {
  readonly allow: boolean;
  /** Set on a deny — the message surfaced to the agent. */
  readonly reason?: string;
}

const ALLOW: GuardDecision = { allow: true };
const deny = (reason: string): GuardDecision => ({ allow: false, reason });

const matchesPattern = (e: ToolEvent, p: ToolPattern): boolean =>
  e.tool === p.tool && (p.when === undefined || matchesArgs(e.input, p.when));

/** A path is confined if it sits under at least one allowed prefix. */
function isConfined(path: string, allow: readonly string[]): boolean {
  const norm = path.replace(/^\.\//, "");
  return allow.some((a) => {
    const base = a.replace(/\/?\*+$/, "").replace(/\/$/, "");
    return base === "" || norm === base || norm.startsWith(base + "/");
  });
}

/** Decide a single guard against the event (null = this guard doesn't apply). */
function decideOne(
  g: Guard,
  event: ToolEvent,
  prior: readonly ToolEvent[],
): GuardDecision | null {
  switch (g.kind) {
    case "block":
      return matchesPattern(event, g.target) ? deny(g.reason) : null;
    case "requireBefore":
      if (!matchesPattern(event, g.target)) return null;
      if (prior.some((c) => matchesPattern(c, g.prerequisite))) return null;
      return deny(
        g.reason ??
          `${describePattern(g.target)} requires ${describePattern(g.prerequisite)} first`,
      );
    case "confine": {
      if (!g.tools.includes(event.tool)) return null;
      const path = (event.input as Record<string, unknown> | null)?.[
        g.pathKey ?? "file_path"
      ];
      if (typeof path !== "string" || isConfined(path, g.allow)) return null;
      return deny(
        g.reason ??
          `${event.tool} path "${path}" is outside the allowed set [${g.allow.join(", ")}]`,
      );
    }
  }
}

/**
 * The pure runtime gate: decide allow/deny for `event`, given the guards and the
 * calls that already fired this session (`prior`, oldest-first — the ledger the
 * `guard-hook` CLI reconstructs from the transcript). First match wins a deny.
 */
export function decideGuards(
  guards: readonly Guard[],
  event: ToolEvent,
  prior: readonly ToolEvent[] = [],
): GuardDecision {
  for (const g of guards) {
    const d = decideOne(g, event, prior);
    if (d) return d;
  }
  return ALLOW;
}

const describePattern = (p: ToolPattern): string =>
  p.when ? `${p.tool}(${describeArgs(p.when)})` : p.tool;

/** Every tool name a guard set gates (the PreToolUse matcher union). */
export function guardedTools(guards: readonly Guard[]): string[] {
  const tools = new Set<string>();
  for (const g of guards) {
    if (g.kind === "confine") for (const t of g.tools) tools.add(t);
    else tools.add(g.target.tool);
  }
  return [...tools].sort();
}

/** A Claude Code settings `hooks` block (the generated artifact). */
export interface HooksConfig {
  readonly hooks: {
    readonly PreToolUse: readonly {
      readonly matcher: string;
      readonly hooks: readonly {
        readonly type: "command";
        readonly command: string;
      }[];
    }[];
  };
}

/**
 * Generate the hooks block for a guard set. The command is vigiles's OWN gate
 * (default `npx vigiles hook-runtime guard`), NOT user shell — so the generated
 * enforcement is safe-by-construction and a repo can't smuggle an arbitrary RCE
 * hook. The gate reads the same guard set + the live event and runs `decideGuards`.
 */
export function compileGuards(
  guards: readonly Guard[],
  gateCommand = "npx vigiles hook-runtime guard",
): HooksConfig {
  const matcher = guardedTools(guards).join("|");
  return {
    hooks: {
      PreToolUse: [
        { matcher, hooks: [{ type: "command", command: gateCommand }] },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Serialization — round-trip a guard set through JSON (RegExp-safe)
// ---------------------------------------------------------------------------
//
// A `when` matcher may carry RegExp values, which `JSON.stringify` drops to `{}`.
// We encode each as `{ re, flags }` (mirroring src/tool-intercept.ts's env round-trip)
// so `.vigiles/guards.json` survives a write/read cycle exactly.

type WireValue = string | number | boolean | { re: string; flags: string };
type WireMatcher = Record<string, WireValue>;

function isWireRegex(v: WireValue): v is { re: string; flags: string } {
  return typeof v === "object" && v !== null && "re" in v;
}

function encodeMatcher(m: ArgMatcher): WireMatcher {
  const out: WireMatcher = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = v instanceof RegExp ? { re: v.source, flags: v.flags } : v;
  }
  return out;
}

function decodeMatcher(w: WireMatcher): ArgMatcher {
  const out: ArgMatcher = {};
  for (const [k, v] of Object.entries(w)) {
    out[k] = isWireRegex(v) ? new RegExp(v.re, v.flags) : v;
  }
  return out;
}

function encodePattern(p: ToolPattern): unknown {
  return { tool: p.tool, when: p.when ? encodeMatcher(p.when) : undefined };
}

function decodePattern(raw: unknown): ToolPattern | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.tool !== "string") return null;
  const when =
    o.when !== null && typeof o.when === "object"
      ? decodeMatcher(o.when as WireMatcher)
      : undefined;
  return { tool: o.tool, when };
}

/** Serialize a guard set for `.vigiles/guards.json` (RegExp matchers preserved). */
export function serializeGuards(guards: readonly Guard[]): string {
  const wire = guards.map((g) => {
    if (g.kind === "confine") {
      return {
        kind: g.kind,
        tools: g.tools,
        allow: g.allow,
        pathKey: g.pathKey,
        reason: g.reason,
      };
    }
    if (g.kind === "requireBefore") {
      return {
        kind: g.kind,
        target: encodePattern(g.target),
        prerequisite: encodePattern(g.prerequisite),
        reason: g.reason,
      };
    }
    return { kind: g.kind, target: encodePattern(g.target), reason: g.reason };
  });
  return JSON.stringify({ guards: wire }, null, 2);
}

function parseConfine(o: Record<string, unknown>): Guard | null {
  if (!Array.isArray(o.tools) || !Array.isArray(o.allow)) return null;
  return {
    kind: "confine",
    tools: o.tools.filter((t): t is string => typeof t === "string"),
    allow: o.allow.filter((a): a is string => typeof a === "string"),
    pathKey: typeof o.pathKey === "string" ? o.pathKey : undefined,
    reason: typeof o.reason === "string" ? o.reason : undefined,
  };
}

function parseGuard(raw: unknown): Guard | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const reason = typeof o.reason === "string" ? o.reason : undefined;
  if (o.kind === "block") {
    const target = decodePattern(o.target);
    return target && reason ? { kind: "block", target, reason } : null;
  }
  if (o.kind === "requireBefore") {
    const target = decodePattern(o.target);
    const prerequisite = decodePattern(o.prerequisite);
    if (!target || !prerequisite) return null;
    return { kind: "requireBefore", target, prerequisite, reason };
  }
  if (o.kind === "confine") return parseConfine(o);
  return null;
}

/** Parse a guard set from JSON (tolerant — a malformed guard is skipped). */
export function parseGuards(json: string): Guard[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (data as { guards?: unknown })?.guards;
  if (!Array.isArray(list)) return [];
  const out: Guard[] = [];
  for (const item of list) {
    const g = parseGuard(item);
    if (g) out.push(g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime IO — load the guard set, read/append the session ledger
// ---------------------------------------------------------------------------

const GUARDS_FILE = ".vigiles/guards.json";
const LEDGER_FILE = `${VIGILES_DIR}/${GUARD_LEDGER_FILE}`;

/** Load the declared guard set from `.vigiles/guards.json` (absent → none). */
export function loadGuards(cwd: string): Guard[] {
  const p = resolve(cwd, GUARDS_FILE);
  if (!existsSync(p)) return [];
  return parseGuards(readFileSync(p, "utf-8"));
}

/**
 * The prior-call ledger — the calls already allowed this session, oldest-first.
 * `requireBefore` reads it to know whether a prerequisite ran. Claude Code doesn't
 * surface call history to a hook, so vigiles records each allowed call itself
 * (mirrors `.vigiles/active-agent.json`).
 */
export function readGuardLedger(cwd: string): ToolEvent[] {
  const p = resolve(cwd, LEDGER_FILE);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { calls?: unknown };
    if (!Array.isArray(parsed.calls)) return [];
    return parsed.calls.filter(
      (c): c is ToolEvent =>
        c !== null &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).tool === "string",
    );
  } catch {
    return [];
  }
}

/** Append an allowed call to the session ledger. */
export function recordGuardCall(cwd: string, event: ToolEvent): void {
  const p = resolve(cwd, LEDGER_FILE);
  const calls = readGuardLedger(cwd);
  calls.push({ tool: event.tool, input: event.input });
  mkdirSync(dirname(p), { recursive: true });
  ensureLocalFilesIgnored(dirname(p));
  writeFileSync(p, JSON.stringify({ calls }, null, 2));
}

/** Parse a PreToolUse event JSON (the hook's stdin) into a {@link ToolEvent}. */
export function parseGuardEvent(rawJson: string): ToolEvent | null {
  let parsed: { tool_name?: unknown; tool_input?: unknown };
  try {
    parsed = JSON.parse(rawJson) as {
      tool_name?: unknown;
      tool_input?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof parsed.tool_name !== "string" || !parsed.tool_name) return null;
  return { tool: parsed.tool_name, input: parsed.tool_input ?? {} };
}

/** The outcome of running the gate against one event. */
export interface GuardHookOutcome {
  readonly decision: GuardDecision;
  /** True iff the allowed call was recorded to the ledger. */
  readonly recorded: boolean;
}

/**
 * The runnable gate, decoupled from process/exit so it's testable. Decides the
 * event against the loaded guards + the prior-call ledger; on ALLOW it records the
 * call (so a later `requireBefore` sees it) and on DENY it records nothing (a
 * blocked call never happened). Malformed/absent event → allow, record nothing.
 */
export function runGuardHook(cwd: string, rawJson: string): GuardHookOutcome {
  const event = parseGuardEvent(rawJson);
  if (!event) return { decision: ALLOW, recorded: false };
  const guards = loadGuards(cwd);
  const decision = decideGuards(guards, event, readGuardLedger(cwd));
  if (decision.allow) {
    recordGuardCall(cwd, event);
    return { decision, recorded: true };
  }
  return { decision, recorded: false };
}
