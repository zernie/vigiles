/**
 * The eval engine's walk: it follows literal imports and re-exports, skips
 * type-only ones, reports each computed `import()`, and over the real eval
 * roots finds only the computed imports that are allowed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  engineHash,
  moduleRefs,
  walkEngine,
  type WalkIo,
} from "./eval-engine.js";

describe("moduleRefs", () => {
  it("reads literal specifiers, skips type-only ones, places a computed import()", () => {
    const refs = moduleRefs(
      "m.js",
      [
        'import { a } from "./a.js";',
        'import type { T } from "./t.js";',
        'export { b } from "./b.js";',
        'export type { U } from "./u.js";',
        'const c = await import("./c.js");',
        "const d = await import(where);",
      ].join("\n"),
    );
    // Guards: a type-only import erases at emit, so it is not part of the engine.
    expect(refs.literal).toEqual(["./a.js", "./b.js", "./c.js"]);
    // Guards: a computed specifier cannot be followed, so its line is reported.
    expect(refs.dynamic).toEqual([6]);
  });
});

/** A walk over an in-memory module graph. */
function memoryIo(files: Readonly<Record<string, string>>): WalkIo {
  return {
    read: (p) => files[p] ?? "",
    resolve: (_from, spec) =>
      spec.startsWith(".") ? spec.slice(2) : undefined,
  };
}

describe("walkEngine", () => {
  it("follows relative specifiers once each, through a cycle, and not bare ones", () => {
    const walk = walkEngine(
      ["root.js"],
      memoryIo({
        "root.js": 'import "./a.js"; import "zod"; import "./b.js";',
        "a.js": 'import "./b.js";',
        "b.js": 'import "./a.js"; await import(x);',
      }),
    );
    // Guards: every reached module once, sorted; a bare dependency is not hashed.
    expect(walk.files).toEqual(["a.js", "b.js", "root.js"]);
    expect(walk.dynamic).toEqual([{ file: "b.js", line: 1 }]);
  });
});

describe("engineHash", () => {
  it("changes with a module's bytes and with its path", () => {
    const one = [{ path: "a.js", text: "x" }];
    // Guards: an edit to any reached module makes a new fingerprint.
    expect(engineHash(one)).not.toBe(engineHash([{ path: "a.js", text: "y" }]));
    expect(engineHash(one)).not.toBe(engineHash([{ path: "b.js", text: "x" }]));
    expect(engineHash(one)).toBe(engineHash([{ path: "a.js", text: "x" }]));
  });
});

const SRC = join(import.meta.dirname, "..");

/** The source twin of the emitted graph: `./x.js` is `./x.ts` here. */
const srcIo: WalkIo = {
  read: (p) => readFileSync(p, "utf-8"),
  resolve: (from, spec) => {
    if (!spec.startsWith(".")) return undefined;
    const js = join(dirname(from), spec);
    const ts = js.endsWith(".js") ? `${js.slice(0, -3)}.ts` : js;
    return existsSync(ts) ? ts : undefined;
  },
};

describe("the eval engine's roots", () => {
  it("reach a computed import() only where one is allowed", () => {
    const walk = walkEngine(
      [join(SRC, "eval-program.ts"), join(SRC, "entries/eval.ts")],
      srcIo,
    );
    const files = new Set(walk.dynamic.map((d) => relative(SRC, d.file)));
    // Guards: the eval file the user wrote (loaded by path), and a bare package
    // loaded by a constant name. A new computed import in the engine is a module
    // the fingerprint cannot see: it must be added here on purpose, or removed.
    expect(files).toEqual(new Set(["core/tree-sitter-wasm.ts", "eval-run.ts"]));
  });
});
