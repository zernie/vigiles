/**
 * Refuse to spend model calls when somebody else's test runner owns this process.
 *
 * ## The failure this removes
 *
 * A vigiles eval spawns `claude` and spends real money. It is meant to run on a
 * schedule, from `vigiles eval`. But an author who names one `foo.test.mjs` — a
 * name vigiles used to CREDIT as coverage — hands it to every default `npx vitest`
 * / `npx jest` run in the repository, because that name matches their default
 * patterns exactly (read out of the installed packages):
 *
 *   vitest  ** /*.{test,spec}.?(c|m)[jt]s?(x)
 *   jest    ** /?(*.)+(spec|test).?([mc])[jt]s?(x)
 *           ** /__tests__/** /*.?([mc])[jt]s?(x)   ← everything in that directory
 *
 * Measured 2026-08-11: a bare project with `.claude/skills/foo/foo.test.mjs` and a
 * plain `npx vitest run` — it executed. "It lives under a dot-directory, nothing
 * else will find it" is false. The bill arrives silently, on every push, in CI.
 *
 * The naming half is fixed elsewhere (those globs no longer count). This is the
 * part that does not depend on anybody obeying a convention: the money cannot be
 * spent from inside a foreign runner, whatever the file is called.
 *
 * ## 🪦 THE STATIC HALF WAS DELETED 2026-08-12, AND THIS IS NOW THE WHOLE DEFENCE
 *
 * There used to be a companion, `core/foreign-runner-tests.ts`: a lexical gate
 * that read every file under a harness surface dir, decided FROM THE TEXT whether
 * it drives an agent (`runEval(`, `runHarnessTest(`, …), and warned in the audit
 * report when a default vitest/jest glob would collect it. It is gone, with its
 * test file and the disk walker in `scan.ts` that fed it.
 *
 * It was deleted under a rule that file pre-registered, not on a whim:
 *
 * > A seventh false positive is not another bug to fix — it is the measurement
 * > saying the lexical rule cannot be made tight enough, and the answer then is
 * > to DELETE the gate and let the money guard be the whole defence.
 *
 * THE SEVENTH ARRIVED: `function testDriver(runEval) { runEval(fake); }`. The
 * binding check looked at declarations and import aliases but never at PARAMETER
 * lists, so an ordinary offline unit test injecting a fake was reported as
 * spawning a real agent. Run, not argued — the gate over one file of that shape
 * returned one finding, whose warning read *"It calls `runEval`, which spawns an
 * agent"* and told the author to rename the file. That sentence was false about
 * that file.
 *
 * Six shapes had already been narrowed away one at a time, and this one had been
 * SELF-DISCLOSED in the file as a known residual ("costs one warning and needs a
 * scope analysis this module cannot have"). Pre-disclosure is not a defence: a
 * pre-registered stopping rule exists precisely to stop "we know, it is
 * acceptable" from running forever, so the count was honoured rather than
 * reasoned around.
 *
 * The measurement agreed independently. Across three corpora (this repo, a
 * 43-harness consumer repo, five vendored third-party plugin repos — 3 613 js/ts
 * files), and re-measured at deletion time over this repo's 941 files:
 *
 *   true positives, ever                                            0
 *   distinct false-positive shapes reported                         7
 *
 * Its only demonstrated effect on a real repository was an effect of NOT firing.
 * Every error it made was the expensive kind: the remedy it printed is "rename
 * this file", so a false warning costs someone a working test, while a missed
 * warning costs nothing — the refusal below already fires at all four spawn doors
 * (`judge.ts`, `eval.ts`, `scan-behavioral.ts`, `adapters/codex/eval.ts`), so a
 * miss is at most a less friendly notice, never a bill.
 *
 * ⚠️ WHAT IS GENUINELY LOST: the early, report-time heads-up. An author who names
 * a harness test `foo.test.mjs` now learns it at the refusal below rather than in
 * the audit. That is the trade, made knowingly — an advisory that has never once
 * been right is not worth a warning that has been wrong seven times.
 *
 * The removal is PINNED, not merely done: `scan-vendor.test.ts` still asserts that
 * no `COLLECTS AND EXECUTES` warning appears on the vendored corpus, so bringing
 * the gate back fails a test instead of passing silently.
 *
 * ## Why not an environment variable
 *
 * The obvious version is `process.env.VITEST`. It was proposed and rejected: that
 * variable can sit in a `.env` or in a CI environment for unrelated reasons, and
 * then a legitimate scheduled eval refuses to run — a guard that fires on correct
 * input is a guard people delete.
 *
 * `process.argv[1]` is the path node was actually started with, which no stray
 * configuration can forge. Measured, same spike:
 *
 *   under `npx vitest run`   → …/node_modules/vitest/dist/workers/forks.js
 *   under `node foo.eval.mjs`→ …/foo.eval.mjs
 *   under `vigiles eval`     → the script vigiles spawned
 *
 * So the check is a POSITIVE identification of a known runner, not "am I the entry
 * point". Positive is the conservative direction here: an unrecognised wrapper
 * runs (and may cost money) rather than a legitimate run being blocked by a
 * pattern nobody predicted.
 *
 * ## 🔴 `node --test` HAS NO argv SIGNAL AT ALL, and the line that claimed one
 * was dead from the day it was written
 *
 * `["node --test", ["node_modules/.bin/node--test"]]` used to sit in the table
 * below. It was added by analogy with the npx-installed runners and never
 * measured. There is no such binary: Node's test runner is a FLAG on node
 * itself, so nothing under `node_modules/.bin/` can appear in `argv[1]`, and the
 * entry could not fire under any invocation. That is worse than its absence — it
 * READ as coverage while the paid tier stayed reachable from a legacy harness
 * named `*.test.mjs`, a name Node's own default patterns collect.
 *
 * Measured 2026-08-12 (Node 22.22, a fixture printing its own process facts):
 *
 *   node --test foo.test.mjs
 *     argv[1]           = /abs/foo.test.mjs   ← the TEST FILE, no runner in sight
 *     execArgv          = []                  ← the flag is not here either
 *     NODE_TEST_CONTEXT = child-v8            ← the only signal
 *
 *   node --test --experimental-test-isolation=none foo.test.mjs
 *     argv[1]           = foo.test.mjs
 *     execArgv          = ["--test", "--experimental-test-isolation=none"]
 *     NODE_TEST_CONTEXT = undefined           ← in-process: no child, no var
 *
 * The two modes therefore need two different facts, and both are read here.
 *
 * ⚠️ THIS IS NOT THE `process.env.VITEST` IDIOM REJECTED ABOVE, and the
 * difference is the reason it is allowed. `VITEST` is a USER-VISIBLE CONVENTION:
 * a person can put it in a `.env` or a CI job for unrelated reasons, so a guard
 * reading it fires on correct input. `NODE_TEST_CONTEXT` is set by NODE ITSELF in
 * the child it spawns — the internal protocol between runner and test process,
 * which nobody writes into their own environment. Same for `execArgv`: the flag
 * list node was launched with (`--test` is explicitly refused inside
 * `NODE_OPTIONS` — verified — so it cannot arrive from a stray env either). Do
 * not "fix" this back into an argv fragment: for `node --test` an argv signal
 * does not exist, so the choice is these facts or no detection at all.
 *
 * Pure: facts in, a name or null out. No process access, no filesystem.
 */

/** Path fragments that identify a runner owning the process. POSIX-normalised.
 *  Every fragment was MEASURED from a real run of that runner — see the tests. */
const RUNNERS: readonly (readonly [string, readonly string[]])[] = [
  ["vitest", ["node_modules/vitest/", "node_modules/.bin/vitest"]],
  [
    "jest",
    [
      "node_modules/jest/",
      "node_modules/jest-cli/",
      "node_modules/jest-worker/",
      "node_modules/.bin/jest",
    ],
  ],
  ["mocha", ["node_modules/mocha/", "node_modules/.bin/mocha"]],
  ["ava", ["node_modules/ava/", "node_modules/.bin/ava"]],
];

/** The name reported for Node's built-in runner — also the command to blame. */
const NODE_TEST = "node --test";

/**
 * The process facts identifying Node's own test runner, which leaves no trace in
 * `argv[1]`. Passed in rather than read, so the decision stays pure.
 */
export interface NodeTestFacts {
  /** `process.execArgv` — carries `--test` when the runner is IN-PROCESS. */
  readonly execArgv?: readonly string[];
  /** `process.env.NODE_TEST_CONTEXT` — node sets it in the test CHILD it spawns. */
  readonly nodeTestContext?: string | undefined;
}

/**
 * The foreign test runner that started this process, or `null`.
 *
 * `argv1` is `process.argv[1]`; `node` carries the two facts that identify Node's
 * built-in runner (see the header). Both are passed in rather than read, so the
 * decision is a pure function the tests drive with values measured from real runs.
 */
export function foreignRunner(
  argv1: string | undefined,
  node: NodeTestFacts = {},
): string | null {
  // `--test` EXACTLY: `--test-only` / `--test-name-pattern` are ordinary flags a
  // plain `node foo.eval.mjs` may carry, and a prefix match would refuse it.
  if (
    (node.nodeTestContext ?? "") !== "" ||
    (node.execArgv ?? []).includes("--test")
  )
    return NODE_TEST;
  if (!argv1) return null;
  const p = argv1.replaceAll("\\", "/");
  for (const [name, fragments] of RUNNERS)
    if (fragments.some((f) => p.includes(f))) return name;
  return null;
}

/**
 * The refusal message. Separate from the check so a test can assert the WORDS —
 * a guard that stops a run without saying what to do instead is a support ticket.
 */
export function foreignRunnerRefusal(runner: string, what: string): string {
  return (
    `vigiles refused to spawn a model: this process is running under ${runner}.\n` +
    `  ${what} spends real model calls, and a general test runner picking it up ` +
    `would spend them on every push.\n` +
    `  If this file is a vigiles eval, run it with \`vigiles eval <file>\` ` +
    `and name it \`<surface>.eval.mjs\` — that name is outside ${runner}'s default patterns.\n` +
    `  If ${runner} is meant to run it, it must not call the real-model tier.`
  );
}

/**
 * Refuse to spend model budget when a foreign test runner started this process.
 *
 * 🔴 CALL THIS AT EVERY REAL-MODEL SPAWN. It used to live privately in `eval.ts`
 * and be called from exactly one place — `spawnAgent`, the real `claude` runner —
 * on the reasoning that the composition root funnels every paid path. Measured
 * 2026-08-12: it funnels ONE of four.
 *
 *   src/eval.ts               spawn(claudeCodeRuntime.agentBinary)  guarded
 *   src/adapters/codex/eval.ts  spawnSync("codex", …)               UNGUARDED
 *   src/judge.ts                spawnSync("claude", …)              UNGUARDED
 *   src/scan-behavioral.ts      spawnSync("claude", …)              UNGUARDED
 *
 * `measureTriggerRate(spec, { evalDriver })` calls the injected driver's runner
 * DIRECTLY, so a Codex eval collected by a stray `npx vitest run` spent real
 * money on every push while the guard looked complete. The irony is worth
 * recording: the untested-skill nudge now tells Codex users to pass
 * `{ evalDriver }` — the product recommends the shape that bypassed the guard.
 *
 * Lives here, in a module that imports NOTHING, so any adapter can call it
 * without a cycle. `foreignRunner` stays pure; this is the one impure wrapper,
 * and it is impure precisely so callers cannot forget to pass the facts.
 *
 * ⚠️ CALL IT OUTSIDE ANY `try` THAT SWALLOWS. `judge` and `deriveAttackReal` both
 * wrap their spawn in `try { … } catch { return fallback }`, so a refusal thrown
 * inside would be caught and downgraded to a score of 0 / a canned string — a
 * silent wrong answer instead of a stop. Both call it before the `try`.
 */
export function refuseUnderForeignRunner(what: string): void {
  // `node --test` is INVISIBLE in argv (it is a flag on node, not an installed
  // binary), so the two facts that do identify it are read here — the one impure
  // place — and handed to the pure decision above.
  const runner = foreignRunner(process.argv[1], {
    execArgv: process.execArgv,
    nodeTestContext: process.env["NODE_TEST_CONTEXT"],
  });
  if (runner !== null) throw new Error(foreignRunnerRefusal(runner, what));
}
