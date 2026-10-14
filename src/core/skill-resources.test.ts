/**
 * Skill bundled-resource resolution detector suite (vitest): a SKILL.md body's
 * local file references resolve, with the FP-safe skip list (URLs, absolute
 * paths, `../` escapes, bare words, `$VAR` tokens) deliberately not flagged.
 * IO is an injected fake existsSync — no real filesystem.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

import {
  repoRootOnlyAdvice,
  skillResourceIssues,
  type SkillResourceFinding,
} from "./skill-resources.js";

const SKILL_DIR = "/plugin/skills/my-skill";

/** A fake existsSync that returns true only for the given relative paths. */
function existsOnly(...present: string[]): (p: string) => boolean {
  const set = new Set(present.map((rel) => resolve(SKILL_DIR, rel)));
  return (p) => set.has(p);
}

function run(
  body: string,
  exists: (p: string) => boolean,
): readonly SkillResourceFinding[] {
  return skillResourceIssues(body, SKILL_DIR, { existsSync: exists });
}

describe("skillResourceIssues", () => {
  // ── a file the skill WRITES is not a file the skill SHIPS ──────────────────
  // Regression for a measured false positive (2026-08-20): a consumer skill's
  // line "API responses are cached to `scripts/.cite-cache.json` (gitignored)
  // so re-runs are cheap" was reported as a missing bundled resource, because
  // `USE_DIRECTIVE`'s `runs` matches INSIDE `re-runs` (JavaScript's `\b` treats
  // a hyphen as a word boundary). The three cases below are the fixture that
  // isolated it: only the middle one ever fired.
  it("does not flag a gitignored cache the skill writes, even with a verb inside a hyphenated word", () => {
    const body =
      "Responses are cached to `scripts/.cache.json` (gitignored) so re-runs are cheap.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("does not flag the same line phrased without the hyphenated word", () => {
    const body =
      "Responses are cached to `scripts/.cache.json` (gitignored) so subsequent invocations are cheap.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("does not flag a markdown link to a file the line says is written at runtime", () => {
    const body =
      "The run drops a summary at [scripts/out.json](scripts/out.json), generated at runtime.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  // The veto is narrow ON PURPOSE: it keys on the line SAYING the file is
  // produced, not on the hyphen. So a genuine directive that happens to carry a
  // hyphenated verb must still be checked — otherwise this fix would trade one
  // false positive for a false negative, which is the alternative it rejected.
  it("still flags a missing file when a hyphenated verb is a REAL directive", () => {
    const body = "Re-run `scripts/verify.sh` before submitting.";
    const found = run(body, existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ resolved: "scripts/verify.sh" });
  });

  it("does not flag a markdown link to an existing scripts/ file", () => {
    const body = "See [the runner](scripts/run.sh) for setup.";
    expect(run(body, existsOnly("scripts/run.sh"))).toEqual([]);
  });

  it("flags a markdown link to a missing references/ file", () => {
    const body = "Read [the API](references/api.md) before editing.";
    const found = run(body, existsOnly()); // nothing exists
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ref: "references/api.md",
      resolved: "references/api.md",
      kind: "link",
      line: 1,
    });
  });

  it("resolves a ./-prefixed relative link", () => {
    const body = "Run [setup](./scripts/setup.py).";
    expect(run(body, existsOnly("scripts/setup.py"))).toEqual([]);
    expect(run(body, existsOnly())).toHaveLength(1);
  });

  it("skips a URL link", () => {
    const body =
      "See [the docs](https://example.com/api.md) and [http](http://x.io/y.sh).";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips an absolute path link", () => {
    const body = "Load [config](/etc/vigiles/config.json).";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a percent-encoded link (a URL / space-handling EXAMPLE, not a real file)", () => {
    // Regression: a skill documenting how to handle spaces in paths shows an inline
    // markdown-link EXAMPLE like `[a report](docs/My%20File.pdf)`. `%20` is URL
    // encoding — a real bundled file on disk is never percent-encoded — so flagging
    // it "missing" is a false positive on a prose example, not a real broken ref.
    const body =
      "To handle spaces, reference [a report](docs/My%20File.pdf) — encode the space.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a ../ escape out of the skill dir", () => {
    const body =
      "See [sibling](../other-skill/scripts/run.sh) and [up](../shared.md).";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a bare anchor / fragment-only link", () => {
    const body = "Jump to [section](#usage).";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("flags an inline `scripts/x.sh` mention that is missing", () => {
    const body = "First run `scripts/setup.sh` to install deps.";
    const found = run(body, existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ref: "scripts/setup.sh",
      kind: "path",
      line: 1,
    });
  });

  it("does not flag an existing inline bundle path", () => {
    const body = "Run `assets/template.json` through the generator.";
    expect(run(body, existsOnly("assets/template.json"))).toEqual([]);
  });

  it("does NOT flag illustrative inline bundle paths on a teaching skill (cry-wolf regression)", () => {
    // The prose patterns from the official `skill-development` skill: bundle
    // paths mentioned as EXAMPLES of what a skill could ship, not files it uses.
    // None of these carry a use-directive, and most carry an illustrative cue —
    // flagging them graded a clean skill an F. All must stay silent.
    const body = [
      "2. A `scripts/rotate_pdf.py` script would be helpful to store in the skill",
      "2. A `references/schema.md` file documenting the table schemas would be helpful",
      "**Example**: `scripts/rotate_pdf.py` for PDF rotation tasks",
      "**Examples**: `references/finance.md` for financial schemas, `references/mnda.md` for the NDA template",
      "**Examples**: `assets/logo.png` for brand assets, `assets/slides.pptx`, `assets/font.ttf` for typography",
      "- Detailed patterns → `references/patterns.md`",
      "- **`references/patterns.md`** - Common patterns",
      "`references/patterns.md` for detailed hook patterns to avoid bloating SKILL.md",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips an inline bundle path with a use-directive but an illustrative cue", () => {
    // Even WITH a use-directive, an explicit illustrative cue means the path is
    // a demonstration, not a real reference — the negative gate wins.
    const body = "For example, run `scripts/demo.sh` to see how it works.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips an inline bundle path with no use-directive (bare mention)", () => {
    // A path stated as a fact with no imperative to act on it is undecidable
    // prose — biased toward precision, we don't flag it.
    const body = "The schema lives at `references/schema.md` in the repo.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("STILL flags a missing inline bundle path the skill is told to use (true positive)", () => {
    // The genuine dead-ref: an imperative directing the agent at a missing file.
    const body =
      "First read `references/setup.md`, then run `scripts/install.sh`.";
    const found = run(body, existsOnly());
    expect(found.map((f) => f.resolved).sort()).toEqual([
      "references/setup.md",
      "scripts/install.sh",
    ]);
  });

  it("does NOT flag an illustrative markdown-link EXAMPLE (issue #110)", () => {
    // Regression: markdown links now carry the SAME illustrative-cue prose
    // gate as inline spans — "For example, see [the schema](...)" describes a
    // hypothetical usage, not a real bundled file the skill ships. Previously
    // this fired unconditionally (candidatesInLine had no gate on the link
    // branch), which is exactly the false positive issue #110 reports (a
    // SKILL.md documenting how to write a path — e.g. escaping a space in a
    // filename — via an example markdown link).
    const body =
      "For example, see [a report](assets/My-Escaped-Space.pdf) for how to write the path.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("STILL flags a missing bundled resource behind a directive markdown link with no illustrative cue (issue #110 caution)", () => {
    // A markdown link that DIRECTS the agent to a file, carrying no
    // illustrative cue, is still a genuine follow-me reference and must fire.
    const body = "Read [the schema](references/schema.md) before editing.";
    const found = run(body, existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      resolved: "references/schema.md",
      kind: "link",
    });
  });

  it("flags a plain resource link with NO use directive (a link is explicit syntax — Codex review)", () => {
    // A markdown link is the actual file reference, so a normal resource listing
    // ("Resources: [API](references/api.md)") must still be checked even without a
    // verb like read/see/run — only an illustrative cue suppresses a link.
    const body = "Resources: [the API](references/api.md).";
    const found = run(body, existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      resolved: "references/api.md",
      kind: "link",
    });
  });

  it("can be disabled entirely via <!-- vigiles-disable skill-resource-resolves --> (issue #110)", () => {
    // The escape hatch — a skill body that inherently reads as full of
    // illustrative bundle-path examples (a skill-authoring tutorial) can opt
    // out wholesale, mirroring orphans.ts's `vigiles-disable orphan-docs`.
    const body = [
      "<!-- vigiles-disable skill-resource-resolves -->",
      "Read [the schema](references/schema.md) before editing.",
      "Run `scripts/install.sh` to set up.",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("still flags without the disable marker (control for the escape-hatch test)", () => {
    const body = "Read [the schema](references/schema.md) before editing.";
    expect(run(body, existsOnly())).toHaveLength(1);
  });

  // --- headings name the script the section is about (dogfood 2026-08-08) ----

  it("flags a bundled script named in a SECTION HEADING (no use verb)", () => {
    // 🔴 The regression this exists for. A skill's own `structure.mjs` sits at the
    // skill ROOT; the SKILL.md pointed at `scripts/structure.mjs` from the heading
    // of the section about running it. The verb gate reads prose, a heading has no
    // prose, and the broken ref went unreported for three days. Measured: this line
    // yielded [], while "Run the mechanical leg — `scripts/structure.mjs`" — same
    // file, same missing target — correctly yielded the finding.
    const body =
      "## 🏗 START WITH THE MECHANICAL LEG — `scripts/structure.mjs` (added 2026-08-05)";
    const found = run(body, existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ref: "scripts/structure.mjs",
      resolved: "scripts/structure.mjs",
      kind: "path",
      line: 1,
    });
  });

  it("does not flag a heading naming a bundled script that EXISTS", () => {
    const body = "### `scripts/structure.mjs`";
    expect(run(body, existsOnly("scripts/structure.mjs"))).toEqual([]);
  });

  it("still skips an ILLUSTRATIVE heading (the cue vetoes a heading too)", () => {
    // A skill that teaches skill-authoring headlines its examples. Widening to
    // headings must not reopen that false positive.
    const body = [
      "## Examples of bundled scripts: `scripts/rotate_pdf.py`",
      "## A template layout — `references/patterns.md`",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("keeps the verb gate on ORDINARY prose (the wide net was NOT taken)", () => {
    // The narrow fix promotes HEADINGS only. A mid-paragraph mention with no
    // directive stays unchecked — flagging every backticked bundle path was
    // measured FP-heavy on teaching skills, which is why the gate exists at all.
    const body =
      "A skill ships `scripts/rotate.py` alongside its SKILL.md, one dir deep.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a bare word inline mention (no extension, no bundle prefix)", () => {
    const body = "Use the `runHook` helper and the `scripts` directory.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a generic inline path with no bundle-dir prefix", () => {
    // `src/foo.ts` is an API/prose mention, not a standard bundled resource.
    const body = "The logic lives in `src/foo.ts` and `config.json`.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a ${VAR}/$VAR token", () => {
    const body =
      "Run [hook](${CLAUDE_PLUGIN_ROOT}/scripts/x.sh) or `$HOME/scripts/y.sh`.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips references inside fenced code blocks (illustrative examples)", () => {
    const body = [
      "Here is an example:",
      "```sh",
      "cat scripts/example.sh",
      "[link](references/sample.md)",
      "```",
      "End.",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("de-dupes the same missing file referenced multiple times", () => {
    const body = [
      "Run `scripts/run.sh` now.",
      "Later, re-run `scripts/run.sh`.",
    ].join("\n");
    expect(run(body, existsOnly())).toHaveLength(1);
  });

  it("reports multiple distinct missing resources with correct lines", () => {
    const body = [
      "Read [api](references/api.md).", // line 1 — missing
      "It exists: [ok](scripts/ok.sh).", // line 2 — present
      "Run `assets/seed.json`.", // line 3 — missing
    ].join("\n");
    const found = run(body, existsOnly("scripts/ok.sh"));
    expect(found.map((f) => f.resolved).sort()).toEqual([
      "assets/seed.json",
      "references/api.md",
    ]);
    expect(found.find((f) => f.resolved === "references/api.md")?.line).toBe(1);
    expect(found.find((f) => f.resolved === "assets/seed.json")?.line).toBe(3);
  });

  it("resolves a link target carrying a #fragment", () => {
    const body = "See [auth](references/api.md#auth).";
    expect(run(body, existsOnly("references/api.md"))).toEqual([]);
    expect(run(body, existsOnly())[0]?.resolved).toBe("references/api.md");
  });

  it("skips a glob pattern (not a concrete file) — P1-3", () => {
    // `references/*.md` is a directory convention, not a literal path. Both the
    // inline-span and markdown-link forms must be skipped, never "missing".
    const body = [
      "All refs live under `references/*.md`.",
      "See [the cards](references/*.md) for the list.",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips angle-bracket + brace template placeholders — P1-3", () => {
    const body = [
      "Each linter has `references/linter-cards/{trivial,contextual}/<linter>.md`.",
      "Tests live at `scripts/tests/test_assert_<target>_x.py`.",
    ].join("\n");
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("skips a `~/`-rooted home/global ref (external to the repo) — P1-5", () => {
    const body =
      "Route via [docs](~/.claude/docs/foo.md) and `~/.claude/rules/bar.md`.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("checks a bundled ref with a ?query suffix (not skipped as a glob) — P1-3", () => {
    // `references/schema.json?raw=1` is a real bundled file with a query suffix;
    // the `?` must NOT trigger the glob-skip — the file is still resolved/flagged.
    const body = "See [schema](references/schema.json?raw=1) for the shape.";
    // missing under the skill dir → flagged (resolves to the stripped path)
    const flagged = run(body, existsOnly());
    expect(flagged).toHaveLength(1);
    expect(flagged[0].resolved).toBe("references/schema.json");
    // present → resolves, not flagged
    expect(run(body, existsOnly("references/schema.json"))).toEqual([]);
  });
});

describe("skillResourceIssues — a ref that resolves only from the repo root (#382)", () => {
  // The agent usually runs from the repository root, so a skill that says
  // "run `scripts/check.sh`" often means `<repo>/scripts/check.sh`. That works
  // while the skill runs inside its own repository and breaks once the skill is
  // installed anywhere else. Not "missing", not "fine": a separate resolution.
  const REPO_ROOT = "/repo";
  const DIR = "/repo/tools/skills/my-skill";
  const at =
    (...abs: string[]) =>
    (p: string): boolean =>
      abs.includes(p);
  const body = "Run `scripts/check.sh` before committing.";

  it("reports `repo-root-only` when the file exists at the repo root but not beside the SKILL.md", () => {
    expect(
      skillResourceIssues(body, DIR, {
        existsSync: at("/repo/scripts/check.sh"),
        repoRoot: REPO_ROOT,
      }),
    ).toEqual([
      {
        ref: "scripts/check.sh",
        resolved: "scripts/check.sh",
        kind: "path",
        line: 1,
        resolution: "repo-root-only",
      },
    ]);
  });

  it("still reports `missing` when the file exists nowhere", () => {
    expect(
      skillResourceIssues(body, DIR, {
        existsSync: at(),
        repoRoot: REPO_ROOT,
      }),
    ).toMatchObject([{ ref: "scripts/check.sh", resolution: "missing" }]);
  });

  it("reports nothing when the file exists under the skill dir (the repo-root copy is irrelevant)", () => {
    expect(
      skillResourceIssues(body, DIR, {
        existsSync: at(
          "/repo/tools/skills/my-skill/scripts/check.sh",
          "/repo/scripts/check.sh",
        ),
        repoRoot: REPO_ROOT,
      }),
    ).toEqual([]);
  });

  it("reports nothing when the dir is a declared shared dir — sharedDirs is unchanged", () => {
    expect(
      skillResourceIssues(body, DIR, {
        existsSync: at("/repo/scripts/check.sh"),
        repoRoot: REPO_ROOT,
        sharedDirs: ["scripts"],
      }),
    ).toEqual([]);
  });

  it("applies to a markdown link the same way as to an inline path", () => {
    expect(
      skillResourceIssues("Read [the guide](docs/guide.md).", DIR, {
        existsSync: at("/repo/docs/guide.md"),
        repoRoot: REPO_ROOT,
      }),
    ).toMatchObject([
      { ref: "docs/guide.md", kind: "link", resolution: "repo-root-only" },
    ]);
  });

  it("resolves a declared shared-dir ref against the repo root — P1-4 (opt-in)", () => {
    // `scripts/promptfoo/x.py` lives at the REPO ROOT, not beside the SKILL.md —
    // the shared-tree shape. Only when `scripts` is a DECLARED shared dir does it
    // resolve against the repo root; without that opt-in it's still "missing".
    const REPO_ROOT = "/plugin";
    const body = "Run `scripts/promptfoo/baseline_leak_scan.py` to check.";
    const existsAtRepoRoot = (p: string): boolean =>
      p === resolve(REPO_ROOT, "scripts/promptfoo/baseline_leak_scan.py");
    // no repo root handed over → the detector can only see the skill dir: missing
    expect(run(body, existsAtRepoRoot)).toMatchObject([
      { resolution: "missing" },
    ]);
    // opt-in: `scripts` declared shared → resolves against repo root, not flagged
    expect(
      skillResourceIssues(body, SKILL_DIR, {
        existsSync: existsAtRepoRoot,
        repoRoot: REPO_ROOT,
        sharedDirs: ["scripts", "references"],
      }),
    ).toEqual([]);
  });

  it("does NOT mask a ref outside a declared shared dir — P1-4 safety", () => {
    // Even with `scripts` shared, a ref under a DIFFERENT top dir (`references/`)
    // that only exists at the repo root is NOT resolved. It is reported as a
    // `repo-root-only` finding — visible, never silently dropped — rather than
    // as resolved by a same-named repo-root file.
    const REPO_ROOT = "/plugin";
    const body = "See `references/api.md`.";
    const existsAtRepoRoot = (p: string): boolean =>
      p === resolve(REPO_ROOT, "references/api.md");
    expect(
      skillResourceIssues(body, SKILL_DIR, {
        existsSync: existsAtRepoRoot,
        repoRoot: REPO_ROOT,
        sharedDirs: ["scripts"], // references NOT declared shared
      }),
    ).toMatchObject([
      { ref: "references/api.md", resolution: "repo-root-only" },
    ]);
  });
});

describe("skillResourceIssues — a link's TEXT is not a reference (dogfood 2026-08-17)", () => {
  it("does not flag a code span inside a link's text when the DESTINATION resolves", () => {
    // microsoft/power-platform-skills: the destination is 23KB and present in a
    // sibling skill; the backtick span is the label for it. Reported as a
    // missing bundled resource — an accusation against a correct link.
    const body =
      "See [`references/api.md` § Lookups](../b/references/api.md#lookups) for the pattern.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("does not flag it even when the destination is one this detector skips", () => {
    // rohitg00/pro-workflow: `[`references/models-2026.md`](../../references/models-2026.md)`.
    // The `../` destination is deliberately out of scope (it leaves the skill
    // dir), and "out of scope" must mean silence, not fall back to the label.
    const body =
      "See [`references/models-2026.md`](../../references/models-2026.md) for prices.";
    expect(run(body, existsOnly())).toEqual([]);
  });

  it("STILL flags a bare inline bundle path that is not inside any link", () => {
    // The other half. Without this the fix above is indistinguishable from
    // deleting the inline-path check.
    const found = run("Run `scripts/missing.sh` first.", existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ref: "scripts/missing.sh", kind: "path" });
  });

  it("STILL flags a link whose destination is a missing bundled file", () => {
    const found = run("Read [the API](references/api.md) now.", existsOnly());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ref: "references/api.md", kind: "link" });
  });

  it("does not read link syntax that lives inside a code span", () => {
    // rsmdt/the-startup documents a checklist FORMAT; there is no link on the
    // line, and `phase-N.md` is a metavariable that will never exist.
    const body = "Parse lines matching: `- [ ] [Phase N: Title](phase-N.md)`";
    expect(run(body, existsOnly())).toEqual([]);
  });
});

describe("lineOffset (#206)", () => {
  // `markdownRefs` counts from one over the string it is given. The scanner
  // strips frontmatter before calling, so without an offset every coordinate is
  // short by exactly that block.
  const body = ["# demo", "", "Read [the API](references/api.md) now."].join(
    "\n",
  );

  it("reports the body-relative line when no offset is given", () => {
    const found = run(body, existsOnly());
    expect(found[0]?.line).toBe(3);
  });

  it("adds the offset so the line names the real file", () => {
    const found = skillResourceIssues(body, SKILL_DIR, {
      existsSync: existsOnly(),
      lineOffset: 5,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(8);
  });
});

describe("repoRootOnlyAdvice (#382)", () => {
  const note = (resolved: string): SkillResourceFinding<"repo-root-only"> => ({
    ref: resolved,
    resolved,
    kind: "path",
    line: 1,
    resolution: "repo-root-only",
  });

  it("names the top-level dir to declare in sharedDirs when the path has one", () => {
    expect(repoRootOnlyAdvice(note("scripts/lint/check.sh"))).toBe(
      "resolves only from the repo root, not from the skill directory — it breaks once the skill is installed outside this repository. " +
        'If repo-root resolution is intended, add "scripts" to sharedDirs in .vigilesrc.json.',
    );
  });

  it("suggests shipping the file beside the SKILL.md when there is no dir to declare", () => {
    // sharedDirs takes a directory name; a bare root file has none.
    expect(repoRootOnlyAdvice(note("guide.md"))).toMatch(
      /Ship it beside the SKILL\.md if the skill is meant to be installed elsewhere\.$/,
    );
    expect(repoRootOnlyAdvice(note("guide.md"))).not.toMatch(/sharedDirs/);
  });
});
