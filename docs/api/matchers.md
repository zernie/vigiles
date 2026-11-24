# `vigiles/vitest` and `vigiles/jest` — matchers

```ts
import "vigiles/vitest"; // or "vigiles/jest"
```

**Who it is for:** teams that already run their tests in vitest or jest and want `expect(result).toPass(check.tool("Bash"))` instead of calling `assertChecks`.

These two entries export **no names**. Importing one has a side effect: it registers the vigiles matchers with the runner's `expect` and adds their TypeScript types. vitest and jest are optional peer dependencies, and only the entry you import loads one.

| Runner | Register once in config                    | Or per file               |
| ------ | ------------------------------------------ | ------------------------- |
| vitest | `test: { setupFiles: ["vigiles/vitest"] }` | `import "vigiles/vitest"` |
| jest   | `setupFilesAfterEnv: ["vigiles/jest"]`     | `import "vigiles/jest"`   |

Without the entries, register by hand with `expect.extend(vigilesMatchers)` (`vigilesMatchers` is exported from [`vigiles`](vigiles.md)); you then get no types.

## The matchers

| Matcher          | Asserts                                                                          | Over                      |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------- |
| `toPass`         | one [check](vigiles.md#the-members-of-check) holds, with its own failure message | any result                |
| `toPassAll`      | every check in a list holds                                                      | any result                |
| `toHaveCreated`  | a file was created in the run's work directory                                   | a `runHarnessTest` result |
| `toBlock`        | the hook blocked                                                                 | a `runHook` result        |
| `toBeatBaseline` | an arm beats a baseline arm on a metric by more than a margin                    | an eval report            |

`toPass` covers the whole check vocabulary, so reach for it first; the others are shorthands.

```ts
import "vigiles/vitest";
import { test, expect } from "vitest";
import { runHook, check } from "vigiles";

test("the guard blocks --no-verify", () => {
  const r = runHook(
    '"$GUARD"',
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit --no-verify" },
    },
    { env: { GUARD: guardPath } },
  );

  expect(r).toBlock();
  expect(r).toPass(check.hookFired("PreToolUse", { blocked: true }));
});
```

`toBeatBaseline(baseline, arm, metric, by?)` takes the arm names and the metric name from an eval report, and fails when the difference is not greater than `by` (default 0):

```ts
expect(report).toBeatBaseline("vanilla", "gated", "caught");
```

The full list of checks is on [the `vigiles` page](vigiles.md); the typed matcher signatures are in the [API reference](https://zernie.github.io/vigiles/api/).
