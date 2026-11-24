/**
 * Tool interception — the eval-tier half of the tool-call spy.
 *
 * The eval tier drives the REAL model, so the agent's tool decisions are genuine.
 * But letting a side-effecting tool actually run — a paid image API, `git push`,
 * spawning a paid subagent — makes the eval expensive and dangerous. An
 * **intercept** lets the model emit the `tool_use` (so its arguments are captured
 * in the `Trace`, where `check.tool(name, { with })` asserts on them) while a PreToolUse
 * hook **denies the real execution** with a block message. The run stays cheap and
 * side-effect-free, but the agent's *decision* — the thing a completion grader
 * can't see — is fully observable.
 *
 * This module is the PURE decision + wiring core, mirroring the agent-contract
 * rail (`src/adapters/claude-code/agent-runtime.ts`):
 *
 * - `decideIntercept` — does this call get intercepted, and with what deny reason;
 * - `buildInterceptSettings` — the PreToolUse hook fragment routing matched tools
 *   through `vigiles hook-runtime intercept-tool`;
 * - `serializeIntercepts` / `parseIntercepts` — the env round-trip (incl. RegExp
 *   matchers) the hook subprocess reads back.
 *
 * The hook denies via exit 2 + a stderr message (the same block mechanism the
 * agent rail uses). IMPORTANT — Claude Code surfaces that to the model as a
 * *blocked* call: the tool is intercepted (prevented), NOT executed, and the model
 * is NOT handed a faked successful return. So this is **intercept-and-prevent +
 * observe the attempt**, not a faithful tool mock: it's sound for "did the agent
 * ATTEMPT X / call it with these args / push to the wrong branch" (first-attempt
 * questions, where what happens after doesn't matter), and unsound for "stub the
 * tool and let the trajectory continue as if it succeeded" (the model is told it
 * was blocked, so a multi-step flow that needs the real result will derail). CC
 * exposes no "skip execution but return this as success" primitive for arbitrary
 * tools, so deny+reason is the closest available — with that ceiling.
 */
import { type ArgMatcher, matchesArgs } from "./arg-match.js";

/** Env var the spawned `vigiles hook-runtime intercept-tool` reads its intercept list from. */
export const INTERCEPT_TOOLS_ENV = "VIGILES_INTERCEPT_TOOLS";

/** Declare a tool to intercept: deny its real execution with a block message. */
export interface ToolIntercept {
  /** The tool to intercept (e.g. `"Bash"`, `"WebFetch"`, `"Task"`, `"mcp__img__gen"`). */
  readonly tool: string;
  /**
   * Only intercept calls whose `input` matches (so you can intercept `git push`
   * while letting other `Bash` through). Omit to intercept every call to `tool`.
   */
  readonly when?: ArgMatcher;
  /**
   * The denial reason shown to the model when the call is intercepted. This is a
   * *block* message: the call is intercepted (prevented), NOT executed — so phrase
   * it as "this was prevented; don't retry", not "here's your result".
   * Defaults to {@link DEFAULT_INTERCEPT_REASON}.
   */
  readonly denyReason?: string;
}

/** The default denial reason — honest that the call was intercepted (prevented), NOT executed. */
export const DEFAULT_INTERCEPT_REASON =
  "vigiles intercepted this tool call for testing — it was NOT executed. " +
  "Do not retry it; treat the tool as unavailable and continue.";

/** The decision for one tool call: intercept it (deny + reason), or let it run. */
export type InterceptDecision =
  | { readonly intercept: true; readonly denyReason: string }
  | { readonly intercept: false };

/**
 * Decide whether a tool call should be intercepted. Returns the first matching
 * intercept's denial reason (preventing real execution), or `{ intercept: false }`
 * to let the call run for real. Pure — the same logic `vigiles hook-runtime intercept-tool`
 * runs.
 */
export function decideIntercept(
  toolName: string,
  input: unknown,
  intercepts: readonly ToolIntercept[],
): InterceptDecision {
  for (const i of intercepts) {
    if (i.tool !== toolName) continue;
    if (i.when && !matchesArgs(input, i.when)) continue;
    return {
      intercept: true,
      denyReason: i.denyReason ?? DEFAULT_INTERCEPT_REASON,
    };
  }
  return { intercept: false };
}

/**
 * Decide from a raw PreToolUse event JSON (the hook's stdin). Parses `tool_name`
 * + `tool_input`, then defers to {@link decideIntercept}. Malformed input or a
 * missing tool name is a no-op (let it run) — never fail closed on a parse error.
 */
export function interceptHookDecision(
  rawEvent: string,
  intercepts: readonly ToolIntercept[],
): InterceptDecision {
  let parsed: { tool_name?: string; tool_input?: unknown };
  try {
    parsed = JSON.parse(rawEvent) as {
      tool_name?: string;
      tool_input?: unknown;
    };
  } catch {
    return { intercept: false };
  }
  const tool = parsed.tool_name ?? "";
  if (!tool) return { intercept: false };
  return decideIntercept(tool, parsed.tool_input ?? {}, intercepts);
}

// ---------------------------------------------------------------------------
// Settings fragment — the PreToolUse hook registration
// ---------------------------------------------------------------------------

/** A `.claude/settings.json` fragment registering the intercept PreToolUse hook. */
export interface InterceptSettings {
  readonly hooks: { readonly PreToolUse: readonly unknown[] };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueToolNames(intercepts: readonly ToolIntercept[]): string[] {
  return [...new Set(intercepts.map((i) => i.tool))];
}

/**
 * Build the PreToolUse hook fragment that routes every intercepted tool through
 * `vigiles hook-runtime intercept-tool`. The `matcher` is a CC tool-name regex over the
 * union of intercepted tool names (each escaped), so unrelated tools are never
 * intercepted. Merge the result into an arm's `settings`; the intercept list
 * itself travels in the {@link INTERCEPT_TOOLS_ENV} env var (see
 * {@link serializeIntercepts}).
 */
export function buildInterceptSettings(
  intercepts: readonly ToolIntercept[],
  opts: { command?: string } = {},
): InterceptSettings {
  const command = opts.command ?? "npx vigiles hook-runtime intercept-tool";
  const matcher = uniqueToolNames(intercepts).map(escapeRegex).join("|");
  return {
    hooks: {
      PreToolUse: [{ matcher, hooks: [{ type: "command", command }] }],
    },
  };
}

// ---------------------------------------------------------------------------
// Env round-trip — the hook subprocess reads the intercept list back (RegExp-safe)
// ---------------------------------------------------------------------------

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

/**
 * Serialize an intercept list to a JSON string for {@link INTERCEPT_TOOLS_ENV}.
 * RegExp matchers are encoded as `{ re, flags }` so they round-trip exactly (a
 * plain `JSON.stringify` would drop them to `{}`).
 */
export function serializeIntercepts(
  intercepts: readonly ToolIntercept[],
): string {
  return JSON.stringify(
    intercepts.map((i) => ({
      tool: i.tool,
      denyReason: i.denyReason,
      when: i.when ? encodeMatcher(i.when) : undefined,
    })),
  );
}

/** Parse an intercept list from the env JSON (tolerant — a bad entry is skipped). */
export function parseIntercepts(json: string): ToolIntercept[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: ToolIntercept[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.tool !== "string") continue;
    out.push({
      tool: o.tool,
      denyReason: typeof o.denyReason === "string" ? o.denyReason : undefined,
      when:
        o.when !== null && typeof o.when === "object"
          ? decodeMatcher(o.when as WireMatcher)
          : undefined,
    });
  }
  return out;
}
