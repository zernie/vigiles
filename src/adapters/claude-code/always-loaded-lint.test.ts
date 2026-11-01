/**
 * The always-loaded check on a Claude Code repository, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): a fixed limit per part decides
 * first, and `.vigiles/baseline.json` decides only what is over one. Every
 * state of the issue's list (#410): under the limits, over with no file, over
 * with a file, back under with a file, a limit override, the committed
 * setting that moves the listing budget, the old baseline file, and `init`.
 * `lint` is checked to write nothing in every one of them. The Codex twin is
 * `src/adapters/codex/always-loaded-lint.test.ts`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BASELINE_FILE,
  UPDATE_BASELINE_COMMAND,
  parseBaselineStore,
  type BaselineStore,
} from "../../core/baseline-store.js";
import { checkAlwaysLoadedLimits } from "../../core/always-loaded-limits.js";
import { legacyBaselineFiles } from "../../core/legacy-baseline.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { RULES } from "../../rules/index.js";

const CLI = resolve(__dirname, "..", "..", "..", "dist", "cli.js");
/** The rule, asked of the set by its detector — never spelled. */
const RULE_ID =
  RULES.find((r) => r.detector === checkAlwaysLoadedLimits.name)?.id ?? "";
/** The file earlier releases wrote, named after the rule. */
const LEGACY = legacyBaselineFiles(RULE_ID)[0] ?? "";

let dir: string;

function run(args: readonly string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync("node", [CLI, ...args], {
    cwd: dir,
    encoding: "utf-8",
    env,
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function append(rel: string, body: string): void {
  put(rel, readFileSync(join(dir, rel), "utf-8") + body);
}

/** The store, parsed by the reader `lint` itself uses. */
function store(): BaselineStore {
  const parsed = parseBaselineStore(
    readFileSync(join(dir, BASELINE_FILE), "utf-8"),
  );
  if (parsed.kind !== "ok") throw new Error(parsed.kind);
  return parsed.store;
}

/** Every file under `.vigiles/`, so a test can say `lint` wrote nothing. */
function vigilesDir(): readonly string[] {
  const at = join(dir, ".vigiles");
  return existsSync(at) ? readdirSync(at).sort() : [];
}

/** `lint`, asserting it left `.vigiles/` exactly as it found it. */
function lint(extra: readonly string[] = []): { code: number; out: string } {
  const before = vigilesDir();
  const before2 = existsSync(join(dir, BASELINE_FILE))
    ? readFileSync(join(dir, BASELINE_FILE), "utf-8")
    : null;
  const r = run(["lint", ...extra]);
  expect(vigilesDir()).toEqual(before);
  expect(
    existsSync(join(dir, BASELINE_FILE))
      ? readFileSync(join(dir, BASELINE_FILE), "utf-8")
      : null,
  ).toBe(before2);
  return r;
}

/** A skill whose listing entry is `- <name>: ` plus a capped 1,500-char description. */
function bigSkill(name: string): void {
  put(
    `.claude/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${"d".repeat(1500)}\n---\nbody`,
  );
}

/** Five such skills: 5 × (1,500 + `- sN: `) = 7,530 chars, over the 6,000 floor. */
function overTheListingBudget(): void {
  ["s1", "s2", "s3", "s4", "s5"].forEach(bigSkill);
}

beforeEach(() => {
  dir = makeTmpDir("always-loaded-lint-cc");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { "claude-code": {} } }));
  put("CLAUDE.md", "# Project\n\nUse the npm scripts in package.json.\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("under every limit", () => {
  it("growth passes, no file is needed, and nothing says to record one", () => {
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toHaveLength(48);
    const first = lint();
    expect(first.code).toBe(0);
    append("CLAUDE.md", "- Prefer small PRs.\n");
    const grown = lint();
    expect(grown.code).toBe(0);
    expect(grown.out).not.toContain("baseline");
    expect(grown.out).not.toContain(UPDATE_BASELINE_COMMAND);
  });

  it("--update-baseline writes nothing while nothing is over", () => {
    const r = run(["lint", "--update-baseline"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, BASELINE_FILE))).toBe(false);
    expect(r.out).toContain("no baseline to record");
  });
});

describe("the skill listing over Claude Code's listing budget (6,000 chars)", () => {
  beforeEach(overTheListingBudget);

  it("with no file: a note naming the command, never a finding, and why it matters", () => {
    const r = lint();
    expect(r.code).toBe(0);
    expect(r.out).toContain("skill listing 7,530 chars, limit 6,000");
    expect(r.out).toContain("drops skill descriptions");
    expect(r.out).toContain(UPDATE_BASELINE_COMMAND);
    expect(r.out).not.toMatch(/✗/);
  });

  it("--summary carries the one-line instruction for the session-start hook", () => {
    const r = lint(["--summary"]);
    expect(r.out).toContain(
      `vigiles: note — always-loaded context is over the harness's limit and no baseline is recorded — run \`${UPDATE_BASELINE_COMMAND}\``,
    );
  });

  it("with a file: an equal tree holds, growth fails, a shrink is a note", () => {
    expect(run(["lint", "--update-baseline"]).code).toBe(0);
    const entry = store().rules;
    const [ruleEntries] = Object.values(entry);
    expect(ruleEntries?.["."]?.parts?.["skill-listing"]?.value).toBe(7530);
    expect(ruleEntries?.["."]?.direction).toBe("shrink-only");

    const held = lint();
    expect(held.code).toBe(0);
    expect(held.out).toContain("Held at the recorded baseline");

    append("CLAUDE.md", "- Prefer small PRs.\n");
    const grown = lint();
    expect(grown.code).toBe(2);
    expect(grown.out).toContain("Grew 7,578 → 7,598 chars (+20)");
    expect(grown.out).toContain("CLAUDE.md (instructions) +20");

    put("CLAUDE.md", "# Project\n");
    const shrunk = lint();
    expect(shrunk.code).toBe(0);
    expect(shrunk.out).toContain("Shrank");
  });

  it("dropping under every limit with the file: a note that it can go, and an update deletes it", () => {
    run(["lint", "--update-baseline"]);
    ["s4", "s5"].forEach((name) => {
      put(
        `.claude/skills/${name}/SKILL.md`,
        `---\nname: ${name}\ndescription: short\n---\n`,
      );
    });
    const r = lint();
    expect(r.code).toBe(0);
    expect(r.out).toContain("under the limit");
    expect(r.out).toContain("drops it");
    const update = run(["lint", "--update-baseline"]);
    expect(update.out).toContain(`removed ${BASELINE_FILE}`);
    expect(existsSync(join(dir, BASELINE_FILE))).toBe(false);
  });
});

describe("what moves a limit", () => {
  it("a committed skillListingBudgetFraction moves the listing budget", () => {
    put(
      ".claude/skills/a/SKILL.md",
      `---\nname: a\ndescription: ${"d".repeat(100)}\n---\n`,
    );
    put(".claude/settings.json", '{"skillListingBudgetFraction": 0.0001}');
    const r = lint();
    expect(r.out).toContain("skill listing 105 chars, limit 60");
    expect(r.out).toContain("skillListingBudgetFraction");
  });

  it("a limit override in .vigilesrc.json is read", () => {
    put(
      ".vigilesrc.json",
      JSON.stringify({
        harnesses: { "claude-code": {} },
        rules: { [RULE_ID]: ["error", { limits: { instructions: 20 } }] },
      }),
    );
    const r = lint();
    expect(r.code).toBe(0);
    expect(r.out).toContain("limit 20 (set in .vigilesrc.json)");
  });

  it("an invalid override fails the strict schema", () => {
    put(
      ".vigilesrc.json",
      JSON.stringify({
        harnesses: { "claude-code": {} },
        rules: { [RULE_ID]: ["error", { limits: { "skill-listing": 0 } }] },
      }),
    );
    const r = run(["lint"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("limits");
  });
});

describe("the old baseline file", () => {
  /** A version-2 file as the previous release wrote it: instructions only. */
  function legacy(total: number): void {
    put(
      LEGACY,
      JSON.stringify({
        version: 2,
        bundles: {
          ".": {
            unit: "chars",
            measure: 1,
            total,
            files: { "CLAUDE.md": total },
            parts: {
              "skill-listing": {
                measure: 1,
                total: 7530,
                files: Object.fromEntries(
                  ["s1", "s2", "s3", "s4", "s5"].map((s) => [
                    `.claude/skills/${s}/SKILL.md`,
                    1506,
                  ]),
                ),
              },
            },
          },
        },
      }),
    );
  }

  beforeEach(overTheListingBudget);

  it("is no longer read: a finding names it and the command that migrates it", () => {
    legacy(48);
    const r = lint();
    expect(r.code).toBe(2);
    expect(r.out).toContain(`${LEGACY} is no longer read`);
    expect(r.out).toContain(UPDATE_BASELINE_COMMAND);
    expect(lint(["--summary"]).out).toContain(`${LEGACY} is no longer read`);
  });

  it("the command keeps the recorded numbers, so growth since then still fails", () => {
    legacy(30); // recorded when CLAUDE.md was 30 chars; it is 48 now
    const migrate = run(["lint", "--update-baseline"]);
    expect(migrate.out).toContain(`migrated ${LEGACY}`);
    expect(existsSync(join(dir, LEGACY))).toBe(false);
    const [entries] = Object.values(store().rules);
    expect(entries?.["."]?.parts?.["instructions"]?.value).toBe(30);
    const after = lint();
    expect(after.code).toBe(2);
    expect(after.out).toContain("Grew 7,560 → 7,578 chars (+18)");
    // Run again to accept the current size.
    run(["lint", "--update-baseline"]);
    expect(lint().code).toBe(0);
  });
});

describe("init records the baseline only where it is needed", () => {
  const init = (): { code: number; out: string } =>
    run(["init", "--ci-only", "--no-plugin", "--no-gha"]);

  it("over a limit: writes the file and names it", () => {
    overTheListingBudget();
    const r = init();
    expect(r.out).toContain(
      "skill-listing is 7,530 chars, over the limit of 6,000",
    );
    expect(r.out).toContain(`Recorded ${BASELINE_FILE} — commit it`);
    expect(existsSync(join(dir, BASELINE_FILE))).toBe(true);
    expect(lint().out).toContain("Held at the recorded baseline");
  });

  it("under every limit: writes nothing", () => {
    init();
    expect(existsSync(join(dir, BASELINE_FILE))).toBe(false);
  });

  it("a rerun never overwrites an existing baseline", () => {
    overTheListingBudget();
    init();
    const first = readFileSync(join(dir, BASELINE_FILE), "utf-8");
    append("CLAUDE.md", "- grew after init\n");
    const again = init();
    expect(readFileSync(join(dir, BASELINE_FILE), "utf-8")).toBe(first);
    expect(again.out).toContain("left as it is");
  });
});
