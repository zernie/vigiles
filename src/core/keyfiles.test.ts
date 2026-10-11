/**
 * `keyFiles` deprecation — the compile warning, the measurement it carries, and
 * the static reader `audit` uses to find the field in a spec it must not run.
 *
 * Both halves of every check: it fires on a spec that uses the field, and it is
 * silent on one that does not. A deprecation notice that also fires on clean
 * specs is noise the day it ships.
 */
import { describe, it, expect } from "vitest";

import { compileClaude } from "./compile.js";
import {
  KEYFILES_DOCS_URL,
  keyFilesDeprecationMessage,
  measureKeyFiles,
  renderKeyFiles,
} from "./keyfiles.js";
import { findKeyFilesInSpecSource } from "./keyfiles-source.js";

const spec = (
  extra: Partial<Parameters<typeof compileClaude>[0]>,
): Parameters<typeof compileClaude>[0] =>
  ({
    _specType: "claude",
    rules: {},
    ...extra,
  }) as Parameters<typeof compileClaude>[0];

const compile = async (s: Parameters<typeof compileClaude>[0]) =>
  await compileClaude(s, { specFile: "CLAUDE.md.spec.ts", catalogOnly: true });

describe("compile: keyFiles is deprecated", () => {
  it("warns — never errors — on a spec that uses keyFiles, naming the migration", async () => {
    const { warnings, errors, markdown } = await compile(
      spec({
        keyFiles: { "package.json": "The manifest.", "README.md": "Intro." },
      }),
    );
    const dep = warnings.filter((w) => w.type === "deprecated-field");
    expect(dep).toHaveLength(1);
    expect(dep[0].path).toBe("CLAUDE.md.spec.ts");
    expect(dep[0].message).toContain("2 entries");
    expect(dep[0].message).toContain("file()");
    expect(dep[0].message).toContain(KEYFILES_DOCS_URL);
    // Still compiles exactly as before: deprecated, not removed.
    expect(errors.filter((e) => e.type === "deprecated-field")).toHaveLength(0);
    expect(markdown).toContain("- `package.json` — The manifest.");
  });

  it("warns on an EMPTY keyFiles too — the migration is deleting the field", async () => {
    const { warnings } = await compile(spec({ keyFiles: {} }));
    expect(warnings.map((w) => w.type)).toEqual(["deprecated-field"]);
  });

  it("is silent on a spec without keyFiles", async () => {
    const { warnings } = await compile(
      spec({ commands: { "npm test": "Run tests" } }),
    );
    expect(warnings.filter((w) => w.type === "deprecated-field")).toEqual([]);
  });
});

describe("measureKeyFiles", () => {
  it("counts the characters the compiled section actually costs", () => {
    const map = { "a.ts": "First.", "b.ts": "Second." };
    const m = measureKeyFiles(map);
    expect(m.entries).toBe(2);
    expect(m.chars).toBe(renderKeyFiles(map).length);
    // Guards: the number reported is the size of what loads, not of the descriptions alone.
    expect(renderKeyFiles(map)).toBe(
      "## Key Files\n\n- `a.ts` — First.\n- `b.ts` — Second.",
    );
  });

  it("formats the message in one or two sentences with thousands separators", () => {
    const msg = keyFilesDeprecationMessage({ entries: 230, chars: 47728 });
    expect(msg).toContain("230 entries");
    expect(msg).toContain("47,728 characters");
    expect(msg.split(/\.\s/).length).toBeLessThanOrEqual(3);
  });

  it("says 1 entry, not 1 entries", () => {
    expect(keyFilesDeprecationMessage({ entries: 1, chars: 10 })).toContain(
      "1 entry ",
    );
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
