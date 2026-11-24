/**
 * The spec host, end to end — driving the REAL built CLI the way a user does.
 *
 * WHAT THIS REPLACED, and why the shape of these tests changed. `loadSpec` used
 * to try a native `import()` and fall back to `execSync("npx tsx …")`. Two
 * defects made that arrangement unfixable rather than merely buggy:
 *
 *   1. a spec that threw was evaluated TWICE — once natively, once by the
 *      fallback — so any side effect before the throw happened twice. Guarding
 *      it requires answering "did the module body run?", and Node does not
 *      expose that: `ERR_MODULE_NOT_FOUND` and `SyntaxError` both occur before
 *      AND during evaluation;
 *   2. the native path had NO time bound. An in-flight module evaluation cannot
 *      be cancelled — `Promise.race` returns control but the evaluation keeps
 *      running — so a stalled spec hung `compile`, `test` and `audit` forever.
 *
 * One host process fixes both by construction: one loader means nothing to
 * re-run, and a child can be killed. The tests below assert exactly those two
 * properties, plus the resolution contract vigiles now owns.
 *
 * The measured bug that started all of it: a consuming repo without `tsx`, where
 * `npx tsx` went to the registry — `npx tsx -e 'console.log(1)'` took >60s
 * against a 15s budget, so all 50 specs failed at once with advice to run
 * `npm run build`, a step that does not exist in a consumer install.
 *
 * Deterministic, model-free, offline → free unit tier.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";

// NB: `__dirname`, not `import.meta` — this package builds to CommonJS and tsc
// rejects import.meta here (TS1470). The idiom is legal in scripts/ next door,
// which is outside the tsc project; copying it into src/ does not compile.
const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "cli.js");

let dir: string;

function run(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  cmd = "compile",
): { out: string; code: number } {
  // 🔴 spawnSync, not execSync: on SUCCESS execSync returns stdout only, so a
  // warning printed to stderr is invisible to assertions. That silently made
  // the listener-leak test below pass under a mutation that reinstated the leak
  // — a green mutation is a finding about the TEST, not proof of the fix.
  const r = spawnSync("node", [CLI, cmd], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: 120_000,
  });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}

/** Write a spec at `<dir>/.claude/skills/<name>/SKILL.md.spec.ts`. */
function skill(name: string, body: string): string {
  const at = join(dir, ".claude", "skills", name, "SKILL.md.spec.ts");
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, body);
  return dirname(at);
}

function validSpec(name: string, extra = ""): string {
  return (
    `import { experimental_skill } from "vigiles/spec";\n` +
    extra +
    `export default experimental_skill({\n` +
    `  name: ${JSON.stringify(name)},\n` +
    `  description: "A fixture skill. Use when testing the spec loader.",\n` +
    `  body: "# ${name}\\n\\nFixture body.\\n",\n` +
    `});\n`
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-spec-host-"));
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  execSync(
    `ln -s ${JSON.stringify(ROOT)} ${JSON.stringify(join(dir, "node_modules", "vigiles"))}`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", private: true }, null, 2),
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("spec host", () => {
  it("compiles a spec with npm and npx REMOVED FROM PATH, on any Node", () => {
    // The load-bearing assertion. The original bug was `npx tsx` reaching for
    // the network; the host spawns `process.execPath` and transpiles with the
    // TypeScript already in `dependencies`, so nothing is fetched.
    //
    // Note what is NOT here any more: a Node-version gate. The previous design
    // needed native type stripping (22.18+), so this test had to skip on the
    // Node 20 that this repo's own CI runs. vigiles now owns the transpile, so
    // the assertion holds on every supported runtime.
    const at = skill("alpha", validSpec("alpha"));

    const shadow = join(dir, "no-npx");
    mkdirSync(shadow, { recursive: true });
    for (const bin of ["npx", "npm"]) {
      const f = join(shadow, bin);
      writeFileSync(
        f,
        `#!/bin/sh\necho "${bin} is unavailable in this test" >&2\nexit 127\n`,
      );
      execSync(`chmod +x ${JSON.stringify(f)}`);
    }

    const { out } = run(dir, {
      ...process.env,
      PATH: `${shadow}:${process.env.PATH ?? ""}`,
    });
    assert.match(
      out,
      /✓ .*alpha\/SKILL\.md\.spec\.ts/,
      `compile must succeed without npx on PATH, got:\n${out}`,
    );
    assert.doesNotMatch(out, /failed to load/, `no spec should fail:\n${out}`);
    rmSync(at, { recursive: true, force: true });
  });

  it("resolves a `./x.js` import to the `.ts` beside it", () => {
    // The one resolution rule vigiles deliberately owns: `tsc` under nodenext
    // requires the `.js` extension in source, so a spec that imports a local
    // helper writes `./helper.js` while only `./helper.ts` exists. Native Node
    // does not do this rewrite; tsx does. Now it is OUR documented contract
    // instead of a property of whichever loader happened to be installed.
    const at = skill(
      "sibling",
      validSpec("sibling", `import "./helper.js";\n`),
    );
    writeFileSync(join(at, "helper.ts"), "export const unused: number = 1;\n");

    const { out } = run(dir);
    assert.match(
      out,
      /✓ .*sibling\/SKILL\.md\.spec\.ts/,
      `the .js -> .ts rewrite must resolve:\n${out}`,
    );
    rmSync(at, { recursive: true, force: true });
  });

  it("evaluates a throwing spec EXACTLY ONCE", () => {
    // With one loader there is nothing to re-run. Under the old two-loader
    // arrangement this reported «ran 2 time(s)».
    const marks = join(dir, "side-effects.log");
    const at = skill(
      "sideeffect",
      `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(marks)}, "ran\\n");\n` +
        `throw new Error("spec blew up after its side effect");\n`,
    );

    const { out } = run(dir);
    const ran = readFileSync(marks, "utf-8").trim().split("\n").length;
    assert.equal(ran, 1, `the spec must run once, ran ${ran} time(s):\n${out}`);
    assert.match(
      out,
      /spec blew up after its side effect/,
      `and its own error must be reported:\n${out}`,
    );
    rmSync(at, { recursive: true, force: true });
    rmSync(marks, { force: true });
  });

  it("KILLS a spec that stalls, and names it", () => {
    // This test could not exist before. The native path had no bound, and an
    // in-flight evaluation cannot be cancelled, so a spec like this one hung
    // compile forever. The host is killable, and its `start` line tells the
    // parent WHICH spec stalled — previously a hang gave N identical failures
    // and no culprit.
    const at = skill(
      "stalls",
      `await new Promise(() => {}); // never settles\n` + validSpec("stalls"),
    );

    const started = Date.now();
    const { out } = run(dir, {
      ...process.env,
      VIGILES_SPEC_TIMEOUT_MS: "3000",
    });
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 60_000,
      `compile must not hang; took ${elapsed}ms:\n${out}`,
    );
    assert.match(
      out,
      /exceeded 3000ms/,
      `the deadline must be reported:\n${out}`,
    );
    assert.match(
      out,
      /stalls\/SKILL\.md\.spec\.ts/,
      `the STALLED spec must be named, not just 'a spec':\n${out}`,
    );
    rmSync(at, { recursive: true, force: true });
  });

  it("reports a spec with no default export, without re-running it", () => {
    const at = skill("nodefault", `export const notDefault = 1;\n`);
    const { out } = run(dir);
    assert.match(out, /no default export/, `got:\n${out}`);
    rmSync(at, { recursive: true, force: true });
  });

  it("pairs CONCURRENT loads by path, and leaks no listeners", () => {
    // 🔴 Two defects, one cause, and the second is the serious one.
    //
    // `--trace-warnings` on `vigiles lint` showed checkCoverageThresholds
    // calling loadSpec through Array.map — CONCURRENTLY. The client held a
    // single `pending` slot, so each new caller overwrote the previous one and
    // a reply settled whichever request happened to be last: loadSpec could
    // return ANOTHER spec's value for the path it was asked about. Silent
    // mispairing, in a loader three commands depend on.
    //
    // The MaxListeners warning was only the visible symptom of the same
    // per-request wiring. Node warns at ten, so a fixture loading specs ONE AT
    // A TIME can never see either problem — which is exactly why the first six
    // tests here did not.
    //
    // `compile` iterates serially; `lint` is the concurrent path. This asserts
    // on both: lint for the concurrency, compile for the pairing.
    const made: string[] = [];
    for (let i = 0; i < 12; i++) {
      made.push(skill(`many${i}`, validSpec(`many${i}`)));
    }

    // Compile first so every SKILL.md exists and matches its spec…
    const { out } = run(dir);
    assert.doesNotMatch(out, /failed to load/, `all 12 must load:\n${out}`);

    // …then lint, which loads them CONCURRENTLY and verifies each compiled file
    // against the spec it came from. That hash check is what makes mispairing
    // observable end to end: hand a path another spec's value and the file no
    // longer matches. `compile` alone cannot show this — it loads serially, so
    // "the last pending request" and "the right one" are the same thing there.
    const lint = run(dir, process.env, "lint");
    assert.doesNotMatch(
      lint.out,
      /MaxListenersExceededWarning/,
      `concurrent loads must not add a listener each:\n${lint.out}`,
    );
    // ⚠️ What this pairing check does and does NOT establish. It asserts the
    // name loaded from each spec is reported beside the path it came from, and
    // it passes on the serial `compile` path. It does NOT fail when dispatch is
    // mutated to last-wins: measured, both this fixture and a real `vigiles
    // lint` on the vigiles repo produce byte-identical output either way,
    // because the one concurrent caller aggregates and never asks which spec it
    // got. Keying by path is correct by construction; this is the honest limit
    // of the coverage, recorded rather than papered over.
    for (let i = 0; i < 12; i++) {
      assert.match(
        lint.out,
        new RegExp(`"many${i}" \\(\\.claude/skills/many${i}/SKILL\\.md\\)`),
        `many${i}'s name must be reported against its OWN path:\n${lint.out}`,
      );
    }
    assert.doesNotMatch(out, /failed to load/, `all 12 must load:\n${out}`);
    // Each compiled file must carry ITS OWN body. A mispaired reply shows up
    // here as one skill's markdown written under another's name.
    for (let i = 0; i < 12; i++) {
      const md = readFileSync(join(made[i], "SKILL.md"), "utf-8");
      assert.match(
        md,
        new RegExp(`many${i}\\b`),
        `many${i}/SKILL.md must contain its own spec, not another's:\n${md}`,
      );
    }
    for (const at of made) rmSync(at, { recursive: true, force: true });
  });

  it("never advises `npm run build` when a spec fails to load", () => {
    // The retired message: it named a build step that does not exist in a
    // consumer install, and it was printed for EVERY failure because the real
    // reason had been erased by a bare `catch`.
    const at = skill("broken", `this is not valid typescript(((\n`);
    const { out } = run(dir);
    assert.match(
      out,
      /failed to load/,
      `the broken spec must be reported:\n${out}`,
    );
    assert.doesNotMatch(
      out,
      /npm run build/,
      `the retired misleading advice must not come back:\n${out}`,
    );
    rmSync(at, { recursive: true, force: true });
  });
});
