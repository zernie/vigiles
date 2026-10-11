/**
 * The two ways a compiled instruction file can state an `enforce()` reference,
 * spelled in ONE place so the renderer and every reader agree (#351).
 *
 * "**Enforced by:**" is the product's promise that a machine holds the rule, so
 * `compile` writes it only for a reference it VERIFIED: the rule exists in the
 * linter's catalog and the project's config switches it on. Anything less — the
 * check was turned off (`verify: false`, `verifyLinters: false`, a per-linter
 * `false`, catalog-only), the config does not set the rule, or the config could
 * not be read — renders as "**Claimed (unverified):**". A reader of the compiled
 * file can then tell the two apart without the compile log.
 *
 * Zero imports: `validate.ts`, `rule-routing.ts` and the CLI read these markers
 * too, and some of them are browser-safe.
 */

/** A reference `compile` verified: exists, and the project's config runs it. */
export const ENFORCED_MARKER = "**Enforced by:**";

/** A reference `compile` did not or could not verify. */
export const CLAIMED_MARKER = "**Claimed (unverified):**";

/**
 * Either marker followed by its backticked reference, anywhere in a line.
 * Group 1 is the marker's label (`Enforced by` / `Claimed (unverified)`),
 * group 2 the reference.
 */
export const RULE_MARKER_SOURCE =
  /\*\*(Enforced by|Claimed \(unverified\)):\*\*\s*`([^`]+)`/.source;

/** Is the label captured by {@link RULE_MARKER_SOURCE} the verified one? */
export function isVerifiedLabel(label: string): boolean {
  return label === "Enforced by";
}
