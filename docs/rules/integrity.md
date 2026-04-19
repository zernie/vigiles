# integrity

## What is "integrity"?

Every compiled instruction file (CLAUDE.md, AGENTS.md) starts with a SHA-256 hash that vigiles wrote when it generated the file:

```html
<!-- vigiles:sha256:c92312d638af04cf compiled from CLAUDE.md.spec.ts -->
```

The `integrity` rule recomputes the hash from the current file contents and compares it to the stored value. If they don't match, **someone (or something) edited the compiled file directly** instead of editing the `.spec.ts` source. The rule flags this so the change can be undone and re-expressed in the spec.

This is a tamper-detection check, nothing more. It does NOT recompile and diff (that's what `vigiles compile` does), it does NOT track linter config changes (that's what `enforce()` rules catch at compile time), and it does NOT need configuration beyond severity.

## What you'll see

```
Integrity check:

  ✓ CLAUDE.md
  ✗ AGENTS.md — Compiled file was modified directly — edit the .spec.ts source and recompile
```

## Configuration

```json
{
  "rules": {
    "integrity": "warn"
  }
}
```

### Severity

| Value              | Behavior                                  |
| ------------------ | ----------------------------------------- |
| `"error"`          | `vigiles audit` exits non-zero (CI fails) |
| `"warn"` (default) | Prints warning, exits 0                   |
| `false`            | Skip integrity checks entirely            |

## What about stale specs?

Integrity catches hand-edits, not staleness. For "did the spec change but compile wasn't re-run?", the answer is:

- **Use `guard()`** — declare a guard rule that runs `vigiles compile` whenever any `.spec.ts` changes. The compile step runs at edit time (Claude Code hook) or commit time (husky), so committed markdown is always fresh.
- **Use CI** — run `vigiles compile` then `git diff --exit-code`. If the diff isn't empty, someone forgot to recompile.
- **Use `enforce()` / `file()` / `cmd()`** — these already catch disabled rules, missing files, and removed scripts at compile time.

The old `freshness` rule with `strict` and `input-hash` modes was reframed because every problem it caught is better handled by one of the above. Keep the rule narrow: it does one thing, and it does it for free.
