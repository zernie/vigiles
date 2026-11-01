/**
 * The always-loaded check on a Codex repository, through the BUILT CLI
 * (vitest, e2e on `dist/cli.js`, no model): in BYTES, with no output styles,
 * and with Codex's own listing budget — 8,000 at thread start, or
 * `[skills] max_context_tokens` × 4 when the committed config sets it. The
 * same states as the Claude Code twin
 * (`src/adapters/claude-code/always-loaded-lint.test.ts`), and `lint` writes
 * nothing in any of them.
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
const RULE_ID =
  RULES.find((r) => r.detector === checkAlwaysLoadedLimits.name)?.id ?? "";
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

function store(): BaselineStore {
  const parsed = parseBaselineStore(
    readFileSync(join(dir, BASELINE_FILE), "utf-8"),
  );
  if (parsed.kind !== "ok") throw new Error(parsed.kind);
  return parsed.store;
}

const snapshot = (): string =>
  JSON.stringify(
    existsSync(join(dir, ".vigiles"))
      ? readdirSync(join(dir, ".vigiles"))
          .sort()
          .map((f) => [f, readFileSync(join(dir, ".vigiles", f), "utf-8")])
      : [],
  );

/** `lint`, asserting it left `.vigiles/` byte-for-byte as it found it. */
function lint(extra: readonly string[] = []): { code: number; out: string } {
  const before = snapshot();
  const r = run(["lint", ...extra]);
  expect(snapshot()).toBe(before);
  return r;
}

const SKILLS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

/**
 * Eight skills of `- sN: <1,000 d> (file: .agents/skills/sN/SKILL.md)` —
 * 6 + 1,000 + 35 = 1,041 bytes each, 8,328 in all: over the 8,000 budget.
 */
function overTheListingBudget(): void {
  SKILLS.forEach((name) => {
    put(
      `.agents/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: ${"d".repeat(1000)}\n---\nbody`,
    );
  });
}

beforeEach(() => {
  dir = makeTmpDir("always-loaded-lint-codex");
  put(".vigilesrc.json", JSON.stringify({ harnesses: { codex: {} } }));
  put("AGENTS.md", "# Project\n\nUse the npm scripts in package.json.\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

describe("under every Codex limit", () => {
  it("growth passes, no file is needed, and nothing says to record one", () => {
    expect(lint().code).toBe(0);
    append("AGENTS.md", "- Prefer small PRs.\n");
    const grown = lint();
    expect(grown.code).toBe(0);
    expect(grown.out).not.toContain(UPDATE_BASELINE_COMMAND);
  });
});

describe("the skill listing over Codex's thread-start budget (8,000)", () => {
  beforeEach(overTheListingBudget);

  it("with no file: a note in bytes, never a finding", () => {
    const r = lint();
    expect(r.code).toBe(0);
    expect(r.out).toContain("skill listing 8,328 bytes, limit 8,000");
    expect(r.out).toContain("drops skill descriptions");
    expect(r.out).toContain(UPDATE_BASELINE_COMMAND);
  });

  it("with a file: an equal tree holds and growth fails; no output-style part", () => {
    run(["lint", "--update-baseline"]);
    const [entries] = Object.values(store().rules);
    expect(Object.keys(entries?.["."]?.parts ?? {})).toEqual([
      "instructions",
      "skill-listing",
    ]);
    expect(lint().code).toBe(0);
    append("AGENTS.md", "- Prüfe.\n");
    const grown = lint();
    expect(grown.code).toBe(2);
    expect(grown.out).toContain("(+10)"); // "- Prüfe.\n" is 10 bytes, 9 chars
  });

  it("with a file: a shrink fails until the lower number is recorded", () => {
    run(["lint", "--update-baseline"]);
    put("AGENTS.md", "# Project\n");
    const shrunk = lint();
    expect(shrunk.code).toBe(2);
    expect(shrunk.out).toContain(
      "The size went down: 8,376 → 8,338 bytes (-38)",
    );
    expect(shrunk.out).toContain("Record the new, lower number");
    run(["lint", "--update-baseline"]);
    expect(lint().code).toBe(0);
  });

  it("dropping under every limit with the file: a note that it can go", () => {
    run(["lint", "--update-baseline"]);
    put(".agents/skills/s8/SKILL.md", "---\nname: s8\ndescription: x\n---\n");
    const r = lint();
    expect(r.code).toBe(0);
    expect(r.out).toContain("under the limit");
  });

  it("an old baseline file is named with the command that migrates it", () => {
    put(LEGACY, JSON.stringify({ version: 1, bundles: {} }));
    const r = lint();
    expect(r.code).toBe(2);
    expect(r.out).toContain(`${LEGACY} is no longer read`);
    run(["lint", "--update-baseline"]);
    expect(existsSync(join(dir, LEGACY))).toBe(false);
    expect(lint().code).toBe(0);
  });
});

describe("what moves the Codex listing limit", () => {
  it("a committed [skills] max_context_tokens, four bytes a token", () => {
    put(
      ".agents/skills/a/SKILL.md",
      `---\nname: a\ndescription: ${"d".repeat(40)}\n---\n`,
    );
    put(".codex/config.toml", "[skills]\nmax_context_tokens = 10\n");
    const r = lint();
    expect(r.out).toContain("limit 40");
    expect(r.out).toContain("skills.max_context_tokens");
  });
});

describe("init on a Codex repository", () => {
  const init = (): { code: number; out: string } =>
    run(["init", "--ci-only", "--no-plugin", "--no-gha"]);

  it("over a limit: writes the file and names it; a rerun keeps it", () => {
    overTheListingBudget();
    const r = init();
    expect(r.out).toContain(
      "skill-listing is 8,328 bytes, over the limit of 8,000",
    );
    expect(r.out).toContain(`Recorded ${BASELINE_FILE}`);
    const first = readFileSync(join(dir, BASELINE_FILE), "utf-8");
    append("AGENTS.md", "- grew\n");
    init();
    expect(readFileSync(join(dir, BASELINE_FILE), "utf-8")).toBe(first);
  });

  it("under every limit: writes nothing", () => {
    init();
    expect(existsSync(join(dir, BASELINE_FILE))).toBe(false);
  });
});
