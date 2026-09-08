/**
 * Leaderboard test suite (vitest): pure scoreReport penalty weights + clamp + empty-machine=0 + command-only/hooks-only/MCP-only-is-a-real-surface (incl. an end-to-end hooks-only plugin dir, and that audit-overall == leaderboard-health on it), rankPlugins ordering (healthy above broken) over tmp fixtures, formatLeaderboard rendering
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  scoreReport,
  rankPlugins,
  formatLeaderboard,
  formatLeaderboardMarkdown,
  reportDeductions,
  computeIntegrityScore,
} from "./leaderboard.js";
import { auditScore } from "./audit-score.js";
import { scanPlugin, type ScanReport } from "./scan.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import { claudeCodeDialect } from "./adapters/claude-code/dialect.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    dir: "x",
    instructions: null,
    skills: [],
    agents: [],
    hooks: [],
    inlineHooks: 0,
    manualHookCount: 0,
    commands: 0,
    mcp: false,
    danglingRefs: [],
    hookEventIssues: [],
    frontmatterIssues: [],
    frontmatterValueIssues: [],
    skillMetaIssues: [],
    mcpIssues: [],
    mcpHookIssues: [],
    descriptionOverlaps: [],
    descriptionBudgetIssues: [],
    trifectaFindings: [],
    skillResourceIssues: [],
    skillFenceIssues: [],
    pluginLayoutIssues: [],
    delegationTrifecta: [],
    hookBlockFindings: [],
    hookMatcherFindings: [],
    malformedFrontmatter: [],
    warnings: [],
    untested: 0,
    puritySummary: { pure: 0, bounded: 0, unrestricted: 0 },
    ...over,
  };
}

test("a structurally clean plugin scores 100", () => {
  const r = report({
    skills: [
      {
        name: "s",
        path: "p",
        hasDescription: true,
        userInvoked: false,
        resourceIssues: [],
        trifecta: null,
        fenceIssue: null,
      },
    ],
    hooks: [{ command: "bash h.sh", script: "h.sh", status: "ok" }],
  });
  const { score, issues } = scoreReport(r);
  assert.equal(score, 100);
  assert.equal(issues.length, 0);
});

test("penalties: missing hook -15, no-desc -10; inherit-all + untested advisory (not scored)", () => {
  assert.equal(
    scoreReport(
      report({
        hooks: [{ command: "bash h", script: "h", status: "missing" }],
      }),
    ).score,
    85,
  );
  assert.equal(
    scoreReport(
      report({
        skills: [
          {
            name: "s",
            path: "p",
            hasDescription: false,
            userInvoked: false,
            resourceIssues: [],
            trifecta: null,
            fenceIssue: null,
          },
        ],
      }),
    ).score,
    90,
  );
  // inherit-all (no `tools:` line) is ADVISORY — it does NOT affect the score
  // (omitting the contract is idiomatic, not breakage), but it's still surfaced as
  // an advisory note. See reportDeductions for the rationale.
  const inheritAll = scoreReport(
    report({
      agents: [
        {
          name: "a",
          path: "p",
          tools: null,
          toolIssues: [],
          mcpToolIssues: [],
          disallowedToolIssues: [],
          purity: "unrestricted" as const,
          effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
          trifecta: null,
        },
      ],
    }),
  );
  assert.equal(inheritAll.score, 100);
  assert.ok(
    inheritAll.issues.some(
      (i) => i.includes("inherit all tools") && i.includes("advisory"),
    ),
    "inherit-all still surfaced as an advisory note",
  );
  // Untested surfaces are ADVISORY — they do NOT affect the score (a hardening
  // gap is not breakage), but they're still surfaced as an advisory issue.
  const untestedResult = scoreReport(
    report({
      skills: [
        {
          name: "s",
          path: "p",
          hasDescription: true,
          userInvoked: false,
          resourceIssues: [],
          trifecta: null,
          fenceIssue: null,
        },
      ],
      untested: 4,
    }),
  );
  assert.equal(untestedResult.score, 100);
  assert.ok(
    untestedResult.issues.some(
      (i) => i.includes("untested") && i.includes("advisory"),
    ),
    "untested surfaces still surfaced as an advisory note",
  );
});

test("penalty: broken intra-plugin reference -8 each", () => {
  const { score, issues } = scoreReport(
    report({
      hooks: [{ command: "bash h.sh", script: "h.sh", status: "ok" }],
      danglingRefs: ["skills/using-x/SKILL.md", "agents/missing.md"],
    }),
  );
  assert.equal(score, 84); // 100 - 2*8
  assert.ok(issues.some((i) => i.includes("broken intra-plugin reference")));
});

test("the NEW non-advisory detectors are scored (not ranked A/100 while printing ✗)", () => {
  // Parity: every finding formatScanReport prints with ✗ must deduct, or a broken
  // plugin would rank clean. One of each new detector → all dent the score.
  const skillFence = scoreReport(
    report({
      skillFenceIssues: [{ path: "p", name: "s", finding: {} as never }],
    }),
  ).score;
  assert.ok(skillFence < 100, "an invisible skill must drag the score");
  const hookBlock = scoreReport(
    report({
      hookBlockFindings: [
        {
          event: "SessionStart",
          kind: "wrong-event",
          scriptPath: null,
          message: "x",
        },
      ],
    }),
  ).score;
  assert.ok(hookBlock < 100, "an ineffective hook must drag the score");
  const skillRes = scoreReport(
    report({
      skillResourceIssues: [{ path: "p", name: "s", finding: {} as never }],
    }),
  ).score;
  assert.ok(skillRes < 100, "a broken bundled resource must drag the score");
});

test("a lethal-trifecta unit deducts W_TRIFECTA (-10) — explicit AND inherits-all alike", () => {
  // A hard (explicit all-three) trifecta is an exfil path → graded -10 (half the
  // old 20 — a ding, not a fail).
  const hard = scoreReport(
    report({
      agents: [
        {
          name: "exfil-bot",
          path: "agents/exfil-bot.md",
          tools: ["Bash", "WebFetch"],
          toolIssues: [],
          mcpToolIssues: [],
          disallowedToolIssues: [],
          purity: "unrestricted" as const,
          effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
          trifecta: { severity: "hard" },
        },
      ] as unknown as ScanReport["agents"],
      trifectaFindings: [
        {
          path: "agents/exfil-bot.md",
          kind: "subagent",
          name: "exfil-bot",
          finding: { severity: "hard" },
        },
      ] as unknown as ScanReport["trifectaFindings"],
    }),
  );
  assert.equal(hard.score, 90); // 100 - 10
  assert.ok(hard.issues.some((i) => i.includes("lethal trifecta")));

  // An inherits-all trifecta is graded the SAME — it holds all three legs
  // implicitly AND every other capability, so it can't cost LESS than the
  // explicit contract above (that inversion is the bug this pins).
  const advisory = scoreReport(
    report({
      agents: [
        {
          name: "broad",
          path: "agents/broad.md",
          tools: null,
          toolIssues: [],
          mcpToolIssues: [],
          disallowedToolIssues: [],
          purity: "unrestricted" as const,
          effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
          trifecta: { severity: "advisory" },
        },
      ] as unknown as ScanReport["agents"],
      trifectaFindings: [
        {
          path: "agents/broad.md",
          kind: "subagent",
          name: "broad",
          finding: { severity: "advisory" },
        },
      ] as unknown as ScanReport["trifectaFindings"],
    }),
  );
  assert.equal(advisory.score, 90); // 100 - 10, never cheaper than the explicit one
  assert.ok(advisory.score <= hard.score);
});

test("the audit overall == leaderboard health, even with a HARD trifecta", () => {
  // The invariant: both surfaces read the SAME shared computeIntegrityScore over
  // reportDeductions — Safety being a graded ring must not break that.
  const r = report({
    commands: 1, // a surface (so neither is the empty machine)
    agents: [
      {
        name: "exfil-bot",
        path: "agents/exfil-bot.md",
        tools: ["Bash", "WebFetch"],
        toolIssues: [],
        mcpToolIssues: [],
        disallowedToolIssues: [],
        purity: "unrestricted" as const,
        effectBuckets: { readOnly: [], sideEffecting: [], unknown: [] },
        trifecta: { severity: "hard" },
      },
    ] as unknown as ScanReport["agents"],
    trifectaFindings: [
      {
        path: "agents/exfil-bot.md",
        kind: "subagent",
        name: "exfil-bot",
        finding: { severity: "hard" },
      },
    ] as unknown as ScanReport["trifectaFindings"],
    hooks: [{ command: "bash h.sh", script: "h.sh", status: "ok" }],
  });
  const health = computeIntegrityScore(reportDeductions(r)).score;
  const audit = auditScore(r);
  assert.equal(health, 90); // 100 - 10
  assert.equal(audit.overall, health); // the two surfaces never disagree
});

test("score clamps at 0 and an empty machine is not healthy", () => {
  const empty = scoreReport(report());
  assert.equal(empty.score, 0);
  assert.deepEqual(empty.issues, ["no loadable plugin surface"]);

  // many missing hooks would go negative without the clamp
  const r = report({
    hooks: Array.from({ length: 10 }, (_, i) => ({
      command: `bash h${String(i)}`,
      script: `h${String(i)}`,
      status: "missing" as const,
    })),
  });
  assert.equal(scoreReport(r).score, 0);
});

// ─── a hooks-only plugin is a plugin (#199) ───────────────────────────────────
//
// 🔴 `scoreReport` kept its OWN copy of the surface list and that copy had
// dropped `inlineHooks`, so a plugin whose entire contribution is hooks declared
// inline in `plugin.json` graded 0 / F with "no loadable plugin surface" while
// the same report printed `inlineHooks: 2`. Measured on that shape before the
// fix: `scoreReport` 0 against `auditScore` 100 — two numbers the docs say are
// equal, disagreeing by the whole scale. The fix is that there is now ONE list
// (`isEmptyMachine`), not a corrected second one.
test("a hooks-only plugin is a real surface, not score 0", () => {
  // inline hooks (shell one-liners, no script file) — the shape from #199.
  const inlineOnly = scoreReport(report({ inlineHooks: 2 }));
  assert.equal(inlineOnly.score, 100);
  assert.deepEqual(inlineOnly.issues, []);

  // script-backed hooks, the other half of the same surface.
  const scriptOnly = scoreReport(
    report({
      hooks: [{ command: "bash g.sh", script: "g.sh", status: "ok" as const }],
    }),
  );
  assert.equal(scriptOnly.score, 100);

  // and the headline the audit prints for the same report must not disagree —
  // the invariant a second surface list is exactly what breaks.
  assert.equal(
    auditScore(report({ inlineHooks: 2 })).overall,
    inlineOnly.score,
  );

  // the negative half: no surface of ANY kind is still 0. Without this the fix
  // is indistinguishable from deleting the empty-machine check.
  assert.equal(scoreReport(report()).score, 0);
  assert.deepEqual(scoreReport(report()).issues, [
    "no loadable plugin surface",
  ]);
});

test("a command-only or MCP-only plugin is a real surface, not score 0", () => {
  // commands/*.md with no skills/agents/hooks — Anthropic ships these.
  const cmdOnly = scoreReport(report({ commands: 3 }));
  assert.equal(cmdOnly.score, 100);
  assert.deepEqual(cmdOnly.issues, []);

  // an MCP-only plugin (.mcp.json, no other surface) is loadable too.
  const mcpOnly = scoreReport(report({ mcp: true }));
  assert.equal(mcpOnly.score, 100);
  assert.deepEqual(mcpOnly.issues, []);

  // truly empty (no surface at all) is still 0.
  assert.equal(scoreReport(report()).score, 0);
});

// The end-to-end half of #199: the defect was found by grading a REAL plugin, not
// by reading the code, so one test drives the whole path — a plugin.json on disk
// through `scanPlugin` into the score — rather than a hand-built report only.
test("a real hooks-only plugin dir grades on its hooks, not as empty", () => {
  const dir = makeTmpDir("lb-hooks-only");
  const abs = join(dir, ".claude-plugin", "plugin.json");
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify({
      name: "gates-only",
      version: "1.0.0",
      description: "A plugin whose entire contribution is hooks",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo no" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      },
    }),
  );
  const r = scanPlugin(dir);
  // The loader SEES them — that is what made the 0 read as a contradiction.
  assert.equal(r.inlineHooks, 2, "the hooks are detected");
  assert.equal(r.skills.length + r.agents.length + r.commands, 0);

  const scored = scoreReport(r);
  assert.notEqual(
    scored.score,
    0,
    "a hooks-only plugin is not the empty machine",
  );
  assert.ok(
    !scored.issues.includes("no loadable plugin surface"),
    "and is not reported as having no surface",
  );
  assert.equal(auditScore(r).overall, scored.score, "audit agrees with health");
  cleanupTmpDir(dir);
});

test("rankPlugins orders healthy above broken, with grades", () => {
  const dir = makeTmpDir("lb");
  const mk = (sub: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, sub, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return join(dir, sub);
  };

  const healthy = mk("healthy", {
    "skills/ok/SKILL.md":
      "---\nname: ok\ndescription: A healthy skill with a usable long description\n---\n#ok\n",
  });
  const broken = mk("broken", {
    "skills/bad/SKILL.md": "---\nname: bad\n---\n#bad\n", // no description
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "broken",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/gone.sh",
              },
            ],
          },
        ],
      },
    }),
  });

  const ranked = rankPlugins([broken, healthy]);
  assert.equal(ranked[0].name, "healthy");
  assert.equal(ranked[0].grade, "A");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[1].name, "broken");
  cleanupTmpDir(dir);
});

test("formatLeaderboard renders the mode header, ranks, grades, and reasons", () => {
  const scores = rankPlugins([]); // empty is fine for the header path
  assert.ok(
    formatLeaderboard(scores).includes("0 plugins detected → leaderboard mode"),
  );

  const text = formatLeaderboard([
    {
      dir: "d",
      name: "demo",
      score: 70,
      grade: "C",
      issues: ["2 untested surfaces"],
      report: report(),
    },
  ]);
  assert.ok(text.includes("1 plugin detected → leaderboard mode")); // singular
  assert.ok(text.includes("demo"));
  assert.ok(text.includes("C"));
  assert.ok(text.includes("2 untested surfaces"));
  // The drill-in affordance (a local dir's per-plugin "report link").
  assert.match(text, /Full report for any plugin: npx vigiles audit <dir>/);
  // A C-grade plugin has a real finding → NOT the "all clean" model-tier note.
  assert.ok(!text.includes("All structurally clean"));
});

test("formatLeaderboard points an all-clean board at the model tier", () => {
  // Nothing below a B → the deterministic axis found little, so the note points
  // at the model-gated trigger tier (the "reads as found nothing" fix).
  const text = formatLeaderboard([
    {
      dir: "a",
      name: "clean",
      score: 100,
      grade: "A",
      issues: [],
      report: report(),
    },
    {
      dir: "b",
      name: "solid",
      score: 85,
      grade: "B",
      issues: [],
      report: report(),
    },
  ]);
  assert.match(text, /All structurally clean on the deterministic axis/);
  assert.match(text, /do skills FIRE\? do descriptions collide\?/);

  // A board with a real finding (a C) does NOT get the note.
  const withFinding = formatLeaderboard([
    {
      dir: "a",
      name: "clean",
      score: 100,
      grade: "A",
      issues: [],
      report: report(),
    },
    {
      dir: "c",
      name: "weak",
      score: 70,
      grade: "C",
      issues: ["1 dead tool reference"],
      report: report(),
    },
  ]);
  assert.ok(!withFinding.includes("All structurally clean"));
});

test("formatLeaderboardMarkdown renders a publishable table", () => {
  const md = formatLeaderboardMarkdown([
    {
      dir: "d",
      name: "demo",
      score: 70,
      grade: "C",
      issues: ["2 untested surfaces", "1 broken intra-plugin reference"],
      report: report(),
    },
    {
      dir: "e",
      name: "clean-one",
      score: 100,
      grade: "A",
      issues: [],
      report: report(),
    },
  ]);
  assert.match(md, /\| # \| grade \| score \| plugin \| top issues \|/);
  assert.match(md, /\| 1 \| C \| 70 \| `demo` \| 2 untested surfaces;/);
  assert.match(md, /`clean-one` \| — clean \|/); // no issues → clean
  assert.match(md, /Structural health only/);
});

test("rankPlugins labels a plugin by its manifest name, not the dir basename", () => {
  const dir = makeTmpDir("lb-name");
  const sub = join(dir, "plugin@abc123"); // a SHA-pinned dir basename
  mkdirSync(join(sub, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(sub, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cool-plugin" }),
  );
  mkdirSync(join(sub, "skills", "ok"), { recursive: true });
  writeFileSync(
    join(sub, "skills", "ok", "SKILL.md"),
    "---\nname: ok\ndescription: A healthy skill with a usable long description\n---\n#ok\n",
  );
  const ranked = rankPlugins([sub]);
  assert.equal(ranked[0].name, "cool-plugin"); // not "plugin@abc123"
  cleanupTmpDir(dir);
});

// ─── a board is a list of OTHER people's repos, and they are not all the same ───
//
// 🔴 Found by sweeping for the shape of two sibling bugs (2026-08-12). `vigiles
// audit` on ONE target resolves the adapter and threads `adapter.layout` into
// `scanPlugin`; the MULTI-target branch of the same command called `scanPlugin(dir)`
// bare. A Codex plugin scanned with the Claude Code layout has fewer discoverable
// surfaces — nothing to describe badly, nothing to leave untested, nothing to
// deduct — so it does not score badly. It scores BETTER, and sorts UP the board.
// An empty scan reads as a clean one.
test("rankPlugins detects the harness PER DIRECTORY, so a Codex plugin is really scanned", () => {
  const codex = makeTmpDir("lb-codex");
  mkdirSync(join(codex, ".codex"), { recursive: true });
  mkdirSync(join(codex, "prompts"), { recursive: true });
  writeFileSync(join(codex, ".codex", "config.toml"), "[mcp_servers]\n");
  // Codex keeps its slash-commands in `prompts/`; Claude Code looks in `commands/`
  // and finds nothing there. One surface, visible under exactly one layout.
  writeFileSync(join(codex, "prompts", "go.md"), "# do a thing\n");

  const [scored] = rankPlugins([codex]);
  assert.equal(
    scored.report.commands,
    1,
    "the Codex command surface must be discovered — the Claude Code layout sees 0",
  );
  cleanupTmpDir(codex);
});

test("…and a real Claude Code plugin is scored exactly as it was before", () => {
  // The quiet half on real input: the SHA-pinned vendored plugins. Detection has
  // to resolve them to Claude Code and reproduce, number for number, the score a
  // direct Claude-Code scan gives — otherwise this fix moved a published board.
  const vendor = join(__dirname, "..", "test/dogfood");
  for (const name of [
    "oh-my-claudecode@deee3a4",
    "wshobson-accessibility@cf6059d",
  ]) {
    const dir = join(vendor, name);
    const [ranked] = rankPlugins([dir]);
    const direct = scoreReport(
      scanPlugin(dir, claudeCodeLayout, claudeCodeDialect),
    );
    assert.equal(ranked.score, direct.score, name);
    assert.deepEqual(ranked.issues, direct.issues, name);
    assert.ok(ranked.report.skills.length > 0, `${name} still has its skills`);
  }
});
