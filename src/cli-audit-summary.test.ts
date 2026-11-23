/**
 * The two CLI faces of #474 and #475, driven through the built binary:
 *
 *   - `audit --md` on one directory prints the PR-comment section (the GitHub
 *     Action's audit summary), and `--compare=<base.json>` adds the per-ring
 *     change against an `audit --json` report of the PR base.
 *   - `audit` stamps `.vigiles/last-audit.json`, and `lint --summary` (the
 *     session-start path) prints one line when that record is old or missing.
 *
 * Offline and model-free: a temp repo with one skill.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { AUDIT_SUMMARY_MARKER } from "./audit-pr-summary.js";
import { defaultAdapter } from "./adapter-registry.js";
import { skillsHome } from "./core/layout.js";
import { lastAuditRecord } from "./core/last-audit.js";
import { enumerateEslintCatalog } from "./core/rule-catalog.js";
import { LAST_AUDIT_FILE, VIGILES_DIR } from "./local-files.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

function run(
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 60000,
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

/** The part of `audit --json` the base edit touches — parsed, not cast. */
const ringsOnly = z
  .object({
    score: z
      .object({
        categories: z.array(
          z.object({ key: z.string(), score: z.number().nullable() }).loose(),
        ),
      })
      .loose(),
  })
  .loose();

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-audit-summary-"));
  const { layout } = defaultAdapter;
  writeFileSync(
    join(dir, layout.instructionFile),
    "# Project\n\nBe careful.\n",
  );
  const skill = join(dir, skillsHome(layout) ?? "skills", "greet");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: greet\ndescription: Greet the user when they say hello.\n---\n\nSay hello back.\n",
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stamp = (): string => join(dir, VIGILES_DIR, LAST_AUDIT_FILE);

/** Write the record `audit` would have written at `at`. */
function recordAuditRun(at: Date): void {
  mkdirSync(join(dir, VIGILES_DIR), { recursive: true });
  writeFileSync(stamp(), lastAuditRecord(at));
}

describe("audit --md (one directory)", () => {
  it("prints the PR-comment section, and writes no report files", () => {
    const r = run(["audit", "--md"], dir);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    expect(r.stdout).not.toContain("Detected harness");
    expect(existsSync(join(dir, "vigiles-report.html"))).toBe(false);
    expect(existsSync(join(dir, "vigiles-report.json"))).toBe(false);
  });

  it("--compare= shows each ring's change against the base report", () => {
    const json = run(["audit", "--json"], dir);
    expect(json.exitCode, json.stderr).toBe(0);
    const base = ringsOnly.parse(JSON.parse(json.stdout));
    // The base differs from the head in exactly one ring.
    const edited = {
      ...base,
      score: {
        ...base.score,
        categories: base.score.categories.map((c) =>
          c.key === "Structure" ? { ...c, score: 13 } : c,
        ),
      },
    };
    writeFileSync(join(dir, "base.json"), JSON.stringify(edited));
    const r = run(["audit", "--md", "--compare=base.json"], dir);
    expect(r.exitCode, r.stderr).toBe(0);
    const structure =
      r.stdout.split("\n").find((l) => l.includes("Structure")) ?? "";
    expect(structure).toMatch(/13 → \d+ ▲/);
  });

  it("--compare= naming no file still prints the section, with a note", () => {
    const r = run(["audit", "--md", "--compare=missing.json"], dir);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.startsWith(AUDIT_SUMMARY_MARKER)).toBe(true);
    expect(r.stdout).toMatch(/base/i);
    expect(r.stdout).not.toMatch(/[▲▼]/);
  });

  it("--compare= without --md is refused, not ignored", () => {
    const r = run(["audit", "--compare=base.json"], dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--md");
  });
});

describe("the last-audit stamp", () => {
  it("a human audit records the run", () => {
    const r = run(["audit", "--no-open"], dir);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(stamp())).toBe(true);
    expect(readFileSync(stamp(), "utf-8")).toContain('"at"');
    // A per-checkout record: kept out of git with the other local files.
    const ignore = readFileSync(join(dir, VIGILES_DIR, ".gitignore"), "utf-8");
    expect(ignore.split("\n")).toContain(`/${LAST_AUDIT_FILE}`);
  });

  it("machine runs (--json, --md) do not", () => {
    run(["audit", "--json"], dir);
    run(["audit", "--md"], dir);
    expect(existsSync(stamp())).toBe(false);
  });
});

// Codex on #480: a remembered `audit.measure: true` (a person's yes, committed in
// `.vigilesrc.json`) must not make a headless run load the repo's linter. The
// Action runs `audit --md` on every PR, so loading it there runs the PR's code.
describe("a headless audit never loads the repo's linter", () => {
  /** A stand-in `eslint` package that leaves a marker when anything loads it. */
  function plantEslint(): string {
    const marker = join(dir, "eslint-was-loaded");
    const pkg = join(dir, "node_modules", "eslint");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      '{"name":"eslint","main":"index.js"}',
    );
    writeFileSync(
      join(pkg, "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`,
    );
    writeFileSync(join(dir, ".vigilesrc.json"), '{"audit":{"measure":true}}');
    return marker;
  }

  it("the stand-in is reachable: the catalog loader does load it", () => {
    const marker = plantEslint();
    enumerateEslintCatalog(dir);
    expect(existsSync(marker)).toBe(true);
  });

  it.each([["--md"], ["--json"]])("audit %s with a remembered yes", (flag) => {
    const marker = plantEslint();
    const r = run(["audit", flag], dir);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("lint --summary: the last-audit line", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("no record → 'no local audit yet'", () => {
    const r = run(["lint", "--summary"], dir);
    expect(r.stdout).toContain(
      "vigiles: no local audit yet — run npx vigiles audit",
    );
  });

  it("a record 9 days old → 'last audit 9 days ago'", () => {
    recordAuditRun(new Date(Date.now() - 9 * DAY - 60_000));
    const r = run(["lint", "--summary"], dir);
    expect(r.stdout).toContain(
      "vigiles: last audit 9 days ago — run npx vigiles audit",
    );
  });

  it("a recent record → no line", () => {
    recordAuditRun(new Date(Date.now() - DAY));
    const r = run(["lint", "--summary"], dir);
    expect(r.stdout).not.toContain("last audit");
    expect(r.stdout).not.toContain("no local audit yet");
  });

  it("plain lint never prints it", () => {
    const r = run(["lint"], dir);
    expect(r.stdout).not.toContain("no local audit yet");
  });
});
