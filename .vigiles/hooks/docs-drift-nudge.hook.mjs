/**
 * THIS REPOSITORY'S OWN COMPILED HOOK #2 — product code moved, docs did not.
 *
 * WHAT IT IS FOR. `doc-consistency` (CLAUDE.md) says: when you ship, rename or
 * remove a capability, update its docs in the SAME change, across BOTH tiers —
 * the public `docs/` + README, and the contributor record in `CLAUDE.md`. That
 * rule is prose. The measured failures are all from one evening (2026-09-08):
 *
 *   · `tool()` was deleted from the hook vocabulary and `docs/compiled-hooks.md`
 *     kept listing it as vocabulary — through TWO sweeps of that same file.
 *   · An exclusivity claim outlived the measurement that withdrew it.
 *   · `deep-research` routed findings to a `startup/` vault deleted in #68.
 *
 * None was caught by a check. `self-command-refs` resolves `vigiles <cmd>`;
 * `doc-refs` resolves marks inside fenced ts blocks; `orphan-docs` finds
 * unreferenced files. A capability whose BEHAVIOUR changed while its prose
 * stayed put is invisible to all three, because nothing about the prose is
 * broken — it is merely no longer true.
 *
 * WHY A HOOK AND NOT A LINT RULE. `lint` reads a checkout; "the code changed and
 * the docs didn't" is a property of a DIFF, not of a tree. A rule that fired on
 * a tree would have to guess which prose belongs to which symbol — undecidable,
 * and by `lint-rule-calibration` a heuristic can never gate. A hook sees edits
 * accumulate across a session, which is the only place the fact exists.
 *
 * WHY `react`. A reminder must never block, and `Reaction` has no `deny`, so
 * "this nudge blocked an edit" is a tsc error rather than a promise. Same
 * reasoning as `test-tier-nudge.hook.mjs`, and see its header for why `inject`
 * cannot be used (a `SessionEvent` carries no path).
 *
 * WHY IT IS NOT `ship-a-feature`. That skill exists and covers this for a NEW
 * export, with executable DOCUMENTED / FINDABLE checks. Its own trigger eval
 * asserts it stays QUIET on "Rename the internal helper posixly to toPosix" and
 * "Tighten the wording in docs/compiled-hooks.md" — firing there counts as a
 * false positive against `maxFalsePositive: 0.2`. So widening it to cover a
 * behaviour change would break its own precision assertion. This hook covers
 * what that skill is measured NOT to.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Which tier a given fact belongs in is
 * `public-vs-internal-docs` + `doc-tiers`; how to edit a compiled `CLAUDE.md` is
 * the `edit-spec` skill. Restating either here is the second copy that goes
 * stale — the failure this repo has already paid for more than once. The hook
 * names the two tiers and points at the live sources.
 *
 * THROTTLE, and why it has two facts rather than one. `docs.followed` is
 * recorded whenever a doc IS edited, so a session that is already maintaining
 * its docs stays silent — the nudge is for the case where docs are NOT moving,
 * not for every edit. `docs.nudged` is the ordinary rate limit. A single fact
 * could not express "quiet because the work is being done" separately from
 * "quiet because I just spoke", and those must be distinguishable: the first is
 * success, the second is a cap.
 */
import {
  experimental_defineReact,
  tools,
  state,
  record,
  notice,
  nothing,
} from "vigiles/hook";

/** A doc edit — the thing whose absence this hook is watching for. */
function isDoc(path) {
  return (
    path.startsWith("docs/") ||
    path === "README.md" ||
    path.endsWith("CLAUDE.md.spec.ts") ||
    path.endsWith("CONTRIBUTING.md")
  );
}

/**
 * PRODUCT code — a change here can invalidate prose.
 *
 * Tests are excluded on purpose: a test states what the code already does, so a
 * test-only edit changes no documented behaviour. Including them would make the
 * hook fire through ordinary red-green work, which is how a nudge gets muted.
 */
function isProduct(path) {
  if (!path.startsWith("src/")) return false;
  if (path.includes(".test.")) return false;
  return path.endsWith(".ts") || path.endsWith(".mts");
}

const REMINDER =
  "vigiles: product code changed and no doc has been touched this session.\n" +
  "  · public — does a USER need this to act? `docs/**` + README\n" +
  "  · internal — does a CONTRIBUTOR need it to change the code safely? `CLAUDE.md`,\n" +
  "    edited through its `.spec.ts` (the `edit-spec` skill), never by hand\n" +
  "  · which tier a fact belongs in — the `public-vs-internal-docs` and `doc-tiers` rules\n" +
  "  · a NEW export instead of a behaviour change? that is the `ship-a-feature` skill\n" +
  "(silent while docs are being edited; otherwise at most once every 2h)";

export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Edit", "Write", "MultiEdit"),
  needs: [state("docs.followed"), state("docs.nudged")],
  react: (e) => {
    // `rel` is the repo-relative answer; `raw` is the fallback for a path with
    // no known root, so the hook classifies rather than silently deciding on
    // less than it looks like it is. Same shape as test-tier-nudge.
    const path = e.path.rel ?? e.path.raw;

    // A doc edit is the SUCCESS case: remember it, say nothing.
    if (isDoc(path)) return nothing(record("docs.followed", path));

    if (!isProduct(path)) return nothing();

    // Docs are moving in this session — the rule is being followed, stay quiet.
    if (e.ctx["docs.followed"].fresherThan("2h")) return nothing();

    // Ordinary rate limit, kept separate so the two silences never merge.
    if (e.ctx["docs.nudged"].fresherThan("2h")) return nothing();

    return notice(REMINDER, record("docs.nudged", path));
  },
});
