/**
 * Codex's instruction chain, against the vendor rules quoted in its own header.
 *
 * The case that matters most is the one the glob list got backwards: at a
 * repo-root session Codex loads the ROOT file and nothing else, because its walk
 * runs root→cwd and at the root those are the same directory. `"**\/AGENTS.md"`
 * summed files that never load together, on the harness that TRUNCATES silently
 * over budget — so the number meant to warn about missing rules was itself the
 * thing crying wolf.
 */
import { describe, it, expect } from "vitest";

import { codexLayout } from "./layout.js";
import { overrideSiblingOf } from "./instruction-chain.js";

const chain = (files: Record<string, string>) =>
  codexLayout.instructionChain(files);
const paths = (files: Record<string, string>) =>
  chain(files).loaded.map((e) => e.path);

describe("at most ONE file per directory", () => {
  it("loads the committed root file when it is the only candidate", () => {
    expect(paths({ "AGENTS.md": "a" })).toEqual(["AGENTS.md"]);
  });

  it("the override REPLACES the committed file — the mirror of Claude Code", () => {
    // Claude Code APPENDS its per-machine file after the committed one; Codex
    // takes the override INSTEAD. That difference is the combination rule, which
    // is the harness's to own — the core only learns that a file was replaced,
    // and by which.
    const files = { "AGENTS.md": "a", "AGENTS.override.md": "mine" };
    expect(paths(files)).toEqual(["AGENTS.override.md"]);
    expect(chain(files).unloaded).toEqual([
      {
        path: "AGENTS.md",
        role: "root",
        scope: "repo",
        reason: { kind: "replaced", by: "AGENTS.override.md" },
      },
    ]);
  });

  it("a committed override is the directory's instruction file, and is scored", () => {
    // 🔴 THIS TEST USED TO PIN THE OPPOSITE — `["root-local", "local"]`, "read,
    // linted, never scored". That was a model built by ANALOGY with Claude
    // Code's `CLAUDE.local.md`, and the vendor says no such thing. Its guide,
    // verbatim: "In each directory along the path, it checks for
    // `AGENTS.override.md`, then `AGENTS.md`". The only "temporary" override it
    // describes is the GLOBAL one, `~/.codex/AGENTS.override.md`; the page never
    // mentions `.gitignore`. Measured on the browser engine, where every file in
    // the map is committed by construction, a repository holding both files
    // published `committed 0` — while Codex loads the override's bytes.
    expect(
      chain({ "AGENTS.override.md": "mine" }).loaded.map((e) => [
        e.role,
        e.scope,
      ]),
    ).toEqual([["root", "repo"]]);
  });

  it("and it still takes the slot: a committed override replaces AGENTS.md", () => {
    // The control half. Scoring the override must not score BOTH files — the
    // vendor's precedence gives each directory one slot, and the override wins it.
    const c = chain({ "AGENTS.override.md": "mine", "AGENTS.md": "team" });
    expect(c.loaded.map((e) => e.path)).toEqual(["AGENTS.override.md"]);
    expect(c.unloaded.map((e) => e.path)).toContain("AGENTS.md");
  });

  it("derives the override name from the instruction file", () => {
    expect(overrideSiblingOf(codexLayout.instructionFile)).toBe(
      "AGENTS.override.md",
    );
  });
});

describe("the repo's own config decides which names count", () => {
  it("honours `project_doc_fallback_filenames` when neither documented name exists", () => {
    const files = {
      "CONTEXT.md": "fallback body",
      ".codex/config.toml": 'project_doc_fallback_filenames = ["CONTEXT.md"]\n',
    };
    expect(paths(files)).toEqual(["CONTEXT.md"]);
    expect(chain(files).loaded[0]?.role).toBe("fallback");
  });

  it("a fallback does NOT beat the documented file — it is replaced by it", () => {
    const files = {
      "AGENTS.md": "a",
      "CONTEXT.md": "fallback",
      ".codex/config.toml": 'project_doc_fallback_filenames = ["CONTEXT.md"]\n',
    };
    expect(paths(files)).toEqual(["AGENTS.md"]);
    expect(chain(files).unloaded.map((e) => [e.path, e.reason])).toEqual([
      ["CONTEXT.md", { kind: "replaced", by: "AGENTS.md" }],
    ]);
  });

  it("an unparseable config falls back to the documented names rather than throwing", () => {
    expect(
      paths({ "AGENTS.md": "a", ".codex/config.toml": "= not toml" }),
    ).toEqual(["AGENTS.md"]);
  });

  it("a fallback key of the wrong TYPE is ignored", () => {
    expect(
      paths({
        "AGENTS.md": "a",
        ".codex/config.toml": 'project_doc_fallback_filenames = "CONTEXT.md"\n',
      }),
    ).toEqual(["AGENTS.md"]);
  });
});

describe("what a root session does NOT load", () => {
  it("a nested AGENTS.md is on-demand, not part of the root chain", () => {
    const files = { "AGENTS.md": "a", "pkg/AGENTS.md": "b" };
    expect(paths(files)).toEqual(["AGENTS.md"]);
    expect(chain(files).unloaded).toEqual([
      {
        path: "pkg/AGENTS.md",
        role: "root",
        scope: "repo",
        reason: { kind: "on-demand", when: "subdirectory" },
      },
    ]);
  });

  it("a nested override is a repository file too, loaded on demand like its sibling", () => {
    // Pinned `["root-local", "local"]` until the scope was corrected at the
    // root (see "a committed override is the directory's instruction file").
    // The nested copy is the same file one directory down: repository scope,
    // and "on demand" for the same reason a nested `AGENTS.md` is.
    const [e] = chain({ "pkg/AGENTS.override.md": "b" }).unloaded;
    expect([e.role, e.scope, e.reason]).toEqual([
      "root",
      "repo",
      { kind: "on-demand", when: "subdirectory" },
    ]);
  });

  it("names no imports and no patterns — Codex's project doc has no include", () => {
    const c = chain({ "AGENTS.md": "see @docs/style.md" });
    expect([c.imports, c.patterns]).toEqual([[], []]);
  });
});
