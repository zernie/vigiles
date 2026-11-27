// @ts-check
/**
 * Write `dist/eval-engine.json`: the fingerprint of every emitted module a run
 * of `vigiles eval` reaches, which keys a regression case's lock (vigiles#416).
 *
 * DERIVED, NOT LISTED: the walk (`src/core/eval-engine.ts`) parses each module of
 * `dist/` from the two roots that run an eval — the eval program and the
 * `vigiles/eval` door — and follows every literal import. The hash is over the
 * EMITTED bytes, so it changes exactly when what runs changes. Bare
 * dependencies are not hashed (stated in the walk's header).
 *
 * `.mjs` because it runs before anything compiles it, beside the other build
 * steps here. Run from `npm run build`, after `tsc`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { engineHash, walkEngine } = await import(
  join(dist, "core", "eval-engine.js")
);

const walk = walkEngine(
  [join(dist, "eval-program.js"), join(dist, "entries", "eval.js")],
  {
    read: (/** @type {string} */ p) => readFileSync(p, "utf-8"),
    resolve: (/** @type {string} */ from, /** @type {string} */ spec) => {
      if (!spec.startsWith(".")) return undefined;
      const p = join(dirname(from), spec);
      return existsSync(p) ? p : undefined;
    },
  },
);
/** @type {readonly string[]} */
const files = walk.files;
const hash = engineHash(
  files.map((p) => ({
    path: relative(dist, p),
    text: readFileSync(p, "utf-8"),
  })),
);
writeFileSync(
  join(dist, "eval-engine.json"),
  JSON.stringify({ hash, modules: files.length }, null, 2) + "\n",
);
console.log(
  `[build-eval-engine] → dist/eval-engine.json (${String(files.length)} modules)`,
);
