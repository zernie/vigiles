import { describe, it, expect } from "vitest";
import {
  enumerateEslintCatalog,
  enumeratePylintCatalog,
  parseEslintCatalog,
  parsePylintCatalog,
  mergeCatalogs,
  type RuleCatalog,
} from "./rule-catalog.js";

// Vitest runs from the repo root (see vitest.config.ts).
const REPO_ROOT = process.cwd();

describe("parseEslintCatalog (pure)", () => {
  it("parses a payload into core + plugin rules with enabled state", () => {
    const raw = JSON.stringify({
      core: ["no-console", "no-debugger"],
      enabled: ["no-console", "boundaries/dependencies"],
      plugins: {
        boundaries: ["dependencies", "element-types"],
        "@typescript-eslint": ["no-explicit-any"],
      },
    });
    const cat = parseEslintCatalog(raw);
    expect(cat).not.toBeNull();
    const catalog = cat as RuleCatalog;
    expect(catalog.linter).toBe("eslint");
    // 2 core + 2 boundaries + 1 ts-eslint
    expect(catalog.available).toBe(5);
    expect(catalog.rules).toHaveLength(5);
    // no-console (core, enabled) + boundaries/dependencies (enabled)
    expect(catalog.enabled).toBe(2);

    const core = catalog.rules.find((r) => r.id === "no-console");
    expect(core).toEqual({
      id: "no-console",
      linter: "eslint",
      plugin: null,
      enabled: true,
    });

    const disabledCore = catalog.rules.find((r) => r.id === "no-debugger");
    expect(disabledCore?.plugin).toBeNull();
    expect(disabledCore?.enabled).toBe(false);

    const boundaries = catalog.rules.find(
      (r) => r.id === "boundaries/dependencies",
    );
    expect(boundaries).toEqual({
      id: "boundaries/dependencies",
      linter: "eslint",
      plugin: "boundaries",
      enabled: true,
    });

    const tsRule = catalog.rules.find(
      (r) => r.id === "@typescript-eslint/no-explicit-any",
    );
    expect(tsRule?.plugin).toBe("@typescript-eslint");
    expect(tsRule?.enabled).toBe(false);
  });

  it("returns null for the sentinel, empty, malformed, and empty-catalog inputs", () => {
    expect(parseEslintCatalog("null")).toBeNull();
    expect(parseEslintCatalog("   ")).toBeNull();
    expect(parseEslintCatalog("")).toBeNull();
    expect(parseEslintCatalog("{ not json")).toBeNull();
    expect(parseEslintCatalog("[1,2,3]")).toBeNull();
    expect(parseEslintCatalog("42")).toBeNull();
    // valid object but no rules at all → null
    expect(
      parseEslintCatalog(
        JSON.stringify({ core: [], enabled: [], plugins: {} }),
      ),
    ).toBeNull();
  });

  it("tolerates missing / wrong-typed fields", () => {
    // no plugins key, enabled missing → still yields core rules, none enabled
    const cat = parseEslintCatalog(JSON.stringify({ core: ["no-with"] }));
    expect(cat?.available).toBe(1);
    expect(cat?.enabled).toBe(0);
    // non-string-array fields are ignored, not fatal
    const cat2 = parseEslintCatalog(
      JSON.stringify({ core: ["a", 1], enabled: 5, plugins: { p: "x" } }),
    );
    // core is not a clean string[] → dropped; plugins.p not a string[] → dropped
    expect(cat2).toBeNull();
  });
});

// Real fixtures captured from `pylint --list-msgs` / `--list-msgs-enabled`.
const PYLINT_LIST_MSGS = `Emittable messages with current interpreter:
:invalid-name (C0103): *%s name "%s" doesn't conform to %s*
  Used when the name doesn't conform to naming rules.
:missing-function-docstring (C0116): *Missing function or method docstring*
  Used when a function or method has no docstring.
:unused-import (W0611): *Unused %s*
  Used when an imported module or variable is not used.
:missing-raises-doc (W9006): *"%s" not documented as being raised*
  Used when a docstring does not document an exception.
`;

const PYLINT_LIST_ENABLED = `Enabled messages:
  invalid-name (C0103)
  missing-function-docstring (C0116)
  missing-raises-doc (W9006)

Disabled messages:
  unused-import (W0611)
  locally-disabled (I0011)

Non-emittable messages with current interpreter:
  raw-checker-failed (I0001)
`;

describe("parsePylintCatalog (pure)", () => {
  const cat = parsePylintCatalog(PYLINT_LIST_MSGS, PYLINT_LIST_ENABLED);

  it("parses available messages with symbolic id + numeric code", () => {
    expect(cat).not.toBeNull();
    const catalog = cat as RuleCatalog;
    expect(catalog.linter).toBe("pylint");
    expect(catalog.available).toBe(4);
    const docstring = catalog.rules.find(
      (r) => r.id === "missing-function-docstring",
    );
    expect(docstring).toEqual({
      id: "missing-function-docstring",
      linter: "pylint",
      plugin: null,
      code: "C0116",
      enabled: true,
    });
  });

  it("reads enabled state ONLY from the Enabled-messages section", () => {
    const catalog = cat as RuleCatalog;
    // invalid-name + missing-function-docstring + missing-raises-doc (a PLUGIN
    // message, W9xxx) are enabled; unused-import sits under "Disabled messages:"
    // (same line shape) and must NOT be read as enabled.
    expect(catalog.enabled).toBe(3);
    expect(catalog.rules.find((r) => r.id === "unused-import")?.enabled).toBe(
      false,
    );
    // the plugin message resolved + is enabled (plugin-inclusive catalog)
    expect(catalog.rules.find((r) => r.id === "missing-raises-doc")).toEqual({
      id: "missing-raises-doc",
      linter: "pylint",
      plugin: null,
      code: "W9006",
      enabled: true,
    });
  });

  it("returns null when nothing parses (pylint absent / empty)", () => {
    expect(parsePylintCatalog("", "")).toBeNull();
    expect(parsePylintCatalog("No config found\n", "")).toBeNull();
    // description lines without a leading colon never count as a rule
    expect(parsePylintCatalog("  wrapped description text\n", "")).toBeNull();
  });

  it("de-dupes a repeated message, skips a malformed colon line, tolerates a missing enabled listing", () => {
    const cat2 = parsePylintCatalog(
      // a colon-prefixed line that is NOT a `name (CODE)` message is skipped
      ":invalid-name (C0103): *x*\n:invalid-name (C0103): *x*\n:not a message\n",
      "",
    );
    expect(cat2?.available).toBe(1);
    expect(cat2?.enabled).toBe(0);
  });
});

describe("mergeCatalogs (pure)", () => {
  const eslint: RuleCatalog = {
    linter: "eslint",
    available: 1,
    enabled: 1,
    rules: [
      { id: "no-console", linter: "eslint", plugin: null, enabled: true },
    ],
  };
  const pylint: RuleCatalog = {
    linter: "pylint",
    available: 2,
    enabled: 1,
    rules: [
      {
        id: "invalid-name",
        linter: "pylint",
        plugin: null,
        code: "C0103",
        enabled: true,
      },
      {
        id: "unused-import",
        linter: "pylint",
        plugin: null,
        code: "W0611",
        enabled: false,
      },
    ],
  };

  it("returns undefined when nothing is present", () => {
    expect(mergeCatalogs(null, undefined)).toBeUndefined();
  });

  it("passes a lone catalog straight through", () => {
    expect(mergeCatalogs(null, eslint)).toBe(eslint);
  });

  it("concatenates rules across linters and recomputes totals", () => {
    const merged = mergeCatalogs(eslint, pylint);
    expect(merged?.available).toBe(3);
    expect(merged?.enabled).toBe(2);
    expect(merged?.rules.map((r) => r.id)).toEqual([
      "no-console",
      "invalid-name",
      "unused-import",
    ]);
  });

  it("KEEPS both entries on a cross-linter id collision (never drops one)", () => {
    // `no-else-return` is both an ESLint core rule and a Pylint symbol. Dropping
    // one by id was the bug that let a Python doc inherit ESLint's state; each is
    // a real rule in its own linter, so both survive with their own provenance.
    // (Collision routing is resolved at the lookup — see rule-routing.test.ts.)
    const pylintDup: RuleCatalog = {
      linter: "pylint",
      available: 1,
      enabled: 0,
      rules: [
        {
          id: "no-else-return",
          linter: "pylint",
          plugin: null,
          code: "R1705",
          enabled: false,
        },
      ],
    };
    const eslintDup: RuleCatalog = {
      linter: "eslint",
      available: 1,
      enabled: 1,
      rules: [
        { id: "no-else-return", linter: "eslint", plugin: null, enabled: true },
      ],
    };
    const merged = mergeCatalogs(eslintDup, pylintDup);
    expect(merged?.rules).toHaveLength(2);
    expect(merged?.available).toBe(2);
    expect(merged?.enabled).toBe(1); // ESLint's is on, Pylint's is off
    const pyHit = merged?.rules.find((r) => r.linter === "pylint");
    expect(pyHit?.code).toBe("R1705"); // the Pylint code alias survives the merge
    expect(pyHit?.enabled).toBe(false);
  });
});

describe("enumeratePylintCatalog (integration, executes pylint)", () => {
  const catalog = enumeratePylintCatalog(REPO_ROOT);

  if (!catalog) {
    it.skip("SKIPPED — pylint not runnable in this repo", () => {
      expect(catalog).toBeNull();
    });
    return;
  }

  it("enumerates pylint's messages with a subset enabled", () => {
    expect(catalog.linter).toBe("pylint");
    expect(catalog.available).toBeGreaterThan(100);
    expect(catalog.enabled).toBeGreaterThan(0);
    expect(catalog.enabled).toBeLessThanOrEqual(catalog.available);
    // every rule carries a numeric code alias
    expect(catalog.rules.every((r) => /^[A-Z]\d+$/.test(r.code ?? ""))).toBe(
      true,
    );
  });
});

describe("enumerateEslintCatalog (integration, executes ESLint)", () => {
  const catalog = enumerateEslintCatalog(REPO_ROOT);

  if (!catalog) {
    it.skip("SKIPPED — ESLint not resolvable in this repo", () => {
      expect(catalog).toBeNull();
    });
    return;
  }

  it("enumerates a large available catalog with a subset enabled", () => {
    expect(catalog.linter).toBe("eslint");
    expect(catalog.available).toBeGreaterThan(300);
    expect(catalog.enabled).toBeGreaterThan(0);
    expect(catalog.enabled).toBeLessThan(catalog.available);
    expect(catalog.rules).toHaveLength(catalog.available);
  });

  it("includes boundaries/dependencies with a correct plugin field", () => {
    const rule = catalog.rules.find((r) => r.id === "boundaries/dependencies");
    expect(rule).toBeDefined();
    expect(rule?.plugin).toBe("boundaries");
  });

  it("marks core rules with a null plugin and plugin rules with their prefix", () => {
    const core = catalog.rules.filter((r) => r.plugin === null);
    const plugin = catalog.rules.filter((r) => r.plugin !== null);
    expect(core.length).toBeGreaterThan(200);
    expect(plugin.length).toBeGreaterThan(0);
    // every plugin rule's id is prefixed with its plugin
    for (const r of plugin) {
      expect(r.id.startsWith(`${r.plugin ?? ""}/`)).toBe(true);
    }
  });
});
