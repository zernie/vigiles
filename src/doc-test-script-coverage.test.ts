/**
 * Doc-test-script coverage — unit tests for the detector PLUS the repo DOGFOOD:
 * every `test:*` script in `package.json` must be named on the tier map in
 * `CONTRIBUTING.md`. The map is the only place a contributor can learn a tier
 * exists, and a hand-written map goes stale the moment a script is added — so it
 * gets the same treatment the CLI verb list already has (doc-command-coverage).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  testTierScripts,
  scriptMentioned,
  findUndocumentedTestScripts,
} from "./doc-test-script-coverage.js";

describe("testTierScripts", () => {
  it("keeps the `test:` prefix only, sorted", () => {
    expect(
      testTierScripts({
        lint: "eslint",
        "test:unit": "x",
        test: "y",
        "test:harness": "z",
      }),
    ).toEqual(["test:harness", "test:unit"]);
  });
});

describe("scriptMentioned", () => {
  it("counts the name in a command or in prose", () => {
    expect(scriptMentioned("test:harness", "run `npm run test:harness`")).toBe(
      true,
    );
    expect(scriptMentioned("test:eval", "test:eval is not in CI.")).toBe(true);
  });

  it("does not let a LONGER script name document a shorter one", () => {
    expect(scriptMentioned("test:e2e", "`npm run test:e2e-live`")).toBe(false);
    expect(scriptMentioned("test:unit", "npm run test:unit-extra")).toBe(false);
  });

  it("is silent when the name is absent", () => {
    expect(scriptMentioned("test:types", "nothing about tiers here")).toBe(
      false,
    );
  });
});

describe("findUndocumentedTestScripts", () => {
  it("flags a tier absent from every doc", () => {
    const docs = [{ path: "a.md", content: "`npm run test:unit`" }];
    expect(
      findUndocumentedTestScripts(docs, {
        "test:unit": "x",
        "test:harness": "y",
      }),
    ).toEqual(["test:harness"]);
  });

  it("ignores non-tier scripts entirely", () => {
    expect(
      findUndocumentedTestScripts([], { build: "tsc", lint: "eslint" }),
    ).toEqual([]);
  });
});

// --- The repo dogfood -------------------------------------------------------

const ROOT = resolve(__dirname, "..");

describe("repo dogfood: every test tier is on the CONTRIBUTING map", () => {
  it("names every `test:*` script in CONTRIBUTING.md", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    const docs = [
      {
        path: "CONTRIBUTING.md",
        content: readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf-8"),
      },
    ];
    const missing = findUndocumentedTestScripts(docs, pkg.scripts);
    expect(
      missing,
      `test tiers missing from the CONTRIBUTING.md map: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
