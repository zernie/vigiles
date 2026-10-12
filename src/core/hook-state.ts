/**
 * RUNTIME-OWNED NAMED STATE — the one thing a compiled hook could not do.
 *
 * ## In one sentence
 *
 * A hook names a fact; the runtime stores it; any hook in the same directory can
 * declare that name in `needs` and read it back with its age.
 *
 * There is no "and also". Throttling is not a second feature — it is this one,
 * used twice: a hook records the fact that it spoke, and reads that fact's age
 * before speaking again. See "Why there is no `throttle:` field" below, which is
 * the design's load-bearing decision and the one a reader should challenge first.
 *
 * ## The hole it fills, measured
 *
 * `hook-script-exists` says a hook should be a typed program the compiler can
 * check. In the knowledge base this repo dogfoods on, ALL SEVEN advisory hooks
 * were still hand-written shell (measured 2026-08-12), and the reason was uniform:
 * every one of them both READS and WRITES a stamp file.
 *
 *   calendar-heartbeat    reads .cal-last-sync + .cal-last-nag   writes .cal-last-nag
 *   calendar-sync-record  —                                      writes .cal-last-sync
 *   merge-nudge           reads stamp + branch age               writes stamp
 *   paper-status-gates    reads status lines                     writes —
 *   retro-nudge           reads clock + git log                  writes stamp
 *   scratchpad-guard      reads artifact mtimes                  writes stamp
 *   vigiles-check         reads last report                      writes report + stamp
 *
 * The vocabulary could express the READ (`needs` → `e.ctx`) and could express a
 * WRITE only by shelling out through a react's `run()` — which hands the hook a
 * subprocess to get a timestamp into a file. So "remind at most once an hour" was
 * inexpressible, and seven hooks stayed shell.
 *
 * ## What is UNREPRESENTABLE afterwards, and what is merely legible
 *
 * The product's claim is "remove the capability, don't catch its misuse", so the
 * honest accounting has two columns.
 *
 * Gone by construction — a hook CANNOT:
 *   - touch the filesystem. `record()` returns a VALUE. The hook's return type is
 *     data; the trusted runtime performs the write. `checkHookImports` still
 *     rejects every import but `vigiles/hook`, and this API hands out no writer.
 *   - name another owner's state. Namespaces are not in the vocabulary at all —
 *     {@link StateWrite} and {@link StateNeed} carry a KEY and nothing else, and
 *     the runtime derives the namespace from the hook's own path. There is no
 *     string a hook can pass to reach a sibling plugin's store.
 *   - escape its namespace through the key. {@link isValidStateKey} admits
 *     `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and nothing else, so `../`, `/`, `.`,
 *     `..` and the reserved `@` are all unspellable, and {@link record} THROWS on
 *     a bad key rather than returning a value that fails later.
 *   - read a fact it did not declare — inherited from `needs`/`HookCtx`: an
 *     undeclared key is a `tsc` error, not an empty string at runtime.
 *   - silence itself by never having run. The freshness reads are TOTAL over
 *     "never recorded" (see the `Infinity` note on {@link StateFact.ageSeconds}).
 *
 * Legible but still possible — a hook CAN:
 *   - record a fact under a name that misdescribes what happened. Nothing in a
 *     runtime can decide whether "the calendar was really synced"; that is a
 *     claim about the world. What the design guarantees is narrower and is the
 *     property that was actually missing: **the framework never writes a fact on
 *     its own initiative.** Every entry in the store exists because some hook's
 *     source contains a `record("that-name")` at a site a reader can point at,
 *     and the entry records WHICH hook wrote it ({@link StateEntry.by}). Under
 *     the old shell design and under any automatic-stamp design, the write is
 *     implicit and there is no such site.
 *
 * ## Why there is no `throttle:` field
 *
 * A throttle field was the obvious shape and it was designed first: `throttle:
 * "1h"`, the runtime reads a hidden stamp, skips while fresh, updates on emit.
 * Two measurements killed it.
 *
 * 1. IT CHANGES BEHAVIOUR THE HOOKS DEPEND ON. An automatic stamp can only be
 *    written at one place — where the runtime sees the hook emit. Of the five
 *    hooks that want throttling, `scratchpad-guard` stamps BEFORE its own
 *    threshold test (it marks "I looked" at line 25 and only decides whether to
 *    speak at line 43), so an emit-triggered stamp silently converts "check
 *    hourly" into "check every turn until something is worth saying". The write
 *    site is a design decision per hook; a field takes it away.
 *
 * 2. IT IS THE EXACT DEFECT THIS FEATURE EXISTS TO RETIRE. The knowledge base ran
 *    a single automatic stamp for months: `calendar-heartbeat` wrote it at print
 *    time, so an IGNORED reminder silenced itself for an hour and a skipped sync
 *    became indistinguishable from a completed one. Cost, from that repo's own
 *    record: 28 unclosed events and six blank calendar days behind a hook that
 *    was firing correctly the entire time. The fix that repo reached for was to
 *    split the stamp in two and add a SECOND hook whose only job is to write the
 *    "it really happened" one. A `throttle:` field would have re-manufactured the
 *    stamp whose meaning was wrong, given it no name, and made it the ergonomic
 *    default.
 *
 * So the two meanings of a stamp stay apart the only way that survives contact:
 * BOTH are named, and neither is automatic. "I spoke at T" is
 * `record("retro.nagged")` written on the branch that speaks. "The work happened
 * at T" is `record("calendar.synced")` written by the hook that WATCHED the work
 * — a different hook, on a different event. A reader can see which is which by
 * reading the name and the site; a framework-manufactured stamp offers neither.
 *
 * The cost is one line per throttled hook:
 *
 *     needs: [state("retro.nagged")],
 *     react: (e) => e.ctx["retro.nagged"].fresherThan("1d")
 *       ? nothing()
 *       : notice(MESSAGE, record("retro.nagged")),
 *
 * and the line says out loud what the field would have hidden.
 *
 * ## What this SUBTRACTS
 *
 * - The stamp-file convention it replaces: seven bespoke `.claude/.*-last` files,
 *   each with its own hand-rolled read-and-clamp (`case "$v" in '' | *[!0-9]*) v=0`
 *   appears in three of the seven, because a raw file is untyped and every reader
 *   has to re-derive that a missing file means "never"). The clamp is what
 *   {@link StateFact} is: the parse happens once, in the runtime, typed.
 * - `run()`'s side career as a writer. Today the only sanctioned way for a react
 *   to remember anything is `run("date +%s > .claude/.stamp")` — a subprocess, a
 *   shell, a path, and an effect-classification of "side-effecting" for what is
 *   really a variable assignment. After this, `run()` goes back to meaning what
 *   its doc comment says it means: invoke a real tool.
 * - An asymmetry in `needs`. Gates could declare context; injects and reacts could
 *   not, for no reason anyone recorded. State is useless to a hook that cannot
 *   read it, so `needs` is now uniform across roles — one fewer special case
 *   rather than one more.
 *
 * It does NOT retire the `observe`-mode record (`.vigiles/hook-observations.jsonl`):
 * that is an append-only audit log of what a gate WOULD have blocked, a different
 * shape (many rows, never read back by a hook) from a named current-value fact.
 *
 * ## Failure modes, and whether they are loud
 *
 *   forget to `record`          → the reader's fact never freshens → it fires
 *                                 EVERY TIME. Loud (noisy), self-announcing.
 *   `record` the wrong key      → same as forgetting. Loud.
 *   `record` too eagerly        → the reader goes QUIET. This is the dangerous
 *                                 direction and the design does not make it
 *                                 impossible; it makes it locatable. Every entry
 *                                 carries `by`, so `cat .vigiles/state/**` names
 *                                 the hook that claimed the fact.
 *   invalid key                 → {@link record} throws, in-process, in the hook's
 *                                 own unit test — the tier this product exists to
 *                                 make cheap. A hand-built `{kind:"record",…}`
 *                                 object that bypasses the constructor is refused
 *                                 again by the runtime before the write.
 *   fact never recorded         → age is `Infinity`, so every freshness test says
 *                                 "not fresh" and the hook SPEAKS. Fails toward
 *                                 noise, never toward silence.
 *
 * That last one is not a slogan; it is why the read view exposes `Infinity`
 * instead of `null`. MEASURED: `null < 3600` is `true` in JavaScript (null
 * numifies to 0), so the natural spelling of a freshness test — the one every
 * author writes first — reads a NEVER-RECORDED fact as maximally fresh and
 * silences the hook forever. That is the precise failure this whole feature was
 * commissioned to end, reintroduced by a type choice. `Infinity` makes every
 * comparison come out the safe way with no special case to remember.
 *
 * ## Alternatives rejected, with what rejected them
 *
 * - **Give reacts a filesystem.** Trades one unchecked capability for another and
 *   makes `checkHookImports` theatre: if the sanctioned API hands out a writer,
 *   "capability = API surface" says nothing. Concretely it also puts
 *   `.claude/settings.json` and `.git/hooks/*` one path string away from a guard
 *   that could then rewrite its own wiring. And it does not even solve the stated
 *   problem well: the seven shell hooks touch eight stamp paths between them and
 *   three re-implement the same numeric clamp, which is what a raw file interface
 *   COSTS rather than what it saves.
 * - **Keep throttle as its own feature.** Rejected by the two measurements above.
 * - **`ageSeconds: number | null`.** Rejected by `null < 3600 === true`.
 * - **A separate accessor, `e.state("k")`, instead of `needs`.** Rejected: it
 *   would be a second way to read external facts, and it would destroy the
 *   property that makes `needs` worth having — the dependency is declared, so it
 *   is auditable from the outside and an undeclared read does not compile.
 * - **One store file per HOOK** (isolation by hook rather than by directory).
 *   Rejected because it cannot express the requirement: the case that forced this
 *   feature is one hook recording a fact for a DIFFERENT hook to read tomorrow.
 * - **One JSON blob per namespace.** Rejected on concurrency — see below.
 *
 * ## Storage, scope and concurrency
 *
 * One file per key, under a directory the runtime derives from the hook's own
 * location: `.vigiles/state/<hook's dir>/<key>.json`. The layout mirrors the
 * directory rather than slugging it, so it is injective and a human debugging a
 * hook can find the fact by walking the path they already know.
 *
 * Scope is the hook's DIRECTORY. Hooks shipped together share their facts (which
 * is the requirement); a vendored plugin's hooks live in the plugin's own
 * directory and cannot see or clobber the project's. Two unrelated plugins that
 * both install into `.claude/hooks/` do share — and they also share
 * `settings.json` and the checkout, so they are already one trust domain.
 *
 * Concurrency: two hook processes can run at once, and the store is designed so
 * the answer is "nothing to coordinate" rather than "acceptable loss". Distinct
 * keys are distinct files and never interact — which is exactly why a single JSON
 * blob was rejected, since read-modify-write on a shared blob loses a concurrent
 * write silently. Same-key concurrent writes are resolved by writing a temp file
 * in the same directory and `rename()`ing it over, which is atomic on POSIX: a
 * reader sees the whole old entry or the whole new one, never a torn mix of one
 * write's value with another's timestamp. Two writers of the same key are both
 * writing "now", so either outcome is correct.
 *
 * Pure by construction: this module reads no disk and imports nothing. The store
 * I/O lives in the trusted runtime and is injected, so the whole model is
 * testable against a fake store with no filesystem.
 */

/** A duration a freshness test is measured against: `"90s"`, `"30m"`, `"1h"`, `"7d"`. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Seconds in a duration string, or `null` if it is not one. A bad duration must
 * not quietly become 0 (which would read as "always stale" — noisy but wrong) nor
 * `Infinity` (silent, the failure this feature exists to end), so callers turn
 * `null` into a throw at the point the author can see it.
 */
export function durationSeconds(d: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(d);
  if (m === null) return null;
  const unit = UNIT_SECONDS[m[2]];
  if (unit === undefined) return null;
  return Number(m[1]) * unit;
}

/**
 * The stored shape of one named fact. `at` is ISO-8601 so the store is readable
 * with `cat`; `by` names the hook that claimed it, which is the only handle a
 * human has on "who decided this fact is true" (see the failure modes above).
 */
export interface StateEntry {
  readonly value: string;
  readonly at: string;
  readonly by?: string;
}

/**
 * A recorded fact as a hook reads it — the typed replacement for "cat the stamp
 * file and clamp whatever comes back".
 */
export interface StateFact {
  /** Has this key ever been recorded? The only way to distinguish "never" from "long ago". */
  readonly recorded: boolean;
  /** The recorded string; `""` when never recorded. */
  readonly value: string;
  /** ISO-8601 instant of the recording; `""` when never recorded. */
  readonly at: string;
  /**
   * Seconds since the recording — `Infinity` when never recorded, never `null`.
   *
   * 🔴 THE TYPE IS THE SAFETY PROPERTY. With `number | null`, the test every
   * author writes first (`age < 3600`) reads a never-recorded fact as FRESH,
   * because `null < 3600` is `true` in JavaScript. A hook that has never run
   * would therefore never run. With `Infinity` every comparison lands on the
   * side that speaks, and there is no null case to forget.
   */
  readonly ageSeconds: number;
  /** True iff recorded within `within`. Never-recorded → `false` (so the hook speaks). */
  fresherThan(within: Duration): boolean;
  /** True iff not recorded within `within`. Never-recorded → `true` (so the hook speaks). */
  olderThan(within: Duration): boolean;
}

/** Thrown for a malformed duration or key — a programming error, surfaced in the hook's own test. */
export class HookStateError extends Error {}

function secondsOrThrow(within: string): number {
  const s = durationSeconds(within);
  if (s === null) {
    throw new HookStateError(
      `invalid duration "${within}" — use <number><s|m|h|d>, e.g. "90s", "30m", "1h", "7d".`,
    );
  }
  return s;
}

/**
 * Build the read view of a stored entry. `entry === null` means the key has never
 * been recorded. `nowMs` is passed in rather than read from the clock so the whole
 * model stays pure and a test can pin the age exactly.
 */
export function stateFact(entry: StateEntry | null, nowMs: number): StateFact {
  const parsed = entry === null ? NaN : Date.parse(entry.at);
  // An unparseable `at` is corruption, and it must fail toward NOISE: treat the
  // key as never recorded rather than as recorded-just-now, which would silence
  // a throttled hook for a window with no way to notice.
  const recorded = entry !== null && !Number.isNaN(parsed);
  const ageSeconds = recorded ? Math.max(0, (nowMs - parsed) / 1000) : Infinity;
  return {
    recorded,
    value: recorded ? entry.value : "",
    at: recorded ? entry.at : "",
    ageSeconds,
    fresherThan: (within) => ageSeconds < secondsOrThrow(within),
    olderThan: (within) => ageSeconds >= secondsOrThrow(within),
  };
}

/**
 * Keys a hook may name. Deliberately narrow: it must be a safe path segment on
 * every filesystem, greppable, and unable to reach out of its directory.
 *
 * The leading-alphanumeric requirement is what does the security work — it makes
 * `.`, `..`, `.hidden` and the reserved `@` unspellable in one rule, rather than
 * as a list of special cases someone extends later and gets wrong. There is no
 * `@` namespace in this design (no automatic stamps exist to protect), but the
 * character stays reserved so that adding one later cannot collide with a key
 * some hook already records.
 */
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidStateKey(key: string): boolean {
  return STATE_KEY.test(key);
}

/** A declaration that the runtime should record a fact. Carries a key — never a path, never a namespace. */
export interface StateWrite {
  readonly kind: "record";
  readonly name: string;
  readonly value: string;
}

/**
 * Declare that a named fact just became true: `record("calendar.synced")`.
 *
 * The hook performs no write — it returns this, attached to whatever it was
 * already returning, and the trusted runtime stores it. An optional `value` lets
 * a hook remember WHAT as well as WHEN (`record("merge.nagged", branch)`), which
 * is how a nudge avoids repeating itself about the same thing.
 *
 * Throws on an invalid key rather than returning a value that fails somewhere
 * later: a compiled hook's decision is a pure function that its own test calls
 * in-process, so this surfaces at the cheapest possible tier.
 */
export function record(name: string, value = ""): StateWrite {
  if (!isValidStateKey(name)) {
    throw new HookStateError(
      `invalid state key "${name}" — must match ${String(STATE_KEY)} ` +
        `(letters, digits, dot, dash, underscore; must start with a letter or digit). ` +
        `A key is a name, not a path: the runtime chooses where it is stored.`,
    );
  }
  return { kind: "record", name, value };
}

/** A `needs` entry that reads a recorded fact: `needs: [state("calendar.synced")]`. */
export interface StateNeed<Name extends string = string> {
  readonly kind: "state";
  readonly name: Name;
}

/**
 * Declare a recorded fact as an input: `state("calendar.synced")` in `needs` makes
 * `e.ctx["calendar.synced"]` a {@link StateFact}. Rides the existing `needs`
 * path on purpose — a second way to read external state would give up the
 * property that the dependency is declared and checkable from outside the hook.
 */
export function state<const Name extends string>(name: Name): StateNeed<Name> {
  if (!isValidStateKey(name)) {
    throw new HookStateError(
      `invalid state key "${name}" — must match ${String(STATE_KEY)}.`,
    );
  }
  return { kind: "state", name };
}

/** True iff a `needs` entry is a {@link StateNeed}. */
export function isStateNeed(need: unknown): need is StateNeed {
  return (
    typeof need === "object" &&
    need !== null &&
    (need as StateNeed).kind === "state"
  );
}

/** True iff a value is a {@link StateWrite} (the runtime re-checks what it is handed). */
export function isStateWrite(w: unknown): w is StateWrite {
  return (
    typeof w === "object" &&
    w !== null &&
    (w as StateWrite).kind === "record" &&
    typeof (w as StateWrite).name === "string" &&
    typeof (w as StateWrite).value === "string"
  );
}

/**
 * The writes the runtime may actually perform, given what a hook returned.
 *
 * Defence in depth, and the threat is specific: {@link record} throws on a bad
 * key, but nothing stops a hook returning a hand-built `{kind:"record", name:
 * "../../settings"}` object literal that never went through the constructor.
 * Everything that is not a well-formed write with a valid key is dropped here,
 * before any path is computed from it.
 */
export function admissibleWrites(writes: readonly unknown[]): {
  readonly ok: readonly StateWrite[];
  readonly refused: readonly string[];
} {
  const ok: StateWrite[] = [];
  const refused: string[] = [];
  for (const w of writes) {
    if (isStateWrite(w) && isValidStateKey(w.name)) ok.push(w);
    else refused.push(isStateWrite(w) ? w.name : JSON.stringify(w));
  }
  return { ok, refused };
}
