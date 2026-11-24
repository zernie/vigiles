/**
 * `mvdan-sh` ships no type declarations. The engine reads it as `unknown` and
 * narrows it where it parses (`src/core/bash-effects.ts`); the browser shim only
 * hands the module through, so `unknown` is the honest type here too.
 */
declare module "mvdan-sh" {
  const sh: unknown;
  export default sh;
}
