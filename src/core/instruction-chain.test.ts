/**
 * The instruction BOUND — the domain's half of the instruction surface, tested
 * on its own because it is the half an adapter must not be able to move.
 *
 * The per-harness CLASSIFICATION lives beside each adapter
 * (`adapters/<h>/instruction-chain.test.ts`) and the cross-implementation
 * properties live in `adapter-properties.test.ts`. This file owns one module.
 */
import { describe, it, expect } from "vitest";

import {
  INSTRUCTION_SHAPES,
  instructionCandidatePaths,
  isInstructionShaped,
  isRepoRootedImport,
  settingsSourcePaths,
  siblingNamed,
} from "./instruction-chain.js";
import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { codexLayout } from "../adapters/codex/layout.js";

describe("the bound: what may be handed to a harness at all", () => {
  it("takes the repo root's markdown, a dot-directory's markdown, and a rules TREE", () => {
    expect(
      instructionCandidatePaths(
        [
          "CLAUDE.md",
          "README.md",
          ".claude/CLAUDE.md",
          ".claude/rules/one.md",
          ".claude/rules/team/two.md",
        ],
        claudeCodeLayout,
      ),
    ).toEqual([
      "CLAUDE.md",
      "README.md",
      ".claude/CLAUDE.md",
      ".claude/rules/one.md",
      ".claude/rules/team/two.md",
    ]);
  });

  it("refuses a nested instruction file — the walk the glob list used to drive", () => {
    // 🔴 THE DEFECT THIS WHOLE CHANGE REMOVES, as one assertion. `codexDialect`
    // shipped `"**/AGENTS.md"` and `scan.ts` expanded it by recursing through
    // the entire tree, so registering an adapter widened what vigiles read in
    // everyone's repository. No adapter appears in this call at all.
    expect(
      instructionCandidatePaths(
        [
          "AGENTS.md",
          "pkg/sub/AGENTS.md",
          "node_modules/dep/AGENTS.md",
          "src/index.ts",
          "package-lock.json",
        ],
        codexLayout,
      ),
    ).toEqual(["AGENTS.md"]);
  });

  it("takes each layout's SETTINGS sources, which are not instruction-shaped", () => {
    // `.codex/config.toml` is neither markdown nor an instruction: it is the
    // file that decides WHICH instructions load. Two roles, one map.
    //
    // 🔴 `.codex/config.local.toml` USED TO BE IN THIS LIST, and it is not a
    // file Codex is known to read — the core synthesized a `local` sibling for
    // every layout. A repository that happened to hold one had it parsed as a
    // real settings layer, so a `project_doc_fallback_filenames` inside it
    // could name an instruction file we then weighed and scored. The infix is
    // declared per adapter now; Codex declares none.
    expect(
      instructionCandidatePaths(
        [".codex/config.toml", ".codex/config.local.toml", ".codex/notes.txt"],
        codexLayout,
      ),
    ).toEqual([".codex/config.toml"]);
    // Control: the harness that DOES declare one still gets it, so this is a
    // narrowing of who, not a removal of the feature.
    expect(
      instructionCandidatePaths(
        [".claude/settings.json", ".claude/settings.local.json"],
        claudeCodeLayout,
      ),
    ).toEqual([".claude/settings.json", ".claude/settings.local.json"]);
  });

  it("every shape has a name, and the names are distinct", () => {
    // The shapes are the bound; a shape nobody can name is one nobody reviews.
    const names = INSTRUCTION_SHAPES.map((s) => s.what);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it("is a pure filter — order and membership come from the input alone", () => {
    const paths = ["b.md", "a.md", "docs/c.md"];
    expect(instructionCandidatePaths(paths, claudeCodeLayout)).toEqual([
      "b.md",
      "a.md",
    ]);
    expect(isInstructionShaped("docs/c.md")).toBe(false);
  });
});

describe("settingsSourcePaths: the parse target and its per-machine sibling", () => {
  // 🔴 THIS USED TO ASSERT THE SIBLING WAS DERIVED FOR EVERY LAYOUT, and the
  // derivation was the defect: `siblingNamed`'s own docblock says the two
  // vendors choose DIFFERENT words, so a core that picks one picks wrong for
  // somebody. It spelled `.codex/config.local.toml` — a file Codex is not known
  // to read — into the candidate set. The spelling is still derived from the
  // word; the WORD is now declared by the adapter that observed it.
  it("spells the sibling from the infix the LAYOUT declares", () => {
    expect(settingsSourcePaths(claudeCodeLayout)).toEqual([
      ".claude/settings.json",
      ".claude/settings.local.json",
    ]);
  });

  it("names no sibling for a layout that declares no infix", () => {
    expect(codexLayout.settingsLocalInfix).toBeUndefined();
    expect(settingsSourcePaths(codexLayout)).toEqual([".codex/config.toml"]);
  });

  it("still DERIVES the spelling, so moving the settings path moves both", () => {
    // Not a literal second path on the layout: the infix is the one fact that
    // is not already known, and a layout carrying both would let them disagree.
    const moved = {
      ...claudeCodeLayout,
      settingsPath: ".elsewhere/conf.json",
    };
    expect(settingsSourcePaths(moved)).toEqual([
      ".elsewhere/conf.json",
      ".elsewhere/conf.local.json",
    ]);
  });
});

describe("siblingNamed: one spelling, two vendors' words", () => {
  it("inserts the word before the extension", () => {
    expect(siblingNamed("CLAUDE.md", "local")).toBe("CLAUDE.local.md");
    expect(siblingNamed("AGENTS.md", "override")).toBe("AGENTS.override.md");
    expect(siblingNamed(".claude/settings.json", "local")).toBe(
      ".claude/settings.local.json",
    );
  });

  it("appends when there is no extension to insert before", () => {
    // A dotfile has no extension — `.` at position 0 is the name, not a
    // separator — so inventing one would produce `.claude.localrc`-shaped
    // nonsense.
    expect(siblingNamed("Makefile", "local")).toBe("Makefile.local");
    expect(siblingNamed(".cursorrules", "local")).toBe(".cursorrules.local");
  });
});

describe("isRepoRootedImport: an instruction file may name a path, not a MACHINE", () => {
  it("accepts a plain repo-relative path", () => {
    expect(isRepoRootedImport("docs/style.md")).toBe(true);
    expect(isRepoRootedImport("CONTRIBUTING.md")).toBe(true);
  });

  it("refuses an escape, a home reference and an absolute path", () => {
    // The import pass is the ONE read outside the dot-directory bound; it is
    // allowed because the repo OWNER wrote the token. That argument stops at the
    // repository edge — a file that can name `~/.ssh/config` or `../../etc`
    // would be choosing what vigiles opens on the machine running it.
    for (const bad of [
      "../secrets.md",
      "a/../../b.md",
      "~/notes.md",
      "/etc/x.md",
      "C:/x.md",
      "a\\b.md",
      "",
    ]) {
      expect(isRepoRootedImport(bad), bad).toBe(false);
    }
  });
});
