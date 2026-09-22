/**
 * PARITY GATE for the browser-safe audit engine (src/scan-files.ts).
 *
 * The whole point of `scanFiles` is that it produces, over an in-memory file map,
 * the SAME `AuditReport` the CLI's `audit --json` produces on disk over the same
 * files. This test proves it: for each real SHA-pinned vendored plugin under
 * test/dogfood/*, it reads the whole dir into a `Record<repoRelativePath, content>`
 * (simulating a GitHub fetch — the ENGINE itself stays fs-free; only this TEST
 * touches disk), runs both engines, and asserts the two `buildAuditReport` outputs
 * are byte-identical.
 *
 * The ONE legitimate difference is the checkout path: on disk the report roots at
 * the real absolute dir; in the browser it roots at the synthetic `BROWSER_ROOT`
 * (a browser has no real directory). We normalize the on-disk report's real
 * absolute root to `BROWSER_ROOT`, then assert full deep equality — so nothing
 * else may differ. See src/scan-files.ts (BROWSER_ROOT) for why this is the only
 * environment-specific field.
 */
import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { scanPlugin, type ScanReport } from "./scan.js";
import { scanFiles, BROWSER_ROOT } from "./scan-files.js";
import { buildAuditReport } from "./audit-report.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";

const OPTS = { harness: "claude-code", vigilesVersion: "9.9.9-parity-test" };

// The vendored plugins scanPlugin can load (see test/dogfood/README.md provenance).
const PLUGINS = [
  "oh-my-claudecode@deee3a4",
  "superpowers@6fd4507",
  "wshobson-accessibility@cf6059d",
  "madappgang-frontend@6097ad4",
] as const;

/** Read a whole plugin dir into a repo-relative (POSIX) file map — the GitHub fetch stand-in. */
function readDirToMap(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        out[rel] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(root);
  return out;
}

/** Replace the real absolute root with BROWSER_ROOT everywhere in a JSON-able value. */
function normalizeRoot<T>(value: T, abs: string): T {
  return JSON.parse(JSON.stringify(value).split(abs).join(BROWSER_ROOT)) as T;
}

/** Sort the fs-walk-order-dependent arrays so a raw-report compare is order-robust. */
function stabilize(report: ScanReport): ScanReport {
  return {
    ...report,
    danglingRefs: [...report.danglingRefs].sort(),
    descriptionOverlaps: [...report.descriptionOverlaps].sort((a, b) =>
      `${a.a}\u0000${a.b}`.localeCompare(`${b.a}\u0000${b.b}`),
    ),
    descriptionBudgetIssues: [...report.descriptionBudgetIssues].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}

describe("scanFiles parity with scanPlugin (buildAuditReport byte-identical)", () => {
  for (const name of PLUGINS) {
    it(`produces an identical AuditReport for ${name}`, () => {
      // __dirname is src/ (vitest) or dist/ (built) — both one level under the
      // repo root, where the vendored plugins live.
      const abs = resolve(__dirname, "..", "test/dogfood", name);

      const diskReport = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
      const map = readDirToMap(abs);
      const fileReport = scanFiles(map);

      // The mandated gate: the SAME AuditReport (modulo the checkout path).
      const diskAudit = normalizeRoot(buildAuditReport(diskReport, OPTS), abs);
      const fileAudit = buildAuditReport(fileReport, OPTS);
      expect(fileAudit).toEqual(diskAudit);

      // Stronger: the raw ScanReport itself matches field-for-field (only the
      // fs-walk order of `danglingRefs`/description arrays is normalized away).
      const diskRaw = stabilize(normalizeRoot(diskReport, abs));
      const fileRaw = stabilize(fileReport);
      expect(fileRaw).toEqual(diskRaw);
    });
  }
});

/**
 * 🔴 WHY THE FOUR VENDORED FIXTURES DID NOT CATCH THE `"SKILL"` DIVERGENCE, and
 * why this describe exists.
 *
 * Every plugin under test/dogfood/ is `skills/<name>/SKILL.md` shaped; not one of
 * them has a `SKILL.md` AT THE ROOT. So the whole single-skill-at-root branch —
 * the branch where the disk detector reads the declared `name:` and this twin
 * hard-coded the literal `"SKILL"` — was executed by NEITHER engine during the
 * byte-parity comparison. The gate was real and the input never reached the code.
 * That is the third divergence in this PR to land in one report builder and not
 * the other, and the first two were invisible for the same reason.
 *
 * The fixture is BUILT here rather than vendored: it is three files, and a
 * checked-in single-skill repo would be a fixture nobody could tell was
 * load-bearing. Same gate as above — the AuditReport must be byte-identical, and
 * `repoName` is passed because the disk engine's identity fallback is
 * `basename(auditedDir)`, which a browser structurally cannot have.
 */
describe("scanFiles parity for a SINGLE-SKILL-AT-ROOT repo (the shape no vendored fixture has)", () => {
  const cases = [
    {
      what: "a declared name, with its colocated harness named after it",
      files: {
        "SKILL.md":
          "---\nname: deployer\ndescription: Deploys the application to production safely\n---\n# deployer\n",
        "deployer.harness.mjs":
          "// the colocated test, named after the skill\n",
      },
    },
    {
      what: "a declared name whose harness is named after the DIRECTORY instead",
      files: {
        // The half that proves the name is load-bearing rather than decorative:
        // named after the checkout, this covers nothing, in both engines.
        "SKILL.md":
          "---\nname: deployer\ndescription: Deploys the application to production safely\n---\n# deployer\n",
        "single-skill-repo.harness.mjs": "// named after the checkout dir\n",
      },
    },
    {
      what: "NO declared name — both engines fall back to the repo's own name",
      files: {
        "SKILL.md": "Deploys the application to production safely.\n",
        "single-skill-repo.harness.mjs": "// named after the repo\n",
      },
    },
  ] as const;

  for (const { what, files } of cases) {
    it(`produces an identical AuditReport: ${what}`, () => {
      const tmp = makeTmpDir("parity-single-skill");
      // The audited dir's BASENAME is the disk engine's fallback identity, so it
      // has to be a name the fixture can also state to the browser engine.
      const abs = join(tmp, "single-skill-repo");
      mkdirSync(abs, { recursive: true });
      for (const [rel, body] of Object.entries(files))
        writeFileSync(join(abs, rel), body);

      const diskReport = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
      const fileReport = scanFiles(
        readDirToMap(abs),
        undefined,
        undefined,
        basename(abs),
      );

      const diskAudit = normalizeRoot(buildAuditReport(diskReport, OPTS), abs);
      const fileAudit = buildAuditReport(fileReport, OPTS);
      expect(fileAudit).toEqual(diskAudit);
      expect(stabilize(fileReport)).toEqual(
        stabilize(normalizeRoot(diskReport, abs)),
      );
      cleanupTmpDir(tmp);
    });
  }

  it("…and the untested count really does turn on the declared name", () => {
    // Without this the parity assertions above pass while BOTH engines are wrong
    // in the same direction — parity is agreement, not correctness.
    const named = {
      "SKILL.md":
        "---\nname: deployer\ndescription: Deploys the application to production safely\n---\n# deployer\n",
      "deployer.harness.mjs": "// colocated, named after the declared name\n",
    };
    const report = scanFiles(named, undefined, undefined, "single-skill-repo");
    expect(buildAuditReport(report, OPTS).inventory.untested).toBe(0);
    // The same map with the harness named after the checkout instead: uncovered.
    const misnamed = {
      "SKILL.md": named["SKILL.md"],
      "single-skill-repo.harness.mjs": "// named after the checkout dir\n",
    };
    expect(
      buildAuditReport(
        scanFiles(misnamed, undefined, undefined, "single-skill-repo"),
        OPTS,
      ).inventory.untested,
    ).toBe(1);
  });
});

/**
 * 🔴 THE SAME BLIND SPOT AS THE SINGLE-SKILL BRANCH ABOVE, one surface over.
 *
 * Not one of the four vendored plugins ships an agent in a SUBDIRECTORY —
 * measured: `test/dogfood/**\/agents/*\/*.md` is empty. So when the agent-file
 * depth rule was widened to read `agents/` recursively (the harness documents it
 * as recursive; vigiles read only the top level), the byte-parity gate above
 * could not see the change at all: the input never reached the code.
 *
 * That matters here more than elsewhere, because the two engines reach the
 * untested count through DIFFERENT discoverers — `scanPlugin` via
 * `test-coverage.ts` (globSync on disk), `scanFiles` via
 * `test-coverage-files.ts` (regex over a file map). Both used to spell the depth
 * rule for themselves. They now quote `AGENT_FILE_LEAF_RE`, and this is the case
 * that would notice if only one of them stopped.
 */
describe("scanFiles parity for NESTED agents (the shape no vendored fixture has)", () => {
  const files = {
    ".claude-plugin/plugin.json":
      '{"name":"nested-agents-repo","version":"0.1.0","description":"x"}',
    "agents/top.md":
      "---\nname: top\ndescription: A top-level agent for the parity probe.\ntools: Read\n---\nbody\n",
    "agents/review/security.md":
      "---\nname: security\ndescription: Reviews a diff for security defects.\ntools: Read\n---\nbody\n",
    "agents/review/deep/perf.md":
      "---\nname: perf\ndescription: Reviews a diff for performance defects.\ntools: Read\n---\nbody\n",
  } as const;

  it("produces an identical AuditReport for a repo with nested agents", () => {
    const tmp = makeTmpDir("parity-nested-agents");
    const abs = join(tmp, "nested-agents-repo");
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(abs, rel)), { recursive: true });
      writeFileSync(join(abs, rel), body);
    }

    const diskReport = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
    const fileReport = scanFiles(
      readDirToMap(abs),
      undefined,
      undefined,
      basename(abs),
    );

    const diskAudit = normalizeRoot(buildAuditReport(diskReport, OPTS), abs);
    const fileAudit = buildAuditReport(fileReport, OPTS);
    expect(fileAudit).toEqual(diskAudit);
    expect(stabilize(fileReport)).toEqual(
      stabilize(normalizeRoot(diskReport, abs)),
    );
    cleanupTmpDir(tmp);
  });

  it("…and BOTH engines really see all three, not zero in agreement", () => {
    // Parity is agreement, not correctness — the sibling describe learned this
    // the same way. Pin the absolute number in each engine so the pair cannot
    // pass by being wrong together.
    const tmp = makeTmpDir("parity-nested-agents-abs");
    const abs = join(tmp, "nested-agents-repo");
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(abs, rel)), { recursive: true });
      writeFileSync(join(abs, rel), body);
    }
    const expected = ["review:deep:perf", "review:security", "top"];
    expect(
      scanPlugin(abs, claudeCodeLayout, claudeCodeDialect).agents.map(
        (a) => a.name,
      ),
    ).toEqual(expected);
    expect(
      scanFiles(
        readDirToMap(abs),
        undefined,
        undefined,
        basename(abs),
      ).agents.map((a) => a.name),
    ).toEqual(expected);
    // The untested count is the half that runs through the two SEPARATE
    // coverage discoverers, so pin it too: three agents, no colocated tests.
    expect(
      buildAuditReport(
        scanPlugin(abs, claudeCodeLayout, claudeCodeDialect),
        OPTS,
      ).inventory.untested,
    ).toBe(3);
    expect(
      buildAuditReport(
        scanFiles(readDirToMap(abs), undefined, undefined, basename(abs)),
        OPTS,
      ).inventory.untested,
    ).toBe(3);
    cleanupTmpDir(tmp);
  });
});

/**
 * 🔴 THE TWO-SCOPE SHAPE — the second shape no vendored fixture has.
 *
 * Every plugin under test/dogfood/ carries surfaces at exactly ONE level, so the
 * both-levels-present branch was executed by neither engine during the byte-parity
 * comparison, exactly as the single-skill branch wasn't. The loader used to read
 * one level and materialize it under the OTHER level's canonical key; a divergence
 * between the two engines here would be invisible for the same reason.
 *
 * Measured shape (nyldn/claude-octopus @ 2026-08-18): 61 skills at the repo root,
 * 57 under `.claude/skills`, 50 names in both — and all 50 pairs DIFFER.
 */
describe("scanFiles parity for a TWO-SCOPE repo (root skills/ AND .claude/skills)", () => {
  const files = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "twoscope" }),
    "skills/dup/SKILL.md":
      "---\nname: dup\ndescription: The PLUGIN copy, loaded as /twoscope:dup by the harness\n---\n# plugin\n",
    ".claude/skills/dup/SKILL.md":
      "---\nname: dup\ndescription: The PROJECT copy, loaded as /dup by the harness\n---\n# project\n",
    ".claude/agents/dev.md":
      "---\nname: dev\ndescription: A project-level subagent that used to be dropped\n---\nbody\n",
  };

  it("produces an identical AuditReport on both engines", () => {
    const tmp = makeTmpDir("parity-two-scope");
    const abs = join(tmp, "two-scope-repo");
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(abs, rel)), { recursive: true });
      writeFileSync(join(abs, rel), body);
    }
    const diskReport = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
    const fileReport = scanFiles(
      readDirToMap(abs),
      undefined,
      undefined,
      basename(abs),
    );
    const diskAudit = normalizeRoot(buildAuditReport(diskReport, OPTS), abs);
    expect(buildAuditReport(fileReport, OPTS)).toEqual(diskAudit);
    expect(stabilize(fileReport)).toEqual(
      stabilize(normalizeRoot(diskReport, abs)),
    );
    cleanupTmpDir(tmp);
  });

  it("…and BOTH copies are actually there — parity is agreement, not correctness", () => {
    // Without this the parity assertion above passes while both engines drop the
    // same file, which is precisely how the shadowing bug survived.
    const report = scanFiles(files, undefined, undefined, "two-scope-repo");
    expect(report.skills.map((s) => s.path).sort()).toEqual([
      ".claude/skills/dup/SKILL.md",
      "skills/dup/SKILL.md",
    ]);
    expect(report.agents.map((a) => a.path)).toEqual([".claude/agents/dev.md"]);
  });
});

describe("scanFiles — non-plugin and empty inputs", () => {
  it("reports an instruction-only repo (CLAUDE.md, no spec) like scanPlugin would", () => {
    const map = {
      "CLAUDE.md": "# Rules\n\nBe careful.\n",
    };
    const report = scanFiles(map);
    expect(report.instructions).toEqual({ file: "CLAUDE.md", hasSpec: false });
    expect(report.skills).toEqual([]);
    expect(report.agents).toEqual([]);
    // Deterministic — buildAuditReport consumes it without touching disk.
    const audit = buildAuditReport(report, OPTS);
    expect(audit.meta.dir).toBe(BROWSER_ROOT);
    expect(audit.inventory.skills).toBe(0);
  });

  it("detects a beside-the-instruction-file spec via hasSpec", () => {
    const map = {
      "CLAUDE.md": "# Rules\n",
      "CLAUDE.md.spec.ts": "export default {}\n",
    };
    expect(scanFiles(map).instructions).toEqual({
      file: "CLAUDE.md",
      hasSpec: true,
    });
  });

  it("reports an empty map as an empty machine (no surfaces)", () => {
    const report = scanFiles({});
    expect(report.instructions).toBeNull();
    expect(report.skills).toEqual([]);
    expect(report.hooks).toEqual([]);
    expect(report.mcp).toBe(false);
  });

  it("names a nameless root SKILL.md after the repo, not BROWSER_ROOT", () => {
    // A single-skill repo (root SKILL.md, no frontmatter name) takes the repo
    // name the caller supplies — mirroring the CLI's audited-dir basename —
    // instead of the synthetic BROWSER_ROOT, so the report/recommendations name
    // the real repo, not `__vigiles_repo__`.
    const map = { "SKILL.md": "Deploys the app to prod.\n" };
    expect(
      scanFiles(map, undefined, undefined, "my-deployer").skills[0]?.name,
    ).toBe("my-deployer");
    // Without a repo name (e.g. the parity test) it falls back to BROWSER_ROOT's
    // basename — the pre-existing default, unchanged.
    expect(scanFiles(map).skills[0]?.name).toBe(basename(BROWSER_ROOT));
  });
});

describe("scanFiles — dangling-ref false positives (issue #110)", () => {
  const repoName = "my-plugin";

  it("does not read a `#`-comment usage example as a dangling ref", () => {
    const map = {
      "hooks/setup.sh": "echo installed\n",
      "hooks/print-usage.sh": [
        "#!/usr/bin/env bash",
        `# Usage: bash skills/${repoName}/hooks/setup.sh`,
        "echo done",
      ].join("\n"),
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [],
    );
  });

  it("resolves a repo-checkout-relative echo of the audited root's own name on a non-comment line", () => {
    const map = {
      "hooks/setup.sh": "echo installed\n",
      "hooks/print-usage.sh": `echo "run: bash skills/${repoName}/hooks/setup.sh"\n`,
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [],
    );
  });

  it("still flags a genuinely missing ref shaped like a repo-root echo (no under-detection)", () => {
    const map = {
      "hooks/print-usage.sh": `echo "run: bash skills/${repoName}/hooks/really-missing.sh"\n`,
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [`skills/${repoName}/hooks/really-missing.sh`],
    );
  });

  it("comment-stripping in a .sh script still flags a genuine missing ref on a real code line", () => {
    const map = {
      "hooks/setup.sh": [
        "#!/usr/bin/env bash",
        `# Usage: bash skills/${repoName}/hooks/setup.sh`, // comment — ignored
        'cat "skills/real-missing/SKILL.md"', // real code line — still flagged
      ].join("\n"),
    };
    const dangling = scanFiles(
      map,
      undefined,
      undefined,
      repoName,
    ).danglingRefs;
    expect(dangling).toEqual(["skills/real-missing/SKILL.md"]);
  });

  it("reads hooks/hooks.json as .json — not as a missing hooks/.js (dogfood 2026-08-17)", () => {
    // The browser HALF of the boundary fix. Both twins carried the same
    // unbounded extension alternation; fixing only the disk one would have left
    // the demo engine accusing microsoft/power-platform-skills forever.
    const map = {
      "hooks/hooks.json": "{}",
      "hooks/h.js": 'load("./hooks.json"); // registered in hooks/hooks.json\n',
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [],
    );
  });

  it("does not read the tail of `claude-agents/` as a reference to `agents/`", () => {
    const map = {
      "agents/real.md": "---\nname: real\ndescription: real\n---\n",
      "hooks/h.js": 'new URL("../../claude-agents/adv.md", import.meta.url);\n',
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [],
    );
  });

  it("does not read a full-line JSDoc mention as a file operation", () => {
    const map = {
      "hooks/h.js": [
        "/**",
        " * `git log -- hooks/never-existed.mjs` is refused for a word in a search.",
        " */",
        "run();",
      ].join("\n"),
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      [],
    );
  });

  it("still flags a genuinely missing .json ref on a code line, under its REAL name", () => {
    // The other half of every case above: the boundary and the comment rule
    // must not have turned the detector off.
    const map = {
      "hooks/h.js": 'const p = "hooks/gone.json";\nload(p);\n',
    };
    expect(scanFiles(map, undefined, undefined, repoName).danglingRefs).toEqual(
      ["hooks/gone.json"],
    );
  });

  it("without a repoName, falls back to BROWSER_ROOT's basename for the echo check", () => {
    // Mirrors the single-skill naming fallback (`repoName ?? basename(BROWSER_ROOT)`)
    // — the parity path (scanFiles(map) with no repoName) must still resolve an
    // echo of BROWSER_ROOT's own basename, not silently stop checking.
    const rootBase = basename(BROWSER_ROOT);
    const map = {
      "hooks/setup.sh": "echo installed\n",
      "hooks/print-usage.sh": `echo "run: bash skills/${rootBase}/hooks/setup.sh"\n`,
    };
    expect(scanFiles(map).danglingRefs).toEqual([]);
  });
});

/**
 * 🔴 THE SAME BLIND SPOT AGAIN, on the INSTRUCTION surface — and here the two
 * engines were not merely at risk of disagreeing, they DID.
 *
 * `scanPlugin` expanded the dialect's `alwaysLoaded` globs by walking the repo;
 * `scanFiles` ran the same globs over the whole fetched map with no walk and no
 * bound. So the CLI counted `pkg/sub/AGENTS.md` (it recursed to find it) and
 * `.claude/rules/**` (it descended), while the browser counted whatever the
 * fetcher happened to hold. Neither number was the harness's answer, and nothing
 * compared them: no vendored fixture ships `.claude/rules/`, a per-machine file
 * or an `@import`, so the byte-parity gate above could not see any of it.
 *
 * Both engines now call ONE method (`layout.instructionChain`) over ONE bounded
 * candidate set, and follow imports through ONE shared pass (`followImports`).
 * This is the fixture that would notice if only one of them stopped.
 */
describe("scanFiles parity for INSTRUCTION files (the shape no vendored fixture has)", () => {
  const files = {
    ".claude-plugin/plugin.json":
      '{"name":"instruction-repo","version":"0.1.0","description":"x"}',
    "CLAUDE.md": `${"a".repeat(100)}\n@docs/style.md\n`,
    // Read and linted, never scored: a gitignored file the browser can never see.
    "CLAUDE.local.md": "b".repeat(70),
    ".claude/rules/always.md": "c".repeat(50),
    // On demand, not at launch — the Claude Code over-report this fixes.
    ".claude/rules/scoped.md": '---\npaths: ["src/**"]\n---\nd',
    // Recursive: the flat classifier read this and classified it as nothing.
    ".claude/rules/team/deep.md": "e".repeat(30),
    // Outside the dot-dir bound, reached only because CLAUDE.md NAMES it.
    "docs/style.md": "f".repeat(20),
    // Named by nobody, in a directory the bound never opens.
    "docs/unnamed.md": "g".repeat(9999),
    // 🔴 THE FILE THAT MAKES THE BOUND OBSERVABLE ON THE BROWSER SIDE, and
    // without it a mutation removing the twin's bound stayed GREEN. The rules
    // pattern is position-independent (`(?:^|/)rules/…`, because a harness's
    // rules dir sits under whatever root it sits under), so a monorepo package's
    // own `rules/` matches it. On disk it is unreachable — the walk opens the
    // repo root and its depth-1 dot-directories only — so if the twin weighed
    // its whole fetched map the two engines would disagree by exactly this file.
    "packages/x/rules/theirs.md": "h".repeat(40),
  } as const;

  const write = (abs: string): void => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(abs, rel)), { recursive: true });
      writeFileSync(join(abs, rel), body);
    }
  };

  it("produces an identical AuditReport for a repo with a real instruction chain", () => {
    const tmp = makeTmpDir("parity-instructions");
    const abs = join(tmp, "instruction-repo");
    write(abs);

    const diskReport = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
    const fileReport = scanFiles(
      readDirToMap(abs),
      undefined,
      undefined,
      basename(abs),
    );
    expect(buildAuditReport(fileReport, OPTS)).toEqual(
      normalizeRoot(buildAuditReport(diskReport, OPTS), abs),
    );
    expect(stabilize(fileReport)).toEqual(
      stabilize(normalizeRoot(diskReport, abs)),
    );
    cleanupTmpDir(tmp);
  });

  it("…and BOTH engines reach the SAME numbers, which are the harness's answer", () => {
    // Parity is agreement, not correctness. Pin the absolute figures so the pair
    // cannot pass by being wrong together — which is exactly how they passed
    // while one walked the repo and the other weighed the whole fetched map.
    const tmp = makeTmpDir("parity-instructions-abs");
    const abs = join(tmp, "instruction-repo");
    write(abs);

    const disk = scanPlugin(abs, claudeCodeLayout, claudeCodeDialect);
    const browser = scanFiles(
      readDirToMap(abs),
      undefined,
      undefined,
      basename(abs),
    );
    // CLAUDE.md (100 + "\n@docs/style.md\n" = 116) + always 50 + deep 30
    // + the imported docs/style.md 20 = 216. `scoped.md` is on demand,
    // `docs/unnamed.md` was never named, and CLAUDE.local.md (70) is read but
    // NOT scored — it is the difference between the two totals below.
    for (const [name, r] of [
      ["disk", disk],
      ["browser", browser],
    ] as const) {
      expect([name, r.instructionWeight?.committedTotal]).toEqual([name, 216]);
      expect([name, r.instructionWeight?.effectiveTotal]).toEqual([name, 286]);
      expect([
        name,
        r.instructionWeight?.files.map((f) => f.path).sort(),
      ]).toEqual([
        name,
        [
          ".claude/rules/always.md",
          ".claude/rules/team/deep.md",
          "CLAUDE.local.md",
          "CLAUDE.md",
          "docs/style.md",
        ],
      ]);
    }
    cleanupTmpDir(tmp);
  });
});
