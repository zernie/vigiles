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
import { resolve, dirname, basename, relative } from "node:path";
import {
  verifyHookStamp,
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
  projectRootOf,
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
} from "./core/hook-program.js";
import {
  hasMergeConflictMarkers,
  HARNESS_CONFIG_FILES,
} from "./core/merge-conflict.js";
import { discoverProviderFiles } from "./hook-install.js";
import {
  gatherContext,
  type ProviderRegistry,
  type RegisteredProvider,
} from "./core/hook-providers.js";
import type { SHA256Hash } from "./core/hash.js";
import type { StateFact } from "./core/hook-state.js";
import { readHookState, writeHookState } from "./hook-state-store.js";
import { appendObservation } from "./observe.js";
import { loadHook } from "./load-hook.js";

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
  return resolveAdapter(root).hookProtocol?.injectableEvents ?? [];
}

/**
 * Load a compiled-hook program's default export — the SHARED loader, also the
 * public `vigiles` `loadHook` a `.harness.mjs` test uses, so a hook that
 * loads in a test loads identically here (one loader, no drift).
 */
export const loadHookProgram = loadHook;

/** Load a registered provider (`.vigiles/providers/<name>`) → its definition. */
export async function loadProvider(file: string): Promise<RegisteredProvider> {
  const abs = resolve(process.cwd(), file);
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
export function hookStampPath(file: string): string {
  return resolve(process.cwd(), ".vigiles/hooks", basename(file) + ".json");
}

/**
 * Perform the state writes a hook declared, after its output has been emitted.
 * A refused write (a hand-built record object with a key `record()` would have
 * thrown on) is announced — silence here would be a hook that believes it
 * remembered something.
 */
function applyHookWrites(file: string, outcome: HookProgramOutcome): void {
  const { ok, refused } = outcomeWrites(outcome);
  for (const name of refused) {
    console.error(
      `vigiles: refused to record ${name} from ${file} — not a valid state key.`,
    );
  }
  for (const w of ok) {
    try {
      writeHookState(file, w);
    } catch (e) {
      console.error(
        `vigiles: could not record ${w.name} from ${file}: ${String(e)}`,
      );
    }
  }
}
/**
 * Gather a gate's DECLARED context providers (the trusted-host I/O step). Runs
 * each declared read-only command via execSync in the hook's cwd; a provider
 * that can't resolve yields its default (never throws). The pure registry +
 * decision logic live in core/hook-providers.ts — this only injects the real IO.
 */
async function gatherHookContext(
  program: AnyHook,
  file: string,
): Promise<Record<string, string | boolean | StateFact>> {
  const needs = hookNeeds(program);
  if (needs.length === 0) return {};
  // Only load the registered-provider registry if a provider() ref is declared.
  const hasRef = needs.some(
    (n) => typeof n !== "string" && n.kind === "provider-ref",
  );
  const registry = hasRef ? await loadProviderRegistry() : {};
  const { execSync } =
    require("node:child_process") as typeof import("node:child_process");
  const { isCI } = require("ci-info") as { isCI: boolean };
  return gatherContext(
    needs,
    {
      exec: (command) =>
        execSync(command, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      cwd: process.cwd(),
      platform: process.platform,
      isCI,
      // The namespace is bound HERE, from the hook's own path — core never sees
      // it, so no key a hook can spell reaches another owner's store.
      readState: (key) => readHookState(file, key),
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
async function loadProviderRegistry(): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = {};
  for (const file of discoverProviderFiles(process.cwd())) {
    try {
      const def = await loadProvider(file);
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
): void {
  try {
    const dir = resolve(process.cwd(), ".vigiles");
    mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        hook: file,
        event: on,
        would,
        reason,
      }) + "\n";
    appendFileSync(resolve(dir, "hook-observations.jsonl"), line);
  } catch {
    /* recording is best-effort — never let it break a live session */
  }
}

/**
 * Emit a gate Decision in the harness protocol — the author never writes it.
 * `observe` mode turns a would-be block/ask into a recorded no-op (exit 0): the
 * shadow/rollout path. Harness-neutral — exit 2 / exit 0 are identical on Claude
 * Code and Codex; the record is vigiles-local.
 */
function emitGate(
  decision: Decision,
  on: string,
  mode: HookMode,
  file: string,
): void {
  const action = gateAction(decision, mode);
  switch (action.kind) {
    case "block":
      appendObservation({
        kind: "hook",
        event: on,
        decision: "deny",
        mode: "enforce",
        rule: file,
        reason: action.reason,
      });
      console.error(action.reason);
      process.exit(2);
      return;
    case "ask":
      appendObservation({
        kind: "hook",
        event: on,
        decision: "ask",
        mode: "enforce",
        rule: file,
        reason: action.reason,
      });
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: on,
            permissionDecision: "ask",
            permissionDecisionReason: action.reason,
          },
        }) + "\n",
      );
      return;
    case "observe":
      appendObservation({
        kind: "hook",
        event: on,
        decision: action.would,
        mode: "observe",
        rule: file,
        reason: action.reason,
      });
      recordObservation(file, on, action.would, action.reason);
      console.error(
        `⚠ [vigiles observe] ${on}: would ${action.would} — ${action.reason}`,
      );
      return; // exit 0 — observe never blocks
    case "allow":
      return; // emit nothing, exit 0
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
function hookLoadPathFiles(hookFile: string): readonly string[] {
  const files: string[] = [];
  let dir = dirname(resolve(process.cwd(), hookFile));
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
  files.push(resolve(process.cwd(), ".vigilesrc.json"));
  return files;
}

/**
 * The conflicted files on this hook's load path, if any — the difference between
 * "your hook is broken" and "your repo is mid-merge and the hook is collateral".
 */
function conflictedLoadPathFiles(hookFile: string): readonly string[] {
  return hookLoadPathFiles(hookFile)
    .filter((p) => {
      try {
        return (
          existsSync(p) && hasMergeConflictMarkers(readFileSync(p, "utf-8"))
        );
      } catch {
        return false; // unreadable is a different problem; don't guess about it
      }
    })
    .map((p) => relative(process.cwd(), p) || p);
}

/**
 * Print the loud stderr banner that accompanies a REPAIR-only pass-through, and
 * return true — the caller allows exactly this one tool call. Shared by the two
 * refusal paths (stale stamp, unloadable program) so the wording can't drift.
 */
function announceRepairEscape(file: string, why: string): boolean {
  console.error(
    `vigiles: hook ${file} ${why}.\n` +
      `vigiles: ALLOWING this one call because it is a repair or recovery action ` +
      `(a write to ${file}, to ${hookStampPath(file)}, or to one of ` +
      `${HARNESS_CONFIG_FILES.join(", ")}) ` +
      `— without this the gate blocks the only actions that can fix it.\n` +
      `vigiles: every OTHER tool call stays BLOCKED until the hook loads again.`,
  );
  return true;
}

/**
 * Fail closed if a stamp sidecar exists and the on-disk source no longer
 * matches it — a hand-edit that smuggles in a capability breaks the stamp.
 * No sidecar → run uncompiled (e.g. a test fixture or a not-yet-compiled hook).
 *
 * ONE exception, and it is loud: the author's own REPAIR action
 * ({@link isStampRepairEvent}) is let through, or a repo WEDGES. A stale stamp on
 * a PreToolUse Bash gate blocks every Bash command — including `vigiles compile`,
 * the only command that regenerates the stamp — so a normal edit-compile cycle
 * could paint you into a corner whose only escape was hand-editing
 * `.claude/settings.json` to unwire the gate. Observed 2026-08-03.
 */
function verifyStampOrRefuse(file: string, event: RawHookEvent): void {
  const stampPath = hookStampPath(file);
  if (!existsSync(stampPath)) return;
  try {
    const { stamp } = JSON.parse(readFileSync(stampPath, "utf-8")) as {
      stamp?: string;
    };
    const source = readFileSync(resolve(process.cwd(), file), "utf-8");
    if (stamp && !verifyHookStamp(source, stamp as SHA256Hash)) {
      if (isStampRepairEvent(event, file, process.cwd())) {
        announceRepairEscape(file, "does not match its compiled stamp");
        return;
      }
      console.error(
        `vigiles: hook ${file} does not match its compiled stamp (tampered).\n` +
          `vigiles: if YOU edited it, the way out is a FILE WRITE, not a command — ` +
          `this refusal blocks the recompile too. Either edit ${file} back to what ` +
          `was compiled, or clear its stamp by writing \`{}\` into ` +
          `${stampPath}. The hook then runs UNSTAMPED but still ENFORCES, so ` +
          `\`vigiles compile ${file}\` goes through the normal gate.`,
      );
      process.exit(2);
    }
  } catch {
    /* unreadable sidecar → don't block a live session on it */
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
 * points at. Reads the live event on stdin, loads the typed program, verifies
 * its stamp, and dispatches by role: a gate exits 2 + reason on `deny`; an
 * inject prints `additionalContext`; a react runs its effect-classified
 * command. A hook that won't load — or whose stamp is stale — fails CLOSED
 * (exit 2), never silent-allow, with two loudly-announced exceptions: the repair
 * action itself ({@link isStampRepairEvent}), and — on a LOAD failure only — the
 * load-path repair WRITE ({@link isLoadPathRepairEvent}), or the repo wedges
 * with no way to fix whatever broke the load path.
 *
 * INJECT-HOOK-SPECIFIC: An inject hook that fails to load is a harness failure,
 * not a decision failure. Unlike gates (which must be conservative and block on
 * any error), an inject is pure context addition. It degrades gracefully: if it
 * cannot load, the session continues without the injected context, and the error
 * is logged for debugging. This prevents a single broken inject from wedging all
 * sessions.
 */
export async function runHookProgramCommand(
  file: string | undefined,
): Promise<void> {
  if (!file) {
    console.error("Usage: vigiles hook-runtime run-program <hook-file>");
    process.exit(2);
    return;
  }
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
    /* no stdin */
  }
  let event: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    source?: string;
    prompt?: string;
    stop_hook_active?: boolean;
    /** The session's cwd — Claude Code sends it on every hook payload. */
    cwd?: string;
  } = {};
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    /* malformed → empty event */
  }
  // The root repo-relative path prefixes resolve against. `$CLAUDE_PROJECT_DIR`
  // first (the same root the harness resolved THIS hook's own path against),
  // then the payload's `cwd`; never `process.cwd()`, which under a git worktree
  // can be a different checkout. See `projectRootOf`.
  const projectRoot = projectRootOf(event, process.env);

  let program: AnyHook;
  try {
    program = await loadHookProgram(file);
  } catch (err) {
    // A LOAD failure is a fact about the harness, not a verdict about the
    // command that happened to arrive — so it must still fail CLOSED (a gate
    // that cannot run must not wave traffic through), but the two things it owes
    // the author are different from a `deny`'s: name the real cause, and leave a
    // way back.
    //
    // EXCEPTION: inject hooks. An inject's purpose is to ADD context, not to
    // ENFORCE a decision. If it fails to load, the session should degrade
    // gracefully (no context injected) rather than wedging the entire harness.
    // This is a harness failure, not a gating decision — so we handle it by
    // logging the error and exiting 0. Gates (file, bash, prompt, stop) remain
    // conservative and fail closed.
    //
    // Escapes, both announced loudly on stderr:
    //   - the stale-stamp one (an edit to the hook itself / `vigiles compile`),
    //     for the hook broken mid-edit;
    //   - the RECOVERY set, for the case where the hook is fine and something
    //     else on its load path is not (observed 2026-08-10: `package.json` left
    //     holding merge-conflict markers → Node can't resolve `vigiles/hook` →
    //     no compiled hook loads → the Bash gate refuses `git merge --abort`,
    //     the one command that undoes the cause. Irreversible from inside the
    //     session; it was fixed by hand-editing the JSON, because file tools do
    //     not go through PreToolUse(Bash)).
    // Everything else stays BLOCKED, and the escapes are whitelists of commands
    // that are WRITES — see `isLoadPathRepairEvent` for why no command is one.
    const conflicted = conflictedLoadPathFiles(file);
    // 🔴 THE THROWN MESSAGE IS THE ONLY THING THAT NAMES THE REAL CAUSE when the
    // merge-conflict heuristic above does not fire. Without it this said just
    // "cannot be loaded" — a diagnosis that sends the reader looking in the wrong
    // place, which is the defect this runtime has already shipped twice (the
    // loader that advised `npm run build` when the answer was `npm install`).
    // The comment above promises to name the cause; this is what keeps it.
    const thrown = err instanceof Error ? err.message : String(err);
    const cause =
      conflicted.length > 0
        ? `cannot be loaded — ${conflicted.join(", ")} contains merge-conflict ` +
          `markers, so Node cannot resolve \`vigiles/hook\` from it (the hook itself ` +
          `may be fine)`
        : `cannot be loaded — ${thrown}`;
    if (
      isLoadPathRepairEvent(event, file, {
        // The root the REST of this runtime already uses: `hookStampPath` and
        // `verifyStampOrRefuse` read the hook and its sidecar via `process.cwd()`,
        // so a repair accepted against any other root would name a file the
        // runtime never reads. The hook's own path cannot supply it (a hook sits
        // at any depth, and a `.git` probe would be a disk read core does not do).
        root: process.cwd(),
        loadPathFiles: hookLoadPathFiles(file),
      })
    ) {
      announceRepairEscape(file, cause);
      return;
    }

    // Log the error, but for inject hooks, degrade gracefully (exit 0).
    const errorMsg =
      `vigiles: hook ${file} ${cause}.\n` +
      `vigiles: this is the state of the HARNESS, not a decision about your ` +
      `command — the gate never ran. Blocking anyway (a gate that cannot run ` +
      `must not pass traffic).\n` +
      `vigiles: the way out is a FILE WRITE, not a command — under a tool that ` +
      `WRITES (Write/Edit/MultiEdit); a Read of the same path repairs nothing ` +
      `and is refused. Fix whichever of ` +
      `${file}, ${HARNESS_CONFIG_FILES.join(", ")} is broken — those writes are ` +
      `allowed even while this refuses, and a Bash gate never gated file tools ` +
      `at all. The hook then loads and the gate decides normally again.\n` +
      `vigiles: those paths resolve under ${process.cwd()} — plus any ancestor ` +
      `\`package.json\` Node actually reads, so whatever is named above as the ` +
      `cause is writable. A path in a DIFFERENT checkout is refused: it cannot ` +
      `repair this failure.\n` +
      `vigiles: no command is allowed, deliberately. \`git merge --abort\` and ` +
      `\`git checkout\` RUN \`.git/hooks/*\` (measured: reference-transaction, ` +
      `post-checkout), and \`vigiles compile\` loads the hook through the same ` +
      `resolver that just failed.`;

    console.error(errorMsg);

    // Exit code depends on hook kind. This heuristic is based on the filename —
    // a more robust approach would parse the stamp or metadata, but that requires
    // the hook to load. Inject hooks typically have "inject" in the name; fall
    // back to blocking (exit 2) for safety on gates.
    const isLikelyInject = file.includes("inject");
    if (isLikelyInject) {
      // Inject hook: degrade gracefully. Log the error but don't wedge the session.
      console.error(
        `vigiles: ${file} is an inject hook; degrading gracefully (no context injected).`,
      );
      process.exit(0);
    } else {
      // Gate hook: fail closed.
      process.exit(2);
    }
    return;
  }
  verifyStampOrRefuse(file, event);

  switch (dispatchKind(program)) {
    case "inject": {
      const ctx = await gatherHookContext(program, file);
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
      applyHookWrites(file, {
        kind: "injection",
        context: injection.context,
        records: injection.records,
      });
      return;
    }
    case "react": {
      const ctx = await gatherHookContext(program, file);
      warnIfPathUndecidable(event, projectRoot);
      const reaction = runReact(program as ReactHook, event, ctx, projectRoot);
      // A notice has to REACH someone. stderr at exit 0 goes to the debug log
      // and nothing else (the host's docs are explicit: "Claude never sees it"),
      // and a react always exits 0 because its type has no `deny` — so stderr
      // alone delivered nowhere. Emit the same `additionalContext` shape the
      // shipped refs/eval-lock nudges use, gated on the ACTIVE adapter's
      // `injectableEvents` so this is per-harness fact, not a CC literal.
      const injectable = injectableEventsFor(projectRoot ?? process.cwd());
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
      applyHookWrites(file, { kind: "reaction", reaction });
      if (reaction.kind === "run") {
        const { spawnSync } =
          require("node:child_process") as typeof import("node:child_process");
        const res = spawnSync(reaction.command, {
          shell: true,
          stdio: "inherit",
        });
        process.exit(res.status ?? 0);
      }
      return;
    }
    case "file-gate": {
      const ctx = await gatherHookContext(program, file);
      warnIfPathUndecidable(event, projectRoot);
      emitGate(
        decideFileGate(program as FileGateHook, event, ctx, projectRoot),
        program.on,
        hookMode(program),
        file,
      );
      return;
    }
    case "bash-gate": {
      const ctx = await gatherHookContext(program, file);
      // The same `projectRoot` the file gates get: without it every
      // repo-relative prefix in a DENYLIST matcher (`touches`/`writesTo`) is
      // matched by over-blocking alone, and with it an absolute token is placed
      // exactly. Measured bypass this closes: `sed -i s/a/b/ <abs>/paper.tex`
      // exited 0 against a guard that blocked the relative spelling.
      emitGate(
        decideProgram(program as HookProgram, event, ctx, projectRoot),
        program.on,
        hookMode(program),
        file,
      );
      return;
    }
    case "prompt-gate": {
      const ctx = await gatherHookContext(program, file);
      emitGate(
        decidePromptGate(program as PromptGateHook, event, ctx),
        program.on,
        hookMode(program),
        file,
      );
      return;
    }
    case "stop-gate": {
      const ctx = await gatherHookContext(program, file);
      emitGate(
        decideStopGate(program as StopGateHook, event, ctx),
        program.on,
        hookMode(program),
        file,
      );
      return;
    }
  }
}
