/**
 * Hook-matcher verification — the cross-referencing moat applied to the MATCHER
 * string inside a hook registration. A hook fires only when its `matcher` selects
 * the tool name the harness emits; a typo or an unmatchable pattern silently
 * prevents the hook from ever running — exactly the FALSE CONFIDENCE failure the
 * compiled-hooks design exists to eliminate (research/hook-pain-points.md).
 *
 * ## The matching semantics this detector models (MEASURED, not assumed)
 *
 * A matcher is NOT a literal tool name — it is a pattern. Measured against the
 * real `claude` CLI (2.1.226) with the scripted mock model, one hook per run,
 * marker file as the oracle:
 *
 * | matcher              | tool called                                     | fired |
 * | -------------------- | ----------------------------------------------- | ----- |
 * | `Write`              | `Write`                                         | yes   |
 * | `Writ` / `rit`       | `Write`                                         | NO    |
 * | `rit.`               | `Write`                                         | yes   |
 * | `W(rit)e`            | `Write`                                         | yes   |
 * | `mcp__.*`            | `mcp__some_server__list_events`                 | yes   |
 * | `mcp__.*__.*`        | `mcp__some_server__list_events`                 | yes   |
 * | `mcp__[^_]+__[^_]+`  | `mcp__some_server__list_events`                 | NO    |
 * | `mcp__[^_]+__[^_]+`  | `mcp__4f54037d-…-6130f3da1ef8__list_events`      | yes   |
 * | `mcp__\w+__\w+`      | `mcp__some_server__list_events`                 | yes   |
 * | `mcp__\w+__\w+`      | `mcp__4f54037d-…-6130f3da1ef8__list_events`      | NO    |
 *
 * Two facts follow, and the detector encodes exactly these:
 *
 * 1. A matcher with NO regex metacharacter is matched by STRING EQUALITY
 *    (`rit` does not fire on `Write`, though it is a substring).
 * 2. A matcher WITH metacharacters is matched as an UNANCHORED regex
 *    (`rit.` fires on `Write`; `mcp__[^_]+__[^_]+` fires on the hyphenated
 *    server because `[^_]+` only has to reach *into* the tool segment).
 *
 * ## What is flagged (five kinds)
 *
 * 1. **tool-typo** — a LITERAL bare token that is a close typo (edit distance ≤ 2)
 *    of a real built-in tool (`bash` → `Bash`). Reuses `closestTool`.
 * 2. **invalid-regex** — the matcher does not COMPILE. A dead hook no other check
 *    catches, and its own finding rather than a silent skip.
 * 3. **mcp-form** — an MCP-ish matcher that can match NO MCP tool name at all:
 *    a literal that isn't the `mcp__<server>__<tool>` shape (`mcp_memory_search`),
 *    or a pattern that matches none of the synthetic probes (`mcp_memory_*`).
 * 4. **mcp-narrow** — an MCP-ish pattern that DOES fire, but not on the server
 *    naming that occurs in the wild. `mcp__[^_]+__[^_]+` cannot cross the `_` in
 *    `Google_Calendar`; `mcp__\w+__\w+` cannot cross the `-` in the uuid form —
 *    and the SAME server appears both ways in different sessions. This is a real
 *    gap but it is NOT "never fires", and the message says so.
 * 5. **mcp-undeclared** — a matcher pinning a literal `mcp__<server>__…` the
 *    plugin doesn't declare. Gated exactly like `mcp-tool-resolves`.
 *
 * ## Why patterns are validated by PROBING, not by shape
 *
 * The server segment is not stable: the same Google Calendar server is
 * `mcp__Google_Calendar__list_events` in one session and
 * `mcp__4f54037d-…__list_events` in another, so a hook keyed to one literal id
 * dies silently when the id changes — patterns are the CORRECT authoring form.
 * Validating a pattern against the literal shape therefore inverts the verdict:
 * it rejected `mcp__.*` (fires on everything) and accepted `mcp__[^_]+__[^_]+`
 * (fires on nothing with an underscored server). So a pattern is instead COMPILED
 * and run against synthetic probes — including a probe whose server segment holds
 * an underscore and one whose server segment holds hyphens, because both occur.
 * Probes are also DERIVED from the matcher's own literal segments, so a correctly
 * server-scoped `mcp__memory__.*` is never called unreachable (#131).
 *
 * FP-SAFE, unchanged in spirit: a match-all (`*`, `.*`, `**`, empty) or an
 * ALTERNATION (`Edit|Write`) is skipped — each arm of an alternation would have
 * to be judged separately, and a mixed arm set is legitimate. A non-MCP token
 * carrying regex/glob syntax is skipped too (it is a pattern over built-in tool
 * names, not a name).
 *
 * Pure + ONE detector reused by `scan` + the `hook-matcher` lint rule
 * (one-detector-no-drift). The dialect is injected (core ⊄ adapter).
 */
import type { HarnessDialect } from "./dialect.js";
import { closestTool } from "./tool-contract.js";
import { mcpToolServer } from "./mcp-tool.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which matching failure was detected in the hook matcher string. */
export type HookMatcherKind =
  | "tool-typo"
  | "invalid-regex"
  | "mcp-form"
  | "mcp-narrow"
  | "mcp-undeclared";

/** One finding for a hook matcher that doesn't fire the way it reads. */
export interface HookMatcherFinding {
  /** The matcher string exactly as written. */
  readonly matcher: string;
  /** Which class of error was detected. */
  readonly kind: HookMatcherKind;
  /**
   * The corrected matcher when the intent is recoverable (e.g. `Bash` for
   * `bash`, `mcp__memory__.*` for `mcp_memory_*`). Absent when the server
   * segment can't be recovered from a malformed MCP form.
   *
   * INVARIANT (property-tested): a suggestion, fed back through this detector,
   * produces no finding — the advice converges in one step.
   */
  readonly suggestion?: string;
  /** A ready-to-show, actionable message. */
  readonly message: string;
}

/** A single hook registration entry — its event and matcher string. */
export interface HookMatcherEntry {
  readonly event: string;
  readonly matcher: string;
}

// ---------------------------------------------------------------------------
// The probe corpus
// ---------------------------------------------------------------------------

/**
 * Server segments an MCP tool name really carries. `Google_Calendar` is
 * Anthropic's own connector naming (an underscore INSIDE the server segment);
 * the uuid is the SAME server as it appears in another session (hyphens). A
 * matcher meant to catch "MCP tools" has to reach both.
 */
const PROBE_SERVERS = [
  "srv",
  "Google_Calendar",
  "4f54037d-0499-426a-8573-6130f3da1ef8",
] as const;

/** Tool segments: plain, underscored, and the second underscored form. */
const PROBE_TOOLS = ["tool", "list_events", "update_event"] as const;

/** The simplest possible MCP tool name — "does this pattern match MCP at all". */
const PROBE_SIMPLE = "mcp__srv__tool";

/**
 * The two REAL-SHAPE probes a generic MCP matcher must also reach. Both are
 * measured: `mcp__[^_]+__[^_]+` does not fire on the first, `mcp__\w+__\w+`
 * does not fire on the second.
 */
const REAL_SHAPE_PROBES = [
  "mcp__Google_Calendar__list_events",
  "mcp__4f54037d-0499-426a-8573-6130f3da1ef8__update_event",
] as const;

/** The widest correct MCP matcher — what a too-narrow one should become. */
const WIDE_MCP_MATCHER = "mcp__.*__.*";

/**
 * Match-all matchers the harness special-cases (and `*` isn't even a regex).
 *
 * 🔴 MEASURED, AND `**` IS NOT ONE OF THEM. It sat in this set on no evidence
 * while the table at the top of this file — the measured one — never listed it.
 * Against a real `claude` 2.1.263, one hook per run, marker file as the oracle,
 * 3 runs of each:
 *
 * | matcher | a `Bash` call | fired |
 * | ------- | ------------- | ----- |
 * | `*`     | `Bash`        | yes   |
 * | `.*`    | `Bash`        | yes   |
 * | `""`    | `Bash`        | yes   |
 * | `**`    | `Bash`        | NO    |
 *
 * The direction of that mistake is the expensive one: believing `**` selects
 * everything makes a guard registered under it come back "measured, allows
 * 0/7" — an ACCUSATION that a repo's guard let seven disasters through, when
 * the harness never invoked it once. The mirror image of scoring a hook that
 * could not start. `**` now falls through to the regex path, where it does not
 * compile, and both the sweep and the `hook-matcher` rule report a hook that
 * never fires. Pinned by `src/hook-matcher-delivery.test.ts` so the day Claude
 * Code starts honouring it, the claim goes red instead of quietly rotting.
 */
const MATCH_ALL = new Set(["", "*", ".*"]);

/** Cap on segments harvested from a matcher — bounds the probe corpus. */
const MAX_DERIVED_SEGMENTS = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Regex metacharacters — their presence is what makes a matcher a PATTERN. */
const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/** A matcher with no metacharacter is compared by string equality (measured). */
function isLiteralMatcher(matcher: string): boolean {
  return !REGEX_META.test(matcher);
}

/** Compile a matcher, or null when the regex engine rejects it. */
function compileMatcher(matcher: string): RegExp | null {
  try {
    return new RegExp(matcher);
  } catch {
    return null;
  }
}

/**
 * A token starts with `mcp` followed by a separator — it is trying to be an MCP
 * tool reference, whether or not it succeeds. A leading `^` is tolerated so an
 * ANCHORED pattern (`^mcp__srv$`, which cannot reach the tool segment) is judged
 * as MCP rather than skipped as an unknown built-in.
 */
function looksMcpIsh(token: string): boolean {
  return /^\^?mcp[_-]/i.test(token);
}

/**
 * Whether a NON-MCP token should be inspected as a possible tool-name typo. We
 * only inspect a single bare token that could plausibly BE a tool name; regex /
 * glob syntax means it is a pattern over tool names, not one. Conservative by
 * design: an unrecognized form → skip, never flag.
 */
function isBareToolToken(token: string): boolean {
  if (token.includes("(") || token.includes(")")) return false;
  if (token.includes("[")) return false;
  if (token.startsWith("^") || token.endsWith("$")) return false;
  if (token.startsWith(".*")) return false;
  if (token.endsWith(".*") || token.endsWith("*")) return false;
  return true;
}

/**
 * Strip the regex anchors so an anchored matcher (`^mcp__memory__.*$`) is read
 * structurally the same as its unanchored twin. The anchors stay in the compiled
 * regex — this is only for reading the matcher's literal segments.
 */
function withoutAnchors(matcher: string): string {
  return matcher.replace(/^\^/, "").replace(/\$$/, "");
}

/** The literal server segment of `mcp__<server>__…`, or null when it's a pattern. */
function literalServerSegment(matcher: string): string | null {
  return /^mcp__([A-Za-z0-9_-]+)__/.exec(withoutAnchors(matcher))?.[1] ?? null;
}

/** Literal name-shaped runs inside one segment of a matcher (`mem.*` → `mem`). */
function literalRuns(segment: string): string[] {
  return (segment.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? []).slice(
    0,
    MAX_DERIVED_SEGMENTS,
  );
}

/**
 * Synthetic MCP tool names to test a matcher against: the generic corpus (the
 * real-world server/tool shapes) PLUS names built from the matcher's OWN literal
 * segments, so a legitimately scoped `mcp__memory__search.*` has something to
 * match. Derivation is POSITIONAL — segments are read from the `mcp__`-split
 * positions they occupy, never re-used as a different segment — so a malformed
 * `mcp_memory_search` cannot manufacture a probe that rescues it.
 */
function mcpProbes(matcher: string): string[] {
  const parts = withoutAnchors(matcher).split("__");
  const derivedServers =
    parts[0] === "mcp" && parts.length > 1 ? literalRuns(parts[1]) : [];
  const derivedTools =
    parts[0] === "mcp" && parts.length > 2
      ? literalRuns(parts.slice(2).join("__"))
      : [];
  const servers = [...derivedServers, ...PROBE_SERVERS];
  const tools = [...derivedTools, ...PROBE_TOOLS];
  const probes: string[] = [];
  for (const server of servers)
    for (const tool of tools) probes.push(`mcp__${server}__${tool}`);
  return probes;
}

/**
 * Recover the server segment from a malformed MCP token so the corrected
 * `mcp__<server>__.*` form can be suggested. Returns null when nothing
 * name-shaped can be recovered (then the message spells the form out instead).
 *
 * Handles the `__`-separated form first — the segment the user actually wrote is
 * kept whole (`mcp__memory_search` → `memory_search`, since a real server IS
 * named like `Google_Calendar`) — then the single-underscore / hyphen typos
 * (`mcp_memory_search`, `mcp-memory-search`, `mcp_memory_*` → `memory`).
 */
function recoverMcpServer(token: string): string | null {
  const parts = withoutAnchors(token).split("__");
  const candidate =
    parts.length > 1 && parts[1].length > 0
      ? parts[1]
      : firstSeparatedSegment(token);
  if (candidate === null) return null;
  // A recovered segment must be name-shaped, or the "suggestion" would be a
  // regex fragment — the bug that made the old advice grow `__.*` forever.
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate) ? candidate : null;
}

/** The segment after a single `_`/`-` separator following the `mcp` prefix. */
function firstSeparatedSegment(token: string): string | null {
  const rest = withoutAnchors(token).replace(/^mcp(?:_|-)/i, "");
  if (rest === token || rest.length === 0) return null;
  const segment = rest.split(/(?<!_)_(?!_)|-/)[0];
  return segment.length > 0 ? segment : null;
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

/** The matcher can match NO MCP tool name — the hook is dead. */
function unreachableFinding(matcher: string): HookMatcherFinding {
  const server = recoverMcpServer(matcher);
  const suggestion = server === null ? undefined : `mcp__${server}__.*`;
  const hint =
    suggestion === undefined
      ? " Use the form `mcp__<server>__<tool>` (double underscores), or a pattern that produces it."
      : ` Did you mean "${suggestion}"?`;
  return {
    matcher,
    kind: "mcp-form",
    ...(suggestion === undefined ? {} : { suggestion }),
    message: `Hook matcher "${matcher}" matches no MCP tool name — MCP tools are named \`mcp__<server>__<tool>\`, so this hook never fires.${hint}`,
  };
}

/**
 * The matcher fires on some MCP tools but misses real-world server naming. The
 * message names the probes it actually misses — not the whole corpus — so the
 * finding is checkable rather than a vague "too narrow".
 */
function narrowFinding(
  matcher: string,
  missed: readonly string[],
): HookMatcherFinding {
  const names = missed.map((m) => `"${m}"`).join(" or ");
  return {
    matcher,
    kind: "mcp-narrow",
    suggestion: WIDE_MCP_MATCHER,
    message: `Hook matcher "${matcher}" fires on some MCP tools but not on ${names} — real server segments contain "_" and "-" (the same server appears as \`mcp__Google_Calendar__…\` in one session and \`mcp__<uuid>__…\` in another), so this matcher silently skips them. Did you mean "${WIDE_MCP_MATCHER}"?`,
  };
}

/** The matcher isn't a regex the engine accepts — it can never match. */
function invalidRegexFinding(matcher: string): HookMatcherFinding {
  return {
    matcher,
    kind: "invalid-regex",
    message: `Hook matcher "${matcher}" is not a valid regular expression — the harness can't compile it, so the hook never fires.`,
  };
}

// ---------------------------------------------------------------------------
// Per-matcher checks
// ---------------------------------------------------------------------------

/**
 * The shape half of the MCP check: can this matcher produce an MCP tool name at
 * all, and if so does it reach the ones that occur in the wild? `re` is null for
 * a literal matcher (compared by string equality, so only the shape can be
 * checked).
 */
function mcpShapeFinding(
  matcher: string,
  re: RegExp | null,
  dialect: HarnessDialect,
): HookMatcherFinding | null {
  if (re === null)
    return dialect.mcpToolPattern.test(matcher)
      ? null
      : unreachableFinding(matcher);
  if (!mcpProbes(matcher).some((p) => re.test(p)))
    return unreachableFinding(matcher);
  // The narrowness check applies only to a matcher meant to be GENERIC: one that
  // pins no literal server yet matches the simplest MCP name. A matcher scoped to
  // one server (or to specific tools) is narrow ON PURPOSE — never flag it.
  if (literalServerSegment(matcher) !== null || !re.test(PROBE_SIMPLE))
    return null;
  const missed = REAL_SHAPE_PROBES.filter((p) => !re.test(p));
  return missed.length === 0 ? null : narrowFinding(matcher, missed);
}

/**
 * The resolution half: a matcher pinning a literal server the plugin doesn't
 * declare can't fire. Gated EXACTLY like `mcp-tool-resolves` — no declared set →
 * silent (the server may be user-global), built-ins allowlisted, the
 * plugin-namespaced form skipped.
 */
function mcpUndeclaredFinding(
  matcher: string,
  declaredServers: readonly string[],
  dialect: HarnessDialect,
): HookMatcherFinding | null {
  if (declaredServers.length === 0) return null;
  const server =
    mcpToolServer(matcher, dialect) ?? literalServerSegment(matcher);
  if (server === null) return null;
  if (/^plugin_/i.test(server)) return null;
  const known = new Set<string>([
    ...declaredServers,
    ...(dialect.knownMcpServers ?? []),
  ]);
  if (known.has(server)) return null;
  return {
    matcher,
    kind: "mcp-undeclared",
    message: `Hook matcher "${matcher}" references MCP server "${server}", which the plugin doesn't declare (declared: ${declaredServers.join(", ")}) — the hook can't fire.`,
  };
}

/** A literal bare token that is a close typo of a real built-in tool. */
function toolTypoFinding(
  matcher: string,
  dialect: HarnessDialect,
): HookMatcherFinding | null {
  if (!isBareToolToken(matcher)) return null;
  if (new Set(dialect.builtinAgentTools).has(matcher)) return null;
  const near = closestTool(matcher, dialect);
  if (near === null) return null; // far/unknown → likely a plugin tool, not a typo
  return {
    matcher,
    kind: "tool-typo",
    suggestion: near,
    message: `Hook matcher "${matcher}" doesn't match any built-in tool — the hook silently never fires. Did you mean "${near}"?`,
  };
}

/** The whole per-matcher decision. Null when the matcher is fine (or skipped). */
function matcherFinding(
  matcher: string,
  declaredServers: readonly string[],
  dialect: HarnessDialect,
): HookMatcherFinding | null {
  if (MATCH_ALL.has(matcher)) return null;
  // Alternation: each arm would have to be judged on its own, and a mixed set
  // (`mcp__x__y|Bash`) is legitimate — skip, same don't-cry-wolf discipline.
  if (matcher.includes("|")) return null;
  const literal = isLiteralMatcher(matcher);
  const re = literal ? null : compileMatcher(matcher);
  if (!literal && re === null) return invalidRegexFinding(matcher);
  if (looksMcpIsh(matcher))
    return (
      mcpShapeFinding(matcher, re, dialect) ??
      mcpUndeclaredFinding(matcher, declaredServers, dialect)
    );
  return literal ? toolTypoFinding(matcher, dialect) : null;
}

// ---------------------------------------------------------------------------
// Public detector
// ---------------------------------------------------------------------------

/**
 * Verify hook-matcher strings for the ways a matcher fails to fire as written.
 * Returns one {@link HookMatcherFinding} per offending entry. De-duplicates
 * repeated matchers. Returns `[]` when every matcher is FP-safe to skip or is
 * correct.
 */
export function hookMatcherIssues(
  entries: readonly HookMatcherEntry[],
  declaredServers: readonly string[],
  dialect: HarnessDialect,
): HookMatcherFinding[] {
  const findings: HookMatcherFinding[] = [];
  const seen = new Set<string>();
  for (const { matcher } of entries) {
    if (seen.has(matcher)) continue; // de-dupe repeated matchers across entries
    seen.add(matcher);
    const finding = matcherFinding(matcher, declaredServers, dialect);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/**
 * How a matcher relates to one tool call — the answer a boolean could not carry.
 *
 * - `"selects"` — the harness spawns the hook for this call.
 * - `"misses"` — it does not, because the matcher names something else.
 * - `"uncompilable"` — it does not, because the harness cannot BUILD the matcher.
 *
 * The last two both mean "the hook does not run", and a caller that only asks
 * `=== "selects"` still lands on the safe answer; they are separate because only
 * the third is a DEFECT worth naming in a report.
 */
export type MatcherReach = "selects" | "misses" | "uncompilable";

/**
 * Would this matcher select a call to `tool` — i.e. does the harness spawn the
 * hook at all?
 *
 * The same two MEASURED facts the module header pins, asked as a question rather
 * than as a defect: on a harness whose matchers are tool names (Claude Code), a
 * matcher with no regex metacharacter is compared by string EQUALITY and one
 * with metacharacters is an UNANCHORED regex. It lives here and not in the
 * caller so those semantics have one home (one-detector-no-drift) —
 * `hookMatcherIssues` judges a matcher, this one applies it.
 *
 * FAIL-OPEN WHERE THE HARNESS IS, AND NOT ONE STEP FURTHER. An absent matcher or
 * a match-all really does select every tool, so answering `"selects"` there
 * states a fact — the same direction `decideHookCondition`
 * (`core/hook-condition.ts`) fails open, and for the same reason it gives: where
 * Claude Code cannot tell, it RUNS the hook, so mirroring it can only ever add a
 * run, never invent a skip.
 *
 * 🔴 THAT REASONING DOES NOT REACH AN UNCOMPILABLE MATCHER, and this function
 * used to apply it there anyway. `Bash(` is what the `invalid-regex` finding
 * above already reports as "the harness can't compile it, so the hook never
 * fires" — the harness fails CLOSED. Answering `"selects"` therefore does not
 * add a run the harness makes, it MANUFACTURES one: a caller feeds the hook a
 * battery it would never have been handed, and an unconditional-deny body scores
 * a full pass for a hook that cannot run. That is the false-confidence class
 * this module exists to remove, so an uncompilable matcher gets its own answer
 * and the caller declines to score it.
 *
 * @param matcher - the registration's matcher, or `null` when it declares none.
 * @param tool - the tool named by the call, e.g. `"Bash"`.
 * @param style - the active harness's `HookProtocol.matcherStyle`. `"exact"`
 *   (the default, Claude Code) applies the literal-equality rule above;
 *   `"regex"` (Codex) compiles EVERY matcher, so `ash` matches `Bash` and the
 *   glob spellings `*` / `**` — which are Claude Code's documented match-all,
 *   not regexes — come back `"uncompilable"` rather than being assumed to be
 *   special-cased by a harness nobody measured.
 */
export function hookMatcherReach(
  matcher: string | null,
  tool: string,
  style: "exact" | "regex" = "exact",
): MatcherReach {
  if (matcher === null || matcher === "") return "selects";
  if (style === "exact") {
    if (MATCH_ALL.has(matcher)) return "selects";
    if (isLiteralMatcher(matcher))
      return matcher === tool ? "selects" : "misses";
  }
  const re = compileMatcher(matcher);
  if (re === null) return "uncompilable";
  return re.test(tool) ? "selects" : "misses";
}
