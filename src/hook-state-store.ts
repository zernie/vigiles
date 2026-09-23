/**
 * The named-state STORE — the one place on disk a compiled hook's facts live,
 * and the one seam a test seeds them through.
 *
 * `src/core/hook-state.ts` is the pure MODEL of a fact (`record`, `state`,
 * `stateFact`, the key charset). It reads no disk on purpose. This module is the
 * other half: where a fact is written, under what name, and how a reader finds
 * it again. It sits at the composition root rather than in `src/core/` because
 * it touches the filesystem, and rather than in an adapter because nothing here
 * is harness-specific — `.vigiles/state/` is vigiles's own directory on Claude
 * Code, on Codex, and on whatever comes next.
 *
 * ## Why it is a module and not three private functions in `cli.ts`
 *
 * It WAS three private functions in `cli.ts` (`hookStateDir`, `readHookState`,
 * `writeHookState`), exported nowhere and named in no `api-surface/*.api.md`.
 * The consequence is quoted in `docs/compiled-hooks.md` as a reason the hook
 * vocabulary still carries the `experimental_` prefix:
 *
 * > Testing a hook that uses named state is archaeology today. The runtime
 * > derives the store's path from the hook's own location and validates the key
 * > charset, so a test that wants to seed "this fact was recorded four days ago"
 * > must reconstruct a private path. The dogfood repo does exactly that,
 * > hard-coded, and it broke when the facts were renamed.
 *
 * A throttled hook's ONLY interesting behaviour is what it does with an old fact
 * versus a fresh one, so a store nobody can seed is a hook nobody can test. The
 * fix is not a second store for tests — that is the drift this repo's
 * one-detector rule exists to forbid, and a seeder that agrees with a private
 * path derivation only until someone edits the derivation is worth less than
 * nothing, because it fails silently and green. {@link experimental_hookState}
 * is a THIN handle over the SAME {@link writeHookState} / {@link readHookState}
 * / {@link hookStateDir} the live runtime calls; there is no second
 * implementation to keep in step. Same shape as `src/load-hook.ts`, which was
 * lifted out of `cli.ts` for the same reason: the CLI and a test must agree, so
 * they call one function.
 *
 * ## Why the handle is on `vigiles` and NOT on `vigiles/hook`
 *
 * `vigiles/hook` is the closed authoring vocabulary, and `checkHookImports`
 * makes it the ONLY import a compiled hook may have. Its guarantee — stated at
 * the top of `core/hook-state.ts` — is that a hook "cannot touch the filesystem:
 * `record()` returns a VALUE… this API hands out no writer". Exporting a store
 * writer there would hand out exactly that writer, to exactly the code the
 * guarantee is about. So the seeding handle lives on the `vigiles` TEST root,
 * beside `runHook`, `loadHook` and the `assertHook*` helpers, where a test can
 * reach it and a hook cannot.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { sha256short } from "./core/hash.js";
import {
  HookStateError,
  durationSeconds,
  record,
  state,
  stateFact,
  type Duration,
  type StateEntry,
  type StateFact,
  type StateWrite,
} from "./core/hook-state.js";
import { normalizeHookRef } from "./hook-install.js";
import {
  HOOK_STATE_DIR,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "./local-files.js";

/**
 * The directory a hook's recorded facts live in — the SCOPE of `state()`/`record()`.
 *
 * Derived from the hook's own location and never from anything the hook said, so
 * a key cannot address another owner's store: hooks shipped in the same directory
 * share their facts (the requirement — one hook records, another reads), a
 * vendored plugin's hooks get their own. The layout MIRRORS the hook's directory
 * rather than slugging it, which keeps it injective and lets a human debugging a
 * hook find the fact by walking the path they already know:
 *
 *   .claude/hooks/calendar-sync-record.hook.ts
 *     → .vigiles/state/.claude/hooks/calendar.synced.json
 *
 * A hook outside the project (an absolute path elsewhere) falls back to a hash of
 * its directory: still stable and still isolated, just not readable — which is the
 * right trade for a case that should not happen in a project's own harness.
 */
export function hookStateDir(file: string, cwd = process.cwd()): string {
  const dir = dirname(resolve(cwd, file));
  const rel = relative(cwd, dir);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return resolve(
    cwd,
    VIGILES_DIR,
    HOOK_STATE_DIR,
    inside ? rel : `external-${sha256short(dir)}`,
  );
}

/** Read one recorded fact for a hook, or `null` if it was never recorded. */
export function readHookState(
  file: string,
  key: string,
  cwd = process.cwd(),
): StateEntry | null {
  try {
    const raw = readFileSync(
      resolve(hookStateDir(file, cwd), key + ".json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as StateEntry;
    return typeof parsed.value === "string" && typeof parsed.at === "string"
      ? parsed
      : null;
  } catch {
    // Never recorded, unreadable, or corrupt — all "no fact", which `stateFact`
    // turns into an infinite age, so the reading hook SPEAKS. Failing toward
    // noise is the whole point; a store problem must never look like freshness.
    return null;
  }
}

/** Options for {@link writeHookState}. */
export interface WriteHookStateOptions {
  /** The project root the store hangs off. Default `process.cwd()`. */
  readonly cwd?: string;
  /**
   * The instant to stamp. Default: now.
   *
   * The runtime never passes this — a fact it records happened just now, by
   * definition. It exists for {@link experimental_hookState}'s `seed`, which
   * must be able to write "four days ago" for a throttle test to have anything
   * to test. Threading it through the REAL writer rather than letting a test
   * build its own entry is what keeps the two in step.
   */
  readonly at?: Date;
}

/**
 * Record one fact. Atomic: written to a temp file in the same directory and
 * `rename()`d over, so a concurrent reader sees the whole old entry or the whole
 * new one — never one write's value with another's timestamp. Distinct keys are
 * distinct files and never interact at all.
 */
export function writeHookState(
  file: string,
  w: StateWrite,
  opts: WriteHookStateOptions = {},
): void {
  const cwd = opts.cwd ?? process.cwd();
  const dir = hookStateDir(file, cwd);
  const target = resolve(dir, w.name + ".json");
  const entry: StateEntry = {
    value: w.value,
    at: (opts.at ?? new Date()).toISOString(),
    by: normalizeHookRef(file, cwd),
  };
  mkdirSync(dir, { recursive: true });
  ensureLocalFilesIgnored(resolve(cwd, VIGILES_DIR));
  const tmp = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, target);
}

/**
 * Forget the facts THIS hook recorded, leaving a co-located hook's alone.
 *
 * The store is keyed by DIRECTORY, not by file, and deliberately so: that
 * sharing is what lets one hook declare `state("calendar.synced")` and read a
 * fact another hook in the same folder recorded. So "delete the directory" and
 * "forget this hook's facts" are different operations, and the recursive
 * delete this replaced was the wrong one — a test following the documented
 * `st.clear()` opener reset every co-located hook, and two tests seeding
 * different hooks in one directory erased each other.
 *
 * Ownership is {@link StateEntry.by}, which {@link writeHookState} stamps from
 * the hook's own path. It is the SAME derivation {@link hookStateDir} uses
 * (`resolve` then `relative`), so a handle built with a relative spelling and a
 * runtime invoked with an absolute one agree — verified against the live
 * runtime in both directions in the colocated test, because a scope that only
 * matched the writer a test happens to use would fail silently and green.
 *
 * An entry we cannot READ, or one carrying no `by` at all, is left in place:
 * every write this module performs stamps an owner, so an unattributed entry
 * was written by something else, and deleting it is exactly the collateral
 * damage being removed here. It reads back as another owner's fact — seed over
 * it, or point `cwd` at a throwaway root when a completely empty store is what
 * the test wants.
 *
 * The directory itself is left behind, possibly empty. Removing it would race
 * a concurrent test writing into the same shared directory, which is the class
 * of interference this function exists to stop.
 */
function clearOwnState(file: string, cwd: string): void {
  const dir = hookStateDir(file, cwd);
  const mine = normalizeHookRef(file, cwd);
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Nothing was ever recorded here — the documented no-op.
    return;
  }
  for (const name of entries) {
    // A torn `<key>.json.<pid>.tmp` from an interrupted write is not an entry.
    if (!name.endsWith(".json")) continue;
    const path = resolve(dir, name);
    let owner: string | undefined;
    try {
      owner = (JSON.parse(readFileSync(path, "utf-8")) as StateEntry).by;
    } catch {
      continue;
    }
    if (owner === mine) rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The test seam.
// ---------------------------------------------------------------------------

/**
 * Options for {@link HookStateHandle.seed}.
 *
 * Spelled out as a three-way union rather than `{value} & SeedWhen` so the whole
 * type is IN this declaration: a public signature that names a type a consumer
 * cannot import is a surface you can read but not write against. The union is
 * also what makes `{ ago, at }` — two disagreeing answers to "when" — a tsc
 * error; `seedInstant` throws on it as well, because harness tests are `.mjs`
 * and a type does not run there.
 */
export type SeedStateOptions =
  /** Recorded that long ago — the reason this exists (a throttle needs an OLD fact). */
  | {
      readonly value?: string;
      readonly ago: Duration;
      readonly at?: never;
    }
  /** Recorded at exactly this instant. */
  | {
      readonly value?: string;
      readonly at: Date;
      readonly ago?: never;
    }
  /** Recorded just now. */
  | {
      readonly value?: string;
      readonly ago?: never;
      readonly at?: never;
    };

/**
 * A handle on ONE hook's recorded facts — what {@link experimental_hookState}
 * returns. Every method goes through the runtime's own store functions, so a
 * seeded fact is indistinguishable from one the hook recorded itself.
 */
export interface HookStateHandle {
  /**
   * Where this hook's facts live. Exposed for a failure message ("no fact under
   * …"), NOT as a path to build on — build on it and you are back to the
   * hard-coded private path this handle exists to retire.
   */
  readonly dir: string;
  /**
   * Write a fact as if the hook had recorded it, then read it back through the
   * real reader — so what you get is exactly what the hook will see, and a write
   * that did not land cannot be mistaken for one that did.
   *
   * `ago` is the reason this exists: a throttle is only interesting against an
   * OLD fact, and "old" is not something a test can produce by waiting.
   *
   * ```js
   * const st = experimental_hookState(".vigiles/hooks/nag.mjs", { cwd });
   * st.seed("retro.nagged", { ago: "4d" });   // → the hook speaks
   * st.seed("retro.nagged", { ago: "10m" });  // → the hook stays quiet
   * ```
   */
  seed(key: string, opts?: SeedStateOptions): StateFact;
  /**
   * Read a fact exactly as the hook's `e.ctx[key]` would — same `recorded` /
   * `ageSeconds` / `fresherThan`. Never-recorded reads back as the total
   * `Infinity` fact rather than throwing, because that is what the hook sees.
   *
   * Also the cheap way to drive the IN-PROCESS tier: the value it returns is a
   * `StateFact`, which is what `runHookProgram(hook, event, ctx)` wants in `ctx`.
   */
  read(key: string): StateFact;
  /**
   * Forget the facts THIS hook recorded. A no-op when it recorded none.
   *
   * Scoped to this hook's own writes, because the store is shared per DIRECTORY
   * — that sharing is what lets one hook read a fact another recorded — so a
   * co-located hook's facts (and any entry with no recorded owner) are left
   * untouched. When a test wants the whole store empty rather than this hook's
   * share of it, give it a throwaway `cwd`: the store hangs off that root.
   */
  clear(): void;
}

/**
 * Seed and read a compiled hook's named state from a test.
 *
 * @experimental — the store LAYOUT is not a stable contract (this handle exists
 * so you never depend on it), and the hook vocabulary it serves is itself
 * `experimental_`. See `docs/compiled-hooks.md` § Status / pending.
 *
 * Pass the hook file exactly as the wiring names it, and the same `cwd` the hook
 * will run under — the store's location is derived from both, so a handle built
 * with a different root points at a different (empty) store.
 *
 * ```js
 * import { experimental_hookState, runHook } from "vigiles";
 *
 * const st = experimental_hookState(hookFile, { cwd });
 * st.clear();
 * st.seed("retro.nagged", { ago: "4d" });
 * const r = runHook(`npx vigiles hook-runtime run-program ${hookFile}`, event, { cwd });
 * ```
 */
export function experimental_hookState(
  hookFile: string,
  opts: { readonly cwd?: string } = {},
): HookStateHandle {
  const cwd = opts.cwd ?? process.cwd();
  const dir = hookStateDir(hookFile, cwd);
  const read = (key: string): StateFact => {
    // Validate the key the way a hook's `needs` does — one validator, one
    // message. A test that reads `"../settings"` should hear about it, not get
    // a silent never-recorded fact back.
    state(key);
    return stateFact(readHookState(hookFile, key, cwd), Date.now());
  };
  return {
    dir,
    read,
    seed(key, seedOpts = {}) {
      // `record()` is the hook's OWN constructor, so the key charset is checked
      // here by the same code and with the same error a hook would hit.
      const w = record(key, seedOpts.value ?? "");
      writeHookState(hookFile, w, { cwd, at: seedInstant(seedOpts) });
      // Read back through the real reader rather than returning what we meant to
      // write: a seed that did not land must not look like one that did.
      return read(key);
    },
    clear() {
      clearOwnState(hookFile, cwd);
    },
  };
}

/**
 * The instant a seed lands on. The `ago`/`at` exclusion is a type error AND a
 * throw: harness tests are `.mjs` by convention (`dual-language-tests`), so a
 * type-only guard would not run where most of these calls live.
 */
function seedInstant(opts: {
  readonly ago?: Duration;
  readonly at?: Date;
}): Date {
  if (opts.ago !== undefined && opts.at !== undefined) {
    throw new HookStateError(
      `pass either ago or at, not both — "${opts.ago}" and ${opts.at.toISOString()} disagree about when the fact was recorded.`,
    );
  }
  if (opts.at !== undefined) return opts.at;
  if (opts.ago === undefined) return new Date();
  const seconds = durationSeconds(opts.ago);
  if (seconds === null) {
    throw new HookStateError(
      `invalid duration "${opts.ago}" — use <number><s|m|h|d>, e.g. "90s", "30m", "1h", "7d".`,
    );
  }
  return new Date(Date.now() - seconds * 1000);
}
