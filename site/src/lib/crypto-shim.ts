/**
 * Browser stand-in for `node:crypto`, aliased in `vite.aliases.ts`.
 *
 * `src/core/hash.ts` imports `createHash`, and an ES module import must resolve
 * at build time even when the browser never calls it. The in-browser audit does
 * not hash (with the old CommonJS engine a call here was already an error), so
 * this stub only makes that error say what happened.
 */
export function createHash(algorithm: string): never {
  throw new Error(
    `the in-browser audit reached createHash("${algorithm}"), which site/src/lib/crypto-shim.ts does not implement`,
  );
}
