/**
 * The compiled-hook RUNTIME — `vigiles hook-runtime run-program <file>`, the
 * process the harness spawns on every matching tool call.
 *
 * WHY IT IS ITS OWN MODULE, and why that is the whole point (#216): this code
 * used to live in `src/cli.ts` beside `compile` / `lint` / `audit` / `eval`, and
 * CommonJS resolves a module's top-level imports before a single argument is
 * parsed — so deciding `allow` on `ls -la` loaded the report template loader, the
 * linter catalogs, the adapter registry and ~30 more barrels. MEASURED
 * 2026-09-08 (Node 22.22.2, `tools/measure-hook-startup.mjs`, median of 20
 * spawns): `require("dist/cli.js")` cost 623 ms against a 42 ms bare Node start,
 * and a real `run-program` spawn cost 610-661 ms. A shell hook doing the same job
 * costs ~12 ms.
 *
 * So `src/cli.ts` is now a dispatcher shim that `require`s THIS file for
 * `hook-runtime run-program` and the verb barrel for everything else. The
 * emitted command is unchanged and MUST stay unchanged — it is baked into every
 * already-emitted settings block and into the SHA stamp beside each hook.
 *
 * KEEP THIS MODULE'S TOP-LEVEL IMPORTS MINIMAL. Everything imported here is paid
 * on every gated tool call. Two deliberately-lazy edges, each with the measurement
 * at its call site: `@iarna/toml` (compile-time only, in `core/hook-program.ts`
 * and `hook-install.ts`) and `mvdan-sh` (bash predicates only, in
 * `core/bash-effects.ts`). `src/hook-runtime-graph.test.ts` asserts the graph
 * deterministically, because a timing threshold on a shared CI runner would be
 * flaky and would be the first thing quarantined.
 *
 * Harness-neutral: the gate protocol (deny → exit 2) is byte-identical on Claude
 * Code and Codex, and the ONE harness-specific fact the runtime needs — which
 * events accept injected context — is read from the resolved adapter's
 * `HookProtocol.injectableEvents`, never a literal. That resolution is itself a
 * lazy `require` because only the react role needs it (the adapter registry
 * measured 279 ms on its own).
 *
 * This is COMPOSITION-ROOT code (`src/` root), not `src/core/`: it does real I/O
 * (stdin, the stamp sidecar, state writes, `spawnSync`) and reaches the adapter
 * registry, so `core ⊄ adapter` keeps it out of the domain layer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import {
  stampHook,
  HookCompileError,
  decideProgram,
  decideFileGate,
  decidePromptGate,
  decideStopGate,
  injectionOf,
  outcomeWrites,
  runReact,
  dispatchKind,
  hookMode,
  hookNeeds,
  gateAction,
  noticeDelivery,
  isStampRepairEvent,
  isLoadPathRepairEvent,
  resolveHookEvent,
  undecidablePathWarning,
  type HookProgramOutcome,
  type HookMode,
  type AnyHook,
  type FileGateHook,
  type PromptGateHook,
  type StopGateHook,
  type InjectHook,
  type ReactHook,
  type HookProgram,
  type Decision,
  type RawHookEvent,
  type HookEvent,
} from "./core/hook-program.js";
import { hookStampRef } from "./core/hook-paths.js";
import {
  hasMergeConflictMarkers,
  HARNESS_CONFIG_FILES,
} from "./core/merge-conflict.js";
import { discoverProviderFiles } from "./hook-install.js";
import {
  lazyContext,
  type ProviderRegistry,
  type RegisteredProvider,
} from "./core/hook-providers.js";
import type { StateFact } from "./core/hook-state.js";
import { readHookState, writeHookState } from "./hook-state-store.js";
import { appendObservation } from "./observe.js";
import {
  HOOK_OBSERVATIONS_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "./local-files.js";
import { loadHook } from "./load-hook.js";
import { injectableEventsOf } from "./core/event-capability.js";
import { checkHookStamp, stampFixCommand } from "./core/hook-stamp.js";
import {
  PASSED,
  decidedBlock,
  failed,
  failureLine,
  hookExitCode,
  type HookExitCode,
  type HookRunOutcome,
} from "./core/hook-exit.js";

/**
 * Which events accept injected context, from the ACTIVE adapter — the one
 * harness-specific fact a react needs, read through the `HookProtocol` port so
 * this stays harness-neutral (never a Claude Code literal).
 *
 * LAZY on purpose: `./adapter-registry.js` pulls every registered adapter and
 * its ports, and measured 279 ms to require on its own (2026-09-08, Node
 * 22.22.2) — more than the whole rest of this module's graph. Only the REACT
 * role needs it; a gate or an inject must not pay for it.
 */
function injectableEventsFor(root: string): readonly string[] {
  const { resolveAdapter } =
    require("./adapter-registry.js") as typeof import("./adapter-registry.js");
  const adapter = resolveAdapter(root);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy list is the FALLBACK an adapter without a capability table still relies on; reading it here is the point
  return injectableEventsOf(adapter.dialect, adapter.hookProtocol?.injectableEvents); // prettier-ignore
}

/**
 * Load a compiled-hook program's default export — the SHARED loader, also the
 * public `vigiles` `loadHook` a `.harness.mjs` test uses, so a hook that
 * loads in a test loads identically here (one loader, no drift).
 */
export const loadHookProgram = loadHook;

/** Load a registered provider (`.vigiles/providers/<name>.provider.<ext>`) → its definition. */
export async function loadProvider(
  file: string,
  root: string = process.cwd(),
): Promise<RegisteredProvider> {
  const abs = resolve(root, file);
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  } catch (e) {
    throw new HookCompileError(
      `Cannot load provider "${file}": ${(e as Error).message}`,
    );
  }
  const def =
    (mod.default as { default?: unknown } | undefined)?.default ?? mod.default;
  if (
    !def ||
    typeof def !== "object" ||
    (def as { kind?: unknown }).kind !== "provider-def"
  ) {
    throw new HookCompileError(
      `${file} has no default-exported provider ` +
        `(use \`export default defineProvider({…})\`).`,
    );
  }
  return def as RegisteredProvider;
}
/** Path of the tamper-evident stamp sidecar for a hook file. */
export function hookStampPath(
  file: string,
  root: string = process.cwd(),
): string {
  return resolve(root, hookStampRef(file));
}

/**
 * Perform the state writes a hook declared, after its output has been emitted.
 * A refused write (a hand-built record object with a key `record()` would have
 * thrown on) is announced — silence here would be a hook that believes it
 * remembered something.
 */
function applyHookWrites(
  file: string,
  outcome: HookProgramOutcome,
  root: string,
): void {
  const { ok, refused } = outcomeWrites(outcome);
  for (const name of refused) {
    console.error(
      `vigiles: refused to record ${name} from ${file} — not a valid state key.`,
    );
  }
  for (const w of ok) {
    try {
      writeHookState(file, w, { cwd: root });
    } catch (e) {
      console.error(
        `vigiles: could not record ${w.name} from ${file}: ${String(e)}`,
      );
    }
  }
}
/**
 * Longest a single provider command may run before it is killed and yields the
 * same default as a failed one. 10 s: the repo's own precedent for a one-shot
 * probe subprocess is 10_000 ms (`src/cli-main.ts`, the `--version` check), the
 * slowest legitimate provider is a `git status` on a large tree (a second or
 * two), and it must stay well under the harness's own hook timeout so a hung
 * provider is reported as a default rather than as a dead hook. Not
 * configurable by design (no new key); a provider needing more is not a fact.
 */
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Build a gate's DECLARED context (`e.ctx`) — LAZILY. Each declared read-only
 * command runs via execSync in the hook's cwd only when the hook READS its key,
 * at most once per call, bounded by {@link PROVIDER_TIMEOUT_MS}; a provider that
 * can't resolve or times out yields its default (never throws). The pure
 * registry + resolver live in core/hook-providers.ts — this only injects the
 * real IO. Loading `.vigiles/providers/` files stays eager (async import), but
 * only when a `provider()` ref is declared.
 */
async function gatherHookContext(
  program: AnyHook,
  file: string,
  root: string,
): Promise<Record<string, string | boolean | StateFact>> {
  const needs = hookNeeds(program);
  if (needs.length === 0) return {};
  // Only load the registered-provider registry if a provider() ref is declared.
  const hasRef = needs.some(
    (n) => typeof n !== "string" && n.kind === "provider-ref",
  );
  const registry = hasRef ? await loadProviderRegistry(root) : {};
  const { execSync } =
    require("node:child_process") as typeof import("node:child_process");
  const { isCI } = require("ci-info") as { isCI: boolean };
  return lazyContext(
    needs,
    {
      exec: (command) =>
        execSync(command, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: PROVIDER_TIMEOUT_MS,
        }),
      cwd: root,
      platform: process.platform,
      isCI,
      // The namespace is bound HERE, from the hook's own path — core never sees
      // it, so no key a hook can spell reaches another owner's store.
      readState: (key) => readHookState(file, key, root),
      now: Date.now(),
    },
    registry,
  );
}

/**
 * Load the registered providers (`.vigiles/providers/`) into a name→def registry
 * for `provider()` ref resolution. A bad/unloadable provider file is skipped (the
 * ref then yields its default ""), never crashes a live session.
 */
async function loadProviderRegistry(root: string): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = {};
  // Tolerant on purpose, unlike `compile`: a provider file written before the
  // `.provider.` marker existed is `unclaimed`, and a hook compiled yesterday
  // still resolves `provider("x")` against it today. `compile` refuses such a
  // file out loud; the runtime must not turn that into a silently empty value
  // for a hook already wired. Tests and declarations are never loaded.
  const { claimed, unclaimed } = discoverProviderFiles(root);
  for (const file of [...claimed, ...unclaimed]) {
    try {
      const def = await loadProvider(file, root);
      registry[def.name] = def;
    } catch {
      /* skip an unloadable provider file */
    }
  }
  return registry;
}

/** Append an observe-mode record to `.vigiles/hook-observations.jsonl` (best-effort). */
function recordObservation(
  file: string,
  on: string,
  would: "deny" | "ask",
  reason: string,
  root: string,
): void {
  try {
    const dir = resolve(root, VIGILES_DIR);
    mkdirSync(dir, { recursive: true });
    ensureLocalFilesIgnored(dir);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: file,
        event: on,
        would,
        reason,
      }) + "\n";
    appendFileSync(resolve(dir, HOOK_OBSERVATIONS_FILE), line);
  } catch {
    /* recording is best-effort — never let it break a live session */
  }
}

/**
 * Emit a gate Decision in the harness protocol — the author never writes it —
 * and return what the run came to. `observe` mode turns a would-be block/ask
 * into a recorded no-op: the shadow/rollout path. Harness-neutral — exit 2 /
 * exit 0 are identical on Claude Code and Codex; the record is vigiles-local.
 *
 * The `block` case is the ONLY caller of {@link decidedBlock} in the runtime:
 * a hook's own `deny` is the one thing that may exit 2.
 */
function emitGate(
  decision: Decision,
  on: string,
  mode: HookMode,
  file: string,
  root: string,
): HookRunOutcome {
  const action = gateAction(decision, mode);
  switch (action.kind) {
    case "block":
      appendObservation(
        {
          kind: "hook",
          event: on,
          decision: "deny",
          mode: "enforce",
          rule: file,
          reason: action.reason,
        },
        root,
      );
      console.error(action.reason);
      return decidedBlock();
    case "ask":
      appendObservation(
        {
          kind: "hook",
          event: on,
          decision: "ask",
          mode: "enforce",
          rule: file,
          reason: action.reason,
        },
        root,
      );
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: on,
            permissionDecision: "ask",
            permissionDecisionReason: action.reason,
          },
        }) + "\n",
      );
      return PASSED;
    case "observe":
      appendObservation(
        {
          kind: "hook",
          event: on,
          decision: action.would,
          mode: "observe",
          rule: file,
          reason: action.reason,
        },
        root,
      );
      recordObservation(file, on, action.would, action.reason, root);
      console.error(
        `⚠ [vigiles observe] ${on}: would ${action.would} — ${action.reason}`,
      );
      return PASSED; // observe never blocks
    case "allow":
      return PASSED; // emit nothing
  }
}

/**
 * Every `package.json` between the hook file and the filesystem root, plus the
 * project's `.vigilesrc.json` — the files Node and the runtime must PARSE for a
 * compiled hook to load at all. Repo-relative-ish paths, for a message.
 *
 * Walking UP is not decoration: `vigiles/hook` is a bare specifier, so Node reads
 * the nearest `package.json` (and every one above it) while resolving it. The
 * observed wedge came from a `package.json` the author was not thinking about at
 * the time — it had merge-conflict markers in it, nothing to do with hooks.
 */
function hookLoadPathFiles(hookFile: string, root: string): readonly string[] {
  const files: string[] = [];
  let dir = dirname(resolve(root, hookFile));
  for (;;) {
    const pkg = resolve(dir, "package.json");
    files.push(pkg);
    // 🔴 THE WALK STOPS AT THE FIRST ONE THAT EXISTS, and this list is now also
    // the set of writes the repair door accepts, so its length is a blast
    // radius. Unbounded, it reached `/home/package.json` and `/package.json` —
    // files Node never opens once a nearer one is found. MEASURED against this
    // runtime, hook at `gp/p/repo/.claude/hooks/`, conflict markers planted at
    // one ancestor:
    //
    //   repo pkg PRESENT , parent conflicted        → loads fine
    //   repo pkg absent  , parent conflicted        → WEDGES (cause: ../package.json)
    //   repo pkg absent  , parent absent, gp broken → WEDGES (cause: ../../package.json)
    //   repo pkg PRESENT , parent absent, gp broken → loads fine
    //   repo pkg absent  , parent HEALTHY, gp broken→ loads fine
    //
    // A missing one is still pushed before the check: `package.json` may be the
    // file the author has to CREATE, and it is the commonest repair of all.
    if (existsSync(pkg)) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  files.push(resolve(root, ".vigilesrc.json"));
  return files;
}

/**
 * The conflicted files on this hook's load path, if any — the difference between
 * "your hook is broken" and "your repo is mid-merge and the hook is collateral".
 */
function conflictedLoadPathFiles(
  hookFile: string,
  root: string,
): readonly string[] {
  return hookLoadPathFiles(hookFile, root)
    .filter((p) => {
      try {
        return (
          existsSync(p) && hasMergeConflictMarkers(readFileSync(p, "utf-8"))
        );
      } catch {
        return false; // unreadable is a different problem; don't guess about it
      }
    })
    .map((p) => relative(root, p) || p);
}

/**
 * Print the loud stderr banner that accompanies a REPAIR-only pass-through on a
 * hook that cannot load or whose stamp is stale. The caller then passes exactly
 * this one tool call.
 */
function announceRepairEscape(file: string, why: string): void {
  console.error(
    `vigiles: hook ${file} ${why}.\n` +
      `vigiles: PASSING this one call because it is a repair or recovery action ` +
      `(a write to ${file}, to ${hookStampPath(file)}, or to one of ` +
      `${HARNESS_CONFIG_FILES.join(", ")}) ` +
      `— a gate's wiring refuses a failed hook's call, and without this it would ` +
      `refuse the only actions that can fix it.\n` +
      `vigiles: every OTHER call to this hook fails until it is repaired.`,
  );
}

/**
 * Check the hook against its stamp sidecar. No sidecar, or a cleared one
 * (`{}`) → run uncompiled (a test fixture, a not-yet-compiled hook, the
 * documented manual clear). An unreadable sidecar or source runs too: a source
 * that cannot be read already failed to load.
 *
 * A STALE stamp is a FAILURE, for every role and on every event: the unverified
 * body does not run, and the runtime exits 1 with one line naming the fix. What
 * the failure does to the action is the wiring's `onFailure`, which `compile`
 * writes from the role — `block` for a tool gate, `continue` for everything
 * else. Observed 2026-11: an `inject` hook on `UserPromptSubmit`, edited and not
 * recompiled, exited 2 on every prompt — the human could not type their way out.
 *
 * ONE escape, the same one a load failure has: the author's own REPAIR write
 * ({@link isStampRepairEvent} — a write to the hook or its sidecar) passes,
 * loudly. Without it a stale Bash gate AND a stale file gate together refuse
 * both ways out — the recompile in Bash and the write that clears the stamp —
 * and the session is wedged.
 */
function verifyStamp(file: string, event: HookEvent): HookRunOutcome | "run" {
  const { root } = event;
  const stampPath = hookStampPath(file, root);
  const check = checkHookStamp(
    readIfPresent(stampPath),
    readIfPresent(resolve(root, file)),
    stampHook,
  );
  if (check.kind !== "stale") return "run";
  if (isStampRepairEvent(event, file, root)) {
    announceRepairEscape(file, "does not match its compiled stamp");
    return PASSED;
  }
  return failed(
    `it does not match its compiled stamp (edited after \`vigiles compile\`), ` +
      `so its body did not run`,
    `run \`${stampFixCommand(file)}\`, or edit ${file} back to what was ` +
      `compiled; if a gate refuses the command, write \`{}\` into ${stampPath} ` +
      `and the hook runs unstamped, still enforcing`,
  );
}

/** A file's text, or `undefined` when it cannot be read. */
function readIfPresent(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Say so, ON STDERR, when this event's path cannot be matched against a
 * repo-relative prefix — an absolute `file_path` and no project root anywhere.
 * The failure it announces is otherwise invisible: the hook runs, exits 0, and
 * decides on nothing. Deliberately silent for a relative `file_path` (decidable
 * without a root) so it cannot be mistaken for a react hook's `notice`.
 */
function warnIfPathUndecidable(
  event: { tool_input?: Record<string, unknown> },
  root: string | undefined,
): void {
  const warning = undecidablePathWarning(event.tool_input?.file_path, root);
  if (warning !== undefined) console.error(warning);
}

/**
 * `vigiles hook-runtime run-program <file>` — the runtime the compiled hooks block
 * points at. Runs the hook ({@link runHookProgram}) and exits with
 * {@link hookExitCode} of what it came to — the ONE place the exit code is set:
 * 2 only when the hook's own `decide` denied, 1 for any failure (printed as one
 * stderr line naming the cause and the fix), 0 for everything else. A throw
 * anywhere below is a failure too, never a block.
 */
export async function runHookProgramCommand(
  file: string | undefined,
): Promise<void> {
  const outcome = await runHookProgram(file).catch(crashed);
  if (outcome.kind === "failed") console.error(failureLine(file, outcome));
  exitAfterFlush(hookExitCode(outcome));
}

/** A throw anywhere in the run: a failure, never a block. */
function crashed(err: unknown): HookRunOutcome {
  if (process.env.VIGILES_DEBUG && err instanceof Error && err.stack)
    console.error(err.stack);
  return failed(
    `the runtime threw: ${err instanceof Error ? err.message : String(err)}`,
    `if the hook's own code throws, fix it; otherwise rerun with ` +
      `VIGILES_DEBUG=1 for the stack and report it as a vigiles defect`,
  );
}

/**
 * Exit with `code` once stdout and stderr have flushed — a pipe write is async
 * on macOS, and an inject's `additionalContext` must not be cut off by the
 * exit that follows it.
 */
function exitAfterFlush(code: HookExitCode): void {
  process.stdout.write("", () =>
    process.stderr.write("", () => process.exit(code)),
  );
}

/** The live event off stdin: a JSON object, or the failure that it is not. */
function readEvent(): RawHookEvent | HookRunOutcome {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin: reported below as not JSON */
  }
  const notJson = failed(
    "the event on stdin is not a JSON object",
    "this command is run by the harness, which sends the event on stdin; " +
      "to try a hook by hand, use `runHook` (`vigiles test`), which sends one",
  );
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as RawHookEvent)
      : notJson;
  } catch {
    return notJson;
  }
}

/** Is this a run's outcome rather than the value the step produces? */
function isOutcome(v: unknown): v is HookRunOutcome {
  return (
    v !== null &&
    typeof v === "object" &&
    "kind" in v &&
    (v.kind === "blocked" || v.kind === "passed" || v.kind === "failed")
  );
}

/**
 * Read the event, load the program, verify its stamp, and dispatch by role. A
 * gate's `deny` is the only path to {@link decidedBlock}; every way this can go
 * wrong before the hook answers is a {@link failed} outcome.
 *
 * One loudly-announced exception to a load failure: the load-path repair WRITE
 * ({@link isLoadPathRepairEvent}) passes, or a gate wired `onFailure: block`
 * would refuse the only write that fixes whatever broke the load path.
 */
async function runHookProgram(
  file: string | undefined,
): Promise<HookRunOutcome> {
  if (!file) {
    return failed(
      "no hook file was given",
      "wire it as `vigiles hook-runtime run-program <hook-file>` " +
        "(the line `vigiles compile` writes)",
    );
  }
  const payload = readEvent();
  if (isOutcome(payload)) return payload;
  // 🔴 THE ROOT IS RESOLVED ONCE, HERE, AND RIDES ON THE EVENT. Everything below
  // reads `event.root`; nothing recomputes it and nothing is handed a root
  // beside an event it might disagree with. That disagreement is the defect
  // this shape exists to prevent — the stamp sidecar, the hook's own source,
  // the state store, the ledger and the provider registry each used to resolve
  // against `process.cwd()` while the decision layer resolved against the
  // payload, so under a worktree the tamper check did not misfire, it did not
  // run at all.
  //
  // This is the only `process.cwd()` on the runtime's own execution path, and
  // it is the documented last resort for a payload that declares no root. The
  // two others in this file are back-compat defaults on exported helpers
  // (`loadProvider`, `hookStampPath`) for callers outside the runtime; the
  // runtime itself always passes a root and never takes them.
  const event = resolveHookEvent(payload, process.env, process.cwd());
  const root = event.root;
  // ⚠️ THE DECISION LAYER MUST NOT SEE THE FALLBACK, and this is not a detail.
  // `parseFilePath` treats an undefined root as "I cannot place this path" and errs
  // toward SILENCE. Handing it `process.cwd()` instead would turn that silence
  // into confident decisions measured against a directory nobody declared —
  // quietly widening what gates fire on. IO paths need a usable root; verdicts
  // need an honest one, and they are not the same question.
  const declaredRoot = event.rootDeclared ? event.root : undefined;

  let program: AnyHook;
  try {
    program = await loadHookProgram(file, root);
  } catch (err) {
    // A LOAD failure is a fact about the harness, not a verdict about the
    // command that happened to arrive, so it is a FAILURE (exit 1), whatever
    // kind of hook it is — the hook did not load, so there is nothing to ask
    // whether it is a gate or a nudge. The wiring's `onFailure` (written by
    // `compile` from the role) decides what that does to the action: a tool
    // gate's refuses it, a nudge's lets it through.
    //
    // The RECOVERY escape stays, for the case where the hook is fine and
    // something else on its load path is not (observed 2026-08-10:
    // `package.json` left holding merge-conflict markers → Node can't resolve
    // `vigiles/hook` → no compiled hook loads → a refusing gate blocks the
    // repair). It passes only WRITES — see `isLoadPathRepairEvent` for why no
    // command is one.
    const conflicted = conflictedLoadPathFiles(file, root);
    // 🔴 THE THROWN MESSAGE IS THE ONLY THING THAT NAMES THE REAL CAUSE when the
    // merge-conflict heuristic above does not fire. Without it this said just
    // "cannot be loaded" — a diagnosis that sends the reader looking in the wrong
    // place, which is the defect this runtime has already shipped twice (the
    // loader that advised `npm run build` when the answer was `npm install`).
    const thrown = err instanceof Error ? err.message : String(err);
    const cause =
      conflicted.length > 0
        ? `${conflicted.join(", ")} contains merge-conflict markers, so Node ` +
          `cannot resolve \`vigiles/hook\` from it (the hook itself may be fine)`
        : thrown;
    if (
      isLoadPathRepairEvent(event, file, {
        // The root the REST of this runtime already uses — now the PROJECT's,
        // not the process's. A repair accepted against any other root would name
        // a file the runtime never reads.
        root,
        loadPathFiles: hookLoadPathFiles(file, root),
      })
    ) {
      announceRepairEscape(file, `cannot be loaded — ${cause}`);
      return PASSED;
    }
    return failed(
      `it cannot be loaded: ${cause}`,
      `repair whichever of ${file}, ${HARNESS_CONFIG_FILES.join(", ")} (or an ` +
        `ancestor package.json Node reads, under ${root}) is broken with a FILE ` +
        `WRITE (Write/Edit/MultiEdit; a Read repairs nothing), which passes even ` +
        `while this fails; no command does, ` +
        `because \`git merge --abort\` and installs run code and \`vigiles ` +
        `compile\` loads the hook through the resolver that just failed`,
    );
  }
  const verified = verifyStamp(file, event);
  if (verified !== "run") return verified;
  return dispatchVerified(program, file, event, declaredRoot);
}

/**
 * Run a loaded, stamp-checked hook by its role — the half of the runtime that
 * executes the author's code, reached only once {@link verifyStamp} says `run`.
 */
async function dispatchVerified(
  program: AnyHook,
  file: string,
  event: HookEvent,
  declaredRoot: string | undefined,
): Promise<HookRunOutcome> {
  const { root } = event;
  switch (dispatchKind(program)) {
    case "inject": {
      const ctx = await gatherHookContext(program, file, root);
      const injection = injectionOf(program as InjectHook, event, ctx);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: program.on,
            additionalContext: injection.context,
          },
        }) + "\n",
      );
      // Writes land AFTER the output is emitted: a hook that recorded "I spoke"
      // must not have recorded it if emitting threw.
      applyHookWrites(
        file,
        {
          kind: "injection",
          context: injection.context,
          records: injection.records,
        },
        root,
      );
      return PASSED;
    }
    case "react":
      return dispatchReact(program as ReactHook, file, event, declaredRoot);
    case "file-gate": {
      const ctx = await gatherHookContext(program, file, root);
      warnIfPathUndecidable(event, declaredRoot);
      return emitGate(
        decideFileGate(program as FileGateHook, event, ctx, declaredRoot),
        program.on,
        hookMode(program),
        file,
        root,
      );
    }
    case "bash-gate": {
      const ctx = await gatherHookContext(program, file, root);
      // The same `declaredRoot` the file gates get: without it every
      // repo-relative prefix in a DENYLIST matcher (`touches`/`writesTo`) is
      // matched by over-blocking alone, and with it an absolute token is placed
      // exactly. Measured bypass this closes: `sed -i s/a/b/ <abs>/paper.tex`
      // exited 0 against a guard that blocked the relative spelling.
      return emitGate(
        decideProgram(program as HookProgram, event, ctx, declaredRoot),
        program.on,
        hookMode(program),
        file,
        root,
      );
    }
    case "prompt-gate": {
      const ctx = await gatherHookContext(program, file, root);
      return emitGate(
        decidePromptGate(program as PromptGateHook, event, ctx),
        program.on,
        hookMode(program),
        file,
        root,
      );
    }
    case "stop-gate": {
      const ctx = await gatherHookContext(program, file, root);
      return emitGate(
        decideStopGate(program as StopGateHook, event, ctx),
        program.on,
        hookMode(program),
        file,
        root,
      );
    }
  }
}

/** A react hook: deliver its notice, record its writes, run its classified command. */
async function dispatchReact(
  program: ReactHook,
  file: string,
  event: HookEvent,
  declaredRoot: string | undefined,
): Promise<HookRunOutcome> {
  const { root } = event;
  const ctx = await gatherHookContext(program, file, root);
  warnIfPathUndecidable(event, declaredRoot);
  const reaction = runReact(program, event, ctx, declaredRoot);
  // A notice has to REACH someone. stderr at exit 0 goes to the debug log
  // and nothing else (the host's docs are explicit: "Claude never sees it"),
  // and a react always exits 0 because its type has no `deny` — so stderr
  // alone delivered nowhere. Emit the same `additionalContext` shape the
  // shipped refs/eval-lock nudges use, gated on the ACTIVE adapter's
  // `injectableEvents` so this is per-harness fact, not a CC literal.
  const injectable = injectableEventsFor(root);
  const delivery = noticeDelivery(reaction, program.on, injectable);
  if (delivery.kind === "inject") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: program.on,
          additionalContext: delivery.context,
        },
      }) + "\n",
    );
  }
  // The stderr copy STAYS, deliberately. It is what the debug log and every
  // `runHook`-based probe already read, it costs nothing, and on an event
  // this harness does not inject it is the only trace that exists at all.
  // Removing it would break existing consumers to gain nothing.
  if (reaction.kind === "notice") console.error(reaction.message);
  applyHookWrites(file, { kind: "reaction", reaction }, root);
  return reaction.kind === "run" ? runReactCommand(reaction.command) : PASSED;
}

/**
 * Run a react's classified command. Its exit code is a fact about THAT command,
 * never a verdict: a react has no `deny`, so a formatter that exits 2 must not
 * turn into a block. Anything but 0 is the react failing.
 */
function runReactCommand(command: string): HookRunOutcome {
  const { spawnSync } =
    require("node:child_process") as typeof import("node:child_process");
  const res = spawnSync(command, { shell: true, stdio: "inherit" });
  if (res.status === 0) return PASSED;
  return failed(
    res.status === null
      ? `its react command \`${command}\` was killed (${res.signal ?? res.error?.message ?? "no exit status"})`
      : `its react command \`${command}\` exited ${String(res.status)}`,
    "run that command by hand to see why it fails",
  );
}
