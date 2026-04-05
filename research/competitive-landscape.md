# Competitive Landscape: AI Agent Instruction File Tooling

Collected April 2026. 15+ tools exist in this space across four categories.

---

## Category 1: Linters / Validators (Direct Competitors)

| Tool                                                                     | Focus                                           | Key Differentiator                                                                                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[AgentLinter](https://github.com/seojoonkim/agentlinter)**             | Content quality scoring for CLAUDE.md/AGENTS.md | A-F grading, security checks, token efficiency, vagueness detection. 30+ rules. Exports to Cursor/Copilot/Gemini formats                                                     |
| **[cclint (carlrannaberg)](https://github.com/carlrannaberg/cclint)**    | Claude Code project structure                   | Validates entire `.claude/` directory: agent definitions, slash commands, settings.json hooks. Zod-based custom schemas                                                      |
| **[cclint (felixgeelhaar)](https://github.com/felixgeelhaar/cclint)**    | CLAUDE.md best-practice validation              | Independent tool with same name. TypeScript-based                                                                                                                            |
| **[claudelint](https://github.com/pdugan20/claudelint)**                 | Full Claude Code ecosystem                      | Broadest scope: CLAUDE.md + skills + settings + hooks + MCP servers + plugins. Circular reference detection. Auto-fix. Available as Claude Code plugin                       |
| **[cursor-doctor](https://github.com/nedcodes-ok/cursor-doctor)**        | Cursor `.mdc` rule files                        | 100+ checks, 34 auto-fixers. A-F grading. 48 conflict-pattern checks across files. Glob pattern validation. Team drift detection. "82% of 50 real projects had broken rules" |
| **[claude-rules-doctor](https://github.com/nulone/claude-rules-doctor)** | `.claude/rules/` glob validity                  | Narrow: detects dead rules where `paths:` globs match no files                                                                                                               |

## Category 2: Staleness / Drift Detection

| Tool                                                      | Focus                         | Key Differentiator                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[agents-lint](https://github.com/giacomo/agents-lint)** | Stale references in AGENTS.md | Most novel competitor. Verifies file paths exist, `npm run` scripts exist in package.json (with monorepo support), packages in manifests, flags deprecated packages (moment, request, tslint). Zero deps |

## Category 3: Rule Sync / Portability

| Tool                                                          | Focus                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **[Ruler](https://github.com/intellectronica/ruler)**         | Single source of truth → auto-distributes to agent configs                          |
| **[rulesync](https://github.com/dyoshikawa/rulesync)**        | Unified rule management CLI, 10+ AI tools                                           |
| **[rule-porter](https://github.com/nedcodes-ok/rule-porter)** | Bidirectional format conversion between Cursor/Windsurf/CLAUDE.md/AGENTS.md/Copilot |
| **[block/ai-rules](https://github.com/block/ai-rules)**       | Enterprise multi-agent rule management (by Block/Square)                            |
| **[vibe-cli](https://github.com/jinjos/vibe-cli)**            | Unifies rules across Claude/Cursor/Copilot/Gemini                                   |

## Category 4: Runtime Policy Engines (Adjacent)

| Tool                                                                                            | Focus                                                                                           |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **[Agent RuleZ](https://github.com/SpillwaveSolutions/agent_rulez)**                            | YAML policy engine for Claude Code hooks. Rust binary, sub-10ms, blocks dangerous ops           |
| **[Vectimus](https://github.com/vectimus/vectimus)**                                            | Cedar-based policy engine. 78 policies, sub-5ms, signed audit receipts, maps to OWASP/SOC2/NIST |
| **[Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)** | Runtime governance infra. Sub-0.1ms per action. Framework-agnostic                              |

---

## vigiles Moat Analysis

**What we have that nobody else does:**

- `require-rule-file` — cross-references `**Enforced by:**` annotations against actual linter APIs (ESLint builtinRules, Stylelint rules, Ruff CLI, Clippy, Pylint, RuboCop). Checks both rule existence AND config-enabled status
- The annotation model itself — forcing every rule to declare enforcement mechanism or explicitly mark as guidance-only

**Gaps relative to competitors:**

| Gap                                                 | Who has it                                    |
| --------------------------------------------------- | --------------------------------------------- |
| Staleness detection (file paths, scripts, packages) | **agents-lint**                               |
| Auto-fix                                            | **cursor-doctor** (34 fixers), **claudelint** |
| Conflict detection across files                     | **cursor-doctor** (48 patterns)               |
| `.claude/rules/` glob validation                    | **claude-rules-doctor**                       |
| Hook/MCP/plugin validation                          | **claudelint**, **cclint**                    |
| Scoring/grading (A-F)                               | **AgentLinter**, **cursor-doctor**            |
| Security anti-pattern detection                     | **AgentLinter**                               |
| Token budget analysis                               | **cursor-doctor**                             |

**Strategic filter for new rules:** Only build rules that require knowing something mdschema can't know (filesystem state, linter configs, content semantics). Structural checks (heading hierarchy, required sections, max depth) belong in mdschema schemas, not vigiles rules.

---

## Real-World Pain Points

Problems people actually report with AI instruction files, with citations:

### 1. File Too Long / Rules Ignored (HIGH FREQUENCY)

CLAUDE.md over ~200-300 lines → compliance drops sharply. ETH Zurich study: LLM-generated instruction files caused -3% task success, +20% cost. Over 50% of rules were noise.

- Sources: [HumanLayer](https://www.humanlayer.dev/blog/stop-claude-from-ignoring-your-claude-md), [DEV.to](https://dev.to/minatoplanb/i-wrote-200-lines-of-rules-for-claude-code-it-ignored-them-all-4639), [DEV.to](https://dev.to/alexefimenko/i-analyzed-a-lot-of-ai-agent-rules-files-most-are-making-your-agent-worse-2fl)

### 2. Vague / Unenforceable Directives (HIGH FREQUENCY)

"Write clean code," "Follow best practices" — infinite interpretations, zero behavioral change.

- Sources: [HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md), [UX Planet](https://uxplanet.org/claude-md-best-practices-1ef4f861ce7c)

### 3. Stale / Broken File References (HIGH FREQUENCY)

Instruction files reference paths moved, renamed, or deleted. One audit found 59 broken references.

- Sources: [Packmind](https://packmind.com/evaluate-context-ai-coding-agent/), [agents-lint](https://giacomo.github.io/agents-lint/)

### 4. Contradictory Rules Across Files (MEDIUM FREQUENCY)

Root CLAUDE.md says "Use Prettier," subdirectory says "Use Biome." Agent picks one at random.

- Sources: [Cursor Forum](https://forum.cursor.com/t/issues-with-cursorrules-not-being-consistently-followed/59264)

### 5. Rules That Belong in Tooling (MEDIUM FREQUENCY)

"Don't use var" should be an ESLint rule, not a CLAUDE.md instruction. ~80% compliance via instruction vs 100% via linter.

- Sources: [Spotify Engineering](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3), [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### 6. "Lost in the Middle" Effect (RESEARCH-BACKED)

LLMs exhibit primacy/recency bias — rules buried in the middle of long files get deprioritized.

- Sources: [Context Windows - Goose Blog](https://block.github.io/goose/blog/2025/08/18/understanding-context-windows/), [Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)

### 7. Missing Essential Sections (MEDIUM FREQUENCY)

GitHub analysis of 2,500+ AGENTS.md files: common omissions = executable commands, testing instructions, project structure, code style, git workflow.

- Sources: [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/), [AGENTS.md](https://agents.md/)

---

## Transferable Concepts from Other Linters

| Source Tool                     | Concept                                                | vigiles Application                                                                                   |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **hadolint** (Dockerfile)       | Version pinning — flag vague refs that rot             | `no-vague-enforcement`: flag `**Enforced by:** linter` without specific rule name                     |
| **actionlint** (GitHub Actions) | Reference validation — actions/jobs must exist         | Already have `require-rule-file`. Extend to script/package refs                                       |
| **commitlint**                  | Structural template enforcement                        | `require-why` (rationale), `rule-title-format` (consistent imperative titles)                         |
| **ShellCheck**                  | Portability warnings — bash-isms in sh scripts         | `no-tool-specific-rules`: flag rules using tools only one agent has when project uses multiple agents |
| **Clippy** (Rust)               | Severity tiers (correctness/suspicious/style/pedantic) | Could tier vigiles rules by impact, but current pass/fail model is simpler                            |
| **Pylint** (`R0801`)            | Duplicate code detection                               | `no-duplicate-rules` across instruction files                                                         |
| **ESLint** (`no-shadow`)        | Scope shadowing — inner var hides outer                | `no-shadow-rules`: subdirectory CLAUDE.md redefines root rule with different enforcement              |
| **Danger.js**                   | PR meta-checks — is it too big? changelog updated?     | `instruction-file-hygiene`: was CLAUDE.md updated when architecture changed?                          |

---

## Decisions Log

### markdownlint integration — NO (April 2026)

Decided not to integrate markdownlint. Reasons:

- **Not our job.** vigiles validates content semantics (are enforcement claims real?). markdownlint validates formatting (trailing spaces, list markers). Different concerns.
- **Already solved.** CodeRabbit runs it on PRs by default. Teams that want CI blocking already run `npx markdownlint CLAUDE.md`.
- **Noise.** Formatting issues in instruction files have zero impact on whether the agent follows the rules. Dilutes signal from our actual rules.
- **Dependency weight.** Against the zero-config principle. Would own the config surface ("why is vigiles flagging MD013?").

Listed as complementary tool in README instead.

### Agent detection refactor — SIMPLIFIED (April 2026)

Removed indicator-based agent detection (scanning `.claude/`, `.cursor/`, etc. and nagging about missing files). Replaced with simple `"files": ["CLAUDE.md"]` config.

Reasons:

- Having a `.cursor/` directory doesn't mean you owe the world a `.cursorrules` file
- File distribution across agents is the sync tools' job (Ruler, rulesync, block/ai-rules), not ours
- The "missing file" check was a half-baked sync tool inside a content validator
- Simpler: validate what exists, don't nag about what doesn't
