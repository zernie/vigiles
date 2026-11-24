/**
 * The export-surface gates: what keeps the public API from growing back.
 *
 * One test file for the gates a unit test can decide (`scripts/check.mjs` runs
 * the two that need a build: API Extractor's release-tag check and
 * `check-dist-types.mjs`, each proved here against a fixture that must FAIL):
 *
 *   1. every export carries a release tag   — the fixture below fails untagged
 *   2. one name, one entry                  — no name in two entries' exports
 *   3. a function budget per entry          — api-surface/budget.json
 *   4. STABILITY.md lists every entry       — the table equals package.json exports
 *
 * Exports are read from the SOURCE with the TypeScript checker
 * (scripts/lib/entry-exports.mjs): runtime and type exports of each key of
 * package.json `exports`, `export *` included.
 */
import { beforeAll, describe, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Extractor } from "@microsoft/api-extractor";

import { budgetNames, entryExports } from "./lib/entry-exports.mjs";
import { configFor } from "./lib/api-extractor-config.mjs";

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  exports: Record<string, unknown>;
};

type Entries = ReturnType<typeof entryExports>;
let entries: Entries;
beforeAll(() => {
  entries = entryExports(ROOT);
}, 120_000);

describe("gate 2: one name, one entry", () => {
  /**
   * Names that are deliberately reachable from two entries, each with its
   * reason. This list may only SHRINK: a name that stops colliding must be
   * deleted from it (the second test), and a new collision is never added here
   * without a reviewer reading the reason.
   */
  const SHARED: Readonly<Record<string, string>> = {
    experimental_agent:
      "vigiles/spec is the generic builder; vigiles/claude-code is the same name typed against Claude Code's tool catalog (a `purity` check). Chosen by import path on purpose; renaming one is not a breaking change (experimental_) and is the open decision.",
    experimental_skill:
      "same pair as experimental_agent: generic in vigiles/spec, catalog-typed in vigiles/claude-code.",
  };

  function homes(): Map<string, string[]> {
    const byName = new Map<string, string[]>();
    for (const [key, e] of entries) {
      for (const name of new Set([...e.values.keys(), ...e.types])) {
        byName.set(name, [...(byName.get(name) ?? []), key]);
      }
    }
    return byName;
  }

  test("no runtime or type name is exported by two entries (bar the reasoned list)", () => {
    const collisions = [...homes()]
      .filter(([name, keys]) => keys.length > 1 && !(name in SHARED))
      .map(([name, keys]) => `${name}: ${keys.join(", ")}`);
    assert.deepEqual(
      collisions,
      [],
      "a name has ONE home: move it to its audience's entry and delete the other export",
    );
  });

  test("every name on the shared list still collides (delete it when it stops)", () => {
    const byName = homes();
    for (const name of Object.keys(SHARED)) {
      assert.ok(
        (byName.get(name) ?? []).length > 1,
        `${name} is exported by one entry now: delete it from SHARED`,
      );
    }
  });

  test("the matcher entries export nothing, so they cannot collide", () => {
    for (const key of ["./vitest", "./jest"]) {
      const e = entries.get(key);
      assert.ok(e, `${key} is an entry`);
      assert.equal(e.values.size + e.types.size, 0, `${key} re-exports a name`);
    }
  });
});

describe("gate 3: a function budget per entry", () => {
  interface Budget {
    entries: Record<string, { ceiling: number; grandfathered: string[] }>;
  }
  const budget = JSON.parse(
    readFileSync(join(ROOT, "api-surface", "budget.json"), "utf-8"),
  ) as Budget;

  test("budget.json has exactly one row per entry", () => {
    assert.deepEqual(
      Object.keys(budget.entries).sort(),
      Object.keys(pkg.exports).sort(),
    );
  });

  test("an entry with ten functions or fewer has no grandfather list; its ceiling is its count", () => {
    for (const [key, e] of entries) {
      const n = budgetNames(e).length;
      const row = budget.entries[key];
      assert.ok(row, `${key} has a budget row`);
      if (n <= 10) {
        assert.deepEqual(
          row.grandfathered,
          [],
          `${key}: nothing to grandfather`,
        );
      }
    }
  });

  test("each entry's runtime exports fit ceiling + grandfathered, and the lists only shrink", () => {
    for (const [key, e] of entries) {
      const row = budget.entries[key];
      assert.ok(row, `${key} has a budget row`);
      const names = budgetNames(e);
      const exported = new Set(names);

      const gone = row.grandfathered.filter((n) => !exported.has(n));
      assert.deepEqual(
        gone,
        [],
        `${key}: ${gone.join(", ")} no longer exported: delete from grandfathered in api-surface/budget.json`,
      );

      const counted = names.filter((n) => !row.grandfathered.includes(n));
      assert.ok(
        counted.length <= row.ceiling,
        `${key} exports ${String(counted.length)} functions past its grandfathered ones, over its ceiling of ${String(row.ceiling)}: ` +
          `a new export must move to its audience's entry or replace one (${counted.slice(-3).join(", ")}...). ` +
          `Do not raise the ceiling or grow the grandfather list.`,
      );
      assert.ok(
        counted.length >= row.ceiling,
        `${key} is under its ceiling (${String(counted.length)} < ${String(row.ceiling)}): lower the ceiling to ${String(counted.length)} in api-surface/budget.json so the room is not spent later`,
      );
    }
  });

  test("a grandfather list never holds more names than the entry is over its ceiling", () => {
    // Together with the test above this is "the list may only shrink": growing it
    // means un-grandfathering a name that is still exported, which lands it back
    // in the count and trips the ceiling.
    for (const [key, e] of entries) {
      const row = budget.entries[key];
      assert.ok(row, `${key} has a budget row`);
      const over = Math.max(0, budgetNames(e).length - row.ceiling);
      assert.ok(
        row.grandfathered.length <= over,
        `${key}: ${String(row.grandfathered.length)} grandfathered but only ${String(over)} over the ceiling`,
      );
    }
  });

  test("the members of check count toward the root", () => {
    const root = entries.get(".");
    assert.ok(root);
    const names = budgetNames(root);
    assert.ok(names.includes("check.tool"), "check.tool is counted");
    assert.ok(
      !names.includes("check"),
      "the object itself is the door, not a function",
    );
  });
});

describe("gate 4: STABILITY.md lists every entry", () => {
  const md = readFileSync(join(ROOT, "STABILITY.md"), "utf-8");
  const section =
    md.split(/^### The entries$/m)[1]?.split(/^#{1,3} /m)[0] ?? "";
  const rows = section
    .split("\n")
    .filter((l) => /^\|\s*`/.test(l))
    .map((l) => l.split("|").map((c) => c.trim()))
    .map(([, entry, audience, stability]) => ({
      entry: (entry ?? "").replace(/`/g, ""),
      audience: audience ?? "",
      stability: stability ?? "",
    }));

  test("the table's entries equal package.json exports", () => {
    const subpath = (e: string): string =>
      e === "vigiles" ? "." : "./" + e.replace(/^vigiles\//, "");
    assert.deepEqual(
      rows.map((r) => subpath(r.entry)).sort(),
      Object.keys(pkg.exports).sort(),
      "STABILITY.md `The entries` table and package.json `exports` must list the same entries",
    );
  });

  test("every row names an audience and one of stable / beta / internal", () => {
    for (const r of rows) {
      assert.ok(r.audience.length > 0, `${r.entry}: audience`);
      assert.match(
        r.stability,
        /^(stable|beta|internal)$/,
        `${r.entry}: stability`,
      );
    }
  });
});

describe("gate 1: every export carries a release tag", () => {
  function fixture(dts: string): { ok: boolean; messages: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0" }),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { module: "Node16", moduleResolution: "Node16" },
          include: ["*.d.ts"],
        }),
      );
      writeFileSync(join(dir, "entry.d.ts"), dts);
      mkdirSync(join(dir, "temp"));
      mkdirSync(join(dir, "api-surface"));
      const messages: string[] = [];
      const result = Extractor.invoke(
        configFor(dir, { name: "fixture", dts: "entry.d.ts" }),
        {
          localBuild: true,
          messageCallback: (m) => {
            if (m.logLevel === "error") messages.push(m.text);
          },
        },
      );
      return { ok: result.succeeded, messages };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an untagged export fails, naming the declaration", () => {
    const r = fixture(
      "/** Tagged. @public */\nexport declare function tagged(): void;\n" +
        "export declare function untagged(): void;\n",
    );
    assert.equal(r.ok, false);
    assert.ok(
      r.messages.some((m) => /untagged.*release tag/.test(m)),
      r.messages.join("\n"),
    );
  });

  test("@public, @beta and @alpha each satisfy it", () => {
    const r = fixture(
      "/** @public */\nexport declare const a: 1;\n" +
        "/** @beta */\nexport declare const experimental_b: 2;\n" +
        "/** @alpha */\nexport declare const experimental_c: 3;\n",
    );
    assert.deepEqual(r.messages, []);
    assert.equal(r.ok, true);
  });

  test("the built .d.ts of a public signature naming a stripped @internal type fails check-dist-types", () => {
    const run = (internal: boolean): number => {
      const dir = mkdtempSync(join(tmpdir(), "dist-types-"));
      try {
        mkdirSync(join(dir, "src"));
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: "fixture", exports: { ".": "./dist/b.js" } }),
        );
        writeFileSync(
          join(dir, "src", "a.ts"),
          `${internal ? "/** @internal */\n" : "/** @public */\n"}export type Hidden = { readonly x: 1 };\n`,
        );
        writeFileSync(
          join(dir, "src", "b.ts"),
          'import type { Hidden } from "./a.js";\n/** @public */\nexport function f(): Hidden {\n  return { x: 1 };\n}\n',
        );
        const tsc = join(ROOT, "node_modules", ".bin", "tsc");
        const built = spawnSync(
          tsc,
          [
            "--declaration",
            "--stripInternal",
            "--module",
            "node16",
            "--moduleResolution",
            "node16",
            "--target",
            "es2022",
            "--strict",
            "--outDir",
            join(dir, "dist"),
            join(dir, "src", "a.ts"),
            join(dir, "src", "b.ts"),
          ],
          { encoding: "utf8" },
        );
        assert.equal(built.status, 0, built.stdout + built.stderr);
        return (
          spawnSync(
            process.execPath,
            [join(dirname(__filename), "check-dist-types.mjs"), dir],
            { encoding: "utf8" },
          ).status ?? -1
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    assert.equal(
      run(true),
      1,
      "a stripped @internal type in a public signature must fail",
    );
    assert.equal(run(false), 0, "the same shape, tagged @public, passes");
  });
});
