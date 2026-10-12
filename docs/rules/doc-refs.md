# doc-refs

Validate **vigiles builder calls quoted inside markdown code fences** —
`enforce("...")`, `file("...")`, `cmd("...")`, `ref("...")` inside a
` ```ts ` block — against the same engines that validate them in a real
`.spec.ts`: the linter catalog, the filesystem, `package.json` scripts.

**Default: `off`.** This is the only rule in vigiles whose default was set by a
measurement of the rule's own precision, and the number is why.

## Why it is off

Run across two real repositories on 2026-08-19 — the vigiles source tree and a
large private knowledge base that consumes it:

| repo     | `.md` scanned | builder refs found | errors | true positives |
| -------- | ------------: | -----------------: | -----: | -------------: |
| vigiles  |           178 |                 25 |      0 |              0 |
| consumer |         2 404 |                 27 |      8 |          **0** |

All eight errors were false. Seven were **design prose in the consumer repo
sketching future vigiles APIs**, e.g.

```
vigiles/research/skill-as-pipeline.md:161  cmd("npm run lint") — Script "lint" not found in package.json
vigiles/ideas/22-namespace-obekt.md:206    cmd("npm run lint") — Script "lint" not found in package.json
```

Those fences describe a package that does not exist yet. The eighth was a
third-party `CLAUDE.md` captured verbatim as benchmark data for a paper —
someone else's repo, held to this repo's filesystem.

The cause is structural rather than a calibration miss: **a fenced block in
prose is a drawing of config, and this rule read it as config.** No threshold
fixes that, because the block is not wrong — it is not config.

## What the escape hatches cost

The consumer repo could only reach a passing `lint` by listing whole
directories in `exclude`:

```json
{ "exclude": [".claude/worktrees/**", "vendor/**", "papers/**"] }
```

That silenced the rule by removing roughly a third of the repository from
**every** check, not just this one. Measured afterwards, the pass walked 604
files and found **0 refs** — fully inert, and still paying for the walk. Off by
default replaces that blunt instrument with an honest default.

Per-site opt-outs exist and still work when the rule is on:
`<!-- vigiles:ignore -->` immediately before a fence (one block), or
`<!-- vigiles:ignore-file -->` anywhere in a file (the whole file).

## When to turn it on

```json
{ "rules": { "doc-refs": "error" } }
```

Turn it on where markdown genuinely **is** the source — a docs site whose
fences are copy-pasted into live specs, or a tutorial repo where a stale
`enforce("eslint/no-unused-vars")` would send readers to a rule that no longer
exists. In that setting every ref is a promise about the current tree, and this
rule keeps the promise.

At `"warn"` findings print and annotate but do not affect the exit code. At
`"error"` they gate (exit 2).

## Known gap for whoever improves it

The walker globs `**/*.md` **without `dot`**, so `.claude/**` — where deployed
skills, agents and commands actually live — has never been scanned. Measured:
turning that on adds one ref in the vigiles tree
(`enforce("<linter>/<rule-name>")`, a placeholder the engine already skips) and
zero errors. So the rule has never once judged a deployed instruction file;
every ref it has ever seen was in prose. Any attempt to restore a non-`off`
default should start there, and should be able to show a true positive first.

## Scope

Only vigiles builder calls. Generic TypeScript syntax or type checking inside
markdown is explicitly out of scope — use `eslint-plugin-markdown` or `twoslash`
for that (see `docs/comparison.md`).
