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
 * WHAT IT VISITS, AND WHY THAT IS ONLY THREE NODE TYPES
 *
 * Measured against this repo's own parser (`@typescript-eslint/parser` 8.58,
 * TypeScript 5.9) rather than reasoned about: a string in TYPE position is a
 * plain `Literal` nested under `TSLiteralType`. Every position below produced a
 * `Literal`, a `TemplateElement`, or an `Identifier` — there is no fourth kind of
 * node to visit, so the rule does not carry machinery for one:
 *
 *   type H = "claude-code" | "codex"        Literal  < TSLiteralType < TSUnionType
 *   declare function f(h: "codex")          Literal  < TSLiteralType < TSTypeAnnotation
 *   interface X { name: "claude-code" }     Literal  < TSLiteralType < TSTypeAnnotation
 *   type K = `${"codex"}-suffix`            Literal  < TSLiteralType < TSTemplateLiteralType
 *   type A = `codex-${string}`              TemplateElement          < TSTemplateLiteralType
 *   type O = Pick<C, "codex">               Literal  < TSLiteralType < TSTypeParameterInstantiation
 *   type M = { [k in "codex"]: 1 }          Literal  < TSLiteralType < TSMappedType
 *   type I = import("../adapters/codex/x")  Literal  < TSImportType
 *   enum H { Codex = "codex" }              Identifier + Literal     < TSEnumMember
 *   const x = { "codex": 1 }                Literal  < Property
 *   import { codexLayout } from "…/codex/…" Identifier + Literal     < ImportDeclaration
 *   adapter.name === "codex"                Literal  < BinaryExpression
 *
 * A comment saying the word `codex` is none of those three, which is the whole
 * reason this is a rule over an AST and not a grep. A grep would flag this
 * file's own header, and a check that flags its own documentation is a check
 * people delete.
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
 * TOKENS, NOT SUBSTRINGS
 *
 * A string matches only when the name stands as a whole token — bounded by a
 * non-alphanumeric character or the end of the string. So `"../adapters/codex/x"`
 * matches and `"codexy"` does not, and the rule cannot be satisfied by a rename
 * that merely buries the word.
 *
 * An identifier is split into case/underscore segments and matched against a
 * CONSECUTIVE RUN of them, so `claudeCodeLayout` → `[claude, code, layout]`
 * matches `claudecode`, `openCodeDriver` matches `opencode`, and `decoded` — one
 * segment, no run — does not. This is the part that would be unwritable as a
 * `no-restricted-syntax` selector regex, which sees the identifier as one flat
 * string.
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
 */

/**
 * Whether `text` spells a harness literal. A literal ending in a letter or a
 * digit (`.claude`) must not run on into another word character, so
 * `.claudette/cache` is not Claude Code while `.claude/x` and `.claude-plugin`
 * are. A literal ending in `_` (`ANTHROPIC_`) is a prefix by design.
 */
function containsLiteral(text, literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = /[A-Za-z0-9]$/.test(literal) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(escaped + end).test(text);
}

/** `claude-code` → `claudecode`, so identifier segments can be matched to it. */
const squash = (name) => name.replace(/[^a-z0-9]+/gi, "").toLowerCase();

/**
 * Does `text` contain `name` as a whole token?
 *
 * Built per call rather than cached in a module-level map: a rule instance lives
 * for one lint run over a handful of names, and a cache keyed on user-supplied
 * strings is a leak with no measured payoff.
 */
function containsToken(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

/**
 * The lowercase case/underscore segments of an identifier.
 *
 * `claudeCodeLayout` → `[claude, code, layout]`; `CODEX_X` → `[codex, x]`;
 * `decoded` → `[decoded]`.
 */
function segments(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? [])
    .map((s) => s.toLowerCase());
}

/** The harness name an identifier spells across consecutive segments, if any. */
function identifierSpells(name, squashed) {
  const parts = segments(name);
  for (let i = 0; i < parts.length; i++) {
    let run = "";
    for (let j = i; j < parts.length; j++) {
      run += parts[j];
      const hit = squashed.get(run);
      if (hit !== undefined) return hit;
      // Longer runs can only grow; stop once no name still starts with `run`.
      if (![...squashed.keys()].some((k) => k.startsWith(run))) break;
    }
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid harness names (claude-code, codex, opencode) in the harness-agnostic domain, in value AND type positions.",
    },
    schema: [
      {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, minItems: 1 },
          identifiers: { type: "boolean" },
          // Harness name → the other strings that spell it: its config directory, its
          // environment variables. See `containsLiteral` for how they match.
          literals: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
        // 🔴 REQUIRED, and it used to have a DEFAULT_NAMES fallback baked into
        // this file. A hand-written list of the adapters that exist is the same
        // defect the port redesign removes everywhere else: it goes stale
        // SILENTLY — a fourth adapter would have been linted against a list that
        // did not know its name, and nothing would have said so. The caller now
        // supplies the list, and `eslint.config.mjs` derives it by reading
        // `src/adapters/`, so there is no copy to keep true.
        required: ["names"],
        additionalProperties: false,
      },
    ],
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
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const names = opts.names;
    const checkIdentifiers = opts.identifiers === true;
    const literals = Object.entries(opts.literals ?? {}).flatMap(
      ([name, texts]) => texts.map((text) => ({ name, text })),
    );

    /** squashed spelling → the canonical name, for identifier matching. */
    const squashed = new Map(names.map((n) => [squash(n), n]));

    // One report per source position. `import { codexLayout }` puts two
    // Identifier nodes on the same range (imported + local), and two errors for
    // one mistake reads as two mistakes.
    const reported = new Set();
    const report = (node, messageId, data) => {
      const at = node.range[0];
      if (reported.has(at)) return;
      reported.add(at);
      context.report({ node, messageId, data });
    };

    const scanText = (node, text, where) => {
      const name = names.find((n) => containsToken(text, n));
      if (name !== undefined) {
        report(node, "hardcoded", { name, where });
        return;
      }
      const hit = literals.find((l) => containsLiteral(text, l.text));
      if (hit !== undefined) report(node, "literal", { ...hit, where });
    };

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        scanText(
          node,
          node.value,
          node.parent?.type === "TSLiteralType"
            ? "a string literal in TYPE position"
            : "a string literal",
        );
      },

      TemplateElement(node) {
        scanText(
          node,
          node.value.raw,
          node.parent?.type === "TSTemplateLiteralType"
            ? "a template literal TYPE"
            : "a template literal",
        );
      },

      Identifier(node) {
        if (!checkIdentifiers) return;
        const hit = identifierSpells(node.name, squashed);
        if (hit !== null)
          report(node, "hardcoded", { name: hit, where: "an identifier" });
      },
    };
  },
};
