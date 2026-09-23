/**
 * e2e tier — the PACKED package installs without running a single lifecycle script.
 *
 * WHY THIS IS AN ASSERTION AND NOT A HABIT (#257). Since pnpm 10 a dependency's
 * `preinstall` / `install` / `postinstall` does not run unless the installing project
 * approves it, and on pnpm 12 an unapproved one fails the install:
 *
 *   ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: @ast-grep/lang-python, …
 *
 * So ONE script anywhere in our dependency tree turns `pnpm add vigiles` into a non-zero
 * exit for every consumer. The three ast-grep grammars arrived that way unnoticed, and moving
 * them to `optionalDependencies` did NOT help — optional dependencies are still installed by
 * default, scripts and all. They are optional PEER dependencies now, which npm and pnpm do not
 * install unless the consumer asks.
 *
 * What is asserted is the property, not the list: the tree a consumer gets from the tarball
 * has zero packages declaring an install-time script. A new dependency that brings one fails
 * here the day it is added, whoever adds it, instead of in a downstream project's CI.
 *
 * It needs the registry (it installs the tarball's real dependency tree), so it lives in the
 * e2e tier and self-skips where the registry is unreachable rather than failing red.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(".");

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

test.skipIf(!online)(
  "the packed tarball installs a tree with NO preinstall/install/postinstall script",
  () => {
    // `npm pack` ships `dist/` as it is on disk; the e2e script builds first. Without it the
    // tarball would be a hollow package and the assertion below would be about nothing.
    assert.ok(
      existsSync(join(ROOT, "dist", "cli.js")),
      "dist/ is missing — run `npm run build` (npm run test:e2e does)",
    );

    const work = mkdtempSync(join(tmpdir(), "vigiles-pack-scripts-"));
    try {
      const packDir = join(work, "pack");
      const consumer = join(work, "consumer");
      mkdirSync(packDir);
      mkdirSync(consumer);
      execFileSync("npm", ["pack", "--pack-destination", packDir], {
        cwd: ROOT,
        stdio: "ignore",
      });
      const [tgz] = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
      assert.ok(tgz, "npm pack produced no tarball");

      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
      );
      // `--ignore-scripts` changes nothing about WHICH packages land, only whether their
      // scripts run — and the question here is which packages land. It also keeps a script,
      // if one sneaks back in, from executing on the test machine.
      execFileSync(
        "npm",
        [
          "install",
          join(packDir, tgz),
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: consumer, stdio: "ignore", timeout: 240000 },
      );

      // The installed vigiles must be there, or an empty result below is vacuous.
      assert.ok(
        existsSync(join(consumer, "node_modules", "vigiles", "package.json")),
        "the tarball did not install",
      );

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
          "for every consumer (ERR_PNPM_IGNORED_BUILDS). Make the dependency optional-peer " +
          "or drop it; see #257.",
      );

      // And the specific regression #257 fixed: the grammars are opt-in, not installed.
      for (const lang of ["python", "ruby", "rust"])
        assert.equal(
          existsSync(
            join(consumer, "node_modules", "@ast-grep", `lang-${lang}`),
          ),
          false,
          `@ast-grep/lang-${lang} was installed by default`,
        );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  300000,
);
