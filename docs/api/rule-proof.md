# `vigiles/rule-proof`

Prove that a linter configuration actually **fires**, then list the repository
files it flags. Supports ESLint and Ruff.

**For:** people who compare configurations of one rule across real repositories,
or who want proof that a rule catches what they think it catches, rather than a
reading of the config. It is explicit and runs on demand; `vigiles audit` and
`vigiles lint` never reach it.

It installs another repository's linter and plugins. Install scripts are off, but
linting loads plugin code, so run it on a throwaway machine such as a CI runner.
The entry is beta and its reading shape may change.

The guide, with the reasoning and the install rules per linter, is
[Does a linter rule actually fire?](../rule-proof.md). This entry is not part of
the generated API reference; its signatures are in `api-surface/vigiles-rule-proof.api.md`
in the repository.

## Typical tasks

### Prove a rule fires on a planted pair

Three steps, each taking only what the one before returned: `install`, `prove`,
`flagged`.

```ts
import { experimental_ruleProof } from "vigiles/rule-proof";

const installed = experimental_ruleProof.install("eslint", "/work/repo", {
  cacheDir: "/work/cache",
});
if (installed.kind === "installed") {
  const proof = experimental_ruleProof.prove(
    installed.linter,
    {
      linter: "eslint",
      rule: "no-console",
      options: [{ allow: ["warn"] }],
      scope: { files: ["src/**/*.js"], ignores: ["src/vendor/**"] },
    },
    {
      bad: { path: "src/__proof__/bad.js", text: "console.log(1);\n" },
      good: { path: "src/__proof__/good.js", text: "console.warn(1);\n" },
    },
  );
  if (proof.kind === "proved") {
    const run = experimental_ruleProof.flagged(proof.reading);
    if (run.kind === "ran")
      console.log(run.flagged, run.parseErrors, run.ignored);
  }
}
```

### Handle every way a step can fail

Each step returns a tagged result. `install` gives `installed` or `not-installed`
(`NotInstalled`); `prove` gives `proved`, `not-proved` or `not-run` (`NotRun`,
with a `NotRunStage` such as `config-load` or `timeout`); `flagged` gives `ran` or
`not-run`. A config that did not load is never reported as "flags nothing".

### Prove a Ruff rule

A Ruff reading takes `settings` instead of `options`; they are written verbatim to
the TOML file Ruff reads. See [the guide](../rule-proof.md#readings-and-scope).

## Exports

- `experimental_ruleProof`: the object with the three steps `install`, `prove` and `flagged`.

### Readings

- `EslintReading`: an ESLint rule, its options, optional parser and scope.
- `RuffReading`: a Ruff rule, its settings and scope.
- `BaseReading`: the fields every reading shares.
- `ReadingScope`: the `files` and `ignores` patterns, relative to the repository root.
- `KitSet`: the map from a reading type to the kit that runs it; it types the set `experimental_ruleProof` is built from.

### Install

- `InstallOptions`: options of `install`: a required `cacheDir`, and optional `installTimeoutMs` and `lintTimeoutMs`.
- `Installed`: a successful install, carrying the `PinnedLinter`.
- `PinnedLinter`: a linter at the version the repository pins; only `install` makes one.
- `NotInstalled`: why an install did not happen: a `reason` and a stage (`no-lockfile`, `no-pin`, `install`, `timeout` or `no-linter`).

### Prove and flag

- `PlantedFile`: one planted file, a `path` and its `text`.
- `PlantedPair`: the `bad` and `good` planted files, both required.
- `Proof`: the result of `prove`: `proved`, `not-proved` (with `badHits` and `goodHits`) or `not-run`.
- `ProvedReading`: a reading that passed its pair, carrying the `PinnedLinter` it was proved on.
- `Flagged`: the data of a successful run: `flagged` files, files that did not parse (`parseErrors`), files the linter `ignored`, and how many it `linted`.
- `FlaggedRun`: the result of `flagged`: `ran` (with the `Flagged` data) or `not-run`.
- `NotRun`: a step that could not run, with a `NotRunStage`.
- `NotRunStage`: where it stopped: `pair-outside-scope`, `pair-path-taken`, `scratch-path-taken`, `pair-ignored`, `parse`, `config-load` or `timeout`.
