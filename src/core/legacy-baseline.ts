/**
 * The always-loaded baseline as earlier releases wrote it, in its own file —
 * read ONLY to migrate it into the baseline store (`./baseline-store.ts`).
 * Nothing compares against it: a file `lint` no longer reads must say so, not
 * keep gating under an old name. The file is named after the rule
 * (`.vigiles/<rule-id>.json`), or `.vigiles/instruction-weight.json` from
 * before the rule's rename.
 *
 * WHAT MIGRATING KEEPS. The recorded numbers, not the tree's current size:
 * re-measuring while migrating would accept, unseen, whatever growth landed
 * since the old file was last recorded. So each old entry becomes a store
 * entry with the same instructions total and the same parts. A version-1
 * file never recorded the output style or the skill listing (it printed a
 * note for them instead), so those parts are taken at their current size —
 * they were never gated, and recording them is what the note asked for.
 *
 * Pure: parsing and conversion. Finding and deleting the files is the caller's.
 */
import { z } from "zod";

import {
  readJson,
  toEntry,
  type BaselineEntry,
  type Measurement,
  type MeasuredPart,
} from "./baseline-store.js";
import { ALWAYS_LOADED_MEASURE } from "./always-loaded-limits.js";

/** The file this baseline had before the rule was renamed. */
export const PRE_RENAME_BASELINE_FILE = ".vigiles/instruction-weight.json";

/** Every old file name, newest first: the rule's own name, then the pre-rename one. */
export const legacyBaselineFiles = (ruleId: string): readonly string[] => [
  `.vigiles/${ruleId}.json`,
  PRE_RENAME_BASELINE_FILE,
];

/** The one measurement version earlier releases recorded, for the file and every part. */
const LEGACY_MEASURE = 1;

const size = z.number().int().nonnegative();
const files = z.record(z.string(), size);

const legacyPartSchema = z
  .object({ measure: size, total: size, files })
  .strict();

const legacyEntry = z
  .object({
    unit: z.enum(["chars", "bytes"]),
    measure: size,
    total: size,
    files,
    parts: z
      .object({
        "output-style": legacyPartSchema.optional(),
        "skill-listing": legacyPartSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const legacyFile = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    bundles: z.record(z.string(), legacyEntry),
  })
  .strict();

/** The old file, parsed: its bundles, or why it cannot be converted. */
export type LegacyBaseline =
  | { readonly kind: "ok"; readonly file: z.infer<typeof legacyFile> }
  | { readonly kind: "invalid"; readonly message: string };

export function parseLegacyBaseline(text: string): LegacyBaseline {
  const json = readJson(text);
  if (!json.ok) return { kind: "invalid", message: "not valid JSON" };
  const parsed = legacyFile.safeParse(json.value);
  return parsed.success
    ? { kind: "ok", file: parsed.data }
    : {
        kind: "invalid",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      };
}

type LegacyEntry = z.infer<typeof legacyEntry>;
type PartName = "output-style" | "skill-listing";

/**
 * One part of an old entry as a measured part: as recorded; zero when a
 * version-2 file left it out (it wrote only parts that were not zero); today's
 * size when a version-1 file never recorded it.
 */
function legacyPart(
  old: Readonly<LegacyEntry>,
  version: 1 | 2,
  name: PartName,
  current: Measurement | undefined,
): Readonly<Record<string, MeasuredPart>> {
  const p = old.parts?.[name];
  if (p !== undefined) return { [name]: { value: p.total, files: p.files } };
  if (version === 2) return { [name]: { value: 0 } };
  const now = current?.parts?.[name];
  return now === undefined ? {} : { [name]: now };
}

/** Whether every number in the old entry was taken by the one measurement earlier releases had. */
const sameMeasure = (old: Readonly<LegacyEntry>): boolean =>
  old.measure === LEGACY_MEASURE &&
  Object.values(old.parts ?? {}).every((p) => p.measure === LEGACY_MEASURE);

/**
 * One old entry as a store entry, or `undefined` when the old file has no
 * entry for this bundle. `current` fills the parts a version-1 file never
 * recorded; for a bundle this run did not measure it is `undefined`, and
 * those parts stay unrecorded, exactly as the old file left them. A
 * measurement version other than the one earlier releases wrote becomes
 * measure 0, which the store reads as "re-record".
 */
export function convertLegacyEntry(
  legacy: Extract<LegacyBaseline, { kind: "ok" }>,
  at: string,
  current: Measurement | undefined,
): BaselineEntry | undefined {
  const { bundles, version } = legacy.file;
  if (!Object.hasOwn(bundles, at)) return undefined;
  const old = bundles[at];
  const parts = {
    instructions: { value: old.total, files: old.files },
    ...legacyPart(old, version, "output-style", current),
    ...legacyPart(old, version, "skill-listing", current),
  };
  return toEntry(
    {
      unit: old.unit,
      measure: sameMeasure(old) ? ALWAYS_LOADED_MEASURE : 0,
      parts,
      value: 0,
    },
    undefined,
  );
}
