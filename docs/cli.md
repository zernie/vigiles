# CLI & CI reference

Full command-line surface, the Claude Code plugin, and the `vigiles lint`
validation rules. The GitHub Action has its own [reference](github-action.md).
For the pitch and quick start, see the [README](../README.md).

## Commands

```bash
npx vigiles init [--target=X.md]    # Scaffold a spec (runs full setup wizard by default)
npx vigiles compile [files...]      # Compile .spec.ts → .md AND .vigiles/hooks/* → merged hooks config + stamp
npx vigiles eject [file]            # Un-manage a compiled file → plain hand-owned markdown (--keep-spec)
npx vigiles lint [files...]         # Verify references + integrity + symbols + coverage (incl. instruction-file symbol marks)
npx vigiles test [files...]         # Run *.harness.{mjs,ts} deterministic harness tests (no API key)
npx vigiles eval [files...]         # Run *.eval.{mjs,ts} real-model harness evals (--trials=N) — local, on your subscription
npx vigiles eval --all              # Run ALL discovered evals — a bare no-target `eval` asks first (it spends model quota)
npx vigiles eval --update           # Record each named eval's result to a committed .vigiles/eval-locks/<name>.lock.json (local)
npx vigiles eval --check            # Verify committed eval results against current inputs WITHOUT a model — the CI staleness gate
npx vigiles audit [dir]              # Lighthouse for your harness: category rings + fixes (a deterministic read); writes vigiles-report.html + .json
                                     # the executing checks (your hooks · live MCP · do skills FIRE?) run only interactively — a plain audit asks once
npx vigiles audit <dir> --no-html    # Skip writing vigiles-report.html · --no-json skips the JSON artifact (both written by default)
npx vigiles audit <dir> --out=reports  # Write the report to a custom dir (CI upload) · --no-open skips auto-opening the HTML · reports are auto-gitignored
npx vigiles audit <dir> --json       # Print the versioned AuditReport JSON to stdout (the upload/CI contract)
npx vigiles audit <after> --capability-diff=<before>  # Did this change WIDEN the agent's blast radius? (no model)
npx vigiles generate types          # Emit .d.ts from project state (for spec mode; --check to verify)
npx vigiles generate schema         # Emit JSON Schema for vigiles: frontmatter (--check to verify)
npx vigiles generate harness [dir]  # Emit harness.gen.ts — one typed registry over every spec (--check to verify)
```

### Arguments the CLI does not recognise are refused

Every verb **rejects an unknown flag** with a non-zero exit (`2`), names it, and
suggests the nearest real one:

```bash
$ npx vigiles audit --no-htlm
✗ vigiles audit: unknown flag "--no-htlm".
  Did you mean `--no-html`?
```

This matters most on `audit`, whose flags decide what **leaves the machine**
(`--no-html`, `--no-json`, `--out=<dir>`, `--serve`). A swallowed typo produced
the opposite of what was asked for, silently. Value flags take their value with
`=` only (`--out=dir`, never `--out dir`) — the space-separated form is rejected
rather than being read as a positional.

`vigiles <verb> --help` prints that verb's help and its complete flag list
instead of running the verb.

### Exit codes

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | ran, nothing blocking                                                             |
| `1`  | ran, and what you asked about is bad — lint findings, a failing harness script    |
| `2`  | **could not do what you asked** — unknown flag, unknown harness, nothing to audit |

`audit` in particular exits `2` when the target has **no instruction file and no
surface at all**: there was nothing to measure, so no grade is reported. That is
deliberately distinct from a harness that was audited and scored badly (exit
`0`) — a script must be able to tell "this repo is unhealthy" from "I was
pointed at the wrong directory".

`vigiles test` / `vigiles eval` run scripts in JS **or** TS and report each as
**pass / skip / 0 checks / fail** — a tier that can't run (e.g. deterministic with
no `claude`) reports a loud `⊘ SKIPPED`, tallied separately, never a fake green.
Unit-tier `runHook` tests need no `claude` and always run. A skip passes by
default; in a CI job that **asserts** the capability is present, add `--no-skip`
so a skipped tier **fails** (a green-with-skips is untested surface).

**A file that verified nothing says so: `∅ … 0 CHECKS`.** Exit codes answer "did
it fail?", never "did it do anything?", so a script that ran NOTHING used to print
the same `✓` as one that ran and passed — the classic shape being a file that
_defines_ tests (`export default { … }`) and never calls them. Each tier now
records its own runs, and the runner reports a clean exit with **zero** recorded
checks as its own state. It is **not** a failure (the exit code is unchanged), and
a script that never imports `vigiles` cannot report at all, so it stays a
plain pass — silence is the legacy branch, never a verdict. If your harness
asserts some other way (`node:assert`, a runner's `expect`), call `recordCheck()`
from `vigiles` so those count.

**`vigiles eval` asks before fanning out.** A bare `vigiles eval` with no target
discovers every `*.eval.*` in the tree, and each one runs the **real model on your
subscription** — so it never fires them all silently. Name the eval(s) to run
(`vigiles eval path/to/x.eval.mjs`), pass `--all` to opt into the whole set, or
answer the prompt at a terminal. Run headless with none of those and it **refuses**
(exit 2) rather than spend quota. `vigiles test` is free and deterministic, so it
always runs everything it finds. (Discovery is by name — `*.harness.*` / `*.eval.*`,
never `*.test.*` / `*.spec.*` — so it won't pick up your vitest/jest files.)

**`test` runs several scripts at once; `eval` runs them one at a time.** The two share a runner
and want opposite defaults, so the default follows the tier rather than a flag. Harness scripts are
free and deterministic by construction — the tier drives the agent CLI against a mock model with no
API key — so running them concurrently cannot cost anything, and on one real repository of 48
harness files it took the suite from **270s to 77s with byte-identical results**. Evals spend real
model quota, where concurrency means simultaneous billed calls and rate limits, so they stay
strictly serial.

Each script's output is buffered and printed whole when that script finishes, rather than streamed
live, because concurrent children writing to one terminal interleave into an unreadable mess.
Results are reported in discovery order regardless of which finished first — a run that reorders
its own output between invocations reads as flaky even when every result is stable.

**Already have vitest or jest? You don't need a second runner for the
deterministic tier.** The testing API — `runHook`, `runHarnessTest`, the check
vocabulary, and the matchers (via `vigiles/vitest` / `vigiles/jest`) — are plain
functions you call inside your existing suite (vigiles's own unit suite runs on
vitest). The standalone `vigiles test` CLI is the **zero-dependency floor** for
when no runner is installed, not a replacement. `vigiles eval` stays its own
surface by design: real-model, non-deterministic, and statistical (mean ± se,
trials, record/replay) — that doesn't fit a unit-test runner's pass/fail model,
which is why every LLM-eval tool is separate from jest too.

By default `init` sets up **both layers** — **Lint** (verify instruction-file
references) and **Test** (test the harness): it scaffolds a typed spec + types
(Lint), a starter `vigiles.harness.mjs` (Test), wires CI as a
`zernie/vigiles@v1` workflow (creating `.github/workflows/vigiles.yml` when none
exists), and installs the Claude Code plugin.

**Interactive vs non-interactive:** run in a terminal (a TTY), `init` prompts for
which layers, CI, and the plugin. Run by an agent, in CI, or with piped input
(no TTY) — or with `--yes` — it skips the prompts and applies the defaults. So
"set up vigiles" from a Claude Code / Codex prompt Just Works without hanging.

### `init` flags

| Flag                     | Effect                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`, `-y`            | Skip prompts; use defaults (both layers, CI, the plugin)                                                                                                 |
| `--ci-only`              | The CI check only: the lint gate + CI workflow + devDep, **nothing installed** — no plugin/spec/test (see below)                                         |
| `--lint` / `--no-lint`   | Lint layer — verify instruction-file references (default on)                                                                                             |
| `--test` / `--no-test`   | Test layer — scaffold a harness test (default on)                                                                                                        |
| `--harness=claude,codex` | Which harness(es) to set up (default: auto-detect from the repo)                                                                                         |
| `--no-gha`               | Skip wiring CI                                                                                                                                           |
| `--no-plugin`            | Skip installing the vigiles **Claude Code plugin** (its skills + hooks, into `~/.claude/`) — not a vigiles-CLI plugin, and never vendored into your repo |
| `--strict`               | Also enforce the workflow tier (specs + tests; see below)                                                                                                |
| `--report-only`          | Write the whole gate at `warn` — nothing fails CI (migration mode)                                                                                       |
| `--target=AGENTS.md`     | Adopt / create a spec for one file (Lint layer only)                                                                                                     |

Passing a single positive layer flag selects only it (`--lint` = the Lint
layer only); pass both, or neither, for both. `init` also adds `vigiles` to your
`devDependencies` (moving it out of `dependencies` if it's there) so the
scaffolded `vigiles.harness.mjs` resolves `vigiles`.

**`--ci-only` — the CI check only, nothing installed.** At a terminal the wizard's
first question is "gate vs full"; `--ci-only` is the same choice for a headless run
(an agent or CI). It sets up the deterministic lint gate on your raw files, wires
CI, and adds the dev dependency — then stops: no plugin, no scaffolded spec, no
test. It's the zero-conflict path for a repo that already has its own harness (or
isn't JS/Python). **Full stays the default** — bare `init` is unchanged, so
`--ci-only` is an opt-in that never hides the richer layers; the setup still prints a
one-line invitation to run the full setup later, and the report keeps showing what
a spec or eval would catch.

#### What `init` gates by default (vs `--strict`)

There's no confusing "strict mode" to remember: **a plain `init` already makes
CI catch broken surfaces.** It writes the **high-precision, FP-safe** structural
rules to `error` in `.vigilesrc.json`, so a broken surface **fails `vigiles
lint`** (exit 2) — but a well-formed plugin stays green, so it never cries wolf:

- `subagent-tool-contract` (a typo'd / never-available tool),
  `subagent-frontmatter` (a subagent missing `name`/`description`),
- `hook-events` (a typo'd event that never fires), `hook-script-exists` (a dead
  hook script),
- `mcp-config` / `mcp-tool-resolves` / `mcp-hook-target-resolves` (broken MCP),
- `disallowed-tools-contract`, and `description-overlap` (two skills that
  collide in the selector).

`--strict` adds the **`workflow`** group on top — the rules a clean repo can
still fail because you haven't done the work yet: `require-instructions-spec` (a
spec per instruction file) and `untested-skill` / `untested-subagent` /
`untested-hook` (a test per surface). These stay opt-in so your first CI run isn't
red just for not having written a spec yet. (`frontmatter-valid` and
`skill-frontmatter` are **`nudge`**-group — they stay `warn` and never gate, even
under `--strict`.) `--report-only` is the orthogonal dial: it writes the whole
gate at `warn` so nothing fails CI — the migration / observe on-ramp.

Because `init` **auto-adopts** every existing instruction file into a spec (see
[`compile`](#compile-files--harness-selection) / the adopt note below),
`require-instructions-spec` is green by construction right after setup — opting
into `--strict` doesn't turn your CI red on a wall of missing specs.

#### Auto-adopt — `init` leaves you with specs, not homework

When `init` finds an existing hand-written `CLAUDE.md` / `AGENTS.md`, it
**faithfully adopts** it into a `.spec.ts` instead of scaffolding a blank one:
every heading becomes a prose section verbatim, **no rule is inferred**, nothing
is dropped.

**Adoption is non-destructive — `init` never overwrites your file.** It writes the
spec and leaves your `CLAUDE.md` exactly as-is. When you're ready to switch it to
spec-managed, run `npx vigiles compile`: it reproduces the file (plus an integrity
header) — for a well-structured file the diff is just that header, so **review the
diff and commit**. Then run the `/strengthen` skill to upgrade prose to verified
`enforce()` / `guard()` rules when you want, or
[`eject`](#eject-file--adopting-a-spec-is-never-a-one-way-door) to hand the file
back as plain markdown. Adopt one file by hand with
`npx vigiles init --target=CLAUDE.md`.

(In a brand-new repo, `init` defers the compile until you've run `npm install`
— the spec imports `vigiles`, so it can't compile before the dep is installed. It
prints the exact next step instead of erroring.)

**Interactive `init` offers the workflow tier (recommended, opt-out):** at a
terminal it asks _"Also enforce specs + a test per surface?"_ (default yes), and
the agentic install flow asks the same — so a human turns it on with eyes open. A
**non-interactive** `init` (an agent / CI with no one to ask) stays
structural-only unless you pass `--strict`, so an automated setup never silently
turns an existing repo's CI red for not having written a spec yet.

Either way `init` **never clobbers a severity you set** — it only fills in the
undefined ones. Honest limit: Claude Code itself loads a name-less or broken-YAML
**skill**, so vigiles can't hard-gate skill content that still works — it gates
the subagent / hook / MCP defects (and skill collisions) that genuinely break.
See the [rules matrix](verifying-instruction-files.md#the-validation-rules--the-full-matrix).

`vigiles lint` accepts files **or a directory** (`vigiles lint .` discovers the
instruction files under it); with no argument it discovers them from the repo root.

See the [agent setup & workflows guide](agent-setup.md).

### `compile [files...]` — harness selection

> **Not to be confused with the rule engine.** `vigiles compile` is the **spec
> compiler** (`.spec.ts` → `.md`). It is a _different system_ from the
> **`@vigiles/rule-enforcer`** package (dir `rule-enforcer/`), which turns _prose_
> rules from your CLAUDE.md into enforceable lint rules (route → synthesize →
> gate). Same word "compile", unrelated jobs. That tier has its own page:
> [`rule-enforcer/README.md`](../rule-enforcer/README.md).

`compile` renders each `.spec.ts` to its instruction file / `SKILL.md` /
subagent. Which **harness dialect** it renders (the `SKILL.md` frontmatter
profile, the subagent tool catalog) is resolved deterministically — no cwd
sniffing:

1. `--harness=<name>` flag — wins (`claude-code`/`codex`; `claude` is an alias).
2. The **spec's own target** for an instruction file — a `CLAUDE.md.spec.ts` is
   claude-code, an `AGENTS.md.spec.ts` is codex.
3. The **`harnesses` key** in `.vigilesrc.json` (written by `init`):
   `{ "codex": {} }`, or `{ "claude-code": {}, "codex": {} }` to declare a
   multi-harness repo. For a single-dialect operation like `compile` the FIRST
   key is used, with a loud notice; override per run with `--harness=`.
4. Auto-detect from the repo, warning when it's ambiguous.

```bash
npx vigiles compile                      # all specs, harness from config/detect
npx vigiles compile --harness=codex      # force the Codex dialect for this run
```

Two multi-harness behaviours:

- **Instruction-file mirror.** When `harnesses` declares ≥2 harnesses and no sync
  tool (Ruler/rulesync) or existing mirror fans the file out, `compile` writes a
  **byte-identical** `CLAUDE.md`⇄`AGENTS.md` copy. It carries the source's
  integrity hash, so a hand-edit of the mirror trips the `integrity` check. It
  never clobbers a target that has its own spec.
- **Frontmatter-drop warning.** A skill that sets Claude-Code-only frontmatter
  (`disable-model-invocation`, `argument-hint`) in a repo that also declares a
  `minimal`-profile harness (Codex/OpenCode) gets a warning — those keys are
  dropped there, so the constraint won't apply.
- **Auto-refreshes `harness.gen.ts`.** If the repo already has a whole-harness
  registry (see [`generate-harness`](#generate-harness-dir-out)), `compile` keeps
  it in sync as a side effect — so you never hand-run that generator. It's gated
  on the file existing (compile maintains a registry you opted into, never imposes
  one) and cheap (parsing specs, no linter spawn). A duplicate agent name fails
  the compile.

`lint` takes **no** `--harness`: reference verification is harness-agnostic (it
already recognizes both `CLAUDE.md` and `AGENTS.md`), unlike `compile` (renders
one dialect) and `audit` (reports harness-specific structure).

### `eject [file]` — adopting a spec is never a one-way door

`eject` is the inverse of `compile`: it hands a compiled instruction file back to
you as plain, hand-owned markdown. It strips the `vigiles:sha256` integrity
header, removes the `.spec.ts` that managed the file (`--keep-spec` leaves it),
and adds a `<!-- vigiles-disable require-instructions-spec -->` marker so `lint`
won't ask for a spec back. The compiled file's content is preserved verbatim — you keep
everything, you just stop managing it through a spec.

```bash
npx vigiles eject CLAUDE.md             # back to plain markdown; the spec is removed
npx vigiles eject CLAUDE.md --keep-spec # keep the spec (compile would re-manage the file)
```

A file with no integrity header isn't vigiles-managed, so `eject` reports
"nothing to eject" and changes nothing. This is the escape hatch behind
"managed, but ejectable": you can adopt a typed spec for stronger guarantees
knowing you can always drop back to markdown you own.

Two safety details: a **shared spec is kept** — if the file you eject was one of
several outputs of a multi-target spec (`target: ["CLAUDE.md", "AGENTS.md"]`, or a
mirror), the spec is left in place until its last compiled output is ejected, so
the others never orphan. And a compiled **skill / subagent** (its body leads with
YAML frontmatter) is ejected verbatim — no disable marker is inserted (that would
displace the frontmatter and break the surface; the marker only applies to
instruction files).

### Compiled hooks — folded into `compile`

A **compiled hook** is a hook authored as a pure typed function against the
closed `vigiles/hook` vocabulary, which makes whole classes of hook bugs
unrepresentable (false confidence, matcher bypass, capability creep); see the
[compiled-hooks guide](compiled-hooks.md) for the why.

There is **no `compile-hook` verb** — hook compilation is folded into `compile`
(the cohesive-cli-surface principle: one verb compiles every
typed authoring artifact). Put the hook source in **`.vigiles/hooks/`** (it's
harness-neutral, so it lives in vigiles's own dir, not `.claude/`), then:

- `vigiles compile` discovers `.vigiles/hooks/*` (or take one: `vigiles compile
.vigiles/hooks/x.mjs`), runs the capability check (an import outside
  `vigiles/hook` **fails the build**, exit 1), **merges** the block into the
  active harness's config (`.claude/settings.json` / `.codex/config.toml`)
  idempotently, and writes a tamper-evident stamp to `.vigiles/hooks/<file>.json`.
- `--harness=codex` merges a Codex `config.toml` `[[hooks.<event>]]` block (an
  anchored-regex matcher) instead of the Claude Code JSON. The same typed program
  compiles to either; the gate runtime is shared (Codex vetoes via `exit 2`).
- **Context providers.** A gate can decide on external state by declaring
  `needs: ["git.branch"]` (built-ins: `git.branch`/`git.isDirty`/`git.root`/`cwd`/
  `os.platform`/`env.isCI`), or an inline `provide(name, cmd)` / `dangerously(name,
cmd)`, or a **registered** provider. `compile` also discovers
  **`.vigiles/providers/*`** (`export default defineProvider({ name, run })`),
  validates each is read-only (unless `dangerous: true`), and checks every
  `provider()` ref resolves — a dangling ref or an unsafe provider **fails the
  build**. The trusted runtime gathers the declared facts; the hook does zero I/O.
  See the [compiled-hooks guide](compiled-hooks.md#deciding-on-external-state-context-providers).

The merged block points at the `hook-runtime run-program` entrypoint (below).

Honest scope: this fixes the hook's authoring + logic, not the harness's
delivery. The delivery floor moved —
[#34692](https://github.com/anthropics/claude-code/issues/34692) (a subagent's
tool calls bypassing `PreToolUse`) is fixed as of Claude Code 2.1.241, measured
headless (`claude -p`); interactive sessions are unmeasured. A gate is
still a strong default rather than an unbypassable wall, because a model can
route around a tool entirely.

### `hook-runtime <kind>` — runtime entrypoints (not typed by hand)

The harness invokes these on every matching event, via a block `vigiles compile`
emits — they are **not verbs**, so they live under one hidden umbrella, off the
help surface (verbs are typed; runtime entrypoints are emitted). You should never
type one yourself; `compile` wires them for you.

- `vigiles hook-runtime run-program <file>` — the compiled-hook runtime: reads
  the live event on stdin, **verifies the stamp** (a hand-edited artifact is
  refused — exit 2, fail closed), and dispatches by role — a gate exits 2 +
  reason on `deny`, an inject prints `additionalContext`, a react runs its
  classified command. Exit codes: `0` allow, `2` deny/refuse.
- Other kinds (`agent`, `skill`, `skill-tool`, `refs`, `guard`, `intercept-tool`,
  `effect-enter`/`effect-exit`, …) back the subagent/skill rails and other
  emitted gates. Renaming a `<kind>` breaks every already-emitted block, so it's
  a breaking change.

### `audit [dir]`

**Lighthouse for your harness.** Point vigiles at any plugin or repo (defaults to
`.`) and get a one-command report — **no model, no API key, safe to run
anywhere**: six **category rings**, each finding's **fix** inline,
and a self-contained **HTML report**. It's a local report, not a CI step (CI uses
[`lint`](#lint-files)).

```
Harness audit

  ● Truthfulness   100  ██████████████████████
  ◑ Triggering      92  ████████████████████░░
  ● Structure      100  ██████████████████████
  ● Safety         100  ██████████████████████
  ◑ Tested          88  ███████████████████░░░  · advisory (not graded)
  ? Evaluated  not measured                      · advisory (not graded)
       └ 6 surfaces whose firing was never measured; not measured — run `npx vigiles audit` interactively to measure, or add a `*.eval.mjs` (`paid_measureTriggerRate`, vigiles/eval)

Harness health: B (95/100)
```

The six categories — **Truthfulness** (refs resolve) · **Triggering** (skills
fire / don't collide) · **Structure** (tool contracts, MCP, frontmatter) ·
**Safety** (no unit holds all three lethal-trifecta legs — a prompt-injection
exfil path) · **Tested** (deterministic harness coverage) · **Evaluated**
(real-model eval coverage) — are each 0–100, weighted into the overall
grade; an n/a category is excluded, never a false 0. The first five are
**deterministic** (no execution): **Safety** is the **static** lethal-trifecta
capability check over a unit's declared tool-set. (The **executing** "do your
hooks actually block?" disaster-battery is NOT a ring: running arbitrary hooks
safely needs cross-platform confinement that isn't shipped yet — so it lives in
the [`vigiles` testing API](harness-testing.md) via `guardrail-check` /
`assertBlocksDisasters`, where you opt in explicitly.)

**Tested and Evaluated are two rings, not one number.** A harness
(`*.harness.*`) is free, runs in milliseconds on every push, and
asks _does this gate still catch what it claims?_ An eval (`*.eval.mjs`) spends
real model calls, runs on a schedule, and asks the one question a deterministic
read cannot: _does this skill fire at all?_ Folded together, a repo with complete
deterministic coverage and no evals scored identically to a repo with neither —
and the prescription ("add a test/eval") spanned three orders of magnitude in cost
without saying which. Both rings are **advisory**: neither moves your grade.

**Evaluated has three states, and the third one matters.**

| state          | meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| a number       | measured — evals exist here; this is their coverage                                                           |
| `0`            | the firing tier ran this session and nothing covers these surfaces                                            |
| `not measured` | nobody asked. No eval on disk **and** the executing checks were skipped (headless, `--json`, a remembered no) |

`not measured` is deliberately not a `0`: reporting the absence of a check as the
result of a check is the exact failure mode vigiles flags in other people's
harnesses. In that state the ring names the command that would answer the
question, instead of leaving it to a line of prose at the end of the report.

Under the rings, the detailed report lists per-skill description + user-invoked
flag, per-agent tool contract (and the "no `tools:` line → inherits every tool"
footgun), hook resolution (`ok` / `missing` / `unresolved`), command + MCP
detection, and untested-surface counts. `--json` for CI; `--no-html` to skip the
report file.

It also prints a **rule inventory**: prose rules in your instruction file that
map to an off-the-shelf lint rule (`no console.log`, `no any`, `no eslint-disable`,
…), each marked _enforced_ (the rule is in your lint config), _likely enforced_
(covered by a `recommended` preset), or _documented, not enforced_ — the last is a
one-line config fix, and the HTML report gives you a copy-a-prompt button for it.
Deterministic and safe: it reads the config **text** only — never resolves or
executes it — and matches only whole rule-name/code tokens, so prose doesn't trip
it (dogfooded across 20 large OSS repos to drive the false-positive rate to ~0).
Multi-linter by shape (ESLint config today, plus oxlint/biome which share ESLint's
rule names); Ruff/Clippy/Pylint/RuboCop/Stylelint mappings are additive data.

**The safety battery is a [testing-API](harness-testing.md) capability, not an
`audit` ring** — it _executes_ your `PreToolUse` hooks against a curated disaster
catalog (force-push, `rm -rf`, `--no-verify`, secret-read, `curl|sh`) to prove
they actually **block** (the #1 verified hook pain: a guard that _looks_ like it
blocks and silently doesn't). Because running arbitrary hooks safely needs
cross-platform confinement that isn't shipped yet, it's **not** part of the
zero-config report; you run it where you opt in explicitly — `guardrail-check` /
`assertBlocksDisasters` from `vigiles`, or via the `test-harness` skill.

Each deterministic finding carries its **fix inline** under the report — the
cross-reference cause + a one-line correction (`FIX` a dead-end, `DIFFERENTIATE` a
description collision), `likely` dead-ends before `possible` proxies.

**A shareable HTML report** is written to `vigiles-report.html` by default — a
self-contained React app (category rings, findings, fix cards; auto light/dark)
the CLI fills with the report JSON, so it opens offline by double-click. Screenshot
it, attach it to a PR; for a human at a TTY it's **opened in your browser**
automatically (like `lighthouse --view`; `--no-open` suppresses it). `--no-html`
skips writing it. A versioned **`vigiles-report.json`** is written alongside
(`--no-json` to skip) — the same contract `--json` prints, for CI or upload.

**Share a local result with no upload.** When the audited repo has a GitHub
`origin` remote, `audit` prints `Share this grade → https://vigiles.sh/?repo=owner/repo`.
The in-browser demo re-runs the audit **live** for whoever opens the link, so
there's nothing to upload and no backend — but a recipient can only fetch a
**public** repo (the line says so). It's a suggestion on the human-readable path
only, never an automatic share.

**The report artifacts stay out of git.** Because `audit` runs zero-config
(without `init`), it keeps `git status` clean itself: when it writes a report it
idempotently adds `vigiles-report.*` to your `.gitignore` (appending only what's
missing, under a labelled block; if you have no `.gitignore` it prints a one-line
tip instead of creating one). It's the same pattern as `next build` keeping
`.next/` ignored — the tool that writes a build artifact keeps it out of version
control. Use **`--out=<dir>`** to write the report to a custom directory (created
if missing; its relative path is what gets gitignored) — handy for a CI upload
step.

`audit` reports **harness-specific structure** (plugin layout, hook resolution),
so it auto-detects the harness — printing the detected one and warning when a repo
matches several — and takes `--harness=<name>` to override. (`compile` is
harness-aware for the same reason; `lint` isn't — reference verification is
harness-agnostic.)

**Dialect freshness (Claude Code).** Because vigiles's tool/event catalog is
hand-maintained against a specific Claude Code version, `audit` does a best-effort,
**read-local** check of your _installed_ `@anthropic-ai/claude-code` and prints a
one-line `⚠` only when its tool surface has drifted (a new/removed tool type) from
the catalog — a nudge that tool/contract checks may be stale and a vigiles update
may be due. It reads only your own install (nothing is sent or vendored), never
throws, and stays silent on a mere version bump with no surface change.

```bash
npx vigiles audit ./some-plugin          # human-readable report for one plugin
npx vigiles audit ./some-plugin --json   # structured, for pipelines
npx vigiles audit ./plugins/*/           # ≥2 targets → ranked health leaderboard
npx vigiles audit ./plugins/*/ --md      # ranked leaderboard as a Markdown table (publishable)
npx vigiles audit ./marketplace-repo     # a marketplace.json root → ranks every member
npx vigiles audit ./marketplace-repo --single  # ...or audit that root as ONE harness
npx vigiles audit ./repo --harness=codex # override harness detection
```

### Configuration

`audit` and every other command read `.vigilesrc.json` from the repo root. The
keys, what each one does, and a config using all of them are on one page:
**[Configuration](configuration.md)**.

The two you are most likely to want:

| key                      | for                                                  |
| ------------------------ | ---------------------------------------------------- |
| `exclude`                | files in the repo that are not the repo's own        |
| `harnesses.<name>.roots` | skills in a folder the tool does not read by default |

### `lint` in a monorepo, and getting both artefacts from one run

**Nested bundles.** `lint` scores the root bundle. If the repo holds more
(`plugins/*/skills/`), it now NAMES them rather than leaving them out silently:

```
⚠ 2 nested bundle(s) discovered but NOT scored: plugins/alpha, plugins/beta
```

Score them all in one pass — one exit code over the whole repo, which is what a
CI gate needs — with `--bundles=all`, or `"bundles": "all"` in `.vigilesrc.json`.
Root-only stays the default because descending unconditionally would also score
vendored third-party plugins as if they were yours.

**Both artefacts, one scan.** `--json` replaces stdout; `--json-out=<file>`
writes the JSON to disk and leaves stdout human-readable, so a CI job that wants
the log for a human AND the JSON for a PR comment scans once:

```bash
npx vigiles lint . --json-out=reports/lint.json
```

**One number to quote.** Every run ends with a total that matches `--json`:

```
88 finding(s): 0 error, 88 warning — exit 0
```

Counting `⚠` lines gives a different number — some checks print one line per
finding, others one line carrying a count — so the total is computed from the
report, not from the output.

**Running the harness tier without installing into the project.** A harness
imports `vigiles` by name, and in a repo that already has a `package.json` a root
install pulls the entire dependency tree. `vigiles test` now resolves that import
from the CLI's own installation, so `npx vigiles@<version> test` works with
nothing installed in the project. A locally installed vigiles still wins.

#### `--single` — audit a many-bundle root as one harness

A marketplace root switches to the leaderboard automatically, which means the
full ring report **for that root** has no way to be asked for. `--single` pins
the single-harness reading regardless of what is nested inside:

```bash
npx vigiles audit . --single    # rings for the root itself, not a table of members
```

It names ONE harness, so passing several directories alongside it is refused
(exit 2) rather than auditing the first and dropping the rest.

Note `--out` writes a report only in single-harness mode; in leaderboard mode
there is no per-bundle report to write, and `audit` now says so instead of
ignoring the flag silently.

#### Leaderboard — rank many plugins

Pass **more than one directory** — or a single **marketplace** root (a
`.claude-plugin/marketplace.json`, e.g. `wshobson/agents`' 80+ plugins, which
`audit` expands into its members) — and `audit` switches to a **ranked health
leaderboard**: a deterministic structural-health score (0–100 + A–F) per plugin,
worst issues first. Weights: a missing hook script −15 (won't run), a skill with
no usable description −10 (can't trigger), a broken intra-plugin reference −8
(partial-vendor / dead path), an agent with no `tools:` contract −5 (inherits
everything), an untested surface −3. Scoring deliberately ignores the loader's
free-text warnings (they include doc-mention false positives), so the ranking
stays defensible. A **command-only** plugin (`commands/*.md`), a **hooks-only** one
(gates and nothing else — script-backed or inline in `plugin.json`) and an
**MCP-only** one (`.mcp.json`) are each a real, valid surface and score on their own
health — only a directory with _no_ surface at all scores 0. Add **`--md`** to
emit the ranking as a **Markdown table** (the publishable form for a README/gist/site;
`--json` gives the full per-plugin breakdown). A worked at-scale run over real public
plugins lives in `bench/leaderboard/` (`run.mjs` + the generated `RESULTS.md`).
(The leaderboard is the multi-dir form and does not run the executing checks or
write an HTML report — those are the single-dir audit.)

**A marketplace whose members are all external** (each `source` is a git/url
object, so nothing is on disk) expands to no members — so `audit` falls back to
auditing **that directory itself**, as a plugin. This matters because a repo can be
both: a `marketplace.json` listing external members can sit beside a `plugin.json`
naming its own directory, with real skills, agents and hooks in it. The marketplace
listing describes _other_ directories, and never suppresses the one you pointed at.
If the directory really has no surface of its own you get the ordinary "nothing to
audit" outcome — **exit 2**, plus a line naming the external members and suggesting
you clone one and scan that.

#### `audit` is a local report, not a CI step

Like Lighthouse, `audit` is something you **run on your machine** to see your
harness's health — not a build gate. **CI uses [`vigiles lint`](#lint-files)**
(deterministic, stable exit codes 0/1/2); `audit` is the human-facing read +
report. (You _can_ pipe `audit --json` somewhere, but it's not a pass/fail gate.)

#### The executing checks — `audit` asks (interactive only)

A plain `audit` is a deterministic **read**. Three checks actually _run_ your
harness, and they share **one** consent:

1. **Safety battery** — execute each PreToolUse hook against the disaster catalog
   to prove it blocks (network-confined where a sandbox exists; otherwise your own
   hooks run direct with a loud warning, a foreign plugin's skip).
2. **Live MCP resolution** — **start each declared MCP server** and check every
   `mcp__server__tool` resolves (`tools/list`), catching silent "rename rot". Own-repo
   only — a foreign plugin's servers are never spawned. (Starting a server connects
   to its real backend, which is why it never runs on a plain read.)
3. **Skill firing (trigger-rate)** — how reliably each model-invocable skill's
   description **FIRES** (recall) and stays quiet on unrelated prompts (precision).
   Probes are **auto-generated from each skill's description** (zero setup);
   `--prompts=<file>` supplies a curated set + the selection-collision matrix.

4. **Adoptability preview** — see what vigiles would catch **before you adopt it**.
   `audit` uses a model to draft a spec from your `CLAUDE.md`, then
   deterministically verifies every reference it found — linter rules, file paths,
   npm scripts, directories — and reports how many are broken right now. This is a
   **read-only preview**: it never writes anything; `vigiles init` is what adopts
   the spec. Claude Code only in v1.

   ```
   Adoptability — what vigiles would lock in
     vigiles drafted a spec from CLAUDE.md: 23 verifiable reference(s) found
      3 broken right now:
        ✗ eslint rule "import/no-cycle" is referenced but not enabled
        ✗ `npm run typecheck` referenced — no such script in package.json
     → run `vigiles init` to adopt the spec and catch these at edit time.
   ```

**How the consent works** — `audit` is a read by default; the executing checks need
a human to consent (there's **no execution flag** — see below):

- **At a terminal (TTY)** → `audit` **asks once** ("Run the executing checks against
  your harness?" — with a confinement + cost disclosure) and **remembers** the answer
  in `.vigilesrc.json` (`audit.measure`).
- **Headless** (`--json` / CI / non-interactive / an agent) → stays a read + a
  one-line nudge; never hangs, never silently executes.
- **No execution flag.** `audit` is a local report — it runs the executing checks
  only when a human can consent. For automation, test the harness through the
  [vigiles testing API](harness-testing.md) (`paid_measureTriggerRate` on `vigiles/eval`, `guardrail-check` on `vigiles`)
  - skills — the layered tiers that exist for exactly that. The deterministic read is
    identical on every OS; there's deliberately no `--measure`/`--fast`.

```bash
npx vigiles audit ./some-plugin                                # read; asks to run the checks at a TTY
npx vigiles audit ./some-plugin --prompts=./probes.json       # curated trigger set (used when you say yes)
```

The trigger tier needs the harness CLI + model auth; it **degrades honestly**
("unavailable") when absent, runs on your own Claude Pro/Max subscription (or
`ANTHROPIC_API_KEY`). `--harness=codex` routes the trigger probe through the native
Codex driver. See
[`docs/harness-testing.md`](harness-testing.md).

#### Capability diff — `audit <after> --capability-diff=<before>`

**Did this change widen the agent's blast radius?** Computes each version's
whole-harness **capability lattice** from its scanned agents — the union of every
agent's reachable tools (read-only / side-effecting / unknown-MCP) plus the loosest
purity floor — and diffs them. A change **WIDENS** the surface iff it adds a
side-effecting or unknown/MCP tool, or loosens the purity floor; new read-only tools
and removals are reported but are **not** a widening. Deterministic, no model.

`<before>` is any prior version — e.g. a git worktree of the PR's base. Intended as a
**PR comment**, so it's **informational by default** (exit 0); pass `--fail-on-widen`
to make a widening a non-zero exit (the opt-in CI gate — don't cry wolf, since
widening is often intended).

```bash
npx vigiles audit ./head --capability-diff=./base                  # report (exit 0)
npx vigiles audit ./head --capability-diff=./base --fail-on-widen  # exit 1 if widened
npx vigiles audit ./head --capability-diff=./base --json           # structured diff
```

This is the **capability-diff** check: the capability surface is the typed
effect lattice `generate-harness` already computes; the diff reads it.

### `generate harness [dir] [out]`

Emit **one typed registry** — `harness.gen.ts` — over every `*.spec.ts` under
`dir`, so a single `tsc --noEmit` cross-checks the **whole harness as one
program** (think TanStack Router's `routeTree.gen.ts` or the Prisma client). It's
the third generated artifact beside `generate types` (`.d.ts`) and
`generate schema` (JSON Schema).

> **You rarely run this by hand.** Like all three `generate-*` artifacts, it's
> dev-toolchain output (read by `tsc`/your editor, never by the agent). Once the
> file exists, **`compile` keeps it fresh** — this verb is the explicit/CI
> escape-hatch (e.g. `--check`). `generate-types`/`generate-schema` similarly run
> off a guard on linter-config changes, not by hand.

It ships four cross-spec checks:

- **Dangling `delegate` → a `tsc` error at edit time.** Every `railway()`
  delegate target (`steps`, `recover.step`, `onError`) is checked against the
  literal union of every agent name. A `delegate("ghost")` whose target has no
  spec makes the generated assertion a `tsc` error naming the missing target
  (`__dangling_delegate: "ghost"` from its railway) — no vigiles run, in your
  editor.
- **Duplicate agent names → a non-zero exit.** Two specs declaring the same
  `name` make `generate-harness` exit `2` naming the collision. This is an O(N)
  check in the generator, **not** a type — a set-uniqueness type is the TS2589
  wall (see the research).
- **Cross-file typed composition → a `tsc` error at edit time.** When a
  `railway()` success-track step declares what it `needs()`, the gen file asserts
  the **previous** step's agent `result().ok` SUPPLIES it — **across files**. A
  step that needs `diff: "string[]"` whose producer emits `diff: "string"` (or
  doesn't emit `diff` at all) is a `tsc` error naming the field
  (`__handoff_error: { __mismatch: "diff", expected: "string[]", got: "string" }`
  / `__missing: "diff"`). This is the repo-scale generalization of the per-file
  `pipe`/`Supplies` composition — one shallow per-pair assertion (O(N), no
  recursion). Scoped to the **linear success track**; `recover`/`onError` edges
  (which consume an `err`, not the prior `ok`) are a noted follow-up. A railway
  whose `delegate()`s declare **no** `needs` generates exactly as before — the
  check is purely additive and opt-in per edge.
- **The whole-harness capability lattice.** A computed `harnessCapabilities`
  export — the union of every agent's effect surface (read-only / side-effecting
  / unknown tools + the loosest purity) — the substrate a future repo-scale
  capability-diff reads.

```bash
npx vigiles generate harness ./agents               # → ./agents/harness.gen.ts
npx vigiles generate harness ./agents out.gen.ts    # custom out path
npx vigiles generate harness ./agents --check        # CI: assert the gen file is up to date (exit 1 if stale)
npx vigiles generate harness ./agents --harness=codex
```

**tsconfig need:** the gen file imports sibling `*.spec.ts` directly, so the
tsconfig that type-checks it needs `"allowImportingTsExtensions": true` (under
`Node16`/`NodeNext` resolution). Commit `harness.gen.ts` like a lockfile and add
a `--check` step to CI so a stale registry is caught, then let `tsc --noEmit`
enforce the cross-checks. Wire regeneration to a spec guard (the same mechanism
as `recompile-on-spec-change`):

```ts
guard({ watch: "*.spec.ts", run: "npx vigiles generate harness" });
```

Declare a handoff with the optional 3rd argument of `delegate()` — the same
`experimental_needs(...)` builder a typed `experimental_pipeStep` uses:

```ts
import { experimental_agent } from "vigiles/spec";
const { railway, delegate, needs: experimental_needs } = experimental_agent;
railway({
  name: "ship-pr",
  steps: [
    delegate("planner"),
    delegate(
      "implementer",
      undefined,
      experimental_needs({ steps: "string[]" }),
    ), // planner.ok must supply `steps`
    delegate("reviewer", undefined, experimental_needs({ summary: "string" })), // implementer.ok must supply `summary`
  ],
});
```

See [`docs/railway-subagents.md`](railway-subagents.md) for the typed-composition
guide.

## Lint vs audit — gate vs report

`lint` and `audit` look like they overlap, but they're **different verbs with
different contracts** — the classic gate-vs-report split (think `eslint .` /
`tsc --noEmit` vs `npm audit` / `terraform plan`):

- **`lint` is the gate.** It runs on **your** repo with **your** config, verifies
  references (file paths, scripts, and linter rules across **11 linters** — does
  the rule exist _and_ is it enabled?), checks integrity/hash, coverage
  thresholds, orphan docs, duplicate rules — and exits with **config-driven
  severities → stable CI codes (0/1/2)**. It blocks bad commits.
- **`audit` is the report** (Lighthouse-style, local — not a CI step). Zero config,
  harness-aware, works on **any** plugin (including third-party ones with no spec).
  It scores the six category rings, ranks a whole marketplace
  (leaderboard), and writes the HTML report — all a safe read. Two **executing**
  checks (live MCP resolution + "do skills fire?") run only on the interactive
  consent (`audit-side-effect-free`); for automation, run those — and the safety
  battery — through the `vigiles` testing API.

They deliberately **share one implementation** of the few deterministic
structural detectors they have in common (untested-surface, dangling-ref,
description-script), per the `one-detector-no-drift` rule, so the two surfaces can
never disagree. The asymmetry everywhere else is intentional: some checks need
inputs only the gate has (your linter configs, your compiled output), and the
**model-gated trigger column must never become a `lint` rule** (lint stays free +
deterministic + every-commit).

**What each does:**

| Check                                                       |  `lint`  |  `audit`  | `audit` (interactive) |
| ----------------------------------------------------------- | :------: | :-------: | :-------------------: |
| Linter-rule cross-ref (11 linters, exists **+ enabled**)    |    ✓     |     –     |           –           |
| Marked file/script ref verification                         |    ✓     |     –     |           –           |
| Integrity/hash · duplicate-NCD · coverage · orphan docs     |    ✓     |     –     |           –           |
| Untested surface                                            |  ✓ gate  |  ✓ ring   |           –           |
| Dangling ref · description-script _(shared detectors)_      |    ✓     |     ✓     |           –           |
| Instruction file · tool-contract/inherits-all · hooks · MCP |    –     |     ✓     |           –           |
| Category rings + weighted health score                      |    –     |     ✓     |           –           |
| HTML report                                                 |    –     | ✓ default |       ✓ default       |
| Leaderboard (rank a marketplace)                            |    –     |     ✓     |           –           |
| MCP tool exists on **live** server                          |    –     |     –     |      ✓ own-repo¹      |
| Trigger recall/precision (does a skill fire?)               |    –     |     –     |          ✓²           |
| Adoptability preview (broken refs in your instruction file) |    –     |     –     |          ✓⁴           |
| Safety battery (does a hook block?) — `vigiles`             |    –     |     –     |          –⁵           |
| Config severities + CI exit codes                           |    ✓     | read-only |       read-only       |
| **Cost tier**                                               | free/det | free/det  |     **model/sub**     |

The two executing checks share **one consent**: a plain `audit` is a read; at a
TTY it **asks once** (remembered in `.vigilesrc.json`). There is no execution flag
— for automation use the `vigiles` testing API, not the report verb.

¹ Live MCP **starts your servers** (connects to real backends), so it's **own-repo
only**; a foreign plugin's servers are never spawned.
² The trigger tier needs model auth; it **degrades honestly** ("unavailable") when
absent and runs on your subscription (or a metered key).
⁴ The adoptability preview uses a model to draft a spec from your instruction file and
then verifies every reference deterministically. Claude Code only in v1; never writes
anything to the repo. Runs on your subscription ($0 metered).
⁵ The safety battery (run your hooks against the disaster catalog) is **not** an
`audit` check — it needs cross-platform confinement that isn't shipped, so it lives
in the `vigiles` testing API (`guardrail-check`/`assertBlocksDisasters`).

**Where each runs:**

| Target             |        `lint`        |        `audit`        | `audit` (interactive) |
| ------------------ | :------------------: | :-------------------: | :-------------------: |
| Normal app repo    |   ✓ (marked refs)    | ✓ (instruction file)⁴ |    n/a (no skills)    |
| Claude Code plugin |          ✓           |           ✓           |           ✓           |
| Codex plugin/repo  | ✓ (harness-agnostic) | ✓ (auto-detect, TOML) |  ✓ `--harness=codex`  |
| Marketplace (many) |       per-file       |     ✓ leaderboard     |    per-plugin only    |

⁴ On a plain repo `audit` reports the detected instruction file (`CLAUDE.md` /
`AGENTS.md`, spec-managed vs hand-written) but no plugin surface; reference
_verification_ of that file is `lint`'s job (and needs marks — inline,
frontmatter, or a spec; plain prose isn't auto-parsed).

The executing checks are **state-safe by consent**: a plain `audit` runs none of
them (a deterministic read), so it's safe on any repo, even one wired to prod. On
opt-in, live MCP starts servers own-repo only, and the trigger-rate stubs skill
bodies so no procedure runs. (The safety battery — which executes arbitrary hooks
and so needs cross-platform confinement that isn't shipped — is not here; it's a
`vigiles` testing capability you invoke explicitly.)

For how all five verbs (`audit` / `lint` / `test` / `eval` / `init`) fit together —
and why measuring "do my skills fire?" from an agent uses `init`, not `audit` — see
[Commands & how they relate](commands-and-how-they-relate.md).

## GitHub Action

Run vigiles in CI via a composite action over the published `npx vigiles` CLI.
The full reference — quick start, every input, the three output channels (incl.
the sticky PR comment), and the Action-tag-vs-CLI-version model — is in its own
doc: **[github-action.md](github-action.md)**.

```yaml
- uses: zernie/vigiles@v1 # runs `lint` by default; see github-action.md
```

## Claude Code plugin

Without the plugin, you're responsible for manually running `compile` and
`generate-types`. With it, the agent works with fresh instruction files
automatically, and the consumer skills (`strengthen`, `adopt-spec`,
`test-harness`, `edit-spec`) are available (edit-spec now covers adding a rule).

The plugin installs through the **Claude Code plugin marketplace** — globally
into `~/.claude/plugins/`, **not** vendored into your repo. In a Claude Code
session:

```
/plugin marketplace add zernie/vigiles
/plugin install vigiles@vigiles
```

`vigiles init` does this for you (it runs the non-interactive `claude plugin`
CLI when available, else prints these two commands). Nothing is written to your
working tree, so there is nothing to `.gitignore` or accidentally commit.

The plugin provides hooks:

- **PreToolUse** (Edit/Write) — blocks direct edits to compiled `.md` files and redirects the agent to the `.spec.ts` source
- **PostToolUse** (Edit/Write) — auto-runs `generate-types` on linter config changes, `compile` on `.spec.ts` changes; nudges marking unmarked references
- **SessionStart** — surfaces the project's vigiles state

> Internal vigiles-development skills (`generate-logo`, `pr-to-lint-rule`,
> `enforce-rules-format`, `audit-feedback-loop`, `audience-check`, `code-quality`)
> live under `.claude/skills/` — this repo's own harness, auto-loaded when a
> contributor works in-repo. They are **not** shipped to consumers (`.claude/` is
> not published).

### Codex

Codex has no plugin marketplace, but the same skills install **globally** via the
cross-agent [`skills` CLI](https://github.com/vercel-labs/skills) — to the global
agents store `~/.agents/skills/` (which Codex reads), again not vendored into your
repo:

```bash
npx skills add zernie/vigiles -a codex -g -y
```

(The `-g` is what keeps it out of your repo — without it, `skills` vendors into
`./.agents/skills/`. `-y` skips the confirmation prompt.)

`vigiles init --harness=codex` (or auto-detection on an `AGENTS.md` repo) runs
this for you. Codex reads `AGENTS.md` directly, so no plugin is needed for
instructions; only the authoring skills install. Codex **hooks**
(`.codex/config.toml [hooks]`) are not auto-wired yet — add them by hand if you
want compile-on-edit.

## Validation rules

`vigiles lint` runs a set of deterministic validation rules over your instruction
files, skills, subagents, and hooks (configured in `.vigilesrc.json`). The full
matrix — every rule, its default severity, what it checks, and a link to its
reference doc — lives with the linting guide:

**[→ The validation rules, the full matrix](verifying-instruction-files.md#the-validation-rules--the-full-matrix)**

Quick severity config:

```json
{
  "rules": {
    "require-instructions-spec": "error",
    "integrity": "error",
    "coverage": ["warn", { "scripts": 50, "linterRules": 5 }]
  }
}
```

Disable per-file with `<!-- vigiles-disable require-instructions-spec -->` at the top of the markdown.
