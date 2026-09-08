/**
 * Compiled hooks — a hook as a CONSTRAINED TYPED PROGRAM, not arbitrary shell.
 *
 * The pure core behind the public `vigiles/hook` surface (re-exported in
 * `src/hook.ts`; compiled by `vigiles compile`, run by `vigiles hook-runtime
 * run-program`). A hook today is opaque shell (`bash guard.sh`) —
 * un-analyzable (Rice), and the author hand-writes the fragile parts (exit code,
 * JSON field, a `grep` matcher) that the verified #1 pains come from. Invert it:
 * the author writes a PURE typed function `(event) => Decision` against a CLOSED
 * API; vigiles compiles it. The constraint ELIMINATES whole bug classes by
 * construction and buys testability / safety / matching / portability:
 *
 *  - TESTABILITY: `decide` is a pure fn — unit-test in-process, no subprocess, no
 *    exit-code/JSON plumbing. The false-confidence bug class (exit 1≠2, wrong field)
 *    is UNREPRESENTABLE — the author never writes the protocol; `compile` emits it.
 *  - SAFETY: capability = API surface. `checkHookImports` rejects any import outside
 *    `vigiles/hook` at compile (so the hook can't reach `child_process`/`net`), and
 *    `stampHook`/`verifyHookStamp` make the compiled artifact TAMPER-EVIDENT (the
 *    integrity.ts pattern) — a hand-edit that smuggles a capability breaks the stamp.
 *  - MATCHING: `command.runs("git push", { force })` is AST-backed (leafCommands),
 *    so it catches `cd x && git push -f` that the native `Bash(git:*)` glob (#30519)
 *    and a hand-written `grep` both miss.
 *  - PORTABILITY: one program → each harness's protocol (CC exit-2 here; Codex /
 *    OpenCode via the HookProtocol port later — OpenCode hooks ARE in-process TS).
 *
 * Pure core, harness-neutral. HONEST SCOPE (kept in every doc): compile/verify fix
 * the hook's AUTHORING + LOGIC, not the harness's DELIVERY. #34692 (a subagent's
 * calls never reaching PreToolUse) is FIXED as of CC 2.1.241 — measured on a stock
 * install, pinned by src/subagent-delivery.test.ts. SCOPE of that measurement:
 * headless `claude -p` only — interactive is unmeasured, and depth-2 subagent
 * nesting does not occur there at all. A gate is STILL a strong default
 * rather than an unbypassable wall, because a model can route around a tool
 * entirely (#45427 / #32376). Limits (buy-in, node-startup latency) +
 * full record in research/hook-pain-points.md.
 */
import {
  leafCommands,
  leafCommandsNormalized,
  classifyBashCommand,
  type BashEffect,
  type NormalizedLeaf,
} from "./bash-effects.js";
import { sha256short, assertNever, type SHA256Hash } from "./hash.js";
/**
 * `@iarna/toml` is required LAZILY, at the one call site that serializes a Codex
 * TOML settings block — never at module load. MEASURED 2026-09-08 (Node 22.22.2,
 * `tools/measure-hook-startup.mjs`): the top-level import cost 56 ms of a
 * ~170 ms `require("dist/core/hook-program.js")`, and this module is on the hot
 * path of `vigiles hook-runtime run-program`, which runs on EVERY matching tool
 * call. A hook DECIDES; it never serializes a settings block, so it paid 56 ms
 * per tool call for a compile-time dependency. Keep it a call-site require —
 * hoisting it back to the top is the regression, and `src/hook-runtime-graph.test.ts`
 * fails if `@iarna/toml` reappears in a decision's module graph.
 */
const stringifyToml = (value: unknown): string =>
  (require("@iarna/toml") as typeof import("@iarna/toml")).stringify(
    value as never,
  );
import type { HarnessDialect } from "./dialect.js";
import type { HookProtocol } from "./hook-protocol.js";
import { verifyHookEvents, authoringIssues } from "./hook-events.js";
import { verifyToolContract } from "./tool-contract.js";
import { HARNESS_CONFIG_FILES } from "./merge-conflict.js";
import {
  unknownProviders,
  unsafeInlineProviders,
  BUILTIN_PROVIDERS,
  type ProviderName,
  type NeedSpec,
  type HookCtx,
} from "./hook-providers.js";
import {
  admissibleWrites,
  type StateFact,
  type StateWrite,
} from "./hook-state.js";

/**
 * The erased runtime shape of a gathered context. Author-facing types keep the
 * precise `HookCtx<N>`; the decode functions re-narrow and cast.
 */
type RawCtx = Record<string, string | boolean | StateFact>;

/**
 * Does `name` match a hook's declared tool list, under the SAME semantics as the
 * matcher the compiler emits for it?
 *
 * 🔴 IT DID NOT, AND THE DISAGREEMENT WAS SILENT. `hookRouting` joins a react's
 * tools with `|` and emits that as the harness matcher, and a Claude Code matcher
 * is a REGEX — `Edit|Write|MultiEdit` only works because it is one. The runtime
 * meanwhile compared with `Array.includes`, i.e. exact string equality. So a hook
 * declaring a tool FAMILY compiled fine, was wired up fine, was routed to by the
 * harness fine, and was then dropped by vigiles' own filter without a word.
 *
 * MEASURED 2026-08-12 against the real runtime, before the fix:
 *
 *   $ echo '{"tool_name":"mcp__4f54037d-0499__list_events",…}' \
 *       | vigiles hook-runtime run-program mcp-family.hook.mjs
 *   exit=0                       # silence — react() never ran
 *   $ echo '{"tool_name":"mcp__.*",…}' | …
 *   FIRED on mcp__.*             # fires only for a tool LITERALLY named "mcp__.*"
 *
 * That is the false-confidence class this whole subsystem exists to eliminate,
 * living inside the subsystem. The live evidence that the harness really does
 * route these: the knowledge base has shipped `"matcher": "mcp__.*"` in
 * `.claude/settings.json` for months and its stamp file was last written the
 * morning this was measured. The MCP server's id changes per session, so an exact
 * list cannot be written down — a family matcher is the only correct spelling.
 *
 * Anchored `^(…)$` so a pattern cannot match a longer tool name by accident, and
 * identical to `includes` for ordinary names, which contain no metacharacters.
 * An unparseable pattern is rejected at COMPILE ({@link invalidToolPatterns}), so
 * the fallback here is unreachable in a compiled hook and exists only so that a
 * hand-constructed one degrades to exact matching rather than throwing mid-event.
 */
export function matchesTool(tools: readonly string[], name: string): boolean {
  // An EMPTY list matches NOTHING. Found by a mutation that was meant to disable
  // tool-less reacts and didn't: with no tools the joined pattern is `^()$`,
  // which matches the EMPTY STRING — and a tool-less event's name is the empty
  // string. Without this line `tools()` would quietly be a catch-all on exactly
  // the events where a react has no tool to check. Declaring nothing must mean
  // nothing, not everything.
  if (tools.length === 0) return false;
  if (tools.includes(name)) return true;
  try {
    return new RegExp(`^(${tools.join("|")})$`).test(name);
  } catch {
    return false;
  }
}

/** Regex metacharacters — an entry containing one is a PATTERN, not a name. */
const REGEX_META = /[.*+?^${}()|[\]\\]/;

/** Tool patterns that are not valid regexes — rejected at compile, see {@link matchesTool}. */
export function invalidToolPatterns(tools: readonly string[]): string[] {
  return tools.filter((t) => {
    try {
      new RegExp(`^(${t})$`);
      return false;
    } catch {
      return true;
    }
  });
}

// ---------------------------------------------------------------------------
// The closed vocabulary (this is the entire surface a hook author may touch)
// ---------------------------------------------------------------------------

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly reason: string };

export const allow = (): Decision => ({ kind: "allow" });
export const deny = (reason: string): Decision => ({ kind: "deny", reason });
export const ask = (reason: string): Decision => ({ kind: "ask", reason });

/**
 * Whether a gate BLOCKS on a `deny` (`enforce`, the default) or only RECORDS what
 * it WOULD block while letting everything through (`observe` — the shadow / rollout
 * mode: trust a new gate by watching it first, then promote to `enforce`). This is
 * the WAF "shadow mode" pattern, the one essential mode (block vs don't-block-but-
 * record) — not a vocabulary of on-fail actions. HARNESS-NEUTRAL by construction:
 * observe just exits 0 and writes a local record, so it behaves identically on
 * Claude Code and Codex (no harness-specific field names involved).
 */
export type HookMode = "enforce" | "observe";

/** A gate's runtime ACTION after applying its {@link HookMode} to its {@link Decision}. Pure. */
export type GateAction =
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "ask"; readonly reason: string }
  | {
      readonly kind: "observe";
      readonly would: "deny" | "ask";
      readonly reason: string;
    }
  | { readonly kind: "allow" };

/**
 * Map a gate's {@link Decision} + {@link HookMode} to what the runtime actually does.
 * `enforce`: deny→block (exit 2), ask→ask, allow→allow. `observe`: a deny/ask is
 * recorded as a no-op `observe` (would-have-blocked) and allowed; allow stays allow.
 * Pure, so a test asserts "in observe mode this deny does NOT block" with no process.
 */
export function gateAction(
  decision: Decision,
  mode: HookMode = "enforce",
): GateAction {
  if (mode === "observe")
    return decision.kind === "allow"
      ? { kind: "allow" }
      : { kind: "observe", would: decision.kind, reason: decision.reason };
  switch (decision.kind) {
    case "deny":
      return { kind: "block", reason: decision.reason };
    case "ask":
      return { kind: "ask", reason: decision.reason };
    case "allow":
      return { kind: "allow" };
    default:
      return assertNever(decision);
  }
}

/**
 * WHERE A REACT'S `notice` CAN ACTUALLY ARRIVE — the react-side twin of
 * {@link gateAction}, and pure for the same reason: the runtime and a test must
 * agree about delivery without either of them running a harness.
 *
 * 🔴 THE DEFECT THIS EXISTS TO CLOSE, MEASURED 2026-09-07 BY THIS REPO'S OWN
 * FIRST COMPILED HOOK. `notice(…)` was written to stderr and nothing else. Per
 * Claude Code's hooks documentation, stderr from a hook that exits 0 "goes to
 * the debug log only, never the transcript, and Claude never sees it" — and a
 * react ALWAYS exits 0, because its type has no `deny`. So a notice reached
 * NOBODY: not the model, not the user, not the transcript. `docs/compiled-hooks.md`
 * stated the MECHANIC ("notice writes to stderr") and never the CONSEQUENCE, so
 * the role looked healthy while delivering nowhere — precisely the
 * false-confidence class compiled hooks exist to eliminate, inside the
 * implementation of compiled hooks.
 *
 * The fix is the mechanism the shipped nudges already use:
 * `hookSpecificOutput.additionalContext` on STDOUT. Two candidates were
 * considered and one is a trap:
 *
 * - **exit 2.** The host's per-event table does show `PostToolUse` stderr to the
 *   model on exit 2. But {@link HookProtocol.blockExitCode} IS 2 — it is the
 *   DENY channel. Spending it on a role whose type-level guarantee is "can never
 *   block" would make that guarantee a lie on every other event. Rejected.
 * - **`additionalContext`.** Already proven on this event by the shipped refs
 *   nudge, shape shared across harnesses, and the per-harness half is exactly
 *   {@link HookProtocol.injectableEvents} — a fact the port already carries and
 *   the conformance kit already checks. Chosen.
 *
 * `injectableEvents` is INJECTED rather than read from a Claude Code literal, so
 * this stays harness-agnostic (`core ⊄ adapter`): a Codex react on `PostToolUse`
 * is delivered by the same code path, and an event neither harness injects is
 * reported `undeliverable` rather than silently dropped.
 */
export type NoticeDelivery =
  /** The notice can reach the agent as injected context on this event. */
  | { readonly kind: "inject"; readonly context: string }
  /**
   * A notice on an event this harness does NOT inject. It still goes to stderr
   * (the debug log), but nothing surfaces it — so the CALLER must say so out
   * loud rather than treat this as success. Carrying the message means the
   * caller never has to re-derive which reaction it was talking about.
   */
  | { readonly kind: "undeliverable"; readonly message: string }
  /** Not a notice (a `run` or `nothing`) — nothing to deliver. */
  | { readonly kind: "none" };

/**
 * Decide how a {@link Reaction}'s notice reaches the agent on `on`, given the
 * events this harness injects. Pure — no I/O, no process, no harness literal.
 */
export function noticeDelivery(
  reaction: Reaction,
  on: string,
  injectableEvents: readonly string[],
): NoticeDelivery {
  if (reaction.kind !== "notice") return { kind: "none" };
  return injectableEvents.includes(on)
    ? { kind: "inject", context: reaction.message }
    : { kind: "undeliverable", message: reaction.message };
}

/** An AST-backed view of a Bash command — the author never writes a regex. */
export interface CommandView {
  readonly raw: string;
  /** True iff a leaf command runs `program` (e.g. "git push"), optionally with --force/-f. */
  runs(program: string, opts?: { readonly force?: boolean }): boolean;
  /** True iff the command is provably side-effecting (bash-effects classifier). */
  isSideEffecting(): boolean;
  /**
   * True iff a leaf command MENTIONS a path under one of the prefixes (e.g.
   * `~/.ssh`, `.env`) — the secret-read / sensitive-path matcher. Sees the path
   * however the command is wrapped (`cd x && cat ~/.ssh/id_rsa`).
   *
   * MENTIONS, not writes. `grep -c x notes/S.md` touches `notes` — so does
   * `rm -rf notes`. Pairing this with {@link isSideEffecting}, which classifies
   * the WHOLE command line, does NOT recover the difference: a plain read whose
   * line happens to be side-effecting for an unrelated reason (`grep -c x
   * notes/S.md 2>/dev/null`) matches both and gets blocked. To gate WRITES to a
   * directory, use {@link writesTo}; conflating the two is the trap.
   *
   * OVER-INCLUSIVE ON PURPOSE, AND THE OPPOSITE WAY ROUND FROM {@link
   * PathView.under}. This is a DENYLIST primitive — every caller spells
   * `touches(secret) ? deny() : allow()` — so a miss is an ALLOW, not silence. An
   * unprovable answer is therefore reported as a MATCH: a token that could name
   * something under the prefix under some root or some `cd` matches, and the gate
   * blocks. See {@link prefixVerdict} for the three answers and {@link
   * matchesPrefix} for the two biases.
   */
  touches(prefixes: readonly string[]): boolean;
  /**
   * True iff a leaf command CREATES OR MODIFIES a file under one of the prefixes
   * — the "don't let Bash write here" matcher, and the precise counterpart to
   * {@link touches}. Two sources, both AST-backed:
   *
   * - **Redirection targets** — `cmd > f`, `cmd >> f`, `cmd >| f`, `cmd &> f`.
   *   This is the single most common write shape, and it lives on the statement,
   *   not in any argv.
   * - **File-writing programs**, at the argv positions that actually name the
   *   file written: `sed -i`, `cp`/`mv`/`install` (destination), `tee`, `dd of=`,
   *   `truncate`, `shred`.
   *
   * A path merely READ never matches — `cat a/paper.md`, `grep x a/paper.md`,
   * `cp a/paper.md /tmp/x` (the source is read, `/tmp/x` is the write) are all
   * false for `writesTo(["a"])`. Quoting is handled by the parser, so a write
   * QUOTED inside another command does not match: in
   * `echo 'echo y > a/paper.md' > /tmp/note.txt` the only real target is
   * `/tmp/note.txt`.
   *
   * Deletion is a different question and is deliberately NOT reported here —
   * pair with `runs("rm")` if a gate cares about removal too.
   *
   * Exactly `writeTargets(prefixes).length > 0`, and implemented as that — reach
   * for {@link writeTargets} when the gate needs to know WHICH file.
   */
  writesTo(prefixes: readonly string[]): boolean;
  /**
   * The write targets of this command that fall under one of the prefixes — the
   * "WHICH file is written" counterpart to {@link writesTo}. Same two AST-backed
   * sources (redirection targets + file-writing programs' argv positions), same
   * denylist bias (an undecidable placement is INCLUDED).
   *
   * Spelling is as-written after normalization — quote-unwrapped,
   * `$HOME`-canonicalized, and resolved against the leaf's own chdir wrapper
   * (`env -C dir sed -i x` reports `dir/x`) — in order of appearance, exact
   * duplicates collapsed. Filter by basename/suffix; never re-match the prefixes
   * by hand, because hand-rolled prefix matching is the exact source of the
   * trailing-slash, absolute-path and root-blindness defects this vocabulary
   * exists to remove.
   *
   * An empty array ⇔ `writesTo(prefixes) === false`, so the natural
   * `writeTargets(P).some(pred)` needs no emptiness check to behave correctly.
   *
   * `prefixes` is REQUIRED and there is no unfiltered overload: the raw list
   * does not cross the API boundary, because a consumer holding it has to
   * re-implement the matching that {@link prefixVerdict} exists to own.
   */
  writeTargets(prefixes: readonly string[]): readonly string[];
  /**
   * True iff the command pipes into a BARE shell interpreter (`curl … | sh`,
   * `… | bash -s`) — the remote-code-execution shape. High-signal: a shell leaf
   * WITH a script-file argument (`sh deploy.sh`) is NOT flagged; only a shell
   * reading from stdin is, which only happens downstream of a pipe.
   */
  pipesToShell(): boolean;
}

const FORCE_FLAG = /^-(?:-force$|[a-z]*f[a-z]*$)/;
const hasForce = (argv: readonly string[]): boolean =>
  argv.some((a) => FORCE_FLAG.test(a));

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Does `argv` run `tokens` in order (head exact, rest present after it)? */
function runsSeq(argv: readonly string[], tokens: readonly string[]): boolean {
  if (argv[0] !== tokens[0]) return false;
  let i = 1;
  for (let j = 1; j < argv.length && i < tokens.length; j++) {
    if (argv[j] === tokens[i]) i++;
  }
  return i === tokens.length;
}

// ---------------------------------------------------------------------------
// Prefix matching — ONE rule, THREE answers, and the bias named at every call
//
// 🔴 THE TWO PRIMITIVES BUILT ON THIS WANT OPPOSITE DEFAULTS, AND ONE OF THEM
// FAILS OPEN WHEN IT GUESSES WRONG. `PathView.under` is an ALLOWLIST (confinement,
// coverage): an unprovable answer must be a MISS, so a gate fails closed and a
// nudge stays quiet. `CommandView.touches` / `CommandView.writesTo` are DENYLISTS:
// an unprovable answer must be a MATCH, or the gate waves the command through.
//
// MEASURED 2026-08-12, the reason this exists. `touches` compared a repo-relative
// prefix against a raw bash token, with no project root anywhere in `decideProgram`
// — exactly the root-blindness `pathView` had just been fixed for, except a miss
// here is an ALLOW. Against a real shipped guard (`paper-edit-guard.hook.ts` in a
// consumer repo, `CLAUDE_PROJECT_DIR` set, exit 2 = blocked):
//
//   sed -i s/a/b/ migratsiya/papers/x/paper.tex                  → 2  blocked
//   sed -i s/a/b/ /home/user/mine/migratsiya/papers/x/paper.tex  → 0  ALLOWED
//   cp /tmp/a     migratsiya/papers/x/paper.tex                  → 2  blocked
//   cp /tmp/a     /home/user/mine/migratsiya/papers/x/paper.tex  → 0  ALLOWED
//
// Spelling the path absolutely walked straight through the gate. (Redirects still
// blocked — that guard decodes its own redirect targets with a hand-written
// `includes("/" + p + "/")`, which is this bias, hand-rolled, by an author who
// happened to think of it. `dna-privacy-guard.hook.ts` is the other hand-patch:
// it declares `needs: ["git.root"]` purely to build `${root}/${DNA}` itself. Every
// gate whose author did not think of that was exposed.)
//
// The fix is one shared rule that cannot be resolved to a boolean without NAMING
// the bias: `matchesPrefix` takes `onUndecidable` with NO DEFAULT, so a future
// caller cannot inherit the wrong one silently — picking it is a `tsc` error away
// from being skipped. That is deliberate: the previous shape (a single boolean
// helper, `tokenUnder`, shared by an allowlist and two denylists) is precisely
// what let one bias serve three callers that do not agree on it.
// ---------------------------------------------------------------------------

/**
 * Where a path sits relative to a prefix — with an explicit third answer for the
 * case the two spellings cannot be reconciled.
 *
 * - `"under"` — the path was PLACED (made comparable to the prefix in the
 *   prefix's own spelling) and is at/under it. A fact, biased neither way.
 * - `"outside"` — either placed and not under it, or not placeable AND the
 *   prefix's segments appear nowhere in the path. Also a fact: no root and no
 *   `cd` could make this path be under this prefix.
 * - `"undecidable"` — not placeable, but the prefix's segments DO occur as a
 *   whole run in the path, so SOME project root or working directory would make
 *   it true. The answer callers must break with their own bias.
 */
type PrefixVerdict = "under" | "outside" | "undecidable";

/**
 * Collapse a {@link PrefixVerdict} to the boolean a matcher returns.
 *
 * `onUndecidable` HAS NO DEFAULT ON PURPOSE. The two callers need opposite
 * values, and the one that guesses wrong (`"miss"` for a denylist) fails OPEN —
 * the failure mode that made this refactor necessary. A default here would make
 * that bug reachable by omission, which is how it was reachable before.
 */
const matchesPrefix = (
  verdict: PrefixVerdict,
  onUndecidable: "match" | "miss",
): boolean =>
  verdict === "under" ||
  (verdict === "undecidable" && onUndecidable === "match");

/**
 * Trailing separators removed — EXCEPT the one that is the path itself.
 *
 * 🔴 THE CARVE-OUT IS THE RULE, NOT AN EDGE CASE, and skipping it fails
 * SILENTLY. Strip every trailing separator and the POSIX root `"/"` becomes
 * `""`, the Windows drive root `"C:/"` becomes `"C:"` — and `isAbsoluteRef`
 * reads a bare drive letter as RELATIVE. Nothing throws: an allowlist prefix of
 * `"C:/"` simply stops matching, so a confinement gate denies every path and a
 * react hook goes quiet, both looking like a correct decision.
 *
 * This lives here, in one place, because the same normalisation is applied to
 * two different things — the PREFIX being matched against, and the project ROOT
 * a path is resolved against (`run-hook.ts` imports it for the latter). Round 28
 * fixed the root and left the prefix; round 29 found the prefix. Two copies of a
 * rule is how the second one survives the fix to the first.
 */
export function trimTrailingSeparators(path: string): string {
  const sep = /[/\\]+$/.exec(path)?.[0];
  const trimmed = sep === undefined ? path : path.slice(0, -sep.length);
  return trimmed === "" || /^[A-Za-z]:$/.test(trimmed)
    ? trimmed + (sep?.[0] ?? "/")
    : trimmed;
}

/**
 * A prefix with its glob tail and trailing slash removed — `"src/**"`, `"src/"`
 * and `"src"` all mean the same directory.
 *
 * The trailing slash is not cosmetic: a prefix of `"papers/"` used to compare
 * against `"papers//"` and match NOTHING, a trap a shipped guard's own header
 * records having fallen into.
 */
const normalizePrefix = (prefix: string): string => {
  const stripped = prefix.replace(/\\/g, "/").replace(/\/?\*+$/, "");
  // 🔴 THE CATCH-ALL IS A SENTINEL, NOT A ROOT — and conflating them is a
  // regression I shipped in the previous commit. `"**"`, `"*"` and `"/"` all
  // reduce to an EMPTY base, which `prefixVerdict` answers `"under"` for
  // outright, no root required. Handing that empty string to
  // `trimTrailingSeparators` turned it into `"/"` — a genuine POSIX root — so a
  // catch-all suddenly demanded an absolute spelling and `under(["**"])` went
  // FALSE for every relative path with no root. A catch-all that denies
  // everything is the loudest possible version of this bug and it still
  // type-checked and passed the drive-root test beside it, because that test
  // supplied a root.
  //
  // The drive-letter carve-out below is the opposite case: `"C:"` is not a
  // catch-all, it is a real absolute root that must keep its separator to stay
  // absolute. Same helper, and only the empty case differs.
  if (/^[/\\]*$/.test(stripped)) return "";
  return trimTrailingSeparators(stripped);
};

/**
 * Case-insensitivity is a property of the FILESYSTEM, so it is decided by the
 * root — never by the operand being compared.
 *
 * 🔴 KEYING IT ON THE OPERAND COST A P1, and the shape is worth keeping in view.
 * The first version asked "does this string look drive-rooted?", which is true of
 * a root (`C:/repo`) and of an absolute prefix (`C:/repo/secrets`) but FALSE of a
 * repo-relative prefix (`secrets`). So under a Windows root, `C:/REPO/SECRETS/x`
 * resolved to the remainder `SECRETS/x`, was compared against `secrets`
 * case-sensitively, and `writesTo(["secrets"])` returned false — a denylist
 * allowing the protected write. The drive letter was known; it just never reached
 * the comparison that needed it.
 *
 * The asymmetry is unchanged and load-bearing: fold only when the ROOT is
 * drive-rooted. POSIX is case-sensitive, so folding there would judge a path from
 * `/REPO` to be inside `/repo` — a silent FALSE GRANT, the direction never taken.
 * With no root known, nothing is folded: an unprovable answer must not be turned
 * into a match by a guess about someone else's filesystem.
 */
const WINDOWS_ROOT =
  // Drive: `C:/x`, `C:\x`. UNC share: `//server/share`, `\\server\share`.
  // Extended-length prefixes `//?/C:/x` and `//?/UNC/server/share` reduce to the
  // two above once `//?/` (and its `UNC/` marker) is consumed — which is why
  // they are alternatives here rather than separate cases.
  /^(?:[A-Za-z]:|[/\\]{2}(?:\?[/\\]+(?:UNC[/\\]+)?)?(?:[A-Za-z]:|[^/\\]+[/\\]+[^/\\]+))/;

/**
 * HOW THIS LIST IS DECIDED, because a table without that note is how the last
 * three rounds happened: Windows absolute paths have exactly two root forms —
 * a drive (`C:`) and a UNC share (`//server/share`) — plus the extended-length
 * `//?/` prefix, which is a spelling OF those two, not a third. Anything else
 * (a relative path, a POSIX absolute path) is not a Windows root.
 *
 * ⚠️ The miss direction is stated rather than implied: an unrecognised root means
 * NO folding, so a denylist can miss on casing alone. That is the wrong
 * direction, and it is accepted only because the alternative — folding whenever
 * we are unsure — is a false GRANT on Linux, where `/repo/Secrets` and
 * `/repo/secrets` are two different files. If a genuine third root form turns
 * up, it belongs in the regex above, not in a caller.
 */
const caseInsensitiveFs = (root: string | undefined): boolean =>
  root !== undefined && WINDOWS_ROOT.test(root);

const foldWhen = (value: string, insensitive: boolean): string =>
  insensitive ? value.toLowerCase() : value;

/** Is `candidate` the prefix itself, or something below it? Boundary-aware. */
const isAtOrUnder = (
  rawCandidate: string,
  rawBase: string,
  insensitive = false,
): boolean => {
  // An absolute drive-rooted BASE names a Windows filesystem by itself, even when
  // the caller could not say so (`under(["C:/x"])` with no root).
  const fold = insensitive || WINDOWS_ROOT.test(rawBase);
  const base = foldWhen(rawBase, fold);
  const candidate = foldWhen(rawCandidate, fold);
  return (
    candidate === base ||
    // A base that IS a separator (`"/"`, `"C:/"` — see `trimTrailingSeparators`)
    // already carries the boundary, so appending another looks for `"C://"` and
    // matches nothing. Keeping the carve-out without this line trades one silent
    // never-match for another.
    candidate.startsWith(/[/\\]$/.test(base) ? base : base + "/")
  );
};

/**
 * Could this path be under this prefix under SOME root or working directory?
 *
 * The tractable stand-in for "unprovable": the prefix's segments occur as a whole
 * contiguous run somewhere in the path. `/home/u/mine/migratsiya/papers/x.tex`
 * could be `migratsiya/papers/x.tex` in a repo rooted at `/home/u/mine`; the
 * leading directories are exactly what we cannot rule out without a root.
 *
 * A leading `/` is stripped from the prefix first, so an ABSOLUTE prefix can
 * still be recognized inside a relative token (`/etc` vs `etc/passwd` under an
 * unknown `cd`).
 *
 * ⚠️ WHAT THIS STILL MISSES, stated rather than implied — in both cases the
 * verdict is `"outside"`, so the denylist misses too:
 *
 * 1. The segments must be PRESENT. `cd migratsiya && sed -i s/a/b/ papers/x.tex`
 *    names only `papers/x.tex`, so a prefix of `migratsiya/papers` finds nothing.
 *    Resolving a leaf's argument against a preceding `cd` is a parser change, not
 *    a matcher one; it is the blind spot both shipped guards already document.
 * 2. An ABSOLUTE prefix against a RELATIVE token with NO root — `touches(["/r/
 *    health/data/dna"])` vs the token `health/data/dna/g.txt`. The needle is the
 *    longer string, so containment cannot see it. Deliberately not chased: the
 *    runtime always supplies a root ({@link projectRootOf} falls back to the
 *    event's `cwd`, which Claude Code sends on every payload), and a gate that
 *    builds absolute prefixes at all builds them FROM a root, so by construction
 *    it has one. Widening this arm would also cost precision in the case that
 *    matters — a token that IS placeable would start matching on segments alone.
 */
const mightBeUnder = (
  path: string,
  base: string,
  insensitive = false,
): boolean => {
  const needle = base.replace(/^\/+/, "").replace(/^[A-Za-z]:\//, "");
  if (needle === "") return true;
  const raw = path.replace(/\\/g, "/").replace(/^\.\//, "");
  // Same fold, same rule: keyed on the BASE, which is what decides whether a
  // Windows filesystem is in play. Left case-sensitive here, the denylist's
  // "could this be under it?" fallback misses on casing alone.
  const fold = insensitive || WINDOWS_ROOT.test(base);
  const p = foldWhen(raw, fold);
  const n = foldWhen(needle, fold);
  return (
    isAtOrUnder(p, n, fold) || p.endsWith("/" + n) || p.includes("/" + n + "/")
  );
};

/**
 * The verdict for ONE path against ONE prefix, given the project root.
 *
 * A prefix is matched in ITS OWN spelling — a repo-relative prefix against the
 * path made repo-relative, an absolute prefix against the path made absolute —
 * because those are the only two comparisons that mean anything. When the needed
 * spelling cannot be produced (an absolute path with no root, a path resolving
 * outside the root, a relative path with no root to absolutize it), the path was
 * not PLACED, and the answer falls to {@link mightBeUnder}.
 *
 * Note what does NOT happen: a placed path that is not under the prefix comes
 * back `"under"`-less but is still offered to `mightBeUnder`, so a denylist
 * over-blocks a sibling checkout's `…/migratsiya/papers/…` rather than silently
 * allowing it. That over-block is the chosen error direction, not an oversight —
 * `under` never sees it, because `under` accepts `"under"` only.
 */
function prefixVerdict(
  path: string,
  prefix: string,
  root: string | undefined,
): PrefixVerdict {
  const base = normalizePrefix(prefix);
  if (base === "") return "under"; // `"/"`, `"**"` — everything is under it
  const slashed = path.replace(/\\/g, "/");
  const placed = isAbsoluteRef(base)
    ? absoluteSpelling(slashed, root)
    : relativeSpelling(slashed, root);
  const insensitive = caseInsensitiveFs(root);
  if (placed !== undefined && isAtOrUnder(placed, base, insensitive))
    return "under";
  return mightBeUnder(slashed, base, insensitive) ? "undecidable" : "outside";
}

/** A leaf whose head is a shell reading stdin (no script-file argument). */
function isBareShellLeaf(argv: readonly string[]): boolean {
  return (
    SHELLS.has(argv[0] ?? "") && argv.slice(1).every((a) => a.startsWith("-"))
  );
}

// ---------------------------------------------------------------------------
// writesTo — which argv positions of a known file-writing program name the file
// it WRITES. Deliberately small and high-precision: an unlisted head contributes
// no write target (the redirection half above already covers `cmd > f`), so this
// never guesses. Anything that only READS its operands (cat/grep/…) is absent by
// construction.
// ---------------------------------------------------------------------------

/** Options that consume a SEPARATE following token, per writer head. */
const WRITER_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sed: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  tee: new Set(["-p", "--output-error"]),
  install: new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-t"]),
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  shred: new Set(["-n", "--iterations", "-s", "--size"]),
  dd: new Set(),
};

/** The non-option operands of a leaf, with each option's separate value skipped. */
function operandsOf(leaf: NormalizedLeaf): string[] {
  const valueOpts = WRITER_VALUE_OPTS[leaf.head] ?? new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < leaf.args.length; i++) {
    const a = leaf.args[i];
    if (a === undefined) continue;
    if (a === "--") {
      out.push(...leaf.args.slice(i + 1).filter((x) => x !== undefined));
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      if (valueOpts.has(a)) i++; // this option's value is not an operand
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * The paths a leaf WRITES, by head. Empty for anything not known to write —
 * including every read-only command, so a read can never be mistaken for a write.
 */
function writeTargetsOf(leaf: NormalizedLeaf): string[] {
  const operands = operandsOf(leaf);
  switch (leaf.head) {
    case "sed":
      // Only `sed -i` edits in place; otherwise it writes to stdout. The first
      // operand is the SCRIPT unless it was supplied via -e/-f.
      if (!leaf.hasFlag("i", "in-place")) return [];
      return leaf.hasFlag("e", "expression", "f", "file")
        ? operands
        : operands.slice(1);
    case "cp":
    case "mv":
    case "install":
      // The LAST operand is the destination; every earlier one is read.
      return operands.length >= 2 ? operands.slice(-1) : [];
    case "tee":
    case "truncate":
    case "shred":
      return operands;
    case "dd":
      // `dd if=src of=dest` — only the output file is written.
      return leaf.args.flatMap((a) =>
        a.startsWith("of=") ? [a.slice(3)] : [],
      );
    default:
      return [];
  }
}

/**
 * A write target as it lands on disk, given the chdir wrapper the leaf ran under
 * (`env -C migratsiya sed -i s/a/b/ papers/x.tex` writes `migratsiya/papers/x.tex`).
 *
 * Absolute targets and `~`-rooted ones already name their directory and are
 * returned untouched. The join itself is {@link resolveRef} rather than a fresh
 * `a + "/" + b`, because two functions normalising the same string differently is
 * the defect class this file keeps finding.
 */
const underChdir = (target: string, chdir: string | null): string =>
  chdir === null || target === "" || target.startsWith("~")
    ? target
    : resolveRef(chdir, target);

/**
 * An AST-backed view of a Bash command.
 *
 * @param raw - the command line as the tool event carried it.
 * @param root - the project root repo-relative prefixes resolve against, from
 *   the runtime ({@link projectRootOf}: `$CLAUDE_PROJECT_DIR`, else the event's
 *   own `cwd`, never `process.cwd()`). Omitting it does NOT disarm the denylist
 *   matchers — without a root an absolute token is `"undecidable"` rather than
 *   placeable, and {@link CommandView.touches} treats that as a match. It does
 *   cost precision: with a root, `/somewhere-else/notes/x` is provably not this
 *   repo's `notes`; without one it can only be over-blocked.
 */
export function commandView(raw: string, root?: string): CommandView {
  const leaves = leafCommands(raw);
  // The operation-normalized leaves carry the redirections (and quote-unwrapped,
  // wrapper-resolved argv) that `writesTo` needs; `leafCommands` cannot see them.
  const normalized = leafCommandsNormalized(raw);
  const allWriteTargets = normalized.flatMap((leaf) => [
    // 🔴 A REDIRECTION IS NOT JOINED ONTO THE LEAF'S CHDIR, AND THAT IS THE
    // SHELL'S RULE, NOT A SHORTCUT. `env -C dir cmd > out.txt` opens `out.txt`
    // in the SHELL's directory — the redirection happens before `env` ever runs
    // and `-C` only moves the process `env` execs. Joining here would report a
    // file the command never writes.
    ...leaf.redirects.flatMap((r) =>
      r.writes && r.target !== null ? [r.target] : [],
    ),
    // The wrapped program's own operands DO resolve against it — see
    // `NormalizedLeaf.chdir` for why the value was being read and discarded.
    ...writeTargetsOf(leaf).map((t) => underChdir(t, leaf.chdir)),
  ]);
  const matchedWriteTargets = (
    prefixes: readonly string[],
  ): readonly string[] => [
    ...new Set(
      allWriteTargets.filter((t) =>
        prefixes.some((p) => matchesPrefix(prefixVerdict(t, p, root), "match")),
      ),
    ),
  ];
  return {
    raw,
    runs(program, opts) {
      const tokens = program.split(/\s+/).filter(Boolean);
      // 🔴 READS RAW **AND** NORMALIZED ARGV — the same union `touches` already
      // uses, and for the same reason. This matcher read only `leaves` (raw), so
      // three ordinary rewrites walked past a guard that blocks the plain form.
      // MEASURED 2026-09-02 on the shipped dogfood artifact behind the public
      // 7/7 claim (`examples/harness/safe-bash-guard.mjs`):
      //   git push --force origin main            exit 2  blocked
      //   git push "--force" origin main          exit 0  ALLOWED
      //   sudo git push --force origin main       exit 0  ALLOWED
      //   /usr/bin/git push --force origin main   exit 0  ALLOWED
      // Across 30 shell-equivalent variants of the seven catalog seeds the guard
      // blocked 8. The seeds were 7/7 — the number was true and measured on the
      // only forms anyone had written down.
      //
      // The quoting case is the sharpest: `getLiteral` (bash-effects) returns
      // null for a quoted word, and `leafCommands` FILTERS nulls, so
      // `git push "--force" origin main` arrives as [git, push, origin, main] —
      // a NON-force push. The force check was answering correctly about an argv
      // that had already lost the flag.
      //
      // Force is asked of the NORMALIZED leaf via `hasFlag`, not by re-scanning
      // strings: short clusters are already split (`-rf`→r,f) and each flag is
      // recorded in both short and long form, so `-f` and `--force` are one
      // question. The raw half stays because it is what an exact-literal match
      // is for; neither half alone is enough, which is exactly what the comment
      // on `touches` says about its own union.
      const rawHit = leaves.some(
        (argv) =>
          runsSeq(argv, tokens) && (opts?.force ? hasForce(argv) : true),
      );
      if (rawHit) return true;
      // A FLAG named in the pattern is asked of `hasFlag`, not matched as a
      // literal token. The normalized leaf already records every flag in BOTH
      // short and long form, so `runs("git commit --no-verify")` also catches
      // `git commit -n` — which the literal path cannot, because `-n` is simply
      // a different string. Found by the generated battery on its first real
      // run: 72/73, and the one miss was exactly this
      // (`git commit -n -m 'skip hooks'`). The `{force:true}` option exists
      // because force needed this for `-f`; every other flag needed it too and
      // nobody noticed, since nobody wrote the short form down by hand.
      const flagTokens = tokens.filter((t) => t.startsWith("-"));
      const plainTokens = tokens.filter((t) => !t.startsWith("-"));
      return normalized.some(
        (leaf) =>
          runsSeq(leaf.argv, plainTokens) &&
          flagTokens.every((t) => leaf.hasFlag(t.replace(/^-+/, ""))) &&
          (opts?.force ? leaf.hasFlag("force", "f") : true),
      );
    },
    isSideEffecting: () => classifyBashCommand(raw) === "side-effecting",
    // Both of these are DENYLIST matchers, so both break an undecidable verdict
    // toward "match" — see the block above `PrefixVerdict` for the measurement
    // that made the opposite default a security hole.
    // 🔴 READS THE NORMALIZED ARGV, NOT THE RAW ONE, AND THAT IS THE FIX FOR A
    // REAL BYPASS. `leafCommands` keeps a word exactly as written, quotes and
    // all, so a token arrived as `"papers/x.tex"` — with the quote characters —
    // and matched no prefix at all. MEASURED end-to-end on a shipped guard:
    // `sed -i s/a/b/ migratsiya/papers/x/paper.tex` exited 2 (blocked) while
    // `sed -i s/a/b/ "migratsiya/papers/x/paper.tex"` exited 0. Quoting a path
    // is not an exotic evasion — it is what anyone writes for a path with a
    // space in it, so every denylist built on `touches` was one quote from open.
    // `writesTo` was already correct precisely because it reads `normalized`;
    // this is the same class as the other siblings this PR keeps finding, so
    // both denylists now read the SAME argv.
    touches: (prefixes) =>
      // 🔴 THE UNION IS THE FIX, AND EACH HALF COVERS THE OTHER'S BLIND SPOT.
      // Raw argv keeps a word exactly as written, so a QUOTED path arrives as
      // `"papers/x.tex"` and matches nothing — measured end-to-end on a shipped
      // guard: unquoted exited 2, quoted exited 0. Normalized argv unwraps the
      // quotes, but `stripWrappers` also CONSUMES wrapper options, so
      // `env -C secrets cat key` loses `secrets` entirely and a denylist on it
      // fails open. Reading only one of the two trades one bypass for the other;
      // that is exactly what the previous commit did, and it earned a P1.
      // A denylist over-matching costs an argument. Missing costs the write.
      [...leaves.map((argv) => argv.slice(1)), ...normalized.map((l) => l.args)]
        .flat()
        // `--chdir=secrets` is ONE token, so the path is invisible to a whole-token
        // comparison. Only the tail of an `--opt=value` word can be a path, so the
        // extra candidate is added rather than replacing the token.
        .flatMap((tok) =>
          /^-{1,2}[^=]+=/.test(tok)
            ? [tok, tok.slice(tok.indexOf("=") + 1)]
            : [tok],
        )
        .some((tok) =>
          prefixes.some((p) =>
            matchesPrefix(prefixVerdict(tok, p, root), "match"),
          ),
        ),
    // DERIVED, not a second implementation of the same rule. The boolean stays
    // because `writesTo(secrets) ? deny() : allow()` is the common gate shape,
    // but it is a PROJECTION of the list — one code path, so the two can never
    // drift the way `runs()` and `writesTo` did (one reads raw leaves, the other
    // normalized ones, and a gate built on both had a silent hole).
    writesTo: (prefixes) => matchedWriteTargets(prefixes).length > 0,
    writeTargets: matchedWriteTargets,
    // Same union, same reason: `curl … | /bin/sh` and `curl … | sudo sh` are a
    // pipe-to-shell, and a raw-only check misses both (`isBareShellLeaf` tests
    // the head literally, and the normalizer is what reduces `/bin/sh`→`sh` and
    // strips the wrapper).
    pipesToShell: () =>
      leaves.some(isBareShellLeaf) ||
      normalized.some((leaf) => isBareShellLeaf(leaf.argv)),
  };
}

/**
 * The typed event a Bash gate decides over. Generic over the declared context
 * `needs` (`N`) so `e.ctx` exposes ONLY the facts the hook declared — reading an
 * undeclared one is a `tsc` error. The default is the erased (all-providers)
 * shape used by the runtime/`AnyHook`.
 */
export interface BashToolEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  readonly tool: "Bash";
  readonly command: CommandView;
  /** Host-gathered, DECLARED read-only facts (git branch, …) — see `needs`. */
  readonly ctx: HookCtx<N>;
}

/** A hook program: where it fires + the pure decision. */
export interface HookProgram<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly on: string;
  /** `enforce` (default) blocks on a `deny`; `observe` records + allows. */
  readonly mode?: HookMode;
  /** Declared context providers the trusted runtime gathers into `e.ctx`. */
  readonly needs?: N;
  readonly decide: (e: BashToolEvent<N>) => Decision;
}

/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_defineHook` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `defineHook` without it and cannot tell it is provisional.
 */
export function experimental_defineHook<
  const N extends readonly NeedSpec[] = readonly [],
>(p: HookProgram<N>): HookProgram<N> {
  return p;
}

// ---------------------------------------------------------------------------
// Run the program against a raw PreToolUse event (the runtime half)
// ---------------------------------------------------------------------------

/**
 * Build the typed event from a raw PreToolUse event, then decide.
 *
 * `root` is the project root repo-relative prefixes in the hook resolve against,
 * threaded exactly as {@link decideFileGate} threads it: omitted, it falls back
 * to the event's OWN `cwd` (a payload field, so this stays pure and reads no
 * environment); the CLI passes {@link projectRootOf}, which prefers
 * `$CLAUDE_PROJECT_DIR`. Until 2026-08-12 no root reached here at all, and the
 * denylist matchers on {@link CommandView} were bypassable by spelling a path
 * absolutely — see the block above {@link PrefixVerdict} for the measurement.
 */
export function decideProgram<N extends readonly NeedSpec[]>(
  program: HookProgram<N>,
  rawEvent: {
    tool_name?: string;
    tool_input?: { command?: unknown };
    cwd?: unknown;
  },
  ctx: RawCtx = {},
  root: string | undefined = typeof rawEvent.cwd === "string"
    ? rawEvent.cwd
    : undefined,
): Decision {
  // A bash gate is Bash BY CONSTRUCTION — `BashToolEvent.tool` is the literal
  // "Bash" and every one of the 34 call sites in both repos wrote
  // `match: tool("Bash")`. The field carried no information and one real risk:
  // `match: tool("Edit")` type-checked, compiled, wired a PreToolUse matcher
  // `Edit`, fired on edits, built `commandView("")` from a missing
  // `tool_input.command`, found every predicate false and returned allow() — a
  // silently dead guard, which is the exact class the header above says this
  // subsystem eliminates. Worse, the comparison was `!==` while every sibling
  // role routes through `matchesTool`; that runtime/emit disagreement is the
  // one MEASURED and fixed for reacts on 2026-08-12 (see the header), and it
  // survived here on the flagship role. Removed 2026-09-08.
  if (rawEvent.tool_name !== "Bash") return allow();
  const command =
    typeof rawEvent.tool_input?.command === "string"
      ? rawEvent.tool_input.command
      : "";
  return program.decide({
    event: program.on,
    tool: "Bash",
    command: commandView(command, root),
    ctx: ctx as unknown as HookCtx<N>,
  });
}

/** Map a Decision to the CC hook exit code — the protocol the author never writes. */
export function decisionExitCode(d: Decision): number {
  return d.kind === "deny" ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Compile-time safety: capability = the API surface
// ---------------------------------------------------------------------------

const ALLOWED_IMPORT = "vigiles/hook";

/**
 * Reject any import/require outside `vigiles/hook` + textual escape hatches
 * (eval / Function / dynamic import). The hook's capabilities are then EXACTLY the
 * sanctioned API — it cannot reach `child_process`, `fs`, or the network. Returns
 * the offending specifiers/constructs (empty = clean). (Probe: a regex scan; a
 * production impl walks the TS AST.)
 */
export function checkHookImports(source: string): string[] {
  const out: string[] = [];
  const importRe =
    /\b(?:import|require)\s*(?:\(|[^'"]*from)?\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(importRe)) {
    if (m[1] !== ALLOWED_IMPORT) out.push(m[1]);
  }
  if (/\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(/.test(source)) {
    out.push("dynamic-eval");
  }
  return out;
}

export class HookCompileError extends Error {}

/** A compiled hook program: the harness block + a tamper-evident stamp. */
export interface CompiledHookProgram {
  readonly hooks: Record<
    string,
    readonly {
      /** Tool matcher — omitted for tool-less events (SessionStart/UserPromptSubmit). */
      readonly matcher?: string;
      readonly hooks: readonly {
        readonly type: "command";
        readonly command: string;
      }[];
    }[]
  >;
  /**
   * The rendered settings block to add to the harness's hooks config — JSON for
   * Claude Code (`.claude/settings.json`), TOML `[[hooks.<event>]]` for Codex
   * (`config.toml`). The CLI prints this; the structured `hooks` above is the
   * Claude-Code-shaped intermediate.
   */
  readonly settingsBlock: string;
  /** SHA-256 of the sanctioned source — the runtime refuses an artifact whose stamp differs. */
  readonly stamp: SHA256Hash;
}

/**
 * Per-harness emit inputs (all optional, default to Claude Code) — the ports the
 * CLI threads in from the resolved adapter. Keeps the core harness-agnostic:
 * core depends only on these interfaces, never an adapter (core ⊄ adapter).
 */
export interface CompileHookOptions {
  /** The command the emitted block routes the event to. */
  readonly gateCommand?: string;
  /** Validate `hook.on` against this harness's hook-event catalog (a typo won't compile). */
  readonly dialect?: HarnessDialect;
  /** Matcher style (exact vs anchored regex). Defaults to Claude Code's `"exact"`. */
  readonly hookProtocol?: HookProtocol;
  /** Settings encoding — `"json"` (Claude Code) or `"toml"` (Codex). From `PluginLayout.settingsFormat`. */
  readonly settingsFormat?: "json" | "toml";
  /** Names of registered providers (`.vigiles/providers/`) a `provider()` ref may resolve to. */
  readonly registeredProviders?: readonly string[];
}

/**
 * Every hook shape the closed vocabulary can express. `compileHookProgram`
 * (emit) and the runtime dispatch both range over this union.
 */
/**
 * The ERASED needs-generic for the {@link AnyHook} union. A gate's `decide`
 * carries `N` contravariantly (in the event param), so no single concrete
 * instantiation is a supertype of every authored hook (a built-in-needs hook and
 * an inline-needs hook have no common `HookProgram<N>`). `any` erases the context
 * generic for the runtime/union view; the decode functions re-narrow + cast `ctx`
 * (they never trust this type). Author-facing types keep the precise `N`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErasedNeeds = readonly any[];

/* eslint-disable @typescript-eslint/no-unnecessary-type-arguments -- ErasedNeeds
   (readonly any[]) is deliberate, NOT the default: the union must accept EVERY
   authored `N`, which the default (`readonly ProviderName[]`) cannot, because a
   gate's `decide` is contravariant in `N`. `any` makes the instantiation
   bivariant so a built-in-needs and an inline-needs hook both assign. */
export type AnyHook =
  | HookProgram<ErasedNeeds>
  | FileGateHook<ErasedNeeds>
  | PromptGateHook<ErasedNeeds>
  | StopGateHook<ErasedNeeds>
  | InjectHook<ErasedNeeds>
  | ReactHook<ErasedNeeds>;
/* eslint-enable @typescript-eslint/no-unnecessary-type-arguments */

/**
 * The runtime dispatch shapes. A bare {@link HookProgram} (no `role`) is a Bash
 * command gate; the role-keyed hooks carry their own shape. The runtime uses this
 * to pick the right decode + output (a gate exits 2, an inject prints
 * `additionalContext`, a react runs its classified command). `prompt-gate` and
 * `stop-gate` are gates on non-tool events — they decode the prompt / stop signal
 * and emit a `Decision` like the tool gates.
 */
export type DispatchKind =
  | "bash-gate"
  | "file-gate"
  | "prompt-gate"
  | "stop-gate"
  | "inject"
  | "react";

export function dispatchKind(hook: AnyHook): DispatchKind {
  if ("role" in hook) return hook.role === "gate" ? "file-gate" : hook.role;
  return "bash-gate";
}

/** A gate's {@link HookMode} (`enforce` default); non-gate roles report `enforce` too. */
export function hookMode(hook: AnyHook): HookMode {
  return "mode" in hook && hook.mode ? hook.mode : "enforce";
}

/** The context providers a hook declared via `needs` ([] if none / not a gate). */
export function hookNeeds(hook: AnyHook): readonly NeedSpec[] {
  return "needs" in hook && Array.isArray(hook.needs)
    ? (hook.needs as readonly NeedSpec[])
    : [];
}

/** Where a hook fires + its tool matcher (undefined for tool-less events). */
export function hookRouting(hook: AnyHook): {
  on: string;
  matcher?: string;
} {
  if ("role" in hook) {
    // inject / prompt-gate / stop-gate fire on a whole EVENT — no tool matcher.
    if (
      hook.role === "inject" ||
      hook.role === "prompt-gate" ||
      hook.role === "stop-gate"
    )
      return { on: hook.on };
    // A react MAY also be tool-less (Stop/SessionEnd) — same shape, same reason.
    if (hook.match === undefined) return { on: hook.on };
    return { on: hook.on, matcher: hook.match.tools.join("|") };
  }
  // Bash by construction — see decideProgram; the author no longer declares it.
  return { on: hook.on, matcher: "Bash" };
}

/** Apply a harness's matcher style to the neutral `A|B` matcher join. */
function styleMatcher(
  matcher: string | undefined,
  protocol: HookProtocol | undefined,
): string | undefined {
  if (matcher === undefined) return undefined;
  return protocol?.matcherStyle === "regex" ? `^(${matcher})$` : matcher;
}

/**
 * Render the settings block a user pastes into their hooks config. JSON for
 * Claude Code (the nested `{event:[{matcher,hooks:[{type,command}]}]}` shape);
 * TOML `[[hooks.<event>]]` with a flat `command` for Codex.
 */
function renderSettingsBlock(
  on: string,
  matcher: string | undefined,
  gateCommand: string,
  format: "json" | "toml",
): string {
  if (format === "toml") {
    const entry: Record<string, string> =
      matcher === undefined
        ? { command: gateCommand }
        : { matcher, command: gateCommand };
    return stringifyToml({ hooks: { [on]: [entry] } }).trim();
  }
  const entry =
    matcher === undefined
      ? { hooks: [{ type: "command", command: gateCommand }] }
      : { matcher, hooks: [{ type: "command", command: gateCommand }] };
  return JSON.stringify({ hooks: { [on]: [entry] } }, null, 2);
}

/**
 * Compile a hook program from its source. Runs the capability check FIRST (an
 * out-of-API import does NOT compile), validates the event against the target
 * harness (a typo won't compile), then stamps the source so the shipped artifact
 * is tamper-evident. The hook supplies the routing (event + matcher), which
 * differs per role — a tool gate matches its tool, a react matches its tools, an
 * inject (SessionStart) has no tool matcher at all.
 *
 * Harness-agnostic by injection: with no `opts` it emits the Claude Code block
 * (back-compatible); pass `{ dialect, hookProtocol, settingsFormat }` from a
 * resolved adapter and it emits that harness's block (e.g. Codex TOML + regex
 * matcher). Core never imports an adapter — only the port interfaces.
 */
export function compileHookProgram(
  source: string,
  hook: AnyHook,
  opts: CompileHookOptions = {},
): CompiledHookProgram {
  const violations = checkHookImports(source);
  if (violations.length > 0) {
    throw new HookCompileError(
      `hook program uses capabilities outside \`${ALLOWED_IMPORT}\`: ${violations.join(
        ", ",
      )} — only the sanctioned API is allowed (capability = API surface).`,
    );
  }
  const { on, matcher: rawMatcher } = hookRouting(hook);
  // A tool pattern that is not a valid regex cannot match under the semantics the
  // emitted matcher is read with, so it would compile to a hook that never fires.
  // Reject it here rather than let `matchesTool` fall back silently.
  if ("match" in hook && hook.match !== undefined && "tools" in hook.match) {
    const bad = invalidToolPatterns(hook.match.tools);
    if (bad.length > 0) {
      throw new HookCompileError(
        `invalid tool matcher pattern(s): ${bad.join(", ")} — a tool matcher is a ` +
          `regex (that is why "Edit|Write" works), so it must parse as one.`,
      );
    }
    // …and a VALID regex can still be a dead matcher. `tools("Edt")` parses
    // fine, wires a matcher `Edt`, and the hook never fires — the same defect
    // the event check below rejects, on the axis it did not cover.
    //
    // Only an entry with NO regex metacharacter is read as a literal tool NAME.
    // A matcher IS a regex — `tools("mcp__github__.*")` is correct and must not
    // be cross-referenced as a name — so the check is scoped to the spellings a
    // typo actually produces. MCP names are skipped inside verifyToolContract
    // itself (dialect.mcpToolPattern), so a fully-spelled server tool passes on
    // both counts.
    if (opts.dialect) {
      const literal = hook.match.tools.filter((t) => !REGEX_META.test(t));
      const badNames = authoringIssues(
        verifyToolContract(literal, opts.dialect),
      );
      if (badNames.length > 0) {
        throw new HookCompileError(badNames[0].message);
      }
    }
  }
  // A hook registered under an event the harness never fires is dead — reject
  // it. AUTHORING is a closed world (you are writing this hook now, against the
  // vigiles you have), so an unrecognised event is still an error — the typo
  // guarantee this exists for. What changed on 2026-08-17 is the catalog it
  // asks: this used to throw on `Setup`, `PostCompact`, `ConfigChange` and 19
  // other REAL events, because vigiles held 9 of the vendor's 31. The fix is the
  // right vocabulary, not a weaker check. A genuinely newer event still fails
  // here, and now says so — the message names vigiles's capture as the thing
  // that may be stale, instead of asserting the event does not exist.
  if (opts.dialect) {
    const fatal = authoringIssues(verifyHookEvents([on], opts.dialect));
    if (fatal.length > 0) {
      throw new HookCompileError(fatal[0].message);
    }
  }
  // A `needs` entry that isn't a built-in provider never resolves — reject it
  // (the typo-won't-compile guarantee, for JS authors the type can't reach).
  const needs = hookNeeds(hook);
  const unknownNeeds = unknownProviders(needs, opts.registeredProviders);
  if (unknownNeeds.length > 0) {
    throw new HookCompileError(
      `unknown context provider(s): ${unknownNeeds.join(", ")} — built-ins are ${Object.keys(
        BUILTIN_PROVIDERS,
      ).join(
        ", ",
      )}; a provider() ref must resolve to a .vigiles/providers/ file, or use provide()/dangerously() inline (see research/hook-context-providers.md).`,
    );
  }
  // An inline provide() whose command isn't provably read-only must be acknowledged.
  const unsafe = unsafeInlineProviders(needs);
  if (unsafe.length > 0) {
    throw new HookCompileError(
      `inline provider(s) not provably read-only: ${unsafe
        .map((u) => `${u.name} ("${u.run}")`)
        .join(
          ", ",
        )} — use dangerously(name, cmd) to acknowledge a side-effecting/undecidable command, or keep provide() only for a read-only one.`,
    );
  }
  const gateCommand =
    opts.gateCommand ?? "npx vigiles hook-runtime run-program";
  const matcher = styleMatcher(rawMatcher, opts.hookProtocol);
  const entry =
    matcher === undefined
      ? { hooks: [{ type: "command" as const, command: gateCommand }] }
      : {
          matcher,
          hooks: [{ type: "command" as const, command: gateCommand }],
        };
  return {
    hooks: { [on]: [entry] },
    settingsBlock: renderSettingsBlock(
      on,
      matcher,
      gateCommand,
      opts.settingsFormat ?? "json",
    ),
    stamp: stampHook(source),
  };
}

/** Stamp a hook's source (the integrity.ts pattern, applied to a hook artifact). */
export function stampHook(source: string): SHA256Hash {
  return sha256short(source);
}

/** Verify a shipped hook artifact matches its stamp (tamper → false). */
export function verifyHookStamp(source: string, stamp: SHA256Hash): boolean {
  return stampHook(source) === stamp;
}

// ===========================================================================
// PROBE 2 — does the closed vocabulary HOLD for two genuinely different shapes?
//
// Finding: it holds, but the vocabulary is a small FAMILY keyed by hook ROLE,
// and the per-role OUTPUT TYPE makes two more verified pains UNREPRESENTABLE:
//   - a context-injection hook can't return a block (no `deny` in `Injection`) —
//     so "block on a SessionStart/PostToolUse hook" (a documented mistake) is a
//     TYPE error, not a silent no-op;
//   - the compiler emits the RIGHT JSON field per role (`additionalContext` for
//     inject vs the exit-2/`permissionDecision` for a gate) — the wrong-field pain
//     vanishes because the author never picks the field.
// ===========================================================================

// --- A second GATE shape: Edit/Write path confinement (a different tool/field/matcher) ---

/** An AST-free view of a file path — the matching primitive for file tools. */
export interface PathView {
  readonly raw: string;
  /**
   * True iff the path sits under at least one allowed prefix (e.g. "src/**").
   *
   * A prefix is matched in ITS OWN spelling: a repo-relative prefix (`"src"`,
   * `"migratsiya/papers/"`) is compared against the path made repo-relative, an
   * absolute prefix (`"/etc"`) against the path made absolute. Which of those is
   * available depends on the project root — see {@link pathView}.
   */
  under(prefixes: readonly string[]): boolean;
  /**
   * The path as a repo-relative reference, or `undefined` when this view cannot
   * produce one — an absolute path with no known root, or a path that resolves
   * OUTSIDE the root (`/etc/passwd`, a sibling checkout). Exposed because a hook
   * that wants to report or re-match the path needs the same answer `under`
   * used, and `raw` alone does not carry it.
   */
  readonly rel: string | undefined;
}

/**
 * A view of a file path, matched against prefixes by {@link PathView.under}.
 *
 * 🔴 `root` IS NOT OPTIONAL IN PRACTICE — WITHOUT IT THIS IS DEAD FOR EVERY REAL
 * EVENT. Claude Code's Edit/Write/MultiEdit tools always send an ABSOLUTE
 * `file_path`, and every hook in the wild writes repo-relative prefixes
 * (`under(["migratsiya/papers/"])`). Before the root existed, the two could
 * never meet: the comparison ran `"/home/u/repo/migratsiya/papers/x.tex"`
 * against `"migratsiya/papers"` and returned `false` for all input, forever.
 * MEASURED 2026-08-12 on the live runtime with one compiled react hook and two
 * spellings of the same file — the relative one printed its checklist, the
 * absolute one exited 0 in silence. Three shipped hooks in a consumer repo were
 * dead by it, all three compiled *specifically to replace hooks that were dead*,
 * and none of the tests noticed because the harness helper built relative paths.
 *
 * ## Which way a miss errs, and why it is not the same answer as `touches`
 *
 * `under` is the ALLOWLIST/COVERAGE primitive: its callers spell
 * `under(P) ? allow() : deny()` (confinement) and `under(P) ? notice() : nothing()`
 * (a nudge). For both, an unprovable answer must be `false` — a confinement gate
 * denies (fails closed) and a nudge stays quiet. So:
 *
 * - path resolves OUTSIDE the root → `false` for every relative prefix. Not a
 *   bias, the truth: a repo-relative prefix names nothing in another checkout.
 *   This is the {@link resolveRef} lesson — the suffix match it replaced handed
 *   `/home/other-project/package.json` a grant meant for this repo's.
 * - NO root known and the path is absolute → `false` for every relative prefix.
 *   Here we genuinely cannot tell, and `false` is the choice: silence, never a
 *   false grant. It is also the pre-fix behaviour, so nothing regresses.
 *
 * ⚠️ THE ASYMMETRY INVERTS FOR A DENYLIST, AND `under` DOES NOT SERVE THAT CASE.
 * A gate written `under(["secrets"]) ? deny() : allow()` reads an unprovable
 * `false` as ALLOW — a false grant. The Bash-side counterpart {@link
 * CommandView.touches} exists precisely for that direction and takes the
 * opposite bias from the SAME rule ({@link prefixVerdict}), which is why the
 * resolver {@link matchesPrefix} makes each caller name its own. `PathView` has
 * no such counterpart; a file-side denylist inherits the allowlist bias.
 * Reported, not papered over.
 *
 * @param raw - the `file_path` the tool event carried, any spelling.
 * @param root - the project root relative prefixes resolve against. Comes from
 *   the runtime (`$CLAUDE_PROJECT_DIR`, else the event's own `cwd`), never from
 *   `process.cwd()` — under a git worktree the process's cwd is a DIFFERENT
 *   checkout from the one the harness resolved the hook out of, and that exact
 *   mismatch already wedged a repo once.
 */
export function pathView(raw: string, root?: string): PathView {
  const slashed = raw.replace(/\\/g, "/");
  return {
    raw,
    rel: relativeSpelling(slashed, root),
    // A prefix is matched only against its OWN spelling, and a path that cannot
    // be produced in that spelling is a miss — never a silent fallback to the
    // other one. `"miss"` is the ALLOWLIST bias, named here rather than
    // inherited: `matchesPrefix` has no default, so the denylist matchers on
    // `CommandView` cannot pick this one up by accident (and did not, for the
    // whole time they shared a single boolean helper with it).
    under: (prefixes) =>
      prefixes.some((p) =>
        matchesPrefix(prefixVerdict(slashed, p, root), "miss"),
      ),
  };
}

/** The path as an absolute reference, or `undefined` when it cannot be one. */
/**
 * A root only relates the two spellings if it is itself ABSOLUTE. A relative one
 * — `"."`, `"repo"` — is treated as no root at all, and the reason is a wrong
 * ANSWER rather than tidiness: `resolveRef(".", ".")` collapses to `""`, so
 * `/etc/passwd` would come back as the repo-relative `etc/passwd` and satisfy
 * `under(["etc"])` inside a repo that has no such directory. Claude Code always
 * sends an absolute `cwd` and sets an absolute `$CLAUDE_PROJECT_DIR`, so this
 * costs nothing real and closes the one input that produced a false grant.
 */
const usableRoot = (root?: string): string | undefined =>
  root !== undefined && isAbsoluteRef(root.replace(/\\/g, "/"))
    ? root
    : undefined;

/** The path as an absolute reference, or `undefined` when it cannot be one. */
function absoluteSpelling(path: string, root?: string): string | undefined {
  const r = usableRoot(root);
  if (r !== undefined) return resolveRef(r, path);
  // No usable root: an already-absolute path just needs its dot segments
  // collapsed; a relative one has nothing to hang off, so there is no absolute
  // spelling of it.
  return isAbsoluteRef(path) ? resolveRef("/", path) : undefined;
}

/** The path as a repo-relative reference, or `undefined` when it cannot be one. */
function relativeSpelling(path: string, root?: string): string | undefined {
  const r = usableRoot(root);
  if (r !== undefined) return relativeToRoot(r, path);
  // No usable root: an absolute path is UNKNOWABLE — this is the case that used
  // to be every real event, and the miss is chosen to cost silence (see
  // `pathView`).
  return isAbsoluteRef(path) ? undefined : path.replace(/^\.\//, "");
}

/**
 * `raw` expressed relative to `root`, or `undefined` when it resolves outside it.
 * Both sides are resolved and compared WHOLE (never by suffix) — see
 * {@link resolveRef} for the hole that cost.
 */
function relativeToRoot(root: string, raw: string): string | undefined {
  const base = resolveRef(root.replace(/\\/g, "/"), ".");
  const full = resolveRef(root.replace(/\\/g, "/"), raw);
  // 🔴 CASE FOLDING IS DRIVE-ROOTED-ONLY, AND THE ASYMMETRY IS THE POINT.
  // Windows filesystems are case-insensitive by default, so `C:/Repo` and
  // `c:/repo/src/x.ts` name the same place — compared exactly, the second reads
  // as OUTSIDE the first and the gate silently denies a same-repo edit. POSIX is
  // case-SENSITIVE: `/repo/Secrets` and `/repo/secrets` are two different files,
  // and folding there would invent a match that does not exist — turning a
  // silent miss into a silent false grant, which is the worse direction. So the
  // fold is applied only when the root is drive-rooted, and only for the
  // comparison; the returned remainder keeps the path's own casing.
  const insensitive = caseInsensitiveFs(base);
  const foldedBase = foldWhen(base, insensitive);
  const foldedFull = foldWhen(full, insensitive);
  if (foldedFull === foldedBase) return "";
  if (foldedBase === "/") return full.slice(1);
  return foldedFull.startsWith(foldedBase + "/")
    ? full.slice(base.length + 1)
    : undefined;
}

/**
 * The project root a compiled hook's repo-relative prefixes resolve against.
 *
 * Two sources, in order, and `process.cwd()` is deliberately NOT one of them:
 *
 * 1. **`$CLAUDE_PROJECT_DIR`** — what the harness itself resolved the hook's own
 *    path against (`.claude/settings.json` spells the command
 *    `"$CLAUDE_PROJECT_DIR/.claude/hooks/x.hook.ts"`), so it is the same root the
 *    hook was loaded from by construction.
 * 2. **the event's `cwd`** — Claude Code puts the session's working directory in
 *    every hook payload. A fallback, not a peer: it is where the session is, and
 *    the two coincide in the ordinary case.
 *
 * `process.cwd()` is excluded because under a git worktree it can be a different
 * checkout than the one the harness is driving, and a root from the wrong
 * checkout turns every repo-relative prefix into a non-match — the same silent
 * death this whole function exists to end. When NEITHER source is present the
 * answer is `undefined` and the miss errs toward silence (see {@link pathView}).
 */
export function projectRootOf(
  event: { readonly cwd?: unknown },
  env: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  // 🔴 THE FIRST *USABLE* ROOT, NOT THE FIRST NON-EMPTY STRING. A relative
  // `$CLAUDE_PROJECT_DIR` — `.` is the obvious one — is not a root: `usableRoot`
  // rejects it downstream, precisely so a relative value cannot turn
  // `/etc/passwd` into the repo-relative `etc/passwd`. Returning it anyway
  // MASKED a perfectly good absolute `cwd` from the payload, so absolute paths
  // stopped matching repo-relative prefixes — and worse, `undecidablePathWarning`
  // saw a defined root and stayed quiet, removing the one signal that says why.
  // A source that cannot serve as a root must not consume the slot.
  for (const candidate of [env.CLAUDE_PROJECT_DIR, event.cwd]) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    if (usableRoot(candidate) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The one case {@link pathView} cannot answer and must not answer silently: an
 * ABSOLUTE `file_path` with no project root in sight. Every repo-relative prefix
 * in the hook returns `false`, so a gate waves everything through and a nudge
 * never fires — indistinguishable, from the outside, from a hook with nothing to
 * say. Returns the warning line, or `undefined` when there is nothing wrong.
 *
 * Narrow on purpose: a RELATIVE `file_path` is decidable without a root, so it
 * warns about nothing. That matters because a react hook's `notice` also goes to
 * stderr, and a warning on every event would read as the hook firing.
 */
export function undecidablePathWarning(
  filePath: unknown,
  root: string | undefined,
): string | undefined {
  if (root !== undefined) return undefined;
  if (
    typeof filePath !== "string" ||
    !isAbsoluteRef(filePath.replace(/\\/g, "/"))
  )
    return undefined;
  return (
    `vigiles: no project root — neither $CLAUDE_PROJECT_DIR nor the event's ` +
    `\`cwd\` was set, and the event carries an ABSOLUTE file_path (${filePath}). ` +
    `Repo-relative prefixes in this hook cannot match it, so the hook is ` +
    `deciding on less than it looks like it is. Set CLAUDE_PROJECT_DIR.`
  );
}

/** The event a file-tool gate decides over (Edit/Write/Read carry `file_path`). */
export interface FileToolEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  readonly tool: string;
  readonly path: PathView;
  /** Host-gathered, DECLARED read-only facts — see `needs`. */
  readonly ctx: HookCtx<N>;
}

export interface FileGateHook<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly role: "gate";
  readonly on: string;
  readonly match: { readonly tools: readonly string[] };
  /** `enforce` (default) blocks on a `deny`; `observe` records + allows. */
  readonly mode?: HookMode;
  /** Declared context providers the trusted runtime gathers into `e.ctx`. */
  readonly needs?: N;
  readonly decide: (e: FileToolEvent<N>) => Decision;
}

export const tools = (...names: string[]): { tools: string[] } => ({
  tools: names,
});
/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_defineFileGate` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `defineFileGate` without it and cannot tell it is provisional.
 */
export function experimental_defineFileGate<
  const N extends readonly NeedSpec[] = readonly [],
>(p: Omit<FileGateHook<N>, "role">): FileGateHook<N> {
  return { role: "gate", ...p };
}

/**
 * Run a file-tool gate against a raw PreToolUse event (reads `file_path`).
 *
 * `root` is the project root repo-relative prefixes resolve against; omitted, it
 * falls back to the event's OWN `cwd` (a payload field — this stays pure and
 * reads no environment). The CLI passes {@link projectRootOf} instead, which
 * prefers `$CLAUDE_PROJECT_DIR`. Without either, an absolute `file_path` matches
 * no relative prefix — see {@link pathView} for why that direction was chosen.
 */
export function decideFileGate<N extends readonly NeedSpec[]>(
  hook: FileGateHook<N>,
  raw: {
    tool_name?: string;
    tool_input?: { file_path?: unknown };
    cwd?: unknown;
  },
  ctx: RawCtx = {},
  root: string | undefined = typeof raw.cwd === "string" ? raw.cwd : undefined,
): Decision {
  const t = raw.tool_name ?? "";
  // Same matcher semantics as the emitted settings block — see {@link matchesTool}.
  if (!matchesTool(hook.match.tools, t)) return allow();
  const fp =
    typeof raw.tool_input?.file_path === "string"
      ? raw.tool_input.file_path
      : "";
  return hook.decide({
    event: hook.on,
    tool: t,
    path: pathView(fp, root),
    ctx: ctx as unknown as HookCtx<N>,
  });
}

// ===========================================================================
// PROBE 4 — gate-capable NON-TOOL events: UserPromptSubmit + Stop.
//
// The flagship gate is PreToolUse (block a dangerous tool call). But two more
// session events CAN block, and a typed DECISION fits them exactly:
//   - UserPromptSubmit: see the prompt TEXT, deny to block/erase it (a security
//     filter — refuse a prompt that leaks a secret or carries an injection);
//   - Stop: deny to BLOCK the agent from stopping (gate-until-tests-pass; the
//     reason is fed back to the agent telling it why to continue).
// Both are DECISIONS (the typed lane's sweet spot) on events the vocab didn't
// expose yet — they ride the SAME exit-2 gate runtime as PreToolUse, so they
// work on every harness whose gate vetoes via exit 2 (Claude Code + Codex).
// ===========================================================================

/** The event a UserPromptSubmit gate decides over — it sees the prompt TEXT. */
export interface PromptEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  /** The user's submitted prompt text (empty string if the event carried none). */
  readonly prompt: string;
  /** Host-gathered, DECLARED read-only facts — see `needs`. */
  readonly ctx: HookCtx<N>;
}

export interface PromptGateHook<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly role: "prompt-gate";
  /** The event — `UserPromptSubmit`. */
  readonly on: string;
  /** `enforce` (default) blocks on a `deny`; `observe` records + allows. */
  readonly mode?: HookMode;
  /** Declared context providers the trusted runtime gathers into `e.ctx`. */
  readonly needs?: N;
  /** Decide over the prompt. `deny` blocks/erases the prompt; `ask` defers to the user. */
  readonly decide: (e: PromptEvent<N>) => Decision;
}
/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_definePromptGate` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `definePromptGate` without it and cannot tell it is provisional.
 */
export function experimental_definePromptGate<
  const N extends readonly NeedSpec[] = readonly [],
>(p: Omit<PromptGateHook<N>, "role">): PromptGateHook<N> {
  return { role: "prompt-gate", ...p };
}

/** Run a prompt gate against a raw UserPromptSubmit event (reads `prompt`). */
export function decidePromptGate<N extends readonly NeedSpec[]>(
  hook: PromptGateHook<N>,
  raw: { prompt?: unknown },
  ctx: RawCtx = {},
): Decision {
  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  return hook.decide({
    event: hook.on,
    prompt,
    ctx: ctx as unknown as HookCtx<N>,
  });
}

/**
 * The event a Stop gate decides over. `deny` BLOCKS the agent from ending its
 * turn (the reason is surfaced to the agent — e.g. "tests are red, keep going").
 */
export interface StopEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  /**
   * True when this Stop is itself the consequence of a PRIOR Stop-block — the
   * loop guard. A gate MUST return `allow` when this is set, or it can wedge the
   * agent in an infinite stop→continue→stop cycle.
   */
  readonly stopHookActive: boolean;
  /** Host-gathered, DECLARED read-only facts — see `needs`. */
  readonly ctx: HookCtx<N>;
}

export interface StopGateHook<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly role: "stop-gate";
  /** The event — `Stop` or `SubagentStop`. */
  readonly on: string;
  /** `enforce` (default) blocks on a `deny`; `observe` records + allows. */
  readonly mode?: HookMode;
  /** Declared context providers the trusted runtime gathers into `e.ctx`. */
  readonly needs?: N;
  /** Decide whether the agent may stop. `deny` keeps it going; `allow` lets it stop. */
  readonly decide: (e: StopEvent<N>) => Decision;
}
/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_defineStopGate` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `defineStopGate` without it and cannot tell it is provisional.
 */
export function experimental_defineStopGate<
  const N extends readonly NeedSpec[] = readonly [],
>(p: Omit<StopGateHook<N>, "role">): StopGateHook<N> {
  return { role: "stop-gate", ...p };
}

/** Run a Stop gate against a raw Stop/SubagentStop event (reads `stop_hook_active`). */
export function decideStopGate<N extends readonly NeedSpec[]>(
  hook: StopGateHook<N>,
  raw: { stop_hook_active?: unknown },
  ctx: RawCtx = {},
): Decision {
  return hook.decide({
    event: hook.on,
    stopHookActive: raw.stop_hook_active === true,
    ctx: ctx as unknown as HookCtx<N>,
  });
}

// --- A non-gate shape: context INJECTION (SessionStart) — a different OUTPUT ---

/** The output of an inject hook — text to add to context. NO allow/deny exists here. */
export interface Injection {
  readonly kind: "inject";
  readonly context: string;
  /** Facts to record — a DECLARATION; the trusted runtime performs the write. */
  readonly records: readonly StateWrite[];
}
/**
 * Context to add, plus any facts that just became true:
 * `inject(text, record("calendar.nagged"))`.
 *
 * The writes are trailing arguments on every output builder, so there is one rule
 * to learn rather than a per-role spelling — and a hook that records nothing is
 * written exactly as it was before.
 */
export const inject = (
  context: string,
  ...records: readonly StateWrite[]
): Injection => ({
  kind: "inject",
  context,
  records,
});

/**
 * The event an inject hook produces from (no tool — SessionStart/UserPromptSubmit).
 * Generic over its declared `needs`, exactly like the gate events.
 */
export interface SessionEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  readonly source: string;
  /** Host-gathered, DECLARED facts — built-ins, inline providers, and `state()` reads. */
  readonly ctx: HookCtx<N>;
}

export interface InjectHook<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly role: "inject";
  readonly on: string;
  /**
   * Declared context providers the trusted runtime gathers into `e.ctx`.
   *
   * Injects and reacts could not declare `needs` at all until state landed, for
   * no reason anyone had recorded — and a fact a hook cannot read is not a
   * feature. `needs` is now uniform across every role.
   */
  readonly needs?: N;
  /** Produces context to add. Its return type (Injection) has no `deny` — by design. */
  readonly produce: (e: SessionEvent<N>) => Injection;
}
/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_defineInject` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `defineInject` without it and cannot tell it is provisional.
 */
export function experimental_defineInject<
  const N extends readonly NeedSpec[] = readonly [],
>(p: Omit<InjectHook<N>, "role">): InjectHook<N> {
  return { role: "inject", ...p };
}

/**
 * Run an inject hook → the CC JSON the author never hand-writes. The compiler
 * targets `additionalContext` (the RIGHT field for this event), so the
 * wrong-JSON-field pain can't occur.
 */
export function runInject<N extends readonly NeedSpec[]>(
  hook: InjectHook<N>,
  raw: { source?: string },
  ctx: RawCtx = {},
): {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
} {
  const out = injectionOf(hook, raw, ctx);
  return {
    hookSpecificOutput: {
      hookEventName: hook.on,
      additionalContext: out.context,
    },
  };
}

/** The full {@link Injection} — the runtime needs its `records`, which the CC JSON drops. */
export function injectionOf<N extends readonly NeedSpec[]>(
  hook: InjectHook<N>,
  raw: { source?: string },
  ctx: RawCtx = {},
): Injection {
  return hook.produce({
    event: hook.on,
    source: raw.source ?? "startup",
    ctx: ctx as unknown as HookCtx<N>,
  });
}

// --- PROBE 3 — the REACT shape (PostToolUse): where side effects re-enter ---
//
// gate + inject are PURE. A react hook (PostToolUse) fires AFTER the tool ran, so
// it can't block — its job is to DO something in reaction (format, recompile, warn).
// That reintroduces side effects, the exact thing we constrained away. The principled
// answer keeps them BOUNDED: a react's action isn't arbitrary shell, it's a typed
// `Reaction` whose `run(cmd)` is EFFECT-CLASSIFIED at construction (bash-effects). So
// even the side-effecting role stays ANALYZABLE — you can list/diff exactly what every
// react hook runs and its effect — and a react still CANNOT block (no `deny` in
// Reaction), making "block on a PostToolUse hook" (a documented mistake) a type error.

/**
 * A view of a tool's RESPONSE (PostToolUse) — the matching primitive a react hook
 * reasons over (e.g. capture/notify only when a command FAILED). The author never
 * parses the raw payload shape.
 */
export interface ResponseView {
  /** The response as text (an object payload is JSON-stringified). */
  readonly raw: string;
  /**
   * True iff the tool reported a failure — a truthy `error`/`is_error` field on a
   * structured payload, or a leading `Error`/`error:` line on a text one.
   */
  isError(): boolean;
  /** True iff the response text contains `needle`. */
  contains(needle: string): boolean;
}

/** Normalize an arbitrary tool_response payload to text (object → JSON). */
function responseText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  return JSON.stringify(raw);
}

export function responseView(raw: unknown): ResponseView {
  const text = responseText(raw);
  const flagged =
    typeof raw === "object" &&
    raw !== null &&
    (Boolean((raw as { error?: unknown }).error) ||
      (raw as { is_error?: unknown }).is_error === true);
  return {
    raw: text,
    isError: () => flagged || /^\s*error[:\s]/i.test(text),
    contains: (needle) => text.includes(needle),
  };
}

/** The event a react hook reacts over — the tool, the file path, AND its response. */
export interface ReactEvent<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly event: string;
  readonly tool: string;
  readonly path: PathView;
  /** The tool's response (PostToolUse) — react only on an error, capture output, … */
  readonly response: ResponseView;
  /** Host-gathered, DECLARED facts — built-ins, inline providers, and `state()` reads. */
  readonly ctx: HookCtx<N>;
}

export interface RunReaction {
  readonly kind: "run";
  readonly command: string;
  readonly effect: BashEffect;
  readonly records: readonly StateWrite[];
}
export type Reaction =
  | RunReaction
  | {
      readonly kind: "notice";
      readonly message: string;
      readonly records: readonly StateWrite[];
    }
  | { readonly kind: "none"; readonly records: readonly StateWrite[] };

/**
 * Run a command in reaction — its effect is classified AT CONSTRUCTION
 * (audit/diff-able). Trailing arguments record facts.
 *
 * ⚠️ `run()` is for invoking a real TOOL. Using it to write a stamp
 * (`run("date +%s > .claude/.stamp")`) was the only way to remember anything
 * before `record()` existed; it is now the wrong tool — it spends a subprocess
 * and a shell on a variable assignment, and it classifies as side-effecting.
 */
export const run = (
  command: string,
  ...records: readonly StateWrite[]
): RunReaction => ({
  kind: "run",
  command,
  effect: classifyBashCommand(command),
  records,
});
/** Surface a non-blocking note (no execution). Trailing arguments record facts. */
export const notice = (
  message: string,
  ...records: readonly StateWrite[]
): Reaction => ({
  kind: "notice",
  message,
  records,
});
/**
 * Take no action. Trailing arguments still record facts — `nothing(record("x"))`
 * is the shape of a hook whose entire job is to WITNESS that something happened
 * (an MCP call, a deploy) so a different hook can read it later.
 */
export const nothing = (...records: readonly StateWrite[]): Reaction => ({
  kind: "none",
  records,
});

export interface ReactHook<
  N extends readonly NeedSpec[] = readonly ProviderName[],
> {
  readonly role: "react";
  readonly on: string;
  /**
   * Which tools to react to. OMIT IT for an event that carries no tool at all
   * (`Stop`, `SubagentStop`, `SessionEnd`), exactly as inject and the prompt/stop
   * gates already do — `hookRouting` then emits no matcher.
   *
   * 🔴 IT USED TO BE REQUIRED, WHICH MADE EVERY TOOL-LESS REACT DEAD. `runReact`
   * gates on `tool_name`; a `Stop` event carries none, so the name defaulted to
   * `""`, matched nothing, and the hook returned `nothing()` forever. MEASURED
   * 2026-08-12 against the real runtime: a `Stop` react printed nothing and
   * exited 0 — indistinguishable from a hook that decided to stay quiet, which
   * is the whole reason advisory hooks die unnoticed. Three of the seven hooks
   * this feature was built for are `Stop` nudges.
   */
  readonly match?: { readonly tools: readonly string[] };
  /** Declared context providers the trusted runtime gathers into `e.ctx`. */
  readonly needs?: N;
  /** Reacts to a tool that already ran. Returns a Reaction — NO `deny` exists here. */
  readonly react: (e: ReactEvent<N>) => Reaction;
}
/**
 * @experimental Compiled hooks are provisional — see docs/compiled-hooks.md#status--pending.
 * Imported and CALLED as `experimental_defineReact` — do not alias the prefix away at
 * the import. Measured 2026-08-21: with the alias in place the marker survived
 * at 0 of 5 call sites in the only user-facing example, because a reader 200
 * lines down sees `defineReact` without it and cannot tell it is provisional.
 */
export function experimental_defineReact<
  const N extends readonly NeedSpec[] = readonly [],
>(p: Omit<ReactHook<N>, "role">): ReactHook<N> {
  return { role: "react", ...p };
}

/**
 * Run a react hook against a raw PostToolUse event → the (classified) Reaction.
 *
 * `root` behaves exactly as in {@link decideFileGate}: the event's own `cwd` by
 * default, the CLI's {@link projectRootOf} when the runtime supplies one. It
 * trails `ctx` so the argument order matches {@link decideProgram} and
 * {@link decideFileGate} — every decode function reads `(hook, raw, ctx, root)`.
 */
export function runReact<N extends readonly NeedSpec[]>(
  hook: ReactHook<N>,
  raw: {
    tool_name?: string;
    tool_input?: { file_path?: unknown };
    tool_response?: unknown;
    cwd?: unknown;
  },
  ctx: RawCtx = {},
  root: string | undefined = typeof raw.cwd === "string" ? raw.cwd : undefined,
): Reaction {
  const t = raw.tool_name ?? "";
  // No `match` → a tool-less event (Stop/SessionEnd): there is nothing to filter
  // on, and filtering on the empty string is how these hooks used to die.
  if (hook.match !== undefined && !matchesTool(hook.match.tools, t))
    return nothing();
  const fp =
    typeof raw.tool_input?.file_path === "string"
      ? raw.tool_input.file_path
      : "";
  return hook.react({
    event: hook.on,
    tool: t,
    path: pathView(fp, root),
    response: responseView(raw.tool_response),
    ctx: ctx as unknown as HookCtx<N>,
  });
}

// ---------------------------------------------------------------------------
// runHookProgram — one in-process dispatcher over the whole role family. The
// cheapest test tier for a compiled hook: a hook's decision is a PURE function,
// so this evaluates it with NO subprocess and NO model (vs `runHook`, which
// spawns the real CLI runtime). Dispatches by role so a test never has to pick
// `decideProgram` vs `decideFileGate` vs `runReact`/`runInject` by hand — the
// in-process twin of the `vigiles hook-runtime run-program` CLI.
// ---------------------------------------------------------------------------

/** The raw event fields the decode functions read (the union across roles). */
export interface RawHookEvent {
  readonly tool_name?: string;
  readonly tool_input?: {
    readonly command?: unknown;
    readonly file_path?: unknown;
  };
  /** PostToolUse response (react). */
  readonly tool_response?: unknown;
  /** SessionStart / UserPromptSubmit (inject). */
  readonly source?: string;
  /** UserPromptSubmit (prompt-gate). */
  readonly prompt?: string;
  /** Stop / SubagentStop (stop-gate) — the prior-block loop guard. */
  readonly stop_hook_active?: boolean;
  /**
   * The session's working directory, which Claude Code puts in EVERY hook
   * payload. The fallback project root repo-relative path prefixes resolve
   * against when the runtime does not pass one — see {@link projectRootOf}.
   */
  readonly cwd?: string;
}

/** The normalized outcome of running a hook program — discriminated by role. */
export type HookProgramOutcome =
  | { readonly kind: "decision"; readonly decision: Decision }
  | {
      readonly kind: "injection";
      readonly context: string;
      readonly records: readonly StateWrite[];
    }
  | { readonly kind: "reaction"; readonly reaction: Reaction };

/**
 * The state writes an outcome declares, filtered to the ones the runtime may
 * actually perform. A gate's `Decision` carries none — deliberately: a gate is
 * the role that must be trustworthy and runs on every tool call, so it READS
 * state (via `needs`) and never writes it. Adding a write there later is easy;
 * removing one would not be.
 */
export function outcomeWrites(outcome: HookProgramOutcome): {
  readonly ok: readonly StateWrite[];
  readonly refused: readonly string[];
} {
  if (outcome.kind === "injection") return admissibleWrites(outcome.records);
  if (outcome.kind === "reaction")
    return admissibleWrites(outcome.reaction.records);
  return admissibleWrites([]);
}

/**
 * The file a hook program was LOADED from — the one coverage attribution in this
 * codebase that needs no parsing at all.
 *
 * 🔴 BY CONSTRUCTION, NOT BEST-EFFORT, and a reader should not treat this source
 * as equivalent to the parsed one. `commandRefs` (coverage-probe.ts) infers what
 * executed from an arbitrary command STRING — interpreter grammars, option
 * bundles, shell short-circuits — and has been wrong in five review rounds
 * because that grammar is unbounded. Here the path is the argument `loadHook`
 * was called with and resolved itself. There is nothing to guess.
 *
 * A `WeakMap`, not a property on the hook: the object is the USER's, it is
 * `export default`-ed from their module, and stamping a field on it would show
 * up in their serialization and their equality checks. The map also lets the
 * entry die with the hook.
 *
 * ⚠️ REMEMBERING IS NOT RECORDING. `loadHook(file)` calls this and nothing else —
 * loading a hook to inspect its shape is not running it, and attributing a load
 * would be the "an empty file counts" disease the execution tier exists to cure.
 * The probe is emitted by `harness-assert.ts` at the moment the hook is
 * EVALUATED, which is the only place both facts are in hand.
 */
const HOOK_SOURCE = new WeakMap<object, string>();

/** Record where a hook program was loaded from. Called by `loadHook` ONLY. */
export function rememberHookSource(hook: AnyHook, file: string): void {
  HOOK_SOURCE.set(hook, file);
}

/** The file a hook was loaded from, or `undefined` for one built in-process. */
export function hookSource(hook: AnyHook): string | undefined {
  return HOOK_SOURCE.get(hook);
}

/**
 * Evaluate a compiled hook against a raw event, in-process, dispatching by role:
 * a gate → its `Decision`, an inject → the injected context text, a react → its
 * (effect-classified) `Reaction`. Pure — no subprocess, no model. The ergonomic
 * base for testing a compiled hook (see `assertHookDenies` / `assertHookAllows`).
 */
export function runHookProgram(
  hook: AnyHook,
  event: RawHookEvent,
  ctx: RawCtx = {},
  root: string | undefined = event.cwd,
): HookProgramOutcome {
  const kind = dispatchKind(hook);
  switch (kind) {
    case "bash-gate":
      return {
        kind: "decision",
        decision: decideProgram(hook as HookProgram, event, ctx, root),
      };
    case "file-gate":
      return {
        kind: "decision",
        decision: decideFileGate(hook as FileGateHook, event, ctx, root),
      };
    case "prompt-gate":
      return {
        kind: "decision",
        decision: decidePromptGate(hook as PromptGateHook, event, ctx),
      };
    case "stop-gate":
      return {
        kind: "decision",
        decision: decideStopGate(hook as StopGateHook, event, ctx),
      };
    case "inject": {
      const out = injectionOf(hook as InjectHook, event, ctx);
      return { kind: "injection", context: out.context, records: out.records };
    }
    case "react":
      return {
        kind: "reaction",
        reaction: runReact(hook as ReactHook, event, ctx, root),
      };
    default:
      return assertNever(kind);
  }
}

// ---------------------------------------------------------------------------
// Stale-stamp REPAIR detection — the bootstrap deadlock's escape hatch.
//
// `verifyStampOrRefuse` makes a compiled hook refuse to run once its source no
// longer matches its stamp. That is correct for tampering, but it wedges the
// AUTHOR: if the hook is a PreToolUse Bash gate wired into the same repo, editing
// its source makes it block EVERY Bash command — including `vigiles compile`,
// the only command that regenerates the stamp. Observed 2026-08-03; the only
// escape was hand-editing `.claude/settings.json` to unwire the gate, compile,
// and rewire.
//
// Fail-closed is kept for everything else. The ONE exception is the repair
// action itself, and it is announced loudly on stderr. This does not weaken the
// stamp's threat model in a way that matters: while the stamp is stale the hook
// enforces NOTHING (it refuses every call), and an attacker who can rewrite a
// hook's source can equally rewrite `.claude/settings.json` — the escape they'd
// otherwise use. What the stamp buys is that a smuggled capability can never run
// SILENTLY, and that is unchanged.
// ---------------------------------------------------------------------------

/** A reference that already names a root — POSIX `/x` or Windows `C:/x`. */
function isAbsoluteRef(ref: string): boolean {
  return ref.startsWith("/") || /^[A-Za-z]:\//.test(ref);
}

/**
 * Does this ROOT name a Windows filesystem? One predicate, because the two
 * questions that ask it — how many segments `..` may not pop through, and
 * whether a `//` leader is a share or a stutter — must never disagree about the
 * same root. `//x` is caught by the second arm: too short to be a share, but
 * still not something to read as POSIX.
 */
const namesWindowsFs = (root: string): boolean =>
  WINDOWS_ROOT.test(root) || root.startsWith("//");

/**
 * How many leading segments of a resolved path ARE its root — the floor a `..`
 * must not pop through. `0` on POSIX, `1` for a drive (`C:`), `2` for a UNC
 * share (`//server/share`), and 2/4 for the `//?/` spellings of those two.
 *
 * 🔴 A `//` LEADER IS THE ROOT'S ANSWER, NEVER THE OPERAND'S — the round-37
 * lesson at a third site (after the case fold in {@link caseInsensitiveFs} and
 * the UNC leader in {@link resolveRef}). Read from the string alone,
 * `//repo/a/../src/x.ts` looks share-rooted, so a count taken off the operand
 * would guard `repo/a` and stop `..` collapsing at all — under a POSIX root that
 * doubled slash is a stutter, not a share. The `//` forms are therefore gated on
 * the root, exactly as the leader is.
 *
 * ⚠️ A DRIVE LETTER IS THE ONE THING THAT NAMES A WINDOWS FILESYSTEM BY ITSELF,
 * and that is not a second rule — {@link isAtOrUnder} already says it about a
 * base (`WINDOWS_ROOT.test(rawBase)`), because `C:/x` has no POSIX reading the
 * way `//x` does. It earns its place at a real call site rather than in the
 * abstract: {@link absoluteSpelling} resolves a ROOTLESS absolute path against
 * the literal `"/"`, so gating the drive on the root too would leave
 * `C:/../repo/x` still losing its drive right there — the sibling call site a
 * fix written only where the defect was found would have missed.
 *
 * The count itself is read off {@link WINDOWS_ROOT} rather than re-derived,
 * because that regex already IS this file's single answer to "what is a Windows
 * root"; the two forms and the `//?/` spelling are enumerated there, once.
 */
const rootSegmentCount = (joined: string, root: string): number => {
  const matched = WINDOWS_ROOT.exec(joined)?.[0];
  if (matched === undefined) return 0; // POSIX, or relative: no root inside `out`
  if (/^[/\\]/.test(matched) && !namesWindowsFs(root)) return 0; // stutter, not share
  return matched.split(/[/\\]+/).filter((s) => s !== "").length;
};

/**
 * Resolve a path reference against a root, without node:path (core stays
 * dependency-free). Mirrors `resolve(root, ref)`: an absolute ref wins, a
 * relative one hangs off the root, and `.` / `..` / `//` collapse.
 *
 * 🔴 THIS REPLACED A SUFFIX COMPARISON, and the difference is SCOPE, not
 * spelling. The old helper accepted `a.endsWith("/" + b)`, so a write to
 * `/home/another-project/package.json` counted as a repair of THIS repo's
 * `package.json` — one wedged checkout handed out a write in every other
 * checkout on the disk. The tolerance that motivated the looseness is real (the
 * harness sends an absolute `file_path` while settings carry a relative one) and
 * survives untouched: both sides resolve against the same root and compare
 * whole, so `/repo/package.json` and `package.json` still match while a sibling
 * repo's never can.
 */
function resolveRef(root: string, ref: string): string {
  const slashes = (s: string) => s.replace(/\\/g, "/");
  const r = slashes(ref);
  const joined = isAbsoluteRef(r)
    ? r
    : `${slashes(root).replace(/\/+$/, "")}/${r}`;
  // 🔴 `..` CLAMPS AT THE ROOT, IT DOES NOT EAT IT. A real filesystem holds
  // still at the top: on Windows `C:/..` is `C:/`, on POSIX `/..` is `/`. An
  // unconditional `out.pop()` popped the DRIVE LETTER out of `C:/../repo/src/x`,
  // leaving the relative-looking `repo/src/x` — which then failed to resolve
  // against `C:/repo`, so a gate stopped recognising a path naming its own
  // repository. A UNC share went one worse: two `..` ate `share` and then
  // `server`.
  //
  // ⚠️ POSIX WAS ALREADY CORRECT BY ACCIDENT, and the accident is worth naming
  // so nobody "simplifies" it back: its leader `/` is held OUTSIDE `out` (see
  // the leader below), so popping an empty array is already the clamp. The
  // Windows forms broke precisely because their root lives INSIDE `out` —
  // exactly the segments the loop treats as ordinary directories.
  const floor = rootSegmentCount(joined, root);
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > floor) out.pop();
      continue;
    }
    out.push(seg);
  }
  // 🔴 A UNC LEADER IS TWO SLASHES AND BOTH ARE LOAD-BEARING. Collapsing
  // `//server/share/x` to `/server/share/x` makes this function disagree with
  // `normalizePrefix`, which keeps the pair — so a UNC path and a UNC prefix
  // never compared equal, and an allowlist gate denied every valid edit on a
  // Windows network share while a react hook stayed silent. Two functions
  // normalising the SAME string differently is the defect class this PR keeps
  // finding; here it is inside one call.
  // ⚠️ AND THE PAIR IS KEPT ONLY WHEN THE ROOT SAYS THIS IS WINDOWS — the same
  // lesson as the case fold, relearned one commit later. Judged from the STRING,
  // `//repo/src/x.ts` looks like UNC; on Linux it is just `/repo/src/x.ts` with a
  // stutter, so preserving the pair unconditionally made it stop resolving
  // against a POSIX root and an allowlist gate denied a valid edit. Semantics
  // belong to the filesystem, and only the root knows which one that is.
  const unc = joined.startsWith("//") && namesWindowsFs(root);
  const leader = unc ? "//" : joined.startsWith("/") ? "/" : "";
  return leader + out.join("/");
}

/**
 * The repository a wedged hook belongs to, as the runtime sees it. Supplied by
 * the caller because core takes no `node:path` and reads no disk — and because
 * the hook's own path does NOT determine it (see {@link isLoadPathRepairEvent}).
 */
export interface HookRepoPaths {
  /**
   * Absolute root that relative references resolve against. Must be the SAME
   * root the runtime reads the hook and its stamp with, or the write accepted
   * here is not the file the runtime reads.
   */
  readonly root: string;
  /**
   * The actual files whose breakage can wedge THIS hook's module resolution,
   * already resolved by the caller: the `package.json` at every ancestor of the
   * hook, plus the repo's `.vigilesrc.json`. Node walks that chain, so a
   * monorepo package's own `package.json` is on it and a sibling checkout's is
   * not.
   */
  readonly loadPathFiles: readonly string[];
}

/** The basename of a path token — the sidecar is keyed by the hook's basename. */
function basenameOf(token: string): string {
  const parts = token.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? token;
}

/**
 * The tool names a repair may arrive under: the ones MEASURED to write a file
 * and carry `file_path`. Everything else is refused, including a name this list
 * has never heard of.
 *
 * 🔴 THE ESCAPE USED TO IGNORE `tool_name` ENTIRELY, so a `Read` of
 * `package.json` was a "repair" — and if the wedged hook was registered for
 * `Read`, that read went through while the gate was refusing everything else. A
 * read repairs nothing, so it cannot be a repair. The door's whole justification
 * is "a file write executes nothing"; a predicate blind to which tool is running
 * cannot make that claim about anything.
 *
 * ## How the list was decided, since an allow-list is the shape that has bitten
 *
 * Read off the LIVE harness's own tool schemas rather than from memory or a doc
 * page (measured 2026-08-12, this Claude Code build):
 *
 * ```
 * Write         file_path            → writes  → ADMITTED
 * Edit          file_path            → writes  → ADMITTED
 * MultiEdit     file_path            → writes  → ADMITTED (absent from this
 *                                                build; a vendored third-party
 *                                                plugin still matches on it, so
 *                                                other builds ship it)
 * Read          file_path            → reads   → refused (the reported hole)
 * NotebookEdit  notebook_path        → writes, but cannot reach this predicate
 * Glob / Grep   pattern, path        → no `file_path` at all
 * Bash          command              → no `file_path` at all
 * ```
 *
 * `NotebookEdit` is deliberately NOT listed. It writes, but its input field is
 * `notebook_path` — quoted from the live schema: *"notebook_path: The absolute
 * path to the Jupyter notebook file to edit"* — so it never carries the field
 * this predicate reads and listing it would be a fragment that can never
 * execute. If it ever grows `file_path`, this is a one-word change.
 *
 * ## What happens to an unrecognised name, and why that is not the wedge
 *
 * It is REFUSED. The other direction was weighed first, because "refuse
 * everything outside cwd" was rejected two rounds ago for making a wedged repo
 * unrecoverable — and the same objection does not land here. This list does not
 * have to be COMPLETE; it has to be NON-EMPTY at runtime. A new writing tool
 * appearing wedges nothing, because the author still repairs with `Write`. Only
 * the simultaneous disappearance of every name above could strand a repo, and a
 * release that deletes `Write` and `Edit` together has bigger problems.
 *
 * Admitting unknown names was the alternative, and it forfeits the one sentence
 * this door rests on: with an unrecognised tool we cannot say the call executes
 * nothing, so the exception would no longer be justified by the argument that
 * created it.
 */
const REPAIR_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit"];

/**
 * The file a repair event targets, or `null` when this event is not a repair
 * shape at all — wrong tool, or no `file_path`. Shared by both doors so the
 * stamp escape and the load-path escape cannot drift apart (they already did
 * once: the suffix-match hole was fixed on one and found on the other).
 */
function repairTargetOf(event: RawHookEvent): string | null {
  const tool = event.tool_name;
  if (typeof tool !== "string" || !REPAIR_TOOLS.includes(tool)) return null;
  const filePath = event.tool_input?.file_path;
  return typeof filePath === "string" ? filePath : null;
}

/**
 * The stamp sidecar a hook's compile writes, as a repo-relative reference.
 * Mirrors `hookStampPath` in cli.ts (`.vigiles/hooks/<basename>.json`); kept as a
 * string here because core takes no `node:path`.
 */
function stampSidecarRef(hookFile: string): string {
  return `.vigiles/hooks/${basenameOf(hookFile)}.json`;
}

/**
 * True when this event IS the author repairing the hook — a FILE WRITE, and only
 * a file write.
 *
 * 🔴 THIS USED TO ADMIT A BASH COMMAND, AND THAT WAS THE WHOLE PROBLEM. The
 * escape accepted `vigiles compile …`, and recognising a trusted ACTION from an
 * untrusted STRING produced five findings in a row, each fix correct and each
 * followed by another: `.some()` over the leaves → the operand (`compile
 * /tmp/payload.spec.ts`, which `loadSpec` imports) → the executable path
 * (`/tmp/vigiles compile`) → the working directory (`cd /tmp/evil && vigiles
 * compile`). The degrees of freedom in a command string are unbounded — argv,
 * cwd, PATH, `node_modules` resolution, a hostile `.vigilesrc.json`, a shell
 * function — so no amount of parsing closes the class. Two more constraints
 * predict two more findings.
 *
 * ## Why the command was not needed at all — measured, not argued
 *
 * MEASURED 2026-08-12 against the real runtime, on a stale-stamp fixture:
 * writing `{}` into the stamp sidecar (or deleting it) makes
 * `verifyStampOrRefuse` return early, so the hook LOADS AND ENFORCES again —
 * `ls` passed and `git push --force` was still denied with the hook's own reason.
 * The repo is unwedged by a file write, and the gate is back on duty; the author
 * then runs `vigiles compile` through the NORMAL gate, needing no escape at all.
 *
 * MEASURED the same day on the load-wedge fixture: with `package.json` holding
 * conflict markers, `vigiles compile <hook>` exits 1 —
 * `Cannot load hook …: Invalid package config` — because compile has to load the
 * hook through the same broken resolver the runtime just failed on. The command
 * the escape existed to permit CANNOT repair that wedge. It was pure liability.
 *
 * So the Bash escape kept only a git whitelist — and a later round measured that
 * those run `.git/hooks/*` too and deleted them as well. NO command is an escape
 * now; the repair is what it always should have been: a write
 * ({@link isLoadPathRepairEvent}).
 *
 * ## What is accepted here
 *
 * A write whose target is the hook's own source, or its stamp sidecar
 * (`.vigiles/hooks/<basename>.json`). Both are repo-owned paths derived from the
 * file the runtime was invoked with, never from the event.
 *
 * 🔴 SCOPE IS NOT THE SAME QUESTION AS EXECUTION. A previous round defended a
 * suffix comparison here on the ground that a write executes nothing — true, and
 * beside the point: `/home/another-project/.claude/hooks/guard.hook.mjs` ends
 * the same way as this repo's hook, so a wedge in one checkout granted a write
 * into another. Both sides now resolve against `repoRoot` and compare whole
 * ({@link resolveRef}); the absolute-vs-relative tolerance that suffix matching
 * was reached for is what resolution gives you properly.
 *
 * This grants nothing new: a Bash gate never gated file tools in the first place
 * (the 2026-08-10 incident was fixed by hand-editing JSON while every Bash
 * command was refused), and a file gate already let the hook's own source be
 * rewritten, which is strictly more powerful than clearing its stamp.
 */
export function isStampRepairEvent(
  event: RawHookEvent,
  hookFile: string,
  repoRoot: string,
): boolean {
  const filePath = repairTargetOf(event);
  if (filePath === null) return false;
  const target = resolveRef(repoRoot, filePath);
  return (
    target === resolveRef(repoRoot, hookFile) ||
    target === resolveRef(repoRoot, stampSidecarRef(hookFile))
  );
}

/**
 * True when this event is a load-path REPAIR — a file write, and only a file
 * write, to one of the files whose breakage takes the runtime down.
 *
 * 🔴 THE GIT ESCAPE USED TO LIVE HERE AND IT EXECUTED REPO CODE. `git merge
 * --abort` · `git rebase --abort` · `git checkout -- <path>` were admitted on the
 * reasoning that they "only move the tree to states git already holds; none
 * executes a line of repo code". MEASURED against git 2.43.0 with hooks installed
 * in `.git/hooks/`, and the reasoning is false for ALL THREE:
 *
 *   git checkout -- f.txt   → post-checkout          (args `<sha> <sha> 0`)
 *   git merge --abort       → reference-transaction  (prepared, committed)
 *   git rebase --abort      → reference-transaction  (×4) + post-checkout
 *
 * `reference-transaction` fires on ANY ref update, and every one of these updates
 * a ref. `.git/hooks/*` is writable by exactly the actor this door assumes —
 * whoever could wedge the repo in the first place — so the whitelist was an
 * arbitrary-execution path standing open precisely while the gate enforced
 * nothing. Same shape as the `vigiles compile` escape one layer down: a command
 * believed inert because of what it MEANS rather than what it DOES.
 *
 * ## Why the replacement is a write, not a safer command
 *
 * `git -c core.hooksPath=/nonexistent …` does suppress all three (measured: no
 * hook ran for any of them). It was rejected anyway. It puts free-form structure
 * back into the accepted string — the exact thing five findings on the compile
 * door came from — and it buys nothing, because MEASURED on the load-wedge
 * fixture a plain file write already restores the gate to ENFORCING:
 *
 *   wedged     : `ls` refused
 *   after Edit : `ls` allowed, `git push --force` DENIED by the hook's own reason
 *
 * You do not need to finish recovering, only to stop being wedged. Once the hook
 * loads, the gate decides normally and `git merge --abort` is an ordinary allowed
 * command — through the gate, not around it.
 *
 * ## What is accepted
 *
 * A write to the hook's own source, its stamp sidecar, or one of
 * {@link HARNESS_CONFIG_FILES}. That set is COMPLETE for a compiled hook rather
 * than a guess: `checkHookImports` rejects every import but `vigiles/hook`, so the
 * load path is the hook file plus the config that resolves that specifier —
 * nothing else can break it.
 *
 * A file write executes nothing, which is the property no command on this door
 * ever had.
 *
 * ## …IN THIS REPOSITORY, which is a separate question
 *
 * "A write executes nothing" answers the EXECUTION objection and says nothing
 * about SCOPE. Under the suffix comparison this used to do, a write to
 * `/home/another-project/package.json` was accepted while THIS repo was wedged —
 * a file that cannot repair the failure, in a checkout the wedged session has no
 * business touching. Every candidate is now resolved against
 * {@link HookRepoPaths.root} and compared whole against the paths the runtime
 * itself derived ({@link HookRepoPaths.loadPathFiles}, plus this root's
 * {@link HARNESS_CONFIG_FILES} so the floor case can never be argued away).
 *
 * ⚠️ THE HOOK'S OWN PATH DOES NOT GIVE THE ROOT, so the caller passes it. A hook
 * lives at `.claude/hooks/…`, `.vigiles/hooks/…`, a plugin subdirectory or the
 * repo root itself; there is no fixed depth to walk up, and finding a `.git`
 * marker would mean reading disk, which core does not do. Nor would a
 * git-derived root be RIGHT: `verifyStampOrRefuse` reads the hook and its stamp
 * sidecar via `process.cwd()`, so any other root would accept writes to files
 * the runtime does not read — repairs that do not repair. The root is therefore
 * the one the rest of the runtime already uses, and it is passed in rather than
 * invented here.
 */
export function isLoadPathRepairEvent(
  event: RawHookEvent,
  hookFile: string,
  repo: HookRepoPaths,
): boolean {
  if (isStampRepairEvent(event, hookFile, repo.root)) return true;
  const filePath = repairTargetOf(event);
  if (filePath === null) return false;
  const target = resolveRef(repo.root, filePath);
  return [...HARNESS_CONFIG_FILES, ...repo.loadPathFiles].some(
    (f) => target === resolveRef(repo.root, f),
  );
}
