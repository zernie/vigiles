/**
 * Integrity-header tests — the hand-edit check plus the `eject` transform that
 * hands a compiled file back as plain, hand-owned markdown.
 */
import { beforeAll, describe, it, expect } from "vitest";
import {
  checkIntegrity,
  parseIntegrityHeader,
  ejectMarkdown,
  findIntegrityHeader,
  placeIntegrityHeader,
  REQUIRE_INSTRUCTIONS_SPEC_DISABLE,
} from "./integrity.js";
import { sha256short } from "./hash.js";
import { addHash, compileSkill } from "./compile.js";
import { experimental_skill } from "./spec.js";
import { claudeCodeDialect as dialect } from "../adapters/claude-code/dialect.js";
const { input } = experimental_skill;

/** Build a compiled-file string with a VALID header for `body`. */
function compiled(body: string, spec = "CLAUDE.md.spec.ts"): string {
  return `<!-- vigiles:sha256:${sha256short(body)} compiled from ${spec} -->\n\n${body}`;
}

describe("checkIntegrity", () => {
  it("accepts a file whose hash matches its body", () => {
    expect(checkIntegrity(compiled("# Title\n\nBody.\n")).intact).toBe(true);
  });

  it("flags a hand-edited compiled file (hash mismatch)", () => {
    const tampered = compiled("# Title\n").replace("Title", "Tampered");
    expect(checkIntegrity(tampered).intact).toBe(false);
  });

  it("treats a header-less file as hand-written (intact)", () => {
    expect(checkIntegrity("# Plain markdown\n").intact).toBe(true);
  });
});

describe("parseIntegrityHeader", () => {
  it("extracts the spec path and the body below the header", () => {
    const parsed = parseIntegrityHeader(
      compiled("# T\n\nB.\n", "AGENTS.md.spec.ts"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.specFile).toBe("AGENTS.md.spec.ts");
    expect(parsed?.body).toBe("# T\n\nB.\n");
  });

  it("returns null for plain markdown (no header)", () => {
    expect(parseIntegrityHeader("# Plain\n")).toBeNull();
  });
});

describe("ejectMarkdown", () => {
  it("strips the header and prepends the require-instructions-spec disable marker", () => {
    const out = ejectMarkdown(compiled("# Title\n\nBody.\n"));
    expect(out).not.toBeNull();
    expect(out?.specFile).toBe("CLAUDE.md.spec.ts");
    expect(out?.markdown).toBe(
      `${REQUIRE_INSTRUCTIONS_SPEC_DISABLE}\n\n# Title\n\nBody.\n`,
    );
    // No integrity header remains.
    expect(out?.markdown.includes("vigiles:sha256")).toBe(false);
  });

  it("returns null when there is nothing to eject (no header)", () => {
    expect(ejectMarkdown("# Already plain\n")).toBeNull();
  });

  it("does NOT prepend the marker before YAML frontmatter (skill/agent)", () => {
    // A compiled SKILL.md body leads with `---` frontmatter that must stay first
    // — prepending an HTML comment would break the skill (lost name/description).
    const body =
      "---\nname: my-skill\ndescription: Does a thing.\n---\n\nBody.\n";
    const out = ejectMarkdown(compiled(body, "SKILL.md.spec.ts"));
    expect(out?.markdown).toBe(body); // frontmatter stays in first position
    expect(out?.markdown.startsWith("---")).toBe(true);
    expect(out?.markdown.includes(REQUIRE_INSTRUCTIONS_SPEC_DISABLE)).toBe(
      false,
    );
    expect(out?.specFile).toBe("SKILL.md.spec.ts");
  });

  it("is idempotent — does not double-mark an already-disabled body", () => {
    const body = `${REQUIRE_INSTRUCTIONS_SPEC_DISABLE}\n\n# Title\n`;
    const out = ejectMarkdown(compiled(body));
    expect(out?.markdown).toBe(body);
    // Exactly one marker.
    expect(out?.markdown.split(REQUIRE_INSTRUCTIONS_SPEC_DISABLE).length).toBe(
      2,
    );
  });
});

/**
 * Where the integrity header sits relative to YAML frontmatter.
 *
 * 🔴 THE DEFECT THESE PIN. `addHash` prepended the header to every compiled file, including
 * SKILL.md — whose frontmatter must be the first thing in the file or the harness cannot read the
 * skill's name, description or tools. `ejectMarkdown`'s docstring in this very module had said so
 * since it was written; the compiler two modules over did the opposite.
 *
 * Measured 2026-08-17 on five real skills: after compiling, a `^---` reader found NO frontmatter.
 * That one line was the ENTIRE diff against the hand-written original — body byte-identical,
 * section order untouched — so it was the whole reason a compiled skill could not be adopted.
 */
describe("integrity header placement", () => {
  const FM = "---\nname: demo\nallowed-tools: [Read]\n---\n";
  const BODY = "# Demo\n\nSome instructions.\n";

  it("goes AFTER frontmatter, leaving `---` as the first line", () => {
    const out = placeIntegrityHeader(FM + BODY, "abc123", "SKILL.md.spec.ts");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain(
      "<!-- vigiles:sha256:abc123 compiled from SKILL.md.spec.ts -->",
    );
    // The property that actually matters: a reader anchored at `^---` still finds the block.
    expect(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(out)?.[1]).toContain(
      "name: demo",
    );
  });

  it("still goes FIRST when the file has no frontmatter", () => {
    const out = placeIntegrityHeader(BODY, "abc123", "CLAUDE.md.spec.ts");
    expect(out.startsWith("<!-- vigiles:sha256:abc123")).toBe(true);
  });

  it("round-trips: a stamped frontmatter file verifies as intact", () => {
    const content = FM + BODY;
    const stamped = placeIntegrityHeader(
      content,
      sha256short(content),
      "s.spec.ts",
    );
    expect(checkIntegrity(stamped).intact).toBe(true);
    expect(parseIntegrityHeader(stamped)?.specFile).toBe("s.spec.ts");
  });

  it("a hand-edit under the header is still caught", () => {
    const content = FM + BODY;
    const stamped = placeIntegrityHeader(
      content,
      sha256short(content),
      "s.spec.ts",
    );
    expect(
      checkIntegrity(stamped.replace("Some instructions.", "Tampered.")).intact,
    ).toBe(false);
  });

  // Backward compatibility is not optional: every SKILL.md compiled before this fix carries the
  // header FIRST and its frontmatter second. Those files must keep verifying, or upgrading vigiles
  // would report every previously-compiled skill as hand-edited.
  it("reads the OLD layout — header first, frontmatter second", () => {
    const content = FM + BODY;
    const old = `<!-- vigiles:sha256:${sha256short(content)} compiled from s.spec.ts -->\n\n${content}`;
    const found = findIntegrityHeader(old);
    expect(found?.specFile).toBe("s.spec.ts");
    expect(found?.withoutHeader).toBe(content);
    expect(checkIntegrity(old).intact).toBe(true);
  });

  it("finds nothing in plain markdown", () => {
    expect(findIntegrityHeader(FM + BODY)).toBeNull();
    expect(findIntegrityHeader(BODY)).toBeNull();
  });
});

/**
 * The output boundary refuses a stringified object.
 *
 * 🔴 Measured 2026-08-17: `input({ name, description })` — the object form a reader reasonably
 * guesses — compiled with no error and wrote `argument-hint: <[object Object]>` into a shipped
 * SKILL.md. Types cannot stop it for a user's spec: `vigiles compile` runs `.spec.ts` through
 * tsx, which transpiles and erases types without checking them.
 */
describe("addHash refuses stringified objects", () => {
  it("throws when the compiled body carries [object Object]", () => {
    expect(() =>
      addHash(
        "# Skill\n\n- `$1` **[object Object]** — undefined\n",
        "s.spec.ts",
      ),
    ).toThrow(/\[object Object\]/);
  });

  it("stays quiet on ordinary content", () => {
    expect(() =>
      addHash("# Skill\n\nOrdinary prose.\n", "s.spec.ts"),
    ).not.toThrow();
  });
});

/** `input()` is the boundary where that object actually enters. */
describe("input() refuses a non-string call", () => {
  it("throws on the object form, and names the real signature", () => {
    // @ts-expect-error — the point is that TS would catch this and tsx does not.
    expect(() => input({ name: "p", description: "d" })).toThrow(
      /input\(name, hint/,
    );
  });

  it("throws on an empty hint rather than rendering a blank argument", () => {
    expect(() => input("p", "  ")).toThrow(/two strings/);
  });

  it("accepts the documented call", () => {
    expect(input("pattern", "regex to search for")).toEqual({
      name: "pattern",
      hint: "regex to search for",
      required: undefined,
    });
  });
});

/**
 * A COMPILED artifact must be prettier-clean, or the tool cannot pass its own
 * `npm run check` after a recompile — measured 2026-09-03 on all seven
 * `examples/` artifacts, which is why the seven sat un-recompiled with an
 * out-of-date marker position instead of being regenerated.
 *
 * Two separate defects produced it, and both are asserted here because each one
 * alone is enough to fail `prettier --check`:
 *
 *   1. the frontmatter renderers padded the INSIDE of the `---` fence
 *   2. the frontmatter/body join added a blank line that `placeIntegrityHeader`
 *      then added again
 *
 * Fixed at the JOIN, not in the stamper: the hash is computed over the content
 * `seal` receives, so trimming inside `placeIntegrityHeader` hashes one string
 * and writes another — that attempt broke integrity on all three
 * frontmatter-bearing artifacts before it was reverted.
 */
describe("a compiled artifact is prettier-clean by construction", () => {
  // Compiling is async (the symbol check awaits WASM grammars), and a describe body must stay
  // synchronous, so the artifact is produced in beforeAll.
  let compiled!: Awaited<ReturnType<typeof compileSkill>>;
  beforeAll(async () => {
    compiled = await compileSkill(
      experimental_skill({
        name: "fixture",
        description: "One line, no surprises",
        body: "Body line.",
      }),
      { basePath: process.cwd(), specFile: "SKILL.md.spec.ts", dialect },
    );
  });

  it("compiles", () => {
    expect(compiled.errors).toEqual([]);
    expect(compiled.artifact).not.toBeNull();
  });

  it("has no blank line INSIDE the frontmatter fence", () => {
    const md = compiled.artifact ?? "";
    const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
    expect(fence, "no frontmatter found").not.toBeNull();
    expect(fence?.[1]).not.toMatch(/^\s*$/m);
  });

  it("never emits two consecutive blank lines", () => {
    expect(compiled.artifact ?? "").not.toMatch(/\n[ \t]*\n[ \t]*\n/);
  });
});
