# GitHub Action

Run vigiles in CI. The README has the pitch; this is the full Action reference.
For the CLI the Action wraps, see the [CLI reference](cli.md).

The Action is a **composite action over the published `npx vigiles` CLI** — it
runs the exact artifact you'd run locally, so there's no separate bundle to drift.
Every input maps to a real CLI flag.

## Quick start

```yaml
name: vigiles
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read # all the Action needs; it only reads files and emits annotations

jobs:
  vigiles:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: zernie/vigiles@v1 # runs `lint` by default
```

That's the whole thing — `lint` verifies that every linter rule, file path,
script, and symbol your `CLAUDE.md` / `AGENTS.md` cites is real and enabled, checks
the integrity hashes, and reports coverage. Failures appear inline as GitHub
annotations and fail the job.

## Compile specs in CI

```yaml
- uses: zernie/vigiles@v1
  with:
    command: compile # spec.ts → markdown; fails if a reference is stale
    paths: CLAUDE.md.spec.ts # optional; auto-discovers when omitted
```

## Run the harness tests

```yaml
on:
  pull_request:
  push:
    branches: [main]

jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm # caches the `npm ci` the Action runs
      - uses: zernie/vigiles@v1
        with:
          command: test # → `vigiles test`, after `npm ci`
          changed-only: "true" # pull_request: only what the PR reaches; push: everything
          min: "40" # fail if fewer than 40 harness files ran (default: 1)
          no-skip: "true" # fail if any file reports SKIPPED
```

Harness files import the library and your repo's own packages, so `command: test` runs `npm ci`
first when there is a `package-lock.json` and no `node_modules`. An install step of your own before
the Action wins (it finds `node_modules` and installs nothing); set `install: "false"` to skip it.
With pnpm or Yarn, install in a step before the Action. Because the install comes first, the default
`version` then runs the vigiles your `package.json` declares — the same copy your harness files import.

Harness files drive the real `claude` binary against a scripted model (no API key), and a file
without it skips. So `command: test` installs the CLI (`npm install -g @anthropic-ai/claude-code`)
when the runner has none on `PATH` or in `node_modules/.bin`; set `install-claude: "false"` to skip
that. And because a run in which every file skipped tested nothing, `test` fails unless at least one
file **ran**: `min` defaults to `1` for `test`, a declared skip does not count toward it, and
`min: "0"` turns the floor off.

**`changed-only`** maps to a bare [`vigiles test --changed`](cli.md#running-only-what-a-change-reaches---changed):
on `pull_request` events the CLI diffs against the PR's base (fetching it into the shallow
checkout, so no `fetch-depth: 0`), and on any other event every file runs — the push to your
default branch stays the full sweep. Each selected file is listed with its reason; a pull request
that reaches none says `0 of N test file(s) selected` rather than passing silently.

**`min`** is a floor on the files that **ran** — a file that declared a skip or never loaded did not.
Discovery is checked against it **before** `changed-only` narrows the set, so a glob that broke
still fails on every pull request.

## Check eval results aren't stale (no model)

Real-model evals run locally on your subscription (`vigiles eval --update`, which
commits a lock). This job verifies those committed results against the current
inputs **without** a model call — failing if you changed a skill but forgot to
re-eval. It **fails** until you commit your first lock (`vigiles eval --update`):
with no recorded result there is nothing to verify, and a pass would mean nothing
was checked. Set `min: "0"` to stay green until the first eval file exists (the job
`vigiles init` scaffolds is a plain `npx vigiles eval --check --min=0` step for the same reason).

```yaml
- uses: zernie/vigiles@v1
  with:
    command: eval-check # → `vigiles eval --check`; no API key, no subscription
```

## Inputs

| Input               | Default        | Description                                                                                                                                                                                                                                       |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`           | `lint`         | `lint` (verify references + integrity + coverage), `compile` (specs → markdown), `test` (run the harness files; [above](#run-the-harness-tests)), or `eval-check` (verify committed eval locks vs current inputs — the staleness gate, no model). |
| `paths`             | _(auto)_       | Comma/space-separated paths or globs — `.md` for `lint`, `.spec.ts` for `compile`, harness files for `test`. Auto-discovers.                                                                                                                      |
| `changed-only`      | `false`        | `test`: run only what the change reaches (maps to a bare `--changed`): the PR's base on `pull_request`, every file on any other event.                                                                                                            |
| `min`               | `1` for `test` | `test`, `eval-check`: fail unless at least this many files ran (maps to `--min=`); a declared skip does not count. Checked against discovery before `changed-only` narrows. `0` turns the `test` floor off; `eval-check` has no floor by default. |
| `no-skip`           | `false`        | `test`, `eval-check`: fail when a file reports itself SKIPPED (maps to `--no-skip`).                                                                                                                                                              |
| `install`           | `true`         | `test`: run `npm ci` first when `package-lock.json` exists and `node_modules` does not.                                                                                                                                                           |
| `install-claude`    | `true`         | `test`: install the `claude` CLI when the runner has none on `PATH` or in `node_modules/.bin`; harness files skip without it.                                                                                                                     |
| `version`           | _(repo)_       | npm version of `vigiles` to run (`34`, `34.1.2`, `latest`). Empty (the default) runs the version **your `package.json` declares** — see [Versioning](#versioning). `local` runs a checked-out build.                                              |
| `max-rules`         | _(unset)_      | Cap rules per spec (maps to `--max-rules`).                                                                                                                                                                                                       |
| `catalog-only`      | `false`        | Only check that linter rules exist; skip config-enabled checks (maps to `--catalog-only`).                                                                                                                                                        |
| `preset`            | _(none)_       | Add a preset for this run, on top of your `.vigilesrc.json` (maps to `--preset=`; `lint` only). `experimental` runs the [experimental rules](configuration.md#experimental-rules) at `warn`, so they report and never fail the run.               |
| `working-directory` | `.`            | Directory to run vigiles in.                                                                                                                                                                                                                      |
| `comment`           | `true`         | On `pull_request` events, post/update a sticky PR comment with the result.                                                                                                                                                                        |
| `capability-diff`   | `false`        | On `pull_request` events, diff the agent's capability surface (subagents' tool/effect blast radius) vs the PR base and fold it into the sticky comment (maps to `--capability-diff`). Needs `fetch-depth: 0` on checkout.                         |
| `audit-summary`     | `true`         | Add the audit grade to the job summary and the sticky comment ([below](#audit-grade-in-prs)); on `pull_request`, with each ring's change vs the PR base. Never changes the job's result.                                                          |
| `fail-on-widen`     | `false`        | With `capability-diff`, fail the run when the PR **widens** the blast radius (maps to `--fail-on-widen`).                                                                                                                                         |
| `github-token`      | _(auto)_       | Token for the PR comment. Defaults to the workflow token (`${{ github.token }}`).                                                                                                                                                                 |

## Output channels

Beyond the `valid` step output, the Action reports **three** ways:

1. **Inline annotations** — failures appear on the diff (`::error`).
2. **Job summary** — a markdown result block on the run page (`$GITHUB_STEP_SUMMARY`), with the [audit grade](#audit-grade-in-prs).
3. **Sticky PR comment** — on `pull_request` events, one comment that is _updated in place_ each run (found by a hidden marker, never duplicated). Requires `pull-requests: write`; set `comment: false` to disable.

```yaml
permissions:
  contents: read
  pull-requests: write # needed for the sticky PR comment

# ...
- id: vigiles
  uses: zernie/vigiles@v1
- run: echo "passed=${{ steps.vigiles.outputs.valid }}"
```

The `valid` output is `'true'` if vigiles passed (exit 0), `'false'` otherwise.
Exit codes (also reflected in `valid`): **0** clean · **1** warnings · **2** hard errors.
On a fork PR (read-only token) the comment step degrades to a warning — the job still passes/fails on the result.

## Capability diff in PRs

Set `capability-diff: true` to answer one question on every PR: **did this change widen what your agents can do?** The Action materializes the PR base, computes the [capability diff](cli.md#capability-diff--audit-after---capability-diffbefore) (new side-effecting/unknown tools, a loosened purity floor), and folds a short section into the same sticky comment — only when something actually changed. It's informational by default; add `fail-on-widen: true` to block a PR that grows the blast radius.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # required: the base commit must be present to diff against
- uses: zernie/vigiles@v1
  with:
    capability-diff: "true"
    # fail-on-widen: "true"   # optional gate
```

`fetch-depth: 0` is required because a shallow checkout (the default) doesn't carry the PR base commit the diff compares against.

## Audit grade in PRs

On by default (`audit-summary: true`): the job summary and the sticky comment
get a short audit section from [`audit --md`](cli.md#the-pr-comment-summary--audit---md) —
the A–F grade and score, the four graded rings, the top three fixes, every fix in
a collapsed list. On a `pull_request` the Action also audits the PR base (the same
base the capability diff uses, materialized once) and shows each ring's change:

```markdown
### vigiles audit: **B** · 82/100 (base B → B, 81 → 82 ▲)

| Ring                   |   Base → now |
| :--------------------- | -----------: |
| Truthfulness           |          100 |
| Triggering             |          100 |
| Structure              |          100 |
| Safety                 |    81 → 82 ▲ |
| Tested _(advisory)_    |    40 → 37 ▼ |
| Evaluated _(advisory)_ | not measured |
```

It is the **headless** audit, and says so: the checks that need your consent
(starting live MCP servers, measuring skill trigger rate, loading your ESLint
config) do not run in CI, so a local `npx vigiles audit` can show more. The base
needs `fetch-depth: 0`; without it the section shows the current grade and a note.

It **never changes the job's result**. An audit that errors, or an older vigiles
whose `audit --md` predates the section, leaves a one-line note instead. Turn it
off with `audit-summary: "false"`.

## Versioning

**The Action tag and the npm version are two separate version lines.** The Action
is a thin composite that runs the published `npx vigiles@<version>` CLI, so:

- **Action ref** (`uses: zernie/vigiles@v1`) — pin the **floating major tag**
  `@v1`. `1` is the major of the _wrapper's own interface_ — its inputs and
  outputs — which has only ever grown, so it is still 1 while the npm package is
  on a far higher number. The release pipeline re-points `v1` at each new
  release, so you get wrapper fixes automatically. For byte-for-byte
  reproducibility pin a full release tag (e.g. `@v26.0.1`) or a commit SHA;
  `@main` tracks unreleased `HEAD`. Do **not** pin one of the bare `v2`…`v26`
  tags: a bug in the release pipeline (fixed 2026-09-07) derived those from the
  package version, and they are now frozen where they stopped.
- **CLI version** (`version:` input) — selects which published `vigiles` npm
  release the Action runs. **Leave it out** and the Action runs the vigiles your
  repo already declares, so CI and a local `npx vigiles` run the same version:

  | your repo                                           | the Action runs                     |
  | --------------------------------------------------- | ----------------------------------- |
  | has vigiles installed (`node_modules/.bin/vigiles`) | that copy (`npx --no-install`)      |
  | declares it, and `package-lock.json` records it     | the locked version                  |
  | declares it, no npm lockfile entry                  | the declared range (e.g. `^34.1.0`) |
  | does not declare vigiles                            | `latest`                            |

  The log line says which of these it used. Set `version:` to override it: a
  major (`'34'`), an exact release (`'34.1.2'`) or `latest`.

So `uses: zernie/vigiles@v1` with no `version:` runs **your** vigiles through the
v1 Action wrapper — the one pin is your `package.json`. The `@v1` does **not**
mean "vigiles 1.x". To run a different CLI than your repo declares:

```yaml
- uses: zernie/vigiles@v1
  with:
    version: "latest" # ignore package.json; @v1 pins the Action wrapper
```

The workflow `npx vigiles init` generates sets no `version:` for this reason.

To verify generated types are fresh in CI:

```yaml
- run: npx vigiles generate types --check
```

## See also

- [CLI reference](cli.md) — the commands the Action wraps.
- [Verifying instruction files](verifying-instruction-files.md) — what `lint` checks.
