/**
 * Tests for the cross-language symbol index (ast-grep): per-file extraction,
 * the project index, and bare/scoped resolution (unique/ambiguous/missing).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Lang } from "@ast-grep/napi";

import {
  definedSymbols,
  langForFile,
  fileDefinesSymbol,
  installedGrammars,
} from "./symbols.js";

test("extracts functions, constants, classes and methods (TypeScript)", () => {
  const defs = definedSymbols(
    `export function parseConfig(x) { return x; }
export const MAX = 3;
export class Widget { render() {} }`,
    Lang.TypeScript,
  );
  const names = defs.map((d) => d.name);
  assert.ok(names.includes("parseConfig"));
  assert.ok(names.includes("MAX"));
  assert.ok(names.includes("Widget"));
  const render = defs.find((d) => d.name === "render");
  assert.equal(render?.scope, "Widget"); // method carries enclosing class
  assert.ok((render?.line ?? 0) > 0); // 1-based line is populated
});

test("extracts Python defs including bare-assignment constants", () => {
  const defs = definedSymbols(
    `def parse_config(x):\n    return x\nMAX = 3\nclass Widget:\n    def render(self):\n        pass`,
    "python",
  );
  const names = defs.map((d) => d.name);
  assert.ok(names.includes("parse_config"));
  assert.ok(names.includes("MAX")); // assignment `left`, not a `name` field
  assert.equal(defs.find((d) => d.name === "render")?.scope, "Widget");
});

test("extracts Ruby class/method/constant", () => {
  const defs = definedSymbols(
    `class User\n  def full_name\n  end\nend\nMAX = 3`,
    "ruby",
  );
  assert.equal(defs.find((d) => d.name === "full_name")?.scope, "User");
  assert.ok(defs.some((d) => d.name === "MAX"));
});

test("langForFile maps extensions and skips unsupported", () => {
  // The optional grammars are installed in this repo's own tree, so they read as ready here.
  assert.deepEqual(langForFile("a.py"), { kind: "ready", lang: "python" });
  assert.deepEqual(langForFile("a.rs"), { kind: "ready", lang: "rust" });
  assert.deepEqual(langForFile("a.rb"), { kind: "ready", lang: "ruby" });
  assert.deepEqual(langForFile("a.txt"), { kind: "unsupported" });
  assert.equal(langForFile("a.ts").kind, "ready");
  assert.equal(langForFile("a.d.ts").kind, "ready");
});

// 🔴 THE THIRD CASE IS THE WHOLE POINT OF THE UNION, so it gets its own test rather than
// riding along above: a language this tool HANDLES whose optional package is absent must not
// come back as "unsupported". Before the union both answers were `null`, and both call sites
// printed "Unsupported language for symbol check" — an un-run check phrased as a verdict.
test("an absent optional grammar is 'grammar-missing', never 'unsupported'", () => {
  const seen = installedGrammars();
  assert.ok(
    seen.has("python"),
    "fixture assumption: this repo installs the grammars",
  );

  // The built-ins must not be able to land in that branch, whatever the optional set holds.
  for (const f of ["a.ts", "a.tsx", "a.js", "a.css"])
    assert.equal(langForFile(f).kind, "ready", f);

  // And the shape a consumer without the package would get, asserted on the type's own terms.
  const missing = {
    kind: "grammar-missing",
    id: "ruby",
    pkg: "@ast-grep/lang-ruby",
  } as const;
  assert.notEqual(missing.kind, "unsupported");
  assert.match(
    `Symbol not checked: the ${missing.id} grammar is not installed (npm i -D ${missing.pkg})`,
    /not installed \(npm i -D @ast-grep\/lang-ruby\)/,
  );
});

// 🔴 THE TEST ABOVE ASSERTS THE SHAPE, THIS ONE RUNS THE PATH. The grammars are optional peer
// dependencies (#257): a default `npm i vigiles` / `pnpm add vigiles` installs none of them, so the
// absent-module branch is what most consumers execute. This repo has them installed, so the only
// way to reach that branch honestly is a child process in which requiring them FAILS, the same way
// it fails in a consumer's tree (`MODULE_NOT_FOUND`). A stub inside this process would not do: the
// registration result is cached per process, and the other tests here need the real grammars.
test("with the grammar modules absent, .py/.rb/.rs say 'not installed' and never 'not defined'", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-sym-absent-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.py"), "def handler():\n    pass\n");
    writeFileSync(join(dir, "src", "app.rb"), "def handler\nend\n");
    writeFileSync(join(dir, "src", "app.rs"), "fn handler() {}\n");
    writeFileSync(join(dir, "src", "app.ts"), "export function handler() {}\n");
    // Make every `@ast-grep/lang-*` resolution fail exactly as an uninstalled package does.
    const block = join(dir, "block-grammars.cjs");
    writeFileSync(
      block,
      `const Module = require("node:module");\n` +
        `const orig = Module._resolveFilename;\n` +
        `Module._resolveFilename = function (req, ...rest) {\n` +
        `  if (/^@ast-grep\\/lang-/.test(req)) {\n` +
        `    const e = new Error("Cannot find module '" + req + "'");\n` +
        `    e.code = "MODULE_NOT_FOUND";\n` +
        `    throw e;\n` +
        `  }\n` +
        `  return orig.call(this, req, ...rest);\n` +
        `};\n`,
    );
    const probe = join(dir, "probe.ts");
    const md = ["py", "rb", "rs", "ts"]
      .flatMap((x) => [
        `- \`vigiles:symbol src/app.${x}#handler\``,
        `- \`vigiles:symbol src/app.${x}#missing\``,
      ])
      .join("\n");
    writeFileSync(
      probe,
      `import { verifySymbolRefs } from ${JSON.stringify(resolve("src/core/refs.ts"))};\n` +
        `import { installedGrammars } from ${JSON.stringify(resolve("src/core/symbols.ts"))};\n` +
        `console.log(JSON.stringify({\n` +
        `  installed: [...installedGrammars()],\n` +
        `  errors: verifySymbolRefs(${JSON.stringify(md)}, ${JSON.stringify(dir)})\n` +
        `    .map((e) => e.file + "#" + e.symbol + " :: " + e.reason),\n` +
        `}));\n`,
    );
    const r = spawnSync(
      process.execPath,
      ["--require", block, "--import", "tsx", probe],
      { encoding: "utf8", cwd: resolve(".") },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as {
      installed: string[];
      errors: string[];
    };

    // The blocker actually blocked — otherwise every assertion below is vacuous.
    assert.deepEqual(out.installed, []);

    const pkgFor = { py: "python", rb: "ruby", rs: "rust" } as const;
    for (const [ext, lang] of Object.entries(pkgFor)) {
      for (const sym of ["handler", "missing"]) {
        const line = out.errors.find((e) =>
          e.startsWith(`src/app.${ext}#${sym} ::`),
        );
        assert.ok(line, `${ext}#${sym} must be reported, not silently passed`);
        assert.match(
          line,
          new RegExp(
            `the ${lang} grammar is not installed \\(npm i -D @ast-grep/lang-${lang}\\)`,
          ),
        );
        // The two answers must stay different: an un-run check is not a missing symbol.
        assert.doesNotMatch(line, /is not defined in/);
        assert.doesNotMatch(line, /Unsupported language/);
      }
    }

    // The built-in grammars are untouched by the absence: a real hit passes, a real miss fails.
    assert.ok(!out.errors.some((e) => e.startsWith("src/app.ts#handler ::")));
    assert.ok(
      out.errors.includes(
        'src/app.ts#missing :: "missing" is not defined in src/app.ts',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileDefinesSymbol checks one named file (no project index)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-sym-file-"));
  try {
    mkdirSync(join(dir, "src"));
    const f = join(dir, "src", "config.ts");
    writeFileSync(
      f,
      "export function parseConfig(){}\nexport const MAX = 1;\n",
    );
    assert.equal(fileDefinesSymbol(f, "parseConfig"), true);
    assert.equal(fileDefinesSymbol(f, "MAX"), true);
    assert.equal(fileDefinesSymbol(f, "missingSymbol"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileDefinesSymbol falls back to a co-located .d.ts / .rbi", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-sym-decl-"));
  try {
    mkdirSync(join(dir, "lib"));
    // The source defines it dynamically (not statically visible)...
    writeFileSync(join(dir, "lib", "dyn.js"), "module.exports = build();\n");
    // ...but a co-located .d.ts declares it.
    writeFileSync(
      join(dir, "lib", "dyn.d.ts"),
      "export function dynamicFn(): void;\n",
    );
    assert.equal(
      fileDefinesSymbol(join(dir, "lib", "dyn.js"), "dynamicFn"),
      true,
    );
    assert.equal(fileDefinesSymbol(join(dir, "lib", "dyn.js"), "nope"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
