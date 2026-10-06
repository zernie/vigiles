import { describe, expect, it } from "vitest";

import { findOutputStyles, outputStyleHomes } from "./output-style.js";
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
