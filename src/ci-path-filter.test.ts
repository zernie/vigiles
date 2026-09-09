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
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  // A `site/` PATH SEGMENT inside a string literal — quoted, so the bare test
  // data at the top of this file (`["site/src/App.tsx", …]`, which the
  // classifier is FED rather than reads) stays legal. That distinction is
  // measured, not assumed: forbidding the mere mention of `site/` under src/
  // fires on 3 legitimate fixtures today, and a guard with false positives is
  // switched off, which is how the first hole survived.
  // NB the shape: quote, then an OPTIONAL prefix that must end in a slash. The
  // first attempt wrote `(?:^|\/)` for "start of the literal, or a slash" — but
  // `^` anchors to the start of the whole ARGUMENT STRING, not to the position
  // after the quote, so it never matched a literal that was not the first thing
  // in the call. Its own fixture caught it.
  const SITE_LITERAL = /["'`](?:[^"'`]*\/)?site\//;

  const tsFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? tsFiles(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );

  it("finds no disk read of site/ anywhere under src/", () => {
    const offenders = tsFiles(__dirname)
      // THIS file is the one place a violation-SHAPED string is legal: the
      // fixture below reproduces the exact call the old grep guard missed, so
      // the guard can never narrow back to a single-line spelling. Excluding it
      // costs nothing — it reads ci.yml and nothing under site/.
      .filter((f) => !f.endsWith("ci-path-filter.test.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return [...src.matchAll(CALLS)].some(([, args]) =>
          SITE_LITERAL.test(args),
        );
      });
    // A site assertion belongs in the site suite, where the site job runs it.
    expect(offenders).toEqual([]);
  });

  it("catches a site read the OLD grep guard missed (split across lines)", () => {
    // The exact shape of the second instance, kept as a fixture so the guard can
    // never silently narrow back to a single-line spelling.
    const missedBefore = [
      "const SNAPSHOT = resolve(",
      "  __dirname,",
      '  "..",',
      '  "site/src/comparison/validate-overlap.json",',
      ");",
    ].join("\n");
    expect(
      [...missedBefore.matchAll(CALLS)].some(([, args]) =>
        SITE_LITERAL.test(args),
      ),
    ).toBe(true);
    // …and the legal fixture form still passes.
    expect(SITE_LITERAL.test('["site/src/App.tsx", "site/package.json"]')).toBe(
      true,
    );
    expect(
      [...'const siteOnly = ["site/src/App.tsx"];'.matchAll(CALLS)].some(
        ([, args]) => SITE_LITERAL.test(args),
      ),
    ).toBe(false);
  });
});
