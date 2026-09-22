import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findOrphanDocs, formatOrphanReport } from "./orphans.js";
import { makeTmpDir, cleanupTmpDir } from "./test-utils.js";
import type { PluginLayout } from "./layout.js";
import { claudeCodeLayout } from "../adapters/claude-code/layout.js";

// Harness surfaces are injected (core stays harness-agnostic). Real usage passes
// every registered adapter's layout; here we pass Claude Code plus a Codex-shaped
// layout (AGENTS.md) to exercise the multi-harness instruction-file exemption.
const HARNESS_LAYOUTS = [
  claudeCodeLayout,
  { ...claudeCodeLayout, name: "codex", instructionFile: "AGENTS.md" },
];

describe("findOrphanDocs()", () => {
  it("flags docs not referenced anywhere (default scope = docs/ only)", () => {
    const dir = makeTmpDir("orphans");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      mkdirSync(join(dir, "research"), { recursive: true });
      writeFileSync(join(dir, "docs/referenced.md"), "# ref");
      writeFileSync(join(dir, "docs/orphan.md"), "# orphan");
      // research/ is NOT in the default scope — `docs/` is the common
      // convention; a vigiles-specific dir is opted into explicitly (via
      // `orphans.include`), so research/stale.md is not scanned here.
      writeFileSync(join(dir, "research/stale.md"), "# stale");
      writeFileSync(
        join(dir, "README.md"),
        "See [docs](docs/referenced.md) for more.",
      );

      const report = findOrphanDocs({ basePath: dir });
      assert.deepEqual([...report.orphans], ["docs/orphan.md"]);
      assert.deepEqual([...report.referencedDocs], ["docs/referenced.md"]);
      assert.equal(report.totalDocs, 2);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("never flags harness-loaded instruction files, even when scanned", () => {
    const dir = makeTmpDir("orphans-instruction");
    try {
      mkdirSync(join(dir, "skills/greet"), { recursive: true });
      mkdirSync(join(dir, "agents"), { recursive: true });
      mkdirSync(join(dir, "commands"), { recursive: true });
      // Harness-loaded surfaces — load-bearing by name/location, never orphans.
      writeFileSync(join(dir, "CLAUDE.md"), "# instructions");
      writeFileSync(join(dir, "AGENTS.md"), "# instructions");
      writeFileSync(join(dir, "skills/greet/SKILL.md"), "# greet");
      writeFileSync(join(dir, "agents/reviewer.md"), "# reviewer");
      writeFileSync(join(dir, "commands/ship.md"), "# ship");
      // A genuine orphan doc to prove the scan still works under a broad include.
      writeFileSync(join(dir, "rot.md"), "# nobody links me");

      // Broaden include to the whole repo — instruction files must stay exempt.
      const report = findOrphanDocs({
        basePath: dir,
        include: ["**/*.md"],
        layouts: HARNESS_LAYOUTS,
      });
      assert.deepEqual([...report.orphans], ["rot.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("only exempts a harness surface at a real root, not a docs subdir sharing the name", () => {
    const dir = makeTmpDir("orphans-surface-root");
    try {
      mkdirSync(join(dir, "docs/prompts"), { recursive: true });
      mkdirSync(join(dir, "prompts"), { recursive: true });
      // Codex's command surface is `prompts`. At the REPO ROOT it's a real
      // surface (never an orphan); under `docs/` it's just documentation and
      // must still be flagged — the exemption anchors to the surface root, not
      // any nested dir that shares the name.
      writeFileSync(join(dir, "prompts/run.md"), "# a real command surface");
      writeFileSync(join(dir, "docs/prompts/guide.md"), "# unreferenced doc");
      const codexLayout: PluginLayout = {
        ...claudeCodeLayout,
        name: "codex",
        instructionFile: "AGENTS.md",
        // No `agent` key — a harness without that surface omits it (it used to
        // be `agentDir: ""`, a second spelling of the same absence).
        surfaces: { skill: "skills", command: "prompts" },
      };
      const report = findOrphanDocs({
        basePath: dir,
        include: ["**/*.md"],
        layouts: [codexLayout],
      });
      assert.deepEqual([...report.orphans], ["docs/prompts/guide.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("still credits a doc that only a CLAUDE.md references", () => {
    const dir = makeTmpDir("orphans-cref");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/guide.md"), "# guide");
      // The exemption removes CLAUDE.md from the CANDIDATE set but it still
      // counts as a REFERENCER, so docs/guide.md is not an orphan.
      writeFileSync(join(dir, "CLAUDE.md"), "See [guide](docs/guide.md).");

      const report = findOrphanDocs({
        basePath: dir,
        include: ["**/*.md"],
        layouts: HARNESS_LAYOUTS,
      });
      assert.deepEqual([...report.orphans], []);
      assert.deepEqual([...report.referencedDocs], ["docs/guide.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("recognizes backtick path references", () => {
    const dir = makeTmpDir("orphans-tick");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/foo.md"), "# foo");
      writeFileSync(join(dir, "CLAUDE.md"), "See `docs/foo.md` for details.");

      const report = findOrphanDocs({ basePath: dir });
      assert.deepEqual([...report.orphans], []);
      assert.deepEqual([...report.referencedDocs], ["docs/foo.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("does not count a doc as referenced by itself", () => {
    const dir = makeTmpDir("orphans-self");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(
        join(dir, "docs/lonely.md"),
        "See [me](docs/lonely.md) for details.",
      );

      const report = findOrphanDocs({ basePath: dir });
      assert.deepEqual([...report.orphans], ["docs/lonely.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("honors custom include globs", () => {
    const dir = makeTmpDir("orphans-include");
    try {
      mkdirSync(join(dir, "guides"), { recursive: true });
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "guides/lost.md"), "# lost");
      writeFileSync(join(dir, "docs/ignored.md"), "# not scanned");
      writeFileSync(join(dir, "README.md"), "hello");

      const report = findOrphanDocs({
        basePath: dir,
        include: ["guides/**/*.md"],
      });
      assert.deepEqual([...report.orphans], ["guides/lost.md"]);
      assert.equal(report.totalDocs, 1);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("supports tsconfig-style exclude within include scope", () => {
    const dir = makeTmpDir("orphans-exclude");
    try {
      mkdirSync(join(dir, "docs/legacy"), { recursive: true });
      writeFileSync(join(dir, "docs/active.md"), "# active");
      writeFileSync(join(dir, "docs/legacy/old1.md"), "# legacy");
      writeFileSync(join(dir, "docs/legacy/old2.md"), "# legacy");
      writeFileSync(join(dir, "README.md"), "hello");

      const report = findOrphanDocs({
        basePath: dir,
        include: ["docs/**/*.md"],
        exclude: ["docs/legacy/**"],
      });
      // Only docs/active.md scanned; legacy files excluded entirely.
      assert.equal(report.totalDocs, 1);
      assert.deepEqual([...report.orphans], ["docs/active.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("repoExclude drops an excluded corpus from BOTH walks: not a candidate, not a referencer (#192)", () => {
    const dir = makeTmpDir("orphans-repo-exclude");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      mkdirSync(join(dir, "vendored/docs"), { recursive: true });
      // kept.md is referenced ONLY from inside the vendored corpus.
      writeFileSync(join(dir, "docs/kept.md"), "# kept");
      writeFileSync(
        join(dir, "vendored/docs/theirs.md"),
        "see [kept](../../docs/kept.md)",
      );
      writeFileSync(join(dir, "README.md"), "hello");
      const include = ["docs/**/*.md", "vendored/docs/**/*.md"];

      // Control (no repoExclude): the vendored link keeps kept.md alive, and the
      // vendored doc itself is an orphan candidate — so the exclusion below is
      // observable in both directions, not a no-op on an empty scan.
      const control = findOrphanDocs({ basePath: dir, include });
      assert.equal(control.totalDocs, 2);
      assert.deepEqual([...control.orphans], ["vendored/docs/theirs.md"]);

      // Bare directory name, no `/**` — the spelling the string-glob dialect
      // silently ignored (measured 2026-09-03); passed here the way the CLI
      // passes it, as the ExcludeSet string face (name + name/**).
      const excluded = findOrphanDocs({
        basePath: dir,
        include,
        repoExclude: ["vendored", "vendored/**"],
      });
      assert.equal(
        excluded.totalDocs,
        1,
        "the vendored doc is no longer a candidate",
      );
      assert.deepEqual(
        [...excluded.orphans],
        ["docs/kept.md"],
        "a link from an excluded corpus no longer keeps a doc alive",
      );

      // The rule-level `exclude` narrows CANDIDACY only: with it (and no
      // repoExclude) the vendored doc still counts as a referencer.
      const narrowed = findOrphanDocs({
        basePath: dir,
        include,
        exclude: ["vendored/**"],
      });
      assert.equal(narrowed.totalDocs, 1);
      assert.deepEqual(
        [...narrowed.orphans],
        [],
        "kept.md is still referenced by the vendored doc",
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("empty include disables scanning (no orphans reported)", () => {
    const dir = makeTmpDir("orphans-empty-include");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/foo.md"), "# foo");

      const report = findOrphanDocs({ basePath: dir, include: [] });
      assert.equal(report.totalDocs, 0);
      assert.deepEqual([...report.orphans], []);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("multiple include globs combine without duplicates", () => {
    const dir = makeTmpDir("orphans-multi-include");
    try {
      mkdirSync(join(dir, "wiki"), { recursive: true });
      mkdirSync(join(dir, "handbook"), { recursive: true });
      writeFileSync(join(dir, "wiki/a.md"), "# a");
      writeFileSync(join(dir, "handbook/b.md"), "# b");

      const report = findOrphanDocs({
        basePath: dir,
        include: ["wiki/**/*.md", "handbook/**/*.md"],
      });
      assert.equal(report.totalDocs, 2);
      assert.deepEqual([...report.orphans].sort(), [
        "handbook/b.md",
        "wiki/a.md",
      ]);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("credits a file-relative link from a same-directory index (not just root-relative)", () => {
    const dir = makeTmpDir("orphans-relative");
    try {
      mkdirSync(join(dir, "research"), { recursive: true });
      writeFileSync(join(dir, "research/target.md"), "# target");
      // A bare, file-relative link from research/README.md → research/target.md
      writeFileSync(
        join(dir, "research/README.md"),
        "See [target](target.md) for details.",
      );

      const report = findOrphanDocs({
        basePath: dir,
        include: ["research/**/*.md"],
      });
      // target.md is referenced by the sibling README via a relative link.
      assert.ok(!report.orphans.includes("research/target.md"));
      assert.ok(report.referencedDocs.includes("research/target.md"));
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("resolves `../` relative links across directories", () => {
    const dir = makeTmpDir("orphans-updir");
    try {
      mkdirSync(join(dir, "research"), { recursive: true });
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "research/deep.md"), "# deep");
      // docs/guide.md → ../research/deep.md
      writeFileSync(
        join(dir, "docs/guide.md"),
        "Background: [deep](../research/deep.md).",
      );
      writeFileSync(join(dir, "README.md"), "[g](docs/guide.md)");

      const report = findOrphanDocs({ basePath: dir });
      assert.ok(!report.orphans.includes("research/deep.md"));
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("honors an inline `vigiles-disable orphan-docs` marker", () => {
    const dir = makeTmpDir("orphans-disable");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/rot.md"), "# rot");
      writeFileSync(
        join(dir, "docs/intentional.md"),
        "# intentional\n\n<!-- vigiles-disable orphan-docs -->\n",
      );
      writeFileSync(join(dir, "README.md"), "hello");

      const report = findOrphanDocs({ basePath: dir });
      // The marked doc is exempt entirely (not even counted); only rot.md flags.
      assert.deepEqual([...report.orphans], ["docs/rot.md"]);
      assert.equal(report.totalDocs, 1);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("ignores node_modules, dist, and .vigiles", () => {
    const dir = makeTmpDir("orphans-ignore");
    try {
      mkdirSync(join(dir, "docs"), { recursive: true });
      mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "docs/target.md"), "# target");
      // Only nested noise references the doc — should not save it
      writeFileSync(
        join(dir, "node_modules/pkg/README.md"),
        "[t](docs/target.md)",
      );
      writeFileSync(join(dir, "dist/CLAUDE.md"), "[t](docs/target.md)");

      const report = findOrphanDocs({ basePath: dir });
      assert.deepEqual([...report.orphans], ["docs/target.md"]);
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

describe("formatOrphanReport()", () => {
  it("reports a clean state succinctly", () => {
    const out = formatOrphanReport({
      include: ["docs/**/*.md"],
      totalDocs: 3,
      referencedDocs: ["docs/a.md", "docs/b.md", "docs/c.md"],
      orphans: [],
    });
    assert.match(out, /no orphan docs/);
  });

  it("lists orphans when present", () => {
    const out = formatOrphanReport({
      include: ["docs/**/*.md"],
      totalDocs: 2,
      referencedDocs: ["docs/a.md"],
      orphans: ["docs/b.md"],
    });
    assert.match(out, /1 orphan/);
    assert.match(out, /docs\/b\.md/);
    // Points the user at both escape hatches when something is flagged.
    assert.match(out, /vigiles-disable orphan-docs/);
    assert.match(out, /orphans\.exclude/);
  });
});
