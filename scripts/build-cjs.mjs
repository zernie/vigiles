// @ts-check
/**
 * The CommonJS copy of every public entry, for test runners that `require`.
 *
 * vigiles is an ES module package. Node itself can `require` it (20.19+ and
 * 22.12+), but Jest runs test files through its own CommonJS loader, which
 * cannot load an ES module without an experimental flag — so `require("vigiles")`
 * and the `vigiles/jest` setup file would fail for every Jest user. Each entry in
 * package.json `exports` therefore has a `require` target: one esbuild bundle of
 * vigiles' own code, with npm dependencies left as `require` calls exactly as
 * before.
 *
 * The bundles are checked here, not trusted: each is `require`d and must expose
 * the same export names as its ES module entry, or the build fails.
 *
 * Runs after `tsc` in `npm run build`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const require = createRequire(import.meta.url);

/** @returns {{ name: string, esm: string, cjs: string }[]} */
const entries = () =>
  Object.entries(pkg.exports).flatMap(([name, target]) =>
    typeof target === "object" && typeof target.require === "string"
      ? [{ name, esm: target.import, cjs: target.require }]
      : [],
  );

// `import.meta` does not exist in CommonJS: rebuild it from `__filename`.
const BANNER =
  'const __vigilesImportMetaUrl = require("node:url").pathToFileURL(__filename).href;';

/** @param {{ esm: string, cjs: string }} e */
const bundle = (e) =>
  build({
    entryPoints: [e.esm],
    outfile: e.cjs,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "external",
    banner: { js: BANNER },
    define: {
      "import.meta.url": "__vigilesImportMetaUrl",
      "import.meta.dirname": "__dirname",
      "import.meta.filename": "__filename",
    },
    logLevel: "warning",
  });

// Entries that load only inside their test runner: `vigiles/jest` imports
// `@jest/globals`, which Jest provides. `npm run test:jest` checks it instead,
// by loading it as a user's Jest setup does.
const RUNNER_ONLY = new Set(["./jest"]);

/** @param {{ name: string, esm: string, cjs: string }} e */
const sameExports = async (e) => {
  if (RUNNER_ONLY.has(e.name)) return null;
  const esm = Object.keys(await import(pathToFileURL(e.esm).href)).sort();
  const cjs = Object.keys(require(`./${e.cjs.replace(/^\.\//, "../")}`))
    .filter((k) => k !== "__esModule" && k !== "default")
    .sort();
  const missing = esm.filter((k) => k !== "default" && !cjs.includes(k));
  return missing.length === 0
    ? null
    : `${e.name}: the CommonJS copy lacks ${missing.join(", ")}`;
};

const list = entries();
await Promise.all(list.map(bundle));
const problems = (await Promise.all(list.map(sameExports))).filter(
  (p) => p !== null,
);
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ build-cjs: ${p}`);
  process.exit(1);
}
console.log(
  `✓ build-cjs: ${String(list.length)} entries have a CommonJS copy with the same exports`,
);
