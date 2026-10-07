/**
 * A repository that declares more than one harness: coverage finds each surface
 * in whichever declared harness keeps it, whatever the declaration order.
 * Before, coverage read only the FIRST declared layout: with a harness that has
 * no output styles declared first, a style kept by the second vanished
 * (`Output styles: n/a`, an empty-machine grade), and its skills and agents
 * were graded but silently left out of `untested`.
 *
 * Two made-up harnesses, so nothing here depends on a real one's file names:
 * "acme" keeps skills, agents and `.txt` styles under `.acme/`; "zeta" keeps
 * skills under `.zeta/` and has no output styles.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultAdapter } from "./adapter-registry.js";
import { EMPTY_CHAIN } from "./core/instruction-chain.js";
import type { PluginLayout } from "./core/layout.js";
import type { OutputStyleRules } from "./core/output-style.js";
import { jsonSettingsCodec } from "./core/settings-codec.js";
import { cleanupTmpDir, makeTmpDir } from "./core/test-utils.js";
import { scanPlugin } from "./scan.js";
import { findUntestedSurfaces } from "./test-coverage.js";

const voices: OutputStyleRules = {
  dir: "voices",
  isStyleFile: (pathInDir) => pathInDir.endsWith(".txt"),
  read: (path, text) => {
    const [first = "", ...rest] = text.split("\n");
    return { path, name: first === "" ? null : first, body: rest.join("\n") };
  },
  select: (name) => ({ voice: name }),
  selectNone: { voice: "none" },
  reached: (style, request) => request.system.includes(style.body),
};

const layoutNamed = (name: string): PluginLayout => ({
  name,
  manifestPath: `.${name}-plugin/plugin.json`,
  settingsPath: `.${name}/settings.json`,
  settings: jsonSettingsCodec,
  instructionFile: `${name.toUpperCase()}.md`,
  surfaces: { skill: "skills", agent: "agents" },
  userSurfaceRoot: `.${name}`,
  pluginRootToken: `\${${name.toUpperCase()}_PLUGIN_ROOT}`,
  mcpConfigFile: ".mcp.json",
  mcpManifestKey: "mcpServers",
  instructionChain: () => EMPTY_CHAIN,
});
const acme: PluginLayout = { ...layoutNamed("acme"), outputStyles: voices };
const zeta: PluginLayout = layoutNamed("zeta");

const STYLE = ".acme/voices/status.txt";
const SKILL = ".acme/skills/alpha/SKILL.md";
const AGENT = ".acme/agents/beta.md";

let dir: string;
function write(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

beforeEach(() => {
  dir = makeTmpDir("coverage-harnesses");
  write(STYLE, "Status\nEnd with a status block.\n");
  write(
    SKILL,
    "---\nname: alpha\ndescription: does alpha things in many cases\n---\n# alpha\n",
  );
  write(
    AGENT,
    "---\nname: beta\ndescription: reviews beta things\n---\nReview.\n",
  );
});
afterEach(() => {
  cleanupTmpDir(dir);
});

const untestedPaths = (layouts: readonly PluginLayout[]): string[] =>
  findUntestedSurfaces({
    basePath: dir,
    layout: layouts[0] ?? zeta,
    harnessLayouts: layouts,
  })
    .untested.map((s) => s.path)
    .sort();

it("finds every declared harness's surfaces, in either order", () => {
  const all = [AGENT, SKILL, STYLE].sort();
  expect(untestedPaths([acme, zeta])).toEqual(all);
  expect(untestedPaths([zeta, acme])).toEqual(all);
});

it("lists a file once when two declared harnesses read it", () => {
  expect(untestedPaths([acme, acme])).toEqual([AGENT, SKILL, STYLE].sort());
});

it("the audit counts the style when the harness without styles is declared first", () => {
  const { dialect } = defaultAdapter;
  const r = scanPlugin(dir, zeta, dialect, {
    harnesses: [
      { layout: zeta, dialect, roots: [] },
      { layout: acme, dialect, roots: [] },
    ],
  });
  expect(r.outputStyles).toBe(1);
  expect(r.untested).toBe(3);
});

it("says n/a only when no declared harness has output styles", () => {
  const { dialect } = defaultAdapter;
  const r = scanPlugin(dir, zeta, dialect, {
    harnesses: [{ layout: zeta, dialect, roots: [] }],
  });
  expect(r.outputStyles).toBe("not-supported");
});
