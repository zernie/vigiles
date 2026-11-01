/**
 * Is what the harness loads at session start over the HARNESS'S OWN limits?
 * The one detector behind the `context-creep` rule and the audit's
 * always-loaded block, so the two can never disagree about which part is over.
 *
 * WHY A FIXED LIMIT, AND WHICH. No threshold here is vigiles's invention: each
 * adapter supplies the number its harness publishes or acts on, per part, read
 * from the pinned release (each `capturedFrom` names the artifact):
 *
 *   - instructions — the instruction budget (`InstructionBudget.limit`). The
 *     selected output style loads beside the instructions and has no limit of
 *     its own, so it is counted with them against this one;
 *   - skill listing — the listing budget (`SkillListingBudget`), past which the
 *     harness drops skill descriptions. A committed setting can move it.
 *
 * WHY THE LIMIT DOES NOT GATE ON ITS OWN. Real repositories sit several times
 * over the instruction budget, and a rule that fails every one of them on day
 * one is switched off on day one. So a part over its limit is a finding the
 * rule PRODUCES, carrying the measured sizes, and the baseline store
 * (`./baseline-store.ts`) decides afterwards whether the repository already
 * accepted that size: green at any size it recorded, red the day it grows. A
 * repository under every limit produces nothing, needs no file, and may grow
 * freely up to the limit.
 *
 * WHY THE SUM IS WHAT IS RECORDED. The measurement handed to the store is the
 * whole always-loaded context with its parts, not the part that is over: text
 * moved from the instructions into a skill description or the selected style
 * still loads on every request, and a per-part number would read that move as a
 * shrink (`./always-loaded.ts`).
 *
 * Pure.
 */
import type { AlwaysLoadedContext, LoadedPart } from "./always-loaded.js";
import { partTotal } from "./always-loaded.js";
import type { InstructionWeight } from "./instruction-weight.js";
import type { Measurement, MeasuredPart } from "./baseline-store.js";

/** The parts a limit applies to. The output style counts with the instructions. */
export type LimitedPart = "instructions" | "skill-listing";

/** Per-repository overrides, from the rule's options in `.vigilesrc.json`. */
export type LimitOverrides = Readonly<Partial<Record<LimitedPart, number>>>;

/** Where a limit came from — said in the message, so a reader can move it. */
export type LimitSource =
  | { readonly kind: "harness" }
  | { readonly kind: "setting"; readonly name: string }
  | { readonly kind: "config" };

/** One part against its limit. */
export interface PartLimit {
  readonly part: LimitedPart;
  readonly size: number;
  readonly limit: number;
  readonly source: LimitSource;
  /** What the harness does past it — said as a consequence, not a cost. */
  readonly onExceed: "warns" | "truncates" | "drops-descriptions";
}

/** Every part that has a limit, and which of them are over. */
export interface LimitCheck {
  readonly unit: "chars" | "bytes";
  /** Every limited part this harness and commit have, in print order. */
  readonly parts: readonly PartLimit[];
  /** The parts strictly over their limit. */
  readonly over: readonly PartLimit[];
}

/** The instructions' part: the committed instructions plus the selected style. */
function instructionsLimit(
  weight: InstructionWeight,
  loaded: AlwaysLoadedContext,
  overrides: LimitOverrides,
): PartLimit {
  const override = overrides.instructions;
  return {
    part: "instructions",
    size: loaded.instructions + partTotal(loaded.outputStyle),
    limit: override ?? weight.limit,
    source: override === undefined ? { kind: "harness" } : { kind: "config" },
    onExceed: weight.onExceed,
  };
}

/** The listing's part, or nothing when the listing or its budget is not modelled. */
function listingLimit(
  loaded: AlwaysLoadedContext,
  overrides: LimitOverrides,
): readonly PartLimit[] {
  const listing = loaded.skillListing;
  if (listing.kind !== "counted" && listing.kind !== "none") return [];
  const override = overrides["skill-listing"];
  const harness = loaded.skillListingLimit;
  if (override === undefined && harness.kind === "not-modelled") return [];
  const source = ((): LimitSource => {
    if (override !== undefined) return { kind: "config" };
    return harness.kind === "limit" && harness.setBy !== undefined
      ? { kind: "setting", name: harness.setBy }
      : { kind: "harness" };
  })();
  return [
    {
      part: "skill-listing",
      size: partTotal(listing),
      limit: override ?? (harness.kind === "limit" ? harness.limit : 0),
      source,
      onExceed: "drops-descriptions",
    },
  ];
}

/** Check each limited part against its limit. */
export function checkAlwaysLoadedLimits(
  weight: InstructionWeight,
  loaded: AlwaysLoadedContext,
  overrides: LimitOverrides = {},
): LimitCheck {
  const parts = [
    instructionsLimit(weight, loaded, overrides),
    ...listingLimit(loaded, overrides),
  ];
  return {
    unit: weight.unit,
    parts,
    over: parts.filter((p) => p.size > p.limit),
  };
}

/**
 * Which measurement produced a recorded context-creep number — bumped whenever
 * a release changes what counts in ANY part (chain membership, how a listing
 * entry is rendered), so consumers see one "re-record" verdict instead of
 * growth attributed to their own files.
 */
export const ALWAYS_LOADED_MEASURE = 1;

/** A part as the store records it: its size and files, `null` when not measurable. */
function measuredPart(part: LoadedPart): MeasuredPart {
  switch (part.kind) {
    case "counted":
      return {
        value: part.total,
        files: Object.fromEntries(part.files.map((f) => [f.path, f.size])),
      };
    case "none":
      return { value: 0 };
    case "not-supported":
    case "not-modelled":
    case "unresolved":
      return { value: null };
  }
}

/**
 * The always-loaded context as the store records it: the scored instruction
 * files (never a per-machine one), the selected style and the listing.
 */
export function alwaysLoadedMeasurement(
  weight: InstructionWeight,
  loaded: AlwaysLoadedContext,
): Measurement {
  const scored = weight.files.filter((f) => f.scope === "repo");
  const parts: Readonly<Record<string, MeasuredPart>> = {
    instructions: {
      value: weight.committedTotal,
      files: Object.fromEntries(scored.map((f) => [f.path, f.size])),
    },
    "output-style": measuredPart(loaded.outputStyle),
    "skill-listing": measuredPart(loaded.skillListing),
  };
  return {
    unit: weight.unit,
    measure: ALWAYS_LOADED_MEASURE,
    parts,
    value: Object.values(parts).reduce((sum, p) => sum + (p.value ?? 0), 0),
  };
}

const n = (x: number): string => x.toLocaleString("en-US");

const PART_LABEL: Readonly<Record<LimitedPart, string>> = {
  instructions: "instructions (with the selected output style)",
  "skill-listing": "skill listing",
};

/** What happens past a limit, as a behaviour. */
export const CONSEQUENCE: Readonly<Record<PartLimit["onExceed"], string>> = {
  warns:
    "the harness warns and still loads it, so every character is paid on every request",
  truncates:
    "the harness silently truncates past it, so the rules after the cut never reach the model",
  "drops-descriptions":
    "the harness drops skill descriptions past it, so some skills lose the text they trigger on",
};

/** Where the limit came from, in words. */
export function describeSource(source: LimitSource): string {
  switch (source.kind) {
    case "harness":
      return "the harness's own";
    case "setting":
      return `set by \`${source.name}\` in the committed settings`;
    case "config":
      return "set in .vigilesrc.json";
  }
}

/** One over-limit part, as a line. */
export function describeOver(p: PartLimit, unit: string): string {
  return (
    `${PART_LABEL[p.part]} ${n(p.size)} ${unit}, limit ${n(p.limit)} (${describeSource(p.source)}) — ` +
    `${n(p.size - p.limit)} over; ${CONSEQUENCE[p.onExceed]}`
  );
}

/** The finding text for a bundle with at least one part over its limit. */
export function formatOverLimit(check: LimitCheck, at: string): string {
  const where = at === "." ? "" : `${at}: `;
  const lines = check.over.map((p) => describeOver(p, check.unit));
  return `${where}always-loaded context is over the harness's limit: ${lines.join("; ")}`;
}

/** One file's size, for naming where the weight is. */
export interface FileWeight {
  readonly path: string;
  readonly size: number;
}

/**
 * A total above the opt-in absolute ceiling (`["error", { max }]`) — unlike a
 * limit, a ceiling no baseline lifts. Decided on the scored instructions
 * (`committedTotal`) in the harness's unit, without looking at the store: that
 * independence is what makes it a ceiling.
 */
export interface CeilingVerdict {
  readonly total: number;
  readonly max: number;
  readonly unit: "chars" | "bytes";
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
  if (max === undefined || weight.committedTotal <= max) return undefined;
  return {
    total: weight.committedTotal,
    max,
    unit: weight.unit,
    largest: weight.files
      .filter((f) => f.scope === "repo")
      .map((f) => ({ path: f.path, size: f.size }))
      .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
      .slice(0, CEILING_NAMED_FILES),
  };
}

/** The message for a total over the ceiling, prefixed by its bundle. */
export function formatCeiling(
  verdict: CeilingVerdict,
  at: string,
  remedy: string,
): string {
  const where = at === "." ? "" : `${at}: `;
  const biggest = verdict.largest
    .map((f) => `${f.path} ${n(f.size)}`)
    .join(", ");
  return (
    `${where}always-loaded instructions are ${n(verdict.total)} ${verdict.unit}, ` +
    `max ${n(verdict.max)} — ${n(verdict.total - verdict.max)} over. ` +
    `Largest: ${biggest}.\n${remedy}\n` +
    `Moving text to another always-loaded file does not help, ` +
    `and recording a baseline does not lift the ceiling.`
  );
}

/** What a refusal names: the file it did not write, the command to rerun, the cure. */
export interface RefusalText {
  readonly file: string;
  readonly command: string;
  readonly remedy: string;
}

/** Why `--update-baseline` wrote nothing: a ceiling the baseline would have sat above. */
export function formatRefusal(
  verdict: CeilingVerdict,
  at: string,
  { file, command, remedy }: RefusalText,
): string {
  const where = at === "." ? "" : `${at}: `;
  return (
    `${where}refusing to record ${file}: ` +
    `${n(verdict.total)} ${verdict.unit} is over the configured max ${n(verdict.max)} ` +
    `(${n(verdict.total - verdict.max)} over). Get under it first, then run \`${command}\` again.\n${remedy}`
  );
}
