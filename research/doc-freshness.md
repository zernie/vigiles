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

### Recommended: `freshness` validation rule

Add `freshness` to `RulesConfig` alongside `require-spec` and `require-skill-spec`. Global rule in `.vigilesrc.json`, optional per-spec override in the spec itself.

```json
{
  "rules": {
    "require-spec": "warn",
    "freshness": "error"
  },
  "freshnessMode": "strict"
}
```

Severity controls what happens when staleness is detected (`"error"` = CI fails, `"warn"` = prints warning, `false` = skip). Mode controls **how** staleness is detected:

| Mode                 | What `vigiles audit` does                                                                  | Cost                     | False positives                                    | False negatives                 |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------- | ------------------------------- |
| `"strict"` (default) | Recompiles in memory, diffs output. Fails if compiled markdown would change.               | 2-5s (runs full compile) | Zero — it checks the actual output                 | Zero                            |
| `"input-hash"`       | Checks input fingerprint only. Fails if any tracked input file changed since last compile. | <100ms (hash comparison) | Possible — whitespace changes in config trigger it | Possible — transitive deps      |
| `"output-hash"`      | Current behavior. Only checks if the `.md` was hand-edited.                                | <1ms (single hash)       | Zero — but misses input drift entirely             | Many — misses all input changes |

**Strict mode is correct by default.** Zero false positives AND zero false negatives. The cost is re-running compilation, which takes the same time as `vigiles compile`.

**Input-hash mode is the fast-path optimization.** For projects where compilation is slow (many specs, large linter configs, slow ESLint plugin loading). Accepts occasional false positives in exchange for faster CI.

**Output-hash mode is the minimal fallback.** "Don't hand-edit the markdown" enforcement only.

### Per-spec override

A spec can override the global freshness mode:

```typescript
export default claude({
  freshness: "input-hash", // override global "strict" for this slow spec
  rules: { ... },
});
```

### Lock files as inputs

For input-hash mode, the lock file is a better signal than `package.json` for dependency changes. vigiles auto-detects lock files by language:

| Lock file           | Language | What it catches                              |
| ------------------- | -------- | -------------------------------------------- |
| `package-lock.json` | Node.js  | ESLint/Stylelint plugin version changes      |
| `yarn.lock`         | Node.js  | Same as above (Yarn)                         |
| `pnpm-lock.yaml`    | Node.js  | Same as above (pnpm)                         |
| `bun.lockb`         | Node.js  | Same as above (Bun)                          |
| `Gemfile.lock`      | Ruby     | RuboCop gem version changes                  |
| `poetry.lock`       | Python   | Pylint plugin version changes                |
| `uv.lock`           | Python   | Same as above (uv)                           |
| `Cargo.lock`        | Rust     | Clippy version changes (via rustc version)   |
| `requirements.txt`  | Python   | Fallback if no lock file (pip freeze output) |

Detection is simple: check `existsSync` for each. First match wins (projects rarely have competing lock files for the same language). The lock file goes into the input hash alongside linter configs and `package.json`.

Why the lock file and not just `package.json`? Because `package.json` can stay identical while the resolved dependency tree changes (version ranges). A Stylelint plugin upgrade from 15.0.0 to 16.0.0 might add/remove rules — `package.json` says `"^15.0.0"` in both cases, but the lock file changes.

For strict mode this doesn't matter (it recompiles from scratch). For input-hash mode it prevents a class of false negatives where dependencies change but `package.json` doesn't.

If the auto-detection is wrong (e.g., monorepo with lock file at a non-standard location), it can be configured explicitly:

```json
{
  "freshnessInputs": ["../../yarn.lock"]
}
```

### Type changes

```typescript
// src/types.ts

export type FreshnessMode = "strict" | "input-hash" | "output-hash";

export interface RulesConfig {
  "require-spec"?: RuleSeverity;
  "require-skill-spec"?: RuleSeverity;
  freshness?: RuleSeverity; // NEW
}

export interface VigilesConfig {
  ruleMarkers: MarkerType[];
  rules: Required<RulesConfig>;
  files: string[];
  freshnessMode?: FreshnessMode; // NEW — default "strict"
  freshnessInputs?: string[]; // NEW — extra files to include in input hash
}
```

### Default behavior change

Today: `vigiles audit` only checks output hashes (hand-edit detection).
After: `vigiles audit` also recompiles in memory and diffs (freshness: "error", strict mode by default).

This is a **breaking change** for projects where the compiled markdown has drifted from the spec. But that's the point — those projects have stale instructions. The `"warn"` severity softens the migration, and `false` opts out entirely.

### Phase 1: `compile --check` (strict mode)

1. `compile.ts` — add `--check` / `dryRun` flag that compiles in memory, compares to existing file
2. `cli.ts` (`audit`) — when `freshness` rule is enabled and mode is `"strict"`, run compile in check mode
3. Error message: `"CLAUDE.md is stale — run vigiles compile"`

### Phase 2: Input fingerprinting (input-hash mode)

1. `compile.ts` — compute input hash after compilation, embed as second HTML comment
2. Auto-detect lock files + linter configs as inputs
3. `cli.ts` (`audit`) — when mode is `"input-hash"`, extract and verify input hash
4. Error message: `"Inputs changed since last compile (eslint.config.mjs, yarn.lock) — run vigiles compile"`
5. Show which files changed (diff input list against current state)

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

## Competitive Landscape

### Tool survey

| Tool               | Type                  | Deterministic | CLI       | Key mechanism                                                        |
| ------------------ | --------------------- | ------------- | --------- | -------------------------------------------------------------------- |
| Drift (Fiberplane) | Doc-code anchor       | Yes           | Yes       | Tree-sitter AST fingerprinting, symbol-level anchors, git provenance |
| ctxlint (YawLabs)  | Context-file linter   | Yes           | Yes       | Codebase cross-ref, git rename detection, auto-fix                   |
| DOCER              | Academic tool         | Yes           | GH Action | Regex-based code element extraction from docs                        |
| Doc Detective      | Doc testing           | Yes           | Yes       | Executes commands/examples embedded in docs                          |
| ai-contextor       | AI doc freshness      | Yes           | Yes       | Source-to-doc mapping config, mtime-based freshness                  |
| doc-hunt           | Doc tracking          | Yes           | Yes       | Explicit doc-to-source regex mapping with git tracking               |
| agents-lint        | AGENTS.md linter      | Yes           | Yes       | Path/script/package validation, deprecated package detection         |
| agnix              | Agent config linter   | Yes           | Yes       | 385 rules, confidence-tiered auto-fix, SARIF output                  |
| Swimm              | Code-coupled docs     | Partial       | No (SaaS) | Patented histogram-based snippet tracking                            |
| Repowise           | Codebase intelligence | Yes           | Yes       | Confidence scoring with git-informed decay (0.0–1.0)                 |
| code-forensics     | Git analytics         | Yes           | Yes       | Temporal coupling / co-change ratio from commit history              |

### Key insights from competing tools

**Drift** anchors markdown specs to source code using tree-sitter. It hashes a normalized AST fingerprint (node kinds + token text, no whitespace or position data). Reformatting a file won't trigger a false positive. An optional `#Name` suffix narrows the anchor to a specific declaration (function, class, type) — the rest of the file can change freely. An optional `@<git-sha>` suffix records which commit last addressed the anchor.

**ctxlint** cross-references context files against the actual codebase. When a file path is stale, it uses `git log --follow --diff-filter=R` to detect renames and suggests the new path. Auto-fix rewrites broken paths using git history. 91% precision across 8 popular open-source repos.

**DOCER** extracts code element references from documentation using regex (variables, functions, class names found in backtick spans). Compares against the codebase. When merging a PR would create outdated references, it comments on the PR. Analysis of 3,000+ GitHub projects found most contain at least one outdated code element reference.

**doc-hunt** uses explicit doc-to-source regex mappings stored in a `.doc-hunt` tracking file committed to VCS. `doc-hunt check` reports whether tracked sources changed since last `doc-hunt update`. Simple, deterministic, zero dependencies.

**code-forensics / CodeScene** compute temporal coupling: given doc file D and code file C, how often do they co-change in commits? Low co-change ratio = documentation drift risk. This is a well-established metric in software engineering research that has never been applied to AI instruction files.

**Repowise** assigns freshness scores per documentation page (0.0–1.0). Confidence scores decay when source changes — stale pages auto-regenerate. The decay is git-informed: more source commits without a corresponding doc update = lower score.

## Additional Options

Beyond the three modes already designed (strict, input-hash, output-hash), the following options are informed by the competitive landscape and by algorithms used in adjacent fields (build systems, version control, software engineering research).

### Option 4: Per-file sidecar manifest

**Source:** Planned as Phase 3 in this doc. Informed by doc-hunt's tracking file and Bazel's action cache.

Store individual file hashes (not just a combined fingerprint) in `.vigiles/<target>.inputs.json`:

```json
{
  "specFile": "CLAUDE.md.spec.ts",
  "target": "CLAUDE.md",
  "compiledAt": "2025-01-15T10:30:00.000Z",
  "vigilesVersion": "0.5.0",
  "files": {
    "CLAUDE.md.spec.ts": "a1b2c3d4e5f6g7h8",
    "eslint.config.mjs": "e5f6a7b8c9d0e1f2",
    "package.json": "1234abcd5678ef90",
    "src/compile.ts": "fedcba0987654321"
  }
}
```

On audit, compare each file hash individually. Report exactly which files changed:

```
Freshness: CLAUDE.md is stale
  Changed inputs:
    eslint.config.mjs  (content changed)
    src/utils/old.ts   (deleted)
  Unchanged: 14 files
```

This is the foundation for every other option — without per-file tracking, you can only say "something changed" not "what changed."

**Determinism:** Fully deterministic (SHA-256 comparison).
**Scope:** Small — add JSON write at compile time, comparison at audit time.
**Hooks:** Pre-commit hook reads the sidecar, skips recompile if no inputs changed (Bazel-style memoization).

### Option 5: Affected-specs reporter

**Source:** Bazel's target determination, Jest's `--changedSince`, Nx's affected graph.

Given a set of changed files, report which specs need recompilation. This is a **reverse index** of the input discovery: instead of "spec → inputs," query "input → specs."

```bash
# CI: only recompile specs affected by this PR
vigiles affected --base main | xargs vigiles compile

# Pre-commit: check only affected specs
vigiles affected --files $(git diff --cached --name-only) | xargs vigiles compile --check
```

The algorithm reads all sidecar manifests (`.vigiles/*.inputs.json`), builds an inverted index `{file → [specs]}`, and intersects with the changed file list. O(n) in the number of tracked files.

**Determinism:** Fully deterministic (set intersection).
**Scope:** Small — reads existing sidecar manifests, builds reverse map.
**Hooks:** Pre-commit hook runs `vigiles affected --staged` to recompile only what changed. CI runs `vigiles affected --base main` to skip unchanged specs. Transforms O(all specs) compilation into O(affected specs).

### Option 6: Git rename auto-repair

**Source:** ctxlint's git rename detection with fuzzy-match suggestions.

When `file()` validation fails (file not found), query git for renames:

```bash
git log --all --diff-filter=R --find-renames --format="%H" -- <missing-path>
```

If the file was renamed, the error message becomes actionable:

```
File not found: "src/utils/logger.ts"
  → Renamed to "src/telemetry/logger.ts" in commit abc1234
  Run: vigiles compile --fix to update the spec
```

With `--fix`, vigiles updates the `file()` call in the spec source automatically.

**Determinism:** Fully deterministic (git history).
**Scope:** Small — add a `git log` subprocess call in the error path of `validateFileRef()` in `compile.ts`. No new dependencies.
**Hooks:** Not hook-dependent, but improves the error UX for every workflow.

### Option 7: Temporal coupling analysis (co-change ratio)

**Source:** Software engineering research on temporal coupling (Ying et al. 2004, D'Ambros et al. 2009). Productionized by CodeScene and code-forensics. Never applied to AI instruction files.

For each `file()` reference in a spec, compute how often the referenced file and the spec file co-change in the same commit. A low ratio means the code is evolving but the spec isn't keeping up — a quantitative staleness risk score.

```
Co-change analysis (last 100 commits):
  src/api/router.ts      12 code changes, 1 spec change  ( 8%)  ⚠ DRIFT RISK
  src/compile.ts          5 code changes, 4 spec changes (80%)  ✓ coupled
  eslint.config.mjs       3 code changes, 2 spec changes (67%)  ✓ coupled
  src/legacy/old.ts       0 code changes, 0 spec changes   —    unchanged
```

The algorithm:

```
for each file F referenced via file() in spec S:
  code_changes = count commits touching F in last N commits
  spec_changes = count commits touching S in same window
  co_changes   = count commits touching BOTH F and S
  ratio        = co_changes / code_changes  (0 if code_changes == 0)
  if ratio < threshold (default 0.2) and code_changes >= min_changes (default 3):
    flag as drift risk
```

This is the temporal coupling metric from software engineering research, applied to spec-to-code relationships. It catches a class of staleness that hash-based approaches miss: the spec may compile fine and all references resolve, but the referenced code has evolved enough that the spec's _descriptions_ are likely outdated.

**Determinism:** Fully deterministic (git log commit counting).
**Scope:** Medium — requires `git log` parsing per file reference. ~50 lines of implementation. No external dependencies.
**Hooks:** `vigiles audit --coupling` as a weekly CI job catches slow drift that per-commit checks miss.

### Option 8: AST-normalized config fingerprinting

**Source:** Fiberplane Drift's tree-sitter AST fingerprinting, applied to linter configs specifically.

Instead of hashing `eslint.config.mjs` as raw text, parse the config and hash only the semantic content (the rule set). Formatting changes, comment additions, and import reordering don't change the hash.

For ESLint: vigiles already calls `calculateConfigForFile()` during linter verification. The resolved config contains the effective rule set. Hash that instead of the raw file.

For TOML-based configs (pyproject.toml, ruff.toml): parse TOML, extract the relevant section (`[tool.ruff.lint]`, `[lints.clippy]`), serialize deterministically, hash.

For YAML-based configs (.rubocop.yml, .stylelintrc.yml): parse YAML, extract rule keys, sort, hash.

| Config type      | Parse with                          | Hash what                             |
| ---------------- | ----------------------------------- | ------------------------------------- |
| eslint.config.\* | ESLint API `calculateConfigForFile` | Resolved rule set (already available) |
| pyproject.toml   | TOML parser                         | `[tool.ruff.lint]` section            |
| .rubocop.yml     | YAML parser                         | Cops configuration                    |
| Cargo.toml       | TOML parser                         | `[lints.clippy]` section              |
| .pylintrc        | INI parser                          | `[MESSAGES CONTROL]` section          |
| .stylelintrc.\*  | JSON/YAML parser                    | Rules object                          |

This eliminates false positives in input-hash mode where reformatting a config triggers a stale signal. The input hash only changes when the _effective linter rules_ change.

**Determinism:** Fully deterministic (parse → normalize → hash).
**Scope:** Medium — requires parsers per config format. vigiles already has TOML/YAML/JSON parsing for linter verification, so this reuses existing infrastructure.
**Hooks:** Reduces noise in pre-commit hooks by eliminating false-positive staleness from config formatting.

### Option 9: Spec age warning with commit velocity

**Source:** Repowise's confidence scoring, Packmind's staleness thresholds, CodeScene's code age visualization.

If the spec file hasn't been modified in N days but the project has had M+ commits touching referenced files, emit an informational warning:

```
Age warning: CLAUDE.md.spec.ts
  Last modified: 94 days ago
  Referenced files changed: 47 commits since last spec update
  Consider reviewing.
```

The algorithm is two `git log` calls:

```
spec_last_modified = git log -1 --format=%aI -- <spec-file>
ref_commits_since = git log --oneline --since=<spec_last_modified> -- <referenced-files...> | wc -l
if days_since(spec_last_modified) > threshold_days AND ref_commits_since > threshold_commits:
  warn
```

This catches slow drift that hash-based checks miss entirely: the spec compiles fine, all references resolve, but the code has evolved significantly while the spec's prose descriptions stagnated.

**Determinism:** Fully deterministic (git dates + commit counts).
**Scope:** Tiny — two `git log` calls, date comparison.
**Hooks:** Weekly CI job. Not useful as a pre-commit hook (too coarse-grained).

### Option 10: Code element cross-referencing

**Source:** DOCER (ICSE 2024 paper), applied to compiled vigiles output.

Scan compiled markdown for backtick-quoted identifiers (`compileSpec`, `ClaudeSpec`, `checkLinterRule`). Verify each identifier still exists somewhere in the codebase via grep. Flag identifiers that appear in the markdown but no longer exist in any source file:

```
Stale code references in CLAUDE.md:
  `formatOutput` — not found in codebase (deleted in commit def5678?)
  `LinterResult` — not found in codebase (renamed to LinterCheckResult?)
```

The algorithm:

```
1. Extract backtick-quoted tokens from compiled markdown: /`([A-Za-z_]\w+)`/g
2. Filter out common English words, markdown formatting, file paths, commands
3. For each remaining identifier, grep the source tree
4. Report identifiers with zero matches
```

This catches a class of staleness that file-level tracking misses: a file still exists and compiles, but the specific function/type/variable mentioned in the prose was renamed or removed. DOCER's research found this affects most projects.

**Determinism:** Fully deterministic (regex extraction + grep).
**Scope:** Medium — identifier extraction regex, word filter, source grep. ~80 lines.
**Hooks:** `vigiles audit --refs` as a CI check. Could also run as a post-compile validation step.

## Top 3 Recommendation

Evaluated against vigiles's positioning (spec-as-source-of-truth, build-artifact model, deterministic verification) and the constraints (deterministic, CLI-friendly, reasonable scope, hook-compatible):

### 1. Per-file sidecar manifest (Option 4)

**Why #1:** It's the foundation. Every other option benefits from per-file tracking. Without it, you can only say "something changed." With it, you can say "eslint.config.mjs changed, and it affects sections X and Y." It's also the prerequisite for the affected-specs reporter.

The sidecar file is a build artifact, consistent with vigiles's architecture. It's `.gitignore`-able (local cache) or committable (shared baseline), user's choice.

### 2. Affected-specs reporter (Option 5)

**Why #2:** It transforms vigiles from "recompile everything" to "recompile what changed." This is the Bazel/Nx insight applied to instruction files. In a monorepo with 20 specs, recompiling only the 2 affected by a config change is a 10x speedup.

It also enables the cleanest hook pattern: pre-commit runs `vigiles affected --staged | xargs vigiles compile --check` — only validates specs whose inputs were staged. Zero wasted work.

### 3. Git rename auto-repair (Option 6)

**Why #3:** Small scope, high signal, immediately improves the developer experience. When a `file()` reference breaks, the error goes from "File not found" (dead end) to "File renamed to X in commit Y" (actionable). This is the kind of polish that makes a tool feel intelligent.

It also solves the most common staleness scenario: a file is renamed during a refactor, the spec is forgotten, and compilation breaks. Instead of manual investigation, vigiles tells you exactly what happened.

### Honorable mention: Temporal coupling (Option 7)

The co-change ratio is the most algorithmically novel option — a well-established metric from software engineering research that has never been applied to AI instruction files. It catches "slow drift" that no hash-based approach can detect. Deferred because it's a diagnostic/reporting feature, not a correctness check. Best suited as a periodic audit (`vigiles audit --coupling`) rather than a per-commit gate.

## Hook Integration Patterns

The options above pair naturally with hooks. Recommended configurations:

### Pre-commit: auto-recompile affected specs

```json
{
  "hooks": {
    "pre-commit": "vigiles affected --staged --quiet | xargs -r vigiles compile --check"
  }
}
```

Blocks commits where staged files would make a spec stale. Only checks affected specs (fast). The `--check` flag means "verify, don't write" — if stale, the developer runs `vigiles compile` manually and stages the result.

Variant with auto-fix:

```json
{
  "hooks": {
    "pre-commit": "vigiles affected --staged --quiet | xargs -r vigiles compile && git add $(vigiles affected --staged --targets)"
  }
}
```

Auto-recompiles and stages the updated markdown. Zero friction but hides drift (the developer doesn't see what changed). Use with caution.

### Post-checkout: staleness warning

```json
{
  "hooks": {
    "post-checkout": "vigiles audit --freshness --quiet || echo 'vigiles: some specs are stale — run vigiles compile'"
  }
}
```

After `git checkout` or `git pull`, warn if compiled files are stale. Non-blocking (exits 0 regardless). Useful when switching to a branch where someone else changed inputs but didn't recompile.

### CI: affected-only compilation

```yaml
# .github/workflows/vigiles.yml
- name: Check affected specs
  run: |
    vigiles affected --base origin/main --quiet | xargs -r vigiles compile --check
```

Only validates specs affected by the PR's changes. Skips unchanged specs entirely.

### Weekly: coupling audit

```yaml
# .github/workflows/vigiles-weekly.yml
on:
  schedule:
    - cron: "0 9 * * 1" # Monday 9am
jobs:
  coupling:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: vigiles audit --coupling --threshold 0.2
```

Catches slow drift that per-commit checks miss. Reports specs where referenced files have diverged significantly.

## Open Questions

1. **Should `vigiles compile` auto-verify inputs before compiling?** (i.e., if inputs haven't changed, skip compilation entirely — Bazel-style memoization)
2. **Should the input manifest include the vigiles version?** (A vigiles upgrade might change compilation output even with identical inputs)
3. **Should `vigiles audit --fix` automatically recompile when inputs are stale?** (Convenient but hides drift)
4. **How to handle inline mode?** Inline rules have no spec file — the "spec source" input doesn't exist. Input hash would cover just the markdown file + linter configs.
5. **Should TOC.md be a new compilation target?** (`vigiles init --target=TOC.md` scaffolds a TOC spec for a directory.) Or should it be a separate `vigiles toc` command?
6. **Recursive TOC depth:** Should nested TOCs be mandatory, or should a root TOC be allowed to list all files flat? Mandatory nesting scales better but adds friction for small projects.
7. **Should the sidecar manifest be committed or gitignored?** Committed = shared baseline, CI can diff against it. Gitignored = local cache, no noise in PRs. Recommendation: gitignored by default, committable via config.
8. **Should `vigiles affected` read sidecar manifests or re-discover inputs?** Sidecar is faster but requires a prior compile. Re-discovery is slower but always works. Recommendation: sidecar first, fall back to re-discovery.
9. **Co-change threshold tuning:** What's the right default threshold for the temporal coupling warning? 20% co-change ratio? 10%? Should it be configurable per-spec?
