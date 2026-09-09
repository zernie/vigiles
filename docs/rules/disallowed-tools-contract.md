# disallowed-tools-contract

Cross-reference a subagent's **`disallowedTools:` block-list** against the harness
tool catalog — the deny-side mirror of [`subagent-tool-contract`](subagent-tool-contract.md).
A typo here is dangerous: you meant to block `Bash` but wrote `Bsh`, so **nothing
is blocked** and the tool you intended to deny stays available, silently. Same
detector `vigiles audit` uses (`disallowedToolIssues` in `src/core/tool-contract.ts`).

## What it flags

```yaml
# agents/reviewer.md
tools: Read, Grep
disallowedTools: Bsh, Bash, Agent, mcp__github__search
```

- `Bsh` — a **close typo of `Bash`** → ✗ blocks nothing (did you mean `Bash`?)
- `Bash` — a real tool, **legitimately blocked** → ✓
- `Agent` — never-available to a subagent anyway, **harmless to list** → ✓
- `mcp__github__search` — a real plugin tool to block → ✓

## High-precision calibration

The block-list **inverts** the allow check, so the FP-safe set is different from
`subagent-tool-contract`:

- A **real built-in** in the list is correct (it's being blocked) — not flagged.
- A **never-available** tool (`Agent`, `AskUserQuestion`) is harmless to list — not
  flagged.
- An **MCP tool** is a legitimate plugin tool to block — not flagged.
- A **bare unknown** with no near match is likely a plugin/MCP tool — not flagged
  (the cry-wolf trap).
- Only a **close typo (≤2) of a real built-in** is flagged — the high-confidence
  signal that the author meant to block a real tool and the deny silently fails.

## Configuration

```json
{ "rules": { "disallowed-tools-contract": "warn" } }
```

### Severity

| Value              | Behavior                                               |
| ------------------ | ------------------------------------------------------ |
| `"error"`          | `vigiles lint` exits non-zero (2) on a block-list typo |
| `"warn"` (default) | Prints a warning, exits 0                              |
| `false`            | Skip the check                                         |

## Scope

Subagent frontmatter (`agents/*.md` `disallowedTools:`) in every spelling Claude
Code accepts — a comma-separated string, a space-separated string, or a YAML
list. Whitespace separates tokens only outside parentheses, so a bounded grant
like `Bash(git push *)` stays one entry.

> **Not the same field as a skill's `disallowed-tools:`.** A skill's fence is
> kebab-case and lives in `SKILL.md`; it is read by
> [lethal-trifecta](lethal-trifecta.md#skills-the-fence-is-disallowed-tools), which
> is where a skill's deny list is checked. This rule's typo cross-reference is
> subagent-only.

## Why

A deny-list that silently denies nothing is worse than no deny-list — the author
believes a dangerous tool is blocked when it isn't. This is the security-relevant
half of the tool cross-reference, and it's a check no other validator does.

## See also

- [subagent-tool-contract](subagent-tool-contract.md) — the allow-list half (the same
  catalog cross-reference, applied to `tools:`).
- [lethal-trifecta](lethal-trifecta.md#skills-the-fence-is-disallowed-tools) — the
  SKILL-side deny list (`disallowed-tools:`), the only skill field that removes a
  tool from the pool.
