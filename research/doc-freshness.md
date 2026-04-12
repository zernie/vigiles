# Doc Freshness: Input Fingerprinting for Stale Spec Detection

## The Gap

vigiles hashes the **compiled output** (the `.md` file). This catches manual edits to the markdown. It does NOT catch when the **inputs** that produced that markdown have changed.

After `vigiles compile` runs successfully:

| What changes                         | Detected today?         | Consequence                                   |
| ------------------------------------ | ----------------------- | --------------------------------------------- |
| Someone edits CLAUDE.md by hand      | Yes (hash mismatch)     | `vigiles audit` catches it                    |
| Linter rule gets disabled in config  | No                      | Spec claims `enforce()`, rule is actually off |
| Referenced file deleted              | No (until next compile) | Markdown contains stale `file()` path         |
| npm script removed from package.json | No (until next compile) | Markdown references dead command              |
| Spec file edited, nobody recompiles  | No                      | Markdown and spec diverge                     |
| ESLint plugin uninstalled            | No (until next compile) | Markdown references non-existent rules        |
| `.vigiles/generated.d.ts` stale      | Yes (`--check` mode)    | Types don't match reality                     |

The hash answers: "Was the output tampered with?" It doesn't answer: "Is the output still valid given what's true about the project right now?"

## Prior Art

### Make / CMake — mtime comparison

Track file modification times. If source is newer than target, rebuild.

- Pro: simple, zero overhead
- Con: mtime is unreliable (git clone resets it, clock skew in CI, `touch` defeats it)
- Con: doesn't detect content changes on same-second edits
- **Verdict:** Not suitable. vigiles needs content-based detection, not time-based.

### Bazel / Buck — input fingerprinting

Hash **all inputs** to a build action into a single key. Cache the output by that key. If any input changes, the key changes, the cache misses, and the action re-runs.

- Pro: precise — catches any input variation
- Pro: deterministic — same inputs always produce same output
- Pro: cacheable — skip redundant work
- Con: requires strict input isolation (must enumerate every file that affects the output)
- **Verdict:** The right model. vigiles can enumerate its inputs: spec file, linter configs, package.json, referenced files.

### Nix — derivation input hashing

Every build step declares its inputs. The derivation hash changes if any input hash changes. The output path is derived from the input hash, so stale outputs are impossible — they live at a different path.

- Pro: hermetic — output is always fresh by construction
- Con: overkill for vigiles (we're not building packages, just compiling markdown)
- **Verdict:** The principle is right (hash inputs, not outputs). The mechanism is too heavy.

### Terraform — drift detection

`terraform plan` compares desired state (config) against actual state (cloud resources). Any delta is flagged as drift.

- Pro: detects both directions of drift (config changed, resource changed)
- Pro: shows a diff, not just "stale"
- **Verdict:** Good analogy. vigiles should compare "what the spec claims" against "what the project actually has."

### Git tree hashes

Git hashes directory trees content-addressably. Changing one file changes the tree hash all the way up. `git diff --stat` shows exactly what changed.

- Pro: always available, zero setup
- Pro: can pin a specific commit as "known good"
- Con: requires git repo
- Con: only tracks committed state (uncommitted changes invisible)
- **Verdict:** Useful as one signal. Can record "compiled at git tree hash X" and check if the relevant files changed since.

### TypeScript `tsBuildInfo` — incremental compilation

Stores per-file hashes and dependency graph. On next compile, skips files whose hash (and all transitive dependency hashes) haven't changed.

- Pro: fast incremental builds
- Con: complex dependency graph maintenance
- **Verdict:** vigiles has a simpler dependency model (spec → {linter configs, files, package.json}). Full DAG is unnecessary.

## Design

### Input manifest

At compile time, record every input that affected the output. Store alongside the output hash.

```
<!-- vigiles:sha256:a1b2c3d4e5f6g7h8 compiled from CLAUDE.md.spec.ts -->
<!-- vigiles:inputs:sha256:f9e8d7c6b5a49382 -->
```

The input hash is a SHA-256 of the **sorted, concatenated hashes** of all input files:

```
inputs = sort([
  sha256(readFile("CLAUDE.md.spec.ts")),       # the spec source
  sha256(readFile("eslint.config.mjs")),        # linter config
  sha256(readFile("package.json")),             # scripts + deps
  sha256(readFile("tsconfig.json")),            # if referenced
  sha256(readFile("src/compile.ts")),           # each file() reference
  sha256(readFile("src/linters.ts")),           # each file() reference
  ...                                           # all keyFiles entries
])
inputHash = sha256(inputs.join("\n"))
```

### What counts as an input

| Input category   | Files                                                                                                                                          | Why                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Spec source      | `CLAUDE.md.spec.ts`                                                                                                                            | Any change to the spec should force recompile          |
| Linter configs   | `eslint.config.*`, `.eslintrc.*`, `pyproject.toml` `[tool.ruff]`, `Cargo.toml` `[lints.clippy]`, `.pylintrc`, `.rubocop.yml`, `.stylelintrc.*` | Disabling a rule makes `enforce()` claims stale        |
| Package manifest | `package.json`                                                                                                                                 | Scripts (`cmd()` references) and deps (linter plugins) |
| Referenced files | Every `file()` call in the spec                                                                                                                | Deletion or rename makes the reference stale           |
| Generated types  | `.vigiles/generated.d.ts`                                                                                                                      | If types are stale, rule references may be invalid     |

### What does NOT count as an input

- Source code files that aren't in `keyFiles` — vigiles doesn't lint code, it lints specs
- `node_modules/` — too large, too volatile; linter config is the proxy
- `.git/` — internal state, not a build input
- Other specs — each spec is compiled independently

### Audit behavior

`vigiles audit` gains a new check:

1. Read the compiled `.md` file
2. Extract the output hash (existing) and input hash (new)
3. Recompute the input hash from current file state
4. If input hash mismatches: **"Inputs changed since last compile — run `vigiles compile`"**

This is separate from the output hash check:

| Output hash | Input hash | Meaning                                            |
| ----------- | ---------- | -------------------------------------------------- |
| Valid       | Valid      | Everything fresh                                   |
| Invalid     | Valid      | Someone hand-edited the markdown                   |
| Valid       | Invalid    | Inputs changed, output is stale — recompile needed |
| Invalid     | Invalid    | Both changed — recompile needed                    |

### Discovery: which linter configs exist

vigiles already detects linters in `src/linters.ts` and `src/generate-types.ts`. The input manifest reuses this:

```typescript
function discoverInputFiles(spec: ClaudeSpec, basePath: string): string[] {
  const inputs: string[] = [];

  // 1. Spec source
  inputs.push(spec._sourceFile);

  // 2. Linter configs — check existence of known config files
  const linterConfigs = [
    "eslint.config.mjs",
    "eslint.config.js",
    "eslint.config.ts",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.yml",
    "pyproject.toml",
    "ruff.toml",
    "Cargo.toml",
    ".pylintrc",
    ".rubocop.yml",
    ".stylelintrc.json",
    ".stylelintrc.js",
    ".stylelintrc.yml",
  ];
  for (const cfg of linterConfigs) {
    if (existsSync(resolve(basePath, cfg))) inputs.push(cfg);
  }

  // 3. Package manifest
  inputs.push("package.json");

  // 4. Referenced files from keyFiles
  for (const filePath of Object.keys(spec.keyFiles ?? {})) {
    inputs.push(filePath);
  }

  // 5. Generated types
  if (existsSync(resolve(basePath, ".vigiles/generated.d.ts"))) {
    inputs.push(".vigiles/generated.d.ts");
  }

  return inputs.sort();
}
```

### Hash computation

```typescript
function computeInputHash(inputs: string[], basePath: string): string {
  const fileHashes = inputs.map((f) => {
    const fullPath = resolve(basePath, f);
    if (!existsSync(fullPath)) return `MISSING:${f}`;
    const content = readFileSync(fullPath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  });
  return createHash("sha256")
    .update(fileHashes.join("\n"))
    .digest("hex")
    .slice(0, 16);
}
```

Missing files hash to `MISSING:<path>` so that file deletion changes the input hash (correctly signaling staleness).

### Storage format

Two options:

**Option A: Second HTML comment** (minimal change)

```html
<!-- vigiles:sha256:a1b2c3d4e5f6g7h8 compiled from CLAUDE.md.spec.ts -->
<!-- vigiles:inputs:f9e8d7c6b5a4 -->
```

Pro: backward-compatible (old vigiles ignores the new comment). Con: two comments at the top.

**Option B: Extend existing comment**

```html
<!-- vigiles:sha256:a1b2c3d4e5f6g7h8 inputs:f9e8d7c6b5a4 compiled from CLAUDE.md.spec.ts -->
```

Pro: single comment. Con: breaks existing regex; requires migration.

**Recommendation:** Option A. Backward-compatible, no migration needed.

### Git-based enhancement (optional)

In addition to content hashing, record the git tree hash of tracked input files at compile time:

```html
<!-- vigiles:git:abc1234 -->
```

On audit, compare:

```bash
git diff --name-only abc1234 -- eslint.config.mjs package.json src/compile.ts ...
```

If any listed file changed in git since that commit, flag as stale.

Pros:

- Catches committed changes (CI scenario)
- Can show exactly which files changed
- Very fast (git does the diffing)

Cons:

- Doesn't catch uncommitted changes
- Requires git repo
- Commit hash may not exist on shallow clones

**Recommendation:** Content hash is the primary mechanism. Git hash is an optional fast-path optimization for CI.

## Edge Cases

### File deleted after compile

`MISSING:src/utils.ts` in the input hash computation ensures the hash changes when a referenced file is deleted. Audit correctly flags staleness.

### Linter config changes but rules stay the same

Example: reformatting `eslint.config.mjs` (whitespace change, no semantic change). The input hash changes, audit says "recompile needed", but `vigiles compile` produces identical output. This is a false positive.

**Mitigation:** Could hash the "effective config" (linter rule set) instead of the raw config file. But this requires running `calculateConfigForFile` on every audit, which is slow. The false positive is cheap (just re-run compile), so raw file hashing is acceptable.

### Monorepo with shared configs

A root `.eslintrc.json` is inherited by all packages. Changing the root config should invalidate all specs that use ESLint. The input discovery already handles this — it checks for config files at `basePath`, which is the spec's directory.

**Gap:** If the root config is at `../../.eslintrc.json` via ESLint's config cascade, we won't discover it. Fix: resolve the actual ESLint config file location using ESLint's API, not just checking known filenames.

### Large `package.json`

In monorepos, `package.json` can be large. Hashing the full file means any dependency change (even unrelated) triggers a stale signal.

**Mitigation:** Hash only the `scripts` and `devDependencies` sections (the parts vigiles cares about). This is a minor optimization; the false positive cost is low.

## Implementation Plan

### The simpler alternative: `compile --check`

Before building input fingerprinting, consider: if compilation is cheap (2-5 seconds), the simplest freshness check is to just recompile in memory and diff:

```bash
vigiles compile --check   # recompile in memory, compare to existing output
```

No manifest, no input tracking, no false positives from whitespace reformatting. If the output would differ, it's stale. If identical, it's fresh. This is exactly what `generate-types --check` already does.

Input fingerprinting only wins when compilation is expensive enough that you want to **avoid** running it. For vigiles today, it isn't.

### Recommended: configurable freshness rule

Make freshness checking a configurable rule in `vigiles.json` (or `package.json` under `"vigiles"`), defaulting to strict:

```json
{
  "rules": {
    "freshness": "strict"
  }
}
```

| Mode                 | What `vigiles audit` does                                                                  | Cost                     | False positives                                    |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------- |
| `"strict"` (default) | Recompiles in memory, diffs output. Fails if compiled markdown would change.               | 2-5s (runs full compile) | Zero — it checks the actual output                 |
| `"input-hash"`       | Checks input fingerprint only. Fails if any tracked input file changed since last compile. | <100ms (hash comparison) | Possible — whitespace changes in config trigger it |
| `"output-hash"`      | Current behavior. Only checks if the `.md` was hand-edited.                                | <1ms (single hash)       | Zero — but misses input drift entirely             |
| `false`              | Skip freshness checks.                                                                     | 0                        | N/A                                                |

**Strict mode is correct by default.** It's the only mode with zero false positives AND zero false negatives. The cost is re-running compilation, which takes the same time as `vigiles compile`.

**Input-hash mode is the fast-path optimization.** Projects where compilation is slow (many specs, large linter configs, slow ESLint plugin loading) can opt into input fingerprinting to skip the full recompile. They accept occasional false positives (config reformatting, irrelevant package.json changes) in exchange for faster CI.

**Output-hash mode is the minimal fallback.** For projects that just want "don't hand-edit the markdown" enforcement.

### Phase 1: `compile --check` (strict mode)

1. `compile.ts` — add `--check` / `dryRun` flag that compiles in memory, compares to existing file
2. `cli.ts` (`audit`) — when `freshness: "strict"` (default), run compile in check mode
3. Error message: `"CLAUDE.md is stale — run vigiles compile"`
4. Fast path: skip if output hash hasn't changed (same as today, but then also run full check)

### Phase 2: Input fingerprinting (opt-in)

1. `compile.ts` — compute input hash after compilation, embed as second HTML comment
2. `cli.ts` (`audit`) — when `freshness: "input-hash"`, extract and verify input hash
3. Error message: `"Inputs changed since last compile (eslint.config.mjs, package.json) — run vigiles compile"`
4. Show which files changed (diff input list against current state)

### Phase 3: Granular reporting

1. Store the individual file paths + hashes in a sidecar file (`.vigiles/CLAUDE.md.inputs.json`)
2. On audit, report exactly which inputs changed
3. Optionally show the delta: "eslint.config.mjs: rule `no-console` was disabled"

### Phase 4: Git integration (optional)

1. Record git commit hash at compile time
2. On audit, use `git diff` for fast change detection before falling back to content hashing
3. Support shallow clones by falling back to content hash when commit is missing

## TOC Manifests: Recursive Directory Fingerprinting

A complementary approach: require a `TOC.md` (or `INDEX.md`) in each documented directory that lists all files with descriptions. This turns "directory contents" into a tracked, verifiable artifact.

### How it works

```markdown
<!-- docs/TOC.md -->

# docs

- `linter-support.md` — Linter cross-referencing engine (6 linters + generate-types)
- `spec-format.md` — Spec format reference (target, sections, rules)
- `agent-workflows.md` — Agent workflows (Claude Code, Codex, multi-agent, Cursor)
- `agent-setup.md` — Non-interactive agent setup guide
- `inline-mode.md` — Inline mode for gradual adoption
- `eslint.md` — ESLint reference (shared by strengthen + pr-to-lint-rule)
```

### Recursive nesting

If a subdirectory has its own `TOC.md`, the parent TOC references the directory, not its individual files:

```markdown
<!-- skills/TOC.md -->

# skills

- `strengthen/` — Upgrade guidance() → enforce() using linter reference docs
- `pr-to-lint-rule/` — Convert PR review comments into automated lint rules
- `edit-spec/` — Edit a spec file with guided workflow
- `linter-docs/` — Per-linter reference docs (ESLint, RuboCop, Pylint)
  - See `linter-docs/TOC.md` for contents
```

### What this enables

1. **Staleness detection** — `vigiles audit` can diff the TOC against `fs.readdirSync`. File added without TOC entry? File deleted but still in TOC? Both are errors.
2. **Agent discoverability** — Agents reading CLAUDE.md can follow TOC.md to find relevant docs without scanning the filesystem. It's a curated index, not `ls`.
3. **Compilation** — vigiles can compile TOC.md from a TOC.md.spec.ts, getting the same hash-based freshness guarantees as CLAUDE.md.
4. **Nested verification** — audit walks the TOC tree recursively. Each level is self-contained.

### Prior art

| Tool                      | Mechanism             | Notes                                                                                                                                             |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust `mod.rs` / `lib.rs`  | Module declarations   | Every `.rs` file must be declared in its parent module. Undeclared files are dead code. Same principle — directory manifest enforced by compiler. |
| Python `__init__.py`      | Package marker        | Historically required for Python packages. Declares what's importable. Not a full manifest but marks directory as "this is intentional."          |
| Cargo `[lib]` / `[[bin]]` | Explicit targets      | Cargo.toml must list all crate entry points. Adding a file without updating Cargo.toml = nothing happens.                                         |
| Go module / package       | Implicit (convention) | Go uses directory = package, file = source. No manifest — but the convention IS the manifest.                                                     |
| mdBook `SUMMARY.md`       | Book structure        | mdBook requires `SUMMARY.md` listing all chapters in order. Unlisted files are excluded from the build. Closest prior art to TOC.md.              |
| Docusaurus `sidebars.js`  | Sidebar structure     | Lists all docs in navigation order. `autogenerated` mode scans filesystem but explicit mode is a manifest.                                        |
| Sphinx `toctree`          | Document tree         | RST directive listing sub-documents. Missing entries = build warning. Closest to nested TOC approach.                                             |
| CODEOWNERS                | File ownership        | GitHub's `CODEOWNERS` lists file patterns → owners. Not a manifest but a structured file-level declaration.                                       |

**mdBook's `SUMMARY.md` is the closest match.** It's a markdown file that lists all chapters. Unlisted files are excluded. It's the source of truth for book structure.

### Integration with input fingerprinting

The TOC becomes an input to the fingerprint:

```
inputs = sort([
  sha256(readFile("CLAUDE.md.spec.ts")),
  sha256(readFile("docs/TOC.md")),           # NEW: directory manifest
  sha256(readFile("skills/TOC.md")),          # NEW: nested manifest
  sha256(readFile("eslint.config.mjs")),
  ...
])
```

If someone adds a file to `docs/` without updating `docs/TOC.md`:

1. The TOC doesn't change → input hash unchanged → no recompile triggered
2. But `vigiles audit` independently checks TOC completeness → flags the unlisted file
3. Two independent signals: "TOC is incomplete" + "inputs haven't changed since last compile"

### vigiles-specific design

For vigiles, the TOC.md could be:

1. **Hand-written** — just a markdown file that humans/agents maintain. Audit verifies it matches the directory.
2. **Compiled from a spec** — `docs/TOC.md.spec.ts` that uses `file()` references. Then the compiler verifies every listed file exists, and audit verifies no unlisted files snuck in.
3. **Auto-generated** — `vigiles generate-toc docs/` scans the directory and emits a TOC. Then it's a build artifact like CLAUDE.md, with the same hash-based freshness.

Option 3 (auto-generated) is cleanest: the filesystem is the source of truth, the TOC is a build artifact, and audit verifies freshness. No manual maintenance.

But option 2 (compiled from spec) is more valuable: descriptions can't be auto-generated (they require understanding), so the spec is the right place for human-written descriptions. The compiler just verifies nothing was missed.

## Open Questions

1. **Should `vigiles compile` auto-verify inputs before compiling?** (i.e., if inputs haven't changed, skip compilation entirely — Bazel-style memoization)
2. **Should the input manifest include the vigiles version?** (A vigiles upgrade might change compilation output even with identical inputs)
3. **Should `vigiles audit --fix` automatically recompile when inputs are stale?** (Convenient but hides drift)
4. **How to handle inline mode?** Inline rules have no spec file — the "spec source" input doesn't exist. Input hash would cover just the markdown file + linter configs.
5. **Should TOC.md be a new compilation target?** (`vigiles init --target=TOC.md` scaffolds a TOC spec for a directory.) Or should it be a separate `vigiles toc` command?
6. **Recursive TOC depth:** Should nested TOCs be mandatory, or should a root TOC be allowed to list all files flat? Mandatory nesting scales better but adds friction for small projects.
