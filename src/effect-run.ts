/**
 * Run an Effect program and get a plain Promise back: the one edge where the
 * eval runner's Effect code becomes a value (Effect never reaches an exported
 * type). Shared by the trial pool (`src/eval.ts`) and the regression case's
 * scorer (`src/eval-regression-case.ts`), so neither imports the other.
 */
type EffectModule = typeof import("effect");

/**
 * Run the Effect program `build` returns; `signal`, when given, interrupts it.
 * Rejects with the program's own error, not Effect's wrapper: callers match on it.
 *
 * `effect` loads here, by a dynamic import kept on purpose: it is ESM-only, and
 * the CommonJS copy this package ships for Jest is loaded by Jest's own module
 * system, which cannot `require` ESM. Loading it on first use also keeps it out
 * of every import that never runs an eval.
 */
export async function runEffect<A>(
  build: (
    fx: Readonly<EffectModule>,
  ) => Readonly<import("effect").Effect.Effect<A, unknown>>,
  signal?: Readonly<AbortSignal>,
): Promise<A> {
  const fx = await import("effect");
  const exit = await fx.Effect.runPromiseExit(
    build(fx),
    signal === undefined ? undefined : { signal },
  );
  if (fx.Exit.isSuccess(exit)) return exit.value;
  throw fx.Cause.squash(exit.cause);
}
