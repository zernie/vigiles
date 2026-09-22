/**
 * OpenCode's instruction chain — the only implementation in this repo that
 * populates `InstructionChain.patterns`, which is why it is tested rather than
 * left to the prototype's usual "exercised by the port properties" treatment.
 *
 * A glob the harness would expand at launch is REPORTED and never walked. That
 * is the whole difference from the mechanism this replaced: `alwaysLoaded` also
 * held patterns, and the core walked the user's repository to expand them.
 */
import { describe, it, expect } from "vitest";

import { opencodeLayout } from "./layout.js";

const chain = (files: Record<string, string>) =>
  opencodeLayout.instructionChain(files);

const withInstructions = (...entries: string[]): Record<string, string> => ({
  "AGENTS.md": "root",
  "opencode.json": JSON.stringify({ instructions: entries }),
});

describe("patterns are reported, never expanded", () => {
  it("a glob becomes a pattern and no file is opened for it", () => {
    const files = withInstructions("packages/*/AGENTS.md");
    expect(chain(files).patterns).toEqual([
      { pattern: "packages/*/AGENTS.md", from: "opencode.json" },
    ]);
    expect(chain(files).loaded.map((e) => e.path)).toEqual(["AGENTS.md"]);
  });

  it("the pattern string literally occurs in the file that names it", () => {
    // The property `adapter-properties.test.ts` asserts for every
    // implementation, stated once here on the only one that can fail it.
    const files = withInstructions("packages/*/AGENTS.md");
    const { pattern, from } = chain(files).patterns[0] ?? {
      pattern: "",
      from: "",
    };
    expect(files[from]?.includes(pattern)).toBe(true);
  });

  it("a URL is a pattern too — it is not a path this repo holds", () => {
    expect(
      chain(withInstructions("https://x.test/a.md")).patterns,
    ).toHaveLength(1);
  });
});

describe("a concrete path is an import, and loads when it is in the map", () => {
  it("loads a named file", () => {
    const files = {
      ...withInstructions("docs/house-style.md"),
      "docs/house-style.md": "body",
    };
    expect(chain(files).loaded.map((e) => [e.path, e.role])).toEqual([
      ["AGENTS.md", "root"],
      ["docs/house-style.md", "import"],
    ]);
  });

  it("reports a named file that is not in the map, rather than dropping it", () => {
    expect(chain(withInstructions("docs/missing.md")).imports).toEqual([
      {
        path: "docs/missing.md",
        token: "docs/missing.md",
        from: "opencode.json",
      },
    ]);
  });

  it("refuses a path that leaves the repository", () => {
    expect(chain(withInstructions("../escape.md")).imports).toEqual([]);
  });

  it("an unparseable manifest names nothing rather than throwing", () => {
    expect(
      chain({ "AGENTS.md": "root", "opencode.json": "{ not json" }).patterns,
    ).toEqual([]);
  });

  it("an `instructions` key of the wrong TYPE is ignored", () => {
    expect(
      chain({
        "AGENTS.md": "root",
        "opencode.json": JSON.stringify({ instructions: "a.md" }),
      }).imports,
    ).toEqual([]);
  });
});
