/**
 * An `@path` import a Claude Code instruction file names that does not resolve
 * (#442): located where it is WRITTEN, the same in the disk engine and the
 * browser engine, and through the built CLI the same in `lint` and `audit`.
 * The Codex twin is `src/adapters/codex/instruction-imports.test.ts`.
 *
 * The fixture is built so the ADAPTER's resolution decides: `.claude/CLAUDE.md`
 * names `@other.md`, which Claude Code reads as `.claude/other.md` — a root
 * `other.md` exists and must not satisfy it — and `@notes.md`, satisfied by
 * `.claude/notes.md` although no root `notes.md` exists.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildAuditReport, type AuditReport } from "../../audit-report.js";
import { applyRules } from "../../core/apply-rules.js";
import { instructionViews } from "../../core/instruction-chain.js";
import {
  listingOfPaths,
  unresolvedImports,
} from "../../core/instruction-imports.js";
import { weighInstructions } from "../../core/instruction-weight.js";
import { defaultSeverities } from "../../core/rule.js";
import { cleanupTmpDir, makeTmpDir } from "../../core/test-utils.js";
import { ruleResolver } from "../../overrides.js";
import { RULES, RULE_GROUPS } from "../../rules/index.js";
import { scanFiles } from "../../scan-files.js";
import { scanPlugin, type ScanReport } from "../../scan.js";
import { claudeCodeDialect } from "./dialect.js";
import { claudeCodeLayout } from "./layout.js";

const CLI = resolve(import.meta.dirname, "..", "..", "..", "dist", "cli.js");
/** The rule, asked of the set by its detector — never spelled. */
const RULE_ID =
  RULES.find((r) => r.detector === unresolvedImports.name)?.id ?? "";

const FILES = {
  ".claude-plugin/plugin.json":
    '{"name":"import-repo","version":"0.1.0","description":"x"}',
  "CLAUDE.md": "# Project\n\n@docs/missing.md\n@docs/Style.md\n@docs/ok.md\n",
  "docs/style.md": "s",
  "docs/ok.md": "o",
  ".claude/CLAUDE.md": "Local notes.\n@notes.md\n@other.md\n",
  ".claude/notes.md": "n",
  "other.md": "a root file with the token's name",
} as const;

const tmps: string[] = [];
afterEach(() => {
  tmps.splice(0).forEach(cleanupTmpDir);
});

/** A repo on disk holding `files` (plus a `.vigilesrc.json` when given). */
function repo(
  files: Readonly<Record<string, string>>,
  config?: object,
): string {
  const tmp = makeTmpDir("cc-imports");
  tmps.push(tmp);
  const abs = join(tmp, "import-repo");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(abs, rel)), { recursive: true });
    writeFileSync(join(abs, rel), body);
  }
  if (config !== undefined)
    writeFileSync(join(abs, ".vigilesrc.json"), JSON.stringify(config));
  return abs;
}

function run(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
): { code: number; out: string } {
  const env = { ...process.env, GITHUB_ACTIONS: undefined, ...extraEnv };
  const r = spawnSync("node", [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout };
}

/** Both engines over the same repository. */
function engines(abs: string): readonly (readonly [string, ScanReport])[] {
  const map = Object.fromEntries(
    Object.entries(FILES).map(([rel, body]) => [rel, body]),
  );
  return [
    ["disk", scanPlugin(abs, claudeCodeLayout, claudeCodeDialect)],
    ["browser", scanFiles(map, claudeCodeLayout, claudeCodeDialect, "x")],
  ];
}

/** Each located finding of a report as `[rule, path, line, subject]`. */
const locatedOf = (report: AuditReport) =>
  report.findings?.flatMap((res) =>
    res.findings.map((f) => [res.rule, f.path, f.line, f.subject]),
  );

const shown = (scan: ScanReport) =>
  applyRules(RULES, RULE_GROUPS, ruleResolver(defaultSeverities(RULES)), scan);

describe("an unresolved import, in both engines", () => {
  it("is named by file, line, the adapter's resolved path and the reason", () => {
    for (const [name, r] of engines(repo(FILES))) {
      expect([
        name,
        r.instructionImportIssues.map((i) => [
          i.from,
          i.line,
          i.path,
          i.resolution,
        ]),
      ]).toEqual([
        name,
        [
          ["CLAUDE.md", 3, "docs/missing.md", { kind: "missing" }],
          [
            "CLAUDE.md",
            4,
            "docs/Style.md",
            { kind: "case-mismatch", actual: "docs/style.md" },
          ],
          [".claude/CLAUDE.md", 3, ".claude/other.md", { kind: "missing" }],
        ],
      ]);
    }
  });

  it("the audit report carries the same findings, located, and the weight does not repeat them", () => {
    for (const [name, r] of engines(repo(FILES))) {
      const report = buildAuditReport(shown(r), {
        harness: "claude-code",
        vigilesVersion: "0.0.0-test",
      });
      expect([name, locatedOf(report)]).toEqual([
        name,
        [
          [RULE_ID, "CLAUDE.md", 3, "@docs/missing.md"],
          [RULE_ID, "CLAUDE.md", 4, "@docs/Style.md"],
          [RULE_ID, ".claude/CLAUDE.md", 3, "@other.md"],
        ],
      ]);
      expect([name, r.instructionWeight?.unreadImports]).toEqual([name, []]);
    }
  });
});

const BROKEN = { "CLAUDE.md": "# Project\n\n@docs/missing.md\n" };
const CLEAN = { ...BROKEN, "docs/missing.md": "now here" };
const located = z.object({
  findings: z
    .array(
      z.object({
        rule: z.string(),
        findings: z.array(z.object({ path: z.string(), line: z.number() })),
      }),
    )
    .optional(),
  score: z.object({
    overall: z.number(),
    categories: z.array(
      z.object({ key: z.string(), score: z.number().nullable() }),
    ),
  }),
});
const audit = (abs: string) =>
  located.parse(JSON.parse(run(["audit", "--json"], abs).out));
const truthfulness = (r: z.infer<typeof located>) =>
  r.score.categories.find((c) => c.key === "Truthfulness")?.score;

describe("through the built CLI", () => {
  it("lint prints it at file:line and stays green at the default warn", () => {
    const r = run(["lint"], repo(BROKEN));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/CLAUDE\.md:3: @docs\/missing\.md: /);
  });

  it("in GitHub Actions the annotation carries the file AND the line", () => {
    const r = run(["lint"], repo(BROKEN), { GITHUB_ACTIONS: "true" });
    expect(r.out).toContain(
      "::warning file=CLAUDE.md,line=3::@docs/missing.md: ",
    );
  });

  it("audit --json carries it located, and it costs Truthfulness", () => {
    const broken = audit(repo(BROKEN));
    expect(broken.findings).toEqual([
      { rule: RULE_ID, findings: [{ path: "CLAUDE.md", line: 3 }] },
    ]);
    const clean = audit(repo(CLEAN));
    expect(clean.findings).toBeUndefined();
    expect(truthfulness(broken)).toBeLessThan(truthfulness(clean) ?? 0);
  });

  it("off: neither lint nor audit reports it, and the score is the clean one", () => {
    const off = repo(BROKEN, { rules: { [RULE_ID]: false } });
    expect(run(["lint"], off).out).not.toMatch(/CLAUDE\.md:3/);
    const r = audit(off);
    expect(r.findings).toBeUndefined();
    expect(truthfulness(r)).toBe(truthfulness(audit(repo(CLEAN))));
  });
});

describe("an import of something that is not a file", () => {
  // A directory named `guide.md` and a symlink to nothing are both IN their
  // directory's listing under the exact name, so a listing of bare names
  // read them as resolved. The listing now says what each entry is, and the
  // name an import ends on must be a file.
  it("a directory or a dangling symlink is `not-a-file` on disk, and the browser engine agrees on the directory", () => {
    const files = {
      "CLAUDE.md": "# Project\n\n@docs/guide.md\n@docs/link.md\n",
      "docs/guide.md/inner.md": "a file inside a directory named guide.md",
    };
    const abs = repo(files);
    symlinkSync("nowhere.md", join(abs, "docs", "link.md"));
    const issuesOf = (r: ScanReport) =>
      r.instructionImportIssues.map((i) => [i.line, i.path, i.resolution]);
    expect(
      issuesOf(scanPlugin(abs, claudeCodeLayout, claudeCodeDialect)),
    ).toEqual([
      [3, "docs/guide.md", { kind: "not-a-file", is: "dir" }],
      [4, "docs/link.md", { kind: "not-a-file", is: "other" }],
    ]);
    // The browser's map has no symlinks; on the directory it says the same.
    expect(
      issuesOf(scanFiles(files, claudeCodeLayout, claudeCodeDialect, "x")),
    ).toEqual([
      [3, "docs/guide.md", { kind: "not-a-file", is: "dir" }],
      [4, "docs/link.md", { kind: "missing" }],
    ]);
  });
});

describe("an import written in one machine's file", () => {
  // `InstructionScope`: `CLAUDE.local.md` is linted, never scored — it is
  // gitignored, so a teammate, CI and the browser engine never see it, and
  // a grade that moved with it would differ between two checkouts of one
  // commit. The scope is the one the CHAIN assigns the importing file, so a
  // committed `docs/notes.md` imported ONLY by `CLAUDE.local.md` is `local`
  // too (it does not load for a teammate) and its own broken import is
  // linted, not scored.
  const COMMITTED = { "CLAUDE.md": "# Project\n" };
  const WITH_LOCAL = {
    ...COMMITTED,
    "CLAUDE.local.md": "mine\n@docs/gone.md\n@docs/notes.md\n",
    "docs/notes.md": "notes\n@deeper.md\n",
  };

  it("lint and audit print it, and the score is the committed checkout's", () => {
    const local = repo(WITH_LOCAL);
    const lint = run(["lint"], local).out;
    expect(lint).toMatch(/CLAUDE\.local\.md:2: @docs\/gone\.md: /);
    expect(lint).toMatch(/docs\/notes\.md:2: @deeper\.md: /);
    const withLocal = audit(local);
    expect(withLocal.findings).toEqual([
      {
        rule: RULE_ID,
        findings: [
          { path: "CLAUDE.local.md", line: 2 },
          { path: "docs/notes.md", line: 2 },
        ],
      },
    ]);
    const committed = audit(repo(COMMITTED));
    expect(withLocal.score).toEqual(committed.score);
  });

  it("audit's structural summary counts the finding it printed, though the grade does not", () => {
    // Otherwise clean, with a skill so there is something to check: the one
    // finding is the local import, and the summary line must agree with it.
    const out = run(
      ["audit"],
      repo({
        ...WITH_LOCAL,
        ".claude/skills/x/SKILL.md":
          "---\nname: x\ndescription: Use when testing imports.\n---\nbody\n",
      }),
    ).out;
    expect(out).toMatch(/CLAUDE\.local\.md:2/);
    expect(out).not.toContain("✓ no structural issues found");
    expect(out).toMatch(/⚠ \d+ structural issue\(s\)/);
  });

  it("the same import written in the COMMITTED file is scored", () => {
    const broken = audit(repo({ "CLAUDE.md": "# Project\n@docs/gone.md\n" }));
    expect(truthfulness(broken)).toBeLessThan(
      truthfulness(audit(repo(COMMITTED))) ?? 0,
    );
  });
});

describe("a committed file a per-machine file hides from this working copy", () => {
  it("its IMPORTS stay in the committed weight — the committed view is a chain, not a filter", () => {
    // `AGENTS.md` imports `docs/x.md`; a `CLAUDE.local.md` makes this copy
    // read neither, and a teammate reads both.
    const files = {
      "AGENTS.md": `${"A".repeat(100)}\n@docs/x.md\n`,
      "docs/x.md": "X".repeat(50),
      "CLAUDE.local.md": "L".repeat(10),
    };
    const budget = claudeCodeDialect.instructionBudget;
    if (budget === undefined) throw new Error("precondition: a budget");
    const w = weighInstructions(
      instructionViews(claudeCodeLayout, files),
      files,
      budget,
      listingOfPaths(Object.keys(files)),
    );
    expect([w.committedTotal, w.effectiveTotal]).toEqual([
      100 + "\n@docs/x.md\n".length + 50,
      10,
    ]);
    expect(
      w.files
        .filter((f) => f.notLoadedHere !== undefined)
        .map((f) => [f.path, f.notLoadedHere?.by]),
    ).toEqual([
      ["AGENTS.md", "CLAUDE.local.md"],
      ["docs/x.md", "CLAUDE.local.md"],
    ]);
  });

  // The grade is the COMMITTED view's — what a teammate's checkout and CI
  // load — so a gitignored file that stops this copy loading a committed file
  // cannot take that file's broken import out of the score. What THIS copy
  // loads still decides what is printed.
  it("a CLAUDE.local.md that supersedes AGENTS.md leaves AGENTS.md's broken import in the score", () => {
    // AGENTS.md alone auto-detects as Codex, hence `--harness=claude-code`.
    const ccAudit = (abs: string) =>
      located.parse(
        JSON.parse(run(["audit", "--json", "--harness=claude-code"], abs).out),
      );
    const committed = {
      "AGENTS.md": "# Agents\n@missing.md\n",
      ".claude/skills/x/SKILL.md":
        "---\nname: x\ndescription: Use when testing imports.\n---\nbody\n",
    };
    const withLocal = { ...committed, "CLAUDE.local.md": "mine\n" };
    expect(ccAudit(repo(withLocal)).score).toEqual(
      ccAudit(repo(committed)).score,
    );
    expect(truthfulness(ccAudit(repo(committed)))).toBeLessThan(100);
  });

  it("a local claudeMdExcludes that hides a rule leaves the rule's broken import in the score", () => {
    const committed = {
      "CLAUDE.md": "# Project\n",
      ".claude/rules/policy.md": "policy\n@gone.md\n",
    };
    const withLocal = {
      ...committed,
      ".claude/settings.local.json": JSON.stringify({
        claudeMdExcludes: ["**/rules/**"],
      }),
    };
    expect(audit(repo(withLocal)).score).toEqual(audit(repo(committed)).score);
    expect(truthfulness(audit(repo(committed)))).toBeLessThan(100);
  });
});

describe("exclude and overrides reach audit as they reach lint", () => {
  // `exclude` beats everything, with no finding either
  // (docs/configuration.md): an import WRITTEN in an excluded file is not
  // reported, by `lint` or by `audit`.
  it("exclude: an import written in an excluded file is reported by neither lint nor audit", () => {
    const files = {
      "CLAUDE.md": "root @root-missing.md @vendor/guide.md\n",
      "vendor/guide.md": "v @vend-missing.md\n",
    };
    const vendor = repo(files, { exclude: ["vendor"] });
    const lint = run(["lint"], vendor).out;
    expect(lint).toMatch(/CLAUDE\.md:1: @root-missing\.md: /);
    expect(lint).not.toMatch(/vendor\/guide\.md:1/);
    expect(audit(vendor).findings).toEqual([
      { rule: RULE_ID, findings: [{ path: "CLAUDE.md", line: 1 }] },
    ]);
    const root = repo(files, { exclude: ["CLAUDE.md"] });
    expect(run(["lint"], root).out).not.toMatch(/CLAUDE\.md:1/);
  });

  // A per-path override that turns the rule off: `lint` already honoured it,
  // and `audit` must agree — no finding printed, no Truthfulness points lost.
  it("an override that turns the rule off for one folder silences it in lint AND audit", () => {
    const files = {
      "CLAUDE.md": "# Project\n",
      ".claude/rules/legacy/a.md": "@old-missing.md\n",
    };
    const overrides = [
      { files: [".claude/rules/legacy/**"], rules: { [RULE_ID]: "off" } },
    ];
    const silenced = repo(files, { overrides });
    expect(run(["lint"], silenced).out).not.toMatch(/old-missing\.md/);
    const r = audit(silenced);
    expect(r.findings).toBeUndefined();
    expect(truthfulness(r)).toBe(
      truthfulness(audit(repo({ "CLAUDE.md": "# Project\n" }))),
    );
  });
});
