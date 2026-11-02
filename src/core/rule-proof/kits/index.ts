/**
 * The kit set: the ONLY place that lists the linters rule-proof supports. A new
 * linter is a module beside this one and a line here; nothing generic changes
 * (`local/no-kit-names` refuses a generic rule-proof file that spells a kit).
 */
import { eslintKit } from "./eslint.js";
import { ruffKit } from "./ruff.js";

export const PROOF_KITS = { eslint: eslintKit, ruff: ruffKit } as const;

export type { EslintReading } from "./eslint.js";
export type { RuffReading } from "./ruff.js";
