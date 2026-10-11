# `compile-budget`

Size budgets on an instruction file compiled from a `.spec.ts`: one entry, one
section, the whole Rules section, the whole Key Files section, and the whole output
against the harness's own budget.

```json
{ "rules": { "compile-budget": "error" } }
```

|              |                                        |
| ------------ | -------------------------------------- |
| **Default**  | `warn`                                 |
| **Surface**  | instruction files compiled from a spec |
| **Bucket**   | structural-closed                      |
| **Detector** | `checkContentBudgets`                  |

`"extends": "vigiles:strict"` sets it to `error`
([the preset](../configuration.md#extends)).

## What it checks

| budget                                  | default threshold                                                               | checked at                  |
| --------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| one `keyFiles` / `commands` description | 200 characters                                                                  | `warn` and `error`          |
| one named prose section                 | 15,000 characters                                                               | `warn` and `error`          |
| the whole rendered Rules section        | 20,000 characters                                                               | `error`, or when you set it |
| the whole rendered Key Files section    | 10,000 characters                                                               | `error`, or when you set it |
| the whole compiled file                 | the harness's budget, in its unit: Claude Code 40,000 chars, Codex 32,768 bytes | `error`, or when you set it |

The first two are what `compile` has always printed as warnings. The other three
are new, and at the default severity they are **not evaluated** unless you give
them a threshold, so the default output is exactly what it was.

The whole-file ceiling is measured in the unit the harness itself counts:
characters for Claude Code (its `/doctor` warns past 40,000), bytes for Codex
(it silently truncates past 32 KiB). It is never a token count: `compile`'s
`~N tokens est.` is characters divided by four, and offline estimates like it
undercount Claude's own tokenizer on English instruction text by roughly
33–44%. Codex's 32 KiB is shared by the whole `AGENTS.md` chain, so one compiled
file under it can still be cut once the chain is summed; the sum is what
[`instruction-weight`](instruction-weight.md) measures. An explicit
`maxTokens` (in the spec or in `.vigilesrc.json`) is a separate, older check: it
fails `compile` at any severity, as it always has, and it does not replace or
lift this ceiling.

## Severity

- `"warn"` (default) — `compile` prints the findings and still writes the file.
  `lint` says nothing about size.
- `"error"` — every budget above, with its default, fails `compile` (nothing is
  written; the last good file stays) and fails `lint` (exit 2), under the heading
  `Compile budget check (compile-budget)`. A size finding is never reported as a
  dead reference.
- `false` / `"off"` — no budget is reported. `maxTokens`, `maxRules` and the
  separate 800-character key-file error still apply.

## Options

Each threshold is optional. A key you leave out keeps its default; `0` turns
that one budget off.

```json
{
  "rules": {
    "compile-budget": [
      "error",
      { "maxRulesChars": 30000, "maxKeyFilesChars": 0 }
    ]
  }
}
```

| option             | unit                                                        |
| ------------------ | ----------------------------------------------------------- |
| `maxEntryChars`    | characters                                                  |
| `maxSectionChars`  | characters                                                  |
| `maxRulesChars`    | characters                                                  |
| `maxKeyFilesChars` | characters                                                  |
| `maxOutput`        | the harness's unit: characters (Claude Code), bytes (Codex) |

Under `"warn"`, setting `maxRulesChars`, `maxKeyFilesChars` or
`maxOutput` turns that budget on as a warning.

## Why the Rules section and the list, not each rule

The per-entry and per-section budgets were warnings, and on a file almost four
times over the harness budget the only message was about one 314-character
entry. The weight was elsewhere: one real Rules section was about 89 kB for 59
rules, and one real Key Files list was about 46.5 kB in 230 entries, 118 of them
clipped with `…` to fit the per-entry budget. Neither sum had a budget. (Whether
the NUMBER of entries should be capped too is a separate, open decision; this
rule budgets only their total size.) A per-rule length
cap was tried and removed within an hour (it fired on 40 of 53 rules); the sum is
what loads on every request, so the sum is what is budgeted.

## Meeting the budget without deleting rules

Deleting a rule from the spec removes it from everything vigiles checks. Render
it shorter instead (see [rule types](../spec-format.md#enforceref-why-options)):

```ts
rules: {
  // the linter already holds the rule: render only its id
  "no-console": enforce("eslint/no-console", why, { render: "id" }),
  // keep one sentence in the always-loaded file, the rest in a linked doc
  "small-prs": guidance("Keep pull requests small.", {
    details: file("docs/rules/small-prs.md"),
  }),
}
```

The rule stays whole in the spec, so `lint`, coverage and `audit` still read it.

## Adoption

The default changes nothing, so turning vigiles on fails no repository. A repo
already over these budgets keeps the [`instruction-weight`](instruction-weight.md)
ratchet: its always-loaded weight cannot grow past the committed baseline. Turn
`compile-budget` to `error` (or extend `vigiles:strict`) when the file is under
budget, so it stays there.

## See also

- [`instruction-weight`](instruction-weight.md) — the ratchet on everything the
  harness loads unasked, not only the compiled file.
- The validation-rule matrix in
  [verifying instruction files](../verifying-instruction-files.md).
