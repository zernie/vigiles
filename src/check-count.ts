/**
 * vigiles — the CHECK COUNTER: the channel a `*.harness.*` / `*.eval.*` script
 * uses to tell `vigiles test` / `vigiles eval` how much it actually did.
 *
 * 🔴 WHY THIS EXISTS. The runner knew exit codes and nothing else, so a script
 * that ran NOTHING was indistinguishable from one that ran and passed. Measured
 * 2026-08-08 — a file whose entire content is
 *
 *     export default { "never runs": () => assert.equal(1, 2) };
 *
 * imports cleanly, exits 0, and the runner printed `✓ … 1 passed`. The assertion
 * inside it is false; it is never called, because nothing calls an exported
 * object. Not hypothetical: a consumer repo hit it, and now hand-copies a warning
 * into the header of every new harness file — "An earlier version exported a
 * `tests` object; nothing ran and the runner printed ✓" — because the runner
 * could not enforce it. Eight harnesses resting on a comment.
 *
 * This is the same distinction `assertNoWrite` already draws between `undefined`
 * and `[]`: "nobody looked" and "nothing happened" must not print the same.
 *
 * HOW IT REPORTS. `vigiles test` puts a scratch path in `VIGILES_CHECK_COUNT_FILE`
 * before spawning each script; on exit, a script that loaded this module writes
 * its count there. A FILE, not stdout, because the runner inherits stdio so the
 * script's own report streams live — there is no stream left to parse. Not an
 * exit code either: those already carry pass/skip/fail, and overloading one would
 * make a real failure ambiguous.
 *
 * WHAT COUNTS AS A CHECK: an observation vigiles can see the script make — a run
 * through one of the tiers (`runHook`, `runHarnessTest`, `runEval`, …), an
 * in-process compiled-hook decision asserted, or an explicit {@link recordCheck}
 * from a harness that asserts some other way (`node:assert`, a runner's
 * `expect`). Deliberately generous: the question this answers is "did this file
 * exercise the harness at all", and a false "0 checks" against a script that
 * genuinely tested something would be exactly the crying wolf the rest of the
 * tool avoids.
 *
 * WHAT A MISSING COUNT MEANS: nothing at all. A script that never imports
 * `vigiles` cannot report, so the runner sees no file and treats it
 * exactly as before — a plain pass. Silence is the legacy branch, never a
 * verdict; only a count of literally zero is a finding. (The alternative —
 * force-loading this module into every child with `node --import` so silence
 * became impossible — was rejected: it would report `0` for a hand-rolled
 * harness that spawns and asserts entirely on its own, which is a real and
 * blameless way to write one.)
 *
 * ## 2026-08-11 — the channel also carries WHAT was exercised
 *
 * 🔴 THE DEFECT. Coverage answered "is surface X tested?" from a FILE NAME —
 * colocation. Measured on a real repo, `.claude/skills/paper-pipeline/` held six
 * `*.eval.mjs`, exactly one of them about that skill, and the orchestrator scored
 * as covered with no test of its own; an EMPTY `foo.eval.mjs` counts just the
 * same. Every mature ecosystem (`go test -cover`, coverage.py, nyc, tarpaulin)
 * answers that question from EXECUTION and uses the name only to find the file.
 *
 * So the tiers now also record WHICH SURFACE a run went by — a {@link SurfaceProbe}
 * — and this channel carries it out alongside the count. Two properties matter:
 *
 * - **Derived, never declared.** The probe comes from what the tier already knew
 *   it was pointed at: the command string `runScript`/`runHook` executed, the
 *   Skill/hook events in a run's transcript. A field an AUTHOR fills in would be
 *   the retired `vigiles:covers` marker with extra steps — a claim about a test,
 *   made by the person who wrote the test.
 * - **A probe is a REFERENCE, not a verdict.** Resolving `hooks/pre-edit.sh` or
 *   `plugin:argument-arc` to a repo surface needs discovery, which this module
 *   has no business doing inside a user's test process. The runner resolves it
 *   (`coverage-artifact.ts`); anything unresolvable is dropped, never guessed.
 *
 * WIRE FORMAT, and why it is two shapes. A run with no probes writes the bare
 * number it always wrote, byte for byte; only a run with something to say writes
 * JSON (`{"checks":N,"surfaces":[…]}`). Readers accept both — an older runner
 * meeting the JSON form reads "no report", i.e. the legacy branch, which is a
 * plain pass rather than a wrong verdict. Silence stays silence.
 */
import { writeFileSync } from "node:fs";

/**
 * Env var naming the file a script writes its check count to. Set per-script by
 * the runner (`runScripts`), read once here at import.
 */
export const CHECK_COUNT_ENV = "VIGILES_CHECK_COUNT_FILE";

/**
 * The counter lives on the global registry, not in module scope, so two copies
 * of vigiles loaded in one child (a global CLI plus a local dependency, say)
 * share ONE count instead of one copy counting while the other reports zero.
 * The cheap version of that bug is a false "this file verified nothing".
 */
const STATE = Symbol.for("vigiles.check-count");

/**
 * How a tier came to name a surface. Not a strength ranking — a statement of
 * what the machinery went by, so a reader can tell an inference from a sighting:
 *
 * - `command` — the executed command line named a program file (`runScript` /
 *   `runHook`). The strongest kind: that exact path was handed to a process.
 * - `fired` — the surface appears in the RUN'S TRANSCRIPT as having activated (a
 *   `Skill` tool call that resolved, a hook that reported). For a skill this is
 *   the only honest attribution: what was INSTALLED is a set, what RAN is one.
 *
 * There is deliberately NO author-declared origin. A `surface:` field on a spec
 * would be `vigiles:covers` with extra steps — a claim about a test written by
 * whoever wrote the test — and that tier was removed after its first real use
 * declared a conformance lint over 21 skills as coverage of all 21.
 */
export type ProbeOrigin = "command" | "fired" | "dispatched";

/**
 * One surface a run went by. `ref` is whatever the tier saw — a script path, a
 * namespaced skill id (`plugin:skill`), a hook name — NOT a resolved repo path.
 * Resolution happens in the runner, where discovery lives.
 */
export interface SurfaceProbe {
  readonly how: ProbeOrigin;
  readonly ref: string;
}

interface CountState {
  count: number;
  armed: boolean;
  /** Deduped probes, keyed `how\0ref`, in first-seen order. */
  surfaces: Map<string, SurfaceProbe>;
}

function state(): CountState {
  const g = globalThis as unknown as Record<symbol, CountState | undefined>;
  const s = (g[STATE] ??= { count: 0, armed: false, surfaces: new Map() });
  // Two copies of vigiles can share one process (a global CLI plus a local
  // dependency), and the OLDER copy's state object has no `surfaces` at all.
  // Without this, the newer copy's first probe throws inside a user's test run.
  s.surfaces ??= new Map();
  return s;
}

/**
 * Record `n` checks against this script's run.
 *
 * The tiers call it themselves, so an ordinary harness never needs to. Call it
 * directly when you assert some OTHER way — `node:assert`, vitest's `expect`, a
 * hand-rolled comparison — and want those visible to `vigiles test` instead of
 * leaving it to conclude the file did nothing.
 *
 * @public
 */
export function recordCheck(n = 1): void {
  state().count += n;
}

/** How many checks this process has recorded so far. */
export function checksRecorded(): number {
  return state().count;
}

/**
 * Record that this run exercised the surface `ref` names. Called by the TIERS
 * from what they were pointed at — never by a harness author, because a field an
 * author fills in is a claim, not a measurement (that was `vigiles:covers`, and
 * it was removed for exactly this reason).
 *
 * Deduped: a harness that fires the same hook forty times names it once.
 * Empty/blank refs are dropped rather than stored as a surface called "".
 */
export function recordSurfaceProbe(how: ProbeOrigin, ref: string): void {
  const trimmed = ref.trim();
  if (!trimmed) return;
  const s = state();
  const key = `${how}\u0000${trimmed}`;
  if (!s.surfaces.has(key)) s.surfaces.set(key, { how, ref: trimmed });
}

/** The surfaces this process has been seen to exercise, in first-seen order. */
export function surfacesRecorded(): readonly SurfaceProbe[] {
  return [...state().surfaces.values()];
}

/**
 * Reset the counter, the probes AND the armed flag. For vigiles's own tests,
 * which drive {@link armCheckReport} with fakes several times in one process; a
 * harness script has no use for it.
 */
export function resetCheckCount(): void {
  const s = state();
  s.count = 0;
  s.armed = false;
  s.surfaces = new Map();
}

/** What a run reported: how much it did, and what it did it against. */
export interface CheckReport {
  readonly checks: number;
  readonly surfaces: readonly SurfaceProbe[];
}

/**
 * Serialize a report for the scratch file. A run with no probes writes the BARE
 * NUMBER it has always written — byte for byte, so the legacy reader and the
 * legacy tests are describing the same thing they always were. Only a run with
 * an attribution to make spends a JSON object on it.
 */
export function formatCheckReport(report: CheckReport): string {
  if (report.surfaces.length === 0) return String(report.checks);
  return JSON.stringify({ checks: report.checks, surfaces: report.surfaces });
}

/**
 * Parse a scratch file's contents, or `undefined` for anything that is not a
 * report. Lives beside {@link formatCheckReport} so the two cannot drift.
 *
 * Tolerant in exactly one direction: a bare integer is the legacy form and is
 * read as a report with no attribution. Anything malformed — a torn write, a
 * negative, a JSON object with the wrong shape — is NOT a report, because
 * "corrupt" must never be turned into a verdict about someone's tests.
 */
export function parseCheckReport(raw: string): CheckReport | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return { checks: Number(trimmed), surfaces: [] };
  if (!trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as { checks?: unknown; surfaces?: unknown };
  const checks = obj.checks;
  if (typeof checks !== "number" || !Number.isInteger(checks) || checks < 0)
    return undefined;
  const surfaces = Array.isArray(obj.surfaces)
    ? obj.surfaces.map(toProbe).filter((p): p is SurfaceProbe => p !== null)
    : [];
  return { checks, surfaces };
}

/** One serialized probe, or null for anything that isn't one. */
function toProbe(entry: unknown): SurfaceProbe | null {
  if (!entry || typeof entry !== "object") return null;
  const { how, ref } = entry as { how?: unknown; ref?: unknown };
  if (how !== "command" && how !== "fired" && how !== "dispatched") return null;
  if (typeof ref !== "string" || !ref.trim()) return null;
  return { how, ref };
}

/** Injection seam for {@link armCheckReport} — the process bits it needs. */
export interface CheckReportEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly onExit: (fn: () => void) => void;
  readonly write: (path: string, contents: string) => void;
}

/**
 * Arm the exit-time report, returning whether it armed (i.e. whether the runner
 * asked for a count). Pure except for the two effects it is handed.
 *
 * It DELETES the env var after reading it. A harness spawns child processes —
 * that is its whole job — and a child inheriting the path would write ITS count
 * over the parent's on exit, reporting a sub-process's activity as the file's.
 * Reading the variable once and dropping it makes that unrepresentable rather
 * than merely unlikely.
 */
export function armCheckReport(deps: CheckReportEnv): boolean {
  const s = state();
  if (s.armed) return false;
  const file = deps.env[CHECK_COUNT_ENV];
  if (file === undefined || file === "") return false;
  // `Reflect.deleteProperty`, not `delete env[KEY]`: the key is a const, which
  // the lint rules count as a dynamic delete.
  Reflect.deleteProperty(deps.env, CHECK_COUNT_ENV);
  s.armed = true;
  deps.onExit(() => {
    try {
      deps.write(
        file,
        formatCheckReport({
          checks: s.count,
          surfaces: [...s.surfaces.values()],
        }),
      );
    } catch {
      // An unwritable scratch path must never turn a passing harness into a
      // crash on the way out. No count reported = the legacy branch = a pass.
    }
  });
  return true;
}

armCheckReport({
  env: process.env,
  onExit: (fn) => {
    process.on("exit", fn);
  },
  write: (path, contents) => {
    writeFileSync(path, contents);
  },
});
