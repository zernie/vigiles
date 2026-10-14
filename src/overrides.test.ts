/**
 * Per-path rule overrides — `.vigilesrc.json#overrides`, ESLint's `{ files,
 * rules }` cascade: `extends` < `rules` < each matching override, later over
 * earlier. One test per precedence step, the glob semantics shared with
 * top-level `exclude`, and the refusals.
 */
import { describe, it, expect } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  configFor,
  formatConfigIssues as formatIssues,
  VigilesConfigError,
  type ConfigIssue,
} from "./core/config-schema.js";
import { loadConfig as loadConfigFor } from "./core/validate.js";
import { RULES, RULE_GROUPS } from "./rules/index.js";

/** The config built over the shipped rule set, as the CLI builds it. */
const CONFIG = configFor(RULES, RULE_GROUPS);
const parseVigilesConfig = (raw: unknown) => CONFIG.parse(raw);
const formatConfigIssues = (issues: readonly ConfigIssue[]) =>
  formatIssues(CONFIG.schema, issues);
const loadConfig = (dir: string) => loadConfigFor(CONFIG, dir);
import { ruleResolver } from "./overrides.js";

/** Parse a raw config the way `loadConfig` does, or fail the test. */
function parsed(raw: unknown) {
  const r = parseVigilesConfig(raw);
  if (!r.success)
    throw new Error(formatConfigIssues(r.error.issues).join("\n"));
  return r.data;
}

/** The severity `rule` gets at `path` under `raw`. */
function at(raw: unknown, rule: "require-instructions-spec", path?: string) {
  const c = parsed(raw);
  return ruleResolver(c.rules, c.overrides).severityAt(rule, path);
}

/** The lines a config that cannot be honoured is refused with. */
function refused(raw: unknown): string {
  const r = parseVigilesConfig(raw);
  expect(r.success).toBe(false);
  return r.success ? "" : formatConfigIssues(r.error.issues).join("\n");
}

const RULE = "require-instructions-spec";
const REC = { extends: "vigiles:recommended" };

describe("precedence — extends < rules < overrides, later override wins", () => {
  it("extends: the preset sets the rule", () => {
    expect(at(REC, RULE, "notes/CLAUDE.md")).toBe("error");
  });

  it("rules over extends", () => {
    expect(at({ ...REC, rules: { [RULE]: "warn" } }, RULE, "x/CLAUDE.md")).toBe(
      "warn",
    );
  });

  it("an override over rules, for the paths it matches only", () => {
    const raw = {
      ...REC,
      overrides: [{ files: ["notes/**"], rules: { [RULE]: "off" } }],
    };
    expect(at(raw, RULE, "notes/a/CLAUDE.md")).toBe(false);
    expect(at(raw, RULE, "src/CLAUDE.md")).toBe("error");
  });

  it("a later override over an earlier one", () => {
    const raw = {
      ...REC,
      overrides: [
        { files: ["notes/**"], rules: { [RULE]: "off" } },
        { files: ["notes/keep/**"], rules: { [RULE]: "warn" } },
      ],
    };
    expect(at(raw, RULE, "notes/keep/CLAUDE.md")).toBe("warn");
    expect(at(raw, RULE, "notes/other/CLAUDE.md")).toBe(false);
  });

  it("a finding with no path keeps the rule's own severity", () => {
    const raw = {
      ...REC,
      overrides: [{ files: ["**"], rules: { [RULE]: "off" } }],
    };
    expect(at(raw, RULE)).toBe("error");
  });
});

describe("globs — the same semantics as top-level `exclude`", () => {
  it("a bare folder name covers its subtree", () => {
    const raw = {
      ...REC,
      overrides: [{ files: "notes", rules: { [RULE]: "off" } }],
    };
    expect(at(raw, RULE, "notes/deep/CLAUDE.md")).toBe(false);
  });

  it("dotfiles match, and a leading ./ is ignored", () => {
    const raw = {
      ...REC,
      overrides: [{ files: ["./.hidden/**"], rules: { [RULE]: "off" } }],
    };
    expect(at(raw, RULE, ".hidden/CLAUDE.md")).toBe(false);
  });
});

describe("mayFire — a rule off in `rules` can be turned on for some paths", () => {
  it("is true when an override turns it on", () => {
    const c = parsed({
      rules: { [RULE]: "off" },
      overrides: [{ files: ["src/**"], rules: { [RULE]: "error" } }],
    });
    const r = ruleResolver(c.rules, c.overrides);
    expect(r.mayFire(RULE)).toBe(true);
    expect(r.severityAt(RULE, "src/CLAUDE.md")).toBe("error");
    expect(r.severityAt(RULE, "CLAUDE.md")).toBe(false);
  });

  it("is false when nothing turns it on", () => {
    const c = parsed({ rules: { [RULE]: "off" } });
    expect(ruleResolver(c.rules, c.overrides).mayFire(RULE)).toBe(false);
  });
});

describe("refusals", () => {
  it("an unknown rule name inside an override, with the near miss", () => {
    expect(
      refused({
        overrides: [{ files: ["a/**"], rules: { "spec-ref": "off" } }],
      }),
    ).toBe(
      '.vigilesrc.json: unknown key "spec-ref" in overrides.0.rules. Did you mean "spec-refs"?',
    );
  });

  it("an unknown key in an override object, with the near miss", () => {
    expect(
      refused({ overrides: [{ file: ["a/**"], rules: { [RULE]: "off" } }] }),
    ).toContain('unknown key "file" in overrides.0. Did you mean "files"?');
  });

  it("an override with no files", () => {
    expect(
      refused({ overrides: [{ files: [], rules: { [RULE]: "off" } }] }),
    ).toContain("overrides.0.files");
  });

  it("options in an override — they live in `rules`", () => {
    expect(
      refused({
        overrides: [
          {
            files: ["a/**"],
            rules: { "compile-budget": ["error", { maxRulesChars: 1 }] },
          },
        ],
      }),
    ).toContain("overrides.0.rules.compile-budget");
  });
});

describe("the per-rule `exclude` options moved to `overrides`", () => {
  /** What `loadConfig` says about a `.vigilesrc.json` holding `raw`. */
  function loaded(raw: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-moved-exclude-"));
    try {
      writeFileSync(join(dir, ".vigilesrc.json"), JSON.stringify(raw));
      loadConfig(dir);
      return "";
    } catch (e) {
      expect(e).toBeInstanceOf(VigilesConfigError);
      return e instanceof Error ? e.message : "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("untested-*: refused with the overrides entry built from the user's globs", () => {
    const msg = loaded({
      rules: {
        "untested-skill": ["warn", { exclude: ["bench/**", "vendor"] }],
      },
    });
    expect(msg).toContain(
      '"exclude" inside "untested-skill" moved to "overrides"',
    );
    expect(msg).toContain(
      '{ "files": ["bench/**", "vendor"], "rules": { "untested-skill": "off", "untested-subagent": "off", "untested-hook": "off", "untested-output-style": "off" } }',
    );
  });

  it("orphans.exclude: refused with the overrides entry built from the user's globs", () => {
    const msg = loaded({
      orphans: { include: ["docs/**/*.md"], exclude: ["docs/archive/**"] },
    });
    expect(msg).toContain('"exclude" inside "orphans" moved to "overrides"');
    expect(msg).toContain(
      '{ "files": ["docs/archive/**"], "rules": { "orphan-docs": "off" } }',
    );
  });

  it("the schema itself no longer accepts them", () => {
    expect(refused({ orphans: { exclude: ["a/**"] } })).toContain(
      'unknown key "exclude" in orphans',
    );
  });

  it("`include` stays a rule option", () => {
    expect(
      parseVigilesConfig({
        rules: {
          "untested-skill": [
            "warn",
            { include: ["tests/{surface}/*.eval.ts"] },
          ],
        },
        orphans: { include: ["docs/**/*.md"] },
      }).success,
    ).toBe(true);
  });
});
