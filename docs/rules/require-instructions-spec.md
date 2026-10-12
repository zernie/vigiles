# require-instructions-spec

Require a `.spec.ts` source behind every `CLAUDE.md` / `AGENTS.md` — the root one and every nested one. The instruction file is compiled from a typed spec, not hand-written: the spec is the source of truth, and the markdown is its build output.

## Severity

| Where                                                   | Severity  |
| ------------------------------------------------------- | --------- |
| Built-in default                                        | `"warn"`  |
| `"extends": "vigiles:recommended"` (what `init` writes) | `"error"` |

`vigiles init` adopts every instruction file it finds into a spec, nested ones included, so right after setup the rule is green. From then on it fires on an instruction file someone added by hand.

```json
{
  "rules": {
    "require-instructions-spec": "error"
  }
}
```

| Value     | Behavior                                             |
| --------- | ---------------------------------------------------- |
| `"error"` | `vigiles lint` exits non-zero on a hand-written file |
| `"warn"`  | Prints the finding, exits 0                          |
| `false`   | Skip this check                                      |

## What it checks

For every `CLAUDE.md` / `AGENTS.md` that `lint` discovers, vigiles looks for a sibling `.spec.ts`:

- `CLAUDE.md` → expects `CLAUDE.md.spec.ts`
- `AGENTS.md` → expects `AGENTS.md.spec.ts`
- `docs/CLAUDE.md` → expects `docs/CLAUDE.md.spec.ts`

A file whose header reads `<!-- vigiles:sha256:... compiled from ... -->` is spec-managed and passes, wherever its spec lives.

**Narrow by design:** only a `.spec.ts` (or the disable marker) satisfies this rule. Inline `<!-- vigiles:enforce ... -->` comments and a `vigiles:` frontmatter block are valid plain-markdown on-ramps, but they do not satisfy it — see [markdown mode](../markdown-mode.md#require-instructions-spec).

## What the finding tells you to do

Each finding names three ways out, in this order:

1. **Adopt the file into a spec.** Two tools, for different jobs:
   - the `adopt-spec` skill — ask your agent to run it on the file (it never fires by itself). The agent maps rules to `guidance()` / `enforce()`, commands to `cmd()` and paths to `file()`, and shows you the spec before writing it.
   - `npx vigiles init --target=<path>` — no agent, immediate. It copies every section verbatim as prose; only paths that resolve become checked `file()` references, and rules stay prose.

   Neither edits the markdown. Review the spec, then run `npx vigiles compile`; for a faithful adoption the diff is the integrity header. Run `/strengthen` later to turn prose into verified rules; `vigiles eject` reverses adoption.

2. **Not your file** (vendored, a fixture, a submodule) — add its folder to top-level `exclude`, so vigiles does not read it at all:

   ```json
   { "exclude": ["vendor/**"] }
   ```

3. **Kept hand-written on purpose** — turn the rule off for those folders with an [`overrides`](../configuration.md#overrides) entry:

   ```json
   {
     "overrides": [
       {
         "files": ["notes/**"],
         "rules": { "require-instructions-spec": "off" }
       }
     ]
   }
   ```

   Only if no instruction file in the repository should have a spec: `{ "rules": { "require-instructions-spec": "off" } }`.

`vigiles audit` lists every hand-written instruction file with the same adoption steps, and leaves out the folders an override turned the rule off for.

## Disable per file

```markdown
<!-- vigiles-disable require-instructions-spec -->

# CLAUDE.md

...
```

`vigiles eject` adds this marker when it hands a compiled file back as plain markdown.

## Adoption

A repo that lists its rules in `.vigilesrc.json` without `extends` keeps the built-in `warn` and sees no change. A repo that extends `vigiles:recommended` gets the gate on upgrade (a major version): each hand-written instruction file fails `lint` until it is adopted, excluded, or overridden off. `"rules": { "require-instructions-spec": "warn" }` keeps the old behaviour while you work through them. A setup that declines specs (`init --ci-only`, the wizard's "gate") writes the rule as `"off"`.

## Why

Hand-written instruction files rot silently: a renamed script or a moved path stays in the prose. A spec checks its references at compile time, and the integrity header catches a hand edit of the output.

## See also

- [`overrides`](../configuration.md#overrides) — per-path severities.
- [`integrity`](integrity.md) — the compiled file was not edited by hand.
- The validation-rule matrix in [verifying instruction files](../verifying-instruction-files.md).
