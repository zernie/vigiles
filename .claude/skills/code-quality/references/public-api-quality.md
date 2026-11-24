# Public-API quality

**Principle.** A public export is a **contract**: it should be small, precisely typed, stable in shape, and free of leaked internals. Every symbol you export is something you must not break later — so export the fewest, most-precise things that let a caller do the job, and nothing else.

In this repo the surface is tracked by **API Extractor** (`api-surface/*.api.md`, checked in CI), so a widened surface shows up as a report diff — treat that diff as the review of your contract.

## The smells

- **Exporting a helper only the tests use** (a builder, a parser). Keep it module-private; the test imports the module, not the public barrel.
- A parameter typed **`string` that actually means an enum** (`mode: string` → `mode: "enforce" | "observe"`).
- Returning **`any` / a broad structural type** where a named type or union belongs.
- An **optional-field soup** on a public interface where a tagged union would say which fields go together (see make-illegal-states-irrepresentable).
- A public function that takes **10 positional args** — bundle into an options object (and it stays under the max-params lint too).

## Techniques

- **Branded types** for semantic strings (a `Port`, a `Sha256`, a `VerifiedPath`) so a raw string can't be passed where a validated one is required.
- **Options object** over positional args; mark the truly-optional ones `?:`.
- **Narrow return types** — a union or a named interface, never `any`.
- **Quarantine unstable surface**: an experimental/draft export goes behind a dedicated subpath + a loud name (this repo: `vigiles/experimental` + the `experimental_` prefix + `@experimental` JSDoc), so the import itself signals "may change."

## Real example (from the R3 work)

The disposable-service tier is genuinely useful but unstable, so it is **not** on the `vigiles` root surface. It ships on `vigiles/fixtures` (test infrastructure) as `experimental_startServices` / `experimental_dockerRuntime`, the prefix marking every call site, while the internal `dockerRunArgs` / `parseDockerPort` helpers stay **unexported** (tests import the module directly). The public surface is four symbols + the port interface, not the whole module.

## Rule of thumb

Before adding an `export`, ask: does a caller genuinely need this, and is its type as precise as I can make it? If it's for a test, don't export it. If it's unstable, quarantine it. If it's `string` but means a fixed set, make it a union. The api-extractor diff is your contract review — read it.
