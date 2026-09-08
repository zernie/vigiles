# Non-JS harnesses (Kotlin, Go, …)

The README has the pitch; this is the full guide for using vigiles on a harness
whose repo is **not** JavaScript/TypeScript — a Kotlin, Go, Java, Rust, or Python
project with no `package.json` and no Node toolchain.

**TL;DR:** vigiles's reference + structural layer works on **any** harness with
**zero toolchain** — you only need `npx`. The linter cross-referencing (“your
rules → enforced”) reaches the JVM and Go ecosystems too. Only the JS-specific
setup (`package.json` devDep, `npm install`) is skipped — you run everything
through `npx vigiles`.

## What works with no toolchain

Everything below runs with **only `npx`** (Node is fetched on demand) — no
`package.json`, no install step, identical output on every OS:

| Command               | Works? | What it checks                                                                                                                                                                                                                                                                                                     |
| --------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vigiles audit`   |   ✅   | The four deterministic rings — Truthfulness (references resolve), Triggering (skills fire / don't collide), Structure (tool contracts, MCP, frontmatter), Safety — plus the advisory Tested (deterministic harnesses) and Evaluated (real-model evals, or `not measured`) counts. A local report, like Lighthouse. |
| `npx vigiles lint`    |   ✅   | The CI gate — reference integrity, subagent tool contracts, hook events/scripts, MCP resolution, skill triggers, lethal-trifecta. Exit codes 0/1/2.                                                                                                                                                                |
| `npx vigiles compile` |   ✅   | The typed-spec path. A spec's `import … from "vigiles/spec"` is resolved from the CLI's own install, so it needs no `node_modules/vigiles` in your repo — and no `package.json` to install one into.                                                                                                               |
| `npx vigiles test`    |   ✅   | The deterministic harness tier (`*.harness.mjs`) — same resolution, so `import { runHook } from "vigiles"` works uninstalled. You still author the test file in JS (see below).                                                                                                                                    |

None of these read your repo's source language — they read the **harness**
(`CLAUDE.md`/`AGENTS.md`, `skills/`, `agents/`, hooks, MCP config), which is
markdown + shell regardless of what your app is written in.

## CI on a non-JS repo

`npx vigiles` needs only Node for the CLI itself, so the CI job is just a
checkout + `setup-node` + the Action — no `package.json` required:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: zernie/vigiles@v1
```

`vigiles init` detects this: on a repo with no `package.json` it scaffolds the
workflow **without** an `npm install` step (which would otherwise fail), and it
skips adding vigiles to `devDependencies` — you invoke it via `npx`. It still
scaffolds and compiles specs; that path does not need the install.

## Linter cross-referencing for JVM / Go

The “rules → enforced” feature verifies that a prose rule (e.g. “always use
`===`” → the `eqeqeq` rule) exists **and** is enabled in your linter config. It
supports native JVM and Go linters, not just the JS/Python ones:

| Ecosystem | Linters        | Rule prefix            |
| --------- | -------------- | ---------------------- |
| Kotlin    | detekt, ktlint | `detekt/…`, `ktlint/…` |
| Java      | Checkstyle     | `checkstyle/…`         |
| Go        | golangci-lint  | `golangci-lint/…`      |

vigiles detects the linter from its config file (`detekt.yml`, `.editorconfig`,
`checkstyle.xml`, `.golangci.yml`) and cross-references your rules against it.

**Know the limits before you rely on it** — these tools expose less than ESLint,
so a couple of checks are intentionally weaker (they never cry wolf, but they
verify less):

- **ktlint** ships no rule catalog, so the existence check is _format-only_ — a
  reference must be a qualified `ktlint/<ruleset>:<rule-id>` (e.g.
  `ktlint/standard:no-wildcard-imports`); the enabled-state read (from
  `.editorconfig`) is real.
- **Checkstyle** has no rule-listing command, so a module absent from your
  `checkstyle.xml` is reported _disabled_ (a config is a whitelist).
- **detekt** falls back to the generated default catalog and fails _open_ (never
  flags every rule) when it can't enumerate.

See [`docs/linter-support.md`](linter-support.md) for the full linter list and
each tool's config conventions.

## The Tested / Evaluated metrics for a native test loop

`audit`/`lint` count vigiles-native files for two advisory metrics, split by what
they cost and what they answer: `*.harness.mjs` feeds **Tested** — free,
deterministic, every push — and `*.eval.mjs` feeds **Evaluated**, the paid
real-model tier that is the only thing that can say whether a skill fires.
A file matched by a custom `include` counts toward **Tested**.

> ⚠️ **Changed in 15.x:** `*.test.*` / `*.spec.*` no longer count. If you have a
> `foo.test.mjs` beside a skill, **rename it `foo.harness.mjs`** — see
> [the migration note](rules/untested-skill.md#migrating-a-test-named-foo-testmjs-changed-in-15x). If you test your
> skills through a native loop instead
> (a Kotlin test suite, a Go benchmark, a promptfoo config), point `include` at
> it so those files count — see
> [the external-suite section in the untested-skill rule](rules/untested-skill.md#counting-an-external-test-suite-promptfoo-a-home-grown-eval-loop).

## What still assumes JS

The harness-**testing** API (`runHook` / `runHarnessTest` / `runEval` from
`vigiles` / `vigiles/eval`) is authored in JS/TS — you `import` it. It tests the
**harness** (hooks, skills, subagents), which is language-agnostic, so it applies
to a Kotlin/Go repo's Claude Code harness too — you just write the test file in
JS (or run the zero-setup `*.harness.mjs` CLI fallback via `npx vigiles test`).
The deterministic `audit`/`lint` layer above needs none of this.

## See also

- [`docs/linter-support.md`](linter-support.md) — all 11 supported linters.
- [`docs/harnesses.md`](harnesses.md) — which agent harnesses vigiles targets.
- [`docs/rules/untested-skill.md`](rules/untested-skill.md) — counting an external test loop.
