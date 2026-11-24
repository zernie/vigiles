/**
 * Whether a prompt set can measure a trigger rate at all: enough prompts, none a
 * near-duplicate of another. Deterministic and model-free, so the trigger-rate
 * runner in `src/eval.ts` refuses a bad set before it spends a token.
 */
import { ncd } from "./proofs.js";

// ---------------------------------------------------------------------------
// Prompt-set diversity (deterministic, pre-eval) — a trigger rate is only
// meaningful over ENOUGH and DIFFERENT prompts. Catch a too-small or
// near-duplicate set before spending a single model token. We measure
// "different" with Normalized Compression Distance (gzip) — the SAME engine
// `findSimilarRules` uses for near-duplicate rule detection — not edit
// distance: NCD scores shared structure/redundancy (a templated prompt with one
// word swapped compresses together), which is exactly the lazy-copy-paste set
// we want to reject, and it's the project's house algorithm for "are these two
// texts basically the same".
// ---------------------------------------------------------------------------

/** Normalize for comparison: lowercase, trim, collapse whitespace. */
function normalizePrompt(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Distance between two prompts in ~0..1 (0 = identical, higher = more
 * different) via Normalized Compression Distance over the normalized text.
 * Reuses {@link ncd} from the proof engine.
 */
export function promptDistance(a: string, b: string): number {
  return ncd(normalizePrompt(a), normalizePrompt(b));
}

export interface PromptDiversityIssue {
  readonly kind: "too-few" | "too-similar";
  readonly message: string;
}

/**
 * Deterministically check a prompt set is big and varied enough to measure a
 * trigger rate: at least `minPrompts` entries, and no two closer than
 * `minDistance` in NCD. Pure — no model. `label` names the set in messages.
 */
export function checkPromptDiversity(
  prompts: readonly string[],
  opts: { minPrompts?: number; minDistance?: number; label?: string } = {},
): PromptDiversityIssue[] {
  const minPrompts = opts.minPrompts ?? 10;
  const minDistance = opts.minDistance ?? 0.3;
  const label = opts.label ?? "prompts";
  const issues: PromptDiversityIssue[] = [];
  if (prompts.length < minPrompts) {
    issues.push({
      kind: "too-few",
      message: `${label}: ${String(prompts.length)} prompt(s), need at least ${String(minPrompts)} to measure a rate (set minPrompts to override).`,
    });
  }
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const dist = promptDistance(prompts[i], prompts[j]);
      if (dist < minDistance) {
        issues.push({
          kind: "too-similar",
          message: `${label}: prompts #${String(i + 1)} and #${String(j + 1)} are near-duplicates (NCD ${dist.toFixed(2)} < ${String(minDistance)}) — vary the phrasing:\n    - ${prompts[i]}\n    - ${prompts[j]}`,
        });
      }
    }
  }
  return issues;
}

/** Throw if a prompt set isn't big/varied enough. See {@link checkPromptDiversity}. */
export function assertPromptDiversity(
  prompts: readonly string[],
  opts: { minPrompts?: number; minDistance?: number; label?: string } = {},
): void {
  const issues = checkPromptDiversity(prompts, opts);
  if (issues.length > 0) {
    throw new Error(
      `Prompt set is not eval-ready:\n  ${issues.map((i) => i.message).join("\n  ")}`,
    );
  }
}
