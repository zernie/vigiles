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
  toEntry,
  type BaselineEntry,
  type Measurement,
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

const legacyPart = z.object({ measure: size, total: size, files }).strict();

const legacyEntry = z
  .object({
    unit: z.enum(["chars", "bytes"]),
    measure: size,
    total: size,
    files,
    parts: z
      .object({
        "output-style": legacyPart.optional(),
        "skill-listing": legacyPart.optional(),
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
  const json = ((): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  })();
  if (!json.ok) return { kind: "invalid", message: "not valid JSON" };
  const parsed = legacyFile.safeParse(json.value);
  return parsed.success
    ? { kind: "ok", file: parsed.data }
    : {
        kind: "invalid",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      };
}

/**
 * One old entry as a store entry, or `undefined` when the old file has no
 * entry for this bundle. `current` fills the parts a version-1 file never
 * recorded; a measurement version other than the one earlier releases wrote
 * becomes measure 0, which the store reads as "re-record".
 */
export function convertLegacyEntry(
  legacy: Extract<LegacyBaseline, { kind: "ok" }>,
  at: string,
  current: Measurement,
): BaselineEntry | undefined {
  const bundles = legacy.file.bundles;
  if (!Object.hasOwn(bundles, at)) return undefined;
  const old = bundles[at];
  const recordedParts = old.parts ?? {};
  const sameMeasure =
    old.measure === LEGACY_MEASURE &&
    Object.values(recordedParts).every((p) => p.measure === LEGACY_MEASURE);
  const part = (
    name: "output-style" | "skill-listing",
  ): Measurement["parts"] => {
    const p = recordedParts[name];
    if (p !== undefined) return { [name]: { value: p.total, files: p.files } };
    // Version 2 wrote only the parts that were not zero; version 1 none at all.
    if (legacy.file.version === 2) return { [name]: { value: 0 } };
    const now = current.parts?.[name];
    return now === undefined ? {} : { [name]: now };
  };
  const parts = {
    instructions: { value: old.total, files: old.files },
    ...part("output-style"),
    ...part("skill-listing"),
  };
  return toEntry(
    {
      unit: old.unit,
      measure: sameMeasure ? ALWAYS_LOADED_MEASURE : 0,
      parts,
      value: 0,
    },
    undefined,
  );
}
