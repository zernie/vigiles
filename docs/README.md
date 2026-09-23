# Documentation — index

How-to and reference docs for using vigiles. **New here? Start with the
[README](../README.md)** for the pitch and a 5-minute quick start, or try the
**[live demo at vigiles.sh](https://vigiles.sh)** — grade any repo in your browser.

The docs are grouped by what you're trying to do:

- **[Guides](#guides--help-me-do-x)** — step-by-step, task-first ("help me do X").
- **[Reference](#reference--the-exact-flag-symbol-or-rule)** — exact flags, symbols, rules.
- **[Explanation](#explanation--why-its-built-this-way)** — the reasoning and trade-offs.

---

## Guides — "help me do X"

### Verify your instruction files (the Lint layer)

- [`verifying-instruction-files.md`](verifying-instruction-files.md) — the master guide: the markdown → typed-spec ladder, the three rule types (`enforce` / `guidance` / `guard`), verified references, and the before/after tables. Holds the [full validation-rules matrix](verifying-instruction-files.md#the-validation-rules--the-full-matrix).
- [`markdown-mode.md`](markdown-mode.md) — the no-spec on-ramp: verify rules in plain markdown with inline `<!-- vigiles:enforce -->` comments, no TypeScript.
- [`skills-monorepo.md`](skills-monorepo.md) — adopt vigiles in a CI-tested skill library or a plain `.claude/` repo (no `plugin.json`).

### Test & measure your harness (the Test + Eval layers)

- [`harness-testing.md`](harness-testing.md) — task-first how-to: pick what you want to test (hook / safety-hook battery / wiring / skill firing / behaviour) and the tier that answers it, with a copy-paste first test and CI.
  - [`harness-testing-claude-code.md`](harness-testing-claude-code.md) — Claude Code specifics: `scriptModel`, `${CLAUDE_PLUGIN_ROOT}` / `pluginDir` / the `Skill` tool, the bubblewrap sandbox.
  - [`harness-testing-codex.md`](harness-testing-codex.md) — Codex specifics: `runHarnessTest({ adapter: codexAdapter })` against real `codex exec`, the Responses mock, what maps and what doesn't.
- [`measuring-skills.md`](measuring-skills.md) — A/B a skill, plugin, model, or rule change on real coding tasks: the metric triple (bill / target / blast-radius), the worked example, and why it's affordable on your subscription.
- [`migrating-from-promptfoo.md`](migrating-from-promptfoo.md) — move existing skill evals onto the subscription: the concept + assertion mapping, a worked side-by-side, and the honest gaps.

### Author & ship

- [`skills.md`](skills.md) — authoring a SKILL.md across the three on-ramps; the prose-vs-gates split.
- [`compiled-hooks.md`](compiled-hooks.md) — author a hook as a pure typed function against the closed `vigiles/hook` vocabulary and compile it, making whole classes of hook bugs unrepresentable (false confidence, matcher bypass, capability creep).
- [`railway-subagents.md`](railway-subagents.md) — the typed `Result` subagent contract: declare a typed outcome, compose flat workers, and assert the outcome deterministically (no model judge).
- [`for-plugin-authors.md`](for-plugin-authors.md) — the plugin-author journey end to end: scan a draft, fix what it flags, make your skills fire, rank against a marketplace, gate it in CI.
- [`github-action.md`](github-action.md) — run vigiles in CI: the composite Action, every input, the sticky PR comment, versioning.

### Harnesses, adapters & agents

- [`harnesses.md`](harnesses.md) — which harness vigiles targets and how you pick one (by import), plus the capability matrix.
- [`authoring-an-adapter.md`](authoring-an-adapter.md) — teach vigiles a new harness: the five ports, a worked skeleton, validating with the conformance kit.
- [`non-js-harnesses.md`](non-js-harnesses.md) — running vigiles on a harness whose project is Kotlin, Go or anything else non-JS: what needs Node and what does not.
- [`agent-setup.md`](agent-setup.md) — agent setup & workflows in one guide: what `init` does, per-agent recipes (Claude Code / Codex / multi-agent / Cursor), non-interactive setup + fallback hooks, and CI.

## Reference — "the exact flag, symbol, or rule"

- [`cli.md`](cli.md) — the full CLI: every verb and flag, the Claude Code plugin, `lint` vs `audit`.
- [`configuration.md`](configuration.md) — every `.vigilesrc.json` key: what it does, its default, an example.
- [`commands-and-how-they-relate.md`](commands-and-how-they-relate.md) — the mental model: how `audit` / `lint` / `test` / `eval` / `init` fit together, and why measuring "do my skills fire?" uses `init`, not `audit`.
- [`testing-matrix.md`](testing-matrix.md) — every use case of the harness-testing API mapped to the tier that tests it, and what each tier costs.
- [`testing-api.md`](testing-api.md) — the full harness-testing API: every predicate, assertion, `check`, matcher, and option (`measureTriggerRate` / `runEval` / significance).
- [`spec-format.md`](spec-format.md) — the typed `.spec.ts` format (target, sections, rules, verified references) — the source of truth.
- [`linter-support.md`](linter-support.md) — the 11 linters + `generate-types` / `generate-schema`.
- [`adapter-api.md`](adapter-api.md) — the adapter API reference: every port field, the conformance functions, the registry API.
- **Validation rules:** the [full matrix](verifying-instruction-files.md#the-validation-rules--the-full-matrix) lives in the linting guide; each rule has a doc under [`rules/`](rules/).
- **Library entry points** (grouped by concern so a future harness can sit beside the current one):
  - `vigiles/linting` — what a spec author imports: the builders, verified-reference constructors and their types. Compiling and verifying is the CLI's job (`vigiles compile`, `vigiles lint`).
  - `vigiles/spec` — the spec builders (`claude`, `enforce`, `guidance`, `file`, `cmd`, `symbol`, …) and the module-augmentation target for generated types.
  - `vigiles` (the package root) — the free testing surface: the harness/hook runners, the `check` vocabulary and the runner-agnostic assertions.
  - `vigiles/eval` — everything that can spend money, every symbol prefixed `paid_`: `paid_runEval`, `paid_measure`, `paid_measureArms`, `paid_measureTriggerRate`, `paid_judge`, `paid_judged`, `paid_claudeEvalDriver`.
  - `defineEval` is on the **free** root, not here, and that is the point: a `*.eval.mjs` file DESCRIBES its eval and `vigiles eval` runs it, so importing one cannot spend. See [eval files describe their eval](harness-testing.md#eval-files-describe-their-eval).
  - `vigiles/claude-code`, `vigiles/codex` — the per-harness adapters.
  - `vigiles/adapter` — the adapter-authoring kit.
- **[API reference (generated) →](https://zernie.github.io/vigiles/api/)** — every exported symbol across all entry points, generated from the source. The hand-written guides here are the human-facing layer; this is the exhaustive symbol-level reference.

## Explanation — "why it's built this way"

- [`what-vigiles-catches.md`](what-vigiles-catches.md) — the taxonomy of problems vigiles handles: the prevented / caught / measured model, biggest-problem-first.
- [`comparison.md`](comparison.md) — before/after tables, the determinism breakdown, the flow diagram, and what vigiles composes with rather than replaces.
- [`sandboxing.md`](sandboxing.md) — what the sandbox isolates vs records (honestly): IO / `rm -rf`, the three network modes, tiers and limits.
- [`emit-channel.md`](emit-channel.md) — `experimental_emitTool`: a skill returns a typed result by calling a tool instead of ending its turn, which is how an INLINE skill can carry an output contract at all. Includes the measurements, and when to prefer the stable `output:` instead.
- [`experimental.md`](experimental.md) — what an `experimental_` name promises (nothing), what is experimental today, and what has to be true before the prefix comes off.
- [`faq.md`](faq.md) — the front-door FAQ across all four layers.
