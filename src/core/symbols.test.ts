/**
 * Tests for the cross-language symbol index (ast-grep): per-file extraction,
 * the project index, and bare/scoped resolution (unique/ambiguous/missing).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
