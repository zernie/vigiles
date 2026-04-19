# coverage

Enforce minimum spec coverage thresholds. Measures how much of the project surface is documented in specs.

## Configuration

```json
{
  "rules": {
    "coverage": ["warn", { "scripts": 50, "linterRules": 5 }]
  }
}
```

### Severity

| Value             | Behavior                                            |
| ----------------- | --------------------------------------------------- |
| `"error"`         | `vigiles audit` exits non-zero when below threshold |
| `"warn"`          | Prints warning when below threshold, exits 0        |
| `false` (default) | Skip coverage checks                                |

### Thresholds

| Option        | Type   | Description                                             |
| ------------- | ------ | ------------------------------------------------------- |
| `scripts`     | number | Min % of npm scripts documented in spec `commands`      |
| `linterRules` | number | Min % of enabled linter rules with `enforce()` in specs |

Both thresholds are optional. Omit a threshold to skip that metric.

## What it measures

### Script coverage

Compares `package.json` scripts against commands declared in specs. Checks both `npm run <script>` and `npm <script>` forms.

```
Script coverage: 4/5 (80%) (threshold: 50%)
  missing: deploy
```

### Linter rule coverage

Compares enabled linter rules (detected via `vigiles generate-types`) against `enforce()` declarations in specs. A rule is "covered" when the spec explicitly references it.

```
Linter rule coverage: 3/64 (5%) (threshold: 5%)
```

## Example

```json
{
  "rules": {
    "coverage": ["error", { "scripts": 80 }]
  }
}
```

This fails audit if more than 20% of npm scripts are undocumented in specs. Linter rule coverage is not checked (no `linterRules` threshold).

## Why

Specs that cover only half the project surface give agents an incomplete picture. Coverage thresholds ensure specs grow alongside the project. Start with low thresholds and raise them as specs mature.
