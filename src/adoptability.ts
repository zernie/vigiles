/**
 * Adoptability preview — "what would vigiles catch in YOUR repo?"
 *
 * The audit's adoption front door for a NON-adopter: instead of grading the hygiene
 * of an already-adopted spec, it shows the concrete bugs a spec WOULD catch today.
 *
 * Architecture (research/adoption-gateway-preview.md): **LLM proposes, deterministic
 * disposes.** A model DRAFTS the verifiable references in an instruction file (high
 * recall, incl. prose intent a regex can't see — `draftRefs`); the deterministic
 * cross-reference engine VERIFIES each one (`verifyDraftedRefs`, reusing
 * `checkLinterRule` + the compile validators). The model never gets to assert a
 * pass — only the verifier does — so the "M broken right now" number is trustworthy
 * even though the extraction was probabilistic.
 *
 * The verifier + parser + formatter are pure and model-free (fully unit-tested); the
 * single real model call (`defaultDraft`) is the only v8-ignored seam, injected so
 * the orchestration is testable without a model.
 */
import { checkLinterRule } from "./core/linters.js";
import {
  validateFileRef,
  validateCommandRef,
  validateDirRef,
} from "./core/compile.js";
import { assertNever } from "./core/hash.js";
import {
  spawnAgent,
  parseClaudeRun,
  type AgentRunner,
  type ModelOutputParser,
  type EvalDriver,
  type RunOut,
} from "./eval.js";

/**
 * The harness CLI did not run, as distinct from running and finding nothing.
 * A named class so the caller can tell the two apart without matching prose.
 */
export class DraftRunFailed extends Error {
  constructor(reason: string) {
    super(`could not run the drafting model — ${reason}`);
    this.name = "DraftRunFailed";
  }
}

/** A reference the model proposes as machine-verifiable. */
export interface DraftedRef {
  readonly kind: "enforce" | "file" | "cmd" | "dir";
  readonly ref: string;
}

/** A drafted ref that failed verification — the value proof. */
export interface BrokenRef {
  readonly kind: DraftedRef["kind"];
  readonly ref: string;
  readonly issue: string;
}

export interface AdoptabilityResult {
  /** Distinct verifiable references the model found (the surface a spec would protect). */
  readonly total: number;
  /** How many of those are broken in this repo right now. */
  readonly broken: number;
  readonly brokenRefs: readonly BrokenRef[];
}

/** Verify ONE drafted ref against the real repo; null = resolves, else the breakage. */
function verifyOne(r: DraftedRef, basePath: string): BrokenRef | null {
  switch (r.kind) {
    case "enforce": {
      const res = checkLinterRule(r.ref, basePath);
      if (!res.exists)
        return {
          ...r,
          issue: res.error ?? `linter rule "${r.ref}" does not exist`,
        };
      if (res.enabled === "disabled")
        return { ...r, issue: `rule "${r.ref}" exists but is not enabled` };
      return null;
    }
    case "file": {
      const e = validateFileRef(r.ref, basePath);
      return e ? { kind: r.kind, ref: r.ref, issue: e.message } : null;
    }
    case "cmd": {
      const e = validateCommandRef(r.ref, basePath);
      return e ? { kind: r.kind, ref: r.ref, issue: e.message } : null;
    }
    case "dir": {
      const e = validateDirRef(r.ref, basePath);
      return e ? { kind: r.kind, ref: r.ref, issue: e.message } : null;
    }
    default:
      return assertNever(r.kind);
  }
}

/**
 * Deterministic verdict over drafted refs — the "disposes" half. Dedupes
 * (kind+ref), routes each to the real cross-ref/filesystem check, and counts the
 * broken. Pure: a hallucinated rule resolves to broken, never trusted as a pass.
 */
export function verifyDraftedRefs(
  refs: readonly DraftedRef[],
  basePath: string,
): AdoptabilityResult {
  const seen = new Set<string>();
  const unique: DraftedRef[] = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const brokenRefs = unique
    .map((r) => verifyOne(r, basePath))
    .filter((b): b is BrokenRef => b !== null);
  return { total: unique.length, broken: brokenRefs.length, brokenRefs };
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "enforce",
  "file",
  "cmd",
  "dir",
]);

/**
 * Tolerant parse of the model's draft output into `DraftedRef[]`. The model is
 * asked for a bare JSON array, but tolerate prose-wrapped / fenced output by
 * extracting the outermost `[...]`. Drops any entry with an unknown kind or a
 * non-string ref (the verifier is the guard, but a malformed shape is just noise).
 */
export function parseDraftJson(text: string): DraftedRef[] {
  const raw = extractJsonArray(text);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DraftedRef[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const ref = rec.ref;
    if (
      typeof kind === "string" &&
      VALID_KINDS.has(kind) &&
      typeof ref === "string" &&
      ref.trim()
    ) {
      out.push({ kind: kind as DraftedRef["kind"], ref: ref.trim() });
    }
  }
  return out;
}

/** Pull the outermost `[...]` from a possibly prose/fence-wrapped string. */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/** The drafting prompt — reuse the strengthen/adopt-spec mapping intent. */
function draftPrompt(content: string): string {
  return [
    "You are evaluating whether a coding-agent instruction file's references can be",
    "machine-verified. Read the instruction file and identify every reference to a",
    "CONCRETE, VERIFIABLE artifact:",
    '- a linter rule (kind "enforce", ref like "eslint/no-console" or',
    '  "@typescript-eslint/no-floating-promises") — INCLUDING prose intent you can',
    '  confidently map to a real rule (e.g. "always await promises" ->',
    '  "@typescript-eslint/no-floating-promises", "no console.log" -> "eslint/no-console").',
    '- a file path (kind "file", ref like "src/index.ts").',
    '- an npm script (kind "cmd", ref like "npm run build" or "npm test").',
    '- a directory (kind "dir", ref like "src/components").',
    "",
    'Output ONLY a JSON array of {"kind","ref"} objects — no markdown, no prose. If',
    "none, output []. Do not invent references that aren't grounded in the text.",
    "",
    "Instruction file:",
    "---",
    content,
    "---",
  ].join("\n");
}

/** Options for the real model draft (the one v8-ignored seam). */
export interface DraftOptions {
  readonly model?: string;
  readonly cwd?: string;
  readonly runner?: AgentRunner;
  readonly parse?: ModelOutputParser;
  /**
   * The driver's own reader for a failure the exit code does not carry — a
   * refusal, or a turn error inside a zero-exit run. Supplied by
   * {@link draftWith}; absent means the exit code is the only signal.
   */
  readonly runError?: (out: RunOut) => string | null;
}

/* v8 ignore start — the single real model call; the orchestration is tested with a fake draft. */
/** The "proposes" half: one model call drafting the verifiable refs from prose. */
async function defaultDraft(
  content: string,
  opts: DraftOptions = {},
): Promise<DraftedRef[]> {
  const runner = opts.runner ?? spawnAgent;
  const parse = opts.parse ?? parseClaudeRun;
  const out = await runner({
    task: draftPrompt(content),
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? "sonnet",
    tools: [], // the content is inline — no file tools needed (deterministic-ish)
    hasSettings: false,
    pluginDir: undefined,
    timeoutMs: 120000,
    env: process.env as Record<string, string>,
  });
  // 🔴 THE EXIT CODE IS READ, AND IT WAS NOT. A runner that could not start the
  // harness binary returns code 1 with empty stdout; `parse` then yields no
  // output, `parseDraftJson` yields `[]`, and the report prints "no
  // machine-verifiable references found" — a valid-looking answer to a question
  // nothing ever asked. Found on review of #265: the unconditional
  // `subscription` on the Codex driver lets this path run with no binary
  // present, and unlike the behavioral probe there is nothing here that
  // self-reports unavailability.
  //
  // Thrown rather than returned empty, because "the run failed" and "the model
  // found nothing" are different answers and the caller has to be able to say
  // which. `runError` is the driver's own reader for a failure the exit code
  // does not carry — a refusal or a turn error inside a zero-exit run.
  if (out.code !== 0) {
    throw new DraftRunFailed(
      `the harness CLI exited ${String(out.code)}${out.stderr ? `: ${out.stderr.trim().slice(0, 200)}` : " with no output"}`,
    );
  }
  const driverError = opts.runError?.(out);
  if (driverError !== null && driverError !== undefined) {
    throw new DraftRunFailed(driverError);
  }
  return parseDraftJson(parse(out).output);
}
/* v8 ignore stop */

/** Injectable drafter — the real one calls a model; tests pass a fake. */
export type Drafter = (content: string) => Promise<DraftedRef[]>;

/**
 * Build the real drafter from a harness's EVAL DRIVER, instead of the hard-wired
 * `spawnAgent` + `parseClaudeRun` defaults above.
 *
 * 🔴 THIS IS WHY THE PREVIEW IS NOT CLAUDE-CODE-ONLY. `defaultDraft`'s two
 * defaults ARE the two members of the Claude eval driver, and nothing else in
 * the drafter is harness-specific: the prompt is over an instruction file's
 * prose, and prose is prose. The VERIFIER is deterministic and harness-free
 * ("LLM proposes, deterministic disposes", this file's header), so "M broken
 * right now" is exactly as trustworthy driven by one harness as by another;
 * only the draft's RECALL varies by model, which it already does across models
 * of the same harness.
 *
 * `model` is passed through to whichever runner: the trigger tier already does
 * this, and a runner that does not understand the alias ignores it.
 */
export function draftWith(
  driver: EvalDriver,
  opts: DraftOptions = {},
): Drafter {
  return (content: string) =>
    defaultDraft(content, {
      ...opts,
      runner: driver.runner,
      parse: driver.parse,
      runError: driver.runError,
    });
}

export interface AdoptabilityTierOptions {
  readonly instructionContent: string;
  readonly basePath: string;
  /** Injectable for tests; defaults to the real one-shot model draft. */
  readonly draft?: Drafter;
}

/**
 * Run the preview: draft refs from the instruction file (model), then verify them
 * (deterministic). The composition root of "LLM proposes, deterministic disposes".
 */
export async function runAdoptabilityTier(
  opts: AdoptabilityTierOptions,
): Promise<AdoptabilityResult> {
  const draft = opts.draft ?? ((c: string) => defaultDraft(c));
  const refs = await draft(opts.instructionContent);
  return verifyDraftedRefs(refs, opts.basePath);
}

/** Terminal section — the adoption invitation, not a graded ring. */
export function formatAdoptability(
  r: AdoptabilityResult,
  instructionFile: string,
): string {
  const lines = ["Adoptability — what vigiles would lock in"];
  if (r.total === 0) {
    lines.push(
      `  no machine-verifiable references found in ${instructionFile}.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `  vigiles drafted a spec from ${instructionFile}: ${String(r.total)} verifiable reference(s) found`,
  );
  if (r.broken === 0) {
    lines.push("  ✓ all resolve right now — adopt a spec to keep it that way.");
    return lines.join("\n");
  }
  lines.push(`  ${String(r.broken)} broken right now:`);
  for (const b of r.brokenRefs) {
    lines.push(`    ✗ ${b.issue}`);
  }
  lines.push(
    "  → run `vigiles init` to adopt the spec and catch these at edit time.",
  );
  return lines.join("\n");
}
