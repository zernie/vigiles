/**
 * `lint`'s side of the always-loaded check: measure each scored bundle, let
 * the detector (`core/always-loaded-limits.ts`) say which parts are over the
 * harness's limits, then apply the baseline store (`core/baseline-store.ts`)
 * to those findings — and, only under the explicit `--update-baseline`, write
 * the store.
 *
 * This module decides what is read, written and deleted — the store, and the
 * file earlier releases wrote — and turns lines into lint counters and
 * annotations. The bytes go through {@link BaselineFiles}, a port the
 * composition root fills with the file system, so this module does no I/O of
 * its own.
 *
 * WHY THE STORE IS COMMITTED, unlike `.vigiles/coverage.json`. Coverage records
 * what tests ran on THIS machine. The store records a property of the COMMIT:
 * every number in it is built from `committedTotal` and committed settings,
 * which leave out per-machine files, so two clones of one commit compute
 * byte-identical files. That is what lets CI compare against it.
 *
 * WHO WRITES. `lint` never does on its own — every default lint path is a read.
 * `--update-baseline` writes the store while some bundle is over a limit and
 * deletes it once nothing is; `init` writes it once on a repository that is
 * over a limit and has none (`recordIfMissing`).
 */
import {
  BASELINE_FILE,
  UPDATE_BASELINE_COMMAND,
  applyBaseline,
  entriesFor,
  hasEntries,
  parseBaselineStore,
  serializeBaselineStore,
  withEntries,
  type BaselineEntry,
  type BaselineStore,
  type RuleFinding,
  type RuleRun,
  type StoreLine,
  type StoreOnDisk,
} from "./core/baseline-store.js";
import {
  alwaysLoadedMeasurement,
  checkAlwaysLoadedLimits,
  checkCeiling,
  formatCeiling,
  formatOverLimit,
  formatRefusal,
  type LimitCheck,
  type LimitOverrides,
} from "./core/always-loaded-limits.js";
import {
  convertLegacyEntry,
  legacyBaselineFiles,
  parseLegacyBaseline,
} from "./core/legacy-baseline.js";
import { MOVE_OUT_OF_ALWAYS_LOADED } from "./core/instruction-remedies.js";
import type { AlwaysLoadedContext } from "./core/always-loaded.js";
import type { InstructionWeight } from "./core/instruction-weight.js";
import type { RuleSeverity } from "./core/types.js";

/**
 * The repository's files, by path relative to the config root. The root fills
 * it with the file system; a test can fill it with a map.
 */
export interface BaselineFiles {
  /** The file's text, or `undefined` when it does not exist. */
  readonly read: (path: string) => string | undefined;
  /** Write the file, creating its folder. */
  readonly write: (path: string, text: string) => void;
  /** Delete the file; nothing when it does not exist. */
  readonly remove: (path: string) => void;
}

/**
 * One bundle's measurement: where it is, and either nothing to weigh or its
 * weight WITH the always-loaded context around it.
 */
export type MeasuredBundle =
  | readonly [at: string, weight: null]
  | readonly [
      at: string,
      weight: InstructionWeight,
      loaded: AlwaysLoadedContext,
    ];

/** The rule's options that change what is measured against. */
export interface ContextCreepLimits {
  /** Per-part limits from `.vigilesrc.json`; each one missing keeps the harness's. */
  readonly limits?: LimitOverrides;
  /** The opt-in absolute ceiling on the scored instructions; no baseline lifts it. */
  readonly max?: number;
}

export function readBaselineStore(files: BaselineFiles): StoreOnDisk {
  const text = files.read(BASELINE_FILE);
  return text === undefined ? { kind: "absent" } : parseBaselineStore(text);
}

/** Write the store, or delete the file when there is nothing left in it. */
function writeBaselineStore(
  files: BaselineFiles,
  store: Readonly<BaselineStore> | undefined,
): void {
  if (store === undefined) files.remove(BASELINE_FILE);
  else files.write(BASELINE_FILE, serializeBaselineStore(store));
}

/** The old baseline files present in this repository, newest name first. */
export function legacyFilesPresent(
  files: BaselineFiles,
  ruleId: string,
): readonly string[] {
  return legacyBaselineFiles(ruleId).filter((f) => files.read(f) !== undefined);
}

/** One bundle's check against its limits, or nothing to weigh. */
function limitCheck(
  m: MeasuredBundle,
  limits: ContextCreepLimits,
): LimitCheck | undefined {
  return m[1] === null
    ? undefined
    : checkAlwaysLoadedLimits(m[1], m[2], limits.limits);
}

/**
 * An import named and not read is weight this number lacks. Said on the
 * finding itself, because the comparison is only as true as the sum.
 */
function unfollowedNote(weight: InstructionWeight): string {
  return weight.unreadImports.length > 0
    ? ` (${String(weight.unreadImports.length)} import(s) not followed: ${weight.unreadImports.join(", ")} — their size is not in this number)`
    : "";
}

/** The over-limit finding for a bundle, carrying what the store records. */
function overLimitFinding(
  at: string,
  weight: InstructionWeight,
  loaded: AlwaysLoadedContext,
  check: LimitCheck,
): readonly RuleFinding[] {
  return check.over.length === 0
    ? []
    : [
        {
          subject: at,
          text: `${formatOverLimit(check, at)}${unfollowedNote(weight)}`,
          measurement: alwaysLoadedMeasurement(weight, loaded),
        },
      ];
}

/** The findings one bundle produces: over a limit (acceptable), over the ceiling (never). */
function bundleFindings(
  m: MeasuredBundle,
  limits: ContextCreepLimits,
): readonly RuleFinding[] {
  if (m[1] === null) return [];
  const [at, weight, loaded] = m;
  const check = checkAlwaysLoadedLimits(weight, loaded, limits.limits);
  const ceiling = checkCeiling(weight, limits.max);
  return [
    ...overLimitFinding(at, weight, loaded, check),
    ...(ceiling === undefined
      ? []
      : [
          {
            subject: at,
            text: formatCeiling(ceiling, at, MOVE_OUT_OF_ALWAYS_LOADED),
          },
        ]),
  ];
}

/** What the stateless rule reports for the store to act on. */
export function contextCreepRun(
  ruleId: string,
  measured: readonly MeasuredBundle[],
  limits: ContextCreepLimits,
): RuleRun {
  return {
    ruleId,
    findings: measured.flatMap((m) => bundleFindings(m, limits)),
    measured: measured.flatMap((m) => (m[1] === null ? [] : [m[0]])),
    remedy: MOVE_OUT_OF_ALWAYS_LOADED,
  };
}

/** The bundles `--update-baseline` must not record: each one over the ceiling. */
export function updateRefusals(
  measured: readonly MeasuredBundle[],
  max: number | undefined,
): readonly string[] {
  const text = {
    file: BASELINE_FILE,
    command: UPDATE_BASELINE_COMMAND,
    remedy: MOVE_OUT_OF_ALWAYS_LOADED,
  };
  return measured.flatMap(([at, weight]) => {
    const over = weight === null ? undefined : checkCeiling(weight, max);
    return over === undefined ? [] : [formatRefusal(over, at, text)];
  });
}

/** The line a repository with an old baseline file gets: a finding, naming the command. */
export function legacyLine(file: string): StoreLine {
  return {
    subject: ".",
    status: "finding",
    text:
      `${file} is no longer read: the always-loaded baseline moved to ${BASELINE_FILE}. ` +
      `Migrate it with \`${UPDATE_BASELINE_COMMAND}\` — it keeps the recorded numbers of every bundle still over a limit and deletes ${file}.`,
  };
}

/** The entries a migration writes, and whether the old file could be converted. */
interface Migration {
  readonly entries: Readonly<Record<string, BaselineEntry>>;
  readonly converted: boolean;
}

/**
 * The entries a migration writes: each bundle still over a limit keeps its
 * entry from the old file (the recorded numbers, never a re-measure), and a
 * bundle the old file did not record is taken at its current size. A file
 * that cannot be read is replaced by the current sizes, and the caller says so.
 */
function migratedEntries(
  oldText: string,
  run: RuleRun,
  onDisk: StoreOnDisk,
): Migration {
  const current = entriesFor(onDisk, run);
  const legacy = parseLegacyBaseline(oldText);
  if (legacy.kind === "invalid") return { entries: current, converted: false };
  const entries = Object.fromEntries(
    run.findings.flatMap((f) => {
      if (f.measurement === undefined) return [];
      const kept = convertLegacyEntry(legacy, f.subject, f.measurement);
      return [[f.subject, kept ?? current[f.subject]] as const];
    }),
  );
  return { entries, converted: true };
}

/** What `record` says about the store it wrote or removed. */
function wroteLine(
  next: Readonly<BaselineStore> | undefined,
  onDisk: StoreOnDisk,
): string {
  if (next !== undefined) return `✓ recorded ${BASELINE_FILE}`;
  return onDisk.kind === "ok"
    ? `✓ nothing is over a limit — removed ${BASELINE_FILE}`
    : "✓ nothing is over a limit — no baseline to record";
}

/** What `record` says about a migration. */
function migratedLine(file: string, converted: boolean): string {
  return converted
    ? `✓ migrated ${file} into ${BASELINE_FILE}, keeping its recorded numbers — run \`${UPDATE_BASELINE_COMMAND}\` again to accept the current size`
    : `✓ ${file} could not be read, so the current size was recorded instead`;
}

/**
 * Record the run. With an old file present and no entries in the store yet,
 * it is a MIGRATION (the old numbers carry over); otherwise the current sizes
 * are recorded. Old files are deleted either way. Returns what to print.
 */
function record(
  files: BaselineFiles,
  run: RuleRun,
  onDisk: StoreOnDisk,
): readonly string[] {
  const legacy = legacyFilesPresent(files, run.ruleId);
  const first = hasEntries(onDisk, run.ruleId) ? undefined : legacy[0];
  const oldText = first === undefined ? undefined : files.read(first);
  const plan: Migration =
    oldText === undefined
      ? { entries: entriesFor(onDisk, run), converted: false }
      : migratedEntries(oldText, run, onDisk);
  const next = withEntries(onDisk, run.ruleId, plan.entries);
  writeBaselineStore(files, next);
  legacy.forEach((f) => {
    files.remove(f);
  });
  return [
    wroteLine(next, onDisk),
    ...(first === undefined ? [] : [migratedLine(first, plan.converted)]),
    ...legacy.map((f) => `✓ deleted ${f}`),
  ];
}

/** The options {@link checkContextCreep} takes. */
export interface ContextCreepOptions extends ContextCreepLimits {
  readonly ruleId: string;
  readonly files: BaselineFiles;
  readonly severity: RuleSeverity;
  readonly update: boolean;
  readonly silent: boolean;
  /** Called only when the rule is on or an update was asked for. */
  readonly measure: () => readonly MeasuredBundle[];
  readonly annotate: (
    level: "error" | "warning" | "notice",
    message: string,
  ) => void;
}

/** What {@link checkContextCreep} hands back to `lint`. */
export interface ContextCreepResult {
  readonly issues: number;
  readonly errors: number;
  /**
   * One-line notes `--summary` prints (the session-start hook injects them):
   * over a limit with no baseline, and an old baseline file to migrate.
   */
  readonly notes: readonly string[];
}

/** The `--summary` notes: what the agent working in the repository should run. */
function summaryNotes(
  run: RuleRun,
  onDisk: StoreOnDisk,
  legacy: readonly string[],
): readonly string[] {
  const unrecorded =
    !hasEntries(onDisk, run.ruleId) &&
    legacy.length === 0 &&
    run.findings.some((f) => f.measurement !== undefined);
  return [
    ...(unrecorded
      ? [
          `always-loaded context is over the harness's limit and no baseline is recorded — run \`${UPDATE_BASELINE_COMMAND}\` and commit ${BASELINE_FILE}`,
        ]
      : []),
    ...legacy.map((f) => legacyLine(f).text),
  ];
}

const MARKS = { ok: "✓", note: "ℹ" } as const;

function printReport(
  lines: readonly StoreLine[],
  recorded: readonly string[],
  severity: RuleSeverity,
): void {
  console.log("\nContext creep (always-loaded context):\n");
  recorded.forEach((r) => {
    console.log(`  ${r}`);
  });
  const finding = severity === "error" ? "✗" : "⚠";
  lines.forEach((l) => {
    const mark = l.status === "finding" ? finding : MARKS[l.status];
    console.log(`  ${mark} ${l.text}`);
  });
}

/** `--update-baseline`: refuse over the ceiling, else record. Returns what it printed and refused. */
function update(
  opts: ContextCreepOptions,
  measured: readonly MeasuredBundle[],
  run: RuleRun,
): { readonly recorded: readonly string[]; readonly refusals: number } {
  if (!opts.update) return { recorded: [], refusals: 0 };
  const refusals = updateRefusals(measured, opts.max);
  refusals.forEach((message) => {
    console.error(`✗ ${message}`);
    opts.annotate("error", message);
  });
  return refusals.length > 0
    ? { recorded: [], refusals: refusals.length }
    : {
        recorded: record(opts.files, run, readBaselineStore(opts.files)),
        refusals: 0,
      };
}

/** Annotate every finding at the rule's level and every summary note as a notice. */
function annotateAll(
  opts: ContextCreepOptions,
  findings: readonly StoreLine[],
  notes: readonly string[],
): void {
  const level = opts.severity === "error" ? "error" : "warning";
  findings.forEach((l) => {
    opts.annotate(level, l.text);
  });
  notes.forEach((note) => {
    opts.annotate("notice", note);
  });
}

/** Run the check for `lint`: record if asked, then print, annotate, count. */
export function checkContextCreep(
  opts: ContextCreepOptions,
): ContextCreepResult {
  const { severity, files, ruleId } = opts;
  if (!severity && !opts.update) return { issues: 0, errors: 0, notes: [] };
  const measured = opts.measure();
  const run = contextCreepRun(ruleId, measured, opts);
  const { recorded, refusals } = update(opts, measured, run);
  const onDisk = readBaselineStore(files);
  const legacy = legacyFilesPresent(files, ruleId);
  const lines = severity
    ? [...applyBaseline(run, onDisk), ...legacy.map(legacyLine)]
    : [];
  if (!opts.silent && (opts.update || lines.length > 0)) {
    printReport(lines, recorded, severity);
  }
  const findings = lines.filter((l) => l.status === "finding");
  const notes = severity ? summaryNotes(run, onDisk, legacy) : [];
  annotateAll(opts, findings, notes);
  const counted = severity === "error" ? findings.length : 0;
  return {
    issues: findings.length + refusals,
    errors: counted + refusals,
    notes,
  };
}

/** What `init` did about the baseline, for its summary. */
export type InitBaseline =
  | { readonly kind: "under-limits" }
  | { readonly kind: "kept"; readonly file: string }
  | { readonly kind: "legacy"; readonly file: string; readonly command: string }
  | {
      readonly kind: "recorded";
      readonly file: string;
      readonly over: readonly string[];
    };

/** "skill-listing is 7,530 chars, over the limit of 6,000", per over part. */
function overParts(
  measured: readonly MeasuredBundle[],
  limits: ContextCreepLimits,
): readonly string[] {
  const g = (x: number): string => x.toLocaleString("en-US");
  return measured.flatMap((m) => {
    const check = limitCheck(m, limits);
    const where = m[0] === "." ? "" : `${m[0]}: `;
    return (check?.over ?? []).map(
      (p) =>
        `${where}${p.part} is ${g(p.size)} ${check?.unit ?? ""}, over the limit of ${g(p.limit)}`,
    );
  });
}

/**
 * `init`'s step: on a repository over a limit with no baseline yet, record one
 * so the gate starts from today's size. It never overwrites an existing
 * baseline, and never re-measures over an old file (that is what migrating is
 * for — re-measuring would accept unseen growth).
 */
export function recordIfMissing(
  files: BaselineFiles,
  ruleId: string,
  measured: readonly MeasuredBundle[],
  limits: ContextCreepLimits,
): InitBaseline {
  const onDisk = readBaselineStore(files);
  if (hasEntries(onDisk, ruleId) || onDisk.kind === "invalid") {
    return { kind: "kept", file: BASELINE_FILE };
  }
  const legacy = legacyFilesPresent(files, ruleId)[0];
  if (legacy !== undefined) {
    return { kind: "legacy", file: legacy, command: UPDATE_BASELINE_COMMAND };
  }
  const entries = entriesFor(onDisk, contextCreepRun(ruleId, measured, limits));
  if (Object.keys(entries).length === 0) return { kind: "under-limits" };
  writeBaselineStore(files, withEntries(onDisk, ruleId, entries));
  return {
    kind: "recorded",
    file: BASELINE_FILE,
    over: overParts(measured, limits),
  };
}

/** Where the size stands against the store, in a few words, for `compile`. */
function compileStatus(line: StoreLine | undefined): string {
  if (line?.status === "ok") return "held at the baseline";
  if (line?.status === "finding")
    return "grew past the baseline — `vigiles lint` fails";
  return "not a finding — `vigiles lint` says why";
}

/**
 * The line `compile` prints after writing instruction files: the size now,
 * against each limit, and against the baseline when over one. Report-only —
 * `lint` stays the single gate. `null` when there is nothing to weigh.
 */
export function compileWeightLine(
  files: BaselineFiles,
  ruleId: string,
  measured: MeasuredBundle,
  limits: ContextCreepLimits,
): string | null {
  const check = limitCheck(measured, limits);
  if (check === undefined || measured[1] === null) return null;
  const g = (x: number): string => x.toLocaleString("en-US");
  const parts = check.parts
    .map((p) => `${p.part} ${g(p.size)}/${g(p.limit)}`)
    .join(" · ");
  const head = `always-loaded context: ${g(measured[2].total)} ${check.unit} — ${parts}`;
  if (check.over.length === 0) return `${head} (under every limit)`;
  const line = applyBaseline(
    contextCreepRun(ruleId, [measured], limits),
    readBaselineStore(files),
  ).find((l) => l.subject === measured[0]);
  return `${head} (over a limit; ${compileStatus(line)})`;
}
