/**
 * Tests for the cross-language symbol index (ast-grep): per-file extraction,
 * the project index, and bare/scoped resolution (unique/ambiguous/missing).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Lang } from "@ast-grep/napi";

import { definedSymbols, langForFile, fileDefinesSymbol } from "./symbols.js";

test("extracts functions, constants, classes and methods (TypeScript)", async () => {
  const defs = await definedSymbols(
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

test("extracts Python defs including bare-assignment constants", async () => {
  const defs = await definedSymbols(
    `def parse_config(x):\n    return x\nMAX = 3\nclass Widget:\n    def render(self):\n        pass`,
    "python",
  );
  const names = defs.map((d) => d.name);
  assert.ok(names.includes("parse_config"));
  assert.ok(names.includes("MAX")); // assignment `left`, not a `name` field
  assert.equal(defs.find((d) => d.name === "render")?.scope, "Widget");
});

test("extracts Ruby class/method/constant", async () => {
  const defs = await definedSymbols(
    `class User\n  def full_name\n  end\nend\nMAX = 3`,
    "ruby",
  );
  assert.equal(defs.find((d) => d.name === "full_name")?.scope, "User");
  assert.ok(defs.some((d) => d.name === "MAX"));
});

test("langForFile maps extensions and skips unsupported", async () => {
  // The WASM grammars ship as a regular dependency, so they load and read as ready.
  assert.deepEqual(await langForFile("a.py"), {
    kind: "ready",
    lang: "python",
  });
  assert.deepEqual(await langForFile("a.rs"), { kind: "ready", lang: "rust" });
  assert.deepEqual(await langForFile("a.rb"), { kind: "ready", lang: "ruby" });
  assert.deepEqual(await langForFile("a.txt"), { kind: "unsupported" });
  assert.equal((await langForFile("a.ts")).kind, "ready");
  assert.equal((await langForFile("a.d.ts")).kind, "ready");
});

// 🔴 PARITY WITH THE NATIVE GRAMMARS (#257). Python/Ruby/Rust moved from `@ast-grep/lang-*`
// (native, postinstall) to the WASM builds in `@vscode/tree-sitter-wasm`. `golden.json` is the
// OLD implementation's output on the three fixtures, generated before `lang-*` was removed; each
// fixture exercises every node kind of its grammar that carries a `name` field or a `left` field
// (the two things the walk records). The same walk over the same grammar must give the same list.
// Measured beyond the fixtures, same day: identical output on 574 CPython 3.12 stdlib files
// (65 176 definitions) and 1 000 Ruby files (50 455).
const FIXTURES = resolve("src/core/__fixtures__/symbols");
const golden = JSON.parse(
  readFileSync(join(FIXTURES, "golden.json"), "utf8"),
) as Record<"python" | "ruby" | "rust", string[]>;
const flat = async (
  file: string,
  lang: "python" | "ruby" | "rust",
): Promise<string[]> =>
  (await definedSymbols(readFileSync(join(FIXTURES, file), "utf8"), lang))
    .map((d) => `${String(d.line)}:${d.kind}:${d.scope}:${d.name}`)
    .sort();

test("Python definitions match the native grammar exactly", async () => {
  assert.deepEqual(
    await flat("sample.py", "python"),
    [...golden.python].sort(),
  );
});

test("Ruby definitions match the native grammar exactly", async () => {
  assert.deepEqual(await flat("sample.rb", "ruby"), [...golden.ruby].sort());
});

// Rust is NOT the same grammar: `lang-rust` was tree-sitter-rust 0.23.2, the WASM build is a 0.24
// commit, and 0.24 rewrote generic parameters (`<T: Clone>` is a `type_parameter` with a `name`,
// not a `constrained_type_parameter` with a `left`; lifetimes and range patterns gained fields).
// So the delta is pinned HERE, entry by entry: anything else changing is a regression. Of the
// four old-only entries, three reappear under the new kind with the same name; the fourth,
// "T: Clone", was never a name (the old walk took the text of a whole bound). On 584 files of
// serde/regex/anyhow/tokio the diff was confined to these kinds, and the only names the old
// code found and the new does not were four such bound texts ("E: Error", "U: ?Sized").
test("Rust definitions match the native grammar except the pinned 0.24 generic-parameter delta", async () => {
  const now = await flat("sample.rs", "rust");
  const before = new Set(golden.rust);
  assert.deepEqual([...golden.rust].filter((x) => !now.includes(x)).sort(), [
    "46:constrained_type_parameter::T",
    "50:constrained_type_parameter::T",
    "50:optional_type_parameter::T: Clone",
    "66:constrained_type_parameter::I",
  ]);
  assert.deepEqual(now.filter((x) => !before.has(x)).sort(), [
    "46:lifetime_parameter::'a",
    "46:type_parameter::T",
    "50:type_parameter::T",
    "61:range_pattern::LOW",
    "66:type_parameter::I",
  ]);
});

test("fileDefinesSymbol resolves real .py/.rb/.rs hits and misses", async () => {
  for (const [file, hit] of [
    ["sample.py", "parse_config"],
    ["sample.rb", "full_name"],
    ["sample.rs", "parse_config"],
  ] as const) {
    assert.equal(
      await fileDefinesSymbol(join(FIXTURES, file), hit),
      true,
      file,
    );
    assert.equal(
      await fileDefinesSymbol(join(FIXTURES, file), "no_such_symbol"),
      false,
      file,
    );
  }
});

// 🔴 THE LOAD-FAILURE PATH, RUN FOR REAL. With the grammars as a plain dependency this branch
// should be unreachable in practice — but if the runtime cannot load, the answer must be "not
// checked" carrying the loader's own error, never "not defined" (a verdict about a check that
// did not run) and never an install instruction. The only honest way to reach it here is a
// child process in which resolving the package FAILS exactly as an absent one does.
test("when the WASM runtime cannot load, .py/.rb/.rs say 'not checked: <error>' and never 'not defined'", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-sym-absent-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.py"), "def handler():\n    pass\n");
    writeFileSync(join(dir, "src", "app.rb"), "def handler\nend\n");
    writeFileSync(join(dir, "src", "app.rs"), "fn handler() {}\n");
    writeFileSync(join(dir, "src", "app.ts"), "export function handler() {}\n");
    const block = join(dir, "block-wasm.cjs");
    writeFileSync(
      block,
      `const Module = require("node:module");\n` +
        `const orig = Module._resolveFilename;\n` +
        `Module._resolveFilename = function (req, ...rest) {\n` +
        `  if (req === "@vscode/tree-sitter-wasm") {\n` +
        `    const e = new Error("Cannot find module '" + req + "'");\n` +
        `    e.code = "MODULE_NOT_FOUND";\n` +
        `    throw e;\n` +
        `  }\n` +
        `  return orig.call(this, req, ...rest);\n` +
        `};\n`,
    );
    const probe = join(dir, "probe.mts"); // .mts: the probe awaits at top level
    const md = ["py", "rb", "rs", "ts"]
      .flatMap((x) => [
        `- \`vigiles:symbol src/app.${x}#handler\``,
        `- \`vigiles:symbol src/app.${x}#missing\``,
      ])
      .join("\n");
    writeFileSync(
      probe,
      // refs.ts is CommonJS under tsx: from an ES module its exports arrive on `default`.
      `import refs from ${JSON.stringify(resolve("src/core/refs.ts"))};\n` +
        `const { verifySymbolRefs } = refs;\n` +
        `const errors = await verifySymbolRefs(${JSON.stringify(md)}, ${JSON.stringify(dir)});\n` +
        `console.log(JSON.stringify(errors.map((e) => e.file + "#" + e.symbol + " :: " + e.reason)));\n`,
    );
    const r = spawnSync(
      process.execPath,
      ["--require", block, "--import", "tsx", probe],
      { encoding: "utf8", cwd: resolve(".") },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const errors = JSON.parse(
      r.stdout.trim().split("\n").pop() ?? "",
    ) as string[];

    for (const [ext, lang] of [
      ["py", "python"],
      ["rb", "ruby"],
      ["rs", "rust"],
    ] as const) {
      for (const sym of ["handler", "missing"]) {
        const line = errors.find((e) =>
          e.startsWith(`src/app.${ext}#${sym} ::`),
        );
        assert.ok(line, `${ext}#${sym} must be reported, not silently passed`);
        assert.equal(
          line,
          `src/app.${ext}#${sym} :: Symbol not checked: the ${lang} grammar failed to load: ` +
            `Cannot find module '@vscode/tree-sitter-wasm'`,
        );
        // An un-run check is not a missing symbol, and the user has nothing to install.
        assert.doesNotMatch(line, /is not defined in/);
        assert.doesNotMatch(line, /Unsupported language/);
        assert.doesNotMatch(line, /npm i|pnpm add|install/);
      }
    }

    // The napi grammars are untouched by the failure: a real hit passes, a real miss fails.
    assert.ok(!errors.some((e) => e.startsWith("src/app.ts#handler ::")));
    assert.ok(
      errors.includes(
        'src/app.ts#missing :: "missing" is not defined in src/app.ts',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileDefinesSymbol checks one named file (no project index)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-sym-file-"));
  try {
    mkdirSync(join(dir, "src"));
    const f = join(dir, "src", "config.ts");
    writeFileSync(
      f,
      "export function parseConfig(){}\nexport const MAX = 1;\n",
    );
    assert.equal(await fileDefinesSymbol(f, "parseConfig"), true);
    assert.equal(await fileDefinesSymbol(f, "MAX"), true);
    assert.equal(await fileDefinesSymbol(f, "missingSymbol"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileDefinesSymbol falls back to a co-located .d.ts / .rbi", async () => {
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
      await fileDefinesSymbol(join(dir, "lib", "dyn.js"), "dynamicFn"),
      true,
    );
    assert.equal(
      await fileDefinesSymbol(join(dir, "lib", "dyn.js"), "nope"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
