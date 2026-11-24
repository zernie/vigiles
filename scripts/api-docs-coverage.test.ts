/**
 * Every exported name of every public entry is documented on that entry's page.
 *
 * `docs/api/` holds one page per entry of package.json `exports`. A name counts
 * as documented when it appears in INLINE code on the page (a fenced example
 * does not count: an example shows how to call a name, it does not say what the
 * name is). The members of `check` count as `check.member`.
 *
 * Exports are read from the SOURCE with the TypeScript checker
 * (scripts/lib/entry-exports.mjs), the same machinery as the export gates in
 * scripts/export-gates.test.ts. The two matcher entries export no names (they
 * register matchers as a side effect), so for them the names are the matchers
 * in `vigilesMatchers`.
 *
 * A page that does not exist yet fails here, by design: the entry is listed in
 * ENTRY_PAGES the moment it exists in package.json, so a new entry cannot ship
 * without its page.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { budgetNames, entryExports } from "./lib/entry-exports.mjs";
import { vigilesMatchers } from "../src/harness-assert.js";

const ROOT = resolve(__dirname, "..");
const API_DIR = join(ROOT, "docs", "api");

/** Entry (a key of package.json `exports`) → its page under docs/api/. */
const ENTRY_PAGES: Readonly<Record<string, string>> = {
  ".": "vigiles.md",
  "./eval": "eval.md",
  "./spec": "spec.md",
  "./hook": "hook.md",
  "./hook/testing": "hook-testing.md",
  "./fixtures": "fixtures.md",
  "./harness/claude-code": "harness-claude-code.md",
  "./harness/codex": "harness-codex.md",
  "./harness/kit": "harness-kit.md",
  "./rule-proof": "rule-proof.md",
  "./vitest": "matchers.md",
  "./jest": "matchers.md",
};

/** Entries that export nothing: the documented names are the matchers they register. */
const MATCHER_ENTRIES = new Set(["./vitest", "./jest"]);

/** The identifiers (`a`, `a.b`) written inside inline code spans of a markdown file. */
function inlineCodeNames(markdown: string): Set<string> {
  const withoutFences = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const names = new Set<string>();
  for (const span of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    for (const id of (span[1] ?? "").matchAll(
      /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g,
    )) {
      names.add(id[0]);
    }
  }
  return names;
}

type Entries = ReturnType<typeof entryExports>;
let entries: Entries;
beforeAll(() => {
  entries = entryExports(ROOT);
}, 120_000);

describe("docs/api covers every entry", () => {
  test("every entry of package.json `exports` has a page in ENTRY_PAGES", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8"),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(ENTRY_PAGES).sort()).toEqual(
      Object.keys(pkg.exports).sort(),
    );
  });

  test("docs/api/README.md links every page", () => {
    const index = readFileSync(join(API_DIR, "README.md"), "utf-8");
    const missing = [...new Set(Object.values(ENTRY_PAGES))].filter(
      (page) => !index.includes(`](${page})`),
    );
    expect(missing).toEqual([]);
  });

  test("every exported name appears in inline code on its entry's page", () => {
    const problems: string[] = [];
    for (const [key, page] of Object.entries(ENTRY_PAGES)) {
      const file = join(API_DIR, page);
      if (!existsSync(file)) {
        problems.push(`${key}: docs/api/${page} does not exist`);
        continue;
      }
      const documented = inlineCodeNames(readFileSync(file, "utf-8"));
      const entry = entries.get(key);
      if (entry === undefined) {
        problems.push(`${key}: not an entry of package.json exports`);
        continue;
      }
      const names = MATCHER_ENTRIES.has(key)
        ? Object.keys(vigilesMatchers)
        : [
            // `check` itself plus each `check.member`: the object is a door too.
            ...entry.values.keys(),
            ...budgetNames(entry).filter((n) => n.includes(".")),
            ...entry.types,
          ];
      const missing = [...new Set(names)]
        .filter((n) => !documented.has(n))
        .sort();
      if (missing.length > 0) {
        problems.push(
          `${key}: docs/api/${page} does not mention ${missing.join(", ")}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
