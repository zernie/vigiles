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

## Check eval results aren't stale (no model)

Real-model evals run locally on your subscription (`vigiles eval --update`, which
commits a lock). This job verifies those committed results against the current
inputs **without** a model call — failing if you changed a skill but forgot to
re-eval. It's a green no-op until you commit your first lock.

```yaml
- uses: zernie/vigiles@v1
  with:
    command: eval-check # → `vigiles eval --check`; no API key, no subscription
```

## Inputs

| Input               | Default   | Description                                                                                                                                                                                                               |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`           | `lint`    | `lint` (verify references + integrity + coverage), `compile` (specs → markdown), or `eval-check` (verify committed eval locks vs current inputs — the staleness gate, no model).                                          |
| `paths`             | _(auto)_  | Comma/space-separated paths — `.md` for `lint`, `.spec.ts` for `compile`. Auto-discovers.                                                                                                                                 |
| `version`           | _(repo)_  | npm version of `vigiles` to run (`34`, `34.1.2`, `latest`). Empty (the default) runs the version **your `package.json` declares** — see [Versioning](#versioning). `local` runs a checked-out build.                      |
| `max-rules`         | _(unset)_ | Cap rules per spec (maps to `--max-rules`).                                                                                                                                                                               |
| `catalog-only`      | `false`   | Only check that linter rules exist; skip config-enabled checks (maps to `--catalog-only`).                                                                                                                                |
| `working-directory` | `.`       | Directory to run vigiles in.                                                                                                                                                                                              |
| `comment`           | `true`    | On `pull_request` events, post/update a sticky PR comment with the result.                                                                                                                                                |
| `capability-diff`   | `false`   | On `pull_request` events, diff the agent's capability surface (subagents' tool/effect blast radius) vs the PR base and fold it into the sticky comment (maps to `--capability-diff`). Needs `fetch-depth: 0` on checkout. |
| `fail-on-widen`     | `false`   | With `capability-diff`, fail the run when the PR **widens** the blast radius (maps to `--fail-on-widen`).                                                                                                                 |
| `github-token`      | _(auto)_  | Token for the PR comment. Defaults to the workflow token (`${{ github.token }}`).                                                                                                                                         |

### Why there is no `command: test`

`test` and `eval` are missing from that list deliberately, and the omission is worth stating
because the input is a **pass-through** — nothing validates it, so `command: test` becomes
`vigiles test` and then fails in a way that looks like a vigiles bug.

It fails because the Action runs `npx vigiles@<version> <cmd>` in your working directory and
**never runs `npm ci`**. Harness files import the library:

```js
import { runHarnessTest, skip } from "vigiles";
```

That import needs repo-local `node_modules`, which the Action does not install. `vigiles init`
knows this: the workflow it generates wires the Action for the jobs that can use it and writes
a plain `npx vigiles test` job — with its own `npm ci` — for the harness tier.

So the split is not an oversight to route around:

| tier                            | how it runs in CI          | why                                              |
| ------------------------------- | -------------------------- | ------------------------------------------------ |
| `lint`, `compile`, `eval-check` | the Action                 | reads files, needs no repo dependencies          |
| `test`, `eval`                  | a normal job with `npm ci` | executes your harness, which imports the library |

**Pin `version:` in any job you hand-write.** The `latest` default deliberately ignores your
`package-lock.json`, so CI can lint with one major while your harnesses run against another —
a split measured in a real consumer on 2026-08-18 (`npm ls vigiles` → `15.2.1 invalid:
"^16.1.0"`), which is what led a new harness to import a subpath v16 had removed.

## Output channels

Beyond the `valid` step output, the Action reports **three** ways:

1. **Inline annotations** — failures appear on the diff (`::error`).
2. **Job summary** — a markdown result block on the run page (`$GITHUB_STEP_SUMMARY`).
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
