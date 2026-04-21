# Enforce-Over-Guidance: Deterministic Upgrade Gates

Research doc for mechanisms that pressure `guidance()` rules toward `enforce()` rules without relying on LLM judgment. Saved here during design iteration — two ideas survived review (snapshot-gated downgrades, Merkle diff vs upstream catalog); two didn't (author-supplied candidates, pure keyword overlap).

LLM matching is explicitly off-limits — non-deterministic, breaks the vigiles determinism moat. Any gate that decides "this could be enforced" must be rule-based.

---

## Idea 1 — Snapshot-gated downgrades

Prevent silent weakening of the spec by tracking the kind of every rule across releases. Easy to implement, catches a concrete real-world regression pattern, no author burden.

### Problem

An agent "fixing" a failing CI build has an easy escape hatch: change `enforce(...)` to `guidance(...)`. CI goes green, diff looks like a refactor, review rubber-stamps it. The spec is silently weaker — a rule that was machine-checked is now prose.

Reviewers don't catch this because the diff reads as innocuous. Without an explicit gate, there's no mechanism that flags the kind-change.

### Mechanism

Snapshot file checked into the repo at `.vigiles/rule-history.json`:

```json
{
  "version": "1.3.0",
  "rules": {
    "no-floating-promises": "enforce",
    "cognitive-complexity": "enforce",
    "never-skip-tests": "guidance"
  }
}
```

Every compile:

1. Load the snapshot (create on first compile if missing).
2. For each rule in the current spec, compare kind against the snapshot entry.
3. If a rule moved from `enforce` → `guidance`, classify as a **downgrade**.
4. Resolve the current project version (see resolver below).
5. If `semver.major(current) > semver.major(snapshot.version)` → accept the downgrade, rewrite snapshot with new version and new kinds.
6. Otherwise, fail compile with a message naming the downgraded rule and instructing either a major bump or a revert.

New rules and upgrades (`guidance` → `enforce`) never fail — the gate only blocks weakening.

### Version resolver (cross-ecosystem)

Hardcoding `package.json` breaks Python, Ruby, Rust, Go projects. Priority order, first hit wins:

1. `.vigilesrc.json` → `{"version": "2.0.0"}` — explicit override.
2. `.vigilesrc.json` → `{"versionSource": "git-tag" | "package.json" | ...}` — explicit source selector.
3. `.vigiles/version` — plain text file, one line, vigiles-owned.
4. `git describe --tags --match 'v*' --abbrev=0` — universal across every ecosystem that uses git.
5. Manifest probe: `package.json.version` → `pyproject.toml[project].version` → `Cargo.toml[package].version` → `*.gemspec` → `VERSION`.
6. Fallback `0.0.0` with warning.

Git tags as the default means the same source release tooling already uses (semantic-release, goreleaser, cargo-release) is the source of truth.

### Workflow

Legitimate downgrade:

```
$ git commit -m "BREAKING: weaken cognitive-complexity to guidance (too noisy)"
$ git tag v2.0.0
$ npx vigiles compile
✓ major bump detected (1.3.0 → 2.0.0), snapshot updated
```

Illegitimate downgrade:

```
$ npx vigiles compile
✗ downgrade detected:
    cognitive-complexity: enforce → guidance
  current version 1.3.1 does not exceed snapshot version 1.3.0 by major.
  bump major or revert the kind change.
```

### Cost and limits

- Snapshot file adds one tracked artifact. Same shape as `.vigiles/generated.d.ts` already in the repo.
- Doesn't find new upgrade opportunities — only blocks regressions. Pair with idea 2 for proactive.
- Deletion of a rule is ambiguous — could be a legitimate removal or a disguised downgrade. Treat removals the same as downgrades (require major bump) unless `.vigilesrc.json` opts out.

### Priority

High. Smallest possible implementation, concrete value, covers the most dangerous regression class.

---

## Idea 2 — Merkle diff vs upstream linter catalog

Detect when upstream linters add rules that cover your existing `guidance()` rules. Deterministic, efficient via existing `proofs.ts` Merkle DAG infra, but has non-trivial fuzz in the matching step.

### Problem

Guidance rules are usually "no linter covers this yet." Over time, linters add rules that DO cover them — ESLint 10 adds a rule you wrote guidance for in ESLint 9. Nothing currently tells the author this happened. Guidance rots in place while mechanical enforcement becomes possible.

### Mechanism

Uses the Merkle DAG code already in `src/proofs.ts`. A Merkle tree over a linter catalog works as follows: hash each rule's `(name, description, enabled)` tuple into a leaf; hash pairs of leaves into parents; continue until one root. Two catalog snapshots are identical iff their roots match. Finding which rules changed is O(log n) by walking mismatched subtrees.

Flow:

1. Every compile, vigiles computes the Merkle root of each linter's catalog (ESLint, Ruff, Clippy, Pylint, RuboCop, Stylelint).
2. Roots stored in `.vigiles/catalog-hash.json`: `{"eslint": "abc123", "ruff": "def456"}`.
3. On next compile, recompute roots.
   - Unchanged → skip all matching. Fast path, zero cost.
   - Changed → walk the tree to find only new leaves (newly added linter rules).
4. For each new rule, run a keyword-overlap check against every `guidance()` rule's `why`.
5. Surface matches as warnings: "ESLint 10.2 added `eslint/no-floating-promises`, matches your guidance `no-floating-promises` (overlap: promises, await). Strengthen?"

### Why Merkle specifically

Three payoffs:

- **Efficiency** — don't rerun matching against 800+ ESLint rules on every compile. Only process what changed upstream.
- **Determinism** — "the catalog was exactly this at time T" is reproducible across machines and CI runs. Two CIs that see the same Merkle root see the same catalog.
- **Reuse** — `src/proofs.ts` already has the DAG infra built for self-evolving specs. No new dependency.

### Keyword overlap subroutine

The matching step inside idea 2 is keyword overlap (the standalone "idea 3" in earlier discussion, reduced to a subroutine here because it's useful scoped but weak as a full rule):

1. Tokenize the guidance `why`: lowercase, split on whitespace and punctuation, drop stopwords.
2. Tokenize each new linter rule's name + description.
3. Count shared tokens.
4. Flag if overlap ≥ K (K=3 default).

Domain stopword list required — generic words (`error`, `type`, `value`, `check`) create false positives. English-only without stemming. Use as a warning, never a hard error. The Merkle scoping makes false positive noise tolerable because the check only runs against a handful of new rules per release, not the full catalog.

### Cost and limits

- Matching is fuzzy — English-only, false positives on generic words, misses semantically-equivalent wording that shares no tokens (`"always await"` vs `"disallow unhandled promises"`).
- Upstream catalog hashing requires each linter's API or CLI be callable during compile. Already a requirement of the existing cross-reference engine, so no new cost.
- Produces warnings, not errors. Still requires a human (or follow-up agent pass) to actually do the upgrade — this finds candidates, doesn't apply them.

### Priority

Medium. Good in theory, harder in practice. Keyword fuzz is the main drag. Worth revisiting once idea 1 lands and once the Merkle infra in `proofs.ts` sees real production traction.

---

## Rejected alternatives

Documenting these so they're not reproposed.

### Author-supplied candidates — `guidance(text, { candidate: "eslint/foo" })`

Rejected: the author has to volunteer the one hint that errors on them. Even reframed as a TODO marker, it's friction the author has no intrinsic reason to supply. Automatic rule-ID naming-convention lookup (rule id `"no-floating-promises"` auto-probes `*/no-floating-promises` across catalogs) is strictly better when it works, and zero-burden.

### Pure keyword overlap as a standalone rule

Rejected as a rule, retained as a subroutine. Running keyword matching against the full linter catalog on every compile produces too much noise, requires per-project stopword tuning, and misses paraphrased matches. It's fine scoped to "new upstream rules only" (idea 2's mechanism), but unusable unscoped.

### Git-based history reading

Rejected: reading previous spec kinds via `git show HEAD~1:CLAUDE.md.spec.ts` requires parsing the spec source and resolving default exports dynamically. A JSON snapshot file is simpler, more portable (no git required to run compile locally), and matches the pattern `.vigiles/generated.d.ts` already uses.

---

## Next steps

Prototype idea 1 first. Smallest surface, highest value. Defer idea 2 until there's real evidence that guidance rules are being left behind by upstream catalog drift — i.e., until someone reports "I wrote guidance for X two releases ago and ESLint now covers it and nobody noticed."
