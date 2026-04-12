# Agent Integration: Proofs, Hooks, and Static Analysis for AI Coding

## Framing

vigiles today helps humans write instruction files that AI agents read. That is useful but thin. The larger opportunity is to make vigiles a **deterministic backstop** around coding agents: a layer that catches the specific failure modes AI models have, before they become committed code.

This doc collects research on where AI agents actually fail, what deterministic tooling can provably prevent, and proposes 10 concrete vigiles improvements. The through-line is: use the spec as the anchor for hooks, proofs, and static checks — so that unreliable probabilistic tools meet a reliable deterministic floor.

## The problem: spiky intelligence

Andrej Karpathy's "jagged intelligence" framing describes it best: LLMs can solve olympiad-level problems in one prompt and fail at `9.11 > 9.9` in the next. Capability is not monotonic across tasks — it is spiky. For coding agents this means:

- The same model that writes a correct Raft implementation will happily `import leftpad` when the package does not exist
- An agent that refactors 500 lines cleanly will silently delete an unrelated test file one invocation later
- Context windows fix some of this, but hallucinated imports, stale file paths, and out-of-date API signatures survive even with full-file context

Deterministic tools do not have this problem. A TypeScript compiler does not "sometimes" miss a type error. A linter does not "occasionally" forget a rule. The thesis of this doc: **put deterministic tools on every edge where the agent touches reality**, and use vigiles specs as the schema that drives them.

## What goes wrong in practice

### 1. Documentation drift

ETH Zurich's AGENTS.md study (arxiv 2511.12884) found that well-intentioned AGENTS.md files produced a **3% reduction in task success** and a **20% increase in token cost** when the docs were stale or overlong. Specifically: files over ~300 lines hurt more than they helped. The model pays attention to prose that is wrong.

DAPLab's 9-failure-pattern study of coding agents called this out as pattern #1: "instructions the model treats as ground truth but which no longer reflect the code." A single file in a popular TS monorepo had **59 broken file-path references** in its CLAUDE.md — agents cheerfully followed them and wrote new code against paths that no longer existed.

### 2. Package hallucination / slopsquatting

Lasso Security's 2024 study: **58% of hallucinated package names are reproducible** across runs of the same prompt. The same non-existent name appears over and over. Attackers have started registering those names on npm and PyPI — the so-called "slopsquatting" attack. If you ask an agent to add a CSV parser and it suggests `fast-csv-parser-lite`, that package might not exist today and might be malware tomorrow.

Neither TypeScript nor ESLint catches this. The import looks fine syntactically; it fails at install time or, worse, succeeds and runs attacker code.

### 3. Missing linter backing

CodeRabbit's 2025 aggregate data: AI-generated code has **1.7× more reviewable issues** than human-written code. Of those issues, roughly 40% are things an appropriately configured linter would catch — the linter just wasn't configured. vigiles already addresses this for rules that appear in a spec (via `enforce()` cross-referencing), but the inverse problem is unsolved: rules enabled in the linter that the spec never mentions, and rules in the spec that are disabled in the linter but still appear in CLAUDE.md. Both cases are silent drift.

### 4. Secrets and dangerous commands

GitGuardian's 2025 report: **3.2% of AI-assisted commits leak a secret**, up from 1.1% in pre-agent commits. Models are not malicious — they paste what they see. A `.env` file in the conversation becomes a `.env` file in the commit. Claude Code's PreToolUse hook is the only unbypassable enforcement point for this; vigiles currently does not ship one.

### 5. Hook anti-patterns

Claude Code hook documentation explicitly warns about two anti-patterns people hit repeatedly:

- **Silent matcher ignore**: a PreToolUse matcher like `Edit|Write` written as `"Edit|Write"` with no regex semantics silently matches neither
- **Trailing-wildcard regex**: `Bash.*` without anchoring matches anything containing "Bash"

These failures do not error. They just quietly stop enforcing anything. Users believe they are protected when they are not.

### 6. Missing product context

The DAPLab study's pattern #7: agents produce syntactically correct code that violates product conventions the codebase has never articulated anywhere. "Use our internal `http.Client` instead of `fetch`." "Log via `logger.ts`, never `console.log`." "All controllers live in `src/controllers/`, not `src/routes/`." These are real rules, but they live in the heads of senior engineers. The moment a rule is not written down, the agent cannot follow it.

vigiles's spec format is the right place for these — if they can be written quickly and enforced automatically.

## Academic + industry landscape (2025–2026)

- **arxiv 2511.12884** (ETH Zurich) — Empirical analysis of AGENTS.md; shorter-and-enforced beats longer-and-prose-only
- **DAPLab 2025** — 9-failure-pattern taxonomy for agentic coding
- **Lasso Security 2024** — Package hallucination reproducibility (58%)
- **GitGuardian 2025** — Secret leak rates in AI-assisted commits (3.2%)
- **CodeRabbit 2025** — AI code has 1.7× issue density vs human code
- **Anthropic Claude Code docs** — PreToolUse / PostToolUse / SessionStart hook surface
- **Karpathy 2024** — "Jagged intelligence" framing for LLM capability distribution

Takeaway: the entire field has converged on the same conclusion. LLMs need deterministic rails. The question is where to put them and who writes the schema.

## Ten vigiles improvements

Each of these maps to one or more failure modes above. All are scoped to vigiles's positioning (compilation + linter cross-reference + filesystem assertions). None of them require us to become a linter.

### 1. Ship a hook pack — SHIPPED

A `vigiles init` flag that installs a curated `settings.json` block with:

- **PreToolUse (Edit|Write)** — block direct edits to any compiled markdown file (CLAUDE.md, AGENTS.md, the target of any discovered `.spec.ts`). Force edits through the spec.
- **PostToolUse (Edit|Write on \*.spec.ts)** — auto-run `vigiles compile` so the markdown is always in sync without the user thinking about it.
- **SessionStart (matcher: `compact`)** — run `vigiles audit --summary` and inject the result so the model sees stale-reference warnings every session for free.

Why this matters: PreToolUse is the only unbypassable enforcement point in the Claude Code harness. Without it, any rule is advisory. With it, vigiles becomes a real floor.

### 2. Package-existence check inside `audit` — DROPPED

Reuse the linter-cross-reference machinery to scan imports in the repo against `package.json`/`requirements.txt`/`Cargo.toml`. Flag any import that (a) is not in the manifest and (b) is not a relative path or builtin. This catches slopsquatting at audit time before it reaches install. Cheap, fully local, zero false positives on builtins.

### 3. Dead-enforcement detection — SHIPPED (already wired for all 6 linters)

Today `enforce("eslint/no-console")` verifies that `no-console` exists as a rule. It does not verify that it is **enabled** (severity > 0). Extend the linter engine to surface rules the spec claims are enforced but which the linter reports as `"off"`. This is a silent-drift bug that happens every time someone tweaks eslint config without touching the spec.

### 4. Reverse coverage report — SHIPPED (built into `vigiles audit` coverage stage)

Right now `audit` tells you which files have no spec coverage. The inverse is just as useful: which **linter rules** are enabled in the project but not mentioned in any spec. Output as a sorted list so users can either add `enforce()` entries (promoting the rule to agent-visible prose) or mark it intentionally out-of-scope. Closes the gap that CodeRabbit's 1.7× issue-density number is mostly made of.

### 5. SessionStart audit injection (compact matcher) — SHIPPED

Hook-pack component worth calling out separately: the `compact` SessionStart matcher fires every time context is compacted, which is effectively free in the session's token budget. Injecting a one-line "3 stale file refs, 2 disabled enforced rules, 1 duplicate rule" message at that moment means the model re-notices drift without anyone running a command. This is the single highest-leverage hook integration.

### 6. Hook validation subcommand — NOT BUILT

`vigiles audit --hooks` parses the user's `settings.json`, runs the listed matchers against known-bad inputs, and reports silent failures (matchers that match nothing, trailing-wildcard regex, missing shell escapes). Directly addresses the silent-matcher-ignore anti-pattern documented in Claude Code's own hook docs. No one else ships this check.

### 7. Token-budget compile-time enforcement — SHIPPED

ETH Zurich's finding was that CLAUDE.md files over ~300 lines actively hurt. Add a `maxTokens` / `maxLines` field to the spec (already partially present), but enforce it at **compile** time with a hard error rather than as advisory output. Force the user to choose what to cut. This is the simplest way to align vigiles with the empirical evidence that shorter + enforced beats longer + prose.

### 8. Instruction diff subcommand — NOT BUILT

`vigiles audit --diff <base>` renders a semantic diff of the compiled markdown: rules added, rules **strengthened** (guidance → enforce), rules **weakened**, rules removed. Attach to every PR that touches a `.spec.ts`. Reviewers currently look at a raw markdown diff which hides the monotonicity property — a strengthen looks identical to a reword unless you read carefully. Semantic diff makes it obvious.

### 9. Snapshot tests for structural changes — PARTIALLY SHIPPED (monotonicity lattice rejects weakening; full `--allow-weaken` flag not yet exposed as CLI)

Compile-time assertion: if a spec change would delete an `enforce()` rule, require an explicit `--allow-weaken` flag. This encodes the monotonicity lattice (`guidance < enforce`) from the proofs work as a hard rule rather than advisory output. Pairs with #8: the diff highlights it, the snapshot prevents accidental loss.

### 10. Stale reference detection — DROPPED (compiler's job, not vigiles's)

Generalize the existing path-verification (`file("src/foo.ts")`) to a crawler that, during `audit`, walks every code-fenced path, every backticked identifier that looks like a file, every npm-script reference, every package name, and flags the ones that no longer resolve. The 59-broken-refs example was in a file no one had audited for 8 months. A cheap cron-friendly audit command closes that gap forever.

### 11. Adversarial AI review loop — NOT BUILT

Ship a skill that takes a spec diff and runs a second LLM pass (same model, reviewer prompt) to critique it before the evolution engine accepts. The Codex-reviews-Claude cycle on PR #16 caught ~40 real bugs across 30+ review rounds — reference leaks, merge semantics, monotonicity bypasses, stale command references. That pattern works. Bake it in: `vigiles evolve --review` proposes a mutation, runs the proof suite, THEN asks a reviewer-prompt subagent "what did I miss?", feeds the response back as a second round of mutations, and only commits the final version. Two-LLM adversarial loop with deterministic gates between rounds.

### 12. Inline-to-spec graduation detector — NOT BUILT

When a markdown file accumulates >N inline `<!-- vigiles:enforce ... -->` comments (default: 5), `audit --summary` includes a "graduate to spec mode" nudge. Bonus: print a ready-to-paste `.spec.ts` template pre-filled with all the inline rules already extracted. The adoption funnel becomes: add one comment → add five → see the nudge → paste the template → you're in spec mode. Zero cliff.

### 13. Cross-file rule coherence — NOT BUILT

When a project has multiple specs (e.g., `CLAUDE.md.spec.ts` + `docs/AGENTS.md.spec.ts`), run NCD across specs (not just within) to detect cross-file near-duplicates. Also flag contradictions: spec A enforces `eslint/no-console` while spec B's prose says "use `console.log` for debugging." Today each spec is audited in isolation; coherence requires a cross-spec pass.

## What we are NOT adding

- Not a linter. Architectural and per-file rules live in ESLint / Ruff / Steiger / ast-grep. vigiles references them.
- Not an agent sandbox. Claude Code and Codex already own the execution surface.
- Not a secret scanner. GitGuardian / trufflehog already do this well. We can recommend them via `enforce()` but we do not reimplement.
- Not an embedding / semantic-search layer. That belongs in the agent, not the spec compiler.

## Next moves

1. Hook pack (#1) + SessionStart audit injection (#5) — highest impact, lowest effort, unblocks everything else
2. Dead-enforcement detection (#3) + reverse coverage report (#4) — extend existing linter engine, no new subsystem
3. Package-existence check (#2) + stale reference detection (#10) — audit-time crawlers, reuse existing infrastructure
4. Semantic diff (#8) + snapshot tests (#9) + token budget (#7) — compile-time guardrails
5. Hook validation (#6) — stretch goal, depends on hook pack being stable first

The first two bullets could ship in one patch and would already move vigiles from "markdown compiler" to "deterministic backstop for coding agents." Everything after that is additive.
