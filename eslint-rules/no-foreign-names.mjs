/**
 * `no-foreign-names` — the shared engine behind the repo's NAME FENCES: code
 * may not spell a name that belongs to somebody else. Not in a value, not in a
 * type, not in an identifier.
 *
 * Two fences are built from it, each a rule of its own with its own message:
 *
 *   local/no-harness-names  a harness (`"claude-code"`) outside its adapter
 *                           (`./no-harness-names.mjs` says why)
 *   local/no-rule-ids       a lint rule's id (`"hook-events"`) outside its
 *                           rule module in `src/rules/` (`./no-rule-ids.mjs`)
 *
 * The two are one mechanism because they are one mistake: generic code that
 * knows the name of one implementation. `boundaries/dependencies` stops the
 * IMPORT of that implementation; this stops the NAME, which imports nothing.
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
 * OPTIONS
 *
 *   names        REQUIRED. The names to forbid in strings. The caller supplies
 *                them, read from the directory that holds the implementations,
 *                so registering one turns the fence on for it with no edit here.
 *   identifiers  `true` — also forbid every name in identifiers; an ARRAY — only
 *                those names (a one-word name like `coverage` is an ordinary
 *                identifier word, so a fence can leave it to the string half).
 *   literals     name → other strings that spell it (a harness's config
 *                directory, its environment variables). See `containsLiteral`.
 *
 * Old sites are grandfathered in `eslint-suppressions.json`, which ESLint 10
 * refuses to let grow; a new spelling is an error.
 */

/**
 * Whether `text` spells a literal. A literal ending in a letter or a digit
 * (`.claude`) must not run on into another word character, so
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

/** The name an identifier spells across consecutive segments, if any. */
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

/** The option schema every fence built here takes. */
const SCHEMA = [
  {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" }, minItems: 1 },
      identifiers: {
        oneOf: [
          { type: "boolean" },
          { type: "array", items: { type: "string" } },
        ],
      },
      literals: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
    // 🔴 REQUIRED. A default list of names baked into the rule goes stale
    // SILENTLY: a new implementation is linted against a list that does not
    // know it, and nothing says so. The caller derives the list from disk.
    required: ["names"],
    additionalProperties: false,
  },
];

/** The names the identifier half checks, from the `identifiers` option. */
function identifierNames(opts, names) {
  if (opts.identifiers === true) return names;
  return Array.isArray(opts.identifiers) ? opts.identifiers : [];
}

/**
 * Build one fence: a rule whose findings read as `messages.hardcoded` (a name)
 * and `messages.literal` (another string that spells it). Both messages get
 * `{{name}}` and `{{where}}`; `literal` also gets `{{text}}`.
 *
 * @param {{ description: string, messages: { hardcoded: string, literal: string } }} spec
 * @returns {import("eslint").Rule.RuleModule}
 */
export function foreignNamesRule({ description, messages }) {
  return {
    meta: {
      type: "problem",
      docs: { description },
      schema: SCHEMA,
      messages,
    },

    create(context) {
      const opts = context.options[0] ?? {};
      const names = opts.names;
      const literals = Object.entries(opts.literals ?? {}).flatMap(
        ([name, texts]) => texts.map((text) => ({ name, text })),
      );

      /** squashed spelling → the canonical name, for identifier matching. */
      const squashed = new Map(
        identifierNames(opts, names).map((n) => [squash(n), n]),
      );

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
          if (squashed.size === 0) return;
          const hit = identifierSpells(node.name, squashed);
          if (hit !== null)
            report(node, "hardcoded", { name: hit, where: "an identifier" });
        },
      };
    },
  };
}
