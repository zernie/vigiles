/**
 * The `changes` job's path classifier — tested against the REAL filters in ci.yml.
 *
 * ── WHY THIS HAS A TEST AT ALL ──────────────────────────────────────────────────
 * A job that is SKIPPED and a job that PASSED render identically in the checks
 * list: both are a tick, neither is red. So a wrong filter does not announce
 * itself — it produces a green PR over work nobody did, and the only way to notice
 * is to already suspect it. That is the same failure mode as an advisory hook whose
 * success state is silence, and it gets the same treatment: assert both directions.
 *
 * The filters are EXTRACTED FROM THE WORKFLOW rather than restated here. A copy
 * would drift, and a test that agrees with its own copy of the rule proves nothing
 * about the rule that runs.
 *
 * ── WHAT CHANGED 2026-09-09 ─────────────────────────────────────────────────────
 * The classifier was a hand-written shell script; it is now `dorny/paths-filter`.
 * So this file can no longer re-run the rule by shelling out to `grep` with the
 * workflow's own pattern. It does the nearest honest thing instead: it reads the
 * filters with a YAML parser and evaluates them with the SAME matcher library the
 * action uses (picomatch), through a transcription of the action's own predicate.
 *
 * That transcription is the one copied thing here, and its risk is named: if the
 * action changes how it combines patterns, this file agrees with the old rule. Two
 * things bound that risk — the action version is PINNED (`@v4.0.3`, not a floating
 * major), and the setting the predicate depends on is asserted separately below,
 * because it is the one whose absence inverts the result in silence.
 */
import { describe, it, expect } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import yaml from "js-yaml";
import picomatch from "picomatch";
import ts from "typescript";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CI = resolve(__dirname, "..", ".github", "workflows", "ci.yml");

interface Step {
  uses?: string;
  with?: Record<string, string>;
}

/** The `dorny/paths-filter` step the `changes` job actually declares. */
function filterStep(): { version: string; with: Record<string, string> } {
  const wf = yaml.load(readFileSync(CI, "utf8")) as {
    jobs?: { changes?: { steps?: Step[] } };
  };
  const step = (wf.jobs?.changes?.steps ?? []).find((x) =>
    (x.uses ?? "").startsWith("dorny/paths-filter@"),
  );
  if (step?.uses === undefined || step.with === undefined)
    throw new Error(
      "no `dorny/paths-filter` step with a `with:` block in the `changes` job — " +
        "the classifier was replaced, and this test can no longer see the rule " +
        "it is asserting",
    );
  return { version: step.uses.split("@")[1], with: step.with };
}

/** The `permissions:` the `changes` job declares for itself. */
function changesPermissions(): Record<string, string> {
  const wf = yaml.load(readFileSync(CI, "utf8")) as {
    jobs?: { changes?: { permissions?: Record<string, string> } };
  };
  return wf.jobs?.changes?.permissions ?? {};
}

/** The filters, parsed out of the step's YAML block scalar. */
function filters(): Record<string, string[]> {
  return yaml.load(filterStep().with["filters"] ?? "") as Record<
    string,
    string[]
  >;
}

/**
 * The action's OWN `some-with-excludes` predicate, transcribed from
 * `paths-filter/src/filter.ts` @v4.0.3, including its picomatch options:
 *
 *   const MatchOptions = { dot: true }
 *   const includes = matchers.filter(m => !m.state.negated)
 *   const excludes = matchers.filter(m =>  m.state.negated)
 *   isExclude = str => excludes.some(m => !m(str))   // un-invert picomatch
 *   // included by >=1 pattern AND excluded by 0
 *
 * `dot: true` is not a detail: without it `**` would not match `.claude/…`, and an
 * agent-config-only diff would set root=false and skip the root jobs in silence.
 */
function fileMatches(file: string, patterns: readonly string[]): boolean {
  const matchers = patterns.map((p) => picomatch(p, { dot: true }, true));
  const excluded = matchers
    .filter((m) => m.state.negated)
    .some((m) => !m(file));
  if (excluded) return false;
  return matchers.filter((m) => !m.state.negated).some((m) => m(file));
}

/** A filter is true when ANY changed file matches it. */
function decide(flag: "root" | "site", files: readonly string[]): boolean {
  const patterns = filters()[flag];
  if (patterns === undefined)
    throw new Error(`the \`changes\` job declares no \`${flag}\` filter`);
  return files.some((f) => fileMatches(f, patterns));
}

describe("the changes job is wired to the action, not to a hand-rolled rule", () => {
  it("pins the action to an exact version, not a floating major", () => {
    // The transcribed predicate above is only safe against a pinned version: a
    // floating `@v4` could change how patterns combine and leave this file
    // agreeing with a rule that no longer runs.
    expect(filterStep().version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("declares predicate-quantifier: some-with-excludes", () => {
    // 🔴 THE SETTING WHOSE ABSENCE INVERTS THE RESULT, SILENTLY. The default is
    // `some`, i.e. `patterns.some(...)` — under it a file under site/ matches the
    // `'**'` pattern and sets root=true for a site-only diff, which is the exact
    // hole the filter exists to prevent. Asserted separately from the behaviour
    // below because the behaviour is checked through a transcription of the
    // predicate this setting selects, so it cannot catch its own absence.
    expect(filterStep().with["predicate-quantifier"]).toBe(
      "some-with-excludes",
    );
  });

  it("declares both flags the dependent jobs read", () => {
    expect(Object.keys(filters()).sort()).toEqual(["root", "site"]);
  });

  it("grants itself BOTH permissions it uses, not one of them", () => {
    // A job-level `permissions:` block REPLACES the default rather than adding
    // to it, so this is a pair or it is a break, and each half fails a DIFFERENT
    // way — which is why both are asserted rather than just the one the action's
    // README names:
    //
    //   contents: read       the `push` path checks out and diffs with git
    //   pull-requests: read  the `pull_request` path calls pulls.listFiles (REST)
    //
    // Without the block at all the job inherits the repository default, which
    // supplies both today. That is a default we do not control: a top-level
    // `permissions:` added later — the standard hardening step — would silently
    // take one away, and the first sign would be every PR blocked on a 403.
    expect(changesPermissions()).toMatchObject({
      contents: "read",
      "pull-requests": "read",
    });
  });
});

// The actual diff of PR #167, the change that exposed the missing filter.
const PR167 = [
  ".github/workflows/ci.yml",
  ".vigiles/generated.d.ts",
  "CLAUDE.md",
  "CLAUDE.md.spec.ts",
  "docs/comparison.md",
  "docs/rules/doc-refs.md",
  "docs/verifying-instruction-files.md",
  "src/cli.test.ts",
  "src/cli.ts",
  "src/core/doc-refs.ts",
  "src/core/rule-meta.ts",
  "src/core/types.ts",
  "src/core/validate.test.ts",
  "src/core/validate.ts",
  "src/doc-refs-rule.test.ts",
  "src/setup-plan.ts",
];

describe("the changes job classifies a diff", () => {
  it("runs everything for a normal src change", () => {
    expect(decide("root", ["src/cli.ts"])).toBe(true);
    expect(decide("site", ["src/cli.ts"])).toBe(true);
  });

  it("skips the site for a prose-only change", () => {
    const prose = ["docs/rules/doc-refs.md", "CLAUDE.md", "README.md"];
    expect(decide("site", prose)).toBe(false);
    // …but the root jobs still run: cli-lint, doc-command-coverage and
    // self-command-refs all READ docs, so prose is a real input to them.
    expect(decide("root", prose)).toBe(true);
  });

  it("skips the site for an agent-config-only change", () => {
    expect(decide("site", [".claude/skills/strengthen/SKILL.md"])).toBe(false);
    expect(decide("root", [".claude/skills/strengthen/SKILL.md"])).toBe(true);
  });

  it("skips the root jobs for a site-only change, and runs the site", () => {
    const siteOnly = ["site/src/App.tsx", "site/package.json"];
    expect(decide("root", siteOnly)).toBe(false);
    expect(decide("site", siteOnly)).toBe(true);
  });

  it("runs BOTH for a mixed diff — one non-prose file is enough", () => {
    expect(decide("root", PR167)).toBe(true);
    expect(decide("site", PR167)).toBe(true);
  });

  it("a markdown file NESTED in src is not prose to this filter", () => {
    // The prose arm anchors root-level `*.md` only (`[^/]*\.md$`). A markdown
    // fixture under src/ is test data, and test data changes what tests do.
    expect(decide("site", ["src/fixtures/CLAUDE.md"])).toBe(true);
  });

  it("an empty diff matches nothing — and that is not the fallback", () => {
    // With no changed files there is nothing to match, so both flags are false.
    // That is trivially right: a run with an empty diff has nothing to check.
    //
    // ⚠️ WHAT THIS DOES NOT COVER, stated so nobody reads it as the safety net.
    // The dangerous case is not "no files" but "the diff could not be
    // DETERMINED", and that case now belongs to the action: it documents that
    // "all files are considered as added if there is no common ancestor with base
    // branch or no previous commit", i.e. a new branch or a shallow history runs
    // EVERYTHING. The hand-rolled classifier had to spell that fallback out in
    // shell (empty list · failed `gh api` · a push whose `before` is all zeros);
    // dropping those branches is most of why the action is worth adopting, and it
    // is also why this file can no longer assert them — they are not ours.
    expect(decide("root", [])).toBe(false);
    expect(decide("site", [])).toBe(false);
  });
});

describe("no root test depends on a file under site/ (#219)", () => {
  // 🔴 THE INVARIANT THE FILTER RESTS ON, checked instead of asserted in a
  // comment. `root` goes false for a site-only diff, which is only safe while
  // nothing outside site/ depends on anything inside it. That was untrue twice:
  // src/core/linter-contract.test.ts read two site files off disk (#219 deleted
  // one in a site-only PR, the root jobs were skipped, and main went red on an
  // ENOENT behind a green merge), and src/comparison-snapshot.test.ts read the
  // /comparison snapshot the same way. The snapshot now lives at the root and
  // the site imports it via the `@measured/…` alias — the dependency points the
  // other way, so a site-only diff cannot break a root test.
  //
  // ── WHY A PARSER, AND WHY THIS COST FIVE ROUNDS OF REVIEW ──────────────────
  // Every earlier version matched TEXT. Review found five spellings it missed,
  // one per round: `"../../site/"` only · a call prettier split across lines ·
  // `"site"` as its own argument · a static import (not a call at all) · files
  // whose extension the walk never took. Each fix was a wider pattern, i.e. a
  // sixth spelling waiting to be found.
  //
  // They are one defect: a regex over source text does not know what a call IS.
  // This repo already forbids exactly that — `parse-structured-input-with-a-real
  // -parser` in CLAUDE.md, the rule that routed five markdown detectors onto one
  // markdown-it oracle for the same reason. TypeScript is already a runtime
  // dependency and `src/core/compile-generator.ts` already parses with it.
  //
  // What the AST buys that no pattern could:
  //   · a call is a CallExpression however it is formatted or split;
  //   · a string inside a comment, or a code sample inside a string literal, is
  //     not a call — so the table below needs no escaping and this file needs no
  //     self-exclusion, which the text version did require;
  //   · imports are their own node kind, found by asking rather than by adding
  //     another alternation.
  const PATH_CALLS = new Set([
    "resolve",
    "join",
    "readFileSync",
    "readdirSync",
    "existsSync",
    "statSync",
    "readFile",
  ]);

  /** Is this path under `site/`? Segment-wise, so `website/` is not a match. */
  const underSite = (p: string): boolean => p.split("/").includes("site");

  /** The path a call assembles from its LITERAL arguments, in order. */
  const literalPath = (args: readonly ts.Expression[]): string =>
    args
      .filter((a): a is ts.StringLiteralLike => ts.isStringLiteralLike(a))
      .map((a) => a.text)
      .join("/");

  function dependsOnSite(file: string): boolean {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      // `import x from "…"`, `export … from "…"` — a module specifier is a
      // dependency exactly like a read, and is not a call.
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(n.moduleSpecifier) &&
        underSite(n.moduleSpecifier.text)
      )
        hit = true;
      else if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : "";
        const isModuleLoad =
          callee.kind === ts.SyntaxKind.ImportKeyword || name === "require";
        if (
          (isModuleLoad || PATH_CALLS.has(name)) &&
          underSite(literalPath(n.arguments))
        )
          hit = true;
      }
      if (!hit) ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
    return hit;
  }

  const REPO = resolve(__dirname, "..");

  /**
   * WHICH FILES THE SKIPPED ROOT JOBS ACTUALLY RUN — READ, not parsed. The
   * configs are modules; importing them yields the include globs as real arrays,
   * so there is nothing to pattern-match and nothing to get wrong. The version
   * before this one regexed the config text and its `[^"]*` ran through
   * newlines, swallowing a 14-line comment as one absurd "glob".
   *
   * Both halves of each glob matter: the leading directory says where to walk,
   * the extension says what counts as a file there. Hard-coding either is what
   * put the vitest and Jest runner suites outside the scan.
   */
  async function rootSuiteGlobs(): Promise<string[]> {
    // The FILENAME is discovered, not spelled, and that is what let the config
    // be renamed `.mjs` -> `.ts` (2026-09-10) without touching this guard —
    // which was the point of writing it this way one day earlier.
    // The specifier stays COMPUTED rather than a literal import: it is what
    // makes the discovery meaningful, and it also sidesteps TS7016 for any
    // future non-TS config here.
    const cfgName = readdirSync(REPO).find((f) =>
      f.startsWith("vitest.config."),
    );
    if (cfgName === undefined)
      throw new Error("no vitest.config.* at the repo root");
    const mod: unknown = await import(
      pathToFileURL(resolve(REPO, cfgName)).href
    );
    const jest: unknown = createRequire(resolve(REPO, "package.json"))(
      "./jest.config.cjs",
    );
    // Parse, don't validate — narrow the two `unknown`s ONCE, here, and hand
    // typed values inward. A shape that stops matching fails loudly below
    // (`globs.length === 0`) rather than yielding an empty scan.
    const strings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const asRecord = (v: unknown): Record<string, unknown> =>
      typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

    const projects = asRecord(asRecord(asRecord(mod)["default"])["test"])[
      "projects"
    ];
    const fromVitest = (Array.isArray(projects) ? projects : []).flatMap((p) =>
      strings(asRecord(asRecord(p)["test"])["include"]),
    );
    const fromJest = strings(asRecord(jest)["testMatch"]).map((g) =>
      g.replace("<rootDir>/", ""),
    );

    const globs = [...fromVitest, ...fromJest];
    if (globs.length === 0)
      throw new Error(
        "no test globs in the vitest / jest configs — the root suite " +
          "was restructured and this guard can no longer see what it must cover",
      );
    return [...new Set(globs)];
  }

  const filesUnder = (dir: string, ext: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? filesUnder(join(dir, e.name), ext)
            : e.name.endsWith(ext)
              ? [join(dir, e.name)]
              : [],
        )
      : [];

  it("finds no site dependency in ANY file the root suite runs", async () => {
    const globs = await rootSuiteGlobs();
    const scanned = globs.map((g) => ({
      dir: g.split("/**")[0],
      ext: extname(g),
    }));
    // Sanity on the DERIVATION — a scan that quietly resolves to nothing reports
    // a clean repo forever. ⚠️ Deliberately NO assertion on the COUNT: narrowing
    // the root suite is a legitimate change, and a guard that goes red on a
    // legitimate change is a guard someone deletes.
    for (const { dir, ext } of scanned) {
      expect(existsSync(resolve(REPO, dir))).toBe(true);
      expect(ext).not.toBe("");
    }
    expect(scanned.map((x) => x.dir)).toContain("src");

    const files = [
      ...new Set(
        scanned.flatMap(({ dir, ext }) => filesUnder(resolve(REPO, dir), ext)),
      ),
    ];
    expect(files.length).toBeGreaterThan(0);

    // A site assertion belongs in the site suite, where the site job runs it.
    expect(files.filter(dependsOnSite)).toEqual([]);
  });

  // EVERY spelling review has caught, plus the shapes that must stay legal. With
  // a parser these are just source strings — no escaping, no self-exclusion.
  it.each([
    [
      "single line",
      'resolve(__dirname, "../../site/src/lib/linters.ts");',
      true,
    ],
    [
      "split across lines by prettier",
      'resolve(\n  __dirname,\n  "..",\n  "site/src/x.json",\n);',
      true,
    ],
    [
      "site as its OWN argument",
      'resolve(__dirname, "..", "site", "x.ts");',
      true,
    ],
    ["join, not resolve", 'join(ROOT, "site", "package.json");', true],
    ["read directly", 'readFileSync("site/src/x.ts", "utf8");', true],
    ["static import", 'import s from "../site/fixture.json";', true],
    ["dynamic import", 'await import("../site/fixture.json");', true],
    ["require", 'require("../site/fixture.json");', true],
    // …and what must STAY legal, or the guard gets switched off.
    [
      "bare test data the classifier is FED, not a read",
      'const siteOnly = ["site/src/App.tsx", "site/package.json"];',
      false,
    ],
    [
      "a substring that is not a path segment",
      'resolve(ROOT, "website");',
      false,
    ],
    ["an ordinary read of a root file", 'readFileSync(CI, "utf8");', false],
    // The two a TEXT match could never get right, and the reason this is a parser:
    [
      "a site path inside a COMMENT",
      '// resolve(__dirname, "../site/x.ts")',
      false,
    ],
    [
      "a site path inside a STRING, not a call",
      "const sample = 'resolve(__dirname, \"../site/x.ts\")';",
      false,
    ],
  ])("%s", (_name, source, expected) => {
    const f = join(tmpdir(), `vigiles-guard-${String(Math.random())}.ts`);
    writeFileSync(f, source);
    try {
      expect(dependsOnSite(f)).toBe(expected);
    } finally {
      rmSync(f, { force: true });
    }
  });
});
