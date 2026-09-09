/**
 * LinterAdapter CONFORMANCE — the parity gate that makes "add a linter" safe.
 *
 * The `LINTERS` registry (Record<BuiltinLinter, LinterAdapter>) already makes a
 * MISSING linter a tsc error. This suite covers the parity a type can't see:
 * every capability flag matches the presence of its method, the key matches the
 * adapter's `name`, the registry keys match the `BuiltinLinter` union AND the
 * `docs/linter-support.md` table (the drift that shipped "only 7 catalogs" in a
 * sibling doc would fail HERE). Mirrors adapter-contract.test.ts (loop the
 * registry) + rule-meta.test.ts (docs set-match). See
 * research/linter-adapter-architecture.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LINTERS } from "./linters.js";
import { BUILTIN_LINTERS } from "./spec.js";

// BUILTIN_LINTERS is the single source the BuiltinLinter type derives from; the
// set-equality checks below tie it ⇄ the registry ⇄ the docs, so adding a linter
// must touch all three (the array, the registry, the docs table) or a test fails.
const ALL_LINTERS = BUILTIN_LINTERS;

/** Lowercased linter names from the `## Supported Linters` table. */
function docLinterNames(): Set<string> {
  const md = readFileSync(
    resolve(__dirname, "../../docs/linter-support.md"),
    "utf8",
  );
  const section = md.split("## Supported Linters")[1]?.split("\n## ")[0] ?? "";
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    const m = /^\|\s*([A-Za-z][\w-]*)\s*\|/.exec(line);
    if (!m) continue;
    const cell = m[1].toLowerCase();
    if (cell === "linter") continue; // the header row
    names.add(cell);
  }
  return names;
}

describe("LinterAdapter conformance", () => {
  it("every adapter's key matches its declared name", () => {
    for (const [key, adapter] of Object.entries(LINTERS)) {
      expect(adapter.name).toBe(key);
    }
  });

  it("each capability flag matches the presence of its method", () => {
    for (const adapter of Object.values(LINTERS)) {
      const c = adapter.capabilities;
      expect(c.configCheck).toBe(adapter.configEnabled !== undefined);
      expect(c.catalogEnumeration).toBe(adapter.enumerateRules !== undefined);
      expect(c.generateTypes).toBe(adapter.discoverEnabled !== undefined);
      // a `cli` linter is PATH-gated (has a tool); node-api/filesystem/format-only are not.
      expect(c.existenceCheck === "cli").toBe(adapter.cliTool !== undefined);
      // an always-enabled linter (cedar) has no separate config-enabled read.
      if (c.alwaysEnabled) {
        expect(adapter.configEnabled === undefined).toBe(true);
      }
    }
  });

  it("registry keys == the BuiltinLinter union witness", () => {
    expect(Object.keys(LINTERS).sort()).toEqual([...ALL_LINTERS].sort());
  });

  it("registry keys == the docs/linter-support.md table (anti-drift gate)", () => {
    // The single check that would have caught the stale 'only 7 catalogs' docs:
    // a linter added to the registry but not the table (or vice-versa) fails.
    expect([...docLinterNames()].sort()).toEqual(Object.keys(LINTERS).sort());
  });

  // The site's own derivation is asserted ON THE SITE, in
  // site/src/lib/linters.browser.test.ts, which recomputes LINTER_NAMES and
  // LANGUAGES from BUILTIN_LINTERS and compares VALUES.
  //
  // 🔴 A test used to sit here that read two files under site/ off disk and
  // regexed their SOURCE for an import line and against a phrase. Three things
  // were wrong with it and only the third was visible: it asserted the shape of
  // the text rather than the value, so a rename or a reformat broke it; a
  // substring search cannot tell an assertion from a comment discussing one, and
  // it had already fired on exactly that; and it made a ROOT test depend on a
  // SITE file, so when #219 (site-only) deleted one, the `changes` filter skipped
  // the root jobs, the PR merged green and main went red on an ENOENT. Deleted
  // 2026-09-09 rather than patched a third time. src/ci-path-filter.test.ts now
  // asserts that NO root test reads site/, which is the invariant the CI filter
  // always claimed and never checked.
});
