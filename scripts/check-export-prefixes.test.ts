import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, afterAll } from "vitest";

import {
  findPrefixViolations,
  SURFACES,
} from "./check-export-prefixes.mjs" with { "resolution-mode": "import" };

/**
 * Tests for `scripts/check-export-prefixes.mjs` — the gate that holds the two
 * quarantine subpaths (`./eval` → `paid_`, `./experimental` → `experimental_`) to
 * their naming contract.
 *
 * 🔴 EVERY CASE HERE HAS BOTH HALVES: it FIRES on a planted violation AND it is
 * SILENT on the legitimate surface next door. A gate whose success looks like
 * silence cannot be noticed broken, so "silent" alone is indistinguishable from
 * dead — this repository has shipped three checks that were dead on arrival, and
 * every one of them was found by accident rather than by a test.
 *
 * The silent-half cases are the load-bearing ones, and two of them encode real
 * ways this check could pass vacuously:
 *
 *   - TYPES must not be flagged. They are exempt by design (a type cannot be
 *     called, so it cannot bill), and the report types are re-exported from BOTH
 *     barrels — flagging them would demand `paid_` names on the FREE surface.
 *   - ALIASED re-exports must still be seen as values. `./eval` is built entirely
 *     from `export { x as paid_x }`, and an alias reports the Alias flag, not
 *     Value. A version of this check that forgot to resolve aliases would treat
 *     every export on `./eval` as a type and pass on an all-unprefixed barrel.
 */

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "check-export-prefixes.mjs");
const roots: string[] = [];

/**
 * A throwaway package with one quarantined subpath, so a violation can be
 * PLANTED. Testing only against this repo would mean never seeing the check
 * fail — exactly the shape that ships dead.
 */
function fixture(dts: string, subpath = "./eval"): string {
  const root = mkdtempSync(join(tmpdir(), "export-prefix-check-"));
  roots.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo-pkg",
      version: "0.0.0",
      exports: { [subpath]: "./dist/surface.js" },
    }),
  );
  // The script resolves `typescript` from the TARGET package, so borrow ours.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "dist", "surface.d.ts"), dts);
  return root;
}

/** Drive the fixture through the real resolver the script uses. */
function check(root: string, prefix = "paid_", subpath = "./eval") {
  return findPrefixViolations(root, [
    { subpath, dts: "dist/surface.d.ts", prefix },
  ]);
}

/**
 * A fixture the real CLI (which reads the hard-coded `SURFACES`) can run against
 * cleanly: BOTH quarantined subpaths present, at the paths the script expects,
 * so the only variable is whether `evalExport` carries its prefix.
 */
function twoSurfaceFixture(evalExport: string): string {
  const root = mkdtempSync(join(tmpdir(), "export-prefix-cli-"));
  roots.push(root);
  mkdirSync(join(root, "dist", "entries"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo-pkg",
      version: "0.0.0",
      exports: {
        "./eval": "./dist/entries/eval.js",
        "./experimental": "./dist/experimental.js",
      },
    }),
  );
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "dist", "entries/eval.d.ts"),
    `export declare function ${evalExport}(): void;\n`,
  );
  writeFileSync(
    join(root, "dist", "experimental.d.ts"),
    "export declare function experimental_ok(): void;\n",
  );
  return root;
}

/** Run the script as CI runs it, capturing exit code and both streams. */
function runCli(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? -1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-export-prefixes: it FIRES on a violation", () => {
  it("flags a runtime export with no prefix", () => {
    const root = fixture(
      "export declare function runEval(): void;\nexport declare function paid_measureTriggerRate(): void;\n",
    );
    const v = check(root);
    expect(v.map((x) => x.symbol)).toEqual(["runEval"]);
    expect(v[0]?.why).toContain("paid_runEval");
  });

  it("flags an unprefixed CONST, not just a function", () => {
    const root = fixture("export declare const claudeEvalDriver: object;\n");
    expect(check(root).map((x) => x.symbol)).toEqual(["claudeEvalDriver"]);
  });

  it("flags an ALIASED re-export whose alias lacks the prefix", () => {
    // The alias is what the consumer types, so the alias is what must carry the
    // warning — the local name behind it is invisible at the call site.
    const root = fixture(
      "declare function judged(): void;\nexport { judged as graded };\n",
    );
    expect(check(root).map((x) => x.symbol)).toEqual(["graded"]);
  });

  it("flags the `experimental_` axis too, not only `paid_`", () => {
    const root = fixture(
      "export declare function makeDockerRuntime(): void;\n",
      "./experimental",
    );
    const v = check(root, "experimental_", "./experimental");
    expect(v.map((x) => x.symbol)).toEqual(["makeDockerRuntime"]);
    expect(v[0]?.why).toContain("experimental_makeDockerRuntime");
  });

  it("flags a surface that has fallen out of the exports map (a stale contract)", () => {
    const root = fixture("export declare function paid_ok(): void;\n");
    const v = findPrefixViolations(root, [
      { subpath: "./gone", dts: "dist/surface.d.ts", prefix: "paid_" },
    ]);
    expect(v[0]?.why).toContain("not present in package.json");
  });
});

describe("check-export-prefixes: it is SILENT on the legitimate surface", () => {
  it("passes when every runtime export carries the prefix", () => {
    const root = fixture(
      "export declare function paid_runEval(): void;\nexport declare const paid_claudeEvalDriver: object;\n",
    );
    expect(check(root)).toEqual([]);
  });

  it("does NOT flag TYPES — they are exempt by design", () => {
    // Load-bearing: the report types are re-exported from BOTH barrels, so
    // demanding `paid_` on them would put paid names on the FREE surface.
    const root = fixture(
      [
        "export interface EvalReport { ok: boolean }",
        "export type Metrics = Record<string, number>;",
        "export declare function paid_measureTriggerRate(): void;",
        "",
      ].join("\n"),
    );
    expect(check(root)).toEqual([]);
  });

  it("does NOT go vacuous on an ALIASED re-export that IS prefixed", () => {
    // The mutation this pins: drop alias resolution and every `export { x as
    // paid_x }` reads as a type, so the check passes on a fully unprefixed
    // barrel. Here it must stay silent for the RIGHT reason — the alias is
    // recognised as a value AND carries the prefix.
    const root = fixture(
      "declare function runEval(): void;\nexport { runEval as paid_runEval };\n",
    );
    expect(check(root)).toEqual([]);
    // …and the same shape without the prefix must still fire, which is what
    // proves the silence above was not vacuous.
    const bad = fixture(
      "declare function runEval(): void;\nexport { runEval as stillFree };\n",
    );
    expect(check(bad).map((x) => x.symbol)).toEqual(["stillFree"]);
  });
});

describe("check-export-prefixes: the free readers are a closed list", () => {
  it("passes a declared free name and still flags an undeclared one", () => {
    const root = fixture(
      "export declare function compare(): void;\nexport declare function sneaky(): void;\n",
    );
    const v = findPrefixViolations(root, [
      {
        subpath: "./eval",
        dts: "dist/surface.d.ts",
        prefix: "paid_",
        free: ["compare"],
      },
    ]);
    expect(v.map((x) => x.symbol)).toEqual(["sneaky"]);
  });
});

describe("check-export-prefixes: this repository's real surfaces", () => {
  // 🔴 FOUND BY MUTATION, NOT BY REVIEW. Deleting an entry from SURFACES left the
  // whole suite GREEN: the axis-specific test passes its own surface list, the
  // "real barrels" test below is satisfied by a SHORTER list, and the CLI test
  // still exits 1 on its `./eval` defect. So an entire axis could stop being
  // policed with nothing turning red — the same shape as a dead check. This
  // assertion is what makes the SURFACES list itself load-bearing.
  //
  // It did its job on 2026-08-21: `./experimental` was deleted as a subpath and
  // this test is what said so, out loud, instead of the removal passing silently.
  // The list is down to one entry ON PURPOSE — the `experimental_` prefix is now
  // enforced per DECLARATION by `local/experimental-name`, which covers more
  // ground than a per-subpath sweep ever did, since it no longer depends on which
  // door a symbol leaves by. Shrinking this list again needs the same treatment:
  // say where the axis went, or it did not go anywhere.
  it("SURFACES covers exactly the quarantined subpaths — deleting one is a failure", () => {
    expect(new Set(SURFACES.map((s) => s.subpath))).toEqual(
      new Set(["./eval"]),
    );
    const pkg = JSON.parse(
      readFileSync(join(REPO, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    for (const s of SURFACES) {
      expect(pkg.exports[s.subpath], `${s.subpath} in exports`).toBeDefined();
      expect(existsSync(join(REPO, s.dts)), `${s.dts} is built`).toBe(true);
    }
  });

  it("both real barrels satisfy their contract", () => {
    expect(findPrefixViolations(REPO, SURFACES)).toEqual([]);
  });

  it("exits 0 as a CLI on the clean tree", () => {
    const out = execFileSync(process.execPath, [SCRIPT, REPO], {
      encoding: "utf8",
    });
    expect(out).toContain("no violations");
  });

  it("exits NON-ZERO as a CLI when a surface is violated (the CI half)", () => {
    // A gate that reports findings but exits 0 is a nudge, not a gate. This is
    // the assertion that keeps it failing the build.
    //
    // ⚠️ The obvious version of this test is VACUOUS: a fixture with only
    // `./eval` is ALSO missing `./experimental`, so the CLI exits 1 whether or
    // not it noticed the unprefixed symbol, and the assertion would hold with
    // the prefix logic deleted. So both real subpaths are present here and the
    // ONLY defect is the missing prefix — and the pair below pins it: the clean
    // twin must exit 0, or "exits 1" says nothing.
    const bad = twoSurfaceFixture("runEval");
    const good = twoSurfaceFixture("paid_runEval");

    expect(runCli(good).code).toBe(0);

    const r = runCli(bad);
    expect(r.code).toBe(1);
    expect(r.out).toContain("runEval");
    expect(r.out).toContain("paid_runEval");
  });
});
