#!/usr/bin/env node
/**
 * Measure what Anthropic's `claude plugin validate` ACTUALLY checks — by planting
 * known defects and running it, rather than reading its docs.
 *
 * WHY THIS EXISTS. The landing page used to open with "Nothing checks that the
 * tools, events, files and rules your skills and hooks name actually exist."
 * Nobody had run the other tool. When someone finally did (2026-09-08), the
 * sentence turned out to be wrong in one narrow place and the internal note that
 * was going to REPLACE it was wrong in five — it credited `validate` with
 * checking tool names, hook scripts, MCP servers and model values, none of which
 * it does. Both errors came from the same habit: sourcing a claim about another
 * tool from prose about that tool. This script is the alternative.
 *
 * Same shape and reason as `measure-hook-matcher-semantics.mjs`: ground truth
 * about someone else's product, measured, so a claim on a public page cites a
 * command instead of a memory.
 *
 * NOT IN CI, deliberately. It runs a third-party binary whose behaviour is the
 * variable under test — a red build here would mean "Anthropic shipped a
 * release", which is not a defect in this repo. Run it by hand.
 *
 * RUN WHEN: before publishing any claim about what `claude plugin validate` does
 * or does not catch, and whenever Claude Code ships a new minor. The hook-EVENT
 * row is the one most likely to grow — it is the only row that already passes,
 * so it is the direction the tool is evidently moving.
 *
 * Usage:  node tools/measure-validate-overlap.mjs
 * Needs:  `claude` on PATH. Writes only to a temp dir. Makes no network call.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The planted defects. Each is a thing vigiles reports; the question is whether
 *  `claude plugin validate` reports it too. */
const DEFECTS = [
  "skill declares a tool that does not exist (`Bahs`)",
  "skill declares an undeclared MCP server (`mcp__ghost__thing`)",
  "subagent declares a typo'd tool (`Grpe`)",
  "subagent declares a never-available tool (`AskUserQuestion`)",
  "subagent declares a typo'd model (`sonnnet`)",
  "hook command names a script that does not exist",
  "hook is registered on a typo'd event (`PreToolUze`)",
];

const HOOKS = {
  PreToolUze: [
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/ghost.sh",
        },
      ],
    },
  ],
};

const SKILL = `---
name: demo
description: a skill declaring a tool that does not exist and an undeclared MCP server
allowed-tools: Read, Bahs, mcp__ghost__thing
---
Body.
`;

const AGENT = `---
name: rev
description: a subagent with a typo'd tool, a never-available tool, and a typo'd model
tools: Read, Grpe, AskUserQuestion
model: sonnnet
---
Review it.
`;

/** Build one fixture carrying ALL seven defects, in one of the two shapes a real
 *  user has: a repo-local `.claude/` harness, or a packaged plugin. The shape is
 *  load-bearing — the two do not score the same. */
function build(root, shape) {
  const base = shape === "plugin" ? root : join(root, ".claude");
  mkdirSync(join(base, "skills", "demo"), { recursive: true });
  mkdirSync(join(base, "agents"), { recursive: true });
  writeFileSync(join(base, "skills", "demo", "SKILL.md"), SKILL);
  writeFileSync(join(base, "agents", "rev.md"), AGENT);

  if (shape === "plugin") {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "probe",
          description: "d",
          version: "0.0.1",
          author: { name: "t" },
          hooks: HOOKS,
        },
        null,
        2,
      ),
    );
  } else {
    writeFileSync(
      join(base, "settings.json"),
      JSON.stringify({ hooks: HOOKS }, null, 2),
    );
  }
  return root;
}

function run(dir, strict) {
  const args = ["plugin", "validate", dir, ...(strict ? ["--strict"] : [])];
  try {
    return execFileSync("claude", args, { encoding: "utf8" });
  } catch (e) {
    // A non-zero exit is a RESULT here, not a failure of the probe.
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const version = execFileSync("claude", ["--version"], {
  encoding: "utf8",
}).trim();
const tmp = mkdtempSync(join(tmpdir(), "vigiles-validate-probe-"));

console.log(`claude --version → ${version}`);
console.log(`\nPlanted in EVERY fixture:`);
for (const d of DEFECTS) console.log(`  · ${d}`);

try {
  for (const shape of ["plain", "plugin"]) {
    const dir = build(join(tmp, shape), shape);
    for (const strict of [false, true]) {
      const label = `${shape}${strict ? " --strict" : ""}`;
      const out = run(dir, strict);
      const findings = out
        .split("\n")
        .filter((l) => l.trim().startsWith(">"))
        .map((l) => l.trim().replace(/^>\s*/, ""));
      console.log(`\n===== ${label} =====`);
      console.log(
        findings.length === 0
          ? "  (no findings — all seven planted defects passed)"
          : findings.map((f) => `  FLAGGED: ${f}`).join("\n"),
      );
    }
  }

  console.log(`
DISCRIMINATOR — silence only counts once you have shown the tool speaks.
Confirmed against 2.1.263 by separate probes, so the passes above are real
passes and not a surface it never opened:
  · invalid manifest JSON            → errors
  · hooks.json missing its root key  → errors
  · agent with no description        → warns
  · a manifest hook on a REAL event  → passes (verified with \`Setup\`, which IS
    a documented Claude Code event; \`PreToolUze\` and \`Sesion\` both warn)
`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
