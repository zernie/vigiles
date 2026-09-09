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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
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

describe("no root test reads a file under site/ (#219)", () => {
  // 🔴 THE INVARIANT THE FILTER RESTS ON, now checked instead of asserted in a
  // comment. `root` goes false for a site-only diff, which is only safe while
  // nothing outside site/ reads anything inside it. That was untrue TWICE:
  // src/core/linter-contract.test.ts read two site files off disk (#219 deleted
  // one in a site-only PR, the root jobs were skipped, and main went red on an
  // ENOENT behind a green merge), and src/comparison-snapshot.test.ts read the
  // /comparison snapshot the same way. The snapshot now lives at the root and
  // the site imports it via the `@measured/…` alias — the dependency points the
  // other way, so a site-only diff cannot break a root test.
  //
  // ⚠️ WHY THIS IS NODE AND NOT `grep`. The first version shelled out to
  // `grep -rlE 'resolve\([^)]*"\.\./\.\./site/'` and MISSED the second
  // instance for two independent reasons, either of which alone was enough:
  //   1. grep is LINE-based, and prettier had split the call across lines —
  //      `resolve(` and `"site/…"` are never on one line:
  //          resolve(
  //            __dirname,
  //            "..",
  //            "site/src/comparison/validate-overlap.json",
  //          )
  //   2. the pattern encoded ONE SPELLING of the path (`"../../site/`), so the
  //      same path assembled from separate segments slipped through.
  // Both are the same defect: a guard written from the spelling its author had
  // just deleted, rather than from the shape it means to forbid. Reading the
  // file and matching the whole CALL removes both.
  const CALLS =
    /\b(?:resolve|join|readFileSync|readdirSync|existsSync|statSync)\s*\(([^)]*)\)/gs;
  // 🔴 NOT a pattern over the SPELLING — the path is ASSEMBLED and then judged.
  // Three rounds of review found three spellings this guard did not match
  // (`"../../site/"` vs a literal split across lines vs `"site", "src/foo"` as
  // separate arguments), which is three symptoms of one cause: matching text
  // that LOOKS like a site path instead of deciding whether the call resolves
  // under site/. Joining the literal segments in order removes the whole class —
  // however the author breaks the path up, the join puts it back together.
  //
  // What stays out of scope on purpose: an argument that is not a literal
  // (`resolve(dir, name)`), which no static check can resolve. That is the
  // honest limit, and it is narrow — a test reads a fixture by writing its path.
  /** Module specifiers — `from "…"`, `import("…")`, `require("…")`. */
  const SPECIFIERS =
    /\bfrom\s*["'`]([^"'`]+)["'`]|\b(?:import|require)\(\s*["'`]([^"'`]+)["'`]/g;
  const literalsOf = (args: string): string[] =>
    [...args.matchAll(/"([^"]*)"|'([^']*)'|`([^`\\$]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? "",
    );
  /** A `site` PATH SEGMENT — not the substring, so `website/` never matches. */
  const UNDER_SITE = /(?:^|\/)site(?:\/|$)/;
  const readsSite = (args: string): boolean =>
    UNDER_SITE.test(literalsOf(args).join("/"));

  const filesUnder = (dir: string, exts: readonly string[]): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? filesUnder(join(dir, e.name), exts)
            : exts.some((x) => e.name.endsWith(x))
              ? [join(dir, e.name)]
              : [],
        )
      : [];

  // 🔴 THE ROOTS ARE DERIVED, NOT LISTED. The first version walked `src/` only,
  // and Codex pointed out that the root `unit` project also runs
  // `scripts/**/*.test.ts` and `eslint-rules/**/*.test.ts` — a site read in
  // either was invisible to the guard while still being skipped by a site-only
  // diff. Naming those two directories here would fix today and rot on the next
  // glob someone adds, which is the same defect a third time in this one file
  // (a spelling remembered instead of a rule read). So the scan takes the unit
  // project's OWN include list, the way `patternFor` takes the classifier's own
  // patterns out of ci.yml.
  const REPO = resolve(__dirname, "..");

  /**
   * WHICH FILES THE SKIPPED ROOT JOBS ACTUALLY RUN — read out of the configs, in
   * full. Three rounds of review each found the scan short of the real suite (it
   * walked `src/` only; then only the vitest `unit` project; then only `.ts`),
   * and each time the answer was sitting in a config file. So every `include`
   * glob in vitest.config.mjs AND jest's `testMatch` is parsed, and BOTH halves
   * of each glob are used: its leading directory says where to walk, its
   * extension says what counts as a file there. Hard-coding either is what put
   * the vitest `test/runners` runners and the Jest `.cjs` ones outside the scan.
   */
  function rootSuiteGlobs(): string[] {
    const read = (f: string): string => readFileSync(resolve(REPO, f), "utf8");
    const globs = [
      ...read("vitest.config.mjs").matchAll(/"([^"\n]*\*[^"\n]*)"/g),
      ...read("jest.config.cjs").matchAll(/"([^"\n]*\*[^"\n]*)"/g),
    ]
      .map((m) => m[1].replace("<rootDir>/", ""))
      // `exclude:` lists the same globs as `include:`; a glob appearing only as
      // an exclusion still names a real directory, so over-scanning is safe and
      // under-scanning is the bug. Keep them all.
      // A glob with no directory prefix (`**/node_modules/**` from vitest's
      // default excludes) names no place to walk.
      .filter((g) => !g.startsWith("**/"));
    if (globs.length === 0)
      throw new Error(
        "no test globs found in vitest.config.mjs / jest.config.cjs — the root " +
          "suite was restructured and this guard can no longer see what it must cover",
      );
    return [...new Set(globs)];
  }

  it("finds no site dependency in ANY file the root suite runs", () => {
    const globs = rootSuiteGlobs();
    // Sanity on the DERIVATION itself — a guard whose scan quietly resolves to
    // nothing reports a clean repo forever. So the parse must yield the two
    // things it claims (a directory that exists, an extension) for every glob.
    //
    // ⚠️ Deliberately NO assertion on the COUNT of globs: narrowing the root
    // suite is a legitimate change, and a guard that goes red on a legitimate
    // change is a guard someone deletes.
    const scanned = globs.map((g) => ({
      dir: g.split("/**")[0],
      ext: extname(g),
    }));
    for (const { dir, ext } of scanned) {
      expect(existsSync(resolve(REPO, dir))).toBe(true);
      expect(ext).not.toBe("");
    }
    expect(scanned.map((x) => x.dir)).toContain("src");

    const files = [
      ...new Set(
        scanned.flatMap(({ dir, ext }) =>
          filesUnder(resolve(REPO, dir), [ext]),
        ),
      ),
    ];
    // The scan must find SOMETHING, or an empty walk reads as a clean repo.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      // THIS file is the one place violation-SHAPED strings are legal: the table
      // below reproduces every spelling review has caught, so the guard can
      // never narrow back to one of them. Excluding it costs nothing — it reads
      // ci.yml and the test configs, nothing under site/.
      .filter((f) => !f.endsWith("ci-path-filter.test.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          [...src.matchAll(CALLS)].some(([, args]) => readsSite(args)) ||
          // A STATIC OR DYNAMIC IMPORT is the other way to depend on a site
          // file, and it is not a call to any of the names above:
          //   import snapshot from "../../site/fixture.json"
          // Caught 2026-09-09 by review, after four rounds spent on the call
          // form alone. Same verdict function, different channel.
          [...src.matchAll(SPECIFIERS)].some(([, ...g]) =>
            UNDER_SITE.test(g.find((x) => x !== undefined) ?? ""),
          )
        );
      });
    // A site assertion belongs in the site suite, where the site job runs it.
    expect(offenders).toEqual([]);
  });

  // EVERY spelling review has caught, kept as a table so the guard can never
  // narrow back to one of them. Each row is a shape that was, at some point,
  // invisible to a version of this check.
  it.each([
    [
      "single line",
      'const p = resolve(__dirname, "../../site/src/lib/linters.ts");',
      true,
    ],
    [
      "split across lines by prettier",
      [
        "const SNAPSHOT = resolve(",
        "  __dirname,",
        '  "..",',
        '  "site/src/comparison/validate-overlap.json",',
        ");",
      ].join("\n"),
      true,
    ],
    [
      "site as its OWN argument",
      'const p = resolve(__dirname, "..", "site", "src/foo.ts");',
      true,
    ],
    [
      "join, not resolve",
      'const p = join(ROOT, "site", "package.json");',
      true,
    ],
    ["read directly", 'const s = readFileSync("site/src/x.ts", "utf8");', true],
    // …and the shapes that must STAY legal, or the guard gets switched off.
    [
      "bare test data the classifier is FED, not a read",
      'const siteOnly = ["site/src/App.tsx", "site/package.json"];',
      false,
    ],
    [
      "a substring that is not a path segment",
      'const p = resolve(ROOT, "website", "index.html");',
      false,
    ],
    ["an ordinary read of a root file", 'readFileSync(CI, "utf8");', false],
  ])("%s", (_name, source, expected) => {
    expect(
      [...source.matchAll(CALLS)].some(([, args]) => readsSite(args)),
    ).toBe(expected);
  });
});
