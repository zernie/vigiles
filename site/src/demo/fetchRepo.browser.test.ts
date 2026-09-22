import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fetchRepo,
  isHarnessPath,
  isHarnessMarker,
  isTestPath,
  collectReferencedPaths,
} from "./fetchRepo";

// Pure-helper guards for the two harness-detection bugs the PR review flagged.
// (These run under the browser-mode project like the rest of site/, but they touch
// no DOM — just the exported pure functions.)

describe("isHarnessPath — top-level surfaces only", () => {
  it("matches a top-level harness dir + root file", () => {
    expect(isHarnessPath("skills/x/SKILL.md")).toBe(true);
    expect(isHarnessPath("hooks/guard.sh")).toBe(true);
    expect(isHarnessPath(".claude/settings.json")).toBe(true);
    expect(isHarnessPath(".claude-plugin/plugin.json")).toBe(true);
    expect(isHarnessPath("CLAUDE.md")).toBe(true);
    expect(isHarnessPath(".mcp.json")).toBe(true);
  });

  it("FETCHES a root AGENTS.md — the CLI's chain loads one, so the twin must see it", () => {
    // Since v2.1.277 Claude Code reads `AGENTS.md` natively. A twin that did
    // not fetch it would hand the chain a map without it and print a weight of
    // zero for a repo that really loads the file — a missing FILE on the
    // browser side only, not a wrong digit.
    expect(isHarnessPath("AGENTS.md")).toBe(true);
  });

  it("…but a bare AGENTS.md is NOT a harness MARKER — that file is Codex's", () => {
    // The other half, and the one that keeps the demo honest: fetching a file
    // is not detecting on it. `claudeCodeAdapter.detect` makes the same split —
    // it scores `CLAUDE.md` and never `AGENTS.md` — so a repo holding nothing
    // but an AGENTS.md stays in the no-harness state instead of being graded as
    // an empty Claude Code machine.
    expect(isHarnessMarker("AGENTS.md")).toBe(false);
  });

  it("does NOT match a harness word nested in an ordinary source tree", () => {
    // The bug: `src/hooks/useThing.ts` in a plain React app was treated as a
    // harness → graded an empty machine instead of the no-harness state.
    expect(isHarnessPath("src/hooks/useThing.ts")).toBe(false);
    expect(isHarnessPath("packages/app/skills/index.ts")).toBe(false);
    expect(isHarnessPath("app/commands/run.ts")).toBe(false);
    expect(isHarnessPath("README.md")).toBe(false);
    expect(isHarnessPath("src/agents.ts")).toBe(false);
  });
});

describe("isHarnessMarker — a definitive Claude harness signal", () => {
  it("accepts real markers", () => {
    expect(isHarnessMarker("CLAUDE.md")).toBe(true);
    expect(isHarnessMarker(".mcp.json")).toBe(true);
    expect(isHarnessMarker("SKILL.md")).toBe(true); // single-skill repo root
    expect(isHarnessPath("SKILL.md")).toBe(true);
    expect(isHarnessMarker(".claude/settings.json")).toBe(true);
    expect(isHarnessMarker(".claude-plugin/plugin.json")).toBe(true);
    expect(isHarnessMarker("hooks/hooks.json")).toBe(true);
    expect(isHarnessMarker("skills/deploy/SKILL.md")).toBe(true);
    expect(isHarnessMarker("agents/reviewer.md")).toBe(true);
    expect(isHarnessMarker("commands/ship.md")).toBe(true);
  });

  it("rejects an undeclared top-level hooks/ (git hooks) + ordinary files", () => {
    // The bug: a repo with `hooks/pre-commit.sh` and no Claude declaration was
    // graded instead of shown the no-harness state.
    expect(isHarnessMarker("hooks/pre-commit.sh")).toBe(false);
    expect(isHarnessMarker("hooks/lint.js")).toBe(false);
    expect(isHarnessMarker("skills/README.md")).toBe(false);
    expect(isHarnessMarker("README.md")).toBe(false);
    expect(isHarnessMarker("src/index.js")).toBe(false);
  });
});

describe("collectReferencedPaths — hook scripts outside harness dirs", () => {
  it("catches plugin-root / project-dir token refs (braced + unbraced)", () => {
    const refs = collectReferencedPaths({
      "CLAUDE.md": "run ${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh then done",
      ".claude/settings.json": '"command": "$CLAUDE_PROJECT_DIR/bin/check.py"',
    });
    expect(refs.has("scripts/guard.sh")).toBe(true);
    expect(refs.has("bin/check.py")).toBe(true);
  });

  it("catches RELATIVE dir-qualified script refs (the P1 follow-up)", () => {
    const refs = collectReferencedPaths({
      ".claude/settings.json": '{ "command": "bash scripts/guard.sh" }',
      "hooks/hooks.json": '"command": "./bin/lint.mjs --fix"',
    });
    expect(refs.has("scripts/guard.sh")).toBe(true);
    expect(refs.has("bin/lint.mjs")).toBe(true);
  });

  it("ignores prose and non-script paths", () => {
    const refs = collectReferencedPaths({
      "CLAUDE.md": "See docs/guide.md and the src/ folder for details.",
    });
    expect(refs.size).toBe(0);
  });

  it("catches SKILL.md bundled resources (references/assets + md links)", () => {
    // A root single-skill repo's non-script bundled resources — the harness filter
    // drops them, so the scan would falsely flag them missing without this fetch.
    const refs = collectReferencedPaths({
      "SKILL.md":
        "Read `references/api.md` for the schema. See [the guide](assets/guide.md).\n",
    });
    expect(refs.has("references/api.md")).toBe(true);
    expect(refs.has("assets/guide.md")).toBe(true);
  });

  it("ignores external links (no false bundled-resource fetch)", () => {
    const refs = collectReferencedPaths({
      "SKILL.md":
        "See [docs](https://example.com/x.md) and prose about assets.\n",
    });
    expect(refs.size).toBe(0);
  });

  it("collects bundled-resource refs ONLY from SKILL.md, not CLAUDE.md", () => {
    // A CLAUDE.md's ordinary doc links are not graded bundled resources, so they
    // must NOT become required second-pass fetches (which could wrongly bail the
    // repo to too-large/error). A SKILL.md's are; a hook-script ref is, anywhere.
    const refs = collectReferencedPaths({
      "CLAUDE.md":
        "See [the guide](docs/guide.md) and [api](references/api.md).",
      "skills/foo/SKILL.md": "Read `references/schema.md`.",
      ".claude/settings.json": '{ "command": "bash scripts/guard.sh" }',
    });
    expect(refs.has("docs/guide.md")).toBe(false); // CLAUDE.md md-link — dropped
    expect(refs.has("references/api.md")).toBe(false); // CLAUDE.md ref — dropped
    expect(refs.has("references/schema.md")).toBe(true); // SKILL.md bundled resource
    expect(refs.has("scripts/guard.sh")).toBe(true); // hook script — any file
  });
});

describe("fetchRepo — never grades partial data", () => {
  afterEach(() => vi.unstubAllGlobals());

  const resp = (body: Partial<Response> & { text?: () => Promise<string> }) =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "content",
      json: async () => ({}),
      ...body,
    }) as unknown as Response;

  /** Route the three GitHub endpoints; `raw(path)` decides the raw.githubusercontent
   *  leg (path = the repo-relative path after `/main/`). */
  function stubGitHub(tree: unknown[], raw: (path: string) => Response): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u.includes("/git/trees/"))
          return resp({ json: async () => ({ tree }) });
        if (u.startsWith("https://api.github.com/repos/")) {
          return resp({ json: async () => ({ default_branch: "main" }) });
        }
        const path = decodeURIComponent(u.slice(u.indexOf("/main/") + 6));
        return raw(path); // raw.githubusercontent.com
      }),
    );
  }

  it("returns too-large when harness surfaces exceed the file cap", async () => {
    // 301 real skill markers — more than the browser reads fully. Grading a
    // truncated slice would misreport the inventory, so it must bail.
    const tree = Array.from({ length: 301 }, (_, i) => ({
      path: `skills/s${i}/SKILL.md`,
      type: "blob",
      size: 10,
    }));
    stubGitHub(tree, () => resp({}));
    expect((await fetchRepo("o/r")).kind).toBe("too-large");
  });

  it("returns a retryable error when a harness file fetch fails", async () => {
    // The one surface (root SKILL.md) 500s → grading without it would be partial.
    stubGitHub([{ path: "SKILL.md", type: "blob", size: 10 }], () =>
      resp({ ok: false, status: 500 }),
    );
    expect((await fetchRepo("o/r")).kind).toBe("error");
  });

  it("grades normally when every harness file fetches", async () => {
    stubGitHub([{ path: "SKILL.md", type: "blob", size: 10 }], () =>
      resp({ text: async () => "Does a thing.\n" }),
    );
    expect((await fetchRepo("o/r")).kind).toBe("ok");
  });

  it("errors when a REQUIRED second-pass file (manifest hook config) fails", async () => {
    const tree = [
      { path: ".claude-plugin/plugin.json", type: "blob", size: 40 },
      { path: "config/hooks.json", type: "blob", size: 20 },
    ];
    stubGitHub(tree, (path) => {
      if (path === ".claude-plugin/plugin.json") {
        return resp({ text: async () => '{ "hooks": "config/hooks.json" }' });
      }
      return resp({ ok: false, status: 500 }); // the referenced hook config 500s
    });
    expect((await fetchRepo("o/r")).kind).toBe("error");
  });

  it("fetches a coverage test outside the harness dirs (advisory), still ok", async () => {
    const tree = [
      { path: "skills/foo/SKILL.md", type: "blob", size: 10 },
      { path: "tests/foo.test.ts", type: "blob", size: 20 },
    ];
    stubGitHub(tree, (path) =>
      resp({
        text: async () =>
          path === "tests/foo.test.ts" ? "covers skills/foo" : "A skill.\n",
      }),
    );
    const out = await fetchRepo("o/r");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect("tests/foo.test.ts" in out.files).toBe(true);
  });

  it("returns too-large when required second-pass files exceed the budget", async () => {
    // 300 skill surfaces (== cap, so first-pass passes) whose first skill also
    // references a tree-present bundled resource → the second pass has no budget
    // left, so grading would drop a required file → bail to too-large.
    const tree = [
      ...Array.from({ length: 300 }, (_, i) => ({
        path: `skills/s${i}/SKILL.md`,
        type: "blob",
        size: 10,
      })),
      { path: "references/api.md", type: "blob", size: 10 },
    ];
    stubGitHub(tree, (path) =>
      resp({
        text: async () =>
          path === "skills/s0/SKILL.md"
            ? "Read `references/api.md`.\n"
            : "A skill.\n",
      }),
    );
    expect((await fetchRepo("o/r")).kind).toBe("too-large");
  });

  it("a coverage-test fetch FAILURE does not error the grade (advisory)", async () => {
    const tree = [
      { path: "skills/foo/SKILL.md", type: "blob", size: 10 },
      { path: "tests/foo.test.ts", type: "blob", size: 20 },
    ];
    stubGitHub(tree, (path) => {
      if (path === "tests/foo.test.ts") return resp({ ok: false, status: 500 });
      return resp({ text: async () => "A skill.\n" });
    });
    expect((await fetchRepo("o/r")).kind).toBe("ok"); // test 500 tolerated
  });
});

describe("isTestPath", () => {
  it("matches test/eval files (incl. outside harness dirs), not sources", () => {
    expect(isTestPath("tests/foo.test.ts")).toBe(true);
    expect(isTestPath("skills/foo/foo.eval.mjs")).toBe(true);
    expect(isTestPath("__tests__/x.spec.tsx")).toBe(true);
    expect(isTestPath("test/thing.py")).toBe(true);
    expect(isTestPath("src/index.ts")).toBe(false);
    expect(isTestPath("skills/foo/SKILL.md")).toBe(false);
  });
});
