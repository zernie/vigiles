/**
 * Doc-command coverage — unit tests for the detector PLUS the repo DOGFOOD: every
 * public CLI verb must be mentioned in a command context somewhere under `docs/`.
 * The deterministic floor under the `document-the-why` rule — a verb shipped
 * without a doc home fails CI here, the inverse of self-command-refs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  verbMentioned,
  findUndocumentedVerbs,
  COVERAGE_EXEMPT,
} from "./doc-command-coverage.js";
import { VERBS } from "./cli-commands.js";

describe("verbMentioned", () => {
  it("counts `vigiles <verb>` and `npx vigiles <verb>`", () => {
    expect(verbMentioned("audit", "Run `npx vigiles audit ./x`.")).toBe(true);
    expect(verbMentioned("audit", "Then vigiles audit reports it.")).toBe(true);
  });

  it("counts a backtick-prefixed verb", () => {
    expect(verbMentioned("lint", "The `lint` gate fails CI.")).toBe(true);
    expect(
      verbMentioned("scaffold-test", "Use `scaffold-test` to start."),
    ).toBe(true);
  });

  it("does NOT count a bare English word out of command context", () => {
    expect(verbMentioned("test", "You should test your harness.")).toBe(false);
    expect(verbMentioned("audit", "a security audit of the changes")).toBe(
      false,
    );
  });
});

describe("findUndocumentedVerbs", () => {
  it("flags a verb absent from all docs", () => {
    const docs = [{ path: "a.md", content: "Run `npx vigiles audit`." }];
    const undoc = findUndocumentedVerbs(docs, ["audit", "lint"], []);
    expect(undoc).toEqual(["lint"]);
  });

  it("treats a verb mentioned in any one doc as covered", () => {
    const docs = [
      { path: "a.md", content: "nothing here" },
      { path: "b.md", content: "`lint` is the gate." },
    ];
    expect(findUndocumentedVerbs(docs, ["lint"], [])).toEqual([]);
  });

  it("exempts the hidden hook-runtime umbrella by default", () => {
    expect(findUndocumentedVerbs([], ["hook-runtime"])).toEqual([]);
    expect(COVERAGE_EXEMPT).toContain("hook-runtime");
  });
});

// --- The repo dogfood -------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");

/** Every `docs/**\/*.md` file, recursively. */
function gatherDocs(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const add = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) add(rel);
      else if (e.name.endsWith(".md"))
        out.push({
          path: rel,
          content: readFileSync(join(ROOT, rel), "utf-8"),
        });
    }
  };
  add("docs");
  return out;
}

describe("repo dogfood: every public verb is documented under docs/", () => {
  it("has a doc home for every human-facing verb", () => {
    const undoc = findUndocumentedVerbs(gatherDocs(), VERBS);
    expect(
      undoc,
      `verbs with no mention under docs/: ${undoc.join(", ")}`,
    ).toEqual([]);
  });
});
