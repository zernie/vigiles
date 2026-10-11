# `compile-budget`

Size budgets on an instruction file compiled from a `.spec.ts`: one `commands`
entry, one section, and the whole Rules section.

```json
{ "rules": { "compile-budget": "error" } }
```

|              |                                        |
| ------------ | -------------------------------------- |
| **Default**  | `warn`                                 |
| **Surface**  | instruction files compiled from a spec |
| **Bucket**   | structural-closed                      |
| **Detector** | `checkContentBudgets`                  |

`"extends": "vigiles:recommended"` sets it to `error`
([the preset](../configuration.md#extends)).

## What it checks

| budget                       | default threshold | checked at                  |
| ---------------------------- | ----------------- | --------------------------- |
| one `commands` description   | 200 characters    | `warn` and `error`          |
| one named prose section      | 15,000 characters | `warn` and `error`          |
| the whole rendered Rules sum | 20,000 characters | `error`, or when you set it |

The first two are what `compile` has always printed as warnings. The Rules sum
is new, and at the default severity it is **not evaluated** unless you give it
a threshold, so the default output is exactly what it was.

## What it does not check

Each of these has one owner already, and this rule does not report it a second
time:

- **The whole always-loaded size** — [`instruction-weight`](instruction-weight.md).
  It sums every file the harness loads unasked, in the harness's
  own unit (characters for Claude Code, bytes for Codex), so moving text from
  the compiled file into an always-loaded rules file does not fool it. A
  per-file ceiling here would report the same overweight twice and score that
  move as a fix.
- **`keyFiles`** — being deprecated. Budgeting the size of a section you are
  told to delete would be a second, contradicting instruction. The older
  800-character error on one key-file description still applies until the
  field is removed.
- **Estimated tokens.** `maxTokens` (in the spec or in `.vigilesrc.json`) is a
  separate, older check: it fails `compile` at any severity, as it always has.

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

Each threshold is optional, in characters. A key you leave out keeps its
default; `0` turns that one budget off.

```json
{
  "rules": {
    "compile-budget": ["error", { "maxRulesChars": 30000 }]
  }
}
```

| option            | budget                       |
| ----------------- | ---------------------------- |
| `maxEntryChars`   | one `commands` description   |
| `maxSectionChars` | one named prose section      |
| `maxRulesChars`   | the whole rendered Rules sum |

Under `"warn"`, setting `maxRulesChars` turns that budget on as a warning.

## Why the Rules section, not each rule

The per-entry and per-section budgets were warnings, and on a file almost four
times over the harness budget the only message was about one 314-character
entry. The weight was elsewhere: one real Rules section was about 89 kB for 59
rules, and it had no budget. A per-rule length cap was tried and removed within
an hour (it fired on 40 of 53 rules); the sum is what loads on every request, so
the sum is what is budgeted, and the finding names the section to cut.

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

A repo that lists its rules in `.vigilesrc.json` without `extends` keeps the
default and sees no change. A repo that extends `vigiles:recommended` gets the
gate on upgrade (a major version). If its file is over budget, it renders rules
shorter, or sets `"compile-budget": "warn"` in `rules` until it is under; the
[`instruction-weight`](instruction-weight.md) ratchet meanwhile keeps the
always-loaded weight from growing.

## See also

- [`instruction-weight`](instruction-weight.md) — the ratchet on everything the
  harness loads unasked.
- The validation-rule matrix in
  [verifying instruction files](../verifying-instruction-files.md).
