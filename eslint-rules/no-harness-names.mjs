/**
 * `local/no-harness-names` — code may not spell a harness that is not its own.
 * Not in a value, not in a type, not in an identifier.
 *
 * A harness is spelled by its name (`"claude-code"`) and, through the `literals`
 * option, by its directory (`.claude/`) and its environment variables
 * (`ANTHROPIC_`). eslint.config.mjs runs the rule over every file in src/:
 * outside the adapters every harness is forbidden, inside `src/adapters/<h>/`
 * every harness but h. Tests are included, because a test of generic code that
 * names Claude Code is a test of Claude Code.
 *
 * It sits beside `boundaries/dependencies`, which stops the IMPORT of an
 * adapter. Neither covers the other: the string "claude-code" imports nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TYPE POSITIONS ARE COVERED
 *
 * When this rule was written, src/core (non-test) held eight harness names
 * while the import boundary was green. Five of the eight traced to one type
 * alias, and that is the argument for covering type positions rather than only
 * expressions:
 *
 *     src/core/dialect.ts:29
 *       export type SkillFrontmatterProfile = "claude-code" | "minimal";
 *
 * From there the name propagates into every signature that mentions the type —
 * `compile.ts` takes it as a default parameter, branches on it, and defaults it
 * again; `lethal-trifecta.ts` compares against it. A rule that visited only
 * literals reachable from expressions would have reported the four USES and
 * stayed silent on the DECLARATION that put them there, which is the wrong way
 * round: the declaration is the cheap fix and the uses are its shadow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN IDENTIFIER OPTION
 *
 * Banning the string `"codex"` while allowing `import { codexLayout }` in the
 * same file protects very little, so eslint.config.mjs turns `identifiers` on
 * everywhere. Old identifier hits, such as `claudeCodeLayout` as the default
 * `layout` parameter in src/scan.ts, are listed in eslint-suppressions.json
 * until those modules take the layout from their caller. The option stays so a
 * codebase can adopt the string half first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE NAMES COME FROM — not from here
 *
 * `names` is REQUIRED. This file used to carry
 * `DEFAULT_NAMES = ["claude-code", "codex", "opencode"]`, and a hand-written
 * list of which adapters exist goes stale in silence: a fourth adapter would be
 * linted against a list that did not know its name, and nothing would report it.
 * `eslint.config.mjs` now derives the list by reading `src/adapters/`, so
 * registering an adapter turns the rule on for its name with no edit here.
 *
 * ⚠️ MEASURED AND REJECTED: a second, LIST-FREE arm. The redesign proposed
 * `BinaryExpression[operator=/^[!=]==$/] > MemberExpression[property.name="name"]`
 * beside this rule, on the argument that "never compare `.name` in the domain"
 * cannot go stale. Run over `src/core/**` plus the four detectors it produces 46
 * findings, 21 of them non-test and essentially all correct code — `spec.ts`
 * comparing a spec type's name, `vocabulary-consistency.ts` comparing a term's,
 * `hook-program.ts` comparing an event's. Narrowing to `.name === <literal>`
 * still leaves 14. The selector cannot tell an ADAPTER's name from any other
 * `.name`, and a rule that opens at `error` with fourteen findings against
 * correct code is switched off the same day. Making the domain unable to
 * RECEIVE a harness name is the construction that works, and it is a change to
 * the code, not to this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPTING OUT, and the shape of the ratchet
 *
 * Severity is `error` with the existing sites carrying a per-line disable that
 * names its reason:
 *
 *     // eslint-disable-next-line local/no-harness-names -- <why>
 *
 * The alternative considered and rejected was a file-level allowlist in
 * `eslint.config.mjs`. It would have exempted four whole modules out of the 85 in
 * `src/core/`, so a fifth harness name could be added to any of them for free;
 * and it would have had to be edited by anyone deleting a site, which is the one
 * thing an in-flight redesign of this area must not have to do. A disable comment
 * is deleted together with the line it guards, and a leftover one surfaces as an
 * unused-disable-directive warning rather than a failure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM lives in `./no-foreign-names.mjs` (which node types it visits,
 * tokens rather than substrings, identifier segments), shared with
 * `local/no-rule-ids`. This file is the harness fence's configuration of it:
 * its description and its messages.
 */
import { foreignNamesRule } from "./no-foreign-names.mjs";

export default foreignNamesRule({
  description:
    "Forbid harness names (claude-code, codex, opencode) in the harness-agnostic domain, in value AND type positions.",
  messages: {
    hardcoded:
      'Harness-agnostic code must not spell the harness name "{{name}}" ({{where}}). ' +
      "Read the fact off the injected HarnessDialect / PluginLayout — e.g. a CAPABILITY " +
      "field on the dialect rather than a comparison against its name — or move this " +
      "module into the application layer. A harness name in a TYPE is worse than one in " +
      "an expression: it propagates into every signature that references the type. " +
      "See research/code-adapter-architecture.md.",
    literal:
      '"{{text}}" belongs to the {{name}} adapter ({{where}}). Outside that adapter, ' +
      "read it from the adapter's PluginLayout / HarnessDialect instead of spelling it.",
  },
});
