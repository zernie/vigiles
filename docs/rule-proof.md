# Does a linter rule actually fire? — `experimental_ruleProof`

> ⚠️ **Experimental.** The shape can change without a major version. See
> [`experimental.md`](experimental.md).

`enforce()` checks that a rule **exists** and is **enabled** in your config
([`linter-support.md`](linter-support.md)). That still leaves a question open:
does this configuration of the rule **flag** code that breaks it, and leave alone
code that keeps it? A rule can be on and still catch nothing. Its options may
allow the case you care about, its `files` may miss the directory, or the config
may fail to load and print nothing.

`experimental_ruleProof` answers that question by running the linter. It is for
studies that compare several configurations of one rule on real repositories,
and for anyone who wants proof that a config fires rather than a reading of it.
It supports ESLint and Ruff.

## Why: what goes wrong without it

Hand-written versions of this check failed in repeatable ways:

- **The install was the weak point.** Some failures were dependencies hosted on
  git (403), installs over 600 s, and a yarn cache that filled the disk.
- **A config that did not load printed nothing,** and was scored as "no
  diagnostic".
- **The planted test was run at the newest linter, and the repository at its
  pinned one.** Ruff 0.16 widened the default rule set from 59 rules to 413, so
  the version decides the answer.
- **A file that did not parse was counted as clean.**

Each of these is a type in the API below, not a note to remember.

## The three steps

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
    // run.kind === "ran": run.flagged, run.parseErrors, run.ignored, run.linted
  }
}
```

| step      | takes                                            | returns                                                                                |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `install` | a linter, a repository directory, a cache dir    | `installed` with a `PinnedLinter`, or `not-installed` with its stage                   |
| `prove`   | that `PinnedLinter`, one reading, a planted pair | `proved` with a `ProvedReading`, `not-proved` with both hit counts, or `not-run`       |
| `flagged` | a `ProvedReading` — nothing else                 | `ran`: flagged files, files that did not parse, files the linter ignored; or `not-run` |

## What the types rule out

| mistake                                                             | why it cannot be written                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| running a config over the repository before it passed its pair      | `flagged` accepts only a `ProvedReading`, and only a `proved` result has one                               |
| checking only the violating file                                    | the pair is one `{ bad, good }` value; both are required                                                   |
| proving at one linter version and running the repository at another | the `ProvedReading` carries the `PinnedLinter` it was proved on, and only `install` makes a `PinnedLinter` |
| treating "the config did not load" as "flags nothing"               | `not-run` is a separate case, with a stage: `config-load`, `timeout`, `parse`, `pair-ignored`, …           |
| counting an unparsable file as clean                                | every file lands in one of three lists: flagged or clean, parse error, ignored                             |

## Install

- **ESLint.** The install tool comes from the lockfile (npm, pnpm, yarn, bun).
  When there are two lockfiles, `packageManager` picks one, and it also pins the
  tool's version (run through corepack). Install scripts are off. The plugins
  come from the repository's own lockfile. Without a lockfile, nothing is
  installed: the version would not be the repository's.
- **Ruff.** The version is read from `uv.lock`, `poetry.lock` or `pdm.lock`, then
  from `ruff==` in a requirements file or `pyproject.toml`, then from the
  pre-commit hook's `rev`. It runs as `uvx ruff@<version>`. A ranged requirement
  is not a pin, and an unpinned repository is `not-installed: no-pin`.
- HOME and every package-manager cache live under `cacheDir`.
- Yarn Berry installs with `YARN_NODE_LINKER=node-modules`. Plug'n'Play leaves no
  `node_modules`, and the lockfile, not the linker, pins the versions.

## Safety

The install runs no scripts. Linting, however, loads plugin code from the
repository you point it at. So this runs only when you call it: `vigiles audit`
and `vigiles lint` never reach it. Run it on a throwaway machine, such as a CI
runner, when the repository is not yours.

## Readings and scope

- **ESLint reading:** `{ linter: "eslint", rule, options, parser?, scope }`.
  - `rule` is ESLint's id. The plugin package is derived from the id by ESLint's
    naming convention (`react/x` → `eslint-plugin-react`).
  - `parser` names a parser package the repository has installed, for example
    `@typescript-eslint/parser`.
- **Ruff reading:** `{ linter: "ruff", rule, settings, scope }`. `settings` are
  written verbatim to the TOML file Ruff reads, so use the pinned version's own
  keys. A relative `extend` resolves against the repository. Ruff always runs
  with `--no-force-exclude` and `--no-fix`: a reading's own settings must not
  hide the twin from the report or rewrite the planted violation away.
- **Scope:** `{ files, ignores }`, patterns relative to the repository root.
  - Both planted files must be inside the scope, and must not already exist in
    the repository.
  - They are removed afterwards.
  - The scratch config file (`.vigiles-rule-proof.config.mjs` or
    `.vigiles-rule-proof.ruff.toml`) is written in the repository root and removed
    afterwards. If a file already sits at that path, the result is
    `not-run: scratch-path-taken` and the file is left alone.
  - The `ignores` are given to ESLint as global ignores. Inside the rule's own
    block, an ignored file would still be linted with no rule on, and would read
    as clean.
