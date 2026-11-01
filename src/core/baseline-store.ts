/**
 * The BASELINE STORE: one committed file, `.vigiles/baseline.json`, holding the
 * size each rule last ACCEPTED for each thing it measures. A rule stays
 * stateless — it measures, compares against a fixed limit and reports what is
 * over — and this module, applied AFTER the rule has produced its findings,
 * decides which of those findings the repository already accepted. The shape
 * of ESLint's bulk suppressions ("suppressions are applied after cache
 * retrieval"), betterer's results file and the `--update-baseline` flag of
 * several static analysers: the rule never reads the store, the store never
 * knows how a rule measures.
 *
 * WHY ONE FILE FOR EVERY RULE. A second rule that ratchets (a file length, a
 * per-file count) needs the same four things: a number per subject, a
 * direction, a measurement version and a reviewed diff when the number moves.
 * Keyed by rule id and then by subject, every such rule shares the reader, the
 * writer, the schema and the messages, and a re-record of one rule never
 * touches another's entries.
 *
 * WHAT AN ENTRY SAYS. `value` in `unit`, recorded by `measure` (bumped when a
 * release changes what counts, so a vigiles change reads as "re-record", not
 * as growth the author made), and `direction`: `shrink-only` is the one
 * direction today — the number may hold or fall, never rise. `parts` is an
 * optional breakdown that sums to `value`, so a message can say which part
 * moved; each part may name its files for the same reason.
 *
 * THE VERDICT, per finding that carries a measurement:
 *
 *   - no entry for the rule at all → a NOTE naming the command: a repository
 *     over a limit starts green and is told how to accept its current size;
 *   - entries for the rule, none for this subject → a finding: weight that
 *     appeared after the baseline was recorded is weight nobody signed off on;
 *   - another unit or measure → a finding asking to re-record;
 *   - at the stored value → held; below it → a NOTE to lower the baseline;
 *     above it → a finding, with what moved.
 *
 * And per stored entry whose subject produced no such finding: a NOTE that the
 * entry can go (`--update-baseline` drops it), because the subject is now
 * under its limit or is no longer measured.
 *
 * Pure: parsing, comparison, recording and formatting. Reading and writing the
 * file is the caller's.
 */
import { z } from "zod";

/** Where the store lives, relative to the directory `.vigilesrc.json` is read from. */
export const BASELINE_FILE = ".vigiles/baseline.json";

/** The command that writes the store — named once, quoted by every message. */
export const UPDATE_BASELINE_COMMAND = "vigiles lint --update-baseline";

/** The on-disk shape this release reads and writes. */
export const BASELINE_STORE_VERSION = 1;

const size = z.number().int().nonnegative();

const sumOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

const partSchema = z
  .object({
    value: size,
    files: z.record(z.string(), size).optional(),
  })
  .strict()
  .refine(
    (p) => p.files === undefined || sumOf(Object.values(p.files)) === p.value,
    {
      message:
        "`value` is not the sum of `files` — edited by hand; re-record it",
    },
  );

const entrySchema = z
  .object({
    direction: z.literal("shrink-only"),
    unit: z.string().min(1),
    measure: z.number().int().nonnegative(),
    value: size,
    parts: z.record(z.string(), partSchema).optional(),
  })
  .strict()
  .refine(
    (e) =>
      e.parts === undefined ||
      sumOf(Object.values(e.parts).map((p) => p.value)) === e.value,
    {
      message:
        "`value` is not the sum of `parts` — edited by hand; re-record it",
    },
  );

const storeSchema = z
  .object({
    version: z.literal(BASELINE_STORE_VERSION),
    /** Rule id → subject → entry. */
    rules: z.record(z.string(), z.record(z.string(), entrySchema)),
  })
  .strict();

/** One accepted size. */
export type BaselineEntry = Readonly<z.infer<typeof entrySchema>>;
/** The whole committed file. */
export type BaselineStore = z.infer<typeof storeSchema>;

/** The file, read once at the boundary: absent, parsed, or refused. */
export type StoreOnDisk =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly store: BaselineStore }
  | { readonly kind: "invalid"; readonly message: string };

/** Parse the file's text; never throws. */
export function parseBaselineStore(text: string): StoreOnDisk {
  const json = ((): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  })();
  if (!json.ok) return { kind: "invalid", message: "not valid JSON" };
  const parsed = storeSchema.safeParse(json.value);
  return parsed.success
    ? { kind: "ok", store: parsed.data }
    : {
        kind: "invalid",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`)
          .join("; "),
      };
}

/** Stable text: two-space indent, trailing newline, no timestamp. */
export function serializeBaselineStore(store: Readonly<BaselineStore>): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * One part of a measurement. `value: null` = this run could not measure it
 * (the adapter does not model it, or a selection names nothing readable): NOT
 * zero, so the stored value is carried instead of being read as a cut.
 */
export interface MeasuredPart {
  readonly value: number | null;
  readonly files?: Readonly<Record<string, number>>;
}

/** What a rule measured for one subject, in the shape the store records. */
export interface Measurement {
  readonly unit: string;
  readonly measure: number;
  /** Absent: the measurement is a single number, `value`. */
  readonly parts?: Readonly<Record<string, MeasuredPart>>;
  /** The whole number; with parts, the sum of the parts this run measured. */
  readonly value: number;
}

/** One finding a rule produced. Only one that carries a measurement can be accepted. */
export interface RuleFinding {
  readonly subject: string;
  readonly text: string;
  readonly measurement?: Measurement;
}

/** Everything one rule reports for the store to act on. */
export interface RuleRun {
  readonly ruleId: string;
  readonly findings: readonly RuleFinding[];
  /** Every subject the rule measured this run, over its limit or not. */
  readonly measured: readonly string[];
  /** What a reader does about growth — the rule's own cure, printed once per growth. */
  readonly remedy?: string;
}

/** One line of lint output. `finding` counts toward the exit code; `note` never does. */
export interface StoreLine {
  readonly subject: string;
  readonly status: "finding" | "ok" | "note";
  readonly text: string;
}

/** The rule's entries, or none. */
const entriesOf = (
  store: StoreOnDisk,
  ruleId: string,
): Readonly<Record<string, BaselineEntry>> | undefined =>
  store.kind === "ok" && Object.hasOwn(store.store.rules, ruleId)
    ? store.store.rules[ruleId]
    : undefined;

const entryAt = (
  entries: Readonly<Record<string, BaselineEntry>> | undefined,
  subject: string,
): BaselineEntry | undefined =>
  entries !== undefined && Object.hasOwn(entries, subject)
    ? entries[subject]
    : undefined;

/**
 * The measurement as it would be recorded: every part this run could not
 * measure takes its stored value (or is left out when there is none), and
 * zero parts are dropped.
 */
export function toEntry(
  m: Measurement,
  stored: BaselineEntry | undefined,
): BaselineEntry {
  if (m.parts === undefined) {
    return {
      direction: "shrink-only",
      unit: m.unit,
      measure: m.measure,
      value: m.value,
    };
  }
  const parts = Object.entries(m.parts).flatMap(
    ([name, p]): [
      string,
      { value: number; files?: Record<string, number> },
    ][] => {
      const carried = p.value === null ? stored?.parts?.[name] : undefined;
      if (carried !== undefined) return [[name, { ...carried }]];
      if (p.value === null || p.value === 0) return [];
      return [
        [
          name,
          p.files === undefined
            ? { value: p.value }
            : { value: p.value, files: { ...p.files } },
        ],
      ];
    },
  );
  return {
    direction: "shrink-only",
    unit: m.unit,
    measure: m.measure,
    value: sumOf(parts.map(([, p]) => p.value)),
    parts: Object.fromEntries(parts.sort(([a], [b]) => a.localeCompare(b))),
  };
}

const n = (x: number): string => x.toLocaleString("en-US");
const signed = (x: number): string => (x > 0 ? `+${n(x)}` : n(x));

/** Each part's stored and current value, where either side has one. */
function partMoves(current: BaselineEntry, stored: BaselineEntry): string {
  const names = [
    ...new Set([
      ...Object.keys(stored.parts ?? {}),
      ...Object.keys(current.parts ?? {}),
    ]),
  ].sort();
  return names
    .map((name) => {
      const from = stored.parts?.[name]?.value ?? 0;
      const to = current.parts?.[name]?.value ?? 0;
      return `${name} ${n(to)}${from === to ? "" : ` (${signed(to - from)})`}`;
    })
    .join(" · ");
}

/** Every file whose size moved, largest movement first. */
function fileMoves(current: BaselineEntry, stored: BaselineEntry): string {
  const flat = (e: BaselineEntry): Readonly<Record<string, number>> =>
    Object.fromEntries(
      Object.entries(e.parts ?? {}).flatMap(([name, p]) =>
        Object.entries(p.files ?? {}).map(
          ([file, s]) => [`${file} (${name})`, s] as const,
        ),
      ),
    );
  const before = flat(stored);
  const after = flat(current);
  const moves = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((file) => ({
      file,
      from: before[file] ?? 0,
      to: after[file] ?? 0,
      had: Object.hasOwn(before, file),
      has: Object.hasOwn(after, file),
    }))
    .filter((c) => c.from !== c.to || c.had !== c.has)
    .sort(
      (a, b) =>
        Math.abs(b.to - b.from) - Math.abs(a.to - a.from) ||
        a.file.localeCompare(b.file),
    );
  return moves
    .map((c) => {
      if (!c.had) return `${c.file} +${n(c.to)} (new)`;
      if (!c.has) return `${c.file} -${n(c.from)} (gone)`;
      return `${c.file} ${signed(c.to - c.from)}`;
    })
    .join(", ");
}

/** The verdict for one finding that carries a measurement. */
function verdictFor(
  f: RuleFinding & { readonly measurement: Measurement },
  entries: Readonly<Record<string, BaselineEntry>> | undefined,
  remedy: string | undefined,
): StoreLine {
  const at = (status: StoreLine["status"], text: string): StoreLine => ({
    subject: f.subject,
    status,
    text: `${f.text}\n  ${text}`,
  });
  if (entries === undefined) {
    return at(
      "note",
      `No baseline is recorded, so this is not a finding. To fail CI only if it grows, run \`${UPDATE_BASELINE_COMMAND}\` and commit ${BASELINE_FILE}.`,
    );
  }
  const stored = entryAt(entries, f.subject);
  if (stored === undefined) {
    return at(
      "finding",
      `${BASELINE_FILE} has no entry for this, so nobody accepted this size. Record it with \`${UPDATE_BASELINE_COMMAND}\` (the diff is the review), or get under the limit.`,
    );
  }
  const m = f.measurement;
  if (stored.unit !== m.unit || stored.measure !== m.measure) {
    const why =
      stored.unit === m.unit
        ? `was recorded by measurement ${String(stored.measure)}, this vigiles uses ${String(m.measure)} — what counts changed in vigiles, not in your files`
        : `is in ${stored.unit}, this harness counts ${m.unit}`;
    return at(
      "finding",
      `The baseline ${why}. Re-record it with \`${UPDATE_BASELINE_COMMAND}\`.`,
    );
  }
  const current = toEntry(m, stored);
  const head = `${n(stored.value)} → ${n(current.value)} ${m.unit}`;
  const parts =
    current.parts === undefined ? "" : `\n  ${partMoves(current, stored)}`;
  if (current.value === stored.value) {
    return {
      subject: f.subject,
      status: "ok",
      text: `${f.text}\n  Held at the recorded baseline (${n(stored.value)} ${m.unit}).`,
    };
  }
  if (current.value < stored.value) {
    return at(
      "note",
      `Shrank ${head} (${signed(current.value - stored.value)}) below the recorded baseline, which still allows the old size. Lock the cut in with \`${UPDATE_BASELINE_COMMAND}\`.${parts}`,
    );
  }
  const files = fileMoves(current, stored);
  return at(
    "finding",
    `Grew ${head} (${signed(current.value - stored.value)}) over the recorded baseline.${files === "" ? "" : ` Changed: ${files}.`}${parts}\n  ` +
      `If the growth is intended, record it with \`${UPDATE_BASELINE_COMMAND}\` — the diff of ${BASELINE_FILE} is the review.` +
      (remedy === undefined ? "" : ` If it is not:\n${remedy}`),
  );
}

/** A stored entry no finding asked for: the subject is under its limit, or gone. */
function staleLine(subject: string, measured: boolean): StoreLine {
  const where = subject === "." ? "" : `${subject}: `;
  return {
    subject,
    status: "note",
    text: measured
      ? `${where}under the limit, so ${BASELINE_FILE} no longer needs its entry — \`${UPDATE_BASELINE_COMMAND}\` drops it (and deletes the file once it is empty).`
      : `${where}no longer measured, so its entry in ${BASELINE_FILE} is stale — \`${UPDATE_BASELINE_COMMAND}\` drops it.`,
  };
}

/** Apply the store to one rule's run: the lines lint prints, in subject order. */
export function applyBaseline(
  run: RuleRun,
  store: StoreOnDisk,
): readonly StoreLine[] {
  if (store.kind === "invalid") {
    return [
      {
        subject: ".",
        status: "finding",
        text: `${BASELINE_FILE} cannot be read (${store.message}) — re-record it with \`${UPDATE_BASELINE_COMMAND}\``,
      },
      ...run.findings.map(
        (f): StoreLine => ({
          subject: f.subject,
          status: "finding",
          text: f.text,
        }),
      ),
    ];
  }
  const entries = entriesOf(store, run.ruleId);
  const lines = run.findings.map(
    (f): StoreLine =>
      f.measurement === undefined
        ? { subject: f.subject, status: "finding", text: f.text }
        : verdictFor({ ...f, measurement: f.measurement }, entries, run.remedy),
  );
  const asked = new Set(
    run.findings
      .filter((f) => f.measurement !== undefined)
      .map((f) => f.subject),
  );
  const stale = Object.keys(entries ?? {})
    .filter((subject) => !asked.has(subject))
    .sort()
    .map((subject) => staleLine(subject, run.measured.includes(subject)));
  return [...lines, ...stale];
}

/**
 * The store with one rule's entries replaced by `entries` — every other rule's
 * are kept. `undefined` when nothing is left to store, so the caller deletes
 * the file rather than committing an empty one.
 */
export function withEntries(
  previous: StoreOnDisk,
  ruleId: string,
  entries: Readonly<Record<string, BaselineEntry>>,
): BaselineStore | undefined {
  const before = previous.kind === "ok" ? previous.store.rules : {};
  const fresh = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  const others = Object.entries(before).filter(([id]) => id !== ruleId);
  const mine =
    fresh.length === 0 ? [] : [[ruleId, Object.fromEntries(fresh)] as const];
  const rules = Object.fromEntries(
    [...others, ...mine].sort(([a], [b]) => a.localeCompare(b)),
  );
  return Object.keys(rules).length === 0
    ? undefined
    : { version: BASELINE_STORE_VERSION, rules };
}

/**
 * The entries recording one rule's run writes: exactly the findings that carry
 * a measurement, each with any part this run could not measure carried over.
 */
export function entriesFor(
  previous: StoreOnDisk,
  run: RuleRun,
): Readonly<Record<string, BaselineEntry>> {
  const old = entriesOf(previous, run.ruleId);
  return Object.fromEntries(
    run.findings.flatMap((f) =>
      f.measurement === undefined
        ? []
        : [
            [
              f.subject,
              toEntry(f.measurement, entryAt(old, f.subject)),
            ] as const,
          ],
    ),
  );
}

/** The store after recording one rule's run ({@link withEntries} of {@link entriesFor}). */
export const recordRun = (
  previous: StoreOnDisk,
  run: RuleRun,
): BaselineStore | undefined =>
  withEntries(previous, run.ruleId, entriesFor(previous, run));

/** Whether the store already holds entries for a rule — `init` never overwrites them. */
export const hasEntries = (store: StoreOnDisk, ruleId: string): boolean =>
  Object.keys(entriesOf(store, ruleId) ?? {}).length > 0;
