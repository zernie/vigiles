/**
 * `local/no-harness-names`, one case per POSITION a harness name can occupy.
 *
 * The positions are enumerated ONCE, in `POSITIONS`, and both halves of the suite
 * are generated from that one list: the violating snippet must fire, and the same
 * shape with the name read from a port must stay silent. That is deliberate and
 * it is the lesson from `experimental-name` (#170), where nine review findings
 * arrived in sequence — aliased re-export, then a separately-exported local, then
 * `export default`, then a destructured binding — each after the previous fix was
 * called complete. Case-by-case tests could never say when the list was finished,
 * because they only ever held the forms somebody had already thought of.
 *
 * Driving both halves off one enumeration makes an uncovered position a MISSING
 * ROW rather than a silent gap, and makes the coverage readable: the row names
 * below are the claim this rule makes about what it sees.
 *
 * The TYPE positions are the ones worth the ceremony. A rule that visited only
 * literals reachable from expressions would pass every type row while the domain
 * held `type SkillFrontmatterProfile = "claude-code" | "minimal"` — and a
 * type-level hardcode is the worse one, because it propagates into every
 * signature that names the type.
 */
import { RuleTester } from "eslint";
import tsparser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "./no-harness-names.mjs";

RuleTester.describe = describe as never;
RuleTester.it = it as never;
RuleTester.itOnly = it.only as never;

const tester = new RuleTester({
  languageOptions: {
    parser: tsparser as never,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

/** The core configuration: identifiers included (measured 0 hits there today). */
const CORE = [{ identifiers: true }];

interface Position {
  /** What this row claims the rule can see. */
  readonly id: string;
  /** The violating shape. */
  readonly bad: string;
  /** The same shape with the fact read from a port instead of spelled. */
  readonly good: string;
  /** How many findings `bad` produces. Two where one line holds two nodes. */
  readonly errors: number;
}

/**
 * Every position measured against this repo's parser. `enum` and `import` yield
 * TWO nodes on one line — the member's NAME and its VALUE, the binding and the
 * module specifier — and both are real, so both are counted rather than deduped
 * into a prettier number.
 */
const POSITIONS: readonly Position[] = [
  {
    id: "type-union",
    bad: 'type Harness = "claude-code" | "codex";',
    good: "type Harness = AdapterName;",
    errors: 2,
  },
  {
    id: "type-parameter-annotation",
    bad: 'declare function f(h: "codex"): void;',
    good: "declare function f(h: AdapterName): void;",
    errors: 1,
  },
  {
    id: "type-property-signature",
    bad: 'interface X { readonly name: "claude-code" }',
    good: "interface X { readonly name: AdapterName }",
    errors: 1,
  },
  {
    id: "type-template-interpolation",
    bad: "type Key = `${'codex'}-suffix`;",
    good: "type Key = `${AdapterName}-suffix`;",
    errors: 1,
  },
  {
    id: "type-template-raw-text",
    bad: "type Root = `codex-${string}`;",
    good: "type Root = `${AdapterName}-${string}`;",
    errors: 1,
  },
  {
    id: "type-argument",
    bad: 'type Only = Pick<Config, "codex">;',
    good: "type Only = Pick<Config, AdapterName>;",
    errors: 1,
  },
  {
    id: "type-mapped-key",
    bad: 'type M = { [k in "codex"]: number };',
    good: "type M = { [k in AdapterName]: number };",
    errors: 1,
  },
  {
    id: "type-import",
    bad: 'declare const d: import("../adapters/codex/x.js").T;',
    good: 'declare const d: import("../core/adapter.js").T;',
    errors: 1,
  },
  {
    id: "enum-member",
    bad: 'enum H { Codex = "codex" }',
    good: 'enum H { Primary = "primary" }',
    errors: 2,
  },
  {
    id: "object-key",
    bad: 'const x = { "codex": 1 };',
    good: 'const x = { "primary": 1 };',
    errors: 1,
  },
  {
    id: "import-specifier-and-module-path",
    bad: 'import { codexLayout } from "../adapters/codex/layout.js";',
    good: 'import { injectedLayout } from "../core/layout.js";',
    errors: 2,
  },
  {
    id: "value-comparison",
    bad: 'const n = adapter.name === "codex";',
    good: "const n = adapter.supportsSkillFence;",
    errors: 1,
  },
  {
    id: "value-template-interpolation",
    bad: 'const t = `run ${"codex"} now`;',
    good: "const t = `run ${adapter.name} now`;",
    errors: 1,
  },
  {
    id: "value-template-raw-text",
    bad: "const t = `codex-${suffix}`;",
    good: "const t = `${adapter.name}-${suffix}`;",
    errors: 1,
  },
  {
    id: "default-parameter",
    bad: 'function g(p: Profile = "claude-code") { return p; }',
    good: "function g(p: Profile = dialect.skillFrontmatter) { return p; }",
    errors: 1,
  },
  {
    id: "identifier-camel-case",
    bad: "const layout = claudeCodeLayout;",
    good: "const layout = injectedLayout;",
    errors: 1,
  },
  {
    id: "identifier-screaming-snake",
    bad: "const a = CODEX_ADAPTER;",
    good: "const a = DEFAULT_ADAPTER;",
    errors: 1,
  },
];

tester.run("no-harness-names (positions)", rule as never, {
  // Half one: the clean shape of every position stays silent. Without this half
  // the suite below is satisfied by a rule that reports everything, which fails
  // a correct build — and a rule that fails correct builds is switched off
  // rather than fixed.
  valid: [
    ...POSITIONS.map((p) => ({
      name: `${p.id}: reading the fact off a port is accepted`,
      code: p.good,
      options: CORE,
    })),

    // The reason this is an AST rule and not a grep: a grep would flag this
    // file, the rule's own header, and every docs page that names a harness.
    {
      name: "prose: a comment naming codex and claude-code is not code",
      code: "// codex and claude-code are named here on purpose\nconst x = 1;",
      options: CORE,
    },
    {
      name: "prose: a JSDoc block naming a harness is not code",
      code: "/** Works on claude-code and codex. */\nexport const x = 1;",
      options: CORE,
    },

    // Tokens, not substrings — in both halves of the matcher.
    {
      name: "lookalike string: a name buried inside a longer word is not a hit",
      code: 'const s = "codexy";',
      options: CORE,
    },
    {
      name: "lookalike identifier: `decoded` is one segment, not a run",
      code: "const decoded = 1;",
      options: CORE,
    },
    {
      name: "unrelated harness-shaped words are left alone",
      code: 'const s = "the codebase"; const opened = 1;',
      options: CORE,
    },

    // The DECLARED HOLE, asserted rather than described: with the default
    // options the identifier half is off, which is how `src/scan.ts` and
    // `src/test-coverage.ts` are configured. If someone turns it on for them
    // this case fails, which is the conversation we want to have.
    {
      name: "default options: the identifier half is OFF (the declared hole)",
      code: "const layout = claudeCodeLayout;",
    },
    // …and the string half stays on for them regardless.
  ],

  // Half two: every position, spelled out, is reported. Without this half the
  // valid list above is satisfied by a rule that does nothing at all.
  invalid: POSITIONS.map((p) => ({
    name: `${p.id}: a spelled harness name is reported`,
    code: p.bad,
    options: CORE,
    errors: p.errors,
  })),
});

tester.run("no-harness-names (string half, default options)", rule as never, {
  valid: [
    {
      name: "identifier is not reported by default",
      code: "const a = codexDriver;",
    },
  ],
  invalid: [
    {
      name: "a string is reported even with the identifier half off",
      code: 'const n = adapter.name === "codex";',
      errors: 1,
    },
    {
      name: "a type-position string is reported even with the identifier half off",
      code: 'type H = "claude-code";',
      errors: 1,
    },
  ],
});

tester.run("no-harness-names (configured names)", rule as never, {
  valid: [
    {
      name: "a name absent from the configured list is not reported",
      code: 'const n = x === "codex";',
      options: [{ names: ["gemini"] }],
    },
  ],
  invalid: [
    {
      name: "a configured name is reported",
      code: 'const n = x === "gemini";',
      options: [{ names: ["gemini"] }],
      errors: 1,
    },
  ],
});
