/**
 * source-refs — the two token boundaries and the comment rule that keep a
 * character-run path scan from accusing a file that is right there.
 *
 * Every case here has BOTH halves: it fires on a planted defect and stays
 * silent on the clean shape next to it. A boundary that only ever suppresses is
 * indistinguishable from a deleted check.
 */
import { describe, it, expect } from "vitest";

import {
  intraRefPattern,
  scriptRefPattern,
  startsAtSeparator,
  stripFullLineComments,
  INTRA_REF_EXTENSIONS,
} from "./source-refs.js";

const DIRS = ["hooks", "skills", "agents", "commands"];
const all = (src: string): string[] => src.match(intraRefPattern(DIRS)) ?? [];

describe("intraRefPattern — the RIGHT boundary", () => {
  it("reads hooks/hooks.json as .json, not as .js", () => {
    // The live defect: `js` sits ahead of `json` in the alternation, and with no
    // trailing assertion it claimed the head of `.json`. Reported on
    // microsoft/power-platform-skills as "hooks/hooks.js MISSING" while
    // hooks/hooks.json sat in the same directory.
    expect(all("see hooks/hooks.json for details")).toEqual([
      "hooks/hooks.json",
    ]);
  });

  it("does not match an extension that is merely a prefix of the token's", () => {
    // .jsonl / .pyc are not in the vocabulary; a partial match is a fabrication.
    expect(all("see hooks/table.jsonl")).toEqual([]);
    expect(all("see hooks/mod.pyc")).toEqual([]);
  });

  it("still matches every extension it claims to", () => {
    for (const ext of INTRA_REF_EXTENSIONS) {
      expect(all(`cat hooks/a.${ext}`)).toEqual([`hooks/a.${ext}`]);
    }
  });

  it("keeps the prior `\\b` behaviour on a compound suffix", () => {
    expect(all("cat hooks/bundle.js.map")).toEqual(["hooks/bundle.js"]);
  });
});

describe("startsAtSeparator — the LEFT boundary", () => {
  it("rejects a surface dir matched in the middle of a longer name", () => {
    // fcakyon/claude-codex-settings: `../../../claude-agents/fable-advisor.md`
    // resolved fine and was reported as a broken `agents/fable-advisor.md`.
    const src = 'new URL("../../claude-agents/adv.md", import.meta.url)';
    const idx = src.indexOf("agents/adv.md");
    expect(startsAtSeparator(src, idx)).toBe(false);
  });

  it("accepts a reference at a real boundary", () => {
    for (const src of [
      "agents/adv.md",
      'cat "agents/adv.md"',
      "cat agents/adv.md",
      "${CLAUDE_PLUGIN_ROOT}/agents/adv.md",
      "run(agents/adv.md)",
    ]) {
      const idx = src.indexOf("agents/adv.md");
      expect([src, startsAtSeparator(src, idx)]).toEqual([src, true]);
    }
  });
});

describe("scriptRefPattern — unanchored, but still right-bounded", () => {
  it("does not truncate .json to .js", () => {
    expect("hooks/hooks.json".match(scriptRefPattern())).toBeNull();
    expect("hooks/hooks.mjs".match(scriptRefPattern())).toEqual([
      "hooks/hooks.mjs",
    ]);
  });
});

describe("stripFullLineComments", () => {
  const JSDOC = [
    "/**",
    " * It is deliberately not registered in hooks/hooks.json:",
    " */",
    'require("./real.js");',
  ].join("\n");

  it("drops a JSDoc line that only NAMES a path", () => {
    // Both remaining corpus false positives in this detector were exactly this.
    const out = stripFullLineComments("hooks/h.js", JSDOC);
    expect(out).not.toContain("hooks/hooks.json");
    expect(out).toContain('require("./real.js");');
  });

  it("drops a `//` line and a shell `#` line", () => {
    expect(stripFullLineComments("hooks/h.js", "// hooks/a.mjs\nrun()")).toBe(
      "run()",
    );
    expect(stripFullLineComments("hooks/h.sh", "# hooks/a.sh\nrun")).toBe(
      "run",
    );
  });

  it("keeps a generator method, which starts with `*` and is not a comment", () => {
    // `*run() {}` would be deleted by a naive "line starts with *" rule, taking
    // any real reference on it along.
    const src = "class A {\n  *run() { load('hooks/a.mjs'); }\n}";
    expect(stripFullLineComments("hooks/h.js", src)).toBe(src);
  });

  it("keeps a TRAILING comment on a code line — full-line only, by design", () => {
    const src = 'load("hooks/a.mjs"); // see hooks/b.mjs';
    expect(stripFullLineComments("hooks/h.js", src)).toBe(src);
  });

  it("returns an unknown file kind unchanged rather than guessing a syntax", () => {
    const src = "# hooks/a.go\nfunc main() {}";
    expect(stripFullLineComments("hooks/h.go", src)).toBe(src);
  });
});
