---
name: hexagonal-architecture
description: Decide WHERE new code goes and WHO may know about whom, before writing it — vigiles is hexagonal (domain, app, adapters, root), and the recurring failure is generic code that names a specific implementation (a rule id, a harness, a group) or an inner layer that imports an outer one. Use before adding a module, a registry or list of things, a type or field named after one thing, a config key derived from a set, or a function that needs "all the rules / all the harnesses"; and whenever a reviewer says "wrong dependency direction", "core knows about X", or "hexagonal". NOT a general architecture essay — it is this repo's map plus the questions that catch the mistake.
---

# Hexagonal architecture in vigiles

One rule decides everything below: **dependencies point inward.** The inner layer defines
what it needs (a port: an interface or a type); outer code implements it; one composition
root picks the implementations and hands them in. An inner file never imports, names or
lists an outer thing — not by import, not by string, not by type name.

## The map (what `eslint.config.mjs` enforces today)

| layer   | where                                     | may import              | knows about                                   |
| ------- | ----------------------------------------- | ----------------------- | --------------------------------------------- |
| domain  | `src/core/`                               | domain, pure libraries  | nothing outside itself                        |
| app     | `src/*.ts` (scan, score, report, runners) | domain, other app files | ports, never a concrete adapter               |
| adapter | `src/adapters/<harness>/`, `src/host/`    | domain only             | its own harness (host: the machine) only      |
| rule    | `src/rules/<id>.ts`                       | domain only             | its own id and nothing else                   |
| ruleset | `src/rules/{index,groups}.ts`             | rules, domain           | every rule and group — the set the root reads |
| io      | `src/{adapters/*,host}/*.io.ts`           | + I/O modules           | the outside world                             |
| root    | `src/cli{,-main}.ts`, `src/entries/*.ts`  | anything                | everything — the only places that wire        |
| tests   | `src/**/*.test.ts`                        | anything                | —                                             |

Held by `boundaries/dependencies` (`layers()` in `packages/eslint-config/index.mjs`, with
the `rules`/`ruleset` file categories for the rule layer), `local/no-harness-names` (no
file spells a harness other than its own adapter's), `local/no-rule-ids` (no file spells a
rule id but the rule's own module, its test and the set), `local/no-group-names` (no
generic file names a rule group) and `local/no-kit-names` (rule-proof's generic files spell
no linter kit).

`src/host/` is the adapter for the MACHINE — files and processes no harness owns (rule-proof
runs another repository's linter). It is not a harness: `HARNESS_NAMES` and the adapter
contract read `src/adapters` only. A package entry that needs an adapter (`vigiles/rule-proof`)
is served from `src/entries/<name>.ts`, a composition root — an app barrel may not import an
adapter, and the old barrels that do (`claude-code.ts`, `eval.ts`) are grandfathered, not a model.

Harnesses are the worked example of doing it right: core declares the five ports
(`HarnessDialect`, `PluginLayout`, `HarnessRuntime`, `HookProtocol`, `ModelMock`), each
`src/adapters/<harness>/` implements them, and only the root (and the testing barrels that
default to one) chooses which adapter runs. Adding a harness = one new directory + one
registration at the root; core does not change. **Copy this shape for anything else that
comes in many kinds** — lint rules, report renderers, linter catalogs.

## The mistakes this skill exists for

All four happened in one PR (#387) and were caught by the owner, not by a check:

1. **An inner file lists the outer things.** `EXPERIMENTAL_RULES = ["skill-resource-resolves"]`
   in `src/core/`. A list of implementations is knowledge about the outside. It belongs to
   the outer layer (or is DERIVED from the implementations' own declarations).
2. **The "registry" lives in core and imports implementations.** Moving a list into one
   file inside core does not fix (1); it only concentrates it. The set of implementations
   is assembled OUTSIDE core and passed IN — as a parameter or through a port.
3. **A type, field or function is named after one implementation or category.**
   `ExperimentalFinding`, `AuditReport.experimental`, `ScanReport.experimental["<rule id>"]`.
   Being in a group is a fact about a rule TODAY, not what a finding IS. Generic code gets a
   generic type (`Finding`, `ungraded`), and the category is a FIELD read at run time.
4. **A per-implementation default restated in generic code.** `"<rule id>": severitySchema.default(false)`
   in the config schema. The rule declares its own default; the schema is BUILT from the
   declarations (`buildConfigSchema(rules)`), not written next to them.

Again in PR #415 (2026-11-02), with this skill LOADED before the code was written: rule-proof
supported two linters and its steps file branched on `reading.linter === "eslint"` 30 times,
one 600-line domain file held both linters plus the Node install, and the io adapter wired the
public object. Lint caught only the I/O placement; the owner's "show me the architecture"
caught the rest. The fix was the harness shape again — a `ProofKit` port, one kit module per
linter, `kits/index.ts` as the only list, `src/entries/rule-proof.ts` as the root — plus the
`no-kit-names` fence. Reading the questions is not answering them: write question 2's table.

## Questions to answer before writing the code

1. **Who knows about whom?** Draw the arrows. Any arrow from `src/core` (or app) to a
   specific implementation is wrong.
2. **Adding one more of these — how many files change?** Target: the new module + one line
   in the outer list the root reads. If a generic file would also change, the design leaks.
   **Write the answer down BEFORE the code**, in the PR body, as a row per kind of thing:
   `kind → where the list is → files that change for one more`. TWO of something already
   counts as "many kinds": two is when the `if (x.kind === "a") … else …` gets written.
3. **Does any generic file spell the name** of one implementation (id string, type name,
   field name, enum member)? If yes, move that knowledge into the implementation.
4. **Is a category a list somewhere, or a field of the thing?** It must be a field; lists
   are derived (`rules.filter(r => r.group === g)`).
5. **Who builds the set?** Only a composition root (`src/cli{,-main}.ts`, a package entry
   in `src/entries/`, and the browser demo's entry for the site). Core functions take it as an argument.
6. **What does the type system have to carry?** When core stops importing the set, typed
   things that depended on it (the config type, a union of ids) become generics over the
   set, exported from the outer layer or the root. That is the cost; pay it, do not route
   around it by importing inward-out.
7. **Which check holds it?** Every answer above needs a mechanism — a `boundaries` element
   and policy, a name fence like `no-harness-names`, a type, or a planted-violation test.
   A rule held only by this text will be broken by the next agent (prose is not policy).
   **A new family of implementations gets its own name fence**, built on
   `eslint-rules/no-foreign-names.mjs` (a dozen lines — `no-kit-names.mjs` is the smallest
   example): the names read from the family's directory in `eslint.config.mjs`, the fence
   on the generic files only, and planted cases in `eslint-rules/fences.corpus.test.ts` that
   fire on a generic file and stay quiet in the implementation, the set and the root.
   `boundaries` stops the IMPORT of an implementation; only a name fence stops the BRANCH on
   its name, which imports nothing.

## What is not a violation

- The composition root importing and wiring everything. That is its job — though even the
  root spells no rule id: it picks a rule off the set by a property of the rule.
- An implementation naming itself (an adapter spelling its own harness; a rule module its
  own id) and its own tests.
- Detectors in `src/core`. A pure function that resolves a path or parses frontmatter is a
  domain capability; the POLICY around it (id, group, default, how to present) is what lives
  outside.
- Grandfathered sites recorded in `eslint-suppressions.json`. The count may only go down;
  a new one is an error. Grandfathering is for old code, never for the change you are making.

## Where this is decided and recorded

- Layers and policies: `layers()` in `packages/eslint-config/index.mjs`, wired in `eslint.config.mjs`.
- Harness fence: `eslint-rules/no-harness-names.mjs` (its header says why).
- Root `CLAUDE.md` → Architecture section (compiled from `CLAUDE.md.spec.ts`).
- The rule layer (landed in PR #387): core declares the port (`src/core/rule.ts`), a rule is a
  module `src/rules/<id>.ts`, `src/rules/groups.ts` is the group record and
  `src/rules/index.ts` the set; the roots (`src/cli-main.ts`, `site/src/demo/runAudit.ts`,
  `scripts/build-config-schema.mjs`) hand it to `configFor` / `initPolicyOf` / `applyRules`.
  Fences: the `rules`/`ruleset` boundaries categories, `local/no-rule-ids`,
  `local/no-group-names`, `local/frame-mint` on `FilteredScan`, and `no-restricted-syntax` on
  `.ungraded` in the scorers — planted violations in `eslint-rules/fences.corpus.test.ts`
  and `packages/eslint-config/index.test.ts`. 35 rules are still rows in `src/rules/index.ts`
  and old spellings are grandfathered; moving them and reaching zero is #390.
  `docs/contributing/rules.md#rules-are-an-outer-layer` has the invariant table.
