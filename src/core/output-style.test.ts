import { describe, expect, it } from "vitest";

import {
  findOutputStyles,
  outputStyleHomes,
  planStyleRun,
  styleReached,
} from "./output-style.js";
import type { OutputStyle, OutputStyleRules } from "./output-style.js";

/**
 * A made-up harness, so these tests cannot depend on any real one: it keeps
 * styles as `.txt` files in `voices/`, and the first line is the name.
 */
const acme: OutputStyleRules = {
  dir: "voices",
  isStyleFile: (pathInDir) => pathInDir.endsWith(".txt"),
  read: (path, text): OutputStyle => {
    const [first = "", ...rest] = text.split("\n");
    return { path, name: first === "" ? null : first, body: rest.join("\n") };
  },
  select: (name) => ({ voice: name }),
  reached: (style, request) => request.system.includes(style.body),
};

const withStyles = { outputStyles: acme, userSurfaceRoot: ".acme" };
const withoutStyles = { userSurfaceRoot: ".acme" };

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe("outputStyleHomes", () => {
  it("is the folder at the plugin root and under the user surface root", () => {
    expect(outputStyleHomes(withStyles)).toEqual(["voices", ".acme/voices"]);
  });

  it("is nothing for a harness that has no output styles", () => {
    expect(outputStyleHomes(withoutStyles)).toEqual([]);
  });
});

describe("findOutputStyles", () => {
  it("says the harness has none, rather than finding zero", () => {
    expect(
      findOutputStyles(withoutStyles, files({ "voices/terse.txt": "Terse" })),
    ).toEqual({ kind: "not-supported" });
  });

  it("reads every style in both homes, nested folders included", () => {
    const found = findOutputStyles(
      withStyles,
      files({
        ".acme/voices/terse.txt": "Terse\nShort answers.",
        ".acme/voices/team/footer.txt": "Footer\nEnd with a status block.",
        "voices/plugin.txt": "Plugin\nFrom a plugin.",
      }),
    );
    expect(found).toEqual({
      kind: "found",
      styles: [
        {
          path: ".acme/voices/team/footer.txt",
          name: "Footer",
          body: "End with a status block.",
        },
        {
          path: ".acme/voices/terse.txt",
          name: "Terse",
          body: "Short answers.",
        },
        { path: "voices/plugin.txt", name: "Plugin", body: "From a plugin." },
      ],
    });
  });

  it("skips a file the harness would not load, even inside the folder", () => {
    const found = findOutputStyles(
      withStyles,
      files({
        ".acme/voices/notes.md": "Notes\nnot a style here",
        ".acme/voicesextra/terse.txt": "Terse\nnot in the folder",
      }),
    );
    expect(found).toEqual({ kind: "found", styles: [] });
  });
});

describe("planStyleRun", () => {
  const source = { path: "styles/terse.txt", text: "Terse\nShort answers." };
  const empty = { files: {}, settings: undefined };

  it("writes the style into the user home and selects it by its read name", () => {
    expect(planStyleRun(withStyles, source, empty)).toEqual({
      kind: "planned",
      style: {
        path: ".acme/voices/terse.txt",
        name: "Terse",
        body: "Short answers.",
      },
      files: { ".acme/voices/terse.txt": "Terse\nShort answers." },
      settings: { voice: "Terse" },
    });
  });

  it("keeps the fixture's other files and settings", () => {
    const plan = planStyleRun(withStyles, source, {
      files: { "a.md": "a" },
      settings: { model: "m" },
    });
    expect(plan.kind === "planned" && plan.settings).toEqual({
      model: "m",
      voice: "Terse",
    });
    expect(plan.kind === "planned" && plan.files["a.md"]).toBe("a");
  });
});

describe("planStyleRun takes only the file name from the source path", () => {
  // A Windows path (`path.resolve` there) uses backslashes; taking everything
  // after the last "/" kept the whole path and wrote ".acme/voices/C:\\...".
  it.each([
    "C:\\repo\\styles\\terse.txt",
    "styles\\terse.txt",
    "/repo/styles/terse.txt",
  ])("%s", (path) => {
    const plan = planStyleRun(
      withStyles,
      { path, text: "Terse\nShort answers." },
      { files: {}, settings: undefined },
    );
    expect(plan.kind === "planned" && Object.keys(plan.files)).toEqual([
      ".acme/voices/terse.txt",
    ]);
  });
});

describe("planStyleRun refuses rather than guess", () => {
  const source = { path: "styles/terse.txt", text: "Terse\nShort answers." };
  const empty = { files: {}, settings: undefined };
  const CASES = [
    {
      why: "a harness without styles",
      layout: withoutStyles,
      src: source,
      fixture: empty,
      reason: /no output styles/,
    },
    {
      why: "a file the harness would not load",
      layout: withStyles,
      src: { ...source, path: "x.md" },
      fixture: empty,
      reason: /would not load "x.md"/,
    },
    {
      why: "a style with no readable name",
      layout: withStyles,
      src: { ...source, text: "\nbody" },
      fixture: empty,
      reason: /cannot tell which name/,
    },
    {
      why: "a fixture file in the way",
      layout: withStyles,
      src: source,
      fixture: {
        files: { ".acme/voices/terse.txt": "x" },
        settings: undefined,
      },
      reason: /already has a file/,
    },
    {
      why: "settings that already pick a style",
      layout: withStyles,
      src: source,
      fixture: { files: {}, settings: { voice: "Other" } },
      reason: /already set "voice"/,
    },
    {
      why: "settings that are not an object",
      layout: withStyles,
      src: source,
      fixture: { files: {}, settings: [1] },
      reason: /not an object/,
    },
  ] as const;
  it.each(CASES)("on $why", (c) => {
    const plan = planStyleRun(c.layout, c.src, c.fixture);
    expect(plan.kind === "refused" && plan.reason).toMatch(c.reason);
  });
});

describe("styleReached", () => {
  const style = { path: "v/t.txt", name: "Terse", body: "Short answers." };
  const req = (system: string) => ({ system, messages: [] });

  it("is true when any request carries the style", () => {
    expect(styleReached(acme, style, [req("x"), req("Short answers.")])).toBe(
      true,
    );
  });

  it("is false when none does", () => {
    expect(styleReached(acme, style, [req("x"), req("y")])).toBe(false);
  });
});
