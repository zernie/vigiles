/**
 * vigiles — the *unit* tier for agent hooks.
 *
 * A hook is just a process with a protocol on top: the harness pipes a JSON
 * event to its stdin and reads back an exit code (0 ok, 2 = block) and,
 * optionally, a JSON decision on stdout. `runHook` is exactly that protocol —
 * and nothing else.
 *
 * Everything underneath (spawning, shells, stdin, confinement, egress recording,
 * write recording) lives in `./run-script.ts`, because none of it is about
 * hooks. This module is the thin specialization:
 *
 *     runHook  =  runScript  +  event-to-stdin  +  exit-code-to-decision
 *
 * Reach for {@link runScript} instead when the thing under test is an ordinary
 * program — a helper script has effects, not a decision, and its result type
 * says so.
 *
 *   const r = runHook('"$GUARD"', {
 *     hook_event_name: "PreToolUse",
 *     tool_name: "Bash",
 *     tool_input: { command: "git commit --no-verify" },
 *   }, { env: { GUARD: guardPath } });
 *   assert.ok(r.blocked);            // exit 2 / decision:block / permission:deny
 *
 * Why this exists alongside `runHarnessTest`:
 *   - It is the cheap base of the pyramid — no CLI dependency, runs anywhere.
 *   - It reaches every event. The deterministic `runHarnessTest` mock can drive
 *     SessionStart/Stop/UserPromptSubmit/Bash PreToolUse|PostToolUse, but NOT
 *     Edit/Write tool events (headless-gated), PreCompact, Notification,
 *     SessionEnd, or SubagentStop. At this tier you hand the hook the event
 *     JSON yourself, so all of them are testable.
 *
 * It does NOT prove the hook is *wired* into the harness (that the settings
 * point at it, that `${CLAUDE_PLUGIN_ROOT}` resolves) — that is what the
 * `plugin:` loader + `runHarnessTest` cover. Use both: unit-test the hook's
 * logic here, then assert it fires in the assembled machine there.
 */
import type { HookProtocol } from "./core/hook-protocol.js";
import { decideHookCondition } from "./core/hook-condition.js";
import { claudeCodeHookProtocol } from "./adapters/claude-code/hook-protocol.js";
import { propertyTest } from "./core/proofs.js";
import { trimTrailingSeparators } from "./core/hook-program.js";
import {
  runScriptWith,
  REAL_DEPS,
  type RunScriptOptions,
  type ScriptRunResult,
  type RunScriptDeps,
} from "./run-script.js";

export type { EgressAttempt } from "./run-script.js";
// The general runner this module specializes. Re-exported so the `vigiles` root's
// hook surface and the script surface stay one import away from each other.
export { runScript, runScriptWith, egressRoutes } from "./run-script.js";
export type {
  RunScriptOptions,
  ScriptRunResult,
  ScriptSpawnResult,
  ScriptSpawner,
  RunScriptDeps,
} from "./run-script.js";

/**
 * Options for {@link runHook} — every {@link RunScriptOptions} knob except
 * `stdin`, which the hook layer owns (it serializes the event there).
 */
export type RunHookOptions = Omit<RunScriptOptions, "stdin"> & {
  /**
   * The hook's CONDITION as the harness config writes it — Claude Code's `if`,
   * e.g. `"Bash(git push *--force*)"`. When the condition does not match the
   * event, the harness never spawns the hook, so neither do we: the result comes
   * back `ran: false`, `blocked: false`.
   *
   * 🔴 PASS IT WHENEVER THE HOOK YOU ARE TESTING DECLARES ONE. A conditional hook
   * tested without its condition is tested as an unconditional one, and since the
   * bodies of real conditional guards are unconditional denies, that reports the
   * guard as blocking everything you feed it. See `core/hook-condition.ts`.
   */
  readonly condition?: string;
  /**
   * The harness whose wire protocol + condition grammar to use. Defaults to
   * Claude Code, so every existing caller is unaffected.
   */
  readonly protocol?: HookProtocol;
};

// ---------------------------------------------------------------------------
// propertyHook — invariant testing for a hook's (event) → decision (Phase 5 of
// research/testing-api-design.md). A hook is a pure-ish function; instead of a
// few example events, generate MANY (mutate from a seed) and assert invariants
// hold for every decision — "never both allow and block", "PostToolUse output is
// always valid JSON", etc. Reuses the deterministic `propertyTest` from
// proofs.ts (no fast-check dep; seeded, shrinks the counterexample). The `decide`
// runner is injectable, so the loop is unit-testable with a pure fake; pass
// `(e) => runHook(cmd, e)` to property-test a real hook.
// ---------------------------------------------------------------------------

/** Result of {@link propertyHook}: the first shrunk counterexample, if any. */
export interface HookPropertyResult<E> {
  readonly passed: boolean;
  readonly iterations: number;
  /** The (shrunk) event that broke an invariant — present iff `!passed`. */
  readonly counterexample?: E;
  /** Which invariant failed — present iff `!passed`. */
  readonly failedInvariant?: string;
}

/**
 * Property-test a hook's decision over generated events. Throws nothing — returns
 * a result you assert on (`assert.ok(r.passed)`), so the counterexample is
 * inspectable. `mutate(event, rng)` produces a variation from the running event;
 * each named invariant is checked against `decide(event)`.
 */
export function propertyHook<E, D>(opts: {
  readonly seed: E;
  readonly mutate: (event: E, rng: number) => E;
  readonly decide: (event: E) => D;
  readonly invariants: Record<string, (decision: D, event: E) => boolean>;
  readonly iterations?: number;
}): HookPropertyResult<E> {
  const wrapped: Record<string, (e: E) => boolean> = {};
  for (const [name, inv] of Object.entries(opts.invariants)) {
    wrapped[name] = (e: E) => inv(opts.decide(e), e);
  }
  const r = propertyTest(opts.seed, opts.mutate, wrapped, {
    iterations: opts.iterations ?? 100,
    sequenceLength: 1, // each event is independent — no mutation sequence
    seed: 1,
  });
  if (r.passed) return { passed: true, iterations: r.iterations };
  const last = r.failingSequence?.[r.failingSequence.length - 1];
  return {
    passed: false,
    iterations: r.iterations,
    counterexample: r.shrunk ?? last,
    failedInvariant: r.failedInvariant,
  };
}

/** A hook event payload (the JSON Claude Code writes to the hook's stdin). */
export interface HookInput {
  /** e.g. "PreToolUse", "PostToolUse", "Stop", "SessionStart", "PreCompact". */
  readonly hook_event_name?: string;
  /** PreToolUse/PostToolUse. */
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  /** UserPromptSubmit. */
  readonly prompt?: string;
  /** SessionStart. */
  readonly source?: string;
  /** Stop / SubagentStop. */
  readonly stop_hook_active?: boolean;
  /** Any other event-specific fields. */
  readonly [k: string]: unknown;
}

/** Options for {@link fileToolEvents}. */
export interface FileToolEventOptions {
  /** The hook event. Default `"PostToolUse"` (the react tier's event). */
  readonly event?: string;
  /** The tool. Default `"Edit"`. */
  readonly tool?: string;
  /**
   * The project root the absolute spelling is built from, and the value put in
   * each event's `cwd`. Defaults to `$CLAUDE_PROJECT_DIR`, then `process.cwd()`
   * — a TEST may read its own cwd, the RUNTIME may not (see `projectRootOf`).
   */
  readonly root?: string;
  /** Extra `tool_input` fields (`old_string`, `content`, …). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Extra top-level event fields. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * BOTH spellings of one file-tool event — `[relative, absolute]` — so a hook
 * test cannot pin only the spelling its author had in mind.
 *
 * 🔴 THIS EXISTS BECAUSE THE MISSING HALF HID A DEAD HOOK. Every hook test in
 * reach built `{ tool_input: { file_path: "migratsiya/papers/x.tex" } }` by
 * hand — repo-relative, because that is how the hook's own prefixes are written.
 * Claude Code's Edit/Write/MultiEdit tools send an ABSOLUTE `file_path`,
 * `PathView.under` had no project root to reconcile the two, and so three
 * shipped react hooks matched nothing in a real session while their tests stayed
 * green. The tests were not weak; they reproduced the author's assumption
 * instead of the runtime's behaviour.
 *
 * Iterating is the point — there is deliberately no singular builder here:
 *
 *     for (const e of fileToolEvents("migratsiya/papers/x.tex"))
 *       assert.ok(hookFired(runHook(cmd, e)));
 *
 * Each event also carries `cwd`, so a hook run WITHOUT `$CLAUDE_PROJECT_DIR` in
 * its environment still resolves a root — the same fallback the live runtime uses.
 *
 * @param path - the file, as a repo-relative path.
 */
export function fileToolEvents(
  path: string,
  opts: FileToolEventOptions = {},
): readonly [HookInput, HookInput] {
  // `??` alone would let an EMPTY string through — the same silent failure by a
  // second door, since `projectRootOf` skips an empty `cwd` exactly as it skips
  // an empty `$CLAUDE_PROJECT_DIR`. An unset-looking root falls through to the
  // next source rather than becoming an event nothing can decide.
  // 🔴 AND A RELATIVE ROOT IS SKIPPED THE SAME WAY AN EMPTY ONE IS — the sibling
  // of the same fix in `projectRootOf`, and it had to be made twice because the
  // first one was made in only one of the two places. Picking `.` here produced
  // `./src/x.ts` as the "absolute" entry and set `cwd: "."`, which the runtime
  // then rejects as unusable — so the helper handed back TWO relative spellings
  // and the absolute behaviour it exists to exercise went untested again. That
  // is precisely the hole this helper was written to close, reopened by its own
  // root selection.
  const root = trimTrailingSeparators(
    [opts.root, process.env.CLAUDE_PROJECT_DIR, process.cwd()].find(
      (r) => typeof r === "string" && r.trim() !== "" && isAbsolutePath(r),
    ) ?? process.cwd(),
  );
  const rel = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = {
    // `opts.extra` spreads FIRST, for the same reason `opts.input` does below:
    // extras copied from a real hook event carry a `cwd`, and spread last it
    // would replace the root this helper just selected. The absolute entry would
    // still be BUILT from `opts.root` but EVALUATED against someone else's cwd —
    // so the helper would hand back a pair that no longer tests the spelling it
    // promises, and nothing would fail to say so.
    ...opts.extra,
    hook_event_name: opts.event ?? "PostToolUse",
    tool_name: opts.tool ?? "Edit",
    cwd: root,
  };
  const build = (file_path: string): HookInput => ({
    ...base,
    // `opts.input` spreads FIRST. Spread last, a caller reusing a real
    // `tool_input` fixture — the most natural way to use this — would have its
    // own `file_path` overwrite the generated one in BOTH tuple entries, so the
    // helper would hand back the same spelling twice while looking like it
    // returned two. That defeats its single reason to exist, and it defeats it
    // silently: both events still run, both still pass, and the absolute
    // spelling nobody tested is the one the runtime actually sends.
    tool_input: { ...opts.input, file_path },
  });
  // A root that IS a separator keeps it (see `trimTrailingSeparators`), so joining must
  // not add a second one — `//x` is a UNC path, not a file at the POSIX root.
  const sep = /[/\\]$/.test(root) ? "" : "/";
  return [build(rel), build(`${root}${sep}${rel}`)];
}

/** Absolute in the POSIX, drive-rooted, or UNC sense — the three the runtime accepts. */
const isAbsolutePath = (p: string): boolean => /^([/\\]|[A-Za-z]:)/.test(p);

/**
 * A project root with ordinary trailing separators trimmed — but never trimmed
 * down to something that is no longer a root.
 *
 * 🔴 THE CARVE-OUT IS THE WHOLE POINT, AND ITS FAILURE IS SILENT. Stripping
 * every trailing separator turns the POSIX root `"/"` into `""` and the Windows
 * drive root `"C:\"` into `"C:"`. The runtime accepts neither: `projectRootOf`
 * skips an empty `cwd`, and `usableRoot` requires an ABSOLUTE ref, which is `/x`
 * or `C:/x` — a bare drive letter is not one. So the event is still built and
 * the hook still runs; its ABSOLUTE spelling merely stops resolving, every
 * repo-relative prefix misses, and a negative assertion passes while pinning
 * nothing. That is precisely the dead-hook-behind-a-green-test shape this
 * helper's second spelling exists to prevent — reintroduced by the helper.
 *
 * A bare `"C:"` with no separator at all gets one for the same reason: what
 * comes back is always a root the runtime can use.
 */

/** The JSON a hook may print on stdout (all fields optional). */
export interface HookOutput {
  readonly decision?: "approve" | "block";
  readonly reason?: string;
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly permissionDecision?: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
  readonly [k: string]: unknown;
}

export interface HookRunResult extends ScriptRunResult {
  /** Parsed stdout JSON if the hook emitted a JSON decision, else null. */
  readonly json: HookOutput | null;
  /**
   * Normalized decision: the dangerous call did NOT go through. Set by exit 2,
   * `decision:"block"`, `permissionDecision:"deny"`, or the harness's
   * halt-the-turn field (Claude Code `{"continue": false}` — see
   * {@link HookRunResult.haltsTurn}).
   *
   * The halt case was missing until 2026-08-31 (#174), and the shape of that bug
   * is worth keeping written down: `verifyGuardrail` reads this field, so a real
   * `PreToolUse` guard that stopped every one of the disaster battery's commands
   * was reported by `assertBlocksDisasters` as blocking NONE of them. A tool
   * whose stated job is catching a guard that looks fine and silently does
   * nothing said the opposite about a working guard — the same false-confidence
   * failure, with the sign flipped.
   */
  readonly blocked: boolean;
  /**
   * The hook halted the WHOLE TURN rather than denying one call — the harness's
   * `haltsTurnField` came back `false`.
   *
   * Reported separately because it is strictly stronger than a deny and the two
   * are worth telling apart when a test asks WHICH mechanism fired. `blocked`
   * stays the question nearly every caller means ("did the action happen?"), so
   * a halt sets both.
   */
  readonly haltsTurn: boolean;
  /**
   * Every block mechanism that fired, from the closed {@link BlockMechanism}
   * set. Reported so the next mechanism needs no new boolean on this interface —
   * `haltsTurn` exists because the halt case was added as a one-off, and this is
   * the shape that stops the pattern repeating.
   */
  readonly blockedBy: readonly BlockMechanism[];
  /**
   * The decision the hook expressed, preferring the structured
   * `permissionDecision` ("allow"|"deny"|"ask") then legacy `decision`
   * ("approve"|"block"), else undefined.
   */
  readonly decision:
    | HookOutput["decision"]
    | "allow"
    | "deny"
    | "ask"
    | undefined;
  /**
   * Whether the hook process was actually SPAWNED. False only when a declared
   * condition (`RunHookOptions.condition`) did not match, meaning the harness
   * would not have run it either.
   *
   * 🔴 READ THIS BEFORE READING `blocked`. `ran: false` and a hook that ran and
   * allowed both arrive as `blocked: false`, and they are completely different
   * facts — "the harness would never invoke this guard here" versus "the guard
   * looked and let it through". Collapsing them is what let a conditional guard
   * be reported as blocking a battery it cannot see.
   */
  readonly ran: boolean;
  /** Why the hook ran or did not — the condition verdict, always present. */
  readonly conditionReason: string;
}

/** Parse stdout as a hook JSON decision (pure, testable without a process). */
export function parseHookOutput(stdout: string): HookOutput | null {
  const s = stdout.trim();
  if (!s.startsWith("{")) return null;
  try {
    return JSON.parse(s) as HookOutput;
  } catch {
    return null;
  }
}

/**
 * The ways a hook can stop an action — a CLOSED set, listed once.
 *
 * 🔴 WHY A TABLE AND NOT THREE `||` TERMS. `decideHook` used to be a boolean
 * expression over three mechanisms while `HookOutput` declared a fourth,
 * `continue`, that nothing read (#174). The consequence was not a missed
 * detection but an INVERTED verdict in the flagship feature: a real guard that
 * stopped every command in the disaster battery was reported by
 * `assertBlocksDisasters` as blocking none of them.
 *
 * A `||` chain has no shape that can be incomplete — every term is optional by
 * construction, so nothing can say "you declared a mechanism and did not handle
 * it". `Record<BlockMechanism, …>` can: adding a member to the union without
 * adding its row is a tsc error, the same device that keeps `RULE_META` honest.
 */
export type BlockMechanism = "exit-code" | "deny-decision" | "halt-field";

interface BlockContext {
  readonly exitCode: number;
  readonly json: HookOutput | null;
  readonly protocol: HookProtocol;
}

const BLOCK_MECHANISMS: Record<BlockMechanism, (ctx: BlockContext) => boolean> =
  {
    "exit-code": ({ exitCode, protocol }) =>
      exitCode === protocol.blockExitCode,
    "deny-decision": ({ json, protocol }) => {
      const decision =
        json?.hookSpecificOutput?.permissionDecision ?? json?.decision;
      return (
        decision !== undefined && protocol.denyDecisionValues.includes(decision)
      );
    },
    // Read from the PORT, never hard-coded: `"continue"` is a documented Claude
    // Code fact and unverified for Codex, so the harness that has it declares it
    // (core ⊄ adapter). `=== false` and not falsy — an absent field is not a halt.
    "halt-field": ({ json, protocol }) => {
      const field = protocol.haltsTurnField;
      return field !== undefined && json?.[field] === false;
    },
  };

/**
 * Decide whether a hook result blocked, and the normalized decision. Pure, so
 * the policy is unit-testable independent of spawning anything.
 *
 * Folds the closed {@link BLOCK_MECHANISMS} table rather than testing three
 * conditions inline, so a mechanism cannot be declared and left unhandled.
 */
export function decideHook(
  exitCode: number,
  json: HookOutput | null,
  protocol: HookProtocol = claudeCodeHookProtocol,
): {
  blocked: boolean;
  decision: HookRunResult["decision"];
  haltsTurn: boolean;
  blockedBy: readonly BlockMechanism[];
} {
  const permission = json?.hookSpecificOutput?.permissionDecision;
  const decision = permission ?? json?.decision;
  const ctx: BlockContext = { exitCode, json, protocol };
  // EVERY mechanism is evaluated, not the first match: a hook may both exit 2
  // and halt the turn, and reporting only the first would make `haltsTurn`
  // depend on the table's order.
  const blockedBy = (Object.keys(BLOCK_MECHANISMS) as BlockMechanism[]).filter(
    (kind) => BLOCK_MECHANISMS[kind](ctx),
  );
  return {
    blocked: blockedBy.length > 0,
    decision,
    // Derived, not computed twice — the next mechanism needs no new boolean.
    haltsTurn: blockedBy.includes("halt-field"),
    blockedBy,
  };
}

/**
 * The hook layer over {@link runScriptWith}: serialize the event to stdin, run
 * the program, then read the exit code + stdout JSON as a normalized decision.
 * Exported so the decision logic is unit-testable with fake spawners — no real
 * bwrap. `runHook` is this with the real seams.
 */
export function runHookWith(
  command: string,
  input: HookInput,
  opts: RunHookOptions,
  deps: RunScriptDeps,
): HookRunResult {
  const protocol = opts.protocol ?? claudeCodeHookProtocol;
  // The condition is decided BEFORE the spawn, because that is what the harness
  // does — a non-matching `if` means the process never starts. Deciding it after
  // would still report the right verdict but would run the user's hook for an
  // event the harness would never have handed it.
  const verdict = decideHookCondition(
    opts.condition,
    {
      event: input.hook_event_name ?? "",
      tool: input.tool_name ?? "",
      input: (input.tool_input ?? {}) as Record<string, unknown>,
    },
    protocol.condition,
  );
  if (!verdict.runs)
    return {
      ...skippedScriptResult(),
      json: null,
      blocked: false,
      decision: undefined,
      haltsTurn: false,
      blockedBy: [],
      ran: false,
      conditionReason: verdict.why,
    };

  // 🔴 A SPAWN DIRECTORY WITH NO DECLARED ROOT MEANS "THIS DIRECTORY IS THE
  // PROJECT". Without this, a test that says `{ cwd: dir }` and nothing else
  // inherits whatever `$CLAUDE_PROJECT_DIR` the AMBIENT shell exports, and since
  // the runtime prefers the env over the payload (see `projectRootOf`), the hook
  // resolves a root the test never named. Measured 2026-09-19: five rail suites
  // pass with the variable unset — which is CI, and this container — and fail
  // when it is set, which is any run inside a live Claude Code session. That is
  // a one-sided failure, invisible exactly where it would be caught.
  //
  // An EXPLICIT value always wins, including the empty string: a test that pins
  // `CLAUDE_PROJECT_DIR: ""` is saying "no env root, resolve from the payload",
  // and that case has its own coverage.
  const rooted: RunHookOptions =
    opts.cwd !== undefined &&
    !Object.prototype.hasOwnProperty.call(opts.env ?? {}, "CLAUDE_PROJECT_DIR")
      ? { ...opts, env: { ...opts.env, CLAUDE_PROJECT_DIR: opts.cwd } }
      : opts;

  const res = runScriptWith(command, JSON.stringify(input), rooted, deps);
  const json = parseHookOutput(res.stdout);
  const { blocked, decision, haltsTurn, blockedBy } = decideHook(
    res.exitCode,
    json,
    protocol,
  );
  return {
    ...res,
    json,
    blocked,
    decision,
    haltsTurn,
    blockedBy,
    ran: true,
    conditionReason: verdict.why,
  };
}

/**
 * The `ScriptRunResult` shape for a hook that was never spawned. Exit code 0 and
 * empty streams describe reality: no process existed, so the tool call proceeded.
 * The fact that distinguishes this from a hook that ran and allowed is `ran`.
 *
 * `egressDropped` and `filesWritten` stay UNDEFINED on purpose — they mean
 * "recorded nothing", and nothing was recorded because nothing ran. Filling them
 * with zeroes would claim an observation that never happened, which is the same
 * class of lie this whole change removes.
 */
function skippedScriptResult(): ScriptRunResult {
  return { exitCode: 0, stdout: "", stderr: "", egress: [] };
}

/**
 * Run a hook command, piping `input` as JSON to its stdin, and report the exit
 * code + parsed decision. Synchronous (so it can be used inside an eval's
 * `measure` too). `command` is run through a shell, so the same command string a
 * plugin ships (with args / env refs) works verbatim. Mark a hook you didn't
 * write with `trusted: false` and it is confined by default (or pass `sandbox:
 * "auto"` directly) — see {@link RunScriptOptions.trusted}.
 *
 * Testing a program that is NOT a hook? Use {@link runScript}.
 */
export function runHook(
  command: string,
  input: HookInput,
  opts: RunHookOptions = {},
): HookRunResult {
  return runHookWith(command, input, opts, REAL_DEPS);
}
