/**
 * CLAUDE.md specification for the vigiles project.
 *
 * This is the source of truth. CLAUDE.md is a compiled build artifact.
 * Run `npm run compile:spec` to regenerate CLAUDE.md from this spec.
 */
import { claude, enforce, file, guidance, guard } from "./src/core/spec.js";

export default claude({
  sections: {
    positioning: `vigiles verifies the rule references in agent instruction files — that each linter rule exists AND is enabled, that file paths and scripts are real. ⚠️ ADOPTION DIRECTION (committed 2026-07-15): audit-FIRST, not spec-first. The markdown the user hand-edits is the SOURCE OF TRUTH; enforcement of code-quality rules lands in the repo's NATIVE linter config (ruff/eslint), not the spec; the typed \`.spec.ts\` is an OPTIONAL authoring layer for harness-STRUCTURE rules only (subagent contracts, purity, railway, composition — what no linter can express). \`init\` is the GRADUATION to a spec, not the front door (\`audit\` is — see below); \`adopt\`/\`strengthen\` are skills, not verbs. The first pass writes nothing and asserts nothing false (ref-verification is advisory, never written into the file). \`eject\` always reverses. The rule: the spec AUTHORS, the native linter RUNS (same architecture as \`@vigiles/rule-enforcer\`) — Rule of Least Power applied to enforcement homes. [LEGACY, being retired: the earlier spec-first three-level ladder — inline/frontmatter/typed — and \`init\` adopting a CLAUDE.md into a spec-as-source-of-truth with the markdown as a build artifact. Treat as current-shipped, NOT the target.] See \`docs/markdown-mode.md\`.

Positioned in the harness engineering frame coined early 2026: Agent = Model + Harness. The harness has two enforcement modes — probabilistic compliance (prompts, instructions) and deterministic constraints (linters, types, hooks). vigiles is the deterministic-constraints layer for instruction files.

The sharper, structural form of "deterministic constraints" is the CATEGORY line: markdown is inert prose, but a typed \`.spec.ts\` is a PROGRAM, so the whole PL/formal-methods toolbox applies to the harness — and none of it can apply to a markdown file. vigiles is a COMPILER/VERIFIER for agent harnesses. What that buys, concretely: UNSAFE HARNESSES DON'T COMPILE — a config that leaks, exceeds its declared effect floor, hands off mismatched data, or mutates out of order is a TYPE error at edit time, not a runtime surprise a linter notices after the fact (SHIPPED: typed purity — \`purity:'pure'+'Bash'\` won't tsc — and typed composition); the keystone is TYPE-SAFE PIPELINING — \`pipe(producer, pipeStep(agent, needs({…})))\` cross-references at compile time that step N's ok SUPPLIES step N+1's needs, so a multi-agent pipeline DOESN'T COMPILE IF THE HANDOFFS DON'T LINE UP. The enforcement is GRADUATED/OPT-IN, never all-or-nothing — the Level 0/1/2 ladder, the plain \`agent()\` vs the opt-in typed \`vigiles/claude-code\` import, the \`purity:'dangerously-unrestricted'\` escape hatch — progressive like TypeScript's \`strict\`, not a wall.

THE ADOPTION FRONT DOOR is \`vigiles audit\` — "Lighthouse for your harness": one zero-config command → SIX DETERMINISTIC category RINGS (\`src/audit-score.ts\` \`CategoryKey\`): FOUR are GRADED and sum into the A–F headline — Truthfulness/Triggering/Structure/SAFETY — and two are ADVISORY, printed and never summed (Tested, Evaluated; \`advisory: true\`), because a repo with no tests must read as unmeasured rather than as failing + each finding's fix inline + a shareable HTML report. A plain \`audit\` is a DETERMINISTIC READ — safe to run anywhere (even a prod-wired repo), IDENTICAL on every OS, nothing executes. It is a LOCAL report (like Lighthouse), NOT a CI step — CI uses \`vigiles lint\`. The TWO executing checks — live MCP resolution (do referenced tools resolve on the real server?) + trigger-rate (do your skills FIRE?) — sit behind ONE CONSENT (the read-vs-run axis, \`src/scan-trigger-suggest.ts\` \`decideExecute\`): at a TTY \`audit\` ASKS ONCE (a bundled prompt that DISCLOSES confinement + cost) and REMEMBERS in \`.vigilesrc.json\` (\`audit.measure\`); headless (\`--json\`/CI/non-interactive/agent) it stays a read + a one-line nudge (never hangs, never silently executes). There is deliberately NO execution flag: \`audit\` is a LOCAL report (like Lighthouse), NOT a CI step — CI uses \`vigiles lint\` (the deterministic gate). It runs the executing checks only when a human can consent; AUTOMATION tests the harness via the \`vigiles\` testing API + skills, never the report verb. The founder-driven simplification (2026-06-27) collapsed the earlier \`--deep\`/\`--measure\`/\`--fast\` flag sprawl into this ONE read-vs-run consent, because a uniform interactive choice beats per-tier toggles. WHY these two are opt-in: live MCP STARTS your own servers (a real backend connection) and trigger-rate spends model quota — neither is unsafe, but both DO something beyond a read, so a plain \`audit\` never does them without a human's yes. On consent: LIVE MCP is own-repo only (never a stranger's server) because STARTING a server connects to a backend and deny-all-net would break the \`tools/list\` it performs; trigger-rate STUBS skill bodies so no skill PROCEDURE runs (\`hasModelAccess\`/\`isMeteredAccess\` only shape the disclosure wording, sub=\$0 vs metered=credits). THE SAFETY BATTERY (do your hooks actually block?) is DELIBERATELY NOT an audit ring (narrowed 2026-06-27, founder "no half-made shit pre-release"): running ARBITRARY hooks safely needs cross-platform confinement and that's parked (bubblewrap is Linux-only; env-scrub ephemeral floor + macOS sandbox-exec are the unbuilt exit criterion) — so rather than ship a Linux-confined/Mac-unconfined ring, the battery lives in the \`vigiles\` testing API (\`guardrail-check\`/\`assertBlocksDisasters\`) where you opt in EXPLICITLY (a test you wrote, no zero-config-safety promise to break). ⚠️ THE BATTERY IS NOT THE SAFETY RING, and conflating them cost this file an untrue sentence for months: the Safety ring SHIPS TODAY, fed by the STATIC lethal-trifecta capability check (\`lethalTrifectaIssues\` → \`report.trifectaFindings\`), which reads a tool-SET and executes nothing, so no confinement gates it. What confinement gates is adding a RUN-BACKED input to that ring — do your hooks actually block? — and that is what stays parked. Everything renders FROM the versioned \`AuditReport\` JSON (\`src/audit-report.ts\`, \`schemaVersion\`), never from the HTML: the local React/shadcn single-file report and \`audit --json\` for CI. The report UI is a real Vite + React + shadcn app (\`report/\`) built to ONE self-contained file the CLI fills with the JSON (React runs in the reader's browser; the CLI ships only the built template + stays runtime-dep-light), and its components are presentational so any other renderer works off the same JSON contract.

The cross-referencing engine is what the tool is built on: \`enforce("@typescript-eslint/no-floating-promises")\` verifies the rule exists AND is enabled in your linter config. Same for ESLint, Ruff, Clippy, Pylint, RuboCop, Stylelint, Cedar policies (for AWS Bedrock AgentCore and other Cedar-using runtimes), and the JVM/Go ecosystem — detekt, ktlint, Checkstyle, golangci-lint. The rule name is resolved against each linter's own catalog rather than matched as a string, and the enabled state is read from the project's config. (Two exclusivity claims stood in this section until 2026-09-08 — one here, one in the adoption-direction paragraph above. Both rested on a documentation-checked competitor matrix rather than a run, and \`no-product-strategy-here\` forbids competitive positioning in this public repo. Recorded rather than silently dropped, so neither is reintroduced.)

Authoring-time feedback comes two ways: \`generate-types\` emits a \`.d.ts\` so the TS compiler PROVES \`.spec.ts\` references at edit time, and \`generate-schema\` emits a JSON Schema so a YAML LSP autocompletes and squiggles \`vigiles:\` frontmatter rule names — same guarantee, no TypeScript required. Both scan all 11 catalog APIs, package.json, and project files.

Second layer — TESTING the harness (\`docs/harness-testing.md\` is the guide; do not restate it here). Three tiers, cheapest first: \`runHook\` pipes a synthesized event to a hook process (no model, no key, reaches every event); \`runHarnessTest\` drives the real agent binary against a scripted mock model; \`runEval\` drives a real model across arms x trials. THE DISCIPLINE, which constrains what you build rather than describing it: push every question that can be answered deterministically DOWN a tier, and let only the two irreducibly-real-model questions — does a description FIRE, does behaviour MOVE — touch a real model. The real-model tier runs on the user's own Claude subscription (vigiles drives their own \`claude\` CLI), which is why a team can afford harness evals at all; CI runs only the free deterministic tiers. Never claim the mock-model tier is itself distinctive — every code-defined SDK ships a fake model. What no SDK does is test the harness loaded AS IT SHIPS, enforce a subagent's tool contract deterministically, and put a real-model tier on the sub.

Third layer — COMPILED HOOKS, the GATE instrument (\`vigiles/hook\`, src/core/hook-program.ts; \`docs/compiled-hooks.md\` is the guide and \`docs/experimental.md\` holds the exit criteria — do not restate either here). A hook is authored as a PURE typed \`(event) => Decision\` over a CLOSED vocabulary and compiled to the harness protocol, so whole classes of hook bug become unrepresentable: the author never writes the exit code or JSON field, the matcher is AST-backed rather than a glob over the command string, an import outside \`vigiles/hook\` does not compile, the artifact is SHA-stamped and a hand-edit is refused fail-closed, and a category mistake is a tsc error. THREE THINGS TO KEEP SAYING, because each is a claim someone will overstate: the entry points are exported \`experimental_*\` and renaming one is not a breaking change; compile and verify fix AUTHORING and LOGIC, never the harness's DELIVERY; and a model can route around a tool entirely (#45427/#32376), so a gate is a STRONG DEFAULT and never an unbypassable wall. The old subagent-bypass limit (#34692) is FIXED as of CC 2.1.241 and pinned by src/subagent-delivery.test.ts — prose cannot notice that someone else's product moved, a test can.

Multi-harness by design (a hard requirement). vigiles targets Claude Code today but the core is harness-agnostic: every Claude-Code-specific fact lives behind one of five injectable ports — \`HarnessDialect\`/\`PluginLayout\`/\`HarnessRuntime\`/\`HookProtocol\`/\`ModelMock\` — bundled per harness as a \`HarnessAdapter\`. Adding a harness (Codex likely next, then OpenCode/Crush/Gemini) is writing one adapter object and registering it; the boundary rule (core ⊄ adapter) keeps the core untouched. Third-party adapters are a first-class, supported extension point: \`vigiles/adapter\` exports the five ports plus a conformance kit, documented in \`docs/authoring-an-adapter.md\`. Backwards compatibility is non-negotiable — Claude Code stays the default everywhere (the CLI auto-detects; the library selects by import), so adding adapters never breaks existing consumers. See \`docs/harnesses.md\`.

Cross-platform by requirement (macOS + Linux). Most devs are on a Mac, so confinement cannot be Linux-only: it is a native backend per OS behind a \`vigiles/os-isolation\` port — bubblewrap (+\`nft\` per-host egress) on Linux today, \`sandbox-exec\`/Seatbelt for macOS (built-in, the committed next backend), refuse otherwise. Two ORTHOGONAL protections, not one switch: HOST protection (can foreign code read my secrets / escape?) is provenance-keyed — your own code runs direct, foreign \`plugin\`/\`pluginDir\` code is confined-or-refused; STATE protection (does RUNNING a model-driven skill mutate my world?) is UNCONDITIONAL — a fresh ephemeral run environment (throwaway CWD+HOME, scrubbed env), because the model, not the author, chooses the actions. Ephemerality needs no kernel features, so it is the cross-platform floor that lands on macOS immediately; the per-host egress wall stays a Linux capability and degrades honestly to deny-all-net elsewhere. See \`docs/safety.md\`.

vigiles does NOT do architectural linting. Use ast-grep, Dependency Cruiser, Steiger, or eslint-plugin-boundaries for that. vigiles can reference their rules via \`enforce()\`.`,

    direction: `vigiles is ONE LOOP, not a bag of features: DECLARE what the harness should do (the typed spec) → CHECK reality against that declaration. Four instruments are FACETS of the same loop, never a menu — VERIFY (lint/cross-ref/compile, author-time, free), GATE (compiled hooks, loop-time, free), MEASURE (evals on your subscription), OBSERVE (a local record of what the instruments saw). A feature belongs here only if it is a facet of declare→check.

DECIDABILITY DECIDES WHICH INSTRUMENT FITS WHICH SURFACE. On deterministic surfaces (a hook decision, a subagent's tool contract, a file/rule reference, a declared effect) the "supposed to" is DECLARED by the spec, so "did reality match?" is a deterministic check — precise, free, no model. On behavioural surfaces (does a skill FIRE here?) that question is undecidable statically, so it needs an authored expectation measured on a real model (\`measureTriggerRate\`) — never claim a passive record catches a MISS. Prose like "write clean code" is neither and stays prose. The rule underneath: you can check a DECISION, you cannot check "does this fire" without running it.`,

    architecture: `Three rule types in specs:

- \`enforce()\` — delegated to external tool (linter, ast-grep, dependency-cruiser). vigiles verifies the rule exists and is enabled.
- \`guard()\` — a path→command guard (e.g. \`*.spec.ts\` → \`npx vigiles compile\`), compiles to \`**Guard:**\` and wires spec-driven automation into hook engines.
- \`guidance()\` — prose only, compiles to \`**Guidance only**\` in markdown.

Architectural linting (file pairing, import boundaries, AST patterns) belongs in external tools — reference them via \`enforce()\`.

Template literal types ensure linter names (\`eslint/\`, \`ruff/\`, etc.) are type-safe. Branded types (\`VerifiedPath\`, \`VerifiedCmd\`, \`VerifiedRef\`) distinguish verified references from raw strings.

Compilation: spec.ts → compiler reads spec, validates references (file paths via existsSync, npm scripts via package.json, linter rules via linter APIs), generates markdown with SHA-256 integrity hash.

Core modules: \`src/core/spec.ts\` (types + builders), \`src/core/compile.ts\` (compiler), \`src/core/linters.ts\` (11-catalog cross-referencing engine), \`src/core/effects.ts\` (static effect-surface / purity ladder), \`src/core/bash-effects.ts\` (deterministic Bash-effect classifier), \`src/core/generate-types.ts\` (type generator), \`src/core/proofs.ts\` (proof algorithms for self-evolving specs), \`src/core/evolve.ts\` (evolution engine).

Harness-adapter layout (hexagonal — see \`docs/harnesses.md\`). The tree is split so a second harness (Codex likely next) sits beside Claude Code without touching the core:

- \`src/core/\` — the harness-agnostic reference-verification DOMAIN (spec, compile, linters, proofs, …). Knows nothing about how an agent runs.
- \`src/adapters/claude-code/\` — the Claude Code ADAPTER: the swappable ports + bundle + harness glue (the \`HarnessDialect\`/\`PluginLayout\`/\`HarnessRuntime\`/\`HookProtocol\`/\`ModelMock\` port impls, the \`HarnessAdapter\` bundle, agent/skill runtime, run-scripts, and a thin plugin-loader wrapper that defaults the CC layout). A future \`src/adapters/<other-harness>/\` mirrors it.
- \`src/\` root — the application/composition layer AND the harness-testing LIBRARY: cli, scan, the harness-agnostic \`plugin-loader\` (layout-injected; the CC wrapper + every other adapter delegate to it, so no adapter imports a sibling), the deterministic runners (\`harness-test\`/\`run-hook\`/\`eval\` + \`mock-model\`/\`sandbox\`/\`egress\`/\`judge\`) that default to Claude Code via an injected \`{ adapter }\`, and the \`testing\`/\`unit\`/\`integration\`/\`e2e\` barrels that route through the runners and NEVER import an adapter directly.

The layers are enforced in \`eslint.config.mjs\` and dogfooded via \`enforce("boundaries/dependencies")\`: every file belongs to a layer (\`src/core\` domain, \`src/adapters/<h>/\` one adapter each, \`src/cli{,-main}.ts\` root, rest of \`src/\` app) and imports point inward only — no adapter→adapter, and only the root wires an adapter in. \`local/no-harness-names\` stops any file, tests included, from spelling a harness other than its own adapter's (name, directory, env vars). Old violations are grandfathered. The architecture invariant is a verified reference, not a convention. Consumers select a harness by import (\`vigiles/claude-code\` beside the agnostic \`vigiles\`/\`vigiles/eval\`), not a runtime config key; the CLI selects per repo — auto-detect, a \`--harness=\` override, or a \`harnesses\` key in \`.vigilesrc.json\` written by \`init\` (the project-level declaration, distinct from the library's import-time selection). That key is an OBJECT keyed by harness name — \`{"claude-code": {"roots": [".ai"]}, "codex": {}}\` — and it REPLACED the flat \`harness\` + \`surfaceRoots\` pair outright, no alias: the old harness ARRAY's order silently decided which single layout everything was read under, so a repo declaring both got its skills OR its instruction file depending on which name it listed first, and no order gave it both (#240). Scoping each extra surface ROOT inside the harness that reads it removes the order, and a root under a harness whose layout reads nothing there is a hard error rather than a line that changes nothing. A repo declaring several harnesses still drives a byte-identical \`CLAUDE.md\`⇄\`AGENTS.md\` mirror when no sync tool fans it out. The config's SHAPE, its defaults and its error messages are ONE Zod schema (\`src/core/config-schema.ts\`) and \`VigilesConfig\` is \`z.infer\` of it, so a key cannot exist in the type and be absent from the validator.`,

    layout: `What each ROOT directory is — the per-dir index; what one file does is in that file's own header. This repo is FIVE things at once — a TS library, a shipped Claude Code plugin, two auxiliary packages, a benchmark suite, and its own dogfood harness — so the root has a dir per concern, grouped here by concern.

THE LIBRARY (the one compiled thing):

- \`src/\` — all TypeScript source, compiled to \`dist/\`. The ONLY thing \`eslint src/\` lints, vitest sweeps (\`src/**/*.test.ts\`), and the 100% coverage gate covers. Hexagonal: \`src/core/\` (domain) · \`src/adapters/<harness>/\` (ports) · \`src/*.ts\` (composition root + library). Also \`src/schemas/\` = DEPRECATED mdschema presets, parked (see \`src/schemas/DEPRECATED.md\`). A module's test sits BESIDE it as \`<module>.test.ts\` — found by name, and what it proves is in its own header.
- \`dist/\` — compiled JS output (gitignored; the published artifact + the audit-report template).

THE SHIPPED PLUGIN (root-level by Claude Code plugin convention — these MUST sit at the repo root beside the manifest; they are markdown/shell consumed verbatim by the harness, never compiled):

- \`plugin.json\` (repo ROOT) — the AGENT PLUGINS 1.0.0 manifest (the vendor-neutral packaging standard, agent-plugins.org). Pins \`$schema\` to the 1.0.0 identifier; carries metadata only, since skills are discovered at the spec's fixed \`skills/<name>/SKILL.md\` path and the 1.0.0 schema has NO home for hooks/subagents. So the CC manifest below is NOT redundant — the two coexist by design (neutral = portability, CC = what only CC understands), and \`src/agent-plugins-manifest.test.ts\` fails CI if their name/version/description/license drift.
- \`.claude-plugin/\` — the CLAUDE CODE plugin manifest (\`plugin.json\`, the \`hooks\` block) + \`marketplace.json\`. The repo root IS the plugin root.
- \`skills/\` — the SHIPPED consumer skills (published; both manifests point here — the CC one explicitly, the neutral one by the standard's fixed path).
- \`hooks/\` — the SHIPPED plugin's hook scripts (pre-edit/post-edit/refs-nudge/eval-lock-nudge/session-start; published, referenced by \`plugin.json\`).

THIS REPO'S OWN HARNESS (how Claude Code behaves when a CONTRIBUTOR works in-repo — NOT shipped; \`.claude/\` is not published):

- \`.claude/\` — \`settings.json\` + \`hooks/\` + \`skills/\`. \`.claude/skills/\` holds the CONTRIBUTOR-only dev skills (add-a-linter, audience-check, audit-feedback-loop, code-quality, dogfood-cli, enforce-rules-format, generate-logo, landing-site, pr-to-lint-rule, screenshot, ship-a-feature, verify-docs-findable) + vendored deep-research + review-docs. (The old \`dev/\` second plugin was folded here 2026-07-14.)

AUXILIARY PACKAGES (separate npm packages with their OWN \`package.json\`, NOT part of \`src/\`):

- \`rule-enforcer/\` — \`@vigiles/rule-enforcer\`, the opt-in rule-SYNTHESIS engine + its two-stage blind-gold TRUST GATE (\`gate.js\`). Folded in from a former standalone repo; CI runs its gate (dogfood). The \`pr-to-lint-rule\` skill's engine.
- \`report/\` — \`@vigiles/report\`, the Vite + Tailwind audit-report app that CONSUMES \`@vigiles/report-view\` and builds it to one self-contained HTML template the CLI fills. Kept out of the CLI's runtime deps.
- \`packages/report-view/\` — \`@vigiles/report-view\`, the SHARED source-only report view (presentational components + AuditReport schema + band tokens + theme.css) rendered by \`report/\` (and later \`site/\` + the in-browser demo) from the same AuditReport JSON. Wired as npm WORKSPACES (\`packages/*\`, \`report\`, \`site\`) — deps hoist to root, the published package's CI stays green.

DOCS (see the doc-tiers rule):

- \`docs/\` — PUBLIC user docs (what a user needs to act).

TESTS + FIXTURES + BENCHMARKS:

- \`test/\` — test DATA + tier config, NOT the unit tests (those are \`src/**/*.test.ts\`). Holds \`test/dogfood/\` (SHA-pinned vendored real plugins — see the dogfood-vendoring-policy rule), \`test/fixtures/\` (the E2E example-project), \`test/{e2e,runners,types}/\`.
- \`examples/\` — user-facing copy-paste \`*.harness.mjs\`/\`*.eval.mjs\` demos + compiled example specs; the CLI-fallback on-ramp.
- \`bench/\` — the real-model A/B benchmark corpus, deliberately OUTSIDE the vitest sweep (run by node, on your sub). Its free \`corpus/verify*.mjs\` self-checks are CI-gated.

BUILD + TOOLING + GENERATED:

- \`scripts/\` — the BUILD pipeline only (\`api-extractor.mjs\`, \`build-report.mjs\`), invoked by \`npm run build\`/CI.
- \`tools/\` — HUMAN-run maintenance scripts, never in CI. Each documented in \`tools/README.md\` (what + WHEN-run + live/dead status): live corpus-maintenance (\`refresh-vendor.sh\`, \`dogfood-sweep.sh\`), pre-launch \`fp-sweep.sh\`, and the demo-asset tooling (\`demo.sh\`, \`make-demo-gif.py\`) for the demo assets.
- \`api-surface/\` — the committed public-API surface snapshots (\`*.api.md\`), one per exported entry point. A generated CONTRACT (lockfile-class), reviewed as a diff, never hand-edited: CI diffs the live \`.d.ts\` surface against these (the API surface gate) and fails a PR that changes a public export until \`npm run api:report\` regenerates + commits it. (Renamed 2026-07-14 from \`etc/\`, which was Microsoft API Extractor's default output dir; the report folder is set in \`scripts/api-extractor.mjs\`.) Distinct from the human API REFERENCE (TypeDoc → GitHub Pages).
- \`.github/\` — CI workflows (\`ci.yml\` is the gate). \`.vigiles/\` — vigiles's own runtime output (gitignored: hook observations, eval locks, the runs ledger).`,
  },
  commands: {
    "npm run build": "Compile TypeScript to dist/",
    "npm test": "Build and run all tests",
    "npm run fmt": "Format with prettier",
    "npm run fmt:check": "Check formatting",
    "npm run lint": "Run ESLint on src/",
    "npm run test:harness":
      "Build + run the deterministic harness tests (`*.harness.mjs`) on the in-repo CLI — needs the claude CLI, no API key",
    "npm run test:eval":
      "Build + run the real-model harness evals (`*.eval.mjs`) on the in-repo CLI — needs claude + model auth",
    "npm run test:vitest":
      "Build + run the cross-runner matcher constraints under vitest (`test/runners/*.vitest.mjs`)",
    "npm run test:jest":
      "Build + run the cross-runner matcher constraints under jest (`test/runners/*.jest.cjs`)",
    "npm run test:types":
      "Build + type-check the vitest/jest matcher augmentation (tsc --noEmit on test/types/)",
  },

  rules: {
    "no-non-null-assertion": enforce(
      "@typescript-eslint/no-non-null-assertion",
      "Use proper narrowing instead of ! assertions.",
      { render: "line" },
    ),

    "no-floating-promises": enforce(
      "@typescript-eslint/no-floating-promises",
      "Always await or return promises. Unhandled rejections crash the process.",
      { render: "line" },
    ),

    "cognitive-complexity": enforce(
      "sonarjs/cognitive-complexity",
      "Keep functions under 10 cognitive complexity (the shared limit in packages/eslint-config). A function older than the limit is held to its file's ceiling in eslint-ceilings.json. Split complex logic into helpers.",
      { render: "line" },
    ),

    "core-not-adapter": enforce(
      "boundaries/dependencies",
      "Hexagonal boundary: every file in src/ belongs to a layer, and imports point inward only. The domain (src/core) imports nothing outside itself, an adapter (src/adapters/<harness>) never imports another adapter, and only the composition root (src/cli.ts, src/cli-main.ts) wires an adapter in. Dogfoods enforce() over eslint-plugin-boundaries.",
      { render: "line" },
    ),

    "experimental-names-carry-the-warning": guidance(
      "If we EXPORT it and it is not stable, its NAME starts with `experimental_`.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "experimental-names-carry-the-warning",
      },
    ),
    "never-skip-tests": guidance("All tests must pass.", {
      details: file("docs/contributing/rules.md"),
      anchor: "never-skip-tests",
    }),

    "no-silent-skips": guidance("A skip must be LOUD, never a silent green.", {
      details: file("docs/contributing/rules.md"),
      anchor: "no-silent-skips",
    }),

    "zero-config-by-default": guidance(
      "`vigiles compile` should work with just a .spec.ts file.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "zero-config-by-default",
      },
    ),

    "dont-reimplement-linters": guidance(
      "Architectural linting belongs in ast-grep/Dependency Cruiser/Steiger.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "dont-reimplement-linters",
      },
    ),

    "prefer-existing-solutions": guidance(
      "Before building any non-trivial capability — a tool, a check, a runtime, a parser — LOOK FOR EXISTING SOLUTIONS FIRST and PREFER adopting/composing/delegating over reinventing.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "prefer-existing-solutions",
      },
    ),

    "parse-structured-input-with-a-real-parser": guidance(
      "Parse a structured language with its real parser, never a hand-rolled regex or line scanner; SKILL.md and subagent frontmatter go through `src/core/frontmatter-read.ts`.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "parse-structured-input-with-a-real-parser",
      },
    ),

    "never-close-a-half-fixed-issue": guidance(
      "An issue closes when the thing it REPORTS stops happening — not when a PR that mentions it merges.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "never-close-a-half-fixed-issue",
      },
    ),

    "make-the-distinction-a-type": enforce(
      "@typescript-eslint/switch-exhaustiveness-check",
      "When a value can be absent for MORE THAN ONE REASON, the reasons are separate facts and the TYPE must name them — a tagged union, not `T | null` / a boolean / a sentinel. Collapsing them into one value means the first caller that has to explain itself to a human picks ONE wording for all of them: a check that did not run, reported in the words of a check that did. That is this tool's whole subject, so it is committed in its own source. THE TELL IS TEXTUAL — you wrote a comment saying what `null` MEANS; a docstring that disambiguates a return value is a type that is missing. Measured 2026-09-20 in `core/symbols.ts`: `langForFile` returned `LangKey | null` under the comment 'or null if unsupported (graceful skip)', and both callers (`core/refs.ts`, `core/compile.ts`) printed 'Unsupported language for symbol check'. Making the grammars optional gave that same `null` a SECOND meaning — the language IS one we parse, the package simply is not installed here — and a try/catch around the imports would have kept both callers printing the first sentence at a user whose real problem was one `npm i` away. The fix was the type: `{kind:'ready',lang} | {kind:'grammar-missing',id,pkg} | {kind:'unsupported'}`, after which refs.ts says 'Symbol not checked: the ruby grammar is not installed (npm i -D @ast-grep/lang-ruby)' — an instruction, not a verdict. THE TRIGGER, countable so this is not taste: reach for a union when BOTH hold — (1) two different causes produce the same 'nothing' (not-applicable vs cannot-run vs found-nothing), and (2) some caller turns that value into words a human reads (a finding, a log line, an exit message). One without the other does not earn it. THE COUNTERWEIGHT, because this becomes ceremony fast: a boolean is RIGHT when the absent case has exactly one cause and no caller explains it — `existsSync`, a predicate, a private helper; a union whose members no call site ever distinguishes is noise, you pay the switch and buy nothing. WHY THE LINT RULE IS PART OF THIS: introducing the union forces every EXISTING call site exactly once (the old `=== null` comparisons stop compiling, which is what got the two callers above fixed), but it does nothing for the member someone adds NEXT year — an if/else-if chain silently falls through it. `switch-exhaustiveness-check` is the part that keeps the guarantee, so a union is SWITCHED over rather than if-chained wherever the members are the subject. Configured with `considerDefaultExhaustiveForUnions: true`: a `default:` that genuinely handles the rest IS exhaustive, and without the option the rule's single finding on the whole corpus was `handleHookRuntime`'s `switch (kind: string | undefined)` — a proper default, an open `string`, nothing to enumerate. Both halves measured the same day: zero findings on the corpus as it stands, and a planted switch omitting one member reports `Cases not matched: \"grammar-missing\"`. This is the general form of what parse-structured-input-with-a-real-parser did for fence state (the 'make-invalid-states-irrepresentable choke-point'): prefer a shape in which the wrong answer cannot be written down over a discipline that asks everyone to remember it.",
      { render: "line" },
    ),

    "public-exports-are-opt-in": guidance("Public exports are opt-in.", {
      details: file("docs/contributing/rules.md"),
      anchor: "public-exports-are-opt-in",
    }),

    "dogfood-vendoring-policy": guidance(
      "The dogfood corpus follows one policy: SHA-pinned, MIT-only, vendored under `test/dogfood/<name>@<sha>/`.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "dogfood-vendoring-policy",
      },
    ),

    "one-detector-no-drift": guidance(
      "A deterministic structural check has one home: a single pure detector reused by both `lint` and `audit`.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "one-detector-no-drift",
      },
    ),

    "lint-rule-calibration": guidance(
      "Every deterministic check sits at the strongest enforcement its decidability allows, and no further.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "lint-rule-calibration",
      },
    ),

    "harness-parity-and-extensibility": guidance(
      "Any new capability is designed for every harness and for extension from the start, before you write code.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "harness-parity-and-extensibility",
      },
    ),

    "adapter-aware-lint-rules": guidance(
      "A lint/scan rule is scoped to the surface it checks, never to a harness: name it by the harness-neutral concept, thread the resolved adapter, and never hard-code a Claude Code literal in core.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "adapter-aware-lint-rules",
      },
    ),

    "test-both-harnesses": guidance(
      "vigiles is MULTI-HARNESS, so a test of a HARNESS-FACING capability must cover BOTH adapters (Claude Code AND Codex), never just Claude Code by default.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "test-both-harnesses",
      },
    ),

    "compose-with-sync-tools": guidance(
      "vigiles is the author+verify layer, not the fan-out layer.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "compose-with-sync-tools",
      },
    ),

    "smooth-adoption": guidance(
      "`npx vigiles init` works on the first run with zero config, sets up both layers (lint and test) on a new repo, and never hangs on a prompt in agent, CI or piped runs.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "smooth-adoption",
      },
    ),

    "great-agent-flow": guidance(
      "An agent handed 'install vigiles and test my skills' must succeed from the README alone, without friction.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "great-agent-flow",
      },
    ),

    "install-enforcement-model": guidance(
      "`vigiles init` enforces through rule groups keyed by confidence, not a menu of strictness presets.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "install-enforcement-model",
      },
    ),

    "gate-first-adoption": guidance(
      "The adoption north star: `audit` (local) and `lint` (CI) must be useful and safe for every repo with zero setup; everything richer is invited, never forced, and the 'not evil' contract binds every adoption surface.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "gate-first-adoption",
      },
    ),

    "format-before-commit": guidance(
      "Run `npm run fmt:check` before committing.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "format-before-commit",
      },
    ),

    "run-the-gates": guidance(
      "The gate set is ONE COMMAND — `npm run check` — never a list you retype.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "run-the-gates",
      },
    ),

    "pick-the-test-tier": guidance(
      "A new check goes in the cheapest tier that can decide it: unit, then harness, then eval; the full map is in `CONTRIBUTING.md`.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "pick-the-test-tier",
      },
    ),

    "conventional-commits": guidance(
      "Commit subjects AND PR titles are Conventional Commits — they drive the release version via `@semantic-release/commit-analyzer` off `main` (`feat` → minor, `fix` → patch, everything else no bump).",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "conventional-commits",
      },
    ),

    "before-you-open-a-pull-request": guidance(
      'Before changing what a rule, a file kind, a command or a config key means, or when opening a pull request, read the "Before you open a pull request" section of CONTRIBUTING.md.',
      {
        details: file("docs/contributing/rules.md"),
        anchor: "before-you-open-a-pull-request",
      },
    ),

    "lead-with-easy-adoption": guidance(
      "Public docs — and the README's FIRST SCREEN especially — must make CLEAR and UP-FRONT that adopting vigiles is LOW-FRICTION because SKILLS + HOOKS do the mechanical work for you.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "lead-with-easy-adoption",
      },
    ),

    "progressive-adoption": guidance(
      "vigiles must be adoptable incrementally, like TypeScript — but progressive about ENFORCEMENT DEPTH, NOT about whether obvious breakage fails.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "progressive-adoption",
      },
    ),

    "no-session-links": guidance(
      "This repo is public: never put a Claude Code session URL in a commit or a PR.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "no-session-links",
      },
    ),

    "no-product-strategy-here": guidance(
      "This repo is public: never commit roadmap, competitive analysis, go-to-market or design documents for capabilities that are not yet shipped — the line is built vs unbuilt.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "no-product-strategy-here",
      },
    ),

    "hook-startup-cost-is-watched": guidance(
      "A compiled hook runs on EVERY matching tool call, so what it LOADS is a user-visible cost paid per call, not per session.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "hook-startup-cost-is-watched",
      },
    ),

    "subagent-model-note": guidance(
      "When you launch a subagent, tell the user in one short line which model you chose and why.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "subagent-model-note",
      },
    ),

    "surface-architecture-decisions": guidance(
      "The user is often flying BLIND on structure — they cannot see WHERE you put a file, whether a thing is CORE vs an ADAPTER vs a PORT, or whether you extended something vs created a sibling.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "surface-architecture-decisions",
      },
    ),

    "doc-per-rule": guidance(
      "Every validation rule in .vigilesrc.json must have a corresponding doc in docs/rules/<rule-name>.md.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "doc-per-rule",
      },
    ),

    "rules-docs-in-sync": guidance(
      "The `RulesConfig` keys in `src/core/types.ts` are the rule set; `docs/verifying-instruction-files.md` and `docs/rules/` must list every rule.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "rules-docs-in-sync",
      },
    ),

    "readme-brevity": guidance(
      "README.md is the FRONT DOOR and a marketing asset, not a reference manual — it must land a WOW in the first screen for someone who already lives in agentic-coding tools (Claude Code, Codex, Cursor).",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "readme-brevity",
      },
    ),

    "docs-quality": guidance(
      "The docs/ reference docs are the HOW the README defers to — they are NOT held to README brevity (depth is their job; a long reference doc is correct, a wall of undifferentiated prose is not).",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "docs-quality",
      },
    ),

    "prose-clarity": guidance(
      "Public prose (README + docs/) must be CLEAR and SCANNABLE for a human skimming on a screen — not dense, jargon-packed, or wall-of-text.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "prose-clarity",
      },
    ),

    "public-vs-internal-docs": guidance(
      "Match the detail to the AUDIENCE — don't overload public readers.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "public-vs-internal-docs",
      },
    ),

    "no-internal-links-in-public-docs": guidance(
      "PUBLIC docs (`README.md` + `docs/*.md`) must NEVER link to or name-drop an INTERNAL doc (any internal-only file).",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "no-internal-links-in-public-docs",
      },
    ),

    "doc-consistency": guidance("Docs MUST stay consistent with the code.", {
      details: file("docs/contributing/rules.md"),
      anchor: "doc-consistency",
    }),

    "document-the-why": guidance(
      "Docs must give every user-facing DECISION and CONCEPT a discoverable home that answers WHY / WHAT, not only a command-or-API reference for HOW.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "document-the-why",
      },
    ),

    "ts-essentials": guidance(
      "USE `ts-essentials` — it is installed as a RUNTIME dependency (`package.json` `dependencies`, `^10.2.1`), so import what it ships instead of hand-rolling an equivalent.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "ts-essentials",
      },
    ),

    "prefer-immutable-updates": guidance(
      "Build a new value, don't edit an existing one — and where the value crosses a function boundary, make the edit IMPOSSIBLE rather than merely absent.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "prefer-immutable-updates",
      },
    ),

    "prod-grade-gha-cli": guidance(
      "The CLI and the GitHub Action are production-grade, first-class surfaces — for most users CI is how vigiles actually runs — and must be kept that way, not treated as afterthoughts.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "prod-grade-gha-cli",
      },
    ),

    "cohesive-cli-surface": guidance(
      "vigiles is ONE cohesive organism, not a pile of stray commands — the CLI, the GitHub Action, and the agentic-coding flow are three FACES of the same capability set and must stay coherent.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "cohesive-cli-surface",
      },
    ),

    "cohesive-feature-delivery": guidance(
      "A capability is ONE organism with MANY surfaces — and 'done' means coherent across ALL of them, not just the one you started with.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "cohesive-feature-delivery",
      },
    ),

    "dual-language-tests": guidance(
      "Harness/eval test SCRIPTS must run whether authored in JavaScript (`.mjs` / `.cjs` / `.js`) or TypeScript (`.ts` / `.mts` / `.cts`) — neither language is second-class.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "dual-language-tests",
      },
    ),

    "analogical-transfer": guidance(
      "Find non-obvious checks by analogical transfer: map a mature CS principle onto the harness, even when it looks crazy at first.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "analogical-transfer",
      },
    ),

    "doc-tiers": guidance(
      "This repo is public, with two documentation audiences: users (`README.md`, `docs/`) and contributors (`CLAUDE.md`, code comments); neither carries product strategy.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "doc-tiers",
      },
    ),

    "audit-side-effect-free": guidance(
      "`vigiles audit` and every default lint/report path is safe to run anywhere: it never mutates the user's world or runs a stranger's code unconfined, and every executing check — live MCP, trigger-rate, and the ESLint rule catalog (`src/core/rule-catalog.ts`, which loads the repo's ESLint config) — sits behind the one consent.",
      {
        details: file("docs/contributing/rules.md"),
        anchor: "audit-side-effect-free",
      },
    ),

    "no-orphan-docs": enforce(
      "vigiles/orphan-docs",
      "Every `.md` in an opted-in directory (vigiles scans `docs/`, declared via the `.vigilesrc.json` `orphans` block) must be referenced from at least one other markdown file — README, a compiled instruction file, or another doc. Orphan docs rot silently because nothing tells the agent they're still load-bearing. The rule is OPT-IN (off unless the `orphans` block is declared; `include` defaults to `docs/`) because 'unreferenced' only signals rot in a hand-cross-linked corpus, not a nav-managed doc site (Docusaurus/MkDocs) where the page graph lives in config — an OSS sweep confirmed ~100% false positives there. Inverse of stale-reference detection: stale-ref catches specs pointing at missing files, orphan detection catches existing files that no spec points at. Mechanical check in `src/core/orphans.ts`, surfaced by `vigiles lint`.",
      { render: "line" },
    ),

    "recompile-on-spec-change": guard(
      { watch: "*.spec.ts", run: "npx vigiles compile" },
      "Recompile instruction files when any spec changes.",
    ),

    "regen-types-on-config-change": guard(
      {
        watch: ["eslint.config.*", "package.json", "pyproject.toml"],
        run: "npx vigiles generate types",
      },
      "Regenerate type definitions when linter configs or package.json change.",
    ),

    "format-check": guard(
      { watch: "**/*.ts", run: "npm run fmt:check" },
      "Verify formatting on TypeScript file changes.",
    ),
  },
});
