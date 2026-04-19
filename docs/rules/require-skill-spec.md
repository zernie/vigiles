# require-skill-spec

Require a `.spec.ts` source file for every `SKILL.md` found in the project.

## Configuration

```json
{
  "rules": {
    "require-skill-spec": "warn"
  }
}
```

| Value              | Behavior                                              |
| ------------------ | ----------------------------------------------------- |
| `"error"`          | `vigiles audit` exits non-zero if any spec is missing |
| `"warn"` (default) | Prints warning, exits 0                               |
| `false`            | Skip this check                                       |

## What it checks

For every `SKILL.md` file found in the project, vigiles looks for a sibling `.spec.ts` file:

- `skills/strengthen/SKILL.md` → expects `skills/strengthen/SKILL.md.spec.ts`

## Why

Skill files benefit from the same compile-time verification as CLAUDE.md — file references in instructions are checked via `file()`, cross-references via `ref()`. Without a spec, skill instructions can reference deleted files or renamed paths without detection.

Default is `"warn"` rather than `"error"` because many skills are simple enough that a spec adds little value. Escalate to `"error"` for skills with `file()` or `cmd()` references.
