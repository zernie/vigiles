/**
 * Hook-matcher detector suite (vitest) — the cross-referencing moat applied to
 * the MATCHER string in a hook registration. Asserts all five kinds (tool-typo /
 * invalid-regex / mcp-form / mcp-narrow / mcp-undeclared), the FP-safety guards
 * (wildcards / alternation / no-declared-set / built-in allowlist / far
 * unknowns), the MEASURED matcher-semantics table from #131, the suggestion
 * convergence property, and de-duplication. The dialect is injected — same
 * one-detector-no-drift pattern used by every other core detector.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  hookMatcherIssues,
  hookMatcherReach,
  type HookMatcherEntry,
} from "./hook-matcher.js";
import { claudeCodeDialect as d } from "../adapters/claude-code/dialect.js";

// ---------------------------------------------------------------------------
// tool-typo
// ---------------------------------------------------------------------------

test('tool-typo: "bash" → suggestion "Bash" (close typo, wrong casing)', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "bash" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "tool-typo");
  assert.equal(findings[0].matcher, "bash");
  assert.equal(findings[0].suggestion, "Bash");
  assert.match(findings[0].message, /Bash/);
  assert.match(findings[0].message, /never fires/);
});

test('tool-typo: "read" → suggestion "Read"', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "read" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "tool-typo");
  assert.equal(findings[0].suggestion, "Read");
});

test('exact built-in "Bash" → no finding', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "Bash" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.deepEqual(findings, []);
});

test("far-unknown bare token (no close built-in) → no finding (FP-safe)", () => {
  // "frobnicate" is far from every built-in — likely a plugin tool, not a typo.
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "frobnicate" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// mcp-form: looks MCP-ish but wrong shape
// ---------------------------------------------------------------------------

test('mcp-form: "mcp_memory_*" (single underscore + glob) → flagged, recovers "memory"', () => {
  // The classic typo: single underscores + a trailing glob. The wildcard guard
  // intentionally does NOT skip an mcp-ish token, so this headline case IS caught.
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp_memory_*" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  assert.equal(findings[0].matcher, "mcp_memory_*");
  assert.ok(findings[0].suggestion !== undefined);
  assert.match(findings[0].suggestion ?? "", /mcp__memory/);
});

test('mcp-form: "mcp_memory_search" (single underscore, no glob) → flagged', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp_memory_search" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  assert.match(findings[0].suggestion ?? "", /mcp__memory/);
});

test('mcp-form: "mcp-memory-search" (hyphenated) → flagged, suggestion recovers server', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp-memory-search" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  // Suggestion should contain "mcp__memory"
  assert.ok(findings[0].suggestion !== undefined);
  assert.match(findings[0].suggestion ?? "", /mcp__memory/);
});

// ---------------------------------------------------------------------------
// mcp-undeclared: correct form, server not in declared set
// ---------------------------------------------------------------------------

test('correctly-formed "mcp__memory__.*" with declaredServers=["memory"] → no finding', () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp__memory__.*" },
  ];
  const findings = hookMatcherIssues(entries, ["memory"], d);
  assert.deepEqual(findings, []);
});

test('mcp-undeclared: "mcp__ghost__search" with declaredServers=["memory"] → mcp-undeclared', () => {
  // A correctly-formed MCP matcher naming a server the plugin doesn't declare.
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp__ghost__search" },
  ];
  const findings = hookMatcherIssues(entries, ["memory"], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-undeclared");
  assert.equal(findings[0].matcher, "mcp__ghost__search");
  assert.match(findings[0].message, /ghost/);
  assert.match(findings[0].message, /can't fire/);
});

test('mcp-undeclared: server-wide WILDCARD "mcp__ghost__.*" with declaredServers=["memory"] → flagged', () => {
  // The wildcard form's server is recovered by the fallback regex (mcpToolServer
  // only reads the concrete `mcp__server__tool` shape) — so a server-wide matcher
  // naming an undeclared server is still caught.
  const findings = hookMatcherIssues(
    [{ event: "PreToolUse", matcher: "mcp__ghost__.*" }],
    ["memory"],
    d,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-undeclared");
  assert.match(findings[0].message, /ghost/);
});

test("GUARD 1: no declared set → no mcp-undeclared finding (reaches global servers)", () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp__ghost__search" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  // Without a declared set the detector is silent (can't know what's available).
  assert.deepEqual(findings, []);
});

test("GUARD 2: built-in MCP server (ide) is allowlisted even when not in declaredServers", () => {
  // claudeCodeDialect.knownMcpServers = ["ide"]
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "mcp__ide__getDiagnostics" },
  ];
  // declared set has something (non-empty) but not "ide"
  const findings = hookMatcherIssues(entries, ["memory"], d);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// FP-safety: wildcards / regex / alternation → all skipped
// ---------------------------------------------------------------------------

test('pure wildcard "*" → no finding (skip)', () => {
  assert.deepEqual(
    hookMatcherIssues([{ event: "PreToolUse", matcher: "*" }], [], d),
    [],
  );
});

test('".*" → no finding (skip)', () => {
  assert.deepEqual(
    hookMatcherIssues([{ event: "PreToolUse", matcher: ".*" }], [], d),
    [],
  );
});

test('"Edit|Write" (alternation) → no finding (skip)', () => {
  assert.deepEqual(
    hookMatcherIssues([{ event: "PreToolUse", matcher: "Edit|Write" }], [], d),
    [],
  );
});

test('"Bash.*" (trailing .*) → no finding (skip)', () => {
  assert.deepEqual(
    hookMatcherIssues([{ event: "PreToolUse", matcher: "Bash.*" }], [], d),
    [],
  );
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

test("a repeated matcher across entries is reported only once", () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "bash" },
    { event: "PostToolUse", matcher: "bash" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matcher, "bash");
});

// ---------------------------------------------------------------------------
// #131 — the MEASURED acceptance table.
//
// Every row was measured against the real `claude` CLI (2.1.226) driven by the
// scripted mock model: one hook per run, a marker file as the oracle, a real MCP
// server connected under two different names (`some_server` — an underscore in
// the server segment, like Anthropic's `Google_Calendar` connector — and the
// uuid form the SAME server takes in another session).
//
//   | matcher                        | fires on `some_server` | on the uuid |
//   | ------------------------------ | ---------------------- | ----------- |
//   | mcp__some_server__list_events  | yes (literal)          | n/a         |
//   | mcp__.*                        | YES                    | YES         |
//   | mcp__.*__.*                    | yes                    | yes         |
//   | mcp__[^_]+__[^_]+              | NO                     | yes         |
//   | mcp__\w+__\w+                  | yes                    | NO          |
//
// Before the fix the detector had the two bold rows INVERTED: it rejected
// `mcp__.*` (fires on both) and accepted `mcp__[^_]+__[^_]+` (fires on neither
// of the two fixtures in the issue).
// ---------------------------------------------------------------------------

const noFindings = (matcher: string) =>
  hookMatcherIssues([{ event: "PostToolUse", matcher }], [], d);

test("#131 row 1: the literal `mcp__Google_Calendar__list_events` → accepted", () => {
  assert.deepEqual(noFindings("mcp__Google_Calendar__list_events"), []);
});

test("#131 row 2: `mcp__.*` → accepted (it fires — measured)", () => {
  // The headline false positive: the rule told a user this never fires, and the
  // user replaced a working matcher on its say-so.
  assert.deepEqual(noFindings("mcp__.*"), []);
});

test("#131 row 3: `mcp__.*__.*` → accepted", () => {
  assert.deepEqual(noFindings("mcp__.*__.*"), []);
});

test("#131 row 4: `mcp__[^_]+__[^_]+` → rejected (misses an underscored server)", () => {
  // `[^_]+` cannot cross the `_` in `Google_Calendar` — measured: does NOT fire.
  const findings = noFindings("mcp__[^_]+__[^_]+");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-narrow");
  assert.match(findings[0].message, /mcp__Google_Calendar__list_events/);
  // …and it names ONLY what it misses: measured, this matcher DOES fire on the
  // hyphenated uuid server, so claiming otherwise would be the same overreach
  // the rule is being fixed for.
  assert.doesNotMatch(findings[0].message, /4f54037d/);
  // The honest wording: it fires on SOME tools — it is not a dead matcher.
  assert.doesNotMatch(findings[0].message, /never fires/);
});

test("#131 row 5: `mcp__\\w+__\\w+` → rejected (misses the hyphenated uuid server)", () => {
  // `\w` excludes `-`, so the uuid form of the same server is skipped — measured.
  const findings = noFindings("mcp__\\w+__\\w+");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-narrow");
  assert.match(findings[0].message, /4f54037d/);
  // Measured: it DOES fire on `mcp__some_server__list_events`, so the finding
  // must not accuse it of missing the underscored-server shape.
  assert.doesNotMatch(findings[0].message, /Google_Calendar__list_events/);
});

// ---------------------------------------------------------------------------
// The suggestion convergence property — the check that would have caught the
// regress in #131 ("apply the suggestion, get told the suggestion is wrong").
// ---------------------------------------------------------------------------

test("PROPERTY: every `Did you mean` suggestion satisfies the rule that produced it", () => {
  const bad = [
    "bash",
    "read",
    "mcp_memory_search",
    "mcp-memory-search",
    "mcp_memory_*",
    "mcp__[^_]+__[^_]+",
    "mcp__\\w+__\\w+",
    "mcp__memory_search",
    "^mcp__srv$",
  ];
  let suggestions = 0;
  for (const matcher of bad) {
    const findings = noFindings(matcher);
    assert.equal(findings.length, 1, `${matcher} should produce one finding`);
    const { suggestion } = findings[0];
    if (suggestion === undefined) continue;
    suggestions++;
    // Feed the advice straight back in: it must be clean, in ONE step.
    assert.deepEqual(
      noFindings(suggestion),
      [],
      `suggestion "${suggestion}" for "${matcher}" is itself rejected`,
    );
  }
  assert.ok(
    suggestions >= bad.length - 1,
    "nearly every finding advises a fix",
  );
});

// ---------------------------------------------------------------------------
// invalid-regex — its own finding, not a silent skip and not "never fires by
// shape". A matcher the engine can't compile can't match anything.
// ---------------------------------------------------------------------------

test('invalid-regex: "mcp__[a-" (unterminated class) → its own kind', () => {
  const findings = noFindings("mcp__[a-");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "invalid-regex");
  assert.match(findings[0].message, /not a valid regular expression/);
});

test('invalid-regex: a non-MCP matcher "Bash(" is caught too', () => {
  const findings = noFindings("Bash(");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "invalid-regex");
});

// ---------------------------------------------------------------------------
// FP-safety for the pattern path: a matcher that is narrow ON PURPOSE.
// ---------------------------------------------------------------------------

test('a server-scoped "mcp__memory__.*" is not "too narrow" (deliberate scope)', () => {
  assert.deepEqual(noFindings("mcp__memory__.*"), []);
});

test('a server+tool-scoped "mcp__memory__search.*" is reachable (derived probe)', () => {
  // The generic probes can't match it; the probe derived from its own literal
  // segments can — otherwise a correctly scoped matcher reads as unreachable.
  assert.deepEqual(noFindings("mcp__memory__search.*"), []);
});

test('a pattern in the server segment ("mcp__mem.*__list_events") is reachable', () => {
  assert.deepEqual(noFindings("mcp__mem.*__list_events"), []);
});

test('"mcp__srv__.*" pins a server, so the narrowness check does not apply', () => {
  // Guards the probe corpus itself: `srv` is the simple probe's server name, so
  // a matcher pinning it must not be flagged for missing the other probes.
  assert.deepEqual(noFindings("mcp__srv__.*"), []);
});

test('an anchored matcher that cannot reach the tool segment ("^mcp__srv$") is flagged', () => {
  const findings = noFindings("^mcp__srv$");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  assert.match(findings[0].message, /never fires/);
  assert.equal(findings[0].suggestion, "mcp__srv__.*");
});

test('an anchored but CORRECT matcher ("^mcp__srv__.*$") is clean', () => {
  // Anchors are stripped before reading the matcher's literal segments, so an
  // anchored server-scoped matcher gets the same verdict as its bare twin —
  // otherwise `^` alone would resurrect the "too narrow" false positive.
  assert.deepEqual(noFindings("^mcp__srv__.*$"), []);
  assert.deepEqual(noFindings("^mcp__.*__.*$"), []);
});

test('"mcp__memory_search" (no tool segment) → unreachable, keeps the server whole', () => {
  // The written segment is kept AS IS rather than split on its underscore: real
  // servers are named `Google_Calendar`, so `memory_search` is a plausible
  // server name and re-splitting it would invent a different server.
  const findings = noFindings("mcp__memory_search");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  assert.equal(findings[0].suggestion, "mcp__memory_search__.*");
});

test('an MCP-ish alternation ("mcp__a__b|Bash") is skipped (mixed arms are legitimate)', () => {
  assert.deepEqual(noFindings("mcp__a__b|Bash"), []);
});

test("an unrecoverable server segment falls back to spelling out the form", () => {
  const findings = noFindings("mcp_1_2");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "mcp-form");
  assert.equal(findings[0].suggestion, undefined);
  assert.match(findings[0].message, /mcp__<server>__<tool>/);
});

test("two different typos each produce their own finding (no cross-dedup)", () => {
  const entries: HookMatcherEntry[] = [
    { event: "PreToolUse", matcher: "bash" },
    { event: "PreToolUse", matcher: "read" },
  ];
  const findings = hookMatcherIssues(entries, [], d);
  assert.equal(findings.length, 2);
  const matchers = findings.map((f) => f.matcher).sort();
  assert.deepEqual(matchers, ["bash", "read"]);
});

// ---------------------------------------------------------------------------
// hookMatcherReach — the same measured semantics asked as "would the harness
// spawn this hook?", plus the two answers a boolean could not carry: a matcher
// the engine REJECTS, and a harness whose matchers are all regexes.
// ---------------------------------------------------------------------------

test("hookMatcherReach: a literal matcher is compared by equality", () => {
  assert.equal(hookMatcherReach("Bash", "Bash"), "selects");
  assert.equal(hookMatcherReach("Edit", "Bash"), "misses");
  // `rit` is a substring of `Write` and still does not fire — the measured rule.
  assert.equal(hookMatcherReach("rit", "Write"), "misses");
});

test("hookMatcherReach: a metacharacter matcher is an unanchored regex", () => {
  assert.equal(hookMatcherReach("Edit|Write", "Write"), "selects");
  assert.equal(hookMatcherReach("Edit|Write", "Bash"), "misses");
  assert.equal(hookMatcherReach("Ba.h", "Bash"), "selects");
});

test("hookMatcherReach: no matcher and a match-all select everything", () => {
  assert.equal(hookMatcherReach(null, "Bash"), "selects");
  // MEASURED against claude 2.1.263, marker file as the oracle. `**` is
  // deliberately absent — see the next test.
  for (const all of ["", "*", ".*"])
    assert.equal(hookMatcherReach(all, "Bash"), "selects");
});

test("hookMatcherReach: `**` is NOT a match-all — the harness ignores it", () => {
  // 🔴 It sat in MATCH_ALL on no evidence, and that direction MANUFACTURES AN
  // ACCUSATION: a guard registered under `**` came back "measured, allows 0/7"
  // — reported as letting seven disasters through — when claude 2.1.263 never
  // spawns it at all (3 runs of 3, with `.*` as the in-run control). Pinned
  // against the real binary in src/hook-matcher-delivery.test.ts.
  assert.equal(hookMatcherReach("**", "Bash"), "uncompilable");
  // …and the lint rule says the same thing about it, from the same set.
  const [finding] = hookMatcherIssues(
    [{ event: "PreToolUse", matcher: "**" }],
    [],
    d,
  );
  assert.equal(finding?.kind, "invalid-regex");
  assert.match(finding?.message ?? "", /never fires/);
});

test("hookMatcherReach: an UNCOMPILABLE matcher is its own answer, not a select", () => {
  // The one a boolean got wrong. `Bash(` is what `invalid-regex` already reports
  // as "the harness can't compile it, so the hook never fires" — so answering
  // "selects" here manufactures a run the harness never performs.
  assert.equal(hookMatcherReach("Bash(", "Bash"), "uncompilable");
  assert.equal(hookMatcherReach("Bash[", "Bash"), "uncompilable");
});

test("hookMatcherReach: a regex-style harness has no literal shortcut", () => {
  // Codex declares `matcherStyle: "regex"` — every matcher is a regex there, so
  // `ash` matches `Bash` and Claude Code's equality rule must not be applied.
  assert.equal(hookMatcherReach("ash", "Bash", "regex"), "selects");
  assert.equal(hookMatcherReach("ash", "Bash", "exact"), "misses");
  assert.equal(hookMatcherReach("ash", "Bash"), "misses");
  assert.equal(hookMatcherReach("Edit", "Bash", "regex"), "misses");
});

test("hookMatcherReach: a glob wildcard is uncompilable on a regex harness", () => {
  // `*` is Claude Code's documented match-all; it is not a regex, so a harness
  // that compiles every matcher cannot build it. Refusing to score beats
  // assuming a second harness special-cases the same spelling.
  assert.equal(hookMatcherReach("*", "Bash", "regex"), "uncompilable");
  assert.equal(hookMatcherReach(".*", "Bash", "regex"), "selects");
  assert.equal(hookMatcherReach(null, "Bash", "regex"), "selects");
});
