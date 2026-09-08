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

  it("the website's linter strip AND language chip are DERIVED from BUILTIN_LINTERS (can't go stale)", () => {
    // The site hand-lists neither the linters nor the languages — both render
    // from the engine's BUILTIN_LINTERS, so drift is impossible by
    // construction. Guard that the derivation stays in place (a revert to a
    // hand-typed array would reintroduce the staleness this replaced).
    //
    // The derivation MOVED on 2026-09-08, from Wedge.tsx into site/src/lib/
    // linters.ts, when the hero's "is this for me?" chip stopped saying "Any
    // language · 11 linter catalogs" and started naming the languages — two
    // consumers, so one shared source. This test moved with it rather than
    // being deleted: the property it guards (derived, never typed) is
    // unchanged, only its address is. `linters.browser.test.ts` covers the
    // CONTENT of the two maps; this covers that the site still reads them.
    const lib = readFileSync(
      resolve(__dirname, "../../site/src/lib/linters.ts"),
      "utf8",
    );
    // imports the single source of truth…
    expect(lib).toMatch(
      /import\s*\{[^}]*\bBUILTIN_LINTERS\b[^}]*\}\s*from\s*["']@engine\/spec["']/,
    );
    // …derives BOTH the linter strip and the language list from it…
    expect(lib).toMatch(/BUILTIN_LINTERS\.map\(/);
    expect(lib).toMatch(/BUILTIN_LINTERS\.some\(/);
    // …not a reintroduced hand-typed string array of linter names.
    expect(lib).not.toMatch(/const LINTER_NAMES\s*=\s*\[\s*["']/);

    // And both consumers actually read the derived lists rather than
    // reintroducing a local literal.
    const wedge = readFileSync(
      resolve(__dirname, "../../site/src/components/sections/Wedge.tsx"),
      "utf8",
    );
    expect(wedge).toMatch(
      /\bLINTER_NAMES\b[^;]*from\s*["']@\/lib\/linters["']/s,
    );
    const hero = readFileSync(
      resolve(__dirname, "../../site/src/components/sections/Hero.tsx"),
      "utf8",
    );
    expect(hero).toMatch(/\bLANGUAGES\b[^;]*from\s*["']@\/lib\/linters["']/s);
    // The chip must not go back to the abstraction it replaced — asserted over
    // the CODE with comments stripped, not the raw file. The first version of
    // this line searched the whole source and failed on the comment that
    // EXPLAINS the change, which quotes the old chip verbatim. A substring
    // search over a document cannot tell an assertion from a discussion of one,
    // and in a well-commented file the discussion sits right next to the value.
    const heroCode = hero
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(heroCode).not.toMatch(/Any language/);
  });
});
