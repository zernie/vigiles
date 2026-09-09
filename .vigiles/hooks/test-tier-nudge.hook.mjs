/**
 * THIS REPOSITORY'S OWN COMPILED HOOK — and, as of 2026-09-07, its first.
 *
 * `docs/compiled-hooks.md` listed "neither [consumer] is this repository's own
 * harness, which still wires its hooks as plain shell" as a reason the hook
 * vocabulary keeps its `experimental_` prefix. This file is the fix for the
 * first half of that sentence: a real hook, in the real harness, using the part
 * of the vocabulary that had the fewest users — runtime-owned named state.
 *
 * WHAT IT DOES. `pick-the-test-tier` (CLAUDE.md) tells a contributor to put a
 * new check in the cheapest tier that can decide it. That is prose, and prose is
 * not policy — the measured failure it exists to prevent is a contributor (or an
 * agent) writing a test and never learning which tier it landed in or what that
 * tier still owes. So: when a test-shaped file is edited, say so, in the loop.
 *
 * WHY `react` AND NOT A GATE. A reminder must never block, and the way to
 * guarantee that is to pick the role whose RETURN TYPE cannot express a block.
 * `Reaction` has no `deny`, so "this nudge blocked an edit" is a tsc error, not
 * a promise. A `defineFileGate` with `mode: "observe"` would also not block, but
 * only because of a field someone can flip; the type is the stronger claim.
 *
 * WHY NOT `inject`. Injection is what reaches the MODEL (`additionalContext`),
 * so it looks like the better fit for "put a reminder in front of the model".
 * It is not usable here: `InjectHook` has no `match` and its `SessionEvent`
 * carries `event`/`source`/`ctx` and NO path — an inject on PostToolUse cannot
 * see WHICH file was edited, which is the entire trigger condition. React is the
 * only role that sees the tool, the path, and named state at once.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. The tier map (what each tier needs, which
 * CI job runs it) lives in CONTRIBUTING.md, and the list of CI jobs `npm run
 * check` does not cover is rendered by `scripts/check.mjs` from a list that
 * `scripts/check-covers-ci.test.ts` binds to `ci.yml`. Restating either here
 * would be the second copy that goes stale — the exact failure mode this repo
 * has already paid for. The hook names the tier (which it reads off the path,
 * because the suffix IS the naming convention) and points at the live sources.
 *
 * THROTTLE. `needs: [state("tier.reminded")]` + `record("tier.reminded", tier)`:
 * at most once an hour, and again immediately when the TIER changes, because
 * moving from a unit test to a harness test is exactly when the reminder is
 * worth reading. There is no `throttle:` field by design — see the essay at the
 * top of `src/core/hook-state.ts`; a hook records that it spoke, on the branch
 * that speaks, so the fact means what its name says.
 */
import {
  experimental_defineReact,
  tools,
  state,
  record,
  notice,
  nothing,
} from "vigiles/hook";

/**
 * Filename suffix → the tier CONTRIBUTING.md § Test names it by.
 *
 * This is not a copy of the tier map: it carries no cost, no command and no CI
 * job — only the naming convention the path itself already spells. Order is
 * load-bearing, because `.integration.test.ts` and `.e2e.test.ts` both end in
 * `.test.ts`; the first match wins, so the specific suffixes come first.
 */
const TIERS = [
  [".integration.test.ts", "integration"],
  [".e2e.test.ts", "e2e"],
  [".test.ts", "unit"],
  [".test.mts", "unit"],
  [".harness.mjs", "harness"],
  [".harness.ts", "harness"],
  [".eval.mjs", "eval"],
  [".eval.ts", "eval"],
];

function tierOf(path) {
  const hit = TIERS.find(([suffix]) => path.endsWith(suffix));
  return hit === undefined ? undefined : hit[1];
}

function reminder(tier, path) {
  return (
    `vigiles: ${path} is a ${tier}-tier test.\n` +
    `  · which tier a NEW check belongs in — the \`pick-the-test-tier\` rule in CLAUDE.md\n` +
    `  · what this tier needs, and which CI job (if any) runs it — CONTRIBUTING.md § Test\n` +
    `  · \`npm run check\` PRINTS the CI jobs it does not cover — read its last lines and run the ones you touched\n` +
    `(said at most once an hour, and again when the tier changes)`
  );
}

export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Edit", "Write"),
  needs: [state("tier.reminded")],
  react: (e) => {
    // `rel` is the repo-relative answer `under()` would have used; `raw` is the
    // fallback for a path with no known root, so the hook still classifies
    // rather than silently deciding on less than it looks like it is.
    const path = e.path.rel ?? e.path.raw;
    const tier = tierOf(path);
    if (tier === undefined) return nothing();
    const last = e.ctx["tier.reminded"];
    if (last.fresherThan("1h") && last.value === tier) return nothing();
    return notice(reminder(tier, path), record("tier.reminded", tier));
  },
});
