# vigiles Feature Ideas: Programming Techniques as Product Features

Focus: **deterministic, mechanically checkable** features that vigiles provides **to users** of the tool. Each maps a proven programming technique to a real problem in messy production AI-adopting codebases.

---

## 1. Custom Rule Plugin API (Railway-Composable)

**Analog:** Railway-oriented programming + ESLint's plugin system.

**User problem:** Every team has conventions vigiles can't anticipate. "All rules must reference a Jira ticket." "Every section must have examples." No way to add custom checks without forking.

**What vigiles provides:** A plugin API where each rule is a pure function `(parsedRule) → Diagnostic | null`. Rules compose in a pipeline — collect-all mode for IDEs, short-circuit for CI.

```js
// .vigiles/rules/require-jira.mjs
export default {
  name: "require-jira",
  meta: { description: "Every rule must reference a Jira ticket" },
  check(rule, context) {
    if (!/[A-Z]+-\d+/.test(rule.body)) {
      return {
        message: `Rule "${rule.title}" missing Jira reference`,
        line: rule.line,
      };
    }
  },
};
```

```json
{ "plugins": ["./.vigiles/rules/require-jira.mjs"] }
```

**Railway composition:** Rules can't have side effects — they receive parsed data and return diagnostics only. Pipeline ordering is user-controlled. Each step is `Content → Result<ok, Diagnostic[]>`.

---

## 2. Reverse Coverage: Linter → Instruction Mapping

**Analog:** Code coverage reports — but inverted. "Which linter rules lack a corresponding instruction?"

**User problem:** Team has 200 ESLint rules configured. CLAUDE.md explains 5 of them. When an agent trips `no-restricted-imports`, it has no context about _why_ that rule exists — it just blindly fixes. The agent is following rules it doesn't understand.

**What vigiles provides:** A report showing which configured linter rules have corresponding CLAUDE.md entries and which don't.

```
vigiles coverage:

  ESLint: 5 / 47 rules documented (10.6%)

  Documented:
    ✓ no-console          → CLAUDE.md:42 "No console.log in production"
    ✓ no-restricted-imports → CLAUDE.md:48 "Always use barrel file imports"

  Undocumented (top 10 most-triggered):
    ✗ @typescript-eslint/no-explicit-any
    ✗ import/no-cycle
    ✗ react-hooks/exhaustive-deps
    ...

  Ruff: 0 / 12 rules documented (0%)
```

**Why this matters:** This is the inverse of `require-rule-file` (which checks instruction→linter). This checks linter→instruction. Together they form a bidirectional consistency check. The agent doesn't just follow rules — it _understands_ them.

**Implementation:**

- Read linter configs (`.eslintrc`, `ruff.toml`, etc.) to get list of enabled rules
- Cross-reference against `**Enforced by:**` annotations in instruction files
- Report coverage percentage and undocumented rules
- `vigiles coverage` CLI command + `--json` output

---

## 3. Dead Enforcement Detection

**Analog:** Dead code detection / tests marked `skip()` that still count as "covered."

**User problem:** CLAUDE.md says `**Enforced by:** eslint/no-console` but `.eslintrc` has `"no-console": "off"`. The enforcement is a lie. The agent thinks there's a safety net, but nothing actually catches violations. It's like a smoke detector with dead batteries.

**What vigiles provides:** Cross-checks `**Enforced by:**` claims against actual linter configuration to verify the rule is enabled.

```
vigiles validate CLAUDE.md:

  CLAUDE.md:42  Dead enforcement: "no-console" is referenced but disabled in .eslintrc.json
  CLAUDE.md:55  Dead enforcement: "no-restricted-imports" rule not found in ESLint config
```

**Implementation:**

- Extend `require-rule-file` (which already resolves linter rules) to also check if the rule is _enabled_
- ESLint: load flat config, check if rule severity > 0
- Ruff: parse `ruff.toml` / `pyproject.toml` select/ignore lists
- RuboCop: parse `.rubocop.yml` enabled/disabled cops
- New rule: `no-dead-enforcement` (default: "auto" like require-rule-file)

---

## 4. Instruction Snapshot Testing

**Analog:** Jest snapshot testing — lock down expected output, CI alerts on unexpected changes.

**User problem:** Instruction files change silently. Someone refactors CLAUDE.md, accidentally removes a rule or changes an enforcement annotation. Without structural awareness, PR reviewers just see markdown diffs — easy to miss that a rule was weakened.

**What vigiles provides:** `vigiles snapshot` generates a structured JSON summary of all instruction files. Commit it. CI diffs against it. Any unexpected structural change fails the build.

```json
// .vigiles/snapshot.json (committed)
{
  "CLAUDE.md": {
    "rules": [
      {
        "title": "No console.log in production",
        "enforcement": "enforced",
        "enforcedBy": "eslint/no-console",
        "line": 42
      },
      {
        "title": "Use Tailwind spacing scale",
        "enforcement": "guidance",
        "line": 55
      }
    ],
    "lineCount": 89,
    "enforced": 3,
    "guidance": 2
  }
}
```

```
$ vigiles snapshot --check
Snapshot mismatch:
  - Removed rule: "Use barrel file imports" (was enforced)
  + Added rule: "Use direct imports" (guidance only)
  ~ Changed: "No console.log" enforcement: enforced → guidance

Run `vigiles snapshot --update` to accept changes.
```

**Implementation:**

- `vigiles snapshot` — generate/update snapshot file
- `vigiles snapshot --check` — compare current state against committed snapshot
- Snapshot includes: rules, enforcement status, line numbers, counts
- Integrates with existing `parseClaudeMd` output

---

## 5. Stale Reference Detection

**Analog:** Broken link checkers / unused import warnings / dead code elimination.

**User problem:** Rules reference specific files, packages, and scripts that change over time. "Always use `src/utils/logger.ts`" persists months after `logger.ts` was renamed to `telemetry.ts`. The instruction is actively misleading.

**What vigiles provides:** Validates that file paths, package names, and script references in instruction files actually exist.

```
CLAUDE.md:42  Stale reference: `src/utils/logger.ts` does not exist
CLAUDE.md:55  Stale reference: `npm run typecheck` — no "typecheck" script in package.json
CLAUDE.md:68  Stale reference: package `lodash` not found in package.json
```

**What it checks (all deterministic):**

- File paths in backticks → `fs.existsSync()`
- `npm run <script>` → check `package.json` scripts
- Package names → check manifest files (package.json, requirements.txt, Cargo.toml)
- Command names in hooks → `which` check

---

## 6. `vigiles init` — Scaffold from Existing Linter Config

**Analog:** `eslint --init` / `npm init` / scaffolding generators.

**User problem:** Team has 200 ESLint rules, a Ruff config, and RuboCop setup — but no CLAUDE.md. Writing one from scratch is tedious and error-prone. Most teams never start because the blank page is too daunting.

**What vigiles provides:** Auto-generates a CLAUDE.md skeleton from existing linter configurations, pre-populated with `**Enforced by:**` annotations.

```
$ vigiles init

Detected linters:
  ✓ ESLint (47 rules enabled)
  ✓ Ruff (12 rules enabled)

Detected AI tools:
  ✓ Claude Code (.claude/ directory found)
  ✓ Cursor (.cursor/ directory found)

Generated:
  ✓ CLAUDE.md (47 rules from ESLint, 12 from Ruff)
  ✓ .cursorrules (copied from CLAUDE.md)

$ head CLAUDE.md
# CLAUDE.md

## Rules

### No console.log in production
**Enforced by:** `eslint/no-console`

### No explicit any
**Enforced by:** `@typescript-eslint/no-explicit-any`
...
```

**Implementation:**

- Read linter configs using existing resolver infrastructure
- Generate markdown with proper annotation format
- Group rules by linter/category
- Generate for all detected AI tools

---

## 7. Token Budget Linting

**Analog:** Webpack bundle size budgets / Lighthouse performance budgets.

**User problem:** `max-lines: 500` is crude. A 200-line file with code block examples burns more tokens than a 400-line file of terse rules. Teams have no visibility into what's eating their context window — the scarce resource.

**What vigiles provides:** Actual token counting with per-section breakdown and configurable budgets.

```
CLAUDE.md token budget: 1550 / 2000

  ## Commands        120 tokens  (8%)
  ## Architecture    340 tokens (22%)
  ## Rules           890 tokens (57%)  ← largest
  ## Examples        200 tokens (13%)
```

**Implementation:**

- Vendor minimal BPE tokenizer (cl100k_base, ~100KB pure JS, no API calls)
- New rule: `token-budget` with configurable limit
- Section-level breakdown keyed off `##` headers
- `--token-report` CLI flag for report-only mode

---

## 8. Skill Coloring: Side-Effect Classification

**Analog:** Function coloring (async/sync, `&`/`&mut`, IO monad). "What color is your function?"

**User problem:** Teams write skills and hooks but can't mechanically distinguish "safe to auto-run" from "touches production." A hook called "validate" could secretly `curl` an external API. Without coloring, every skill is equally opaque.

**What vigiles provides:** Validates that skills declare their side-effect level, and that the declaration matches the skill body.

```markdown
<!-- In SKILL.md -->

**Side effects:** none
```

vigiles scans for tool references and command patterns:

- `Read`, `Grep`, `Glob` → `none`
- `Write`, `Edit` → `local-fs`
- `curl`, `git push`, `deploy` → `network`

Mismatch = lint error: `Skill "audit" declares "none" but references Write tool`

---

## 9. Hook Validation (Contract Testing)

**Analog:** Contract testing / executable specification / CI pipeline linting.

**User problem:** PostToolUse hooks in `.claude/settings.json` are opaque shell strings. They reference nonexistent scripts, use invalid matchers, or silently fail. Nobody discovers the breakage until an agent session goes wrong.

**What vigiles provides:** Validates hook commands, matchers, and file references.

```
.claude/settings.json:
  Hook[0] ✗ Command references `validate.mjs` which does not exist
  Hook[1] ✗ Matcher "Edit|Writ" — did you mean "Edit|Write"? (no known tool matches "Writ")
  Hook[2] ✓ `npx prettier --check .` — command valid
```

**Checks:**

- Command target exists (file or binary on PATH)
- Matcher regex is valid and matches known tool names
- File references in commands resolve
- Hook ordering (formatter before linter = wasted work)

---

## 10. Instruction Diff Reviews (Migration Safety)

**Analog:** Database migration safety checks / API breaking change detection / semver.

**User problem:** Someone removes `**Enforced by:**` in a PR. No CI catches the regression. The rule silently becomes unenforced — the instruction equivalent of `DROP CONSTRAINT` with no migration review.

**What vigiles provides:** A `diff` command that structurally compares instruction files between versions and classifies changes.

```
vigiles diff base..head:

  ✓ added      "Validate API responses" (enforced by zod/schema)
  ⚠ weakened   "No console.log" — was enforced, now guidance-only
  ⚠ removed    "Use barrel imports"
  ✗ added      "New rule" — missing enforcement annotation
```

**Classifications:** `added` ✓, `strengthened` ✓, `weakened` ⚠, `removed` ⚠, `added-unenforced` ✗

**Implementation:**

- `vigiles diff <base-file> <head-file>` CLI
- GitHub Action mode: auto-fetch base, post PR comment
- Suppress with `<!-- vigiles: intentional-weakening -->`

---

## 11. Instruction File Dependency Graph

**Analog:** Module dependency graph / build system DAG / broken link checker.

**User problem:** Root CLAUDE.md says "See `src/api/CLAUDE.md` for API conventions." That file was deleted last sprint. Or: two files reference each other cyclically, creating ambiguity about which takes precedence.

**What vigiles provides:** Maps cross-references between instruction files, validates targets exist, detects cycles.

```
vigiles graph:
  CLAUDE.md → src/api/CLAUDE.md ✓
  CLAUDE.md → src/ui/CLAUDE.md  ✗ (file not found)
  src/api/CLAUDE.md → CLAUDE.md  (cycle detected ⚠)
```

---

## 12. Annotation Typo Detection

**Analog:** TypeScript strict mode / config key spell-check.

**User problem:** `**Enforced By:**` (wrong case), `**Enforce by:**` (wrong word), `**Guidance:**` (missing "only") — these silently fail to be recognized. The rule looks annotated to humans, but vigiles doesn't match it, producing confusing false positives.

**What vigiles provides:** Catches near-miss annotations via Levenshtein distance and suggests fixes.

```
CLAUDE.md:15  Near-miss: "**Enforced By:**" → did you mean "**Enforced by:**"?
CLAUDE.md:28  Near-miss: "**Guidance:**" → did you mean "**Guidance only**"?
```

Also optionally enforces `**Why:**` explanations: `{ "requireWhy": true }`

---

## Summary

| #   | Feature                | Programming Analog                   | User Problem Solved                                       |
| --- | ---------------------- | ------------------------------------ | --------------------------------------------------------- |
| 1   | **Plugin API**         | Railway composition / ESLint plugins | Can't add custom checks without forking                   |
| 2   | **Reverse Coverage**   | Code coverage (inverted)             | Agent follows 200 rules it doesn't understand             |
| 3   | **Dead Enforcement**   | Dead code / skipped tests            | "Enforced by X" but X is disabled in config               |
| 4   | **Snapshot Testing**   | Jest snapshots                       | Structural instruction changes slip through PRs           |
| 5   | **Stale References**   | Broken link checker                  | Rules reference deleted files/packages                    |
| 6   | **`init` Scaffolding** | `eslint --init` / generators         | Blank page problem — no one writes CLAUDE.md from scratch |
| 7   | **Token Budgets**      | Bundle size budgets                  | No visibility into context window cost                    |
| 8   | **Skill Coloring**     | Function coloring (pure/impure)      | Can't tell if a skill is safe to auto-run                 |
| 9   | **Hook Validation**    | Contract testing                     | Hooks break silently at runtime                           |
| 10  | **Instruction Diffs**  | Migration safety                     | Enforcement removed in PRs, nobody notices                |
| 11  | **Dependency Graph**   | Build DAG / import graph             | Cross-references to deleted instruction files             |
| 12  | **Typo Detection**     | Type checking / strict mode          | Near-miss annotations silently ignored                    |

---

## Research: Code Clone Detection & Deterministic Similarity Techniques

Collected April 2026 during investigation of [this Mastodon thread](https://neuromatch.social/@jonny/116328694967192899) about LLM code inconsistency — the same task implemented 3 different ways (set membership, regex, string methods).

### Clone Type Taxonomy

| Type       | What it catches                              | Deterministic?                       | Example                           |
| ---------- | -------------------------------------------- | ------------------------------------ | --------------------------------- |
| **Type-1** | Exact clones (modulo whitespace/comments)    | Yes                                  | Copy-paste with reformatting      |
| **Type-2** | Renamed identifiers/literals                 | Yes                                  | Same logic, different var names   |
| **Type-3** | Near-miss (added/deleted statements)         | Yes (with fixed threshold)           | Structural modifications          |
| **Type-4** | Semantically equivalent, textually different | **No** (undecidable, Rice's theorem) | `set.has(x)` vs `/regex/.test(x)` |

Type-4 is the core complaint from the post. It's provably undecidable in the general case.

### Practical Tools

#### Token-Based (Type-1/2) — Fast, CI-ready

- **[PMD CPD](https://pmd.github.io/pmd/pmd_userdocs_cpd.html)** — Token stream matching, 31 languages. GitLab CI integration, Maven plugin. More comprehensive than jscpd for 3+ duplications.
- **[jscpd](https://github.com/kucherenko/jscpd)** — Rabin-Karp hash fingerprinting, 150+ languages. ~1.4s for 100 files. npm package, Codacy/GitHub Actions integration.
- **[SourcererCC](https://arxiv.org/abs/1512.06448)** — Token-based inverted index. Scales to 250 MLOC on 12GB RAM, 86% precision. Research tool, not CI-native. Twice as fast as CCFinderX at largest input sizes.

#### AST Tree Edit Distance (Type-3) — Promising

- **[similarity-ts](https://github.com/mizchi/similarity)** — Rust-based, uses Bloom filter + APTED tree edit distance. Built specifically for detecting LLM-generated structural duplicates. <1s for 60K LOC. ~50x speedup from Bloom filter (5x) + multithreading (4x) combined. TypeScript/JS only.
- **[APTED](https://github.com/DatabaseGroup/apted)** — State-of-the-art optimal tree edit distance. O(n²) worst case. Requires pre-filtering for practical use (n functions = n(n-1)/2 comparisons).
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** — GLR parser used by similarity-ts and academic tools for AST generation across languages.

#### PDG / Graph-Based (Type-3/4) — Academic

- **CCGraph** (ASE 2020) — PDG + approximate graph matching. Catches non-contiguous clones but graph isomorphism is NP-complete.
- **Scorpio** — PDG subgraph isomorphism. Academic prototype.
- **[HideNoSeek](https://github.com/aurore54f/hidenoseek)** — Static data flow analysis for JS syntactic clones.

#### Locality-Sensitive Hashing

Hash code features into buckets where similar items collide. Probabilistic but tunable false-positive rate. Used as pre-filter in tools like SourcererCC.

### Key Insight

For CI today: jscpd/PMD CPD for copy-paste (seconds), similarity-ts for structural near-misses (sub-second, JS/TS only), custom lint rules for known patterns. Type-4 detection (semantically identical, textually different) remains unsolved in production.

### Markdown Structure Validation Tools

- **[mdschema](https://github.com/jackchuka/mdschema)** — Declarative YAML schema for markdown structure. Go binary with npm wrapper. Supports required/optional sections, regex heading patterns, nested children, count constraints, frontmatter validation, word counts, code block requirements, link validation. **Integrated into vigiles as `require-structure` rule.**
- **[markdown-validator](https://github.com/mattbriggs/markdown-validator)** — Declarative rules for Hugo/DocFX-style markdown.
- **[markdownlint](https://github.com/DavidAnson/markdownlint)** — Formatting rules (no skipped levels, consistent lists) but not structural schemas.
- **[Vale](https://vale.sh)** — Prose linter with YAML rule collections. Focuses on writing style, not document structure.

### AI in CI Research

The "LLM reviews PRs in CI" approach hasn't worked due to non-determinism. What works:

- **Semgrep** — AI helps _write_ custom rules, but rules run deterministically.
- **SonarQube** — Added LLM explanations of findings, detection stays rule-based.
- **[Factory.ai](https://factory.ai/news/using-linters-to-direct-agents)** — Linters direct agents, not the reverse.
- **Hybrid SAST + LLM post-processing** — 91% false positive reduction vs standalone Semgrep.

Pattern: **LLM proposes, deterministic tool disposes.** The CI gate stays deterministic.

---

## TODO: Type System Enhancements

### Exhaustive Rule Coverage Type

A utility type that diffs all enabled linter rules against the rules referenced in the spec. `vigiles discover` does this at runtime — the type system could do it at authoring time:

```typescript
type UncoveredRules = Exclude<EslintRule, ReferencedEslintRules>;
type _assert = [UncoveredRules] extends [never] ? true : never; // compile error if gaps
```

This would make "100% rule coverage" a type-checked property of the spec itself. Requires `generate-types` to emit a `ReferencedRules` type alongside the linter rule unions.

### Variadic `check()` — Multiple Assertions per Rule

Currently `check()` takes a single assertion. A variadic overload could accept multiple:

```typescript
"test-coverage": check(
  every("src/**/*.service.ts").has("{name}.test.ts"),
  every("src/**/*.service.ts").has("{name}.schema.ts"),
  "Every service must have tests and a schema.",
),
```

Requires expanding `CheckRule.assertion` to `FilePairingAssertion | FilePairingAssertion[]` and updating the compiler to iterate.

See also: [research/competitive-landscape.md](./competitive-landscape.md) for the full competitive landscape, moat analysis, pain points, and transferable concepts from other linters.
