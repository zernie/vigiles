/**
 * The `typescript` package, loaded on first use instead of at import.
 *
 * `typescript` is a 9 MB CommonJS file. Imported from an ES module at the top
 * of a file, it is parsed on EVERY start of the CLI, `--help` included, at
 * about 380 ms — the ES-module loader scans a CommonJS file for its exports
 * before it runs it. Most verbs never touch it. Reading it through
 * `require` on first property access costs about 200 ms, and only for a run
 * that really parses TypeScript.
 *
 * `ts` is a stand-in with the package's own type: every property read is
 * forwarded to the real module, loaded once. A file that needs a type writes
 * `import type TS from "typescript"`; the graph test in
 * `src/hook-runtime-graph.test.ts` pins that `--help` does not load it.
 */
import { createRequire } from "node:module";
import type TS from "typescript";

type Typescript = Readonly<typeof TS>;

/** Node's own module cache makes every call after the first a lookup. */
const load: (id: "typescript") => Typescript = createRequire(import.meta.url);

/**
 * The stand-in. Its target is never read — every trap forwards to the real
 * module — so the empty object only has to exist, and `Proxy` cannot be told
 * that without an assertion.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the target is a placeholder no trap reads; see above.
const placeholder = Object.freeze({}) as Typescript;

export const ts: Typescript = new Proxy(placeholder, {
  get: (_target, key): unknown => Reflect.get(load("typescript"), key),
  has: (_target, key) => Reflect.has(load("typescript"), key),
});
