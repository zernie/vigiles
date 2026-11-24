#!/usr/bin/env node
/**
 * check-dist-types.mjs — the built `.d.ts` of every public entry must type-check.
 *
 * Why: `stripInternal` removes every `@internal` declaration from the published
 * `.d.ts`. A public signature that still NAMES one of them does not fail in the
 * source tree (the source has the type) and does not fail for a consumer with
 * `skipLibCheck` (the name quietly degrades). It is a hole shipped silently, and
 * this is the one place it surfaces: type-check what we publish, with
 * `skipLibCheck` off, starting from each entry in package.json `exports` (tsc
 * follows imports, so everything reachable from a door is checked and nothing
 * unreachable is).
 *
 * Needs a built `dist/` (`npm run build`). Usage: node scripts/check-dist-types.mjs [root]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? ".");
/** This repository, where `tsc` and `@types` live, even when `root` is a fixture. */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** The built declaration file one `exports` value points at. */
function declarationOf(value) {
  const target =
    typeof value === "string" ? value : (value.types ?? value.default);
  return target.replace(/\.mjs$/, ".d.mts").replace(/\.js$/, ".d.ts");
}

const files = Object.values(pkg.exports).map((v) =>
  path.join(root, declarationOf(v)),
);
const config = path.join(
  mkdtempSync(path.join(tmpdir(), "dist-types-")),
  "tsconfig.json",
);
writeFileSync(
  config,
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      types: ["node"],
      typeRoots: [path.join(repo, "node_modules", "@types")],
    },
    files,
  }),
);

const tsc = path.join(repo, "node_modules", ".bin", "tsc");
const r = spawnSync(tsc, ["-p", config], { encoding: "utf8" });
if (r.status !== 0) {
  console.error(r.stdout + r.stderr);
  console.error(
    "dist-types: a built .d.ts does not type-check. A public signature probably names a\n" +
      "declaration tagged @internal (stripInternal removed it): drop the tag or stop exposing the type.",
  );
  process.exit(1);
}
console.log(
  `dist-types: ${String(files.length)} entries type-check (skipLibCheck off).`,
);
