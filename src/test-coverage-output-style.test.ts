/**
 * Output styles as a fourth surface kind of the untested-surface detector.
 *
 * Run against a made-up harness ("acme": styles are `.txt` files in `voices/`)
 * so nothing here depends on a real harness's file names. Both engines are held
 * to the same answer: the disk detector and its browser twin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EMPTY_CHAIN } from "./core/instruction-chain.js";
import type { PluginLayout } from "./core/layout.js";
import type { OutputStyleRules } from "./core/output-style.js";
import { jsonSettingsCodec } from "./core/settings-codec.js";
import { cleanupTmpDir, makeTmpDir } from "./core/test-utils.js";
import {
  evalTierQuestion,
  findUntestedSurfaces,
  suggestedTestPath,
} from "./test-coverage.js";
import { findUntestedSurfacesInFiles } from "./test-coverage-files.js";

const voices: OutputStyleRules = {
  dir: "voices",
  isStyleFile: (pathInDir) => pathInDir.endsWith(".txt"),
  read: (path, text) => {
    const [first = "", ...rest] = text.split("\n");
    return { path, name: first === "" ? null : first, body: rest.join("\n") };
  },
  select: (name) => ({ voice: name }),
  reached: (style, request) => request.system.includes(style.body),
};

const withoutStyles: PluginLayout = {
  name: "acme",
  manifestPath: ".acme-plugin/plugin.json",
  settingsPath: ".acme/settings.json",
  settings: jsonSettingsCodec,
  instructionFile: "ACME.md",
  surfaces: { skill: "skills" },
  userSurfaceRoot: ".acme",
  pluginRootToken: "${ACME_PLUGIN_ROOT}",
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcpServers",
  instructionChain: () => EMPTY_CHAIN,
};
const acme: PluginLayout = { ...withoutStyles, outputStyles: voices };

let dir: string;
let files: Readonly<Record<string, string>> = {};

function write(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  files = { ...files, [rel]: body };
}

const styles = (layout: PluginLayout) =>
  findUntestedSurfaces({ basePath: dir, layout }).untested.filter(
    (s) => s.kind === "output-style",
  );

beforeEach(() => {
  dir = makeTmpDir("tc-output-style");
  files = {};
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("an output style is a surface the audit holds to a test", () => {
  it("reports a style with no test, in both homes and nested folders", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    write(".acme/voices/team/footer.txt", "Footer\nEnd with a block.");
    write("voices/plugin.txt", "Plugin\nFrom a plugin.");
    expect(styles(acme).map((s) => [s.path, s.name])).toEqual([
      [".acme/voices/team/footer.txt", "footer"],
      [".acme/voices/terse.txt", "terse"],
      ["voices/plugin.txt", "plugin"],
    ]);
  });

  it("asks only the harness which files are styles", () => {
    write(".acme/voices/notes.md", "not a style for this harness");
    write(".acme/voicesextra/terse.txt", "Terse\noutside the folder");
    expect(styles(acme)).toEqual([]);
  });

  it("is covered by a test named after the file, beside it", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    write(".acme/voices/terse.harness.mjs", "// drives the style\n");
    expect(styles(acme)).toEqual([]);
  });

  it("suggests a harness test beside the style, named after the file", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    const [style] = styles(acme);
    expect(style && suggestedTestPath(style)).toBe(
      ".acme/voices/terse.harness.mjs",
    );
  });

  it("exempts a style that says vigiles:ignore-test", () => {
    write(".acme/voices/terse.txt", "Terse\nvigiles:ignore-test");
    const report = findUntestedSurfaces({ basePath: dir, layout: acme });
    expect(report.untested).toEqual([]);
    expect(report.exempt).toBe(1);
  });

  it("is not scanned when the rule is switched off", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    const report = findUntestedSurfaces({
      basePath: dir,
      layout: acme,
      outputStyles: false,
    });
    expect(report.total).toBe(0);
  });

  it("finds nothing for a harness that has no output styles", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    expect(styles(withoutStyles)).toEqual([]);
  });
});

describe("the browser twin agrees with the disk detector", () => {
  it("reports the same untested styles", () => {
    write(".acme/voices/terse.txt", "Terse\nShort answers.");
    write(".acme/voices/team/footer.txt", "Footer\nEnd with a block.");
    write(".acme/voices/team/footer.harness.mjs", "// covered\n");
    write(".acme/voices/notes.md", "not a style");
    const twin = findUntestedSurfacesInFiles(files, acme, "repo")
      .untested.filter((s) => s.kind === "output-style")
      .map((s) => s.path);
    expect(twin).toEqual(styles(acme).map((s) => s.path));
    expect(twin).toEqual([".acme/voices/terse.txt"]);
  });
});

describe("the real-model question for a style", () => {
  it("is whether a model follows it, not whether it fires", () => {
    expect(evalTierQuestion("output-style")).toMatch(/follows/);
    expect(evalTierQuestion("output-style")).toMatch(
      /NOT `measureTriggerRate`/,
    );
  });
});
