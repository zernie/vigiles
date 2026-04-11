# Inline mode

Inline mode lets you adopt vigiles **one rule at a time**, without committing
to a `.spec.ts` compile step. You add `<!-- vigiles:enforce ... -->` HTML
comments directly to your existing `CLAUDE.md` / `AGENTS.md`, and
`vigiles audit` verifies them the same way it verifies spec-declared rules:
linter-backed existence check, closest-match typo suggestions, disabled-rule
detection, and GitHub Actions annotations.

It's the vigiles equivalent of `// eslint-disable-next-line` — minimum
commitment, maximum incrementalism.

## When to use it

- You already have a `CLAUDE.md` and don't want to port it to `.spec.ts`
- You want to experiment with a single rule before committing to the full
  vigiles workflow
- Your project isn't a TypeScript project at all and the build step feels
  like dead weight
- Hesitant teammates want to see the verification work before accepting a
  new file type in the repo

If you already have a real TypeScript project and you want the strongest
guarantees (editor-time type safety, programmatic rule composition, the
`generate-types` moat), use spec mode instead — see the main README.

## Format

A single HTML comment per rule:

```md
<!-- vigiles:enforce eslint/no-console "Use structured logger for app output" -->
```

Three required pieces:

1. `vigiles:enforce` — only `enforce` is supported inline. Guidance rules
   are just paragraphs in the surrounding prose, so a `guidance` comment
   would be a tautology.
2. `<linter>/<rule>` — the same reference format as `enforce()` in spec
   mode. Supports all six linters (ESLint, Stylelint, Ruff, Clippy, Pylint,
   RuboCop) and scoped plugin names (`eslint/@typescript-eslint/...`).
3. `"<why>"` — a simple double-quoted string. No newlines, no embedded
   quotes. If you need either, move to spec mode.

## Example

```md
# My Project

<!-- vigiles:enforce eslint/no-console "Route output through logger.ts" -->
<!-- vigiles:enforce eslint/@typescript-eslint/no-floating-promises "Await or explicitly void" -->
<!-- vigiles:enforce ruff/F401 "No unused imports" -->

## Logging

All application output must go through the shared logger module.
Do not use `console.log` directly in src/.

## Async

Every promise must be awaited or explicitly voided. The ESLint rule
enforces this automatically.
```

## What audit catches

Running `vigiles audit CLAUDE.md` on the above file will:

- Verify each `eslint/…`, `ruff/…` reference against your actual linter
  config
- Emit closest-match suggestions on typos: `"no-consol"` →
  `did you mean "eslint/no-console"?`
- Emit `::error` annotations when running inside GitHub Actions
- Exit with code 2 (hard error) on any failed rule, so CI fails fast

## What audit does NOT do in inline mode

- **No type safety at edit time.** The `.spec.ts` path gets TypeScript
  squiggles in the editor because `StrictLinterRule` is a type union of
  every rule in your linters. Inline mode is strings-in-markdown, so
  typos only surface at `vigiles audit` time. Still catches them before
  CI, just not in the editor.
- **No programmatic composition.** You can't reuse a batch of rules from
  a helper. Each comment is its own line.
- **No rule deduplication via NCD.** Duplicate-rule detection runs on
  spec-mode files; inline rules are ungrouped.

All of this is fine for the adoption-onramp use case. When you outgrow it,
port to spec mode.

## Mixing inline and spec mode

Spec mode wins. If a file has both `CLAUDE.md.spec.ts` and inline
comments inside `CLAUDE.md`, the spec compiler will overwrite the markdown
on the next compile, and your inline comments will be gone. Pick one per
file.

## Ignoring `require-spec`

The built-in `require-spec` validation rule demands a `.spec.ts` sibling
for every `CLAUDE.md` / `AGENTS.md`. Inline mode satisfies it — any file
with at least one `<!-- vigiles:enforce ... -->` comment is treated as
spec-equivalent, so you do not need to add a `vigiles-disable require-spec`
comment.

## Graduating to spec mode

When you've accumulated a dozen or so inline rules and the prose is
starting to feel crowded, run:

```bash
npx vigiles init --target=CLAUDE.md
```

That scaffolds a `CLAUDE.md.spec.ts` next to your existing `CLAUDE.md`.
Copy the inline enforce rules into the `rules:` block, delete the inline
comments, and run `vigiles compile`. The markdown output will be rebuilt
with a `sha256` hash header, and future edits flow through the spec.
