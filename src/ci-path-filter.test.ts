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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  // nothing outside site/ reads anything inside it. That was untrue once:
  // src/core/linter-contract.test.ts read two site files off disk, #219 deleted
  // one in a site-only PR, the root jobs were skipped, and main went red on an
  // ENOENT behind a green merge.
  it("finds no disk read of site/ anywhere under src/", () => {
    // ⚠️ `grep -rl` exits 1 when it finds NOTHING, and execFileSync THROWS on a
    // non-zero exit — so the clean case is the throwing one. Read the exit code
    // instead of letting it decide the test: the first version of this guard
    // failed on an empty repo-wide search, i.e. it went red precisely when the
    // property held.
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        ["-rlE", 'resolve\\([^)]*"\\.\\./\\.\\./site/', resolve(__dirname)],
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
      ).trim();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 1) throw e; // 1 = no matches; anything else is a real failure
    }
    // A site assertion belongs in the site suite, where the site job runs it.
    expect(hits).toBe("");
  });
});
