# require-spec

Require a `.spec.ts` source file for every `CLAUDE.md` or `AGENTS.md` found in the project. The spec is the source of truth — the markdown is a compiled build artifact.

## Configuration

```json
{
  "rules": {
    "require-spec": "error"
  }
}
```

| Value              | Behavior                                              |
| ------------------ | ----------------------------------------------------- |
| `"error"`          | `vigiles audit` exits non-zero if any spec is missing |
| `"warn"` (default) | Prints warning, exits 0                               |
| `false`            | Skip this check                                       |

## What it checks

For every `CLAUDE.md` or `AGENTS.md` file found, vigiles looks for a sibling `.spec.ts` file:

- `CLAUDE.md` → expects `CLAUDE.md.spec.ts`
- `AGENTS.md` → expects `AGENTS.md.spec.ts`
- `docs/CLAUDE.md` → expects `docs/CLAUDE.md.spec.ts`

If the markdown file has a `<!-- vigiles:sha256:... compiled from ... -->` header, it's already spec-managed and passes regardless.

## Disable per file

```markdown
<!-- vigiles-disable require-spec -->

# CLAUDE.md

...
```

## Why

Hand-written instruction files rot silently. Specs catch stale references at compile time. This rule nudges projects toward spec-driven instruction files without blocking adoption — start with `"warn"`, escalate to `"error"` once specs are in place.
