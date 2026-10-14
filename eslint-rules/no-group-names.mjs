/**
 * An ESLint check on vigiles' OWN source code. vigiles sorts its product rules
 * into groups (`structural`, `workflow`, `nudge`, `experimental`) that decide
 * how far a rule's findings are trusted; this check stops generic code from
 * hardcoding a group's NAME (a type `ExperimentalFinding`, a list
 * `EXPERIMENTAL_RULES`, a branch on `"experimental"`), so a group is only ever
 * a field of a rule, read at run time. Registered as `local/no-group-names`.
 *
 * A rule group (`experimental`, `structural`, …) is a FACT about a rule today,
 * declared as data in `src/rules/groups.ts` and read off each rule's `group`
 * field at run time. Generic code that names one — a type `ExperimentalFinding`,
 * a field `AuditReport.experimental`, a list `EXPERIMENTAL_RULES`, a branch on
 * `"experimental"` — has baked one implementation into the contract: the next
 * group, or a rule that moves between groups, needs an edit in core. All four of
 * those shapes reached PR #387 before this rule existed, and the owner caught
 * them, not a check.
 *
 * A dedicated rule rather than `no-restricted-syntax` selectors: flat config
 * REPLACES that rule's options per file group, and this repo already sets it in
 * four blocks — a selector added to one would silently drop from the others.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO KINDS OF GROUP NAME, MEASURED (2026-10-14, `src/**`)
 *
 * `names` — a name whose COMPOUND forms mean nothing here but the group
 * (`experimental`, `structural`). Fenced: a camelCase identifier starting with
 * it (`experimentalResults`), a Pascal segment inside one (`isExperimentalRule`),
 * a Pascal type (`ExperimentalFinding`), a SCREAMING_ prefix
 * (`EXPERIMENTAL_RULES`), and a string literal that IS the name
 * (`"experimental"`). The snake prefix `experimental_` is the public-export
 * convention (`experimental-name`) and is not a group: `experimental_defineHook`
 * is left alone.
 *
 * ⚠️ THE BARE IDENTIFIER IS NOT FENCED, and that is a declared hole. A field
 * named `experimental` was one of the PR #387 mistakes (`AuditReport.experimental`),
 * but the same bare name is also the eval drivers' "this measurement is
 * experimental" caveat (`TriggerRateReport.experimental`, 15 sites in five files,
 * measured 2026-10-14), which is not a group. The mistake is still caught: such
 * a field needs a TYPE, and the type's name (`ExperimentalRuleResult`) is fenced.
 *
 * `setNames` — a group name that is ALSO an ordinary word here: `nudge` (the
 * hint concept — `skillTestNudge`, `NUDGE_AS_CONTEXT`, `"nudge"` in refs.ts)
 * and `workflow` (a GitHub Actions workflow — `vigilesWorkflow`). Fencing every
 * form would have opened at 70+ findings against correct code. Only the GROUP
 * sense is fenced: the name joined to `rule`/`rules`/`group` in one identifier
 * (`NUDGE_RULES`, `workflowRules`, `nudgeGroup`).
 *
 * The names are written in `eslint.config.mjs` from `eslint-rules/fence-names.mjs`;
 * `src/rules/groups.test.ts` asserts they equal the keys of `RULE_GROUPS`, the
 * way `adapter-contract.test.ts` binds the adapter directory names.
 */

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const alt = (xs) => xs.join("|");

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid naming a rule group (experimental, structural, …) in generic code.",
    },
    schema: [
      {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          setNames: { type: "array", items: { type: "string" } },
        },
        required: ["names"],
        additionalProperties: false,
      },
    ],
    messages: {
      group:
        '"{{name}}" names a rule GROUP ({{where}}). Groups are data in src/rules/groups.ts: ' +
        "read `group` off the RuleSpec you were handed and render the group's `label`, " +
        "and name the generic thing generically (`Finding`, `ungraded`).",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const names = opts.names ?? [];
    const setNames = opts.setNames ?? [];
    const patterns = [
      ...(names.length === 0
        ? []
        : [
            new RegExp(`^(${alt(names)})[A-Z]`),
            new RegExp(`[a-z0-9](${alt(names.map(cap))})`),
            new RegExp(`^(${alt(names.map(cap))})([A-Z]|$)`),
            new RegExp(`^(${alt(names.map((n) => n.toUpperCase()))})(_|$)`),
          ]),
      ...(setNames.length === 0
        ? []
        : [
            new RegExp(`(^|[^A-Za-z])(${alt(setNames)})_?(rules?|group)`, "i"),
            new RegExp(`[a-z0-9](${alt(setNames.map(cap))})(Rules?|Group)`),
          ]),
    ];
    const exact = new Set(names);
    const report = (node, where) =>
      context.report({
        node,
        messageId: "group",
        data: { name: String(node.name ?? node.value), where },
      });

    return {
      Identifier(node) {
        if (patterns.some((p) => p.test(node.name)))
          report(node, "an identifier");
      },
      Literal(node) {
        if (typeof node.value === "string" && exact.has(node.value))
          report(
            node,
            node.parent?.type === "TSLiteralType"
              ? "a string literal in TYPE position"
              : "a string literal",
          );
      },
    };
  },
};
