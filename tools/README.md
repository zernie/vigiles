# `tools/` — human-run maintenance scripts (never in CI)

Occasional scripts a **maintainer runs by hand** — network I/O (cloning repos),
breadth sweeps, asset generation. They are NOT part of the shipped library: not
`src/`, not compiled to `dist/`, not tested, never run in CI. Run them from the
repo root. (The BUILD pipeline — `api-extractor.mjs`, `build-report.mjs` — lives in
`scripts/`, not here; `tools/` is only the human-run stuff.)

## Live — dogfood-corpus maintenance

- **`refresh-vendor.sh`** — re-fetch + re-pin the SHA-pinned vendored plugin
  snapshots under `test/dogfood/`. **Run when:** bumping a vendored plugin to a
  newer upstream commit. See `research/dogfood-corpus.md`.
- **`dogfood-sweep.sh`** — run `vigiles audit` across a pinned list of real OSS
  Claude Code plugins and tally what the detectors find. **Run when:** before a
  release or after a detector change, to prove no false-positive regression on
  real plugins (breadth, vs the few SHA-pinned slices asserted in tests).

## Live — harness ground truth

- **`measure-hook-matcher-semantics.mjs`** — measure how the harness ACTUALLY
  matches a hook `matcher` (literal equality vs unanchored regex; which MCP
  patterns fire on which server naming), by running the real `claude` CLI against
  the scripted mock model with one hook per row and a marker file as the oracle.
  No API key, no cost. **Run when:** a new Claude Code version lands, or before
  changing `src/core/hook-matcher.ts` — that detector encodes this table, and
  issue #131 is what happens when it is assumed instead of measured. Usage:
  `node tools/measure-hook-matcher-semantics.mjs [--suite=builtin|mcp] [--server=<name>]`.

- **`measure-hook-startup.mjs`** — price what a compiled hook costs to START:
  layer by layer (one `require` per module, against a bare-Node baseline) and
  end-to-end per hook ROLE (`hook-runtime run-program` over a real hook, event on
  stdin). **Run when:** you are about to add an import anywhere on the hook
  runtime's path (`src/cli.ts`, `src/hook-runtime.ts`, `src/core/hook-program.ts`,
  `src/core/bash-effects.ts`), or after a Node upgrade. A hook runs on EVERY
  matching tool call, so this cost is per tool call — issue #216 is what happens
  when it is not measured. The deterministic half is a test
  (`src/hook-runtime-graph.test.ts` asserts the module GRAPH, which cannot be
  flaky); this script owns the NUMBERS, which are machine-specific and must be
  re-measured rather than quoted. Usage: `node tools/measure-hook-startup.mjs
[--runs=N]` after `npm run build`.

## Occasional — pre-launch

- **`smoke-published.sh`** — run the PUBLISHED package from the registry against a
  throwaway Python repo (pyproject.toml + ruff, **no package.json**) and assert the
  OUTPUT of `audit` / `lint` / `init` / `compile`, not just their exit codes. **Run
  when:** before announcing a release, on the exact version you are about to point
  people at. Every gate in `ci.yml` runs the CLI out of `dist/` (`version: local`),
  so the suite can be green while the artifact users download is broken — a file
  missing from `files[]`, a subpath not exported, a resolve hook that only works
  when vigiles is a local dependency. Usage: `bash tools/smoke-published.sh [version]`
  (default `latest`); exits 77 and says so when `ruff` is absent, since the linter
  check is the point. Measured 2026-09-07 against `vigiles@latest`: it FAILED,
  naming both live launch blockers — `lint` printing "No linters detected" on a
  configured ruff repo, and `compile` exiting 1 with a raw Node module-resolution
  stack.

- **`fp-sweep.sh`** — launch-readiness "don't cry wolf" sweep: clone popular
  plugins/marketplaces, run `vigiles audit`, surface any high-precision rule flag
  as a false-positive candidate to triage. **Run when:** pre-launch FP triage.

## Demo assets — for the UNBUILT "polished demo" (roadmap)

- **`demo.sh`** — record an asciinema cast of `vigiles lint` catching stale
  references (`asciinema rec --command "bash tools/demo.sh" vigiles.cast`).
- **`make-demo-gif.py`** — generate an animated terminal GIF (Pillow).

  > ⚠️ **Status:** both feed the roadmap item "Build the ONE polished front-door
  > demo," which is **not built yet**. The old `vigiles-demo.gif` was removed as
  > unreferenced, so their output is currently unused. Kept as the tooling for
  > that item — delete if the demo direction is dropped.

## Not skills — on purpose

A `tools/` script is deterministic automation; a skill is a model **procedure with
judgment**, so these are not skills. The two _with_ real judgment on their output
(`fp-sweep` triage, `dogfood-sweep` regression summary) are a roadmap candidate to
wrap as `.claude/skills/` contributor skills at launch — the skill would _invoke_
the script and reason about the result. `refresh-vendor` / `demo.sh` /
`make-demo-gif.py` stay plain scripts (mechanical or interactive, no judgment).
