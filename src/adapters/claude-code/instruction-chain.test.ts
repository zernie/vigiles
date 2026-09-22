/**
 * Claude Code's instruction chain, against the vendor rules quoted in its own
 * header — one file, one surface.
 *
 * `alwaysLoaded`, the thing this replaced, had ZERO tests: the walk that
 * expanded it could not have one, because the adapter DROVE the walk and there
 * was no input to hand it. That is the shape of the defect as much as the walk
 * itself, so the replacement arrives with its cases stated.
 */
import { describe, it, expect } from "vitest";

import { claudeCodeLayout } from "./layout.js";
import { localSiblingOf } from "./instruction-chain.js";

const chain = (files: Record<string, string>) =>
  claudeCodeLayout.instructionChain(files);
const paths = (files: Record<string, string>) =>
  chain(files).loaded.map((e) => e.path);

describe("what loads, and in what order", () => {
  it("the root file, the dot-dir file, the rules, then the per-machine file LAST", () => {
    // The one ordering fact the vendor states: "CLAUDE.local.md is appended
    // after CLAUDE.md, so your personal notes are the last thing Claude reads
    // at that level."
    expect(
      paths({
        "CLAUDE.md": "root",
        ".claude/CLAUDE.md": "dot",
        ".claude/rules/b.md": "b",
        ".claude/rules/a.md": "a",
        "CLAUDE.local.md": "mine",
      }),
    ).toEqual([
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      ".claude/rules/a.md",
      ".claude/rules/b.md",
      "CLAUDE.local.md",
    ]);
  });

  it("reads the rules dir RECURSIVELY", () => {
    // Vendor: all `.md` files under a rules directory are discovered
    // recursively. The flat classifier this pairs with used to stop at depth 1,
    // so a nested rule was read and classified by nothing.
    expect(paths({ ".claude/rules/team/deep/x.md": "x" })).toEqual([
      ".claude/rules/team/deep/x.md",
    ]);
  });

  it("marks a per-machine file `local`, and everything else `repo`", () => {
    expect(
      chain({ "CLAUDE.md": "a", "CLAUDE.local.md": "b" }).loaded.map((e) => [
        e.role,
        e.scope,
      ]),
    ).toEqual([
      ["root", "repo"],
      ["root-local", "local"],
    ]);
  });

  it("derives the per-machine name from the instruction file", () => {
    expect(localSiblingOf(claudeCodeLayout.instructionFile)).toBe(
      "CLAUDE.local.md",
    );
  });
});

describe("what does NOT load, and why", () => {
  it("a `paths:`-scoped rule is on-demand, not always-loaded", () => {
    const files = {
      ".claude/rules/scoped.md": '---\npaths: ["src/**"]\n---\nbody',
    };
    expect(paths(files)).toEqual([]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "on-demand",
      when: "path-scoped",
    });
  });

  it("a rule with OTHER frontmatter still loads — only `paths:` scopes it", () => {
    expect(paths({ ".claude/rules/x.md": "---\ntitle: x\n---\nbody" })).toEqual(
      [".claude/rules/x.md"],
    );
  });

  it("a subdirectory's CLAUDE.md is reported on-demand when handed over", () => {
    // The bound never enumerates one; a caller with a wider map gets the honest
    // answer rather than silence or a false "always".
    const files = { "CLAUDE.md": "root", "pkg/CLAUDE.md": "nested" };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded).toEqual([
      {
        path: "pkg/CLAUDE.md",
        role: "root",
        scope: "repo",
        reason: { kind: "on-demand", when: "subdirectory" },
      },
    ]);
  });

  it("`claudeMdExcludes` from the repo's own settings removes a file", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/rules/vendor.md": "theirs",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/vendor.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "excluded-by-settings",
      key: "claudeMdExcludes",
      // Committed settings → `repo`. The scope is what keeps a pattern out of
      // the gitignored sibling from lowering the PUBLISHED total; see the
      // measurement on `excluded-by-settings` in core.
      by: ".claude/settings.json",
      byScope: "repo",
    });
  });

  it("the LOCAL settings file can exclude too — advisory, and it can only narrow", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.local.json": JSON.stringify({
        claudeMdExcludes: ["**/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual([]);
  });

  it("an ABSOLUTE-path exclude pattern is not applied, and the file is COUNTED", () => {
    // The vendor matches these against absolute paths; the chain holds
    // repo-relative keys. Guessing a root would be inventing a fact, so the
    // pattern is left unapplied — which OVER-reports. That is the safe
    // direction: an under-report reads as "you are fine".
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["/home/me/repo/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });

  it("an unparseable settings file excludes nothing rather than throwing", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": "{ not json",
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });

  it("a settings file whose excludes key is the wrong TYPE is ignored", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/settings.json": JSON.stringify({ claudeMdExcludes: "**/x.md" }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
  });
});

describe("AGENTS.md — the cross-family switch (vendor, v2.1.277+, read 2026-09-21)", () => {
  // 🔴 THE ROW THIS SUITE IS BUILT FROM. The vendor states the whole rule as a
  // three-row table, and each row below is one of them, verbatim in the name:
  //
  //   | An AGENTS.md, and no CLAUDE.md/CLAUDE.local.md at or above | AGENTS.md |
  //   | An AGENTS.md AND a CLAUDE.md/CLAUDE.local.md at or above   | CLAUDE.md files only |
  //   | A CLAUDE.md that already imports AGENTS.md                 | CLAUDE.md, with AGENTS.md through the import |
  //
  // The rows are mutually exclusive on PRESENCE, which is why this is a switch
  // and not a merge, and why the reason is `superseded` rather than `replaced`.

  it("row 1 — with no CLAUDE.md family at all, both spellings LOAD at session start", () => {
    // "At session start: every `AGENTS.md` and `.claude/AGENTS.md` in your
    // working directory and the directories above it."
    const files = { "AGENTS.md": "shared", ".claude/AGENTS.md": "dot" };
    expect(chain(files).loaded).toEqual([
      { path: "AGENTS.md", role: "root", scope: "repo" },
      { path: ".claude/AGENTS.md", role: "root", scope: "repo" },
    ]);
    expect(chain(files).unloaded).toEqual([]);
  });

  it("row 2 — a CLAUDE.md supersedes it, and the reason NAMES the file that did it", () => {
    const files = { "CLAUDE.md": "root", "AGENTS.md": "shared" };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded).toEqual([
      {
        path: "AGENTS.md",
        role: "root",
        scope: "repo",
        reason: { kind: "superseded", by: "CLAUDE.md", byScope: "repo" },
      },
    ]);
  });

  it("row 2 — `.claude/CLAUDE.md` counts too, on its own", () => {
    // The vendor lists three files, not one, and this is the spelling a reader
    // is most likely to forget: it is not at the repo root.
    const files = { ".claude/CLAUDE.md": "dot", "AGENTS.md": "shared" };
    expect(paths(files)).toEqual([".claude/CLAUDE.md"]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "superseded",
      by: ".claude/CLAUDE.md",
      byScope: "repo",
    });
  });

  it("row 3 — a CLAUDE.md that IMPORTS it still loads it, as an import", () => {
    // "A `CLAUDE.md` that already imports `AGENTS.md`" -> "Your `CLAUDE.md`,
    // with `AGENTS.md` included through the import". This is the idiom four of
    // the six real imports in the measured corpus use, so classifying it as
    // superseded would have deleted a real load AND the redirect finding with
    // it. What makes it come out right is ORDER: the imports pass runs before
    // the supersede verdict.
    const files = { "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "shared" };
    expect(chain(files).loaded).toEqual([
      { path: "CLAUDE.md", role: "root", scope: "repo" },
      {
        path: "AGENTS.md",
        role: "import",
        scope: "repo",
        via: { from: "CLAUDE.md", token: "@AGENTS.md" },
      },
    ]);
    expect(chain(files).unloaded).toEqual([]);
    expect(chain(files).redirects).toEqual([
      { path: "CLAUDE.md", to: ["AGENTS.md"] },
    ]);
  });

  it("a PER-MACHINE CLAUDE.local.md supersedes it — and `byScope` says so", () => {
    // 🔴 THE SENTENCE THAT COSTS A NUMBER: "Because `CLAUDE.local.md` counts,
    // adding one to keep your own uncommitted instructions in a project that
    // relies on `AGENTS.md` stops Claude from reading `AGENTS.md` for you." A
    // gitignored file has changed the MEMBERSHIP of the load — a teammate on
    // this commit loads AGENTS.md and this working copy loads none of it. The
    // weight reads `byScope` to keep both totals right.
    const files = { "CLAUDE.local.md": "mine", "AGENTS.md": "shared" };
    expect(paths(files)).toEqual(["CLAUDE.local.md"]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "superseded",
      by: "CLAUDE.local.md",
      byScope: "local",
    });
  });

  it("a COMMITTED superseder wins over the per-machine one when both exist", () => {
    // 🔴 THE PRECEDENCE RATCHET, and it is not cosmetic: naming the local file
    // here would put AGENTS.md into `committedTotal`, claiming a teammate loads
    // it — but that teammate has the CLAUDE.md, so they do not. The order of
    // the candidate array in `supersederOf` is the whole of this rule.
    const files = {
      "CLAUDE.md": "root",
      "CLAUDE.local.md": "mine",
      "AGENTS.md": "shared",
    };
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "superseded",
      by: "CLAUDE.md",
      byScope: "repo",
    });
  });

  it("`.claude/rules/` does NOT count — it keeps loading ALONGSIDE AGENTS.md", () => {
    // The other half of the vendor's own list ("Don't count, and keep loading
    // alongside `AGENTS.md`"). A reader who added the rules dir to the
    // superseder array would turn AGENTS.md off in every repo that has one.
    expect(
      paths({ ".claude/rules/a.md": "a rule", "AGENTS.md": "shared" }),
    ).toEqual(["AGENTS.md", ".claude/rules/a.md"]);
  });

  it("`@path` imports inside an AGENTS.md are expanded — role-blind, as the vendor says", () => {
    // "Inside each `AGENTS.md`: `@path` imports are expanded". Asserted on an
    // AGENTS.md that got in as a ROOT file, because an import pass keyed on
    // role would pass every CLAUDE.md case and fail exactly this one.
    const files = { "AGENTS.md": "@docs/style.md", "docs/style.md": "prose" };
    expect(paths(files)).toEqual(["AGENTS.md", "docs/style.md"]);
    expect(chain(files).imports).toEqual([
      { path: "docs/style.md", token: "@docs/style.md", from: "AGENTS.md" },
    ]);
  });

  it("an `@AGENTS.local.md` import carries `local` scope — right under both readings", () => {
    // ⏳ ONE OF THE THREE REAL IMPORTS IN THE 214-FILE `AGENTS.md` CORPUS, and
    // it names a file the vendor's "Not read" list refuses. WHETHER THE TOKEN
    // LOADS AT ALL IS OPEN: "Inside each `AGENTS.md`: `@path` imports are
    // expanded" and "Not read: `AGENTS.local.md`…" are peers in one list and
    // neither qualifies the other. Today's behaviour — honoured — is asserted
    // here as behaviour, not as a verdict; see `isNeverRead` for both readings
    // and the one observation that settles them.
    //
    // 🔴 WHAT THIS CASE IS REALLY FOR IS THE SCOPE, which is decidable without
    // settling that. An import inherits the IMPORTER's scope, so a committed
    // `AGENTS.md` naming this file would put a gitignored one into a published
    // `committedTotal` — the browser twin reads a GitHub tree and can never see
    // it, the disagreement `InstructionScope` exists to prevent. Under the
    // other reading the file is never taken and this line cannot fire, so
    // `repo` is wrong either way and `local` is wrong under neither.
    const files = {
      "AGENTS.md": "@AGENTS.local.md",
      "AGENTS.local.md": "mine",
    };
    expect(chain(files).loaded).toEqual([
      { path: "AGENTS.md", role: "root", scope: "repo" },
      {
        path: "AGENTS.local.md",
        role: "import",
        scope: "local",
        via: { from: "AGENTS.md", token: "@AGENTS.local.md" },
      },
    ]);
  });

  it("an import resolves against the IMPORTING file, not the repo root", () => {
    // 🔴 MEASURED, cc 2.1.278, fixture `q3-relative`: `.claude/CLAUDE.md`
    // holding `@notes.md` loads `.claude/notes.md`. The fixture keeps BOTH
    // candidates on disk with different codewords, so "it found nothing" is
    // not an available reading — the model recited SAIGA-8181 (the sibling)
    // and not TAPIR-6262 (the root file), and the hook logged
    // `.claude/notes.md | load_reason: include | parent: .claude/CLAUDE.md`.
    //
    // Resolving against the root is wrong in BOTH directions at once: the
    // sibling is reported unread, and a root file that merely shares its name
    // is charged for its bytes.
    const files = {
      ".claude/CLAUDE.md": "see @notes.md",
      ".claude/notes.md": "the sibling",
      "notes.md": "the root file, which this import does NOT name",
    };
    expect(paths(files)).toEqual([".claude/CLAUDE.md", ".claude/notes.md"]);
    expect(chain(files).loaded[1]).toEqual({
      path: ".claude/notes.md",
      role: "import",
      scope: "repo",
      via: { from: ".claude/CLAUDE.md", token: "@notes.md" },
    });
  });

  it("`@./x` and `@x` are the same file, not two", () => {
    // Without the normalisation the leading `./` survives into the key, so the
    // file is looked up at `./notes.md`, found absent, and reported unread —
    // beside the very file it names.
    const files = { "CLAUDE.md": "see @./notes.md", "notes.md": "prose" };
    expect(paths(files)).toEqual(["CLAUDE.md", "notes.md"]);
    expect(chain(files).imports[0]).toEqual({
      path: "notes.md",
      token: "@./notes.md",
      from: "CLAUDE.md",
    });
  });

  it("an ordinary imported file still inherits the importer's scope", () => {
    // The silent half of the rule above: only a PER-MACHINE NAME overrides the
    // inheritance. A version that made every import `local` would empty
    // `committedTotal` of every imported file and pass the case above.
    const files = { "AGENTS.md": "@docs/style.md", "docs/style.md": "prose" };
    expect(chain(files).loaded.map((e) => e.scope)).toEqual(["repo", "repo"]);
  });

  it("an EXCLUDED CLAUDE.md does NOT supersede — measured, cc 2.1.278", () => {
    // 🔴 THIS ASSERTION USED TO BE PINNED THE OTHER WAY, and the pin said so:
    // two vendor rules meet and the vendor composes neither, so we shipped the
    // literal reading (presence on disk) and wrote down what would settle it —
    // "one session, the documented `AGENTS.md loaded` line, or an
    // `InstructionsLoaded` transcript. Change this expectation only WITH that
    // observation." That observation now exists, and it goes the other way:
    // with the root `CLAUDE.md` excluded, `AGENTS.md` LOADS.
    //
    // Fixtures and the transcripts are in
    // `test/fixtures/instruction-chain-vendor/`; `supersederOf`'s header has
    // the three-row table. The old behaviour UNDER-reported, which is the
    // direction this module's own policy calls wrong — an `AGENTS.md` that
    // really loads was graded at zero bytes.
    const files = {
      "CLAUDE.md": "root",
      "AGENTS.md": "shared",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual(["AGENTS.md"]);
    expect(chain(files).unloaded.map((e) => [e.path, e.reason.kind])).toEqual([
      ["CLAUDE.md", "excluded-by-settings"],
    ]);
  });

  it("a SURVIVING candidate still supersedes, and it is the one named", () => {
    // Fixture c3's SHAPE, and it is what makes the fix a predicate rather than
    // a bypass: one candidate excluded, another surviving. Measured on
    // 2.1.278 — `AGENTS.md` does NOT load while the surviving `CLAUDE.md`
    // does. A version that skipped the supersede check whenever anything was
    // excluded would load `AGENTS.md` here; one that ignored exclusions
    // entirely would name the wrong file in `by`.
    //
    // ⚠️ THE EXCLUDED CANDIDATE IS THE DOT-DIRECTORY ONE, WHICH IS A SWAP OF
    // THE FIXTURE, AND THE REASON IS THE LIMIT ABOVE `compileExcludes`. The
    // vendor matches these globs against ABSOLUTE paths, so the fixture picks
    // the root file out with `**\/<repo-dir>\/CLAUDE.md` — a pattern that
    // cannot match the RELATIVE paths this chain is handed, and which
    // `compileExcludes` therefore reports as unapplied rather than guessing a
    // repo directory name. `**\/.claude\/CLAUDE.md` is the same shape the
    // other way round and IS expressible, so it is what gets asserted.
    const files = {
      "CLAUDE.md": "root",
      ".claude/CLAUDE.md": "gamma",
      "AGENTS.md": "shared",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/.claude/CLAUDE.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded).toContainEqual({
      path: "AGENTS.md",
      role: "root",
      scope: "repo",
      reason: { kind: "superseded", by: "CLAUDE.md", byScope: "repo" },
    });
  });

  it("`claudeMdExcludes` applies to an AGENTS.md too", () => {
    // "…and `claudeMdExcludes` patterns apply". Same argument as above: this is
    // the case a role-keyed exclusion check would miss.
    const files = {
      "AGENTS.md": "shared",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/AGENTS.md"],
      }),
    };
    expect(paths(files)).toEqual([]);
    expect(chain(files).unloaded[0]?.reason).toEqual({
      kind: "excluded-by-settings",
      key: "claudeMdExcludes",
      // Committed settings → `repo`. The scope is what keeps a pattern out of
      // the gitignored sibling from lowering the PUBLISHED total; see the
      // measurement on `excluded-by-settings` in core.
      by: ".claude/settings.json",
      byScope: "repo",
    });
  });

  it("an IMPORTED subdirectory instruction file is LOADED, not on-demand", () => {
    // 🔴 THE REGRESSION THIS PINS. `takeSubdirectories` claims any slash path
    // whose leaf is an instruction name, and `takeImportsOf` skips a path
    // already taken. While the subdirectory pass ran FIRST, a `CLAUDE.md` that
    // the root file literally imports was filed `on-demand/subdirectory` and
    // its bytes left BOTH totals — even though the loader expands it at
    // session start (measured on 2.1.278: an `InstructionsLoaded` entry
    // reading `pkg/CLAUDE.md | load_reason: include | parent_file_path:
    // CLAUDE.md`).
    //
    // Only the LEAF NAME decided it, which is the tell: the same import was
    // reported two different ways depending on what the target was called.
    // `pkg/style.md` — the third case below — was counted all along.
    for (const leaf of ["CLAUDE.md", "AGENTS.md", "style.md"]) {
      const files = {
        "CLAUDE.md": `see @pkg/${leaf}`,
        [`pkg/${leaf}`]: "nested",
      };
      expect(paths(files), leaf).toEqual(["CLAUDE.md", `pkg/${leaf}`]);
      expect(chain(files).loaded[1], leaf).toEqual({
        path: `pkg/${leaf}`,
        role: "import",
        scope: "repo",
        via: { from: "CLAUDE.md", token: `@pkg/${leaf}` },
      });
    }
  });

  it("a subdirectory's AGENTS.md is ON DEMAND — the same treatment a `paths:` rule gets", () => {
    // "As Claude works in subdirectories: a subdirectory's `AGENTS.md`, when
    // Claude opens a file there with the Read tool."
    const files = { "AGENTS.md": "root", "pkg/AGENTS.md": "nested" };
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

  it("`.claude/AGENTS.md` is a ROOT candidate, never a `subdirectory` one", () => {
    // It has a slash and the right leaf name, so the subdirectory pass would
    // claim it if the root pass had not reserved it — and the printed reason
    // would then be "on-demand" for a file that is simply superseded.
    const files = { "CLAUDE.md": "root", ".claude/AGENTS.md": "dot" };
    expect(chain(files).unloaded).toEqual([
      {
        path: ".claude/AGENTS.md",
        role: "root",
        scope: "repo",
        reason: { kind: "superseded", by: "CLAUDE.md", byScope: "repo" },
      },
    ]);
  });

  it.each([
    ["AGENTS.local.md", { "AGENTS.local.md": "x", "pkg/AGENTS.local.md": "y" }],
    [
      "AGENTS.override.md",
      { "AGENTS.override.md": "x", "pkg/AGENTS.override.md": "y" },
    ],
    ["anything under .agents/", { ".agents/AGENTS.md": "x" }],
  ])("does NOT name %s — the vendor's own 'Not read' list", (_name, extra) => {
    // 🔴 `AGENTS.override.md` IS CODEX'S, and this is the assertion that keeps
    // it there: the only executable model of it is `overrideSiblingOf` in
    // `adapters/codex/instruction-chain.ts`. `.agents/AGENTS.md` is the one
    // that would be claimed by accident — it is dot-directory markdown, so the
    // bound really does hand it over, and a leaf-name match would call it
    // "on-demand".
    const files = { "AGENTS.md": "shared", ...extra };
    const c = chain(files);
    const named = [...c.loaded, ...c.unloaded].map((e) => e.path);
    expect(named).toEqual(["AGENTS.md"]);
  });
});

describe("imports: the repo owner names the path, the adapter only finds it", () => {
  it("reports an `@path` token whether or not the file was read", () => {
    expect(chain({ "CLAUDE.md": "see @docs/style.md" }).imports).toEqual([
      { path: "docs/style.md", token: "@docs/style.md", from: "CLAUDE.md" },
    ]);
  });

  it("loads an import that IS in the map — ONE level, not the import of an import", () => {
    // Deliberate: a transitive import is a real feature and is NOT counted. Of
    // 198 real CLAUDE.md files measured, six carried an import at all and every
    // one was a single concrete path at depth 1. See `resolveImports`.
    expect(
      paths({
        "CLAUDE.md": "@docs/a.md",
        "docs/a.md": "@docs/b.md",
        "docs/b.md": "leaf",
      }),
    ).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  it("@AGENTS.md — the shape 4 of those 6 real imports actually have", () => {
    // The workaround written before Claude Code read AGENTS.md natively
    // (anthropics/claude-code#34235; reversed in v2.1.277). It still has to
    // work: the CLAUDE.md beside it SUPPRESSES the AGENTS.md, so the import is
    // the only way that text loads, and dropping it would be an under-report —
    // which reads as "you are fine". The vendor's own table gives this its own
    // row: "A CLAUDE.md that already imports AGENTS.md" -> "Your CLAUDE.md,
    // with AGENTS.md included through the import".
    expect(paths({ "CLAUDE.md": "@AGENTS.md", "AGENTS.md": "shared" })).toEqual(
      ["CLAUDE.md", "AGENTS.md"],
    );
  });

  /**
   * 🔴 THE RATCHET. Every entry below is THE SAME FILE and must be read
   * identically. A pattern anchored at column zero, or an equality against the
   * raw line, answers "not an import" on five of the six and turns nothing red —
   * so a single `@AGENTS.md` case at column zero would prove nothing about the
   * rewrite that breaks them.
   *
   * What makes them pass is that the reading goes through `core/markdown.ts`:
   * CommonMark block parsing strips the indent, normalises CRLF, and drops
   * trailing whitespace and trailing blank lines. The BOM is the one the parser
   * does NOT strip, which is why `proseLines` strips it and why it is listed
   * here rather than assumed.
   */
  it.each([
    ["column zero", "@AGENTS.md"],
    ["indented", "  @AGENTS.md"],
    ["trailing spaces", "@AGENTS.md  "],
    ["CRLF line ending", "@AGENTS.md\r\n"],
    ["UTF-8 BOM", "\uFEFF@AGENTS.md"],
    ["trailing blank lines", "@AGENTS.md\n\n\n"],
    ["after a heading", "# Project\n\n@AGENTS.md\n"],
  ])("recognises the same import written with %s", (_name, body) => {
    expect(chain({ "CLAUDE.md": body }).imports.map((i) => i.path)).toEqual([
      "AGENTS.md",
    ]);
  });

  /**
   * The inverse, and it is measured: a loose `@` over 198 real CLAUDE.md files
   * matches Python decorators, Blade templates, npm scopes and CSS at-rules —
   * every one of them inside a fenced code block. The parser removes those
   * before the pattern runs, which is the reason to parse rather than scan.
   */
  it.each([
    ["a fenced code block", "```py\n@dataclass\nclass X: pass\n```\n"],
    [
      "a four-backtick block holding a bare fence",
      "````\n```\n@media.md\n```\n````\n",
    ],
    ["an inline code span", "use `@config.md` as the example\n"],
    ["an HTML comment", "<!--\n@SECRET.md\n-->\n"],
    ["a bare mention", "ask @zernie about it\n"],
    ["an email address", "write to me@example.com\n"],
    ["frontmatter", '---\nsee: "@SECRET.md"\n---\nbody\n'],
  ])("does NOT read %s as an import", (_name, body) => {
    expect(chain({ "CLAUDE.md": body }).imports).toEqual([]);
  });

  it("refuses a token that leaves the repository", () => {
    expect(
      chain({ "CLAUDE.md": "@../escape.md @~/notes.md @/etc/x.md" }).imports,
    ).toEqual([]);
  });

  it("an import pulled in by the LOCAL file inherits its scope", () => {
    // It is a committed file, but it only loads because a gitignored one names
    // it — so a teammate does not load it, and it must not be in the committed
    // total either.
    const files = {
      "CLAUDE.md": "root",
      "CLAUDE.local.md": "@docs/mine.md",
      "docs/mine.md": "personal",
    };
    expect(chain(files).loaded.map((e) => [e.path, e.scope])).toEqual([
      ["CLAUDE.md", "repo"],
      ["CLAUDE.local.md", "local"],
      ["docs/mine.md", "local"],
    ]);
  });

  it("an excluded import is reported as excluded, not loaded", () => {
    const files = {
      "CLAUDE.md": "@docs/vendor.md",
      "docs/vendor.md": "theirs",
      ".claude/settings.json": JSON.stringify({
        claudeMdExcludes: ["**/vendor.md"],
      }),
    };
    expect(paths(files)).toEqual(["CLAUDE.md"]);
    expect(chain(files).unloaded.map((e) => [e.path, e.role])).toEqual([
      ["docs/vendor.md", "import"],
    ]);
  });
});

describe("a CLAUDE.md that is NOTHING BUT an import is a REDIRECT", () => {
  // 🔴 THE FINDING, NOT THE NUMBER. Four of the six real imports measured are
  // `@AGENTS.md`, written before Claude Code read AGENTS.md natively
  // (anthropics/claude-code#34235; reversed in v2.1.277), and the idiom that
  // follows is a CLAUDE.md holding that one line. Those files did not disappear
  // when the vendor changed, and the CLAUDE.md beside them still suppresses the
  // AGENTS.md — so the redirect is exactly as load-bearing as it was. Reported as a size, such a repo has a fourteen-byte
  // instruction file — a confident wrong answer about a repository that really
  // loads tens of kilobytes.
  it.each([
    ["the bare line", "@AGENTS.md\n"],
    ["indented, CRLF, trailing blanks", "  @AGENTS.md  \r\n\n"],
    [
      "with a maintainer comment above it",
      "<!-- see AGENTS.md -->\n\n@AGENTS.md\n",
    ],
    ["with frontmatter above it", "---\ntitle: pointer\n---\n\n@AGENTS.md\n"],
  ])("is detected when written as %s", (_name, body) => {
    expect(
      chain({ "CLAUDE.md": body, "AGENTS.md": "the real thing" }).redirects,
    ).toEqual([{ path: "CLAUDE.md", to: ["AGENTS.md"] }]);
  });

  it("names EVERY file it points at, not just the first", () => {
    expect(
      chain({
        "CLAUDE.md": "@a.md\n@b.md\n",
        "a.md": "one",
        "b.md": "two",
      }).redirects,
    ).toEqual([{ path: "CLAUDE.md", to: ["a.md", "b.md"] }]);
  });

  // The other half. A rule that fires on a file with real content in it would be
  // worse than no rule: it would be switched off the first week.
  it.each([
    [
      "one line of prose beside the import",
      "@AGENTS.md\n\nAlso: never force-push.\n",
    ],
    ["a heading above it", "# Rules\n\n@AGENTS.md\n"],
    ["no import at all", "Just ordinary instructions.\n"],
    ["an empty file", ""],
    ["frontmatter only", "---\ntitle: x\n---\n"],
  ])("is NOT claimed for a file with %s", (_name, body) => {
    expect(chain({ "CLAUDE.md": body, "AGENTS.md": "real" }).redirects).toEqual(
      [],
    );
  });

  it("is still a redirect when the target is MISSING — that is the worst case, not an exception", () => {
    // 🔴 I ASSERTED THE OPPOSITE FIRST AND THE CODE WAS RIGHT. A pointer at a
    // file that is not there is exactly where a bare size lies hardest: the
    // repository looks like it has a fourteen-byte instruction file AND nothing
    // tells you the thing it points at is gone. Reporting both — "this is a
    // redirect to GONE.md" and "1 named import not read: GONE.md" — is the only
    // output a reader can act on.
    expect(chain({ "CLAUDE.md": "@GONE.md\n" }).redirects).toEqual([
      { path: "CLAUDE.md", to: ["GONE.md"] },
    ]);
  });
});

describe("rules are anchored to THIS harness's directory, not to the word", () => {
  // 🔴 THE MATCHER WAS `(?:^|/)rules/…`, so any path segment spelled `rules`
  // qualified. The bound walks every depth-1 dot-directory's `rules` tree, so
  // `.github/rules/` and `.agents/rules/` — somebody else's tooling — were
  // LOADED and charged to the always-loaded budget, able to push a report over
  // it on bytes the harness never reads. Measured 2026-09-22 before the fix:
  //
  //   loaded: CLAUDE.md · .agents/rules/policy.md · .claude/rules/mine.md
  //                                               · .github/rules/policy.md
  //
  // The loose form is right for SURFACES — `skills/` lives both at a published
  // plugin's root and under `.claude/` — and wrong here, because
  // `PluginLayout.rulesDir` says in prose that rules have exactly one home.
  it("loads its own rules tree and no other directory's", () => {
    const files = {
      "CLAUDE.md": "root",
      ".claude/rules/mine.md": "ours",
      ".claude/rules/nested/deep.md": "ours, recursively",
      ".github/rules/policy.md": "somebody else's",
      ".agents/rules/policy.md": "somebody else's",
      "rules/policy.md": "not a harness directory at all",
    };
    expect(paths(files).sort()).toEqual([
      ".claude/rules/mine.md",
      ".claude/rules/nested/deep.md",
      "CLAUDE.md",
    ]);
  });

  it("keeps the recursion, which is the half the leaf constant already fixed", () => {
    // The anchoring must not quietly re-flatten the tree: a rule in a
    // subdirectory is read by the loader and has to stay classified.
    expect(paths({ ".claude/rules/a/b/c.md": "deep" })).toEqual([
      ".claude/rules/a/b/c.md",
    ]);
  });
});
