/**
 * Test discovery must behave the same on every OS (vitest, unit tier).
 *
 * `glob` defaults `nocase` to true on macOS and Windows, so `a.hook.HARNESS.mjs`
 * RAN as a test there while `classifySource` (case-sensitive, like the file
 * systems these names mostly live on) called it unclaimed. Linux hides the
 * difference, so the guarantee is asserted where it is made: every glob vigiles
 * builds for test discovery states `nocase: false` itself. The wrapper records the
 * options the real `globSync` is called with; nothing is stubbed.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seen: { pattern: unknown; options: unknown }[] = [];

vi.mock("glob", async (importOriginal) => {
  const real = await importOriginal<typeof import("glob")>();
  return {
    ...real,
    globSync: (...args: Parameters<typeof real.globSync>) => {
      seen.push({ pattern: args[0], options: args[1] });
      return real.globSync(...args);
    },
  };
});

import {
  discoverScripts,
  scriptGlob,
} from "./adapters/claude-code/run-scripts.js";
import { findUntestedSurfaces } from "./test-coverage.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";

const nocaseOf = (options: unknown): unknown =>
  typeof options === "object" && options !== null && "nocase" in options
    ? options.nocase
    : "(not stated)";

describe("test-discovery globs state nocase: false", () => {
  it("`vigiles test` / `vigiles eval` discovery (discoverScripts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-nocase-"));
    try {
      writeFileSync(join(dir, "a.hook.HARNESS.mjs"), "");
      writeFileSync(join(dir, "a.harness.mjs"), "");
      seen.length = 0;
      const found = discoverScripts([], scriptGlob("harness"), dir, []);
      expect(found).toEqual(["a.harness.mjs"]);
      const mine = seen.filter((c) => c.pattern === scriptGlob("harness"));
      expect(mine.length).toBeGreaterThan(0);
      for (const c of mine) expect(nocaseOf(c.options)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coverage's default test discovery (findUntestedSurfaces)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-nocase-"));
    try {
      mkdirSync(join(dir, ".claude/skills/foo"), { recursive: true });
      writeFileSync(
        join(dir, ".claude/skills/foo/SKILL.md"),
        "---\nname: foo\ndescription: does foo\n---\nbody\n",
      );
      seen.length = 0;
      findUntestedSurfaces({ layout: claudeCodeLayout, basePath: dir });
      const mine = seen.filter((c) =>
        JSON.stringify(c.pattern).includes(".harness."),
      );
      expect(mine.length).toBeGreaterThan(0);
      for (const c of mine) expect(nocaseOf(c.options)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
