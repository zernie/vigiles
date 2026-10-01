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
  compareToBaseline,
  entryFor,
  formatVerdict,
  formatWeightLine,
  parseInstructionBaseline,
  recordEntries,
  serializeBaseline,
  type InstructionBaseline,
  type ParsedBaseline,
  type RatchetVerdict,
} from "./core/instruction-baseline.js";
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

/** One bundle's measurement: where it is, and its weight (`null` = nothing to weigh). */
export type MeasuredBundle = readonly [
  at: string,
  weight: InstructionWeight | null,
];

/** Write the baseline for every measured bundle; returns what was written. */
export function writeInstructionBaseline(
  root: string,
  onDisk: BaselineOnDisk,
  measured: readonly MeasuredBundle[],
): InstructionBaseline {
  const next = recordEntries(
    onDisk.kind === "ok" ? onDisk.baseline : undefined,
    measured.map(([at, w]) => [at, w === null ? null : entryFor(w)] as const),
  );
  const path = join(root, INSTRUCTION_BASELINE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBaseline(next));
  return next;
}

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
 *
 * A bundle with no entry is a nudge while the repo has NO baseline file (it has
 * not opted in, and a fresh repo must not fail on day one) — but a FINDING once
 * the file exists: a bundle that appeared after the baseline was recorded is
 * weight nobody signed off on.
 */
export function ratchetLines(
  onDisk: BaselineOnDisk,
  measured: readonly MeasuredBundle[],
): readonly RatchetLine[] {
  if (onDisk.kind === "invalid") {
    return [
      {
        at: ".",
        status: "finding",
        text:
          `${INSTRUCTION_BASELINE_FILE} cannot be read (${onDisk.message}) — ` +
          `re-record it with \`${UPDATE_BASELINE_COMMAND}\``,
      },
    ];
  }
  const recorded = onDisk.kind === "ok" ? onDisk.baseline.bundles : {};
  return measured.flatMap(([at, weight]): RatchetLine[] => {
    if (weight === null) return [];
    const verdict: RatchetVerdict = compareToBaseline(
      weight,
      Object.hasOwn(recorded, at) ? recorded[at] : undefined,
    );
    const status: RatchetLine["status"] =
      verdict.kind === "held"
        ? "ok"
        : verdict.kind === "unrecorded" && onDisk.kind !== "ok"
          ? "note"
          : "finding";
    // An import named and not read is weight this number lacks — a second
    // hop, or a path that does not resolve. Said on the line itself, because
    // the gate holding is only as true as the sum it holds.
    const unfollowed =
      weight.unreadImports.length > 0
        ? ` (${String(weight.unreadImports.length)} import(s) not followed: ${weight.unreadImports.join(", ")} — their size is not in this number)`
        : "";
    return [{ at, status, text: `${formatVerdict(verdict, at)}${unfollowed}` }];
  });
}

/** Run the ratchet for `lint`: print, annotate, count. */
export function checkInstructionWeightRatchet(opts: {
  readonly root: string;
  readonly severity: RuleSeverity;
  readonly update: boolean;
  readonly silent: boolean;
  /** Called only when the rule is on or an update was asked for. */
  readonly measure: () => readonly MeasuredBundle[];
  readonly annotate: (level: "error" | "warning", message: string) => void;
}): { issues: number; errors: number } {
  const { severity, update, silent } = opts;
  if (!severity && !update) return { issues: 0, errors: 0 };
  const measured = opts.measure();
  const before = readInstructionBaseline(opts.root);
  const onDisk: BaselineOnDisk = update
    ? {
        kind: "ok",
        baseline: writeInstructionBaseline(opts.root, before, measured),
      }
    : before;
  const lines = severity ? ratchetLines(onDisk, measured) : [];
  const findings = lines.filter((l) => l.status === "finding");
  if (!silent && (update || lines.length > 0)) {
    console.log("\nInstruction-weight ratchet:\n");
    if (update) console.log(`  ✓ recorded ${INSTRUCTION_BASELINE_FILE}`);
    const marks = {
      finding: severity === "error" ? "✗" : "⚠",
      ok: "✓",
      note: "ℹ",
    } as const;
    lines.forEach((l) => {
      console.log(`  ${marks[l.status]} ${l.text}`);
    });
  }
  const level = severity === "error" ? "error" : "warning";
  findings.forEach((l) => {
    opts.annotate(level, l.text);
  });
  return {
    issues: findings.length,
    errors: severity === "error" ? findings.length : 0,
  };
}

/**
 * The line `compile` prints after writing instruction files: the weight NOW,
 * against the baseline, at the moment the author changed it. Report-only —
 * `lint` stays the single gate. `null` when there is nothing to weigh.
 */
export function compileWeightLine(
  root: string,
  weight: InstructionWeight | null,
): string | null {
  if (weight === null) return null;
  const onDisk = readInstructionBaseline(root);
  if (onDisk.kind === "invalid") {
    return `always-loaded: ${INSTRUCTION_BASELINE_FILE} cannot be read (${onDisk.message})`;
  }
  const recorded = onDisk.kind === "ok" ? onDisk.baseline.bundles : {};
  return formatWeightLine(
    compareToBaseline(
      weight,
      Object.hasOwn(recorded, ".") ? recorded["."] : undefined,
    ),
  );
}
