/**
 * vigiles — run harness-test / eval script files via the CLI.
 *
 * `vigiles test` and `vigiles eval` discover `*.harness.*` / `*.eval.*`
 * scripts and run each as a child `node` process, so the two-tier
 * harness-testing API (`src/harness-test.ts`, `src/eval.ts`) works as a CI
 * command, not just `node x.mjs`. Scripts may be authored in **JavaScript**
 * (`.mjs` / `.cjs` / `.js`) **or TypeScript** (`.ts` / `.mts` / `.cts`) — a TS
 * script is run through `tsx` when installed, else Node's built-in type
 * stripping (Node >= 22.6). The scripts import from the built `dist/`, so they
 * also run standalone — the CLI just discovers, runs, and aggregates exit codes.
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { globSync } from "glob";
import {
  CHECK_COUNT_ENV,
  parseCheckReport,
  type SurfaceProbe,
} from "../../check-count.js";

/**
 * The outcome of running one script.
 *
 * `"vacuous"` — the script exited 0 and reported that it made ZERO checks. It
 * neither passed nor failed: nothing was verified. See {@link statusFor}.
 */
export type ScriptStatus = "pass" | "skip" | "fail" | "vacuous";

export interface ScriptRunResult {
  readonly file: string;
  readonly code: number;
  readonly status: ScriptStatus;
  /**
   * How many checks the script reported making, or `undefined` when it reported
   * nothing at all — a script that never imports `vigiles` has no way to
   * report, and that silence is NOT a claim about it. `0` is a claim: the script
   * loaded the library and used none of it.
   */
  readonly checks?: number;
  /**
   * The surfaces this script was seen to exercise — derived by the tiers from the
   * command they ran and the transcripts they got back, never declared by the
   * author (see `coverage-probe.ts`). Feeds `.vigiles/coverage.json`, which lets
   * coverage answer "tested?" by EXECUTION instead of by file name.
   *
   * Absent for a script that reported nothing, and empty for one that reported a
   * count but exercised no identifiable surface — a unit test of a pure helper,
   * say. Neither is a finding.
   */
  readonly surfaces?: readonly SurfaceProbe[];
}

/**
 * Exit code a harness/eval script uses to report itself SKIPPED (e.g. the
 * deterministic tier when `claude` isn't installed) — the autotools convention.
 * The runner surfaces it as a loud `⊘ SKIPPED` instead of a silent `✓`, and a
 * skip never fails the run. Scripts call `skip()` (vigiles) to emit it.
 */
export const SKIP_EXIT_CODE = 77;

/**
 * Classify one script's run from its exit code and its reported check count.
 *
 * 🔴 THE FOURTH STATE, AND WHY. Exit codes answer "did it fail?", never "did it
 * do anything?". Measured 2026-08-08: a file whose whole body is
 * `export default { "never runs": () => assert.equal(1, 2) }` imports fine,
 * exits 0, and printed `✓ … 1 passed` — a false assertion, never called,
 * reported as a pass. A consumer repo hit exactly that and now hand-copies a
 * warning into every new harness header, because the runner could not enforce
 * it: eight harnesses resting on a comment.
 *
 * So a run that ends clean having recorded ZERO checks is `"vacuous"` — its own
 * visible state, not folded into `passed`, the same way a skip is not.
 *
 * NOT A FAILURE, deliberately. Harnesses in the wild predate the counter, and a
 * tool that turned CI red on the release that taught it a new word would be
 * punishing people for upgrading. It is loud and it is not fatal.
 *
 * AND SILENCE IS NOT ZERO. `checks === undefined` means the script never
 * reported — it may not import `vigiles` at all — so it stays a plain
 * `pass`, exactly as before. Only a script that loaded the library and used
 * none of it says zero. This is the `undefined`-vs-`[]` distinction
 * `assertNoWrite` already draws: "nobody looked" must not read as "nothing
 * happened".
 */
export function statusFor(
  code: number,
  checks: number | undefined,
  output?: string,
): ScriptStatus {
  if (code === SKIP_EXIT_CODE) return "skip";
  if (code !== 0) return didNotLoad(output) ? "skip" : "fail";
  return checks === 0 ? "vacuous" : "pass";
}

/**
 * Did the script fail to LOAD, rather than fail?
 *
 * 🔴 The distinction is not cosmetic, because `fail` RETRACTS coverage while
 * `skip` does not (see the table on `runsFromResults`). The rule for `fail` —
 * "it ran and proved nothing, so it must not keep yesterday's green record
 * alive" — is right, and it does not describe a file the runtime never
 * evaluated. A module that cannot resolve executed no assertion; it is the same
 * "did not run" as a missing `claude` CLI, arriving through a different door.
 *
 * MEASURED, twice in one session on 2026-08-20: a container restore left an old
 * `node_modules` behind, every harness in the consumer repo died on `Named export
 * 'recordCheck' not found`, and the ledger dropped from 48 records to 34 and from
 * 47 to 33. Nothing about those surfaces had changed — the machine had.
 *
 * ⚠️ This does NOT make a broken environment quiet. A skip still prints `⊘
 * SKIPPED`, and `--no-skip` — which this repo's own CI passes — still fails the
 * run. What changes is only whether a machine problem is allowed to delete a
 * measurement taken on a machine that worked.
 *
 * Deliberately literal, and only the loader's own vocabulary: these strings come
 * from Node's module resolution, not from user code. A test that legitimately
 * asserts on one of them exits 0 or asserts, and never reaches here.
 */
function didNotLoad(output: string | undefined): boolean {
  if (output === undefined || output === "") return false;
  return (
    output.includes("ERR_MODULE_NOT_FOUND") ||
    output.includes("Cannot find package") ||
    output.includes("Cannot find module") ||
    /SyntaxError: Named export '[^']*' not found/.test(output) ||
    output.includes("ERR_UNSUPPORTED_DIR_IMPORT") ||
    output.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")
  );
}

/** Filename extensions accepted for harness/eval scripts (JS and TS). */
export const SCRIPT_EXTS = ["mjs", "cjs", "js", "mts", "cts", "ts"] as const;

/** Glob suffix matching every accepted script extension, e.g. `harness`. */
export function scriptGlob(kind: "harness" | "eval"): string {
  return `**/*.${kind}.{${SCRIPT_EXTS.join(",")}}`;
}

const TS_EXT = /\.(?:m|c)?ts$/;

// The capability probe lives in `src/ts-runner-caps.ts` so the SUGGESTER
// (`testFileExt`, harness-agnostic) can ask the same question this runner
// answers. It used to recommend `.ts` from a `tsconfig.json` alone, on a Node 20
// box with no `tsx` — a file `interpreterArgs` then refused to run. Re-exported
// here so every existing importer of `run-scripts.js` is unchanged.
export {
  detectNodeCaps,
  canRunTypeScript,
  type NodeCaps,
} from "../../ts-runner-caps.js";
import { detectNodeCaps } from "../../ts-runner-caps.js";
import type { NodeCaps } from "../../ts-runner-caps.js";

/**
 * The `node` argv (after the binary) to run a single script. Plain JS runs
 * directly; a TypeScript script picks `tsx` when available, else Node's native
 * type stripping. Throws a clear, actionable error when neither is available.
 * Pure — exported for testing.
 *
 * `entry` interposes a program that takes the script as its ARGUMENT instead of
 * running the script as the program. `vigiles eval` passes one: an eval file
 * describes its eval rather than running it (see `src/eval-define.ts`), so
 * something has to import the description and execute what it declares. Harness
 * scripts pass nothing and are launched exactly as before.
 *
 * 🔴 The disjunction below is `canRunTypeScript` — keep them together. When they
 * drifted, the tool recommended a `.ts` file and then refused to run it.
 */
export function interpreterArgs(
  file: string,
  caps: NodeCaps,
  entry?: string,
): string[] {
  // The TS flags are chosen from FILE's extension even when `entry` runs — a
  // JavaScript entry importing a `.ts` eval still needs the loader installed.
  const tail = entry === undefined ? [file] : [entry, file];
  if (!TS_EXT.test(file)) return tail;
  if (caps.tsx) return ["--import", "tsx", ...tail];
  if (caps.stripTypes) return ["--experimental-strip-types", ...tail];
  throw new Error(
    `Cannot run TypeScript test script "${file}": install tsx ` +
      `(npm i -D tsx) or use Node >= 22.6, or author it as a .mjs file.`,
  );
}

/**
 * Expand the given path/glob patterns into concrete script files. A pattern
 * that is an existing file passes through unchanged; anything else is treated
 * as a glob. Falls back to `defaultGlob` when no patterns are given. Results
 * are deduped and sorted. `ignore` is the repo's ExcludeSet string face
 * (src/exclude.ts — the floor plus `.vigilesrc.json#exclude`), REQUIRED so a
 * vendored corpus's own `*.harness.mjs` cannot be discovered and run as ours
 * (#192). A path given explicitly in `patterns` is still run.
 */
export function discoverScripts(
  patterns: readonly string[],
  defaultGlob: string,
  cwd: string,
  ignore: readonly string[],
): string[] {
  const globs = patterns.length > 0 ? patterns : [defaultGlob];
  const found = new Set<string>();
  for (const p of globs) {
    if (existsSync(resolve(cwd, p))) {
      found.add(p);
      continue;
    }
    // 🔴 `dot: true`, because the harness for a Claude Code harness lives in `.claude/`.
    // Without it, `vigiles test` and `vigiles eval` print "no files found" in a repository
    // that has them, and `Tested` then measures visibility rather than coverage — the author
    // reads "you have no tests" when the honest reading is "I looked in the wrong place".
    // Observed 2026-08-07 on a repo with two harnesses under `.claude/`, both invisible; it
    // stayed hidden because that repo's CI happened to pass explicit paths.
    //
    // This codebase already fixed the same defect elsewhere and missed it here:
    // `test-coverage.ts` and `cli.ts` both pass `dot: true` with comments saying why, and
    // `test-coverage.test.ts` records "glob without `dot:true` never found it and the surface
    // looked untested". Coverage learned it; the runner did not.
    for (const m of globSync(p, {
      cwd,
      ignore: [...ignore],
      dot: true,
    })) {
      found.add(m);
    }
  }
  return [...found].sort();
}

/**
 * What a script left behind, or `undefined` if it left nothing (it never
 * imported `vigiles`, or died before its exit handler). The parse itself
 * lives beside the writer in `check-count.ts` so the two cannot drift; anything
 * malformed is treated as no report — a corrupt scratch file must not invent a
 * verdict.
 */
function readCheckReport(
  path: string,
): { checks: number; surfaces: readonly SurfaceProbe[] } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseCheckReport(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Extra wiring for {@link runScripts}. */
export interface RunScriptsOptions {
  /**
   * How many scripts may run at once. Omitted → decided from `entry`: `test`
   * fans out across the cores, `eval` stays at 1. See {@link runScripts}.
   */
  readonly concurrency?: number;
  /**
   * A program to run INSTEAD of each script, with the script's path as its one
   * argument. `vigiles eval` passes `dist/eval-entry.js`; `vigiles test` passes
   * nothing. See {@link interpreterArgs}.
   */
  readonly entry?: string;
}

/**
 * Run each script as `node <file>` (or `node <entry> <file>`, see
 * {@link RunScriptsOptions}), inheriting stdio so the script's own report
 * streams to the console. `env` is merged over `process.env` for every child
 * (e.g. `VIGILES_TRIALS`). Returns the per-file exit codes + check counts.
 *
 * Each child is handed its OWN scratch path in `VIGILES_CHECK_COUNT_ENV`, which
 * `vigiles` writes its check count to on exit — the channel that makes
 * "ran nothing" distinguishable from "ran and passed" (see check-count.ts). It
 * has to be a file: stdio is inherited so the script's report streams live,
 * which leaves no stream to parse.
 *
 * The same channel carries WHICH SURFACES the script exercised, so the caller can
 * record them (`.vigiles/coverage.json`) and coverage can answer "tested?" from
 * execution rather than from a matching file name.
 */
export async function runScripts(
  files: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  opts: RunScriptsOptions = {},
): Promise<ScriptRunResult[]> {
  const caps = detectNodeCaps(cwd);
  const countDir = mkdtempSync(join(tmpdir(), "vigiles-checks-"));

  // 🔴 THE DEFAULT IS DECIDED BY `entry`, NOT BY A FLAG, because the two commands
  // that share this runner have OPPOSITE right answers and the caller already
  // distinguishes them:
  //
  //   `test` passes no entry — every script is a `*.harness.*` file, which is free
  //   and deterministic BY CONSTRUCTION (the harness tier drives the agent CLI
  //   against a mock model with no API key, and anything that spends money lives
  //   behind `vigiles/eval` with a `paid_` prefix). Nothing here can bill, so the
  //   only reason to serialize was that we always had.
  //
  //   `eval` passes an entry — every script spends real model quota. Running those
  //   N-at-a-time multiplies spend and collides with rate limits, so it stays at 1.
  //
  // Measured motivation: 48 harness files in one consumer repo took 1m48s in CI as
  // a strict queue, on a runner with cores sitting idle.
  const parallel = Math.max(
    1,
    opts.concurrency ?? (opts.entry ? 1 : Math.min(8, availableParallelism())),
  );

  // Output is BUFFERED per child and printed when that child exits, rather than
  // inherited. This is the real cost of concurrency and the reason it was not
  // free: with `stdio: "inherit"` two children write to the same terminal at once
  // and 48 reports shred into each other. Buffering keeps each report whole and
  // attributable; what it gives up is live streaming, which only matters when one
  // script is slow AND alone — i.e. exactly the `eval` case, where parallel is 1
  // and the buffer is flushed as soon as the single child ends anyway.
  const runOne = (file: string, i: number): Promise<ScriptRunResult> =>
    new Promise((resolveRun) => {
      let argv: string[];
      try {
        argv = interpreterArgs(file, caps, opts.entry);
      } catch (e) {
        console.error(`✗ ${file}: ${(e as Error).message}`);
        resolveRun({ file, code: 1, status: "fail" });
        return;
      }
      const countFile = join(countDir, `${String(i)}.count`);
      // Resolve a harness's bare `vigiles` import from the CLI's OWN install, so
      // running the gate does not require installing the package into the
      // project — which, in a repo that already has a package.json, drags in the
      // entire dependency tree (measured at 840 packages against vigiles' 42,
      // #184). Only rescues that specifier, and only after normal resolution
      // fails, so a locally installed copy still wins.
      const selfRoot = resolve(__dirname, "..", "..", "..");
      const hook = pathToFileURL(
        join(selfRoot, "dist", "harness-resolve-hooks.mjs"),
      ).href;
      const child = spawn("node", ["--import", hookImport(hook), ...argv], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...env,
          VIGILES_SELF_ROOT: selfRoot,
          [CHECK_COUNT_ENV]: countFile,
        },
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", (c: Buffer) => chunks.push(c));
      const finish = (code: number): void => {
        const output = Buffer.concat(chunks).toString("utf8");
        process.stdout.write(output);
        const report = readCheckReport(countFile);
        resolveRun({
          file,
          code,
          status: statusFor(code, report?.checks, output),
          checks: report?.checks,
          ...(report ? { surfaces: report.surfaces } : {}),
        });
      };
      // `error` fires when the process could not be spawned at all; without this
      // the promise would never settle and the whole run would hang silently —
      // which is worse than any failure it could report.
      child.on("error", (e) => {
        chunks.push(Buffer.from(`✗ ${file}: ${e.message}\n`));
        finish(1);
      });
      child.on("close", (code) => {
        finish(code ?? 1);
      });
    });

  try {
    // Results are stored BY INDEX so the reported order is the discovery order,
    // whatever order the children happen to finish in. A run whose output reorders
    // itself between invocations reads as flaky even when every result is stable.
    const results: ScriptRunResult[] = new Array<ScriptRunResult>(files.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        results[i] = await runOne(files[i], i);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(parallel, files.length) }, () => {
        return worker();
      }),
    );
    return results;
  } finally {
    rmSync(countDir, { recursive: true, force: true });
  }
}

/**
 * Whether any script FAILED. Neither a skip nor a vacuous run counts: the first
 * declined to run, the second ran and verified nothing, and neither is evidence
 * that anything is broken. Both are visible in the summary instead.
 */
export function anyFailed(results: readonly ScriptRunResult[]): boolean {
  return results.some((r) => r.status === "fail");
}

/**
 * What a `test`/`eval` invocation should do about actually RUNNING the discovered
 * scripts:
 * - `run`     — proceed.
 * - `confirm` — interactive human, no explicit intent: ask before firing `count`.
 * - `refuse`  — headless, no explicit intent: don't silently fire the whole tree.
 */
export type RunScriptsDecision =
  | { readonly kind: "run" }
  | { readonly kind: "confirm"; readonly count: number }
  | { readonly kind: "refuse"; readonly count: number };

export interface RunScriptsEnv {
  /** `test` is free/deterministic → always runs. `eval` spends model quota. */
  readonly kind: "test" | "eval";
  /** The user named explicit target files/globs (positional args) — clear intent. */
  readonly explicitTargets: boolean;
  /** How many script files the discovery matched. */
  readonly matchedCount: number;
  /** A human at a terminal who can answer + wait. */
  readonly isTTY: boolean;
  /** `--all` — opt in to running the whole discovered set without a prompt. */
  readonly all: boolean;
  /** `--yes` / `--no-interactive` — agent/CI mode: never prompt. */
  readonly yes: boolean;
  /**
   * `--check` — VERIFY committed eval locks rather than measure. `decideLock`
   * in check mode returns only `replay` (the recorded report, no model call) or
   * `stale` (a failure), NEVER `run` — so this path cannot spend quota, and the
   * quota consent below must not stand in its way.
   *
   * Measured 2026-09-09: the CI `eval-check` step had never once executed. With
   * no lock committed anywhere, `eval --check` short-circuited on
   * `anyLocksCommitted` and returned "skip"; the first repo to commit a lock got
   * past that early return, reached this gate, and was refused exit 2. A gate
   * that is green because it never runs is the failure this repo keeps naming.
   */
  readonly lockCheck: boolean;
}

/**
 * Consent gate for a bare (no-target) `vigiles eval`. `eval` runs the REAL model
 * on your subscription, and a no-target run discovers every `*.eval.*` over the
 * whole tree — so a repo with many evals fires them all and spends quota. Mirrors
 * `audit`'s read-vs-run consent (`decideExecute`): a paid, side-effecting verb
 * never fans out over an unbounded glob without either an explicit target, an
 * `--all` opt-in, or an interactive yes. `test` is free + deterministic, so it
 * always runs. Total + pure, first match wins; the IO (prompt/refuse) lives in the
 * CLI.
 */
export function decideRunScripts(o: RunScriptsEnv): RunScriptsDecision {
  if (o.kind === "test") return { kind: "run" };
  if (o.explicitTargets) return { kind: "run" };
  if (o.all || o.yes) return { kind: "run" };
  // Verifying a lock is not spending quota — see `lockCheck`.
  if (o.lockCheck) return { kind: "run" };
  // A bounded no-target run (0 = no-op, 1 = a single obviously-intended eval) is
  // not the footgun; the footgun is fanning out over the whole tree.
  if (o.matchedCount <= 1) return { kind: "run" };
  if (!o.isTTY) return { kind: "refuse", count: o.matchedCount };
  return { kind: "confirm", count: o.matchedCount };
}

const MARK: Record<ScriptStatus, string> = {
  pass: "✓",
  skip: "⊘",
  fail: "✗",
  vacuous: "∅",
};

/** One line per file + an explicit pass/skip/vacuous/fail tally. Skips and
 * vacuous runs are SHOWN, never folded into "passed" — a `⊘ SKIPPED` is loud,
 * not a silent green, and so is a file that verified nothing. */
export function formatScriptSummary(
  results: readonly ScriptRunResult[],
): string {
  const lines = results.map((r) => {
    if (r.status === "skip") return `  ⊘ ${r.file} — SKIPPED`;
    if (r.status === "fail") return `  ✗ ${r.file} (exit ${String(r.code)})`;
    if (r.status === "vacuous") {
      return `  ${MARK.vacuous} ${r.file} — 0 CHECKS (it ran clean and verified nothing)`;
    }
    return `  ${MARK.pass} ${r.file}`;
  });
  const n = (s: ScriptStatus): number =>
    results.filter((r) => r.status === s).length;
  const parts = [`${String(n("pass"))} passed`];
  if (n("skip") > 0) parts.push(`${String(n("skip"))} skipped`);
  if (n("vacuous") > 0) parts.push(`${String(n("vacuous"))} with 0 checks`);
  if (n("fail") > 0) parts.push(`${String(n("fail"))} failed`);
  lines.push(`\n${parts.join(", ")}.`);
  // Name the remedy where it's read, once — the usual cause is a file that
  // DEFINES tests and never calls them, and the usual second cause is a harness
  // asserting some other way, which the runner cannot see.
  if (n("vacuous") > 0) {
    lines.push(
      `  ∅ = the file loaded vigiles and used none of it. Either nothing ran ` +
        `(an exported test object nobody calls), or it asserts another way — in which ` +
        `case call recordCheck() from vigiles so those count.`,
    );
  }
  return lines.join("\n");
}

/**
 * A `--import` argument that registers the resolver hook without a temp file:
 * a data: URL calling `module.register`. Inline because writing a shim into the
 * user's tree to run their tests would be a side effect the runner has no
 * business having.
 */
function hookImport(hookHref: string): string {
  const src = `import {register} from "node:module";register(${JSON.stringify(hookHref)});`;
  return `data:text/javascript,${encodeURIComponent(src)}`;
}
