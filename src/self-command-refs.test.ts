/**
 * Self-command-refs — unit tests for the detector PLUS the repo DOGFOOD: scan
 * vigiles's own docs + comments and assert every `vigiles <cmd>` reference
 * resolves to a real command. This is the deterministic gate that would have
 * caught the stale `compile-hook`/`run-skill` refs a manual rename sweep missed
 * (the cross-reference moat applied to vigiles itself).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findStaleCommandRefs } from "./self-command-refs.js";
import { HOOK_RUNTIME_KINDS } from "./cli-commands.js";

const KNOWN = {
  verbs: ["compile", "lint", "hook-runtime"],
  kinds: ["run-program", "guard"],
};

describe("findStaleCommandRefs", () => {
  it("flags a removed verb in an inline code span", () => {
    const issues = findStaleCommandRefs(
      [
        {
          path: "d.md",
          content: "Run `vigiles compile-hook x.mjs` to wire it.",
        },
      ],
      KNOWN,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].ref).toBe("vigiles compile-hook");
    expect(issues[0].reason).toMatch(/unknown\/removed/);
  });

  it("flags a stale Usage: string and a cli.js invocation", () => {
    const issues = findStaleCommandRefs(
      [
        {
          path: "a.ts",
          content: '  console.error("Usage: vigiles run-skill x");',
        },
        { path: "b.ts", content: "  `node ${CLI} hook-runtime bogus`" },
      ],
      KNOWN,
    );
    expect(issues.map((i) => i.reason)).toEqual([
      expect.stringMatching(/unknown\/removed command "run-skill"/),
      expect.stringMatching(/unknown hook-runtime kind "bogus"/),
    ]);
  });

  it("flags a stale runtime ref behind the ${CLI} harness convention", () => {
    // The class that slipped past until now: a `.harness.mjs` calling the
    // pre-rename `refs-hook` via `node ${CLI} <cmd>` (the literal isn't
    // `vigiles`/`cli.js`). A correct `node ${CLI} hook-runtime <known-kind>` is clean.
    const issues = findStaleCommandRefs(
      [
        {
          path: "stale.harness.mjs",
          content: "  command: `node ${CLI} refs-hook`,",
        },
        {
          path: "ok.harness.mjs",
          content: "  command: `node ${CLI} hook-runtime guard`,",
        },
      ],
      KNOWN,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].ref).toBe("${CLI} refs-hook");
    expect(issues[0].reason).toMatch(/unknown\/removed command "refs-hook"/);
  });

  it("does NOT flag prose (no command context)", () => {
    const issues = findStaleCommandRefs(
      [
        {
          path: "d.md",
          content: "vigiles compiles the spec and verifies refs.",
        },
      ],
      KNOWN,
    );
    expect(issues).toEqual([]);
  });

  it("accepts a known verb, a known kind, and the bare umbrella", () => {
    const issues = findStaleCommandRefs(
      [
        {
          path: "d.md",
          content:
            "Run `vigiles compile`. The `vigiles hook-runtime run-program x` " +
            "entrypoint and the bare `vigiles hook-runtime` are fine.",
        },
      ],
      KNOWN,
    );
    expect(issues).toEqual([]);
  });

  it("honors a vigiles:ignore-cmd opt-out", () => {
    const issues = findStaleCommandRefs(
      [
        {
          path: "d.md",
          content:
            "The old `vigiles compile-hook` is gone <!-- vigiles:ignore-cmd -->",
        },
      ],
      KNOWN,
    );
    expect(issues).toEqual([]);
  });

  it("respects fenced code blocks", () => {
    const content = ["```bash", "vigiles run-hook-program x", "```"].join("\n");
    const issues = findStaleCommandRefs([{ path: "d.md", content }], KNOWN);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toMatch(
      /unknown\/removed command "run-hook-program"/,
    );
  });
});

// --- The repo dogfood -------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
// The must-be-current surfaces: public docs, the live spec, code, examples,
// wired scripts, and the shipped skills (whose SKILL.md bodies tell the model
// which commands to run — stale ones there misdirect the agent). research/ is
// the internal historical record (superseded proposals like the never-shipped
// `vigiles setup`) per the public-vs-internal rule, so it is deliberately not
// held to "every command currently exists".
const SCAN_DIRS = ["docs", "src", "examples", "hooks", "skills", ".github"];
const SCAN_EXT = /\.(md|ts|mjs|cjs|js|sh|yml|yaml)$/;
// The detector's own source + suite legitimately quote removed commands as
// examples/fixtures — excluded so they don't flag themselves.
const SELF = /self-command-refs\.(ts|test\.ts)$/;

function gatherFiles(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const add = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", ".git", "vendor"].includes(e.name))
          continue;
        add(rel);
      } else if (SCAN_EXT.test(e.name) && !SELF.test(e.name)) {
        out.push({
          path: rel,
          content: readFileSync(join(ROOT, rel), "utf-8"),
        });
      }
    }
  };
  for (const d of SCAN_DIRS) add(d);
  out.push({
    path: "README.md",
    content: readFileSync(join(ROOT, "README.md"), "utf-8"),
  });
  out.push({
    path: "CLAUDE.md",
    content: readFileSync(join(ROOT, "CLAUDE.md"), "utf-8"),
  });
  return out;
}

describe("repo dogfood: vigiles's own docs cite only real commands", () => {
  it("has no stale/unknown vigiles command references", () => {
    const issues = findStaleCommandRefs(gatherFiles());
    const report = issues
      .map((i) => `  ${i.file}:${i.line} — ${i.ref} (${i.reason})`)
      .join("\n");
    expect(issues, `stale command references:\n${report}`).toEqual([]);
  });
});

// --- The list is kept honest against the real dispatch ----------------------

describe("HOOK_RUNTIME_KINDS matches the dispatch", () => {
  const CLI = resolve(ROOT, "dist", "cli.js");
  const run = (args: string[]): string => {
    const r = spawnSync("node", [CLI, ...args], {
      input: "{}",
      encoding: "utf-8",
    });
    return (r.stdout ?? "") + (r.stderr ?? "");
  };

  it("rejects an unknown kind", () => {
    expect(run(["hook-runtime", "definitely-not-a-kind"])).toMatch(
      /unknown runtime entrypoint/,
    );
  });

  for (const kind of HOOK_RUNTIME_KINDS) {
    it(`recognizes hook-runtime ${kind}`, () => {
      expect(run(["hook-runtime", kind])).not.toMatch(
        /unknown runtime entrypoint/,
      );
    });
  }
});
