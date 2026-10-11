/**
 * `keyFiles` deprecation — the measurement the `deprecated-key-files` rule
 * reports, its message, and the static reader that finds the field in a spec
 * without running it (lint and audit both read specs; neither executes them).
 *
 * Both halves of every check: it fires on a spec that uses the field, and it is
 * silent on one that does not. A deprecation notice that also fires on clean
 * specs is noise the day it ships.
 */
import { describe, it, expect } from "vitest";

import {
  KEYFILES_DOCS_URL,
  instructionFileOfSpec,
  keyFilesDeprecationMessage,
  measureKeyFiles,
  renderKeyFiles,
} from "./keyfiles.js";
import { findKeyFilesInSpecSource } from "./keyfiles-source.js";

describe("measureKeyFiles", () => {
  it("counts the characters the compiled section actually costs", () => {
    const map = { "a.ts": "First.", "b.ts": "Second." };
    expect(measureKeyFiles(map)).toEqual({
      entries: 2,
      chars: renderKeyFiles(map).length,
      measured: true,
    });
    // Guards: the number reported is the size of what loads, not of the descriptions alone.
    expect(renderKeyFiles(map)).toBe(
      "## Key Files\n\n- `a.ts` — First.\n- `b.ts` — Second.",
    );
  });

  it("formats the message in two sentences: the cost, then the four places an entry can go and the link", () => {
    const msg = keyFilesDeprecationMessage(
      { entries: 230, chars: 47728, measured: true },
      "CLAUDE.md",
    );
    expect(msg).toContain("230 entries");
    expect(msg).toContain("47,728 characters");
    expect(msg).toContain(KEYFILES_DOCS_URL);
    // Two sentences: the URL holds dots, so count sentence ends before it.
    expect(msg.split(KEYFILES_DOCS_URL)[0].match(/\. /g)).toHaveLength(1);
    // Not one instruction but the four choices, in the order to try them: a
    // reader who sees only "remove it" deletes facts that had no other home.
    const options = [
      /delete it if the file or the docs already say it/,
      /move a fact about one file into that file's header comment/,
      /move a rule for one folder into <folder>\/CLAUDE\.md/,
      /keep a one-line file\(\) pointer only if nothing else leads there/,
    ];
    options.forEach((o) => expect(msg).toMatch(o));
    const at = options.map((o) => msg.search(o));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("names the nested file after the instruction file the spec compiles", () => {
    expect(
      keyFilesDeprecationMessage(
        { entries: 1, chars: 10, measured: true },
        "AGENTS.md",
      ),
    ).toContain("<folder>/AGENTS.md");
    expect(instructionFileOfSpec("pkg/AGENTS.md.spec.ts")).toBe("AGENTS.md");
    expect(instructionFileOfSpec("CLAUDE.md.spec.ts")).toBe("CLAUDE.md");
  });

  it("says 1 entry, not 1 entries", () => {
    expect(
      keyFilesDeprecationMessage(
        { entries: 1, chars: 10, measured: true },
        "CLAUDE.md",
      ),
    ).toContain("1 entry,");
  });

  it("does not invent a size for a map it could not read", () => {
    const msg = keyFilesDeprecationMessage(
      { entries: 0, chars: 0, measured: false },
      "CLAUDE.md",
    );
    expect(msg).not.toMatch(/\d+ characters/);
    expect(msg).toContain("not a literal map");
  });
});

describe("findKeyFilesInSpecSource (audit reads the spec, never runs it)", () => {
  it("measures a literal keyFiles map exactly as compile would render it", () => {
    const src = `import { instructionFile } from "vigiles/spec";
export default instructionFile({
  keyFiles: {
    "src/a.ts": "First.",
    'src/b.ts': \`Second.\`,
    plain: "Third.",
  },
  rules: {},
});`;
    const found = findKeyFilesInSpecSource(src);
    expect(found).toEqual({
      entries: 3,
      chars: renderKeyFiles({
        "src/a.ts": "First.",
        "src/b.ts": "Second.",
        plain: "Third.",
      }).length,
      measured: true,
    });
  });

  it("finds a quoted property name", () => {
    const found = findKeyFilesInSpecSource(
      `export default instructionFile({ "keyFiles": { "x": "y" }, rules: {} });`,
    );
    expect(found?.entries).toBe(1);
  });

  it("reports a non-literal map as used but not measured, instead of guessing", () => {
    const found = findKeyFilesInSpecSource(
      `const files = {}; export default instructionFile({ keyFiles: files, rules: {} });`,
    );
    expect(found).toEqual({ entries: 0, chars: 0, measured: false });
  });

  it("counts a computed description as an entry without inventing its size", () => {
    const found = findKeyFilesInSpecSource(
      "const d = 'x'; export default instructionFile({ keyFiles: { [`a`]: d, ...{} }, rules: {} });",
    );
    expect(found).toEqual({ entries: 1, chars: 0, measured: false });
  });

  it("is silent when keyFiles appears only in a comment or a string", () => {
    const src = `export default instructionFile({
  // keyFiles: { "a": "b" },
  sections: { note: "keyFiles: is deprecated" },
  rules: {},
});`;
    expect(findKeyFilesInSpecSource(src)).toBeNull();
  });

  it("finds the shorthand form", () => {
    expect(
      findKeyFilesInSpecSource(
        "const keyFiles = {}; export default instructionFile({ keyFiles, rules: {} });",
      ),
    ).toEqual({ entries: 0, chars: 0, measured: false });
  });
});
