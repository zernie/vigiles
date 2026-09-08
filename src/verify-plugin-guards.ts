/**
 * Sweep the disaster battery across every hook a plugin/repo actually DECLARES.
 *
 * 🔴 THE GAP THIS CLOSES, and it is the same one twice. `verifyGuardrail` takes a
 * COMMAND STRING. #211 taught it to honour a hook's `if:` condition — but only
 * when the caller remembers to pass it, and its own comment says so:
 *
 *     // `condition` + `protocol` are inherited from RunHookOptions — pass the
 *     // hook's declared `if` here …
 *
 * So "forgot to pass the condition" stayed a reachable state, and reaching it
 * produces exactly the false 7/7 that #211 existed to kill. The fix is not
 * another warning: it is to stop asking the caller for facts the config already
 * holds. This function reads the hook's command, event, matcher AND condition off
 * the same registration, so the three cannot be paired wrongly.
 *
 * WHAT IT IS NOT. It reports; it does not judge. There is deliberately no
 * throwing `assertPluginGuards`, because intent is DECLARED PER HOOK and a repo's
 * config declares none of it — we do not know which of a plugin's five hooks is
 * meant to be a bash-safety guard. `assertBlocksDisasters` remains the gate you
 * reach for once YOU have said which hook must block what; this is the sweep that
 * tells you which hooks are even in the conversation. Same neutrality
 * `formatGuardrailReport` already commits to, one level up.
 *
 * FOUR THINGS THAT ARE NOT A VERDICT, and each has its own shape rather than a
 * quietly-zero score — the whole lesson of #211 is that a missing RUN must never
 * be readable as a finding:
 *
 *   - a hook on another EVENT (`Stop`, `SessionStart`, a `PostToolUse` nudge) is
 *     never asked about these calls at all;
 *   - a hook whose MATCHER cannot select the battery's tools likewise;
 *   - a hook whose CONDITION rejects every event its matcher did select — the
 *     harness spawns it for none of them, so there is no program to score;
 *   - a hook whose COMMAND still names a variable nobody has set cannot be run as
 *     the harness runs it, so running it would measure a different program.
 *
 * 🔴 THE THIRD WAS MISSED AND WAS COUNTED, which is why the list says FOUR. The
 * other three are settled before a spawn; the condition is settled per event
 * INSIDE the run, so `matcher: "Bash"` with `if: "Bash(terraform apply*)"` came
 * back `measured` with every row not-run, rendered as `blocks 0/7`, and left
 * `notes` silent because a hook had been "measured". Reported as a guard that
 * blocks nothing; actually a guard the harness never started. See `sweepHook`.
 *
 * A plugin with no hooks reports zero of everything and says so in `notes`. None
 * of these is "safe" and none is "blocks nothing".
 *
 * 🔴 KNOWN REMAINDER, and it is one class rather than a list of spellings
 * (zernie/vigiles#213). `blocked` is decided by exit code 2, and an interpreter
 * that cannot start its script ALSO exits 2 — so a guard that never ran and a
 * guard that denied are the same observation. The preflight below is a PROXY for
 * "did it run": it resolves the script and reports `unresolved` when the file is
 * absent. Review has defeated that proxy five times; two are fixed here (a
 * wrapper hiding the interpreter, a wrong execution cwd) and three are NOT:
 *
 *   - a command-local assignment — `GUARD=missing.py; python3 "$GUARD"`;
 *   - a dominating `cd` — `cd hooks && python3 guard.py`;
 *   - a command substitution that really executes — `result=$(python3 missing.py)`.
 *
 * AND TWO IN THE OPPOSITE DIRECTION, named here because the fix for them is the
 * same "resolve harder" reflex and it is the same mistake. These do not
 * manufacture a score — they REFUSE one a real guard had earned, so a hook that
 * exists reads as `unresolved`. Both UNDER-report, which is why they are
 * remainder rather than defect:
 *
 *   - a TILDE — `python3 ~/.claude/hooks/guard.py`. Tilde expansion is the
 *     shell's, not the parser's, so the ref stays literal and `resolve(cwd, ref)`
 *     probes `<cwd>/~/.claude/…`. Measured: a guard present at
 *     `$HOME/.claude/hooks/` is reported as not on disk.
 *   - `$PWD` UNDER CONFINEMENT — it is absent from the confined name set below
 *     (`HOME`, `TMPDIR`, `PATH`), because `bwrapArgs` does not set it; but
 *     `/bin/sh` initializes `PWD` itself after bubblewrap's `--chdir`, so the
 *     variable IS set by the time the hook reads it. Measured: the same command
 *     scores 7/7 unconfined and reads `unresolved` confined.
 *
 * Do not "fix" these by resolving harder. Extracting a script path from an
 * arbitrary shell command is the same undecidable problem `bash-effects.ts`
 * documents for itself, where `eval`, a `$VAR` head and `sh -c` normalize to
 * `null` BY CONSTRUCTION. Each patch buys one spelling and leaves the class open.
 * What closes it is a CONTROL PROBE: one benign command the guard must ALLOW,
 * run beside the battery — blocked too ⇒ the program is not blocking, it is
 * failing to start, and the hook is `unmeasurable` rather than scored. The same
 * in-run-control shape `src/subagent-delivery.test.ts` already relies on.
 *
 * HARNESS-AGNOSTIC, with Claude Code as the default — the same shape as
 * {@link runHarnessTest}. Every piece it composes already takes its harness by
 * injection: `loadPlugin` takes a `PluginLayout`, `normalizeHooks` reads both the
 * CC-nested and Codex-flat shapes, and `decideHookCondition` treats a harness that
 * declares no condition support as having none. Narrowing this to Claude Code
 * would have been a choice, not a constraint, and `harness-parity-and-extensibility`
 * forbids the CC-first-and-bolt-the-rest-on shape. A harness whose hooks are not
 * shell processes (`capabilities.shellHooks === false`, e.g. OpenCode) reports
 * n/a in `notes` rather than an empty success.
 */
import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { loadPlugin } from "./plugin-loader.js";
import {
  normalizeHooks,
  nonCommandHookActions,
  type HookRegistration,
  type NonCommandHookAction,
} from "./core/hook-normalize.js";
// Re-exported because `PluginGuardReport.unmeasurable` is typed with it: a
// consumer folding that list must be able to NAME what is in it.
export type { NonCommandHookAction } from "./core/hook-normalize.js";
import { hookMatcherReach } from "./core/hook-matcher.js";
import { shellVarReads } from "./core/shell-vars.js";
import { commandFileRefs } from "./core/command-files.js";
import { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";
import { sandboxAvailable } from "./sandbox.js";
import { egressAvailable } from "./egress.js";
import { routeScriptRun, shellNeverLaunched } from "./run-script.js";
import type { HarnessAdapter } from "./core/adapter.js";
import {
  DISASTER_CATALOG,
  guardrailRow,
  verifyGuardrail,
  type DisasterCategory,
  type DisasterEvent,
  type GuardrailResult,
} from "./guardrail-check.js";
import type { RunHookOptions } from "./run-hook.js";

/** The hook a sweep looked at, as its config declares it. */
export interface SweptHook {
  /** The event it registers under, e.g. `"PreToolUse"`. */
  readonly event: string;
  /** Its tool matcher, or `null` when it declares none (matches everything). */
  readonly matcher: string | null;
  /** Its condition as written (Claude Code's `if`), or `null` when unconditional. */
  readonly condition: string | null;
  /** The command, with the harness's plugin-root token already expanded. */
  readonly command: string;
  /**
   * Its position in the flattened registration list, so two hooks sharing a
   * command are still distinguishable in a report. Stable for one sweep of one
   * directory; not an identity across versions.
   */
  readonly index: number;
}

/**
 * What happened to one hook. A DISCRIMINATED UNION, not a result list plus three
 * nullable fields: `results` exists on exactly the outcome that has them, so
 * "read the score of a hook that was never run" is a type error rather than a
 * `0/7` someone quotes.
 */
export type SweptHookOutcome =
  | {
      /** The battery reached this hook; `results` holds one entry per event. */
      readonly status: "measured";
      readonly hook: SweptHook;
      /** One result per battery event, in catalog order. */
      readonly results: readonly GuardrailResult[];
      /** Ids of the events it denied. */
      readonly blocked: readonly string[];
      /** Ids it ran on and let through. */
      readonly allowed: readonly string[];
      /** Ids the harness would never have handed it (condition did not match). */
      readonly notRun: readonly string[];
    }
  | {
      /**
       * The battery does not apply to this hook — a different event, or a matcher
       * that selects none of the battery's tools. NOT a score of zero.
       */
      readonly status: "not-applicable";
      readonly hook: SweptHook;
      /** One line naming which of the two it is, and against what. */
      readonly reason: string;
    }
  | {
      /**
       * The command names a variable nothing has set, so the program we would run
       * is not the program the harness runs. Refusing is the honest answer; the
       * fix is in the caller's hands (pass `env`).
       */
      readonly status: "unresolved";
      readonly hook: SweptHook;
      /** One line naming the unset variables. */
      readonly reason: string;
    };

/** The whole sweep. */
export interface PluginGuardReport {
  /** The directory swept, resolved to an absolute path. */
  readonly dir: string;
  /** The adapter that read it, e.g. `"claude-code"`. */
  readonly harness: string;
  /** The event each disaster was delivered as (default `"PreToolUse"`). */
  readonly event: string;
  /** The battery that was used, so a report says what it measured against. */
  readonly events: readonly DisasterEvent[];
  /** One outcome per declared COMMAND hook, in config order. */
  readonly hooks: readonly SweptHookOutcome[];
  /**
   * Declared actions this tier cannot drive because they are not commands —
   * `prompt`, `http`, `mcp_tool`, `agent`.
   *
   * 🔴 THEY USED TO BE DROPPED, AND DROPPING THEM MANUFACTURED THE FALSE EMPTY
   * `notes` exists to prevent. A repository whose hooks are all `prompt` actions
   * has declared guards; it was reported as declaring none, in the words of the
   * one sentence this report writes to be sure nobody reads an empty result as a
   * clean bill of health. Not measured is a limit of the tier and says so; not
   * declared is an accusation about the repository, and it was not true.
   *
   * They carry no score and never will here — a shell battery cannot drive a
   * prompt — so they are a separate list rather than a fourth outcome status
   * with an invented command.
   */
  readonly unmeasurable: readonly NonCommandHookAction[];
  /**
   * Why the sweep measured less than a reader might assume — no COMMAND hooks
   * declared, a harness with no shell hooks, every hook on another event, or an
   * action this tier cannot drive. Empty only when at least one hook was
   * measured AND nothing was left undrivable: an undrivable action is a gap in
   * COVERAGE, so it is said even when other hooks scored.
   *
   * 🔴 THIS IS THE EMPTY CASE'S VOICE. `hooks: []` on its own reads as a clean
   * bill of health, which is the exact false confidence the battery exists to
   * remove — so a sweep that measured nothing always says so in words.
   */
  readonly notes: readonly string[];
}

/** Options for {@link experimental_verifyPluginGuards}. */
export interface VerifyPluginGuardsOptions extends Omit<
  RunHookOptions,
  "condition" | "protocol"
> {
  /**
   * The harness to read the repo as. Defaults to Claude Code, so an existing
   * Claude Code repo needs nothing. The condition grammar and the block protocol
   * both come from this adapter's `hookProtocol`.
   */
  readonly adapter?: HarnessAdapter;
  /** Restrict the battery to these categories (default: the whole catalog). */
  readonly categories?: readonly DisasterCategory[];
  /** Override the battery entirely. */
  readonly events?: readonly DisasterEvent[];
  /** The event each disaster is delivered as (default `"PreToolUse"`). */
  readonly event?: string;
}
// `condition` and `protocol` are deliberately NOT accepted: the condition is read
// per hook from the config, and the protocol comes from the adapter. Letting a
// caller pass either would reintroduce the pairing mistake this exists to make
// unrepresentable — one hook's `if` applied to a different hook's command.

const DEFAULT_EVENT = "PreToolUse";

/**
 * Variables the command DEPENDS ON that nothing would set at run time.
 *
 * Two filters, and both exist because a false `unresolved` costs a real guard
 * its measurement. The first is the shell's own reading of the command
 * (`shellVarReads`, a real parse): a name the command ASSIGNS for itself before
 * reading it, or one written inside single quotes, is not a dependency however
 * much it looks like `$NAME`. The second is the environment the hook would
 * ACTUALLY get — see {@link hookEnvironment}, which is why the set is passed in
 * rather than read from `process.env` here.
 */
function unsetVariables(command: string, names: ReadonlySet<string>): string[] {
  return shellVarReads(command).reads.filter((name) => !names.has(name));
}

/**
 * Files the command hands to a program to run, that are not there.
 *
 * 🔴 THIS IS THE ONE THE EXIT CODE CANNOT ANSWER, and it was the sweep's loudest
 * lie. `python3 <missing>.py` exits **2**, which is Claude Code's DENY code, so
 * a hook whose script does not exist was reported as blocking every disaster in
 * the battery — a perfect score for a guard that does not exist. Measured on the
 * unfixed build: `blocks=7/7 exits=2,2,2,2,2,2,2`. Unlike the uncompilable
 * matcher, no malformed config is needed to reach it: a relative script path is
 * the commonest hook shape there is.
 *
 * Resolution is against the cwd the hook will actually run in, because that is
 * the only directory a relative path means anything against. See
 * `core/command-files.ts` for what counts as a file reference and the corpus
 * measurement behind that narrowing.
 */
function missingFiles(
  command: string,
  cwd: EffectiveCwd,
  values: Readonly<Record<string, string>>,
): string[] {
  return commandFileRefs(command, values).refs.filter((ref) => {
    // 🔴 A RELATIVE PATH IS MISSING BY CONSTRUCTION IN A FRESH EMPTY DIRECTORY.
    // A confined run with no `cwd` is chdir'd into a directory `sandboxedSpawn`
    // just created, so nothing relative can be there — while the host's `/` is
    // ro-bound, which is why an ABSOLUTE ref is still tested on disk.
    if (!isAbsolute(ref))
      return cwd.kind === "fresh-empty" || !existsSync(resolve(cwd.dir, ref));
    return !existsSync(ref);
  });
}

/** The battery, after `categories` / `events` narrowing. */
function selectEvents(
  opts: VerifyPluginGuardsOptions,
): readonly DisasterEvent[] {
  if (opts.events) return opts.events;
  if (opts.categories) {
    const set = new Set(opts.categories);
    return DISASTER_CATALOG.filter((e) => set.has(e.category));
  }
  return DISASTER_CATALOG;
}

/** The distinct tools a battery names, for the matcher-reachability message. */
function toolsOf(events: readonly DisasterEvent[]): string[] {
  return [...new Set(events.map((e) => e.tool))];
}

/** One registration as the report names it. */
function sweptHook(reg: HookRegistration, index: number): SweptHook {
  return {
    event: reg.event,
    matcher: reg.matcher,
    condition: reg.condition,
    command: reg.command,
    index,
  };
}

/**
 * The event variables the sweep can answer from the event it is SYNTHESIZING,
 * keyed by the lowercased name a harness declares in `eventEnvVars`.
 *
 * 🔴 THE TABLE IS SHORT ON PURPOSE, and the short list is the whole policy: the
 * sweep sets a declared variable only when it KNOWS the value. Codex also
 * declares `session_id`, `turn_id`, `model` and `permission_mode`; the sweep
 * synthesizes none of those, and a hook may branch on `permission_mode`, so
 * inventing a value would not resolve the run — it would measure a program
 * configured by a number we made up. Those stay unset, the hook reads
 * `unresolved`, and its reason names them so a caller can supply the value they
 * actually mean via `env`.
 */
const DERIVABLE_EVENT_VARS: Readonly<
  Record<
    string,
    (f: { root: string; project: string; event: string }) => string
  >
> = {
  hook_event_name: (f) => f.event,
  // The directory the hook RUNS in, which is the project — not the plugin the
  // hooks were read from. They coincide for the ordinary "sweep this repo" call
  // and are different the moment an installed plugin is swept against a host
  // project, which is when getting it wrong would matter.
  cwd: (f) => f.project,
  plugin_root: (f) => f.root,
};

/**
 * The environment each hook is run with: the harness's plugin-root variable set
 * to the real root, plus every variable the ADAPTER declares that the sweep can
 * honestly derive, with the caller's `env` layered on top so they can override
 * any of it or add anything else.
 *
 * 🔴 WITHOUT THE PLUGIN-ROOT HALF, THE COMMONEST HOOK SHAPE IN THE WILD READS AS
 * `unresolved`. `loadPlugin` expands the BRACED token (`${PLUGIN_ROOT}`)
 * textually, but real hooks are shell and are written unbraced
 * (`node "$CLAUDE_PLUGIN_ROOT"/x.cjs` — the vendored oh-my-claudecode shape).
 * Setting the variable rather than doing a second string substitution covers
 * BOTH spellings with one mechanism, and it is what the harness itself does: the
 * shell in a real session resolves that name because the harness put it in the
 * environment. The NAME is derived from `layout.pluginRootToken`, never written
 * out, so this stays correct for a harness that spells its root differently.
 *
 * The DECLARED half is the same argument one layer up. `HookProtocol.eventEnvVars`
 * exists to say "a synthesized hook event carries these", and this function is
 * synthesizing one — so a Codex hook reading `$hook_event_name` or `$cwd` is an
 * ordinary hook, not an unresolvable one, and reading the declaration rather
 * than a literal keeps that true for the next adapter. Claude Code declares an
 * empty list, so nothing changes there.
 */
/** The variable name inside a `${NAME}` token, or null when it is not one. */
function tokenName(token: string): string | null {
  return /^\$\{(.+)\}$/.exec(token)?.[1] ?? null;
}

/**
 * The environment a swept hook is run with, and — separately — what the hook
 * will FIND set and what we can RESOLVE. Three fields because they answer three
 * different questions and conflating them is what produced two of these bugs.
 */
interface HookEnvironment {
  /** Handed to `runHook` as `env`. */
  readonly pass: Record<string, string>;
  /**
   * Names the hook will find set AT RUN TIME, under the execution mode actually
   * chosen. Not the same as `keys(pass)`, and not `process.env` either.
   */
  readonly names: ReadonlySet<string>;
  /**
   * The subset whose VALUE is known here, for resolving a path the command
   * names. A confined run sets `HOME`/`TMPDIR` to directories that do not exist
   * yet, so they are `names` without being `values` — present, not resolvable.
   */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Whether the run will be CONFINED — by ASKING the runner which route it will
 * take, not by restating the policy.
 *
 * 🔴 IT USED TO RESTATE IT, AND THE RESTATEMENT WAS A TERM SHORT. The copy read
 * `opts.sandbox ?? (opts.trusted === false ? "auto" : false)` and knew nothing
 * about `recordEgress`, which the runner has always confined for (it needs the
 * netns recorder). So a `recordEgress: true` sweep pre-flighted every relative
 * script against THIS process's cwd and every variable against `process.env`,
 * accepted both, and then handed the hook to a run that started in a fresh empty
 * directory with a cleared environment — where the interpreter cannot open its
 * script, exits 2, and is scored as a block. The same false 7/7 the pre-flight
 * exists to prevent, arriving through the option nobody had copied over.
 *
 * Under {@link routeScriptRun} there is no list here to fall behind: the next
 * option that selects confinement is added once, in the runner, and this reads
 * it. A refusal counts as confined, deliberately — the sweep describes the
 * environment a run WOULD have, and the environment it would have refused to run
 * unconfined in is the confined one.
 */
function willBeConfined(opts: VerifyPluginGuardsOptions): boolean {
  return (
    routeScriptRun(opts, {
      sandbox: sandboxAvailable(),
      egress: egressAvailable(sandboxAvailable()),
    }).kind !== "direct"
  );
}

/**
 * Where the run will resolve a relative path — and whether that is a directory
 * this process can look inside.
 *
 * 🔴 THE PRE-FLIGHT AND THE RUNNER MUST ANSWER THIS THE SAME WAY, and they did
 * not. `runScript` resolves a relative script against `opts.cwd` when there is
 * one; with none it defaults to THIS process's cwd on a direct run, but a
 * CONFINED run is chdir'd into a `work/` directory `sandboxedSpawn` has just
 * created and left empty. So `python3 .claude/hooks/guard.py` under
 * `trusted: false` passed a pre-flight against the repo, failed to open its
 * script inside the sandbox, and exited 2 — this harness's DENY code — which is
 * scored as a block. That is the same false 7/7 the file-existence check exists
 * to prevent, arriving through the fourth door: the check looked in the right
 * place for the wrong run.
 *
 * `fresh-empty` carries no path on purpose. The runner mints that directory when
 * it spawns, so there is no name to hand back here — and modelling it as a path
 * would invite a caller to test a file in it, which is the mistake itself.
 *
 * 🔴 AND THE UNCONFINED DEFAULT WAS THE CALLER'S CWD, WHICH IS NOT THE SUBJECT.
 * Sweeping a repo other than the one you are standing in resolved every relative
 * script against YOUR directory while telling the hook `CLAUDE_PROJECT_DIR` was
 * the swept root — two different trees, named by one run. `sh .claude/hooks/guard.sh`
 * was reported `unresolved` for a guard that is on disk exactly where the config
 * says, and — the worse half — if the caller happened to hold that same relative
 * path, the sweep ran and SCORED the caller's file under the swept repo's name.
 * The subject of the sweep is `dir`, so that is where its hooks run; an explicit
 * `cwd` still overrides, which is the installed-plugin case (hooks READ from the
 * plugin, RUN against a project elsewhere).
 */
type EffectiveCwd =
  | { readonly kind: "path"; readonly dir: string }
  | { readonly kind: "fresh-empty" };

/**
 * The directory the hook will run in — the ONE answer the pre-flight tests files
 * against and the runner is handed as `cwd`, so the two cannot disagree.
 *
 * @param root - the swept repository, already resolved.
 */
function effectiveCwd(
  opts: VerifyPluginGuardsOptions,
  root: string,
): EffectiveCwd {
  if (opts.cwd !== undefined) return { kind: "path", dir: resolve(opts.cwd) };
  return willBeConfined(opts)
    ? { kind: "fresh-empty" }
    : { kind: "path", dir: root };
}

/**
 * 🔴 WITHOUT THE PLUGIN-ROOT HALF, THE COMMONEST HOOK SHAPE IN THE WILD READS AS
 * `unresolved`. `loadPlugin` expands the BRACED token (`${PLUGIN_ROOT}`)
 * textually, but real hooks are shell and are written unbraced
 * (`node "$CLAUDE_PLUGIN_ROOT"/x.cjs` — the vendored oh-my-claudecode shape).
 * Setting the variable rather than doing a second string substitution covers
 * BOTH spellings with one mechanism, and it is what the harness itself does: the
 * shell in a real session resolves that name because the harness put it in the
 * environment. The NAMES are derived from `layout.pluginRootToken` and
 * `layout.projectRootTokens`, never written out, so this stays correct for a
 * harness that spells its roots differently.
 *
 * THE PROJECT-ROOT HALF IS THE SAME ARGUMENT AND WAS MISSING. `$CLAUDE_PROJECT_DIR`
 * is what an ordinary project hook reads — including this repository's own — and
 * the sweep is sweeping exactly that root, so calling it unresolvable made the
 * function useless on the commonest shape it will ever meet.
 *
 * 🔴 BUT THE PROJECT IS NOT THE PLUGIN, and binding both names to `root` was a
 * conflation that only hides while they coincide. Sweeping an INSTALLED plugin
 * (`dir` = `~/.claude/plugins/foo`, `cwd` = the host project) is a supported
 * call, and there the harness sets `$CLAUDE_PROJECT_DIR` to the project the hook
 * runs against, not to the plugin it came from. Pointing it at the plugin runs a
 * project hook against the wrong tree — or reports it unresolved for a file that
 * exists exactly where the harness would have looked. So the plugin-root token
 * stays bound to `root` and the project-root tokens follow the run's cwd; with
 * no `cwd` they are the same directory and nothing changes.
 *
 * The DECLARED-EVENT half is the argument one layer up. `HookProtocol.eventEnvVars`
 * exists to say "a synthesized hook event carries these", and this function is
 * synthesizing one, so a Codex hook reading `$hook_event_name` or `$cwd` is an
 * ordinary hook, not an unresolvable one. Claude Code declares an empty list, so
 * nothing changes there.
 *
 * 🔴 AND THE AVAILABILITY SET FOLLOWS THE EXECUTION MODE, which is the half that
 * cannot be derived before the mode is known. A confined run (`trusted: false`,
 * `sandbox: "auto"|"strict"`, or any `egress` allowlist) starts from
 * `--clearenv` and gets back only `HOME`, `TMPDIR`, `PATH` and the caller's
 * `env`. Checking availability against `process.env` therefore cleared every
 * ambient variable the hook will NOT find — so a foreign hook reading a CI or
 * custom variable was `measured` while running with it missing, which is the
 * same false score by a third door.
 */
function hookEnvironment(
  adapter: HarnessAdapter,
  root: string,
  project: string,
  event: string,
  opts: VerifyPluginGuardsOptions,
): HookEnvironment {
  const derived: Record<string, string> = {};
  const rootVar = tokenName(adapter.layout.pluginRootToken);
  if (rootVar !== null) derived[rootVar] = root;
  for (const token of adapter.layout.projectRootTokens ?? []) {
    const name = tokenName(token);
    if (name !== null) derived[name] = project;
  }
  for (const name of adapter.hookProtocol?.eventEnvVars ?? []) {
    const value = DERIVABLE_EVENT_VARS[name.toLowerCase()]?.({
      root,
      project,
      event,
    });
    if (value !== undefined) derived[name] = value;
  }
  const pass = { ...derived, ...opts.env };
  if (!willBeConfined(opts)) {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined) values[name] = value;
    return {
      pass,
      names: new Set([...Object.keys(process.env), ...Object.keys(pass)]),
      values: { ...values, ...pass },
    };
  }
  // Confined: exactly what `bwrapArgs` sets back after `--clearenv`, plus what
  // `setenvArgs` restores. HOME and TMPDIR are set to sandbox-internal temp
  // directories, so they are present without being resolvable HERE — a path
  // built from them is left alone rather than tested against the host's copy.
  return {
    pass,
    names: new Set(["HOME", "TMPDIR", "PATH", ...Object.keys(pass)]),
    values: { PATH: process.env["PATH"] ?? "", ...pass },
  };
}

/** Everything a per-hook sweep needs beyond the registration itself. */
interface SweepContext {
  readonly battery: readonly DisasterEvent[];
  readonly eventName: string;
  readonly opts: VerifyPluginGuardsOptions;
  readonly protocol: NonNullable<HarnessAdapter["hookProtocol"]>;
  /** What the run will pass, find set, and be able to resolve. */
  readonly env: HookEnvironment;
  /** Where a relative path in a hook command resolves — see {@link EffectiveCwd}. */
  readonly cwd: EffectiveCwd;
}

/**
 * Decide one hook, running the battery only when it could reach this hook at all.
 *
 * Settled in the order the harness itself settles them: the event, then the
 * matcher, then the command — three non-verdicts decided BEFORE anything is
 * spawned. The FOURTH, the condition, is the exception and cannot be otherwise:
 * the harness applies it per event inside the run, so it is read back off the
 * run's own verdict rather than re-decided here. See the check below `ran`.
 */
function sweepHook(
  reg: HookRegistration,
  index: number,
  ctx: SweepContext,
): SweptHookOutcome {
  const { battery, eventName, opts, protocol, env } = ctx;
  const hook = sweptHook(reg, index);

  if (reg.event !== eventName)
    return {
      status: "not-applicable",
      hook,
      reason: `registered on ${reg.event}; this battery is delivered as ${eventName}, so the hook is never asked about these calls`,
    };

  const style = ctx.protocol.matcherStyle;
  // 🔴 UNCOMPILABLE FIRST, AND IT IS NOT A NARROWER "misses". A matcher the
  // regex engine rejects is one the HARNESS cannot build either, so it spawns
  // the hook for nothing — running the battery anyway would hand an
  // unconditional-deny body a full score for a hook that never runs, which is
  // the false 7/7 this whole function exists to prevent, arriving through the
  // matcher instead of the condition.
  if (
    battery.some(
      (e) => hookMatcherReach(reg.matcher, e.tool, style) === "uncompilable",
    )
  )
    return {
      status: "not-applicable",
      hook,
      reason: `matcher \`${reg.matcher ?? ""}\` is not a valid regular expression — the harness cannot compile it either, so it never spawns this hook and there is nothing to measure (the \`hook-matcher\` rule reports the same matcher as invalid-regex)`,
    };

  const reachable = battery.filter(
    (e) => hookMatcherReach(reg.matcher, e.tool, style) === "selects",
  );
  if (reachable.length === 0)
    return {
      status: "not-applicable",
      hook,
      reason: `matcher \`${reg.matcher ?? ""}\` selects none of the tools this battery calls (${toolsOf(battery).join(", ")}) — the harness never spawns it here`,
    };

  // 🔴 BEFORE EITHER ANALYSIS, BECAUSE A REJECTED COMMAND DEFEATS BOTH. `sh`
  // exits 2 on a syntax error — this harness's DENY code — so a hook whose
  // command does not parse was run and scored as blocking, which is the same
  // false 7/7 the file check above prevents, reached without a missing file.
  // The file half went quiet rather than loud on it (`{ parsed: false,
  // refs: [] }` reads exactly like a clean command), and the variable half is
  // worse than quiet: its regex fallback still names `$FOO` in `echo "$FOO`, so
  // the sweep would have blamed an unset variable for a syntax error and told
  // the caller to pass `env`. Deciding this first makes both accurate.
  if (!commandFileRefs(reg.command).parsed)
    return {
      status: "unresolved",
      hook,
      reason: `the command is not valid shell — the parser rejects it, and so does \`sh\`, which exits 2 for a syntax error. That is this harness's DENY code, so running it anyway would report the syntax error as a block`,
    };

  const missingVars = unsetVariables(reg.command, env.names);
  if (missingVars.length > 0)
    return {
      status: "unresolved",
      hook,
      reason: `the command names ${missingVars.map((v) => `\`$${v}\``).join(", ")}, which nothing sets here — running it would measure a different program than the harness runs. Pass \`env\` to resolve it`,
    };

  // The file half of the same question, and it has to be asked BEFORE the run:
  // a missing script makes the interpreter exit 2, which is indistinguishable
  // from a deny once it has happened.
  const absent = missingFiles(reg.command, ctx.cwd, env.values);
  if (absent.length > 0) {
    const named = absent.map((f) => `\`${f}\``).join(", ");
    const relative = absent.some((f) => !isAbsolute(f));
    return {
      status: "unresolved",
      hook,
      reason:
        ctx.cwd.kind === "fresh-empty" && relative
          ? `the command runs ${named} by a RELATIVE path, and a confined run starts in a fresh empty directory — the script cannot be there, whatever is on disk here. Pass \`cwd\` (the project the hook runs against) so the path means something, or an absolute path (an interpreter that cannot open its script exits 2, which is this harness's DENY code, so running it anyway would report a perfect score for a guard that never ran)`
          : `the command runs ${named}, which ${absent.length === 1 ? "is" : "are"} not on disk here — the guard the config names does not exist, so there is nothing to measure (an interpreter that cannot open its script exits 2, which is this harness's DENY code, so running it anyway would report a perfect score for a guard that never ran)`,
    };
  }

  const ran = verifyGuardrail(reg.command, {
    ...opts,
    // 🔴 THE SAME ANSWER THE PRE-FLIGHT USED, not `opts.cwd` again. The checks
    // above tested this hook's files against {@link SweepContext.cwd}; handing
    // the runner a different directory would make every one of those checks a
    // statement about a tree the hook never ran in. `fresh-empty` passes nothing
    // through, because that directory is the runner's to mint.
    cwd: ctx.cwd.kind === "path" ? ctx.cwd.dir : undefined,
    env: env.pass,
    events: reachable,
    event: eventName,
    condition: reg.condition ?? undefined,
    protocol,
  });

  // 🔴 AND AFTER THE RUN, THE HALF THE PRE-FLIGHT CANNOT SEE. A missing
  // interpreter, a file without the execute bit, a bad shebang: the shell
  // answers 127/126 and the program never had an opinion. That is a property of
  // the COMMAND, not of one battery event — the same command runs for all of
  // them — so one such result disqualifies the hook rather than one row. Erring
  // toward refusal is deliberate: a hook that fails to launch on only some
  // inputs is still a hook whose score would be part fiction.
  const stillborn = ran.find(
    (r) => !r.ran && shellNeverLaunched(r.exitCode) && !r.blocked,
  );
  if (stillborn !== undefined)
    return {
      status: "unresolved",
      hook,
      reason: `${stillborn.reason}. Nothing here is the guard's verdict, so it is not scored`,
    };

  // 🔴 THE FOURTH NON-VERDICT, and it arrives through the one gate the other
  // three do not pass through. The event, the matcher and the command are all
  // settled before a spawn; the CONDITION is settled per event INSIDE the run,
  // by `decideHookCondition` — so a hook whose `if` rejects every event its
  // matcher selected (matcher `Bash`, `if: "Bash(terraform apply*)"`) reached
  // this line with a full `ran` list of `ran: false` and was returned as
  // `measured`. The renderer then printed `blocks 0/7` and `sweepNotes` saw a
  // measured hook and stayed silent — a guard the harness never spawned,
  // reported as a guard that blocks nothing. That is the same false verdict as
  // the other three, in the unsafe direction, so it gets the same shape: its own
  // `not-applicable` reason, no score.
  //
  // ASKED AFTER THE RUN, NOT BEFORE, and deliberately: `ran: false` here IS the
  // runner's own condition verdict, so this reads the decision the harness would
  // make rather than re-deciding it beside `decideHookCondition` — the second
  // copy is the one that drifts. It costs nothing, because a rejected condition
  // never spawns a process either. `ran` is non-empty (an empty `reachable`
  // already returned above) and a launch failure already returned as
  // `unresolved`, so every `ran: false` left here is a condition rejection.
  if (ran.every((r) => !r.ran))
    return {
      status: "not-applicable",
      hook,
      reason: `condition \`${reg.condition ?? ""}\` selects none of the ${plural(ran.length, "battery event")} its matcher reaches — the harness never spawns this hook for any of them, so there is nothing to measure`,
    };

  // The events the matcher excluded are folded back in as NOT-RUN entries, in
  // catalog order, so `results` always answers for the whole battery. Dropping
  // them would leave a hook reporting "1/1 blocked" for a battery of seven.
  const byId = new Map(ran.map((r) => [r.event.id, r]));
  const results = battery.map(
    (event) =>
      byId.get(event.id) ?? {
        event,
        blocked: false,
        exitCode: 0,
        ran: false,
        reason: `matcher \`${reg.matcher ?? ""}\` does not select ${event.tool} — the harness never spawns this hook for it`,
      },
  );

  const ids = (pick: (r: GuardrailResult) => boolean): string[] =>
    results.filter(pick).map((r) => r.event.id);
  return {
    status: "measured",
    hook,
    results,
    blocked: ids((r) => r.blocked),
    allowed: ids((r) => r.ran && !r.blocked),
    notRun: ids((r) => !r.ran),
  };
}

/** The `notes` a sweep owes its reader when it measured less than it looks like. */
function sweepNotes(
  dir: string,
  regs: readonly HookRegistration[],
  outcomes: readonly SweptHookOutcome[],
  unmeasurable: readonly NonCommandHookAction[],
  eventName: string,
): string[] {
  // Always said, measured or not: an action this tier cannot drive is a gap in
  // the COVERAGE, and a reader who sees six measured hooks has no way to know a
  // seventh guard went unexamined unless the sweep says so.
  const notDrivable =
    unmeasurable.length === 0
      ? []
      : [
          `${plural(unmeasurable.length, "declared hook action")} (${[...new Set(unmeasurable.map((a) => a.type))].sort().join(", ")}) ${unmeasurable.length === 1 ? "is not a shell process" : "are not shell processes"}, so this battery cannot drive ${unmeasurable.length === 1 ? "it" : "them"}. Declared and NOT measured — not absent.`,
        ];
  if (outcomes.some((o) => o.status === "measured")) return notDrivable;
  // 🔴 "NO COMMAND HOOKS", NOT "NO HOOKS". Saying the repository declares no
  // guards when it declares four `prompt` actions is a false accusation dressed
  // as the sentence that exists to prevent false comfort.
  if (regs.length === 0)
    return [
      unmeasurable.length === 0
        ? `No hooks are declared in ${dir}. Nothing was measured — this is not a clean bill of health, it is an absence of guards.`
        : `No COMMAND hooks are declared in ${dir}. Nothing was measured here — but hooks ARE declared, so this is not an absence of guards either.`,
      ...notDrivable,
    ];
  return [
    `${regs.length} hook(s) declared, none of them reachable by this battery on ${eventName}. Nothing was measured — read each hook's reason below rather than the (empty) score.`,
    ...notDrivable,
  ];
}

/**
 * Run the disaster battery against every hook a plugin or repo declares, using
 * each hook's OWN event, matcher and condition, and report per hook.
 *
 * ```ts
 * import { experimental_verifyPluginGuards } from "vigiles";
 *
 * const report = experimental_verifyPluginGuards(".");
 * for (const h of report.hooks) {
 *   if (h.status === "measured")
 *     console.log(`${h.blocked.length}/${h.results.length}  ${h.hook.command}`);
 *   else console.log(`⊘ ${h.status}  ${h.hook.command} — ${h.reason}`);
 * }
 * for (const note of report.notes) console.log(note);
 * ```
 *
 * Nothing here needs a model or a key. The hooks it finds are the ones the
 * harness would load, so a hook that is present on disk but not registered is
 * absent from the report by construction — which is the correct answer, and the
 * one you would not get by globbing `hooks/*.sh`.
 *
 * ⚠️ It RUNS each reachable hook. A hook is a program you did not necessarily
 * write, so point this at a repo whose hooks you are willing to execute, or pass
 * `trusted: false` / `sandbox: "auto"` (inherited from {@link RunHookOptions}) to
 * confine them. `verifyGuardrail` has always had the same property; sweeping a
 * whole plugin makes it worth saying out loud.
 *
 * @experimental Days old, with no consumer outside this repository. The REPORT
 * SHAPE is the part most likely to move — specifically whether `not-applicable`
 * stays one status or splits by cause, and whether the per-hook counts stay id
 * arrays. The prefix comes off when that shape survives sweeping several real
 * third-party repos unchanged; see docs/experimental.md.
 *
 * @param dir - the plugin or repo root to read hooks from.
 */
export function experimental_verifyPluginGuards(
  dir: string,
  opts: VerifyPluginGuardsOptions = {},
): PluginGuardReport {
  const adapter = opts.adapter ?? claudeCodeAdapter;
  const root = resolve(dir);
  const battery = selectEvents(opts);
  const eventName = opts.event ?? DEFAULT_EVENT;
  const base = {
    dir: root,
    harness: adapter.name,
    event: eventName,
    events: battery,
  };

  // A harness whose hooks are not shell processes has nothing this tier can
  // drive. Saying so is the `no-silent-skips` half — an empty `hooks` list with
  // no note is indistinguishable from "we looked and it was fine".
  if (!adapter.capabilities.shellHooks || !adapter.hookProtocol)
    return {
      ...base,
      hooks: [],
      // The note below already says nothing here is drivable, so enumerating
      // which actions were declared would add no fact a reader could act on.
      unmeasurable: [],
      notes: [
        `n/a — ${adapter.name} hooks are not shell processes, so the disaster battery cannot drive them. Nothing was measured.`,
      ],
    };

  const rawHooks = loadPlugin(root, adapter.layout).settings.hooks;
  const regs = normalizeHooks(rawHooks);
  // The actions `normalizeHooks` correctly drops, kept so the sweep can tell
  // "declared nothing" from "declared something I cannot run" — see
  // {@link PluginGuardReport.unmeasurable}.
  const unmeasurable = nonCommandHookActions(rawHooks);
  // The two roots the run distinguishes: hooks are READ from `root`, and they
  // RUN against the project — the same directory unless the caller sweeps an
  // installed plugin from somewhere else, which is exactly when conflating them
  // would answer for the wrong tree.
  // Decided by the runner's own policy rather than a second copy of it — see
  // {@link effectiveCwd}, and the confined-run case it exists for.
  const cwd = effectiveCwd(opts, root);
  // The project-root variables follow the RUN's directory, so the tree the hook
  // is told about is the tree it stands in. A confined run has no such path (the
  // runner mints the directory), and there the swept root is the honest answer:
  // it is what the caller pointed at.
  const project = cwd.kind === "path" ? cwd.dir : root;
  const ctx: SweepContext = {
    battery,
    eventName,
    opts,
    protocol: adapter.hookProtocol,
    env: hookEnvironment(adapter, root, project, eventName, opts),
    cwd,
  };
  const hooks = regs.map((reg, i) => sweepHook(reg, i, ctx));
  return {
    ...base,
    hooks,
    unmeasurable,
    notes: sweepNotes(root, regs, hooks, unmeasurable, eventName),
  };
}

// ---------------------------------------------------------------------------
// Rendering. The one motivating use case for the sweep is "point the battery at
// YOUR hooks", and a caller who has to fold a discriminated union by hand before
// he can see that is being handed the library's internals instead of its answer.
// ---------------------------------------------------------------------------

/** Longest a command may run in a header line before it is elided. */
const COMMAND_WIDTH = 68;

/**
 * Hooks named under one not-measured reason before the rest are counted instead.
 *
 * 🔴 THE ONLY LOSSY STEP IN THIS RENDERER, and it is confined to the half where
 * the payload is the REASON rather than the hook. A repo can register dozens of
 * hooks and most will be irrelevant to a Bash battery, so listing every one of
 * them is a wall the reader skips — and the two lines that mattered are skipped
 * with it. Nothing is silently dropped: the group's count is exact, and the tail
 * line says how many more share the reason.
 */
const HOOKS_PER_REASON = 3;

/** A command as one short line — hooks are shell, and may be long or multi-line. */
function oneLine(command: string, width = COMMAND_WIDTH): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** `n thing` / `n things`, so a count never sits as a bare number beside a noun. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** How the config selects this hook — the three facts the sweep read off it. */
function hookMeta(hook: SweptHook): string {
  const parts = [
    hook.event,
    hook.matcher === null
      ? "no matcher (every tool)"
      : `matcher \`${hook.matcher}\``,
  ];
  if (hook.condition !== null) parts.push(`if \`${hook.condition}\``);
  return parts.join(" · ");
}

type MeasuredOutcome = Extract<SweptHookOutcome, { status: "measured" }>;
type UnmeasuredOutcome = Exclude<SweptHookOutcome, MeasuredOutcome>;

/**
 * One measured hook: a headline carrying its count, the selection facts, then one
 * row per battery event in the SAME vocabulary `formatGuardrailReport` prints —
 * they share {@link guardrailRow}, so the two reports cannot drift into two
 * spellings of the same three outcomes.
 */
function measuredBlock(outcome: MeasuredOutcome): string[] {
  return [
    `  #${outcome.hook.index}  blocks ${outcome.blocked.length}/${outcome.results.length}  \`${oneLine(outcome.hook.command)}\``,
    `      ${hookMeta(outcome.hook)}`,
    ...outcome.results.map((r) => `      ${guardrailRow(r)}`),
  ];
}

/** The distinct reasons in a set of unmeasured hooks, each with the hooks it covers. */
function byReason(
  outcomes: readonly UnmeasuredOutcome[],
): { reason: string; hooks: SweptHook[] }[] {
  const groups = new Map<string, SweptHook[]>();
  for (const o of outcomes) {
    const hooks = groups.get(o.reason) ?? [];
    hooks.push(o.hook);
    groups.set(o.reason, hooks);
  }
  return [...groups].map(([reason, hooks]) => ({ reason, hooks }));
}

/**
 * One unmeasured status, grouped by reason.
 *
 * 🔴 NO COUNT APPEARS HERE, and that is this half's whole contract: a hook the
 * battery never reached has no score, so printing `0/7` beside it would
 * reproduce — in rendering, one layer above the type system — exactly the false
 * confidence the discriminated union was built to make unrepresentable. The
 * reason is the payload; the hooks are listed under it.
 */
function unmeasuredSection(
  label: string,
  outcomes: readonly UnmeasuredOutcome[],
): string[] {
  if (outcomes.length === 0) return [];
  const lines = [`  ⊘ ${label} — ${plural(outcomes.length, "hook")}`];
  for (const group of byReason(outcomes)) {
    lines.push(`     ${group.reason}`);
    for (const hook of group.hooks.slice(0, HOOKS_PER_REASON))
      lines.push(`       #${hook.index}  \`${oneLine(hook.command, 56)}\``);
    const rest = group.hooks.length - HOOKS_PER_REASON;
    if (rest > 0)
      lines.push(`       …and ${plural(rest, "more hook")} for this reason`);
  }
  return lines;
}

/**
 * The census — what was declared and what became of it. Never a score.
 *
 * Omitted entirely when nothing was declared, because a row of zeroes reads as a
 * scoreboard, and the `notes` directly below already say what happened in words.
 * `notes` is guaranteed non-empty in that case: it is empty ONLY when some hook
 * was measured.
 */
function censusLine(report: PluginGuardReport): string[] {
  if (report.hooks.length === 0) return [];
  const count = (status: SweptHookOutcome["status"]): number =>
    report.hooks.filter((h) => h.status === status).length;
  // The non-command actions are counted in the SAME sentence, because a census
  // that silently omits them is how "declared" came to mean "declared a command"
  // without any reader being told.
  const notDrivable =
    report.unmeasurable.length === 0
      ? ""
      : ` ${report.unmeasurable.length} further action(s) declared are not commands and cannot be driven here.`;
  return [
    `${plural(report.hooks.length, "hook")} declared: ${count("measured")} measured, ${count("unresolved")} unresolved, ${count("not-applicable")} not applicable.${notDrivable}`,
  ];
}

/**
 * The declared-but-undrivable actions, rendered like every other unmeasured
 * group: grouped by reason, named, and carrying no count.
 */
function unmeasurableSection(
  actions: readonly NonCommandHookAction[],
): string[] {
  if (actions.length === 0) return [];
  const lines = [
    `  ⊘ not a command — ${plural(actions.length, "declared action")}`,
    "     this tier spawns a shell, and these actions do not run one, so nothing here has been examined either way",
  ];
  const byType = new Map<string, NonCommandHookAction[]>();
  for (const a of actions) {
    const list = byType.get(a.type);
    if (list === undefined) byType.set(a.type, [a]);
    else list.push(a);
  }
  for (const [type, group] of [...byType].sort((a, b) =>
    a[0].localeCompare(b[0]),
  ))
    lines.push(
      `       ${type} — ${plural(group.length, "action")} on ${[...new Set(group.map((a) => a.event))].sort().join(", ")}`,
    );
  return lines;
}

/** The closing notes, printed once for the whole sweep rather than per hook. */
function footer(measured: readonly MeasuredOutcome[]): string[] {
  const lines: string[] = [];
  if (measured.some((m) => m.allowed.length > 0))
    lines.push(
      "",
      "Allows ≠ a bug unless a guard is MEANT to block them — gate intent with",
      "assertBlocksDisasters(cmd, { categories: [...] }).",
    );
  if (measured.some((m) => m.notRun.length > 0))
    lines.push(
      "",
      "⊘ Some events never reached a hook: its condition does not match them, so it",
      "cannot protect you there however its body is written.",
    );
  return lines;
}

/**
 * Render a {@link PluginGuardReport} as terminal text.
 *
 * ```ts
 * import {
 *   experimental_verifyPluginGuards,
 *   experimental_formatPluginGuardReport,
 * } from "vigiles";
 *
 * console.log(
 *   experimental_formatPluginGuardReport(experimental_verifyPluginGuards(".")),
 * );
 * ```
 *
 * NEUTRAL, the same way {@link formatGuardrailReport} is: it reports what each
 * hook blocks without deciding whether that was the hook's job. A repo's config
 * never says which of its hooks is meant to be a bash-safety guard, so a verdict
 * here would be invented rather than read.
 *
 * 🔴 A HOOK THE BATTERY NEVER REACHED IS NEVER GIVEN A NUMBER. A `measured` hook
 * prints `blocks n/7`; a `not-applicable` or `unresolved` one prints its REASON
 * under a `⊘` heading and no count at all, because a rendered `0/7` is the same
 * false confidence the discriminated union exists to prevent, reintroduced one
 * layer up where the type system can no longer see it. For the same reason the
 * report's `notes` are printed FIRST and in full: a sweep that measured nothing
 * has to say so in words, since an output with no rows reads as a clean bill of
 * health.
 *
 * MANY HOOKS STAY READABLE by grouping the unmeasured half BY REASON — a repo
 * with thirty hooks usually has two or three distinct reasons — and naming at
 * most {@link HOOKS_PER_REASON} hooks per reason before counting the rest. The
 * measured half is never collapsed: those are the hooks you came for.
 *
 * @experimental It renders {@link PluginGuardReport}, whose SHAPE is the part
 * most likely to move (see {@link experimental_verifyPluginGuards}), so a stable
 * name here would promise a stability its only input does not have. The prefix
 * comes off with the same change that takes it off the report.
 *
 * @param report - a sweep from {@link experimental_verifyPluginGuards}.
 */
export function experimental_formatPluginGuardReport(
  report: PluginGuardReport,
): string {
  const measured = report.hooks.filter(
    (h): h is MeasuredOutcome => h.status === "measured",
  );
  const unmeasured = (status: UnmeasuredOutcome["status"]) =>
    report.hooks.filter((h): h is UnmeasuredOutcome => h.status === status);

  const lines = [
    `Guard sweep of ${report.dir} — ${report.harness} · ${plural(report.events.length, "dangerous action")} delivered as ${report.event}`,
    ...censusLine(report),
    // The empty case's voice, verbatim and above everything else: `hooks: []`
    // renders as an absence of rows, which is indistinguishable from "we looked
    // and it was fine" unless the words are there to say otherwise.
    ...report.notes.flatMap((note) => ["", `⚠ ${note}`]),
  ];

  if (measured.length > 0)
    lines.push("", "MEASURED", ...measured.flatMap(measuredBlock));

  const notMeasured = [
    ...unmeasuredSection("unresolved", unmeasured("unresolved")),
    ...unmeasuredSection("not applicable", unmeasured("not-applicable")),
    ...unmeasurableSection(report.unmeasurable),
  ];
  if (notMeasured.length > 0)
    lines.push(
      "",
      "NOT MEASURED — nothing below has a score; each group says why",
      ...notMeasured,
    );

  return [...lines, ...footer(measured)].join("\n");
}
