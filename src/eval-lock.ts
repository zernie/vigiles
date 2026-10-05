/**
 * vigiles — the eval LOCK (the CI staleness gate for evals run on a subscription).
 *
 * Real-model evals authenticate as your own `claude` CLI on your Claude
 * subscription, so they only run **locally** — never in CI (no metered key, and
 * the subscription can't be driven from a headless runner). That leaves a hole:
 * how does CI know the committed eval numbers still match the current inputs?
 * Someone edits a skill, forgets to re-eval, and ships stale results.
 *
 * The lock closes it with an **integrity hash**, NOT a cache. The two are
 * different mechanisms and must not be confused:
 *
 *   - the eval CACHE ({@link ./eval-cache}) is a LOCAL speed optimization
 *     (gitignored, keyed store, skips the model call when re-scoring `measure`);
 *   - the eval LOCK is a COMMITTED staleness stamp (`.vigiles/eval-locks/<slug>.lock.json`),
 *     reviewed in the git diff, checked in CI without ever touching the model.
 *
 * It is the snapshot/lockfile pattern (`Cargo.lock` + `npm ci`; `jest --ci` /
 * `cargo-insta`): you produce numbers locally with `--update`, commit the lock,
 * and CI runs `--check` — recompute the input hash, compare, and fail "stale,
 * re-run `--update`" on a mismatch. The committed diff of `recall: 0.90 → 0.65`
 * IS the quality gate a human reviews. The same integrity-hash-of-inputs idea
 * vigiles already ships in `core/integrity.ts` (compiled markdown) and
 * `core/sidecar.ts` (spec inputs), applied a third time to eval results.
 *
 * Honest scope (no fiction): the lock promises "your committed results match your
 * current inputs," NOT "your results reflect current model behavior." Model /
 * harness drift is only caught when YOU re-run `--update` locally — there is no
 * automated live run, by design. The clean split that makes replay sound: the
 * lock stores only the model's OBSERVED BEHAVIOR (the report); the script's own
 * assertions (`assertTriggerRate` / `assertSignificant`) re-run live against the
 * replayed report, so a threshold-only edit is a valid replay (no model call)
 * while an input change is stale. See `research/cache-invalidation.md`.
 *
 * Pure + model-free (the only side effects are the two small fs helpers); the
 * inputs hash reuses `canonical` from `eval-cache.ts` so the lock and the cache
 * canonicalize identically.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { sha256short, type SHA256Hash } from "./core/hash.js";
import { canonical } from "./eval-cache.js";
import { isEvalScript } from "./source-kinds.js";

/** Lock mode: never touch the lock / verify-only (CI) / record-and-write (local). */
export type LockMode = "off" | "check" | "update";

/**
 * Per-spec lock overrides (additive on `EvalSpec`/`TriggerRateSpec`). Normally the
 * mode comes from the CLI (`eval --check`/`--update` → `VIGILES_EVAL_LOCK`) and
 * the dir/epoch from defaults/config; set these to drive the lock programmatically
 * (or to point a test at a throwaway dir). Each field falls back to its env/default.
 */
export interface EvalLockOptions {
  /** Override the lock mode (else `VIGILES_EVAL_LOCK`, else `off`). */
  readonly mode?: LockMode;
  /** Override the lock directory (else `<cwd>/.vigiles/eval-locks`). */
  readonly dir?: string;
  /** Override the behavior epoch (else `VIGILES_EVAL_API_VERSION`, else 1). */
  readonly evalApiVersion?: number;
}

/**
 * On-disk lock-format version, salted into nothing (the lock is keyed by name,
 * not by hash) but VALIDATED on read so an incompatible shape fails loud rather
 * than deserializing into a stale structure. Bump on a breaking shape change.
 */
export const LOCK_VERSION = 1;

/** Default directory for committed eval locks (tracked, NOT gitignored). */
export const DEFAULT_LOCK_DIR = ".vigiles/eval-locks";

/**
 * The model-affecting inputs hashed into a lock's `inputsHash`. Everything here
 * is something that, if it changes, means the recorded model behavior is stale
 * and you MUST re-drive the model (→ subscription → local). Deliberately EXCLUDED:
 * the scoring `measure`/assertions (re-run live against the replayed report), the
 * trial count (a sample-size knob, not a behavior input), and per-run env noise.
 */
export interface EvalLockInputs {
  /** Model id used (folded in; a floating alias can't detect weight drift — warned). */
  readonly model: string;
  /**
   * Reasoning budget (`--effort`) the run was pinned to, or undefined for the
   * harness default. Hashed because it steers the model — the criterion this
   * interface already states — so a committed report recorded at one effort is
   * STALE for a run at another. `undefined` is dropped by `JSON.stringify`, so
   * locks committed before effort existed keep their hash and still replay.
   *
   * Caveat kept honest: "omitted" means the harness's own default, which is
   * per-model and can move between builds — reproducible only modulo that, the
   * same class of provenance caveat as `harnessVersion` below.
   */
  readonly effort?: string | number;
  /**
   * A hand-bumped behavior epoch the project owns (`.vigilesrc.json`
   * `eval.apiVersion`), bumped when a harness-side change YOU made (a CLAUDE.md
   * edit, a global hook) would shift eval outputs but isn't otherwise in the
   * inputs. The escape hatch for "force a re-eval."
   */
  readonly evalApiVersion: number;
  /**
   * The seam-specific canonical input object — the tasks/prompts/files/settings/
   * sorted-tools/pluginDirHash/serialized-checks that steer the model. Assembled
   * by each entry point (it knows its own shape) and hashed opaquely here.
   */
  readonly inputs: unknown;
}

/**
 * Why the harness binary version is **NOT** hashed (only recorded as provenance):
 * `--check` runs in CI where `claude` is PINNED to a fixed version, while a dev's
 * local `claude` is whatever they have — folding the version into the hash would
 * false-trip `--check` on every PR where those differ. It is also the lock's
 * honest scope: the gate verifies your committed results match your current
 * *author-controlled inputs*, not current model/harness behavior (there is no
 * automated live run). Harness/model drift is caught when YOU re-run `--update`
 * locally and review the moved numbers in the git diff. Keeping the version out
 * of the hash is what lets `--check` stay binary-free + deterministic in CI.
 * (The eval CACHE still keys on it — that's local replay soundness, a different
 * axis.) See research/cache-invalidation.md.
 */

/** Deterministic content hash of a lock's model-affecting inputs. */
export function evalInputsHash(input: EvalLockInputs): SHA256Hash {
  return sha256short(JSON.stringify(canonical(input)));
}

/** A committed eval lock: the integrity stamp + the replayable recorded report. */
export interface EvalLock {
  readonly version: number;
  /** The eval's report name (human-facing; also the lock filename slug source). */
  readonly name: string;
  /** Hash of the model-affecting inputs ({@link evalInputsHash}). */
  readonly inputsHash: string;
  /** The model id the report was produced against (for the drift warning). */
  readonly model: string;
  /**
   * The effort the report was produced at, or undefined for the harness default
   * (provenance; already in the hash). Recorded because the complaint that
   * motivated effort support was not only that it could not be SET — it was that
   * nothing in the run record said which effort produced the numbers.
   */
  readonly effort?: string | number;
  /** The harness version token at record time (provenance; already in the hash). */
  readonly harnessVersionKey: string;
  /** The behavior epoch at record time (provenance; already in the hash). */
  readonly evalApiVersion: number;
  /** ISO-8601 timestamp the lock was recorded (provenance; NOT in the hash). */
  readonly builtAt: string;
  /**
   * The entry point's recorded report — the model's observed behavior, REPLAYED
   * verbatim on `--check` so the script's own assertions judge it. Stored as the
   * exact return type of the entry point (`EvalReport` / `TriggerRateReport` /
   * `CheckReport`) so replay is transparent to the caller.
   */
  readonly report: unknown;
}

/** Filesystem-safe slug for a report name (the lock filename). */
export function lockSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "eval";
}

/** Path to a named eval's lock file under `dir`. */
export function lockPath(dir: string, name: string): string {
  return join(dir, `${lockSlug(name)}.lock.json`);
}

/**
 * Read a named eval's lock. A MISS (no file) returns `null`. A CORRUPT or
 * wrong-version file **throws** — a broken lock is a real failure the CI gate
 * must surface, not silently treat as "no lock" (which would let a stale eval
 * pass). The message says how to recover.
 */
export function readLock(dir: string, name: string): EvalLock | null {
  const path = lockPath(dir, name);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `eval lock: corrupt lock ${path} (invalid JSON) — delete it and re-run \`vigiles eval --update\``,
    );
  }
  if (typeof data !== "object" || data === null)
    throw new Error(`eval lock: ${path} is not a JSON object`);
  const obj = data as Record<string, unknown>;
  if (obj.version !== LOCK_VERSION)
    throw new Error(
      `eval lock: ${path} has unsupported version ${String(obj.version)} ` +
        `(expected ${String(LOCK_VERSION)}) — re-run \`vigiles eval --update\``,
    );
  // Slug collision guard: two distinct names can normalize to the same file
  // (`foo/bar` and `foo bar` → `foo-bar.lock.json`). A lock whose stored `name`
  // differs from the one requested belongs to the OTHER eval — treat it as a
  // MISS (not this eval's lock) so `--check` degrades to "stale → re-run" and
  // NEVER replays the wrong eval's report. The stored name is the source of truth.
  if (obj.name !== name) return null;
  return obj as unknown as EvalLock;
}

/**
 * Whether ANY lock has been committed under `dir`. The CI staleness gate
 * (`eval --check`) uses this to stay a NO-OP until the feature is in use: a repo
 * that has never run `eval --update` has no locks, so there is nothing to verify
 * and CI passes green. Once the first lock is committed, every named eval is held
 * to having a fresh one (a new unlocked eval then reads as stale). The graduated,
 * opt-in-by-committing behavior that keeps a fresh `init` from going red.
 */
export function anyLocksCommitted(dir: string): boolean {
  return countLocks(dir) > 0;
}

/**
 * How many locks are committed under `dir` — 0 when the dir does not exist.
 *
 * No try/catch around the read: `anyLocksCommitted` never had one, and adding a
 * branch here that no test can reach would trade a real coverage line for a
 * defensive case the caller already survives (an unreadable `.vigiles/` is a
 * broken checkout, not a state this counter should paper over).
 */
export function countLocks(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".lock.json")).length;
}

/**
 * Does an edited path plausibly change an eval's INPUTS — so a committed lock may
 * now be stale? Two surfaces feed the hash: a skill's trigger surface (`SKILL.md`)
 * and the eval script that holds the prompts/spec (`*.eval.{mjs,cjs,js,mts,cts,ts}`).
 * Pure (string-only) so the nudge hook stays cheap and never runs an eval script.
 */
export function isEvalInputFile(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)SKILL\.md$/.test(p)) return true;
  return isEvalScript(p.split("/").pop() ?? "");
}

/**
 * The NON-BLOCKING nudge to emit after an eval-input edit when committed locks
 * exist, or `null` for no nudge. Self-gating: it stays silent until you've opted
 * into the lock (committed one), so it can't annoy a repo that doesn't use evals.
 * It deliberately does NOT recompute staleness (that needs the eval script + is
 * the job of `eval --check`) — a reminder, not a gate. The honest harness-neutral
 * reminder; how it reaches the agent (both CC and Codex inject `additionalContext`
 * on `PostToolUse`) is the caller's concern. See docs/harness-testing-*.md.
 */
export function evalLockNudge(
  filePath: string,
  lockDir: string,
): string | null {
  if (!isEvalInputFile(filePath)) return null;
  if (!anyLocksCommitted(lockDir)) return null;
  return (
    `vigiles: you edited ${filePath}, which can change an eval's inputs — a ` +
    `committed eval lock may now be stale. When you're done, run ` +
    `\`vigiles eval --update\` (local, on your subscription) and commit the ` +
    `updated lock; CI's \`vigiles eval --check\` will otherwise flag it stale. ` +
    `This is a reminder, not a block.`
  );
}

/** Write a named eval's lock (pretty JSON for a reviewable git diff). */
export function writeLock(dir: string, lock: EvalLock): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir, lock.name), JSON.stringify(lock, null, 2) + "\n");
}

/**
 * Build a fresh lock envelope from a just-recorded report (the `--update` write).
 * `builtAt` is passed in (never read from the clock here) so the module stays
 * pure + deterministically testable; the CLI stamps the real timestamp.
 */
export function buildLock(args: {
  readonly name: string;
  readonly inputsHash: string;
  readonly model: string;
  readonly effort?: string | number;
  readonly harnessVersionKey: string;
  readonly evalApiVersion: number;
  readonly builtAt: string;
  readonly report: unknown;
}): EvalLock {
  return { version: LOCK_VERSION, ...args };
}

/** What the lock layer decides an entry point should do for this run. */
export type LockDecision =
  /** Drive the model normally (mode `off`, or `update`, or `check` with no lock-skip). */
  | { readonly kind: "run" }
  /** `check` + a matching fresh lock → return the recorded report, NO model call. */
  | { readonly kind: "replay"; readonly report: unknown }
  /** `check` + a missing/stale lock → fail; the caller throws `reason`. */
  | { readonly kind: "stale"; readonly reason: string };

/**
 * Decide what `check` mode should do given the current input hash and the
 * committed lock. `off`/`update` always `run` (update records afterwards). `check`
 * replays a matching lock (no model) and is `stale` on a missing lock or a hash
 * mismatch — the deterministic CI gate.
 */
export function decideLock(
  mode: LockMode,
  name: string,
  currentHash: string,
  existing: EvalLock | null,
): LockDecision {
  if (mode !== "check") return { kind: "run" };
  if (!existing)
    return {
      kind: "stale",
      reason:
        `eval lock missing for "${name}" — no committed results to verify against. ` +
        `Run \`vigiles eval --update\` locally (on your subscription) and commit the lock.`,
    };
  if (existing.inputsHash !== currentHash)
    return {
      kind: "stale",
      reason:
        `eval lock STALE for "${name}" — the inputs changed since the committed results ` +
        `were recorded (skill/prompts/model/harness/apiVersion). Re-run ` +
        `\`vigiles eval --update\` locally and commit the updated lock.`,
    };
  return { kind: "replay", report: existing.report };
}

/** A single numeric leaf that moved between the prior lock and a fresh `--update`. */
export interface NumberDelta {
  readonly path: string;
  readonly before: number;
  readonly after: number;
}

/**
 * Collect the numeric leaves that changed between two recorded reports — the
 * human-facing delta printed at `--update` time (e.g. `rate: 0.900 → 0.650`).
 * Generic over any report shape (walks numbers by dotted path), so it works for
 * `EvalReport`, `TriggerRateReport`, and `CheckReport` without per-type code. The
 * committed git diff is the primary review surface; this is the at-a-glance echo.
 */
export function diffReportNumbers(
  before: unknown,
  after: unknown,
): NumberDelta[] {
  const out: NumberDelta[] = [];
  walkNumberLeaves(before, after, "", out);
  return out;
}

function walkNumberLeaves(
  a: unknown,
  b: unknown,
  path: string,
  out: NumberDelta[],
): void {
  if (typeof a === "number" && typeof b === "number") {
    if (a !== b) out.push({ path, before: a, after: b });
  } else if (Array.isArray(a) && Array.isArray(b)) {
    walkArrayLeaves(a, b, path, out);
  } else if (isRecord(a) && isRecord(b)) {
    walkRecordLeaves(a, b, path, out);
  }
}

function walkArrayLeaves(
  a: readonly unknown[],
  b: readonly unknown[],
  path: string,
  out: NumberDelta[],
): void {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++)
    walkNumberLeaves(a[i], b[i], `${path}[${String(i)}]`, out);
}

function walkRecordLeaves(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  path: string,
  out: NumberDelta[],
): void {
  for (const k of Object.keys(a))
    if (k in b) walkNumberLeaves(a[k], b[k], path ? `${path}.${k}` : k, out);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Render the `--update` result for a human: NEW lock, or the per-number deltas. */
export function formatLockUpdate(
  name: string,
  deltas: readonly NumberDelta[],
  isNew: boolean,
): string {
  if (isNew) return `eval lock: recorded NEW lock for "${name}"`;
  if (deltas.length === 0)
    return `eval lock: "${name}" updated — no numeric change vs the prior lock`;
  const lines = [
    `eval lock: "${name}" updated — ${String(deltas.length)} value(s) moved:`,
  ];
  for (const d of deltas) {
    const dir = d.after > d.before ? "▲" : "▼";
    lines.push(
      `  ${dir} ${d.path}: ${d.before.toFixed(3)} → ${d.after.toFixed(3)}`,
    );
  }
  lines.push(
    "  review the committed lock diff — this is the eval quality gate.",
  );
  return lines.join("\n");
}

/**
 * Read the lock mode from the environment (`VIGILES_EVAL_LOCK`), set by the CLI's
 * `eval --check` / `--update` flags. A run knob (like `VIGILES_TRIALS`): the CLI
 * is the only place that should set it. Anything unrecognized → `off`.
 */
export function lockModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LockMode {
  const v = env.VIGILES_EVAL_LOCK;
  return v === "check" || v === "update" ? v : "off";
}

/**
 * The behavior epoch (`evalApiVersion`) for this run, read from the env the CLI
 * populates from `.vigilesrc.json` `eval.apiVersion`. Default 1. A malformed
 * value falls back to 1 (never throws) — the lock stays usable.
 */
export function evalApiVersionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.VIGILES_EVAL_API_VERSION;
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}
