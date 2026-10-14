/**
 * Command-line config overrides.
 *
 * The GitHub Action is a thin composite over this CLI, so every Action
 * input must map to a real CLI flag (no config-file-only knobs the Action
 * can't reach — see the `prod-grade-gha-cli` rule). This module turns the
 * shared flags into `VigilesConfig` overrides on top of the loaded config.
 *
 * Pure and exported for unit testing.
 */

import type { VigilesConfig } from "./core/types.js";

const MAX_RULES = "--max-rules=";

/**
 * Apply shared command-line overrides to a loaded config.
 *
 *   --max-rules=<n>   → config.maxRules   (positive integer; ignored otherwise)
 *   --catalog-only    → config.catalogOnly = true
 *
 * Unknown flags are left untouched (each command parses its own besides
 * these). Returns a new object; the input is not mutated.
 */
export function applyConfigFlags<C extends VigilesConfig>(
  config: C,
  args: readonly string[],
): C {
  const next: C = { ...config };

  const maxRulesFlag = args.find((a) => a.startsWith(MAX_RULES));
  if (maxRulesFlag) {
    const n = Number(maxRulesFlag.slice(MAX_RULES.length));
    if (Number.isInteger(n) && n > 0) {
      next.maxRules = n;
    }
  }

  if (args.includes("--catalog-only")) {
    next.catalogOnly = true;
  }

  return next;
}
