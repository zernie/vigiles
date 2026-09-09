/**
 * The `changes` job's path classifier — tested against the REAL patterns in ci.yml.
 *
 * ── WHY THIS HAS A TEST AT ALL ──────────────────────────────────────────────────
 * A job that is SKIPPED and a job that PASSED render identically in the checks
 * list: both are a tick, neither is red. So a wrong filter does not announce
 * itself — it produces a green PR over work nobody did, and the only way to notice
 * is to already suspect it. That is the same failure mode as an advisory hook whose
 * success state is silence, and it gets the same treatment: assert both directions.
 *
 * The patterns are EXTRACTED FROM THE WORKFLOW rather than restated here. A copy
 * would drift, and a test that agrees with its own copy of the rule proves nothing
 * about the rule that runs.
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
import ts from "typescript";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const CI = resolve(__dirname, "..", ".github", "workflows", "ci.yml");

/** Pull the ERE out of `if echo "$files" | grep -qvE '<pattern>'; then <name>=true`. */
function patternFor(flag: "root" | "site"): string {
  const yml = readFileSync(CI, "utf8");
  const re = new RegExp(`grep -qvE '([^']+)'; then ${flag}=true`);
  const m = re.exec(yml);
  if (m === null)
    throw new Error(
      `no grep line for \`${flag}\` in ci.yml — the classifier was renamed or ` +
        `restructured, and this test can no longer see the rule it is asserting`,
    );
  // A YAML block scalar is literal, so the pattern reaches grep exactly as written
  // here — no unescaping step, and none is wanted: adding one would silently
  // rewrite the rule before asserting on it.
  return m[1];
}

/** Re-run the workflow's own decision: `grep -qvE` succeeds ⇒ the flag is true. */
function decide(flag: "root" | "site", files: readonly string[]): boolean {
  try {
    execFileSync("grep", ["-qvE", patternFor(flag)], {
      // Faithful to the shell: an empty list is an empty stream, not a blank line.
      input: files.length > 0 ? files.join("\n") + "\n" : "",
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

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

  it("an empty diff is not a licence to skip", () => {
    // The workflow bails to true before reaching grep when the list is empty; this
    // pins the reason rather than the branch — grep -qv over nothing finds no
    // non-matching line, so the pattern alone would say `false` for BOTH flags.
    expect(decide("root", [])).toBe(false);
    expect(decide("site", [])).toBe(false);
    const yml = readFileSync(CI, "utf8");
    expect(yml).toMatch(/if \[ -z "\$files" \]; then\n\s+echo "root=true"/);
    expect(yml).toMatch(/running everything/);
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
    // The specifier is COMPUTED, not a literal: a literal `.mjs` import is a
    // tsc error here (TS7016 — no declaration file), and shipping a .d.ts for a
    // config would be ceremony around a value we only want to read.
    // The FILENAME is discovered, not spelled. `vitest.config.mjs` is plain JS
    // while `site/vitest.config.ts` is TypeScript — an inconsistency, not a
    // constraint (vitest accepts either; measured 2026-09-09). Whoever settles
    // that should not have to remember this guard.
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
