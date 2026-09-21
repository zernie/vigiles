/**
 * End-to-end `vigiles audit` over the repo-shape matrix — driving the REAL built
 * CLI (`node dist/cli.js audit …`) the way a user does, across Claude Code,
 * Codex, mixed, instruction-only, and marketplace repos.
 *
 * Two fixture sources, by design:
 *   - DOGFOOD on real, SHA-pinned OSS plugins (test/dogfood/*) for the
 *     Claude Code surface — the grounded shapes that catch real-world bugs.
 *   - ARTIFICIAL fixtures for Codex / mixed / instruction-only / marketplace,
 *     which we have no vendored example of (built in a tmp dir, torn down after).
 *
 * Deterministic, model-free, offline → the FREE unit tier (like vendor.test.ts),
 * not the cap-gated e2e tier. It exercises the CLI WIRING the library-level
 * scan.test.ts can't: harness auto-detection, the ambiguity warning, the
 * `--harness=` override, the leaderboard branch, `--json`, and the exit code.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { VERBS } from "./cli-commands.js";
import { knownFlagsFor } from "./cli-flag-check.js";

// __dirname is src/ when vitest resolves the .ts source → ".." is the repo root.
const CLI = resolve(__dirname, "..", "dist", "cli.js");
const VENDOR = resolve(__dirname, "..", "test/dogfood");

function run(
  args: string,
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  // A default `audit` writes vigiles-report.html + vigiles-report.json into cwd —
  // suppress both here so the test run never drops an artifact in the repo root.
  // The dedicated write tests exercise those paths explicitly in a tmp cwd.
  const a =
    args.startsWith("audit ") && !args.includes("--json")
      ? `${args}${args.includes("--no-html") ? "" : " --no-html"}${args.includes("--no-json") ? "" : " --no-json"}`
      : args;
  try {
    const stdout = execSync(`node ${CLI} ${a}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      cwd,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

/** The vendored plugin DIR whose name starts with `prefix` (SHA-suffix agnostic). */
function vendored(prefix: string): string {
  const match = readdirSync(VENDOR, { withFileTypes: true }).find(
    (d) => d.isDirectory() && d.name.startsWith(prefix),
  );
  assert.ok(match, `no vendored plugin dir starting with "${prefix}"`);
  return join(VENDOR, match.name);
}

// --- Dogfood: real Claude Code OSS plugins -------------------------------------

describe("scan e2e — Claude Code (dogfood real OSS)", () => {
  it("reports a real multi-surface plugin (oh-my-claudecode)", () => {
    const r = run(`audit ${vendored("oh-my-claudecode")}`);
    assert.equal(r.exitCode, 0, "scan is read-only — always exits 0");
    assert.match(r.stdout, /Detected harness: claude-code/);
    assert.match(r.stdout, /Skills \(\d+\)/);
    assert.match(r.stdout, /MCP servers: yes/); // it ships an MCP server
  });

  it("flags an inherits-all agent in a real plugin (wshobson-accessibility)", () => {
    const r = run(`audit ${vendored("wshobson-accessibility")}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Detected harness: claude-code/);
    // ships an agent with no `tools:` line → the inherits-all footgun
    assert.match(r.stdout, /inherits all — no contract/);
  });
});

// --- Artificial: the cc/codex/mixed/marketplace matrix -------------------------

describe("scan e2e — artificial cc/codex/mixed/marketplace", () => {
  let root: string;
  const mk = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const desc = (name: string): string =>
    `A skill ${name} that does varied work across many different cases here`;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "scan-e2e-"));

    // 1. A plain Claude Code repo: only a CLAUDE.md, no plugin surface.
    mk("normal/CLAUDE.md", "# Project\nRun the build before committing.\n");

    // 2. A Codex repo: AGENTS.md + TOML config (with MCP) + a skill.
    // The skill sits at `.agents/skills`, which is where Codex scans (vendor,
    // learn.chatgpt.com/docs/build-skills). It was at a root-level `skills/`
    // until 2026-09-21, i.e. this "real Codex repo" fixture was shaped like one
    // no Codex user has; the assertions below only mean something at the real path.
    mk("codex/AGENTS.md", "# Agent instructions\nUse `npm test`.\n");
    mk("codex/.codex/config.toml", "[mcp_servers]\n");
    mk(
      "codex/.agents/skills/foo/SKILL.md",
      `---\nname: foo\ndescription: ${desc("foo")}\n---\n# foo\n`,
    );

    // 2b. A Codex repo wired for `lint` — exercises the layout-driven path end to
    // end: a TOML [hooks] referencing the harness's OWN `${PLUGIN_ROOT}` token (a
    // MISSING script → hook-script-exists fires), an untested skill, and a
    // subagent rule that must report n/a (Codex has no subagents).
    mk("codexlint/AGENTS.md", "# Agent instructions\nUse `npm test`.\n");
    mk(
      "codexlint/.codex/config.toml",
      '[[hooks.PreToolUse]]\ncommand = "${PLUGIN_ROOT}/hooks/missing.sh"\n',
    );
    mk(
      "codexlint/.agents/skills/foo/SKILL.md",
      `---\nname: foo\ndescription: ${desc("foo")}\n---\n# foo\n`,
    );
    mk(
      "codexlint/.vigilesrc.json",
      JSON.stringify({
        harnesses: { codex: {} },
        rules: {
          "hook-script-exists": "warn",
          "untested-skill": "warn",
          "subagent-tool-contract": "warn",
        },
      }),
    );

    // 3. A mixed repo: BOTH CLAUDE.md and AGENTS.md → detection is ambiguous.
    mk("mixed/CLAUDE.md", "# CC\nRun `npm test`.\n");
    mk("mixed/AGENTS.md", "# Codex\nRun `make`.\n");

    // 3b. A repo that AUTO-DETECTS as claude-code (only a CLAUDE.md) but
    // config-DECLARES codex. Audit must honor the `.vigilesrc.json` `harnesses`
    // key (dogfood A: it used to ignore it and scan as Claude Code).
    mk("cfgharness/CLAUDE.md", "# CC file\nRun `npm test`.\n");
    mk(
      "cfgharness/.vigilesrc.json",
      JSON.stringify({ harnesses: { codex: {} } }),
    );

    // 4. A marketplace: a marketplace.json over two member plugins.
    mk(
      "mp/.claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { name: "alpha", source: "./plugins/alpha" },
          { name: "beta", source: "./plugins/beta" },
        ],
      }),
    );
    mk(
      "mp/plugins/alpha/skills/x/SKILL.md",
      `---\nname: x\ndescription: ${desc("x")}\n---\n# x\n`,
    );
    mk("mp/plugins/beta/.claude-plugin/plugin.json", '{"name":"beta"}\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("CC instruction-only repo: detects claude-code + reports the instruction file", () => {
    const r = run(`audit ${join(root, "normal")}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Detected harness: claude-code/);
    assert.match(
      r.stdout,
      /Instructions: CLAUDE\.md \(hand-written, no spec\)/,
    );
    // 🔴 The sentence CHANGED with #240, and this fixture is the case it is about:
    // a repo with an instruction file and zero skills/agents/commands. `no structural
    // issues found` read as "I checked and it is clean" when nothing had been checked.
    // Asserted in both directions — the honest sentence present, the misleading one
    // gone — because a test that only looks for the new text would still pass if both
    // were printed.
    assert.match(
      r.stdout,
      /nothing to check — 0 skills, 0 agents, 0 commands were read/,
    );
    assert.doesNotMatch(r.stdout, /no structural issues found/);
  });

  it("Codex repo: detects codex, reports AGENTS.md + skill + TOML MCP", () => {
    const r = run(`audit ${join(root, "codex")}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Detected harness: codex/);
    assert.match(
      r.stdout,
      /Instructions: AGENTS\.md \(hand-written, no spec\)/,
    );
    assert.match(r.stdout, /Skills \(1\)/);
    assert.match(r.stdout, /MCP servers: yes/); // read from the TOML [mcp_servers]
  });

  it("Codex repo: `lint` runs the layout-driven rules (hook token, untested) and reports subagent n/a", () => {
    // `lint` operates on cwd, so run it INSIDE the fixture. Proves the
    // deterministic rules use the resolved Codex adapter (layout + dialect), not a
    // hard-coded Claude Code default.
    const r = run("lint", join(root, "codexlint"));

    // hook-script-exists resolved the harness's ${PLUGIN_ROOT} token (loaded from
    // TOML [hooks]) and flagged the missing script.
    assert.match(r.stdout, /Hook-script existence check:/);
    assert.match(r.stdout, /missing\.sh.*missing/);

    // untested-skill found the skill under the layout's skill dir.
    assert.match(r.stdout, /Untested surfaces:/);
    assert.match(r.stdout, /foo/);

    // A subagent rule is configured, but Codex has no subagents → n/a, not a
    // false pass and not a crash.
    assert.match(r.stdout, /Subagent tool-contract check:/);
    assert.match(r.stdout, /n\/a — codex has no subagents/);
  });

  it("mixed repo: warns it matches both harnesses, and --harness overrides", () => {
    const auto = run(`audit ${join(root, "mixed")}`);
    assert.equal(auto.exitCode, 0);
    assert.match(auto.stdout, /Detected harness: claude-code/);
    // The ambiguity notice now flows through the SAME resolveHarnessSelection
    // path as lint/compile (dogfood A) — it names both harnesses and points at
    // the config key / --harness override.
    assert.match(auto.stdout, /repo matches claude-code, codex/);

    const forced = run(`audit ${join(root, "mixed")} --harness=codex`);
    assert.match(forced.stdout, /Detected harness: codex/);
    assert.doesNotMatch(forced.stdout, /repo matches/); // override silences it
  });

  it("an unknown --harness fails with a clean message, not a stack trace (dogfood C2)", () => {
    const r = run(`audit ${join(root, "normal")} --harness=bogus`);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Unknown harness "bogus"/);
    assert.match(r.stderr, /claude-code, codex/); // lists the known harnesses
    // A user-facing failure must NOT dump a Node stack trace.
    assert.doesNotMatch(r.stderr, /^\s+at .+\(.*\)/m);
  });

  it("honors the .vigilesrc.json `harnesses` key (audit no longer ignores config)", () => {
    // dogfood A: this repo auto-detects as claude-code (only a CLAUDE.md), but
    // config declares codex. Audit must scan as codex — before the fix it
    // ignored the declaration and reported claude-code. Config resolves from the
    // cwd (like `lint`), so run audit from INSIDE the fixture.
    const r = run("audit .", join(root, "cfgharness"));
    // Exit 2, not 0: scanned AS CODEX this fixture holds no AGENTS.md and no
    // codex surface, so there is nothing to measure — which `audit` now reports
    // as a distinct outcome instead of a silent grade F at exit 0. The harness
    // resolution (the point of this test) is unchanged and still printed.
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout, /Detected harness: codex/);
    // A single configured harness is unambiguous → no override notice.
    assert.doesNotMatch(r.stdout, /repo matches/);
  });

  it("marketplace root: expands members into a ranked leaderboard", () => {
    const r = run(`audit ${join(root, "mp")}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /2 plugins detected → leaderboard mode/);
    assert.match(
      r.stdout,
      /Full report for any plugin: npx vigiles audit <dir>/,
    );
    assert.match(r.stdout, /alpha/);
    assert.match(r.stdout, /beta/);
  });

  it("marketplace --json emits a versioned leaderboard envelope (not a bare array)", () => {
    // Regression: the leaderboard path used to print a raw, unversioned array,
    // inconsistent with the single-plugin AuditReport contract. Now it's a
    // versioned object with a `kind:"leaderboard"` discriminant + `plugins[]`.
    const r = run(`audit ${join(root, "mp")} --json`);
    assert.equal(r.exitCode, 0);
    const j = JSON.parse(r.stdout) as {
      meta: { tool: string; kind: string; schemaVersion: number };
      plugins: unknown[];
    };
    assert.equal(Array.isArray(j), false);
    assert.equal(j.meta.tool, "vigiles");
    assert.equal(j.meta.kind, "leaderboard");
    assert.equal(typeof j.meta.schemaVersion, "number");
    assert.equal(Array.isArray(j.plugins), true);
    assert.equal(j.plugins.length, 2);
  });

  it("curated marketplace (all external members): reports honestly, not 'empty'", () => {
    // obra/superpowers-marketplace, anthropics/claude-plugins-community shape —
    // every member is an external git/url plugin, nothing on disk.
    mk(
      "curated/.claude-plugin/marketplace.json",
      JSON.stringify({
        name: "curated",
        plugins: [
          { name: "p1", source: { source: "url", url: "https://x/1.git" } },
          { name: "p2", source: { source: "url", url: "https://x/2.git" } },
        ],
      }),
    );
    const r = run(`audit ${join(root, "curated")}`);
    // Exit 2, not 0. This directory was NOT measured, and this repo's own rule
    // is that 1 means "I measured, and it's bad" while 2 means "I could not do
    // what you asked". At exit 0 an unscanned repo was byte-indistinguishable
    // from a clean one, which is how a suppressed audit went unnoticed.
    assert.equal(r.exitCode, 2);
    const out = r.stdout + r.stderr;
    assert.match(out, /marketplace "curated": 2 plugin\(s\), all external/i);
    assert.match(out, /[Cc]lone a member plugin/);
    assert.doesNotMatch(out, /no structural issues found/);
    assert.doesNotMatch(out, /nothing was loaded/);
  });

  it("a directory that is BOTH a plugin and an external-member marketplace is still audited", () => {
    // nyldn/claude-octopus shape: `.claude-plugin/` holds a `marketplace.json`
    // whose only member points at a url, AND a `plugin.json` naming this very
    // directory — which also ships real surfaces. The marketplace listing is a
    // statement about OTHER directories; it must not suppress this one.
    mk(
      "selfmarket/.claude-plugin/marketplace.json",
      JSON.stringify({
        name: "selfmarket",
        plugins: [
          { name: "me", source: { source: "url", url: "https://x/me.git" } },
        ],
      }),
    );
    mk(
      "selfmarket/.claude-plugin/plugin.json",
      JSON.stringify({ name: "me", version: "0.1.0", description: "me" }),
    );
    mk(
      "selfmarket/agents/worker.md",
      "---\nname: worker\ndescription: A worker subagent used by this fixture.\ntools: Read\n---\nbody\n",
    );
    const r = run(`audit ${join(root, "selfmarket")}`);
    assert.equal(r.exitCode, 0);
    // The surfaces are reported, and a grade is produced.
    assert.match(r.stdout, /Agents \(1\)/);
    assert.match(r.stdout, /Harness health: [A-F]/);
    // And it is NOT mistaken for a curated marketplace with nothing to scan.
    assert.doesNotMatch(r.stdout + r.stderr, /nothing to audit/i);
  });

  it("--json emits the versioned AuditReport (harness + inventory)", () => {
    const r = run(`audit ${join(root, "codex")} --json`);
    assert.equal(r.exitCode, 0);
    const report = JSON.parse(r.stdout) as {
      meta: { schemaVersion: number; harness: string };
      inventory: { skills: number; mcp: boolean };
    };
    assert.equal(report.meta.schemaVersion, 2);
    assert.equal(report.meta.harness, "codex");
    assert.equal(report.inventory.skills, 1);
    assert.equal(report.inventory.mcp, true);
  });
});

// --- folded deterministic fixes in the default `audit` report (was --explain/--fix-plan)

describe("audit default — folds the deterministic fix into the report", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "audit-fixes-e2e-"));
    mkdirSync(join(root, "demo", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, "demo", ".claude-plugin", "plugin.json"),
      '{"name":"demo"}\n',
    );
    mkdirSync(join(root, "demo", "agents"), { recursive: true });
    // A subagent whose `tools:` names "Reed" — a close typo of the real "Read",
    // so it's silently dropped: the subagent-tool-contract cause, with a
    // did-you-mean fix the default report now surfaces inline.
    writeFileSync(
      join(root, "demo", "agents", "rev.md"),
      `---\nname: rev\ndescription: Reviews code changes for correctness and style across the whole repo here\ntools: Reed\n---\n# rev\nReview stuff.\n`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the default report carries the health score + the ranked FIX with the detector + one-line fix", () => {
    const r = run(`audit ${join(root, "demo")}`);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Harness health: [A-F] \(\d+\/100\)/);
    assert.match(r.stdout, /\[FIX\] rev/);
    assert.match(r.stdout, /\[subagent-tool-contract\]/);
    assert.match(r.stdout, /change the tool "Reed" to "Read"/);
  });

  it("--json emits the versioned AuditReport (the upload/CI contract)", () => {
    const r = run(`audit ${join(root, "demo")} --json`);
    assert.equal(r.exitCode, 0);
    const report = JSON.parse(r.stdout) as {
      meta: { schemaVersion: number; tool: string; dir: string };
      score: { overall: number; grade: string };
      recommendations: { surface: string }[];
    };
    assert.equal(report.meta.schemaVersion, 2);
    assert.equal(report.meta.tool, "vigiles");
    assert.ok(report.meta.dir, "meta.dir present");
    assert.ok(
      typeof report.score.overall === "number",
      "score.overall present",
    );
    assert.doesNotMatch(r.stdout, /\[FIX\]/);
  });
});

describe("audit report artifacts — auto-gitignore + --out", () => {
  it("writes the report to cwd and idempotently gitignores it (no init needed)", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-gi-e2e-"));
    try {
      writeFileSync(
        join(root, "CLAUDE.md"),
        "# Rules\n\n- Never use eval().\n",
      );
      writeFileSync(join(root, ".gitignore"), "node_modules/\n");
      execSync(`node ${CLI} audit . --no-open`, {
        cwd: root,
        encoding: "utf-8",
      });
      assert.ok(existsSync(join(root, "vigiles-report.json")), "json written");
      assert.ok(existsSync(join(root, "vigiles-report.html")), "html written");
      const gi = readFileSync(join(root, ".gitignore"), "utf-8");
      assert.match(gi, /^vigiles-report\.json$/m);
      assert.match(gi, /^vigiles-report\.html$/m);
      // idempotent — a second audit does not duplicate the entry
      execSync(`node ${CLI} audit . --no-open`, {
        cwd: root,
        encoding: "utf-8",
      });
      const gi2 = readFileSync(join(root, ".gitignore"), "utf-8");
      assert.equal((gi2.match(/^vigiles-report\.json$/gm) ?? []).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--out=<dir> writes to a custom dir and gitignores its relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-out-e2e-"));
    try {
      writeFileSync(
        join(root, "CLAUDE.md"),
        "# Rules\n\n- Never use eval().\n",
      );
      writeFileSync(join(root, ".gitignore"), "");
      execSync(`node ${CLI} audit . --out=reports --no-open`, {
        cwd: root,
        encoding: "utf-8",
      });
      assert.ok(existsSync(join(root, "reports", "vigiles-report.json")));
      assert.match(
        readFileSync(join(root, ".gitignore"), "utf-8"),
        /^reports\/vigiles-report\.json$/m,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit → adoption — adoptable-surfaces nudge + JSON data", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "audit-adopt-e2e-"));
    const demo = join(root, "demo");
    mkdirSync(join(demo, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(demo, ".claude-plugin", "plugin.json"),
      '{"name":"demo"}\n',
    );
    // A model-invocable skill with NO spec → both adoptable (no .spec.ts) and a
    // triggerable surface (described, not user-invoked) → the two nudges fire.
    mkdirSync(join(demo, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(demo, "skills", "deploy", "SKILL.md"),
      `---\nname: deploy\ndescription: Deploys the application to production environments reliably and safely here\n---\n# deploy\nDeploy stuff.\n`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the terminal audit prints the adoptable-surfaces nudge + a behavioral nudge", () => {
    const r = run(`audit ${join(root, "demo")}`);
    assert.equal(r.exitCode, 0);
    // The adoption nudge — value-framed (why a spec), with the per-surface command.
    assert.match(r.stdout, /could be spec-managed/);
    assert.match(r.stdout, /npx vigiles init/);
    assert.match(r.stdout, /--target=skills\/deploy\/SKILL\.md/);
    // The small behavioral "do your skills fire?" nudge.
    assert.match(r.stdout, /actually fire/);
    assert.match(r.stdout, /measureTriggerRate/);
  });

  it("--json carries adoptable surfaces + commands (no nudge text)", () => {
    const r = run(`audit ${join(root, "demo")} --json`);
    assert.equal(r.exitCode, 0);
    const report = JSON.parse(r.stdout) as {
      adoptable?: {
        createAllCommand: string;
        surfaces: { path: string; command: string }[];
      };
    };
    assert.ok(report.adoptable, "adoptable present in JSON");
    assert.equal(report.adoptable?.createAllCommand, "npx vigiles init");
    const paths = report.adoptable?.surfaces.map((s) => s.path) ?? [];
    assert.ok(
      paths.includes("skills/deploy/SKILL.md"),
      "the un-spec'd skill is adoptable",
    );
    const deploy = report.adoptable?.surfaces.find(
      (s) => s.path === "skills/deploy/SKILL.md",
    );
    assert.equal(
      deploy?.command,
      "npx vigiles init --target=skills/deploy/SKILL.md",
    );
    // JSON stays machine-clean — no human nudge text.
    assert.doesNotMatch(r.stdout, /could be spec-managed/);
    assert.doesNotMatch(r.stdout, /actually fire/);
  });
});

// --- generate-harness: the whole-harness typed registry ------------------------
//
// Drives the REAL built CLI to emit `harness.gen.ts` over a dir of real specs.
// The fixture lives UNDER the repo root and the CLI runs with cwd = repo root,
// so both `vigiles/spec` (the spec imports + the gen file's KnownAgentName) and
// the gen file's sibling `*.spec.ts` imports resolve. Covers the CLI wiring the
// library-level generate-harness.test.ts can't: spec loading, the duplicate
// non-zero exit, and the emitted file.
describe("generate-harness CLI", () => {
  const REPO = resolve(__dirname, "..");
  let dir = "";

  const PLANNER = `import { experimental_agent } from "vigiles/spec";\nconst { result } = experimental_agent;
export default experimental_agent({
  name: "planner",
  description: "Break the request into an ordered plan. Dispatch first.",
  tools: ["Read", "Grep", "Glob"],
  output: result({ steps: "string[]" }, { reason: "string" }),
});
`;
  const IMPLEMENTER = `import { experimental_agent } from "vigiles/spec";
export default experimental_agent({
  name: "implementer",
  description: "Implement the plan and prove the build passes.",
  tools: ["Read", "Edit", "Write", "Bash"],
});
`;

  beforeAll(() => {
    dir = mkdtempSync(join(REPO, ".tmp-genh-cli-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("emits harness.gen.ts over a dir of specs (exit 0)", () => {
    writeFileSync(join(dir, "planner.spec.ts"), PLANNER);
    writeFileSync(join(dir, "implementer.spec.ts"), IMPLEMENTER);
    writeFileSync(
      join(dir, "ship.spec.ts"),
      `import { experimental_agent } from "vigiles/spec";\nconst { railway, delegate } = experimental_agent;
export default railway({ name: "ship", steps: [delegate("planner"), delegate("implementer")] });
`,
    );
    const out = join(dir, "harness.gen.ts");
    const r = run(`generate harness ${dir} ${out}`, REPO);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.ok(existsSync(out));
    const gen = readFileSync(out, "utf-8");
    assert.match(gen, /export const registry =/);
    assert.match(gen, /export type AgentName =/);
    assert.match(gen, /_edge_0: KnownAgentName<"planner", AgentName, "ship">/);
    assert.match(gen, /export const harnessCapabilities =/);
    // --check on the just-written file is a no-op (up to date)
    const chk = run(`generate harness ${dir} ${out} --check`, REPO);
    assert.equal(chk.exitCode, 0);
    assert.match(chk.stdout, /up to date/);
  });

  it("exits non-zero on a duplicate agent name", () => {
    const dupDir = mkdtempSync(join(REPO, ".tmp-genh-dup-"));
    try {
      writeFileSync(join(dupDir, "a.spec.ts"), PLANNER);
      writeFileSync(
        join(dupDir, "b.spec.ts"),
        PLANNER.replace("Break the request", "A second planner colliding"),
      );
      const r = run(
        `generate harness ${dupDir} ${join(dupDir, "harness.gen.ts")}`,
        REPO,
      );
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stdout, /duplicate agent name "planner"/);
      assert.ok(!existsSync(join(dupDir, "harness.gen.ts")));
    } finally {
      rmSync(dupDir, { recursive: true, force: true });
    }
  });
});

// --- compile keeps an existing harness.gen.ts fresh ----------------------------
//
// The whole-harness registry tracks specs as a side effect of `compile`, so the
// user never hand-runs `generate-harness`. Opt-in: compile refreshes a registry
// that already exists (committed like a lockfile), never imposes one.
describe("compile refreshes harness.gen.ts", () => {
  const REPO = resolve(__dirname, "..");
  const SPECS: Record<string, string> = {
    "planner.md.spec.ts": `import { experimental_agent } from "vigiles/spec";\nconst { result } = experimental_agent;
export default experimental_agent({ name: "planner", description: "Break the request into an ordered plan. Dispatch first.", tools: ["Read", "Grep", "Glob"], output: result({ steps: "string[]" }, { reason: "string" }) });
`,
    "implementer.md.spec.ts": `import { experimental_agent } from "vigiles/spec";
export default experimental_agent({ name: "implementer", description: "Implement the plan and prove the build passes.", tools: ["Read", "Edit", "Write", "Bash"] });
`,
    "ship.md.spec.ts": `import { experimental_agent } from "vigiles/spec";\nconst { railway, delegate } = experimental_agent;
export default railway({ name: "ship", steps: [delegate("planner"), delegate("implementer")] });
`,
  };

  function seed(): string {
    const dir = mkdtempSync(join(REPO, ".tmp-compile-genh-"));
    for (const [name, src] of Object.entries(SPECS))
      writeFileSync(join(dir, name), src);
    return dir;
  }

  it("refreshes a STALE harness.gen.ts on compile", () => {
    const dir = seed();
    try {
      const out = join(dir, "harness.gen.ts");
      writeFileSync(out, "// stale\n");
      const r = run("compile", dir);
      assert.equal(r.exitCode, 0, r.stdout);
      const gen = readFileSync(out, "utf-8");
      assert.match(gen, /export const registry =/);
      assert.match(gen, /KnownAgentName<"planner"/);
      assert.match(r.stdout, /refreshed harness\.gen\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT create harness.gen.ts when absent (opt-in)", () => {
    const dir = seed();
    try {
      const r = run("compile", dir);
      assert.equal(r.exitCode, 0, r.stdout);
      assert.ok(!existsSync(join(dir, "harness.gen.ts")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- scan --capability-diff e2e (the moat #2 PR-comment surface) ---------------

describe("scan --capability-diff e2e", () => {
  // before: a read-only worker; after: the same worker GAINS Bash (blast radius up).
  function versions(): { before: string; after: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "vigiles-capdiff-"));
    const mk = (sub: string, tools: string) => {
      const dir = join(root, sub);
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(dir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "demo" }),
      );
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "worker.md"),
        `---\nname: worker\ndescription: A worker agent\ntools: ${tools}\n---\nbody\n`,
      );
      return dir;
    };
    return {
      before: mk("before", "Read, Grep"),
      after: mk("after", "Read, Grep, Bash"),
      root,
    };
  }

  it("flags a widened blast radius and exits 0 by default (informational)", () => {
    const { before, after, root } = versions();
    try {
      const r = run(`audit ${after} --capability-diff=${before}`);
      assert.equal(r.exitCode, 0, "widening is informational by default");
      assert.match(r.stdout, /WIDENED/);
      assert.match(r.stdout, /side-effecting: Bash/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 on a widening with --fail-on-widen (the opt-in CI gate)", () => {
    const { before, after, root } = versions();
    try {
      const r = run(
        `audit ${after} --capability-diff=${before} --fail-on-widen`,
      );
      assert.equal(r.exitCode, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports no change when the surface is identical", () => {
    const { after, root } = versions();
    try {
      const r = run(
        `audit ${after} --capability-diff=${after} --fail-on-widen`,
      );
      assert.equal(r.exitCode, 0, "no widening → no gate trip");
      assert.match(r.stdout, /unchanged/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// audit → read-vs-run (env-gated; deterministic via explicit env). A plain
// `audit` is a deterministic READ; the executing checks are opt-in. These run
// non-TTY (execSync pipes), so they're headless — `audit` never PROMPTS, it
// stays a read + a loud nudge. The interactive ask-once path is unit-tested via
// decideExecute.
// ---------------------------------------------------------------------------

describe("audit: read-vs-run (executing checks are opt-in)", () => {
  let dir: string;
  const MODEL_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ];

  function runEnv(
    args: string,
    env: Record<string, string | undefined>,
  ): string {
    // Start from a copy with all model-access signals stripped, then apply env.
    const base: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!(MODEL_ENV_KEYS as readonly string[]).includes(k)) base[k] = v;
    }
    try {
      return execSync(`node ${CLI} ${args}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        cwd: dir,
        env: { ...base, ...env } as NodeJS.ProcessEnv,
      });
    } catch (e: unknown) {
      return (e as { stdout?: string }).stdout ?? "";
    }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-scan-nudge-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "nudge-demo" }),
    );
    mkdirSync(join(dir, "skills", "do-thing"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "do-thing", "SKILL.md"),
      "---\nname: do-thing\ndescription: Does a thing when the user asks to do the thing.\n---\n\nBody.\n",
    );
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a headless run stays a READ + a nudge (points to interactive + the API, no flag)", () => {
    const out = runEnv("audit .", { CLAUDECODE: "1" });
    assert.ok(out.includes("Executing checks"), "read-vs-run nudge");
    assert.ok(out.includes("interactively"), "points at the interactive path");
    assert.ok(!out.includes("--measure"), "no execution flag exists");
  });

  it("the nudge is model-agnostic — it's about execution, shown with or without a model", () => {
    const out = runEnv("audit .", {}); // all model signals stripped
    assert.ok(out.includes("Executing checks"), "nudge still shown");
  });

  it("stays silent under --json (machine output — no human nudge)", () => {
    const out = runEnv("audit . --json", { CLAUDECODE: "1" });
    assert.ok(!out.includes("Executing checks"), "no nudge in json mode");
  });

  it("--no-interactive never prompts (loud nudge only)", () => {
    const out = runEnv("audit . --no-interactive", { CLAUDECODE: "1" });
    assert.ok(out.includes("Executing checks"), "nudge shown, not a prompt");
  });
});

// ---------------------------------------------------------------------------
// Health-score header in default single-dir scan output
// ---------------------------------------------------------------------------

describe("scan default output — health score header", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "scan-score-"));
    // A clean plugin — CLAUDE.md + one well-formed skill (nothing broken).
    mkdirSync(join(root, "skills", "greet"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# Project\nRun the build.\n");
    writeFileSync(
      join(root, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets the user warmly with a personalised message\n---\nGreet them.\n",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints a Harness health: <grade> (<score>/100) line before the report", () => {
    const r = run(`audit ${root}`);
    assert.equal(r.exitCode, 0);
    // The score header must appear.
    assert.match(r.stdout, /Harness health: [A-F] \(\d+\/100\)/);
    // The report body still follows.
    assert.match(r.stdout, /Scan:/);
  });

  it("score header is absent under --json (machine output)", () => {
    const r = run(`audit ${root} --json`);
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /Harness health:/);
    // But the JSON still parses as the versioned AuditReport.
    const report = JSON.parse(r.stdout) as { meta: { dir: string } };
    assert.ok(report.meta.dir, "json has meta.dir");
  });

  it("a plain (headless) audit is a deterministic read — nothing executes", () => {
    // A plain audit is a READ; the executing checks (live MCP + skill firing) are
    // opt-in. `root` ships a skill, so a headless run nudges toward them but runs
    // nothing. There is no safety battery in `audit` at all (it's a testing-API
    // capability now), so its section never appears.
    const r = run(`audit ${root}`);
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.stdout, /Safety battery/);
    assert.match(r.stdout, /Executing checks/);
  });
});

// ---------------------------------------------------------------------------
// Default artifacts: vigiles-report.html + vigiles-report.json (the upload boundary)
// ---------------------------------------------------------------------------

describe("audit default artifacts (html + json) written to cwd", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "audit-artifacts-"));
    mkdirSync(join(root, "skills", "greet"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    writeFileSync(
      join(root, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets the user warmly with a personalised message\n---\nGreet.\n",
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Run with cwd INSIDE the tmp dir (raw, not the suppressing `run` helper) so the
  // artifacts land in tmp (cleaned), and assert both are written + valid.
  it("writes a self-contained HTML report and a versioned JSON artifact", () => {
    execSync(`node ${CLI} audit .`, { cwd: root, encoding: "utf-8" });
    const html = join(root, "vigiles-report.html");
    const jsonPath = join(root, "vigiles-report.json");
    assert.ok(existsSync(html), "vigiles-report.html written");
    assert.ok(existsSync(jsonPath), "vigiles-report.json written");
    assert.match(readFileSync(html, "utf-8"), /^<!doctype html>/);
    const report = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      meta: { schemaVersion: number; generatedAt?: string };
      score: { overall: number };
    };
    assert.equal(report.meta.schemaVersion, 2);
    assert.ok(report.meta.generatedAt, "json artifact is timestamped");
    assert.ok(typeof report.score.overall === "number");
  });

  it("--no-html --no-json suppresses both", () => {
    rmSync(join(root, "vigiles-report.html"), { force: true });
    rmSync(join(root, "vigiles-report.json"), { force: true });
    execSync(`node ${CLI} audit . --no-html --no-json`, {
      cwd: root,
      encoding: "utf-8",
    });
    assert.ok(!existsSync(join(root, "vigiles-report.html")), "no html");
    assert.ok(!existsSync(join(root, "vigiles-report.json")), "no json");
  });
});

describe("lint scopes surface checks to an explicit directory (P0-2)", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vig-lint-scope-"));
    // pkgA ships a subagent with a typo'd tool → subagent-tool-contract fires.
    mkdirSync(join(repo, "pkgA", "agents"), { recursive: true });
    writeFileSync(
      join(repo, "pkgA", "agents", "bad.md"),
      "---\nname: bad\ndescription: A reviewer subagent for pkgA here\ntools: Reat\n---\nReview.\n",
    );
    // pkgB is clean.
    mkdirSync(join(repo, "pkgB", "agents"), { recursive: true });
    writeFileSync(
      join(repo, "pkgB", "agents", "ok.md"),
      "---\nname: ok\ndescription: A clean reviewer subagent for pkgB here\ntools: Read\n---\nReview.\n",
    );
    writeFileSync(
      join(repo, ".vigilesrc.json"),
      JSON.stringify({ rules: { "subagent-tool-contract": "warn" } }),
    );
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lint pkgA reports pkgA's typo'd subagent tool", () => {
    const r = run("lint pkgA", repo);
    assert.match(r.stdout, /Reat/, "the scoped dir's own issue is reported");
  });

  it("lint pkgB does NOT leak pkgA's issue (scoped away)", () => {
    const r = run("lint pkgB", repo);
    assert.ok(
      !/Reat/.test(r.stdout),
      "a surface outside the passed dir must never enter the report",
    );
  });
});

describe("lint of a foreign repo does not satisfy target refs from the caller's cwd", () => {
  let caller: string;
  let target: string;
  beforeAll(() => {
    // The CALLER's repo declares sharedDirs and HAS scripts/foo.py.
    caller = mkdtempSync(join(tmpdir(), "vig-caller-"));
    mkdirSync(join(caller, "scripts"), { recursive: true });
    writeFileSync(join(caller, "scripts", "foo.py"), "# caller's file\n");
    writeFileSync(
      join(caller, ".vigilesrc.json"),
      JSON.stringify({
        sharedDirs: ["scripts"],
        rules: { "skill-resource-resolves": "warn" },
      }),
    );
    // The TARGET repo (elsewhere) has a skill referencing scripts/foo.py, which
    // is MISSING in the target. The caller's file must not satisfy it.
    target = mkdtempSync(join(tmpdir(), "vig-target-"));
    mkdirSync(join(target, "skills", "rca"), { recursive: true });
    writeFileSync(
      join(target, "skills", "rca", "SKILL.md"),
      "---\nname: rca\ndescription: references a shared script\n---\nRun `scripts/foo.py`.\n",
    );
  });
  afterAll(() => {
    rmSync(caller, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("flags the target's missing scripts/foo.py (not satisfied by the caller's copy)", () => {
    const r = run(`lint ${target}`, caller);
    assert.match(
      r.stdout,
      /foo\.py/,
      "a foreign-repo lint resolves shared refs against the TARGET, not the caller's cwd",
    );
  });
});

describe("audit share-link only for a whole-repo audit (Codex review)", () => {
  it("suppresses the share link for a SUBDIRECTORY audit (parent origin ≠ audited target)", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-sharelink-"));
    try {
      // A git repo with a github origin; the plugin lives in a subdir.
      execSync(
        "git init -q && git remote add origin https://github.com/foo/bar.git",
        {
          cwd: root,
          stdio: "ignore",
        },
      );
      writeFileSync(join(root, "CLAUDE.md"), "# repo root\nRun the build.\n");
      mkdirSync(join(root, "plugin"), { recursive: true });
      writeFileSync(
        join(root, "plugin", "CLAUDE.md"),
        "# plugin\nRun tests.\n",
      );

      // Whole-repo audit (target IS the git toplevel) → the share link is shown.
      const whole = run("audit .", root);
      assert.match(whole.stdout, /Share this grade → .*foo\/bar/);

      // Subdir audit → git origin belongs to the PARENT, so the owner/repo link
      // would rerun a different audit → suppressed.
      const sub = run("audit plugin", root);
      assert.doesNotMatch(sub.stdout, /Share this grade/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Argument handling: refuse what we didn't understand ──────────────────────
// MEASURED before the fix:
//   $ npx vigiles audit --this-flag-does-not-exist
//   Detected harness: claude-code … a complete audit … EXIT=0
// audit's flags decide what LEAVES the machine (--no-html, --no-json, --out=,
// --serve), so `--no-htlm` silently wrote the HTML report the author believed
// they had suppressed.

describe("unknown flags are refused, not swallowed", () => {
  it("audit: an unknown flag stops the run with a non-zero exit and names it", () => {
    const r = run("audit --this-flag-does-not-exist");
    assert.equal(r.exitCode, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown flag "--this-flag-does-not-exist"/);
    assert.doesNotMatch(
      r.stdout,
      /Detected harness/,
      "nothing may run before the argument is understood",
    );
  });

  it("audit: a TYPO of a real flag suggests the real one", () => {
    const r = run("audit --no-htlm");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Did you mean `--no-html`\?/);
  });

  it("the hole is closed on every verb, not only audit", () => {
    // Run from a THROWAWAY cwd. If this guard ever regresses, `init
    // --definitely-not-a-flag` runs a real `vigiles init`, which writes specs, a
    // workflow and a config into whatever directory the test happened to be in —
    // observed once, in this repo, while proving the fix by reverting it.
    const sandbox = mkdtempSync(join(tmpdir(), "scan-flags-"));
    try {
      for (const verb of ["lint", "test", "eval", "compile", "eject", "init"]) {
        const r = run(`${verb} --definitely-not-a-flag`, sandbox);
        assert.equal(
          r.exitCode,
          2,
          `${verb} accepted an unknown flag: ${r.stdout}${r.stderr}`,
        );
        assert.match(r.stderr, /unknown flag "--definitely-not-a-flag"/);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("real flags still work (the fix must not over-reject)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-flagok-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# repo\nRun `npm test`.\n");
      const audit = run(`audit ${dir} --no-open --harness=claude-code`);
      assert.equal(audit.exitCode, 0, audit.stdout + audit.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("`vigiles <verb> --help` prints help instead of running the verb", () => {
  it("audit --help does not audit", () => {
    const r = run("audit --help");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /vigiles audit \[dir\.\.\.\]/);
    assert.match(r.stdout, /^Flags: /m);
    assert.doesNotMatch(
      r.stdout,
      /Detected harness/,
      "asking what a flag is called must not run the command",
    );
  });

  it("every verb answers --help", () => {
    // Same throwaway cwd for the same reason: a regression here means the verb
    // RUNS, and `init` running is a side effect on whatever dir we are in.
    const sandbox = mkdtempSync(join(tmpdir(), "scan-help-"));
    try {
      for (const verb of ["init", "compile", "eject", "lint", "test", "eval"]) {
        const r = run(`${verb} --help`, sandbox);
        assert.equal(r.exitCode, 0, `${verb} --help: ${r.stderr}`);
        assert.match(r.stdout, new RegExp(`vigiles ${verb}`));
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("`nothing to audit here` is a distinct outcome, not a grade of F", () => {
  // The measured trap: `vigiles audit --json /some/path` — `--json` takes no
  // value, so the PATH became the positional scan dir, the audit ran over a
  // directory with no harness, and printed `skills: 0`, grade F, EXIT 0. That is
  // indistinguishable from a real audit of a repo that scores badly.
  it("an empty target exits non-zero and says there was nothing to measure", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-empty-"));
    try {
      const r = run(`audit ${root}`);
      assert.equal(r.exitCode, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /nothing to audit in/);
      assert.match(r.stderr, /NOT a grade/);
      assert.doesNotMatch(
        r.stdout,
        /Overall|Grade/i,
        "no score may be printed for a target that was never measurable",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a real-but-bad harness still grades, and still exits 0", () => {
    // The other side of the distinction: `audit` remains a read, so a repo that
    // scores badly is NOT an error — only "there was nothing here" is.
    const root = mkdtempSync(join(tmpdir(), "scan-bad-"));
    try {
      writeFileSync(join(root, "CLAUDE.md"), "# repo\nSee docs/nope.md\n");
      const r = run(`audit ${root}`);
      assert.equal(r.exitCode, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /nothing to audit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--json still emits the report for an empty target (machine contract kept)", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-empty-json-"));
    try {
      const r = run(`audit --json ${root}`);
      assert.equal(r.exitCode, 2);
      const parsed = JSON.parse(r.stdout) as { score: { empty: boolean } };
      assert.equal(parsed.score.empty, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a path that does not EXIST says so, instead of 'no surface was found'", () => {
    // A directory that isn't there and a directory with nothing in it are
    // different facts, and only one of them is about the repo's harness. The
    // exit code was already 2; the wording made a typo'd dir in a multi-dir
    // leaderboard run read as a legitimately empty repo.
    const missing = join(tmpdir(), "vigiles-definitely-absent-xyz123");
    const r = run(`audit ${missing}`);
    assert.equal(r.exitCode, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /does not exist/);
    assert.doesNotMatch(
      r.stderr,
      /no claude-code surface .* was found there/,
      "a nonexistent path was never looked at, so nothing was 'found there'",
    );
  });
});

describe("the flag registry and the help text can't drift apart", () => {
  it("every flag the help text advertises is accepted by some verb", () => {
    // The registry is derived from what the HANDLERS read. This is the other
    // direction: a flag we document but forgot to register would now be
    // rejected in a user's face, so fail here instead.
    const help = run("--help").stdout;
    const advertised = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
    // Top-level, handled before dispatch (not a verb flag).
    advertised.delete("--version");
    const accepted = new Set<string>();
    for (const verb of VERBS)
      for (const spec of knownFlagsFor(verb))
        accepted.add(spec.endsWith("=") ? spec.slice(0, -1) : spec);
    const missing = [...advertised].filter((f) => !accepted.has(f));
    assert.deepEqual(
      missing,
      [],
      `documented but unregistered: ${String(missing)}`,
    );
  });
});

/**
 * 🔴 A COVERAGE CAVEAT THAT ONLY `lint` PRINTS IS A CAVEAT NOBODY READS.
 *
 * `formatUntestedReport` (the `lint` renderer) gained two qualifier lines — the
 * retired `vigiles:covers` marker, and a run record older than the text it
 * measured. `audit` assembles its own fact block from the SAME report and
 * carried neither, so the note that exists to explain a silent migration was
 * itself silent for anyone whose habit is `audit`. Measured 2026-08-18 before
 * the fix: `lint` named the file, `audit` printed `Untested surfaces: 0`.
 *
 * Both halves, because an advisory line cannot be noticed missing: it FIRES on a
 * repo that has the marker, and is SILENT on one that does not.
 */
describe("audit carries the coverage caveats, not just lint", () => {
  const skill = (name: string): string =>
    `---\nname: ${name}\ndescription: A skill ${name} that does varied work across many different cases here\n---\n\n# ${name}\n`;

  it("names a test file still carrying the retired `vigiles:covers` marker", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-caveat-"));
    try {
      mkdirSync(join(root, ".claude/skills/foo"), { recursive: true });
      writeFileSync(join(root, ".claude/skills/foo/SKILL.md"), skill("foo"));
      writeFileSync(
        join(root, ".claude/skills/foo/foo.harness.mjs"),
        "// vigiles:covers skills/foo\n",
      );
      const r = run(`audit ${root}`);
      assert.match(r.stdout, /still carry the retired `vigiles:covers` marker/);
      assert.match(r.stdout, /foo\.harness\.mjs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says nothing extra about coverage when there is nothing to say", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-caveat-clean-"));
    try {
      mkdirSync(join(root, ".claude/skills/foo"), { recursive: true });
      writeFileSync(join(root, ".claude/skills/foo/SKILL.md"), skill("foo"));
      writeFileSync(
        join(root, ".claude/skills/foo/foo.harness.mjs"),
        "console.log('ok');\n",
      );
      const r = run(`audit ${root}`);
      assert.doesNotMatch(r.stdout, /vigiles:covers/);
      assert.doesNotMatch(r.stdout, /measured, but not this version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The same list, one caveat later. `retiredTestNames` was added to
 * `coverageCaveats` and wired nowhere else; this asserts it reached the product
 * — `audit`, not just `lint` — because "it is on the shared list, so it must
 * render" is the reasoning that lost the other two caveats for a release.
 */
describe("a newly added coverage caveat reaches audit through the shared list", () => {
  it("names a `<surface>.test.*` sitting beside an untested skill", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-retired-suffix-"));
    try {
      mkdirSync(join(root, ".claude/skills/foo"), { recursive: true });
      writeFileSync(
        join(root, ".claude/skills/foo/SKILL.md"),
        `---\nname: foo\ndescription: A skill foo that does varied work across many different cases here\n---\n\n# foo\n`,
      );
      writeFileSync(
        join(root, ".claude/skills/foo/foo.test.mjs"),
        "// a skill test, misnamed\n",
      );
      const r = run(`audit ${root}`);
      assert.match(r.stdout, /foo\.test\.mjs/);
      assert.match(r.stdout, /vitest\/jest/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
