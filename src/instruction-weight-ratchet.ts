/**
 * `lint`'s side of the instruction-weight ratchet: measure each scored bundle,
 * compare it with `.vigiles/instruction-weight.json`, and — only under the
 * explicit `--update-baseline` — write that file.
 *
 * The decisions (what a verdict is, what it says) live in
 * `core/instruction-baseline.ts`; this module owns the two effects the core
 * must not have, reading and writing the committed file, plus turning verdicts
 * into lint counters.
 *
 * WHY THE FILE IS COMMITTED, unlike `.vigiles/coverage.json`. Coverage records
 * what tests ran on THIS machine, so a committed copy would credit a checkout
 * where nothing ran. The baseline records a property of the COMMIT: it is built
 * from `committedTotal`, which already leaves out every per-machine file
 * (`CLAUDE.local.md`, a gitignored settings sibling), so two clones of one
 * commit compute byte-identical files. That is what lets CI compare against it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  INSTRUCTION_BASELINE_FILE,
  UPDATE_BASELINE_COMMAND,
  checkCeiling,
  carryUnmeasured,
  compareFixedToBaseline,
  describeUnmeasured,
  entryFor,
  formatBaselineVerdict,
  formatCeiling,
  formatRefusal,
  formatUnrecordedParts,
  formatWeightLine,
  parseInstructionBaseline,
  recordEntries,
  serializeBaseline,
  type BaselineEntry,
  type BaselineFileVersion,
  type BaselineVerdict,
  type InstructionBaseline,
  type ParsedBaseline,
} from "./core/instruction-baseline.js";
import type { FixedContext } from "./core/fixed-context.js";
import type { InstructionWeight } from "./core/instruction-weight.js";
import type { RuleSeverity } from "./core/types.js";

/** The file on disk, read once: absent, parsed, or refused. */
export type BaselineOnDisk = { readonly kind: "absent" } | ParsedBaseline;

export function readInstructionBaseline(root: string): BaselineOnDisk {
  const path = join(root, INSTRUCTION_BASELINE_FILE);
  return existsSync(path)
    ? parseInstructionBaseline(readFileSync(path, "utf-8"))
    : { kind: "absent" };
}

/**
 * One bundle's measurement: where it is, and either nothing to weigh or its
 * weight WITH the fixed context around it. One union, not an optional third
 * element: a weight without its fixed context used to read as "no parts", so a
 * recorded part was compared as 0 — a shrink nobody made.
 */
export type MeasuredBundle =
  | readonly [at: string, weight: null]
  | readonly [at: string, weight: InstructionWeight, fixed: FixedContext];

/** Write the baseline for every measured bundle; returns what was written. */
export function writeInstructionBaseline(
  root: string,
  onDisk: BaselineOnDisk,
  measured: readonly MeasuredBundle[],
): InstructionBaseline {
  const previous = onDisk.kind === "ok" ? onDisk.baseline : undefined;
  const next = recordEntries(
    previous,
    measured.map((m) => [m[0], recordedEntry(m, previous)] as const),
  );
  const path = join(root, INSTRUCTION_BASELINE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBaseline(next));
  return next;
}

/**
 * What `--update-baseline` writes for one bundle: the measured entry, with
 * every part the old entry records and this run cannot measure carried over —
 * re-recording must not drop a part only because the adapter stopped modelling
 * it (`carryUnmeasured`).
 */
function recordedEntry(
  m: MeasuredBundle,
  previous: Readonly<InstructionBaseline> | undefined,
): BaselineEntry | null {
  if (m[1] === null) return null;
  const [at, weight, fixed] = m;
  const old = entryAt(previous?.bundles ?? {}, at);
  return carryUnmeasured(entryFor(weight, fixed), fixed, old).entry;
}

/** One bundle's recorded entry, or `undefined` when the file has none. */
const entryAt = (
  bundles: Readonly<InstructionBaseline["bundles"]>,
  at: string,
): BaselineEntry | undefined =>
  Object.hasOwn(bundles, at) ? bundles[at] : undefined;

/**
 * One line of lint output. `finding` counts toward the exit code; `ok` is the
 * baseline holding; `note` is the opt-in nudge on a repo with no baseline.
 */
export interface RatchetLine {
  readonly at: string;
  readonly status: "finding" | "ok" | "note";
  readonly text: string;
}

/**
 * Pure: the lines a run prints, given what was measured and what is on disk.
 * `max` is the opt-in absolute ceiling; a bundle over it adds a finding of its
 * own, whatever the baseline says (including when there is none, or it is
 * unreadable).
 *
 * A bundle with no entry is a nudge while the repo has NO baseline file (it has
 * not opted in, and a fresh repo must not fail on day one) — but a FINDING once
 * the file exists: a bundle that appeared after the baseline was recorded is
 * weight nobody signed off on.
 */
export function ratchetLines(
  onDisk: BaselineOnDisk,
  measured: readonly MeasuredBundle[],
  max?: number,
): readonly RatchetLine[] {
  return [
    ...baselineLines(onDisk, measured),
    ...measured.flatMap(([at, weight]) => ceilingLine(at, weight, max)),
  ];
}

/** One bundle's ceiling finding, or nothing when it is at or under `max`. */
function ceilingLine(
  at: string,
  weight: InstructionWeight | null,
  max: number | undefined,
): readonly RatchetLine[] {
  const over = weight === null ? undefined : checkCeiling(weight, max);
  return over === undefined
    ? []
    : [{ at, status: "finding", text: formatCeiling(over, at) }];
}

/** The one finding an unreadable baseline file gets. */
const unreadableLine = (message: string): RatchetLine => ({
  at: ".",
  status: "finding",
  text:
    `${INSTRUCTION_BASELINE_FILE} cannot be read (${message}) — ` +
    `re-record it with \`${UPDATE_BASELINE_COMMAND}\``,
});

function baselineLines(
  onDisk: BaselineOnDisk,
  measured: readonly MeasuredBundle[],
): readonly RatchetLine[] {
  if (onDisk.kind === "invalid") return [unreadableLine(onDisk.message)];
  const recorded = onDisk.kind === "ok" ? onDisk.baseline.bundles : {};
  const file: BaselineFileVersion =
    onDisk.kind === "ok" ? onDisk.baseline.version : "absent";
  return measured.flatMap((m): RatchetLine[] => {
    if (m[1] === null) return [];
    const [at, weight, fixed] = m;
    const verdict = compareFixedToBaseline(
      weight,
      fixed,
      entryAt(recorded, at),
      file,
    );
    const text = `${formatBaselineVerdict(verdict, at)}${unfollowedNote(weight)}`;
    return [
      { at, status: lineStatus(verdict, onDisk), text },
      ...partNotes(verdict, weight.unit, at),
    ];
  });
}

/**
 * `held` is ok; a bundle with no entry is a nudge while the repo has no
 * baseline file — every other verdict is a finding.
 */
function lineStatus(
  verdict: BaselineVerdict,
  onDisk: BaselineOnDisk,
): RatchetLine["status"] {
  if (verdict.verdict.kind === "held") return "ok";
  return verdict.verdict.kind === "unrecorded" && onDisk.kind !== "ok"
    ? "note"
    : "finding";
}

/**
 * An import named and not read is weight this number lacks — a second hop, or
 * a path that does not resolve. Said on the line itself, because the gate
 * holding is only as true as the sum it holds.
 */
function unfollowedNote(weight: InstructionWeight): string {
  return weight.unreadImports.length > 0
    ? ` (${String(weight.unreadImports.length)} import(s) not followed: ${weight.unreadImports.join(", ")} — their size is not in this number)`
    : "";
}

/**
 * A version-1 file's NOTE for parts that are not in it. Never a finding: a
 * repo whose file predates the fixed context must not go red on upgrade — it
 * records the parts when it chooses to, and they gate from then on.
 */
function partNotes(
  verdict: BaselineVerdict,
  unit: InstructionWeight["unit"],
  at: string,
): readonly RatchetLine[] {
  return verdict.kind === "instructions-only" &&
    verdict.unrecordedParts.length > 0
    ? [
        {
          at,
          status: "note",
          text: formatUnrecordedParts(verdict.unrecordedParts, unit, at),
        },
      ]
    : [];
}

/**
 * The bundles `--update-baseline` must not record: each one over the ceiling,
 * as the refusal text. Empty when there is no ceiling or nothing exceeds it.
 */
export function updateRefusals(
  measured: readonly MeasuredBundle[],
  max: number | undefined,
): readonly string[] {
  return measured.flatMap(([at, weight]) => {
    const over = weight === null ? undefined : checkCeiling(weight, max);
    return over === undefined ? [] : [formatRefusal(over, at)];
  });
}

/** The options {@link checkInstructionWeightRatchet} takes. */
interface RatchetOptions {
  readonly root: string;
  readonly severity: RuleSeverity;
  /** The opt-in absolute ceiling (`["error", { max }]`); `undefined` = ratchet only. */
  readonly max?: number;
  readonly update: boolean;
  readonly silent: boolean;
  /** Called only when the rule is on or an update was asked for. */
  readonly measure: () => readonly MeasuredBundle[];
  readonly annotate: (level: "error" | "warning", message: string) => void;
}

/**
 * What `lint` compares against: the file as it is, or — under `--update-baseline`
 * and when nothing is over the ceiling — the file just written. A baseline above
 * the ceiling would bypass it (re-recording is how a ratchet gets loosened), so
 * then nothing is written and the refusals are returned for the caller to fail on.
 */
function recordOrRead(
  opts: RatchetOptions,
  measured: readonly MeasuredBundle[],
): { readonly onDisk: BaselineOnDisk; readonly refusals: readonly string[] } {
  const before = readInstructionBaseline(opts.root);
  const refusals = opts.update ? updateRefusals(measured, opts.max) : [];
  const record = opts.update && refusals.length === 0;
  return {
    refusals,
    onDisk: record
      ? {
          kind: "ok",
          baseline: writeInstructionBaseline(opts.root, before, measured),
        }
      : before,
  };
}

/** The human-readable report: what was recorded, then one line per bundle. */
function printReport(
  lines: readonly RatchetLine[],
  severity: RuleSeverity,
  recorded: boolean,
): void {
  console.log("\nInstruction-weight ratchet:\n");
  if (recorded) console.log(`  ✓ recorded ${INSTRUCTION_BASELINE_FILE}`);
  const marks = {
    finding: severity === "error" ? "✗" : "⚠",
    ok: "✓",
    note: "ℹ",
  } as const;
  lines.forEach((l) => {
    console.log(`  ${marks[l.status]} ${l.text}`);
  });
}

/** Run the ratchet for `lint`: print, annotate, count. */
export function checkInstructionWeightRatchet(opts: RatchetOptions): {
  issues: number;
  errors: number;
} {
  const { severity, update, silent } = opts;
  if (!severity && !update) return { issues: 0, errors: 0 };
  const measured = opts.measure();
  const { onDisk, refusals } = recordOrRead(opts, measured);
  refusals.forEach((message) => {
    console.error(`✗ ${message}`);
    opts.annotate("error", message);
  });
  const lines = severity ? ratchetLines(onDisk, measured, opts.max) : [];
  const findings = lines.filter((l) => l.status === "finding");
  if (!silent && (update || lines.length > 0)) {
    printReport(lines, severity, update && refusals.length === 0);
  }
  const level = severity === "error" ? "error" : "warning";
  findings.forEach((l) => {
    opts.annotate(level, l.text);
  });
  return {
    issues: findings.length + refusals.length,
    errors: (severity === "error" ? findings.length : 0) + refusals.length,
  };
}

/**
 * The line `compile` prints after writing instruction files: the weight NOW,
 * against the baseline, at the moment the author changed it. Report-only —
 * `lint` stays the single gate. `null` when there is nothing to weigh.
 */
export function compileWeightLine(
  root: string,
  measured: MeasuredBundle,
): string | null {
  if (measured[1] === null) return null;
  const [, weight, fixed] = measured;
  const onDisk = readInstructionBaseline(root);
  if (onDisk.kind === "invalid") {
    return `always-loaded: ${INSTRUCTION_BASELINE_FILE} cannot be read (${onDisk.message})`;
  }
  const recorded = onDisk.kind === "ok" ? onDisk.baseline.bundles : {};
  const verdict = compareFixedToBaseline(
    weight,
    fixed,
    entryAt(recorded, "."),
    onDisk.kind === "ok" ? onDisk.baseline.version : "absent",
  );
  const line = formatWeightLine(
    verdict.verdict,
    verdict.kind === "fixed" ? "fixed context" : "always-loaded",
  );
  return verdict.kind === "fixed" && verdict.unmeasured.length > 0
    ? [line, ...verdict.unmeasured.map(describeUnmeasured)].join("\n  ")
    : line;
}
