# Freshness Detection

vigiles detects when compiled instruction files are out of date. The `freshness` validation rule catches drift between your specs and the compiled markdown.

## Configuration

In `.vigilesrc.json`:

```json
{
  "rules": {
    "freshness": "error"
  },
  "freshnessMode": "strict"
}
```

### Severity

| Value              | Behavior                                  |
| ------------------ | ----------------------------------------- |
| `"error"`          | `vigiles audit` exits non-zero (CI fails) |
| `"warn"` (default) | Prints warning, exits 0                   |
| `false`            | Skip freshness checks entirely            |

### Mode

| Mode                 | What it checks                                                 | Cost          | False positives                         | False negatives               |
| -------------------- | -------------------------------------------------------------- | ------------- | --------------------------------------- | ----------------------------- |
| `"strict"` (default) | Recompiles in memory, diffs against existing output            | 2-5s per spec | Zero                                    | Zero                          |
| `"input-hash"`       | Compares stored input fingerprint against current file state   | <100ms        | Possible (whitespace changes in config) | Possible (transitive deps)    |
| `"output-hash"`      | Only checks if the `.md` was hand-edited (existing hash check) | <1ms          | Zero                                    | Many (misses all input drift) |

**Strict mode** is the correct default. It catches every kind of staleness with zero false positives. The cost is running a full recompile in memory on every `vigiles audit`.

**Input-hash mode** is faster. Use it when compilation is slow (many specs, heavy linter config loading). It tracks a fingerprint of all input files (spec source, linter configs, lock files, keyFiles, generated types). When any input changes, audit flags the output as stale. To use it, set `freshnessMode: "input-hash"` — `vigiles compile` will embed the input fingerprint in the compiled markdown.

**Output-hash mode** is the minimal option. It only detects hand-edits to the compiled markdown (the pre-existing hash check). It won't catch disabled linter rules, deleted files, or spec changes.

## What Counts as an Input

In input-hash mode, vigiles tracks these files:

| Category         | Files                                                                                                                                                                                                                                    | Why                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Spec source      | `CLAUDE.md.spec.ts`                                                                                                                                                                                                                      | Any spec change should force recompile                 |
| Linter configs   | `eslint.config.*`, `.eslintrc.*`, `pyproject.toml`, `ruff.toml`, `Cargo.toml`, `clippy.toml`, `.pylintrc`, `.rubocop.yml`, `.stylelintrc.*`, `setup.cfg`                                                                                 | Disabling a rule makes `enforce()` claims stale        |
| Package manifest | `package.json`                                                                                                                                                                                                                           | Scripts (`cmd()` refs) and deps (linter plugins)       |
| Lock files       | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Cargo.lock`, `go.sum`, `composer.lock`, `packages.lock.json`, `Package.resolved`, `mix.lock`, `requirements.txt` | Dependency version changes can add/remove linter rules |
| Referenced files | Every `file()` path in `keyFiles`                                                                                                                                                                                                        | Deletion or rename makes the reference stale           |
| Generated types  | `.vigiles/generated.d.ts`                                                                                                                                                                                                                | If types are stale, rule references may be invalid     |
| Extra inputs     | Configured via `freshnessInputs`                                                                                                                                                                                                         | For non-standard files (e.g., monorepo root lock file) |

All files are auto-detected by checking existence at `basePath`. Lock files and linter configs cover 6+ ecosystems (Node.js, Ruby, Python, Rust, Go, PHP, .NET, Swift, Elixir).

## Extra Inputs

For monorepos or non-standard layouts, add extra files to track:

```json
{
  "freshnessMode": "input-hash",
  "freshnessInputs": ["../../yarn.lock", "shared/eslint-config/index.js"]
}
```

## How the Input Hash Works

At compile time (`vigiles compile`), when `freshnessMode` is `"input-hash"`:

1. Discover all input files (spec, configs, lock files, keyFiles, etc.)
2. Compute SHA-256 of each file's contents (missing files hash to `MISSING:<path>`)
3. Combine all file hashes into a single fingerprint (SHA-256 of sorted hashes)
4. Embed the fingerprint in the compiled markdown:

```html
<!-- vigiles:sha256:a1b2c3d4e5f6g7h8 compiled from CLAUDE.md.spec.ts -->
<!-- vigiles:inputs:f9e8d7c6b5a49382 -->

# CLAUDE.md ...
```

At audit time (`vigiles audit`):

1. Extract the stored input fingerprint
2. Recompute the fingerprint from current file state
3. If they differ → stale

## Audit Output

```
Freshness check:

  ✓ CLAUDE.md — fresh (strict)
  ✗ AGENTS.md — Output would differ if recompiled — run `vigiles compile`
```

With `--summary`:

```
vigiles: 1 stale (run vigiles compile)
```

## Lock File Detection

vigiles auto-detects lock files for every major ecosystem. No configuration needed — if the file exists, it's tracked.

| Lock file            | Ecosystem       |
| -------------------- | --------------- |
| `package-lock.json`  | Node.js (npm)   |
| `yarn.lock`          | Node.js (Yarn)  |
| `pnpm-lock.yaml`     | Node.js (pnpm)  |
| `bun.lockb`          | Node.js (Bun)   |
| `Gemfile.lock`       | Ruby (Bundler)  |
| `poetry.lock`        | Python (Poetry) |
| `uv.lock`            | Python (uv)     |
| `pdm.lock`           | Python (PDM)    |
| `requirements.txt`   | Python (pip)    |
| `Cargo.lock`         | Rust (Cargo)    |
| `go.sum`             | Go              |
| `composer.lock`      | PHP (Composer)  |
| `packages.lock.json` | .NET (NuGet)    |
| `Package.resolved`   | Swift (SPM)     |
| `mix.lock`           | Elixir (Mix)    |
