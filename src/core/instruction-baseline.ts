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
 * Pure: parsing, comparison and formatting only. Reading and writing the file
 * is the caller's (`src/instruction-weight-ratchet.ts`).
 */
import { z } from "zod";

import type { InstructionWeight } from "./instruction-weight.js";

/** Where the baseline lives, relative to the directory `.vigilesrc.json` is read from. */
export const INSTRUCTION_BASELINE_FILE = ".vigiles/instruction-weight.json";

/** The command that writes the baseline — named once, quoted by every message. */
export const UPDATE_BASELINE_COMMAND = "vigiles lint --update-baseline";

/** Bumped only on an incompatible change to the on-disk shape. */
export const INSTRUCTION_BASELINE_VERSION = 1;

const entrySchema = z
  .object({
    unit: z.enum(["chars", "bytes"]),
    total: z.number().int().nonnegative(),
    files: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
  .refine(
    (e) => Object.values(e.files).reduce((a, b) => a + b, 0) === e.total,
    {
      message:
        "`total` is not the sum of `files` — the file was edited by hand; re-record it",
    },
  );

const baselineSchema = z
  .object({
    version: z.literal(INSTRUCTION_BASELINE_VERSION),
    /** Keyed by bundle location from the config root; `.` is the root itself. */
    bundles: z.record(z.string(), entrySchema),
  })
  .strict();

/** One bundle's recorded weight. */
export type BaselineEntry = z.infer<typeof entrySchema>;
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

/** What a measured weight would be recorded as: the SCORED files only. */
export function entryFor(weight: InstructionWeight): BaselineEntry {
  const scored = weight.files.filter((f) => f.scope === "repo");
  return {
    unit: weight.unit,
    total: weight.committedTotal,
    files: Object.fromEntries(
      [...scored]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => [f.path, f.size]),
    ),
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
  const current = entryFor(weight);
  if (recorded === undefined) return { kind: "unrecorded", current };
  if (recorded.unit !== current.unit) {
    return {
      kind: "unit-changed",
      recorded: recorded.unit,
      current: current.unit,
    };
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
  return {
    version: INSTRUCTION_BASELINE_VERSION,
    bundles: Object.fromEntries(
      [...new Map([...kept, ...fresh]).entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
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

/** The one-paragraph message a verdict prints as, prefixed by its bundle. */
export function formatVerdict(verdict: RatchetVerdict, at: string): string {
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
    case "held":
      return `${where}always-loaded instructions held at ${n(verdict.total)} ${verdict.unit} (baseline)`;
    case "grew":
    case "shrank": {
      const head = `${n(verdict.from)} → ${n(verdict.to)} ${verdict.unit} (${signed(verdict.to - verdict.from)})`;
      const moved =
        verdict.changes.length > 0
          ? ` Changed: ${verdict.changes.map(describeChange).join(", ")}.`
          : "";
      return verdict.kind === "grew"
        ? `${where}always-loaded instructions grew ${head} over the recorded baseline.${moved} ` +
            `If the growth is intended, record it with \`${UPDATE_BASELINE_COMMAND}\` — the diff of ${INSTRUCTION_BASELINE_FILE} is the review.`
        : `${where}always-loaded instructions shrank ${head}; the baseline still allows the old weight.${moved} ` +
            `Lock the cut in with \`${UPDATE_BASELINE_COMMAND}\`, or the headroom can be regrown without a finding.`;
    }
  }
}

/** The compile-time one-liner: weight now, against the baseline when there is one. */
export function formatWeightLine(verdict: RatchetVerdict): string {
  switch (verdict.kind) {
    case "unrecorded":
      return `always-loaded: ${n(verdict.current.total)} ${verdict.current.unit} (no baseline — \`${UPDATE_BASELINE_COMMAND}\`)`;
    case "unit-changed":
      return `always-loaded: baseline is in ${verdict.recorded}, this harness counts ${verdict.current}`;
    case "held":
      return `always-loaded: ${n(verdict.total)} ${verdict.unit} (baseline ${n(verdict.total)}, ±0)`;
    case "grew":
    case "shrank":
      return `always-loaded: ${n(verdict.to)} ${verdict.unit} (baseline ${n(verdict.from)}, ${signed(verdict.to - verdict.from)})`;
  }
}
