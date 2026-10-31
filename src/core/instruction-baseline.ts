/**
 * The instruction-weight RATCHET: the always-loaded weight may not grow past
 * what the repository itself last recorded.
 *
 * WHY A RATCHET AND NOT THE BUDGET. `./instruction-weight.ts` explains why the
 * harness's own threshold cannot gate: real repositories sit several times over
 * it, and a rule that fails every repo on day one is switched off on day one.
 * What CAN gate is the repository's own past. The baseline is whatever the repo
 * weighed when it was last recorded, so a repo four times over budget starts
 * green — and stays green only while it does not get heavier. The measured case
 * this exists for: a root instruction file cut from ~4 100 lines to ~1 900, then
 * regrown by ~1 000 lines over ten ordinary commits, with nothing in CI to say so.
 *
 * WHY THE SUM, AGAIN. The baseline records `committedTotal`, the same number the
 * audit report scores: everything the harness loads without being asked that a
 * teammate on the same commit also loads. A per-file baseline would read text
 * moved into an always-loaded sibling as a shrink — the evasion the weight
 * module was built to see through. The per-file sizes are recorded too, but only
 * so a message can say WHICH file moved; the verdict is decided on the total.
 *
 * WHY A SHRINK IS A FINDING TOO. A baseline left above the tree is headroom, and
 * headroom is exactly where the regrowth above landed: every character up to the
 * old number would pass. So, like ESLint's unpruned suppressions and `betterer
 * ci`, a tree LIGHTER than its baseline asks for the baseline to be lowered —
 * one command, in the same change that made the cut. The baseline then always
 * equals the tree on the default branch, and any growth at all is a diff a
 * reviewer sees.
 *
 * WHO WRITES IT. Never `lint` on its own: a read never writes. The file is
 * written only by the explicit `vigiles lint --update-baseline`, the same shape
 * as `eslint --suppress-all` / `--prune-suppressions` and `jest -u`. Raising the
 * baseline is allowed and is the point: growth is not forbidden, it is made
 * visible as a reviewed diff of a committed file.
 *
 * VERSION 2 — THE FIXED CONTEXT. The output style the committed settings select
 * and the skill listing load at session start exactly as the instructions do
 * (`./fixed-context.ts`), so a section moved from `CLAUDE.md` into either is
 * the same relocation the sum above exists to see. A version-2 entry carries
 * them as `parts`, each with its own `measure`, and the verdict is decided on
 * the SUM of the instructions and every recorded part. Per part, so a change
 * to how one part is measured asks to re-record that part by name.
 *
 * ⚠️ THE TRADE-OFF OF A STRICT FILE, stated rather than hidden. Version 1 was
 * read with `.strict()` and `z.literal(1)`, so there is no extension of it an
 * OLDER vigiles accepts: it reads a version-2 file as "cannot be read", which
 * is a finding at the rule's severity — red CI wherever lint still runs the old
 * release, the moment one teammate re-records. Loud, never silent, but red. The
 * alternative, a sibling file old readers ignore, would split one gated sum
 * across two files, so that a move from one to the other read as a shrink in
 * each. What keeps the cost small:
 *
 *   - a repo still on version 1 is read as before — the instructions gate as
 *     they did, and each new part that is not zero is a NOTE, never a finding,
 *     so upgrading vigiles never turns CI red;
 *   - `--update-baseline` writes version 2 only when some part is not zero, so
 *     a repo with no output style and no listed skill keeps a version-1 file
 *     every release reads;
 *   - the note and the rule doc say to upgrade vigiles wherever lint runs
 *     BEFORE re-recording.
 *
 * Pure: parsing, comparison and formatting only. Reading and writing the file
 * is the caller's (`src/instruction-weight-ratchet.ts`).
 */
import { z } from "zod";

import type { InstructionWeight } from "./instruction-weight.js";
import { MOVE_OUT_OF_ALWAYS_LOADED } from "./instruction-remedies.js";
import type {
  FixedContext,
  FixedPart,
  FixedPartName,
} from "./fixed-context.js";

/** Where the baseline lives, relative to the directory `.vigilesrc.json` is read from. */
export const INSTRUCTION_BASELINE_FILE = ".vigiles/instruction-weight.json";

/** The command that writes the baseline — named once, quoted by every message. */
export const UPDATE_BASELINE_COMMAND = "vigiles lint --update-baseline";

/**
 * The newest on-disk shape this release reads and writes. Bumped only on an
 * incompatible change. Version 1 is still read, and still WRITTEN when no
 * fixed-context part has anything in it — see the header for why.
 */
export const INSTRUCTION_BASELINE_VERSION = 2;

/**
 * Which measurement produced a recorded PART — the same job as
 * {@link INSTRUCTION_WEIGHT_MEASURE}, per part, so a change to how the skill
 * listing is rendered re-records the listing and names it.
 */
export const FIXED_PART_MEASURE = 1;

/** The parts a version-2 entry may carry, in the order they are printed. */
export const FIXED_PART_NAMES: readonly FixedPartName[] = [
  "output-style",
  "skill-listing",
];

/**
 * Which MEASUREMENT produced a recorded number — bumped whenever a release
 * changes what counts (chain membership in any adapter, how a file is sized),
 * even when the file shape stays the same.
 *
 * Without it, a vigiles fix that moves a file into or out of the chain moves
 * `committedTotal` on every consumer with a committed baseline, and they see
 * `grew`/`shrank` attributed to their own content. With it, they see one
 * "re-record" verdict that names the cause. `version` cannot do this job: it
 * describes the file, not the number in it.
 */
export const INSTRUCTION_WEIGHT_MEASURE = 1;

const SUM_MESSAGE =
  "`total` is not the sum of `files` — the file was edited by hand; re-record it";
const sumsUp = (e: {
  readonly total: number;
  readonly files: Readonly<Record<string, number>>;
}): boolean => Object.values(e.files).reduce((a, b) => a + b, 0) === e.total;

const partSchema = z
  .object({
    measure: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    files: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
  .refine(sumsUp, { message: SUM_MESSAGE });

const entrySchema = z
  .object({
    unit: z.enum(["chars", "bytes"]),
    measure: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    files: z.record(z.string(), z.number().int().nonnegative()),
    /** Version 2 only: the fixed-context parts beside the instructions. */
    parts: z
      .object({
        "output-style": partSchema.optional(),
        "skill-listing": partSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(sumsUp, { message: SUM_MESSAGE });

const baselineSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(INSTRUCTION_BASELINE_VERSION)]),
    /** Keyed by bundle location from the config root; `.` is the root itself. */
    bundles: z.record(z.string(), entrySchema),
  })
  .strict()
  .refine(
    (b) =>
      b.version !== 1 ||
      Object.values(b.bundles).every((e) => e.parts === undefined),
    { message: "`parts` needs `version: 2` — re-record the file" },
  );

/** One bundle's recorded weight. */
export type BaselineEntry = Readonly<z.infer<typeof entrySchema>>;
/** One recorded fixed-context part. */
export type BaselinePart = Readonly<z.infer<typeof partSchema>>;
/** The whole committed file. */
export type InstructionBaseline = z.infer<typeof baselineSchema>;

/** The file's contents, parsed once at the boundary. */
export type ParsedBaseline =
  | { readonly kind: "ok"; readonly baseline: InstructionBaseline }
  | { readonly kind: "invalid"; readonly message: string };

export function parseInstructionBaseline(text: string): ParsedBaseline {
  const json = ((): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  })();
  if (!json.ok) return { kind: "invalid", message: "not valid JSON" };
  const parsed = baselineSchema.safeParse(json.value);
  return parsed.success
    ? { kind: "ok", baseline: parsed.data }
    : {
        kind: "invalid",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`)
          .join("; "),
      };
}

const sortedFiles = (
  files: readonly { readonly path: string; readonly size: number }[],
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => [f.path, f.size]),
  );

/** A part as it would be recorded, or nothing when it adds nothing. */
function partEntry(part: FixedPart): BaselinePart | undefined {
  return part.kind === "counted" && part.total > 0
    ? {
        measure: FIXED_PART_MEASURE,
        total: part.total,
        files: sortedFiles(part.files),
      }
    : undefined;
}

/** The parts of a fixed context that would be recorded, by name. */
function partEntries(
  fixed: FixedContext | undefined,
): Readonly<NonNullable<BaselineEntry["parts"]>> | undefined {
  if (fixed === undefined) return undefined;
  const byName = {
    "output-style": partEntry(fixed.outputStyle),
    "skill-listing": partEntry(fixed.skillListing),
  };
  const kept = Object.entries(byName).filter(([, p]) => p !== undefined);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * What a measured weight would be recorded as: the SCORED files only, plus
 * every fixed-context part that is not zero when one is handed in.
 */
export function entryFor(
  weight: InstructionWeight,
  fixed?: FixedContext,
): BaselineEntry {
  const scored = weight.files.filter((f) => f.scope === "repo");
  const parts = partEntries(fixed);
  return {
    unit: weight.unit,
    measure: INSTRUCTION_WEIGHT_MEASURE,
    total: weight.committedTotal,
    files: sortedFiles(scored),
    ...(parts === undefined ? {} : { parts }),
  };
}

/** One file whose recorded size differs. `null` = absent on that side. */
export interface FileChange {
  readonly path: string;
  readonly from: number | null;
  readonly to: number | null;
}

/**
 * The comparison of a tree against its baseline. Each case is a different fact,
 * so each is its own member — "no baseline" is not "equal", and a baseline in
 * another unit is not a number to subtract.
 */
export type RatchetVerdict =
  | {
      readonly kind: "unrecorded";
      /** What `--update-baseline` would write. */
      readonly current: BaselineEntry;
    }
  | {
      readonly kind: "unit-changed";
      readonly recorded: BaselineEntry["unit"];
      readonly current: BaselineEntry["unit"];
    }
  | {
      readonly kind: "measure-changed";
      readonly recorded: number;
      readonly current: number;
      /** Set when it is one fixed-context PART whose measurement changed. */
      readonly part?: FixedPartName;
    }
  | {
      readonly kind: "held";
      readonly total: number;
      readonly unit: BaselineEntry["unit"];
    }
  | {
      readonly kind: "grew" | "shrank";
      readonly from: number;
      readonly to: number;
      readonly unit: BaselineEntry["unit"];
      /** Every file whose size moved, largest movement first. */
      readonly changes: readonly FileChange[];
    };

function changesBetween(
  before: BaselineEntry["files"],
  after: BaselineEntry["files"],
): readonly FileChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const size = (m: BaselineEntry["files"], p: string): number | null =>
    Object.hasOwn(m, p) ? m[p] : null;
  return paths
    .map((path) => ({ path, from: size(before, path), to: size(after, path) }))
    .filter((c) => c.from !== c.to)
    .sort(
      (a, b) =>
        Math.abs((b.to ?? 0) - (b.from ?? 0)) -
          Math.abs((a.to ?? 0) - (a.from ?? 0)) || a.path.localeCompare(b.path),
    );
}

export function compareToBaseline(
  weight: InstructionWeight,
  recorded: BaselineEntry | undefined,
): RatchetVerdict {
  return compareEntries(entryFor(weight), recorded);
}

/** A recorded number some other measurement produced — of a part, when named. */
function measureChanged(
  recorded: number,
  current: number,
  part?: FixedPartName,
): RatchetVerdict {
  return {
    kind: "measure-changed",
    recorded,
    current,
    ...(part === undefined ? {} : { part }),
  };
}

/** The verdict between two entries, decided on `total`. */
function compareEntries(
  current: BaselineEntry,
  recorded: BaselineEntry | undefined,
): RatchetVerdict {
  if (recorded === undefined) return { kind: "unrecorded", current };
  if (recorded.unit !== current.unit) {
    return {
      kind: "unit-changed",
      recorded: recorded.unit,
      current: current.unit,
    };
  }
  if (recorded.measure !== current.measure) {
    return measureChanged(recorded.measure, current.measure);
  }
  if (current.total === recorded.total) {
    return { kind: "held", total: current.total, unit: current.unit };
  }
  return {
    kind: current.total > recorded.total ? "grew" : "shrank",
    from: recorded.total,
    to: current.total,
    unit: current.unit,
    changes: changesBetween(recorded.files, current.files),
  };
}

const PART_LABEL: Readonly<Record<FixedPartName, string>> = {
  "output-style": "output style",
  "skill-listing": "skill listing",
};

/**
 * One entry with its parts folded in: the total is the fixed sum, and each
 * part's files are named with the part, so a `grew` message says which part a
 * file moved in. In memory only — never written.
 */
function folded(entry: BaselineEntry): BaselineEntry {
  const parts = FIXED_PART_NAMES.flatMap((name) => {
    const part = entry.parts?.[name];
    return part === undefined ? [] : [{ name, part }];
  });
  return {
    unit: entry.unit,
    measure: entry.measure,
    total: parts.reduce((sum, p) => sum + p.part.total, entry.total),
    files: Object.fromEntries([
      ...Object.entries(entry.files),
      ...parts.flatMap(({ name, part }) =>
        Object.entries(part.files).map(([path, size]): [string, number] => [
          `${path} (${PART_LABEL[name]})`,
          size,
        ]),
      ),
    ]),
  };
}

/** One part's recorded and current size, for the line that says where weight moved. */
export interface PartMove {
  readonly part: "instructions" | FixedPartName;
  readonly from: number;
  readonly to: number;
}

/** Each part's size on both sides; a part recorded on neither side is left out. */
function movesBetween(
  current: BaselineEntry,
  recorded: BaselineEntry,
): readonly PartMove[] {
  const parts = FIXED_PART_NAMES.flatMap((part): PartMove[] => {
    const from = recorded.parts?.[part]?.total;
    const to = current.parts?.[part]?.total;
    return from === undefined && to === undefined
      ? []
      : [{ part, from: from ?? 0, to: to ?? 0 }];
  });
  return [
    { part: "instructions", from: recorded.total, to: current.total },
    ...parts,
  ];
}

/** The first part whose recorded measurement is not this release's. */
function partMeasureChanged(
  current: BaselineEntry,
  recorded: BaselineEntry,
): RatchetVerdict | undefined {
  const changed = FIXED_PART_NAMES.find((name) => {
    const was = recorded.parts?.[name]?.measure;
    const now = current.parts?.[name]?.measure;
    return was !== undefined && now !== undefined && was !== now;
  });
  if (changed === undefined) return undefined;
  return measureChanged(
    recorded.parts?.[changed]?.measure ?? 0,
    FIXED_PART_MEASURE,
    changed,
  );
}

/**
 * The ratchet's verdict for one bundle with its fixed context:
 *
 *   - `instructions-only` — decided on the instructions as before. A version-1
 *     file, or a repo with no part to add and no file yet. Each part that is
 *     not zero is listed so the caller can print it as a NOTE.
 *   - `fixed` — decided on the SUM of the instructions and the parts: a
 *     version-2 file, or no file yet and something to add (recording then
 *     writes version 2). `byPart` says where weight moved, also on `held`,
 *     because a held sum can hide a listing that doubled while the
 *     instructions halved.
 */
export type BaselineVerdict =
  | {
      readonly kind: "instructions-only";
      readonly verdict: RatchetVerdict;
      readonly unrecordedParts: readonly {
        readonly part: FixedPartName;
        readonly total: number;
      }[];
    }
  | {
      readonly kind: "fixed";
      readonly verdict: RatchetVerdict;
      readonly byPart: readonly PartMove[];
    };

/** Which version of the file the verdict is read against; `absent` = no file. */
export type BaselineFileVersion =
  | 1
  | typeof INSTRUCTION_BASELINE_VERSION
  | "absent";

export function compareFixedToBaseline(
  weight: InstructionWeight,
  fixed: FixedContext | undefined,
  recorded: BaselineEntry | undefined,
  file: BaselineFileVersion,
): BaselineVerdict {
  const current = entryFor(weight, fixed);
  const sumGated =
    file === INSTRUCTION_BASELINE_VERSION ||
    (file === "absent" && current.parts !== undefined);
  if (!sumGated) {
    return {
      kind: "instructions-only",
      verdict: compareToBaseline(weight, recorded),
      unrecordedParts: FIXED_PART_NAMES.flatMap((part) => {
        const total = current.parts?.[part]?.total;
        return total === undefined ? [] : [{ part, total }];
      }),
    };
  }
  if (recorded === undefined) {
    return {
      kind: "fixed",
      verdict: { kind: "unrecorded", current: folded(current) },
      byPart: [],
    };
  }
  return {
    kind: "fixed",
    verdict:
      partMeasureChanged(current, recorded) ??
      compareEntries(folded(current), folded(recorded)),
    byPart: movesBetween(current, recorded),
  };
}

/** One file's size, for naming where the weight is. */
export interface FileWeight {
  readonly path: string;
  readonly size: number;
}

/**
 * A total above the opt-in absolute ceiling (`["error", { max }]`).
 *
 * Decided on the same number the ratchet records — `committedTotal`, the SCORED
 * files only — and in the same unit, so the two can never disagree about what
 * the weight is. It does not look at the baseline at all: that independence is
 * what makes it a ceiling and not a second ratchet.
 */
export interface CeilingVerdict {
  readonly total: number;
  readonly max: number;
  readonly unit: BaselineEntry["unit"];
  /** The scored files, heaviest first — where the cut has to come from. */
  readonly largest: readonly FileWeight[];
}

/** How many of the heaviest files a ceiling message names. */
const CEILING_NAMED_FILES = 5;

/** `undefined` when the weight is at or under `max`, or when no ceiling is set. */
export function checkCeiling(
  weight: InstructionWeight,
  max: number | undefined,
): CeilingVerdict | undefined {
  if (max === undefined) return undefined;
  const { total, unit, files } = entryFor(weight);
  if (total <= max) return undefined;
  return {
    total,
    max,
    unit,
    largest: Object.entries(files)
      .map(([path, size]) => ({ path, size }))
      .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
      .slice(0, CEILING_NAMED_FILES),
  };
}

/** Replace the measured bundles' entries; `null` removes one. Others are kept. */
export function recordEntries(
  previous: InstructionBaseline | undefined,
  measured: readonly (readonly [string, BaselineEntry | null])[],
): InstructionBaseline {
  const removed = new Set(
    measured.filter(([, e]) => e === null).map(([at]) => at),
  );
  const kept = Object.entries(previous?.bundles ?? {}).filter(
    ([at]) => !removed.has(at),
  );
  const fresh = measured.flatMap(([at, e]): [string, BaselineEntry][] =>
    e === null ? [] : [[at, e]],
  );
  const bundles = Object.fromEntries(
    [...new Map([...kept, ...fresh]).entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  // Version 2 only when some entry carries a part — see the header: a repo
  // with nothing to add keeps a file every release can read.
  const withParts = Object.values(bundles).some((e) => e.parts !== undefined);
  return { version: withParts ? INSTRUCTION_BASELINE_VERSION : 1, bundles };
}

/** Stable text: sorted keys, two-space indent, trailing newline, no timestamp. */
export function serializeBaseline(baseline: InstructionBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

const n = (x: number): string => x.toLocaleString("en-US");
const signed = (x: number): string => (x > 0 ? `+${n(x)}` : n(x));

function describeChange(c: FileChange): string {
  if (c.from === null) return `${c.path} +${n(c.to ?? 0)} (new)`;
  if (c.to === null) return `${c.path} -${n(c.from)} (gone)`;
  return `${c.path} ${signed(c.to - c.from)}`;
}

/** A re-record request: what counts changed in vigiles, not in the files. */
function measureChangedText(
  verdict: Extract<RatchetVerdict, { kind: "measure-changed" }>,
  where: string,
): string {
  const whose =
    verdict.part === undefined ? "" : `'s ${PART_LABEL[verdict.part]}`;
  return (
    `${where}the instruction-weight baseline${whose} was recorded by measurement ${String(verdict.recorded)}, this vigiles uses ${String(verdict.current)} — ` +
    `what counts changed in vigiles, not in your files. Re-record it with \`${UPDATE_BASELINE_COMMAND}\``
  );
}

/** The one-paragraph message a verdict prints as, prefixed by its bundle. */
export function formatVerdict(
  verdict: RatchetVerdict,
  at: string,
  subject = "always-loaded instructions",
): string {
  const where = at === "." ? "" : `${at}: `;
  switch (verdict.kind) {
    case "unrecorded":
      return (
        `${where}no instruction-weight baseline recorded (${n(verdict.current.total)} ${verdict.current.unit} always loaded) — ` +
        `run \`${UPDATE_BASELINE_COMMAND}\` and commit ${INSTRUCTION_BASELINE_FILE} to stop it growing unnoticed`
      );
    case "unit-changed":
      return (
        `${where}the instruction-weight baseline is in ${verdict.recorded} but this harness counts ${verdict.current} — ` +
        `re-record it with \`${UPDATE_BASELINE_COMMAND}\``
      );
    case "measure-changed":
      return measureChangedText(verdict, where);
    case "held":
      return `${where}${subject} held at ${n(verdict.total)} ${verdict.unit} (baseline)`;
    case "grew":
    case "shrank":
      return movedText(verdict, `${where}${subject}`);
  }
}

/** A grew/shrank message: the delta, every file that moved, and what to do. */
function movedText(
  verdict: Extract<RatchetVerdict, { kind: "grew" | "shrank" }>,
  who: string,
): string {
  const head = `${n(verdict.from)} → ${n(verdict.to)} ${verdict.unit} (${signed(verdict.to - verdict.from)})`;
  const moved =
    verdict.changes.length > 0
      ? ` Changed: ${verdict.changes.map(describeChange).join(", ")}.`
      : "";
  return verdict.kind === "grew"
    ? `${who} grew ${head} over the recorded baseline.${moved} ` +
        `If the growth is intended, record it with \`${UPDATE_BASELINE_COMMAND}\` — the diff of ${INSTRUCTION_BASELINE_FILE} is the review. If it is not:\n${MOVE_OUT_OF_ALWAYS_LOADED}`
    : `${who} shrank ${head}; the baseline still allows the old weight.${moved} ` +
        `Lock the cut in with \`${UPDATE_BASELINE_COMMAND}\`, or the headroom can be regrown without a finding.`;
}

/** "instructions 24,665 · output style 8,616 (+200) · skill listing 31,210". */
function describeMoves(moves: readonly PartMove[]): string {
  return moves
    .map((m) => {
      const label =
        m.part === "instructions" ? "instructions" : PART_LABEL[m.part];
      const delta = m.to === m.from ? "" : ` (${signed(m.to - m.from)})`;
      return `${label} ${n(m.to)}${delta}`;
    })
    .join(" · ");
}

/** The message for one bundle's {@link BaselineVerdict}, prefixed by its bundle. */
export function formatBaselineVerdict(
  verdict: BaselineVerdict,
  at: string,
): string {
  if (verdict.kind === "instructions-only") {
    return formatVerdict(verdict.verdict, at);
  }
  const text = formatVerdict(verdict.verdict, at, "fixed context");
  return verdict.byPart.length === 0
    ? text
    : `${text}
  ${describeMoves(verdict.byPart)}`;
}

/**
 * The NOTE a version-1 file gets for each part that is not zero: always
 * loaded, not yet in the baseline, and what recording it does — including the
 * one cost of recording, an older vigiles reading the new file as unreadable.
 */
export function formatUnrecordedParts(
  parts: readonly { readonly part: FixedPartName; readonly total: number }[],
  unit: BaselineEntry["unit"],
  at: string,
): string {
  const where = at === "." ? "" : `${at}: `;
  const what = parts
    .map((p) => `${PART_LABEL[p.part]} (${n(p.total)} ${unit})`)
    .join(" and ");
  return (
    `${where}${what} load at session start but are not in the baseline — ` +
    `\`${UPDATE_BASELINE_COMMAND}\` adds them (the file becomes version 2) and the gate becomes their sum with the instructions. ` +
    `Upgrade vigiles wherever lint runs first: an older release cannot read version 2 and reports the file as unreadable.`
  );
}

/** The message for a total over the ceiling, prefixed by its bundle. */
export function formatCeiling(verdict: CeilingVerdict, at: string): string {
  const where = at === "." ? "" : `${at}: `;
  const biggest = verdict.largest
    .map((f) => `${f.path} ${n(f.size)}`)
    .join(", ");
  return (
    `${where}always-loaded instructions are ${n(verdict.total)} ${verdict.unit}, ` +
    `max ${n(verdict.max)} — ${n(verdict.total - verdict.max)} over. ` +
    `Largest: ${biggest}.\n` +
    `${MOVE_OUT_OF_ALWAYS_LOADED}\n` +
    `Moving text to another always-loaded file does not help, ` +
    `and re-recording the baseline does not lift the ceiling.`
  );
}

/** Why `--update-baseline` wrote nothing: the ceiling it would have been recorded above. */
export function formatRefusal(verdict: CeilingVerdict, at: string): string {
  const where = at === "." ? "" : `${at}: `;
  return (
    `${where}refusing to record ${INSTRUCTION_BASELINE_FILE}: ` +
    `${n(verdict.total)} ${verdict.unit} is over the configured max ${n(verdict.max)} ` +
    `(${n(verdict.total - verdict.max)} over). A baseline above the ceiling would bypass it — ` +
    `get under it first, then run \`${UPDATE_BASELINE_COMMAND}\` again.\n${MOVE_OUT_OF_ALWAYS_LOADED}`
  );
}

/** The compile-time one-liner: weight now, against the baseline when there is one. */
export function formatWeightLine(
  verdict: RatchetVerdict,
  label = "always-loaded",
): string {
  switch (verdict.kind) {
    case "unrecorded":
      return `${label}: ${n(verdict.current.total)} ${verdict.current.unit} (no baseline — \`${UPDATE_BASELINE_COMMAND}\`)`;
    case "unit-changed":
      return `${label}: baseline is in ${verdict.recorded}, this harness counts ${verdict.current}`;
    case "measure-changed":
      return `${label}: baseline recorded by measurement ${String(verdict.recorded)}, this vigiles uses ${String(verdict.current)} — re-record`;
    case "held":
      return `${label}: ${n(verdict.total)} ${verdict.unit} (baseline ${n(verdict.total)}, ±0)`;
    case "grew":
    case "shrank":
      return `${label}: ${n(verdict.to)} ${verdict.unit} (baseline ${n(verdict.from)}, ${signed(verdict.to - verdict.from)})`;
  }
}
