/**
 * The local, agent-readable "flight recorder" ledger — `.vigiles/runs.jsonl`.
 *
 * The connective layer of the four-instrument loop (see the Direction section of
 * CLAUDE.md and `research/harness-observability-direction.md`): every instrument
 * (verify / gate / measure / observe) appends a typed record here, and the file is
 * read three ways off ONE schema — by `vigiles audit`, by the agent debugging its own
 * harness, and (later) by an aggregation surface.
 *
 * Harness-agnostic by construction: the record kinds are neutral concepts, so this
 * lives at the composition/library root (adapters + cli CALL it; it imports no adapter,
 * and it is NOT part of the reference-verification `core/` domain).
 *
 * Append is best-effort — recording must never break a live session.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  LEDGER_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "./local-files.js";

/** Bumped when the record shape changes in a non-additive way. */
export const OBSERVE_VERSION = 1;

/** The ledger filename under the `.vigiles/` directory — defined on the one local-files list. */
export { LEDGER_FILE };

/** Fields every record carries; `v`/`ts` are stamped by the writer, not the caller. */
export interface ObservationBase {
  /** schema version (`OBSERVE_VERSION`) */
  v: number;
  /** ISO-8601 timestamp */
  ts: string;
}

/** A gate/hook decision observed in a real session. */
export interface HookObservation extends ObservationBase {
  kind: "hook";
  event: string;
  decision: "allow" | "deny" | "ask";
  /** the compiled-hook rule/name, when known */
  rule?: string;
  /** enforce actually blocked; observe recorded a would-be block */
  mode?: "enforce" | "observe";
  /** the bash command inspected, when the gate keyed on one */
  cmd?: string;
  reason?: string;
}

/** A subagent tool-contract decision (the PreToolUse rail). */
export interface AgentObservation extends ObservationBase {
  kind: "agent";
  /** the dispatched subagent */
  name: string;
  tool: string;
  allowed: boolean;
  reason?: string;
}

/** Whether a skill fired for a turn (behavioral surface — best-effort per harness). */
export interface SkillObservation extends ObservationBase {
  kind: "skill";
  name: string;
  fired: boolean;
}

/** A measured eval outcome (recall, cost, a check rate, …). */
export interface EvalObservation extends ObservationBase {
  kind: "eval";
  name: string;
  metric: string;
  value: number;
}

/** A capability/blast-radius change observed at PR time. */
export interface CapabilityDiffObservation extends ObservationBase {
  kind: "capability-diff";
  pr?: number;
  added: string[];
  removed?: string[];
  /** true when the change loosened the agent's effect surface */
  widened: boolean;
}

/** The discriminated union every reader narrows on `kind`. */
export type ObservationRecord =
  | HookObservation
  | AgentObservation
  | SkillObservation
  | EvalObservation
  | CapabilityDiffObservation;

/** What a caller supplies — the writer stamps `v` + `ts`. */
export type ObservationInput =
  | Omit<HookObservation, "v" | "ts">
  | Omit<AgentObservation, "v" | "ts">
  | Omit<SkillObservation, "v" | "ts">
  | Omit<EvalObservation, "v" | "ts">
  | Omit<CapabilityDiffObservation, "v" | "ts">;

/** Serialize one record to a single JSONL line (trailing newline included). */
export function formatObservation(record: ObservationRecord): string {
  return JSON.stringify(record) + "\n";
}

/**
 * Append one observation to `<cwd>/.vigiles/runs.jsonl`. Best-effort: any failure is
 * swallowed so recording can never break a live session (the `ts`/`clock` here is a
 * runtime side effect, intentionally — this module records reality, it is not a spec).
 */
export function appendObservation(
  input: ObservationInput,
  cwd: string = process.cwd(),
): void {
  try {
    const dir = resolve(cwd, VIGILES_DIR);
    mkdirSync(dir, { recursive: true });
    ensureLocalFilesIgnored(dir);
    const record = {
      v: OBSERVE_VERSION,
      ts: new Date().toISOString(),
      ...input,
    } as ObservationRecord;
    appendFileSync(resolve(dir, LEDGER_FILE), formatObservation(record));
  } catch {
    /* best-effort — recording is never allowed to break a session */
  }
}

/**
 * Read the ledger back. Tolerant by design: a malformed or partially-written line is
 * skipped rather than throwing, so a torn append never nukes the whole read.
 */
export function readObservations(
  cwd: string = process.cwd(),
): ObservationRecord[] {
  let raw: string;
  try {
    raw = readFileSync(resolve(cwd, VIGILES_DIR, LEDGER_FILE), "utf8");
  } catch {
    return [];
  }
  const out: ObservationRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = tryParseRecord(trimmed);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Filter the ledger to one record kind, narrowing the type for the caller. */
export function observationsOfKind<K extends ObservationRecord["kind"]>(
  records: readonly ObservationRecord[],
  kind: K,
): Extract<ObservationRecord, { kind: K }>[] {
  return records.filter(
    (r): r is Extract<ObservationRecord, { kind: K }> => r.kind === kind,
  );
}

/** Was this record a denial (a blocked gate or an out-of-contract tool call)? */
function isDenial(r: ObservationRecord): boolean {
  return (
    (r.kind === "hook" && r.decision === "deny") ||
    (r.kind === "agent" && !r.allowed)
  );
}

/** A denial rendered as a structured `{label, reason}` — the shared shape the
 *  terminal line and the JSON summary both derive from (one-detector-no-drift). */
export interface LedgerDenial {
  readonly label: string;
  readonly reason: string;
}

/** Per-kind record count. */
export interface LedgerCount {
  readonly kind: ObservationRecord["kind"];
  readonly count: number;
}

/** The structured ledger summary carried in the versioned AuditReport JSON. */
export interface LedgerSummary {
  readonly total: number;
  readonly counts: readonly LedgerCount[];
  readonly denials: number;
  /** The most recent denials (blocked gates / out-of-contract tool calls). */
  readonly recentDenials: readonly LedgerDenial[];
}

/** Structured description of a denial (the single source for label + reason). */
function denialParts(r: ObservationRecord): LedgerDenial {
  if (r.kind === "hook")
    return { label: `hook ${r.rule ?? r.event}`, reason: r.reason ?? "denied" };
  if (r.kind === "agent")
    return {
      label: `${r.name} → ${r.tool}`,
      reason: r.reason ?? "outside contract",
    };
  return { label: r.kind, reason: "" };
}

/** One line describing a denial for the terminal summary. */
function denialLine(r: ObservationRecord): string {
  const d = denialParts(r);
  return `    ✗ ${d.label}: ${d.reason}`;
}

/**
 * The structured ledger summary for the AuditReport JSON — total, per-kind counts,
 * and the recent denials. `undefined` when nothing is recorded, so the report field
 * stays absent (additive/optional). Shares `isDenial`/`denialParts` with the
 * terminal `formatLedgerSummary` so the two can't drift.
 */
export function summarizeObservations(
  records: readonly ObservationRecord[],
): LedgerSummary | undefined {
  if (records.length === 0) return undefined;
  const map = new Map<ObservationRecord["kind"], number>();
  for (const r of records) map.set(r.kind, (map.get(r.kind) ?? 0) + 1);
  const denied = records.filter(isDenial);
  return {
    total: records.length,
    counts: Array.from(map.entries()).map(([kind, count]) => ({ kind, count })),
    denials: denied.length,
    recentDenials: denied.slice(-5).map(denialParts),
  };
}

/**
 * A compact human summary of the ledger for `vigiles audit` — total, counts by kind,
 * and the recent high-signal denials. Empty string when there is nothing recorded, so
 * the caller can skip the section entirely.
 */
export function formatLedgerSummary(
  records: readonly ObservationRecord[],
  committedLocks?: number,
): string {
  if (records.length === 0) return "";
  const lines: string[] = [
    `Flight recorder — ${records.length} record${records.length === 1 ? "" : "s"} in .vigiles/${LEDGER_FILE}`,
  ];

  const counts = new Map<ObservationRecord["kind"], number>();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const byKind = Array.from(counts.entries())
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  lines.push(`  by kind: ${byKind}`);

  const unreachable = evalsUnreachable(records, committedLocks);
  if (unreachable) lines.push(unreachable);

  const denials = records.filter(isDenial);
  if (denials.length > 0) {
    lines.push(`  recent denials (${denials.length}):`);
    for (const r of denials.slice(-5)) lines.push(denialLine(r));
  }
  return lines.join("\n");
}

/**
 * The line that says what the eval numbers can and cannot reach — or `""`.
 *
 * 🔴 THE PRODUCT'S OWN AUTHOR COULD NOT TELL THE LOCK FROM THE CACHE, which is
 * the strongest evidence a discoverability defect can have. MEASURED on his repo
 * the day it came up:
 *
 *   .vigiles/runs.jsonl     276 KB, 105 eval entries, 11–12 Aug   gitignored
 *   .vigiles/eval-locks/    does not exist, 0 locks               (committed)
 *   eval cache              does not exist
 *   audit / lint about any of the above:  0 lines
 *
 * Evals had been run over a hundred times and the result reached NOBODY: the
 * ledger is local, the lock is the only channel outward, and nothing said the
 * lock was missing. The summary above already printed `105 eval` — a number with
 * no meaning attached, which is exactly how this stayed invisible.
 *
 * So the CONSEQUENCE is the sentence and the counts are the evidence for it.
 *
 * Fires only when there are eval runs AND no committed lock. Silent with no
 * evals (nothing to say) and silent once a lock exists (nothing wrong) — the
 * whole point is that a lock is the fix, so having one must not keep nagging.
 *
 * ⚠️ AUDIT ONLY, NOT LINT, and the reason is mechanical rather than editorial:
 * the input is `.vigiles/runs.jsonl`, which is GITIGNORED. In CI — where lint
 * runs — the ledger does not exist, so this finding could never fire there. Put
 * it in lint and it would be dead code that reads as a gate.
 */
function evalsUnreachable(
  records: readonly ObservationRecord[],
  committedLocks: number | undefined,
): string {
  if (committedLocks === undefined || committedLocks > 0) return "";
  const evals = records.filter((r) => r.kind === "eval").length;
  if (evals === 0) return "";
  return (
    `  ⚠ CI cannot verify any eval result — ${String(evals)} eval run(s) are ` +
    `recorded here and 0 locks are committed. This ledger is local and ` +
    `gitignored; a committed \`.vigiles/eval-locks/<name>.lock.json\` is the ` +
    `only channel outward. Give the eval a \`name\`, run \`vigiles eval ` +
    `--update\`, and commit the lock so \`--check\` can gate on it.`
  );
}

/** Parse one JSONL line into a record, or `null` if it is not a well-formed record. */
function tryParseRecord(line: string): ObservationRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { kind?: unknown }).kind === "string"
    ) {
      return value as ObservationRecord;
    }
  } catch {
    /* tolerate a torn/malformed line */
  }
  return null;
}
