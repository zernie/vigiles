/**
 * Dogfood — vigiles's OWN plugin conforms to the Agent Plugins standard.
 *
 * vigiles ships as a plugin, so it holds itself to the vendor-neutral packaging
 * standard it tells other people to verify: a root `plugin.json` per Agent
 * Plugins 1.0.0, with `skills/<name>/SKILL.md` where the spec says to look.
 *
 * Two manifests now describe the same plugin — the neutral root `plugin.json`
 * (Agent Plugins) and `.claude-plugin/plugin.json` (Claude Code's own format,
 * which carries the `hooks` block the 1.0.0 spec has no home for). Two hand-kept
 * files DRIFT: `.claude-plugin/marketplace.json` was already a major version
 * behind `plugin.json` when this test was written. So the drift is a CI failure,
 * not a discipline problem — the same reflex as the integrity hash.
 *
 * Model-free, offline, no network: the schema's RULES are asserted here rather
 * than fetched, so the gate runs on every commit. Bumping the pinned spec
 * version is therefore a deliberate edit to this file.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// __dirname is dist/ at runtime; the manifests live at the repo root.
const ROOT = resolve(import.meta.dirname, "..");

/** The canonical `$schema` identifier for the spec version we target. */
const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** Agent Plugins 1.0.0 `name`: lowercase, no leading/trailing or doubled `-`/`.`. */
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The root manifest's schema is CLOSED (`additionalProperties: false`). */
const ALLOWED_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const ALLOWED_AUTHOR_KEYS = new Set(["name", "email", "url"]);

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf-8")) as Record<
    string,
    unknown
  >;
}

test("agent-plugins: the root manifest satisfies the 1.0.0 schema", () => {
  const m = readJson("plugin.json");

  assert.equal(m.$schema, PLUGIN_SCHEMA, "$schema must pin the spec version");
  assert.ok(
    typeof m.name === "string" && NAME_PATTERN.test(m.name),
    "valid name",
  );

  for (const key of Object.keys(m)) {
    assert.ok(
      ALLOWED_KEYS.has(key),
      `unknown top-level key "${key}" — the 1.0.0 manifest schema is closed`,
    );
  }

  // `author` is an object of optional name/email/url — also closed. npm's
  // `repository` object shape is NOT valid here; the spec wants a plain string.
  const author = m.author as Record<string, unknown> | undefined;
  if (author) {
    for (const key of Object.keys(author)) {
      assert.ok(ALLOWED_AUTHOR_KEYS.has(key), `unknown author key "${key}"`);
    }
  }
  for (const key of ["homepage", "repository", "license", "description"]) {
    if (m[key] !== undefined) {
      assert.equal(typeof m[key], "string", `${key} must be a string`);
    }
  }
});

test("agent-plugins: skills sit where the spec says to discover them", () => {
  // A conformant client reads the manifest, then scans the FIXED location
  // `skills/<name>/SKILL.md`. If our skills moved, we'd stop being loadable by
  // any non-Claude-Code client that implements the standard.
  const dirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert.ok(dirs.length > 0, "the plugin ships at least one skill");
  for (const name of dirs) {
    assert.ok(
      existsSync(join(ROOT, "skills", name, "SKILL.md")),
      `skills/${name}/SKILL.md must exist (Agent Skills component layout)`,
    );
  }
});

test("agent-plugins: the neutral manifest can't drift from the Claude Code one", () => {
  const neutral = readJson("plugin.json");
  const cc = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json") as {
    plugins: { name: string; version?: string }[];
  };

  for (const field of ["name", "version", "description", "license"] as const) {
    assert.equal(
      neutral[field],
      cc[field],
      `plugin.json and .claude-plugin/plugin.json disagree on "${field}"`,
    );
  }

  const entry = marketplace.plugins.find((p) => p.name === neutral.name);
  assert.ok(entry, "marketplace.json lists the plugin");
  assert.equal(
    entry.version,
    neutral.version,
    "marketplace.json version is stale — bump it with the manifests",
  );
});

test("agent-plugins: the root manifest ships in the npm package", () => {
  // `files` is an allowlist: an omitted plugin.json means `npm i vigiles` gets a
  // plugin that ISN'T conformant, even though the repo is.
  const pkg = readJson("package.json") as { files: string[] };
  assert.ok(
    pkg.files.includes("plugin.json"),
    "package.json files[] must include plugin.json",
  );
});
