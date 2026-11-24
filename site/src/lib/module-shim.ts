/**
 * Browser stand-in for `node:module`, aliased in `vite.aliases.ts`.
 *
 * The engine is an ES module package. A few of its modules load a library
 * LAZILY, with `createRequire(import.meta.url)("markdown-it")`, so a compiled
 * hook in Node does not pay for a parser it never uses (see the header of
 * `src/core/markdown.ts`). The browser has no `require`, so here every such
 * library is bundled up front and handed out by name — the same objects Node's
 * `require` returns. A name the audit reaches but this table lacks throws,
 * naming this file, rather than failing somewhere inside the engine.
 */
import * as iarnaToml from "@iarna/toml";
import * as jsYaml from "js-yaml";
import markdownIt from "markdown-it";
import * as minimatch from "minimatch";
import mvdanSh from "mvdan-sh";

const BUNDLED: Readonly<Record<string, unknown>> = {
  "@iarna/toml": iarnaToml,
  "js-yaml": jsYaml,
  "markdown-it": markdownIt,
  minimatch,
  "mvdan-sh": mvdanSh,
};

export function createRequire(_from: string | URL): (id: string) => unknown {
  return (id) => {
    if (Object.hasOwn(BUNDLED, id)) return BUNDLED[id];
    throw new Error(
      `the in-browser audit reached require("${id}"), which site/src/lib/module-shim.ts does not bundle`,
    );
  };
}
