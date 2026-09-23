/**
 * e2e tier — the PACKED package installs with every mainstream package manager at its DEFAULT
 * settings, runs no lifecycle script, and checks `.py` and `.ts` symbol references right away.
 *
 * WHY THIS IS AN ASSERTION AND NOT A HABIT (#257). Since pnpm 10 a dependency's
 * `preinstall` / `install` / `postinstall` does not run unless the installing project
 * approves it, and on pnpm 12 an unapproved one fails the install:
 *
 *   ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: @ast-grep/lang-python, …
 *
 * So ONE script anywhere in our dependency tree turns `pnpm add vigiles` into a non-zero
 * exit for every consumer. The three native `@ast-grep/lang-*` grammars arrived that way
 * unnoticed. Moving them to `optionalDependencies` did not help (optional dependencies are still
 * installed, scripts and all), and making them optional PEERS moved the cost onto users: a `.py`
 * reference said "grammar not installed" after an upgrade. They are now WASM grammars from
 * `@vscode/tree-sitter-wasm`, a plain dependency with no install script and no native binary.
 *
 * 🔴 BOTH HALVES, PER MANAGER. "Zero install scripts" alone was also true of the optional-peer
 * design, which then answered "grammar not installed". So every manager installs the tarball
 * with NO flags, exits 0, and the INSTALLED bin checks one `.py` and one `.ts` reference: the
 * existing symbol passes, the missing one is "not defined". npm additionally asserts the
 * property behind the pnpm failure — no package in the tree declares an install-time script —
 * so a new dependency that brings one fails here the day it is added.
 *
 * 🔴 A MANAGER THAT DOES NOT LAUNCH IS A DECLARED SKIP, NEVER A PASS. Its test is skipped BY
 * NAME with the reason; under `CI=true` (or `VIGILES_INSTALL_E2E_STRICT=1`) it FAILS instead,
 * because there a missing manager is a broken environment, and "pnpm passed" must not print the
 * same as "pnpm was never tried" (the same cure `research-paper-pipeline`'s install-e2e uses).
 * Yarn classic (1.x) is deliberately not in the matrix: it is not a supported manager.
 *
 * It needs the registry (it installs the tarball's real dependency tree), so it lives in the
 * e2e tier and self-skips where the registry is unreachable rather than failing red.
 */
import { describe, test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(".");
const STRICT =
  process.env.CI === "true" || process.env.VIGILES_INSTALL_E2E_STRICT === "1";

/** Can we reach the npm registry? `npm ping` asks the configured registry itself. */
function registryReachable(): boolean {
  const r = spawnSync("npm", ["ping"], {
    stdio: "ignore",
    timeout: 60000,
  });
  return r.status === 0;
}

const online = registryReachable();

/** The install-time hooks a package manager runs on a dependency. */
const LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

/** Corepack must never stop to ask before fetching the pinned yarn. */
const ENV = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

interface Manager {
  readonly name: string;
  /** Command that must exit 0 for the manager to count as present. */
  readonly probe: readonly [string, readonly string[]];
  /** Why it may be absent — printed with the skip, so the skip says what is missing. */
  readonly why: string;
  /** Install the tarball with the manager's defaults: no flags. */
  readonly install: (tgz: string) => readonly [string, readonly string[]];
  /** Run the INSTALLED `vigiles` bin through the manager. */
  readonly exec: (args: readonly string[]) => readonly [string, string[]];
}

const MANAGERS: readonly Manager[] = [
  {
    name: "npm",
    probe: ["npm", ["--version"]],
    why: "npm is not on PATH",
    install: (tgz) => ["npm", ["install", tgz]],
    exec: (args) => ["npm", ["exec", "--", "vigiles", ...args]],
  },
  {
    name: "pnpm",
    probe: ["pnpm", ["--version"]],
    why: "pnpm is not on PATH",
    install: (tgz) => ["pnpm", ["add", tgz]],
    exec: (args) => ["pnpm", ["exec", "vigiles", ...args]],
  },
  {
    // Yarn 4's default linker is Plug'n'Play: no node_modules at all, packages read from zips.
    name: "yarn berry (PnP)",
    probe: ["corepack", ["yarn@4", "--version"]],
    why: "corepack is not on PATH or cannot fetch yarn@4",
    install: (tgz) => ["corepack", ["yarn@4", "add", `vigiles@file:${tgz}`]],
    exec: (args) => ["corepack", ["yarn@4", "vigiles", ...args]],
  },
];

function launches(m: Manager): boolean {
  const [cmd, args] = m.probe;
  const r = spawnSync(cmd, args, {
    cwd: tmpdir(),
    env: ENV,
    stdio: "ignore",
    timeout: 120000,
  });
  return r.status === 0;
}

let work = "";
let tgz = "";

describe.skipIf(!online)("the packed tarball, installed with defaults", () => {
  beforeAll(() => {
    // `npm pack` ships `dist/` as it is on disk; the e2e script builds first. Without it the
    // tarball would be a hollow package and every assertion below would be about nothing.
    assert.ok(
      existsSync(join(ROOT, "dist", "cli.js")),
      "dist/ is missing — run `npm run build` (npm run test:e2e does)",
    );
    // realpath: on macOS /var is a symlink to /private/var, and paths must match what the
    // installed tools report from inside.
    work = realpathSync(mkdtempSync(join(tmpdir(), "vigiles-pack-")));
    const packDir = join(work, "pack");
    mkdirSync(packDir);
    execFileSync("npm", ["pack", "--pack-destination", packDir], {
      cwd: ROOT,
      stdio: "ignore",
    });
    const [file] = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    assert.ok(file, "npm pack produced no tarball");
    tgz = join(packDir, file);
  }, 120000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  for (const m of MANAGERS) {
    test(`${m.name}: installs with no flags, then checks .py and .ts references`, (ctx) => {
      if (!launches(m)) {
        const say = `NOT MEASURED: ${m.name} does not launch here — ${m.why}`;
        // Under CI a missing manager fails: measuring the others alone must not look like a pass.
        if (STRICT) assert.fail(`${say} (strict mode: CI=true)`);
        ctx.skip(say);
        return;
      }

      const consumer = join(work, `consumer-${m.name.replace(/\W+/g, "-")}`);
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
      );
      writeFileSync(join(consumer, "app.py"), "def handler():\n    pass\n");
      writeFileSync(join(consumer, "app.ts"), "export function handler() {}\n");
      writeFileSync(
        join(consumer, "CLAUDE.md"),
        [
          "# Rules",
          "",
          "- `vigiles:symbol app.py#handler`",
          "- `vigiles:symbol app.py#missing`",
          "- `vigiles:symbol app.ts#handler`",
          "- `vigiles:symbol app.ts#missing`",
          "",
        ].join("\n"),
      );

      const [icmd, iargs] = m.install(tgz);
      const inst = spawnSync(icmd, iargs, {
        cwd: consumer,
        env: ENV,
        encoding: "utf8",
        timeout: 280000,
      });
      assert.equal(
        inst.status,
        0,
        `${m.name} install exited ${String(inst.status)}:\n${inst.stdout}\n${inst.stderr}`,
      );

      if (m.name === "npm") {
        const offenders: string[] = [];
        for (const hook of LIFECYCLE) {
          const out = execFileSync(
            "npm",
            ["query", `:attr(scripts, [${hook}])`],
            { cwd: consumer, encoding: "utf8" },
          );
          const hits = JSON.parse(out) as { name: string; version: string }[];
          for (const p of hits)
            offenders.push(`${p.name}@${p.version} (${hook})`);
        }
        assert.deepEqual(
          offenders,
          [],
          "these packages carry an install-time script, which fails a default pnpm install " +
            "for every consumer (ERR_PNPM_IGNORED_BUILDS). Replace or drop the dependency; " +
            "see #257.",
        );
        // The native grammars must not come back by any route.
        for (const lang of ["python", "ruby", "rust"])
          assert.equal(
            existsSync(
              join(consumer, "node_modules", "@ast-grep", `lang-${lang}`),
            ),
            false,
            `@ast-grep/lang-${lang} was installed — it carries a postinstall (#257)`,
          );
      }

      // The installed bin, through the manager, right after install — no extra command.
      const [ecmd, eargs] = m.exec(["lint", "CLAUDE.md"]);
      const lint = spawnSync(ecmd, eargs, {
        cwd: consumer,
        env: ENV,
        encoding: "utf8",
        timeout: 120000,
      });
      const out = `${lint.stdout}\n${lint.stderr}`;
      assert.ok(
        out.includes("Symbol reference check:"),
        `${m.name}: lint printed no symbol section (exit ${String(lint.status)}):\n${out}`,
      );
      const findings = out
        .slice(out.indexOf("Symbol reference check:"))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("✗"));
      // Exactly the two misses. The hits pass silently; nothing says "not checked".
      assert.deepEqual(
        findings,
        [
          '✗ CLAUDE.md:4 "missing" is not defined in app.py',
          '✗ CLAUDE.md:6 "missing" is not defined in app.ts',
        ],
        `${m.name}:\n${out}`,
      );
      assert.equal(lint.status, 2, `${m.name}: lint exit\n${out}`);
    }, 420000);
  }
});
