#!/usr/bin/env node

/**
 * The `vigiles` bin — a DISPATCHER SHIM, and deliberately almost empty.
 *
 * ## Why this file has no imports
 *
 * `dist/cli.js` is the `bin`, so it is also what the harness spawns for
 * `vigiles hook-runtime run-program <file>` — a compiled hook's decision, which
 * runs on EVERY matching tool call. The output is CommonJS, where a top-level
 * `import` becomes a top-level `require` that resolves BEFORE argv is read. The
 * verb barrel (`./cli-main.js`) has ~85 of them: the report template loader, the
 * linter catalogs, the adapter registry, `audit`, `eval`, `init`. A hook calls
 * none of it.
 *
 * MEASURED 2026-09-08, Node 22.22.2, median of 20 spawns
 * (`node tools/measure-hook-startup.mjs` — run it, do not trust these):
 *
 * ```
 *   bare `node -e ''`                                42 ms
 *   require dist/core/hook-program.js               170 ms
 *   require dist/cli.js  ← what a hook used to load 623 ms
 *   a real run-program spawn                    610-661 ms
 * ```
 *
 * A shell hook doing the same job costs ~12 ms and a python one ~35 ms, so the
 * gap was the reason to keep the shell hook. Issue #216.
 *
 * ## The rule this file exists to hold
 *
 * 🔴 NO TOP-LEVEL IMPORT MAY BE ADDED HERE. Every `require` in this file is paid
 * by every gated tool call before anything decides anything. Both branches below
 * load their module lazily, inside the branch. `src/hook-runtime-graph.test.ts`
 * fails the day a top-level import puts the CLI barrel back into a hook
 * decision's module graph — it asserts the GRAPH, not a duration, because a
 * timing threshold on a shared CI runner is flaky and would be quarantined first.
 *
 * ## What must not change
 *
 * The emitted command `npx vigiles hook-runtime run-program <file>` is byte-for-byte
 * what `vigiles compile` has already written into users' `.claude/settings.json`
 * and `.codex/config.toml`, and it is covered by the SHA stamp beside each hook.
 * Renaming it — or moving the bin off `dist/cli.js` — breaks a contract that
 * lives in other people's repositories. It is a fast path THROUGH the same
 * command, never a new one.
 *
 * Harness-neutral: `run-program` dispatches on the hook's own role, and the gate
 * protocol (deny → exit 2) is identical on Claude Code and Codex, so one path
 * serves both. The single harness-specific fact (which events accept injected
 * context) is read from the resolved adapter inside the runtime.
 */

/**
 * Print a top-level failure the way the CLI always has: the MESSAGE, not a raw
 * stack (dogfood C2); `VIGILES_DEBUG=1` for the stack when diagnosing an
 * internal bug. Duplicated here rather than imported, because importing it would
 * load the thing this file exists not to load.
 */
function die(e: unknown): never {
  if (process.env.VIGILES_DEBUG && e instanceof Error && e.stack) {
    console.error(e.stack);
  } else {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(2);
}

async function dispatch(): Promise<void> {
  // Parsed EXACTLY as `main()` parses it — `args.slice(1)` with `--flags`
  // dropped — so the fast path and the barrel agree on which argument is the
  // hook file. A shim that split argv its own way would be a second truth.
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1).filter((a) => !a.startsWith("--"));
  const kind = rest[0];

  // THE FAST PATH — a compiled hook's decision, and the only branch that must
  // stay cheap. It loads `./hook-runtime.js` and nothing else.
  //
  // Scoped to `run-program` on purpose. The other `hook-runtime` kinds (the
  // agent/skill rails, `refs`, `guard`, `action`, the effect markers) still go
  // through the barrel: their handlers are woven into the verbs' helpers, so
  // moving them is a much larger edit for a colder path, and this issue measured
  // `run-program`. They behave exactly as before — same function, same output.
  if (command === "hook-runtime" && kind === "run-program") {
    const { runHookProgramCommand } =
      require("./hook-runtime.js") as typeof import("./hook-runtime.js");
    await runHookProgramCommand(rest[1]);
    return;
  }

  const { main } = require("./cli-main.js") as typeof import("./cli-main.js");
  await main();
}

void dispatch().catch(die);
