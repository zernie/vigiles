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
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
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
 * What the runner's load hook saw of one script (`harness-resolve-hooks.mts`).
 *
 * `marked` — the hook saw the script's module as an ES module and planted a
 * marker import at the top of it. `linked` — that marker evaluated, which ESM
 * only does once the WHOLE import graph was found, parsed and linked.
 */
export interface LoadEvidence {
  readonly marked: boolean;
  readonly linked: boolean;
}

/**
 * Classify one script's run from its exit code, its reported check count and
 * what the load hook saw.
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
 *
 * 🔴 DID IT LOAD? A non-zero exit from a script whose module was marked and
 * never linked is did-not-load: `"skip"` with the loader's exit code, which
 * keeps its coverage (`fail` RETRACTS it, see `runsFromResults`). A module that
 * never linked executed no assertion — the same "did not run" as a missing
 * `claude`, arriving through a different door. MEASURED, twice on 2026-08-20: a
 * container restore left an old `node_modules`, every harness in a consumer repo
 * died on `Named export 'recordCheck' not found`, and its ledger fell from 48
 * records to 34 and from 47 to 33 for surfaces nothing had touched. The run is
 * still red: `cli-main.ts` fails on any skip the author did not declare.
 *
 * This used to be decided by grepping the child's OUTPUT for loader phrases,
 * and that was wrong in the dangerous direction (#243): a harness that printed
 * a hook transcript containing "Cannot find module", then failed an assertion,
 * was read as did-not-load and kept its coverage. Output is no longer an input.
 * Anything without a marker (CommonJS, an entry the hook never saw) can never
 * claim did-not-load — it is a `fail`, the side that retracts rather than hides.
 * A syntax error in the script itself also never links, so it too is
 * did-not-load; that is the owner's call, not an accident.
 */
export function statusFor(
  code: number,
  checks: number | undefined,
  load?: LoadEvidence,
): ScriptStatus {
  if (code === SKIP_EXIT_CODE) return "skip";
  if (code !== 0) {
    // A reported count is written by an exit handler that exists only once the
    // module ran (`check-count.ts`), so it overrules a missing marker file.
    const neverLinked =
      load?.marked === true && !load.linked && checks === undefined;
    return neverLinked ? "skip" : "fail";
  }
  return checks === 0 ? "vacuous" : "pass";
}

/**
 * Did this script fail to LOAD — as opposed to declaring a skip (exit 77)?
 * The one predicate behind both the CLI's "never ran" failure and `--min`.
 *
 * Deliberately NOT a fifth `ScriptStatus`: coverage retraction reads the status
 * as a bare string (`coverage-artifact.ts`), so a new member would start
 * retracting silently with no type error.
 */
export function loadFailed(r: ScriptRunResult): boolean {
  return r.status === "skip" && r.code !== SKIP_EXIT_CODE;
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
import { makeTmpDir } from "../../core/tmp-root.js";

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
    // 🔴 `isFile`, not `existsSync`: a DIRECTORY exists too. `vigiles test .`
    // therefore passed `.` through as a script, `spawn("node", ["."])` died with
    // Node's `ERR_UNSUPPORTED_DIR_IMPORT` stack, and the classifier downstream
    // read that stack as "did not load" — a crash reported as a skip, exit 0.
    // A directory now contributes no files, so the caller's own loud
    // nothing-matched path owns the message (see `cli-main.ts`).
    if (statSync(resolve(cwd, p), { throwIfNoEntry: false })?.isFile()) {
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
    // 🔴 `nodir: true` for the same reason as the `isFile` guard above, and the
    // guard alone was NOT enough — caught by its own test. A pattern that names
    // an existing directory (`sub`, `.`) skips the fast path and then comes back
    // out of the globber, because a directory matches a glob perfectly well.
    // Asked of the globber rather than filtered afterwards: it already knows.
    for (const m of globSync(p, {
      cwd,
      ignore: [...ignore],
      dot: true,
      nodir: true,
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

/**
 * What the load hook left behind for one child. A missing or malformed
 * `seenFile` means the hook never saw the script, so `marked` is false and the
 * run can never be read as did-not-load.
 */
function readLoadEvidence(seenFile: string, loadedFile: string): LoadEvidence {
  return { marked: readMarked(seenFile), linked: existsSync(loadedFile) };
}

function readMarked(seenFile: string): boolean {
  try {
    const seen = JSON.parse(readFileSync(seenFile, "utf8")) as {
      marked?: unknown;
    };
    return seen.marked === true;
  } catch {
    return false;
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
  const countDir = makeTmpDir("checks");

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
      const seenFile = join(countDir, `${String(i)}.seen`);
      const loadedFile = join(countDir, `${String(i)}.loaded`);
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
      // 🔴 OUR HOOK IS REGISTERED BEFORE `--import tsx`, and the order is
      // load-bearing. Hooks chain last-in-first-out, so this makes tsx the
      // OUTER hook: it transpiles the source we already marked, and its source
      // map describes that source. The other order was measured wrong: tsx
      // emits each module on ONE line with an inline map, a prefix added after
      // it shifts every generated column, and a stack frame on line 2 was
      // reported on line 3 (Node 20.20 and 22.22). The format we see from the
      // inner position is the same (`module` in a `type: module` scope,
      // `commonjs` otherwise — also measured).
      const probe = {
        entryURL: scriptURL(cwd, file),
        loadedFile,
        seenFile,
      };
      const child = spawn(
        "node",
        ["--import", hookImport(hook, probe), ...argv],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ...env,
            VIGILES_SELF_ROOT: selfRoot,
            [CHECK_COUNT_ENV]: countFile,
          },
        },
      );
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
          status: statusFor(
            code,
            report?.checks,
            readLoadEvidence(seenFile, loadedFile),
          ),
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
 * A `--import` argument that registers the harness hooks without a temp file:
 * a data: URL calling `module.register`. Inline because writing a shim into the
 * user's tree to run their tests would be a side effect the runner has no
 * business having. The per-child probe rides in `data`, not the environment,
 * so a process the script spawns does not inherit it.
 */
function hookImport(hookHref: string, probe: object): string {
  const src = `import {register} from "node:module";register(${JSON.stringify(hookHref)},{data:${JSON.stringify(probe)}});`;
  return `data:text/javascript,${encodeURIComponent(src)}`;
}

/**
 * The URL Node will load the SCRIPT under — for `eval` too, where the process
 * entry is `eval-entry.js` and the script is what it imports. ESM resolution
 * realpaths file URLs, so a symlinked path must be realpathed here or the hook
 * would never recognise it (which is safe — no marker, no did-not-load claim —
 * but blind).
 */
function scriptURL(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  try {
    return pathToFileURL(realpathSync(abs)).href;
  } catch {
    return pathToFileURL(abs).href;
  }
}
