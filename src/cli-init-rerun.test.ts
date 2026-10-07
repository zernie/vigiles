/**
 * Re-running `vigiles init` on a repo that ALREADY uses vigiles (#338) — through
 * the REAL built CLI, in a scratch repo, the way the reporter ran it.
 *
 * The defect, measured on 33.3.0: re-running `init` only to pick up the new
 * skill links also created a CI workflow, wrote nine rules at `error` plus a
 * `harnesses` block into `.vigilesrc.json`, scaffolded `vigiles.harness.mjs` and
 * `.vigiles/schema.json`, wrote specs for hand-written skills, and rewrote the
 * devDependency pin `^33.3.0` to `^33`. Every one of those had to be reverted by
 * hand.
 *
 * The contract now: on an adopted repo a bare `init` adds only what is missing
 * and is safe and local (the skill links, a missing devDependency), writes
 * nothing else, and prints what a full setup would add and the flag that does
 * it. A brand-new repo keeps the full setup.
 *
 * No network and no global install: HOME is a scratch dir and PATH holds only
 * `node`, so a Claude Code plugin step (if reached) reports "not installed".
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { SHIPPED_SKILLS } from "./setup-plan.js";
import { getAdapter } from "./adapter-registry.js";
import { skillsHome } from "./core/layout.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

const CC = "claude";

/** The Claude Code skills home, read off the layout. */
function ccSkillsHome(): string {
  const adapter = getAdapter(CC);
  const home = adapter === undefined ? null : skillsHome(adapter.layout);
  assert.ok(home !== null);
  return home;
}

interface Scratch {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
}

function withScratch(fn: (s: Scratch) => void): void {
  const s: Scratch = {
    root: mkdtempSync(join(tmpdir(), "vigiles-init-rerun-")),
    home: mkdtempSync(join(tmpdir(), "vigiles-init-rerun-home-")),
    bin: mkdtempSync(join(tmpdir(), "vigiles-init-rerun-bin-")),
  };
  symlinkSync(process.execPath, join(s.bin, "node"));
  try {
    fn(s);
  } finally {
    [s.root, s.home, s.bin].forEach((d) => {
      rmSync(d, { recursive: true, force: true });
    });
  }
}

/** Run the built `init` with `args`, headless (no TTY, CI set). */
function init(s: Scratch, args: readonly string[] = []): string {
  return execFileSync(
    process.execPath,
    [CLI, "init", `--harness=${CC}`, ...args],
    {
      cwd: s.root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
      env: { ...process.env, HOME: s.home, PATH: s.bin, CI: "1" },
    },
  );
}

const ADOPTED_CONFIG = `${JSON.stringify({ maxRules: 200 }, null, 2)}\n`;

/**
 * The reporter's repo, reduced: vigiles pinned and installed, its own
 * `.vigilesrc.json`, a hand-written CLAUDE.md and a hand-written skill, no CI
 * workflow of vigiles's.
 */
function adoptedRepo(
  root: string,
  devDependencies: Readonly<Record<string, string>> = { vigiles: "^33.3.0" },
): void {
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "consumer", devDependencies }, null, 2)}\n`,
  );
  const pkg = join(root, "node_modules", "vigiles");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vigiles" }));
  SHIPPED_SKILLS.forEach((name) => {
    mkdirSync(join(pkg, "skills", name), { recursive: true });
    writeFileSync(
      join(pkg, "skills", name, "SKILL.md"),
      `---\nname: ${name}\n---\n`,
    );
  });
  writeFileSync(join(root, ".vigilesrc.json"), ADOPTED_CONFIG);
  writeFileSync(join(root, "CLAUDE.md"), "# Project\n\nHand-written.\n");
  const mine = join(root, ccSkillsHome(), "mine");
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    join(mine, "SKILL.md"),
    "---\nname: mine\ndescription: Hand-written on purpose.\n---\nBody.\n",
  );
}

/** A top-level field of a repo JSON file. */
function jsonField(root: string, rel: string, key: string): unknown {
  const parsed: unknown = JSON.parse(read(root, rel));
  assert.ok(typeof parsed === "object" && parsed !== null, rel);
  return Object.entries(parsed).find(([k]) => k === key)?.[1];
}

/** The bytes of a repo file. */
function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

test("adopted repo: a bare re-run links the skills and writes nothing else", () => {
  withScratch((s) => {
    adoptedRepo(s.root);
    const pkgBefore = read(s.root, "package.json");
    const out = init(s);

    // What it SHOULD do: the skill links.
    SHIPPED_SKILLS.forEach((name) => {
      assert.ok(
        lstatSync(join(s.root, ccSkillsHome(), name)).isSymbolicLink(),
        `${name} linked\n${out}`,
      );
    });
    // Everything #338 had to revert by hand.
    assert.equal(
      existsSync(join(s.root, ".github", "workflows", "vigiles.yml")),
      false,
      `no CI workflow\n${out}`,
    );
    assert.equal(read(s.root, ".vigilesrc.json"), ADOPTED_CONFIG, "config");
    assert.equal(existsSync(join(s.root, "vigiles.harness.mjs")), false);
    assert.equal(existsSync(join(s.root, ".vigiles")), false, "no schema");
    assert.equal(existsSync(join(s.root, "CLAUDE.md.spec.ts")), false);
    assert.equal(
      existsSync(join(s.root, ccSkillsHome(), "mine", "SKILL.md.spec.ts")),
      false,
      "no spec for a hand-written skill",
    );
    assert.equal(read(s.root, "package.json"), pkgBefore, "pin untouched");
    // And it says what a full setup would add, and how to ask for it.
    assert.match(out, /init --full/);
    assert.match(out, /\.github\/workflows\/vigiles\.yml/);
    assert.match(out, /"extends": "vigiles:recommended"/);
  });
});

test("adopted repo with no vigiles devDependency: the re-run adds it, at the running major", () => {
  withScratch((s) => {
    adoptedRepo(s.root, {});
    init(s);
    const dev = jsonField(s.root, "package.json", "devDependencies");
    // `latest` only for an unreleased build (version 0.0.0-…), as in this repo.
    assert.match(JSON.stringify(dev), /"vigiles":"(\^\d+|latest)"/);
  });
});

test("adopted repo + --full: the full setup runs, keeping the user's own keys", () => {
  withScratch((s) => {
    adoptedRepo(s.root);
    init(s, ["--full", "--no-plugin"]);
    assert.ok(
      existsSync(join(s.root, ".github", "workflows", "vigiles.yml")),
      "the full setup wires CI",
    );
    assert.equal(
      jsonField(s.root, ".vigilesrc.json", "extends"),
      "vigiles:recommended",
    );
    assert.equal(
      jsonField(s.root, ".vigilesrc.json", "maxRules"),
      200,
      "the user's key is kept",
    );
  });
});

test("brand-new repo: a bare init is still the full setup, extending the preset", () => {
  withScratch((s) => {
    mkdirSync(join(s.root, ".git"));
    writeFileSync(
      join(s.root, "package.json"),
      JSON.stringify({ name: "fresh" }),
    );
    init(s, ["--no-plugin"]);
    // The generated workflow carries no version pin: the Action runs the
    // vigiles package.json declares, so there is one pin, not two.
    assert.doesNotMatch(
      read(s.root, ".github/workflows/vigiles.yml"),
      /^\s*version:/m,
    );
    assert.equal(
      jsonField(s.root, ".vigilesrc.json", "extends"),
      "vigiles:recommended",
    );
    assert.equal(
      jsonField(s.root, ".vigilesrc.json", "rules"),
      undefined,
      "no per-rule lines",
    );
  });
});
