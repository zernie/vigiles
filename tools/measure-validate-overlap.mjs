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
 * ONE FIXTURE PER CASE (changed 2026-09-09). The first version planted all seven
 * defects in ONE fixture and printed the findings as a set. That answers "how
 * many of the seven?" and nothing else: with a non-empty result you cannot say
 * WHICH defect produced it, so no per-defect cell can be sourced from it. Each
 * case now builds its own isolated fixture, so every verdict is attributable to
 * exactly one planted defect. The original combined fixture survives as the
 * `all-at-once` case, so the 0/7 and 1/7 figures already published stay
 * reproducible by this same script.
 *
 * FAIRNESS — WHAT IS NOT ASKED. Only defects a general plugin validator could
 * reasonably be expected to catch are planted. vigiles rules about vigiles's OWN
 * artifacts (its SHA integrity stamp, `.spec.ts` adoption, `untested-*` coverage,
 * doc refs) are deliberately absent: asking another product whether it checks our
 * hash is a rigged row, and `gate-first-adoption` requires grading others fairly.
 *
 * NOT IN CI, deliberately. It runs a third-party binary whose behaviour is the
 * variable under test — a red build here would mean "Anthropic shipped a
 * release", which is not a defect in this repo. Run it by hand.
 *
 * RUN WHEN: before publishing any claim about what `claude plugin validate` does
 * or does not catch, and whenever Claude Code ships a new minor.
 *
 * Usage:  node tools/measure-validate-overlap.mjs [--json <path>]
 * Needs:  `claude` on PATH. Writes only to a temp dir (and <path> with --json).
 *         Makes no network call.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const GHOST_HOOK = (event) => ({
  [event]: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/ghost.sh" },
      ],
    },
  ],
});

const skill = (body, name = "demo") => ({ kind: "skill", name, body });
const agent = (body, name = "rev") => ({ kind: "agent", name, body });

/**
 * The planted defects. `rule` names the vigiles rule that reports the same thing,
 * so a consumer can join this snapshot to `src/core/rule-meta.ts` by key rather
 * than by matching prose.
 */
const CASES = [
  {
    id: "skill-tool-does-not-exist",
    rule: "subagent-tool-contract",
    what: "a skill declares a tool that does not exist (`Bahs`)",
    files: [
      skill(
        "---\nname: demo\ndescription: declares a tool that does not exist\nallowed-tools: Read, Bahs\n---\nBody.\n",
      ),
    ],
  },
  {
    id: "skill-undeclared-mcp-server",
    rule: "mcp-tool-resolves",
    what: "a skill names an MCP server the plugin never declares (`mcp__ghost__thing`)",
    files: [
      skill(
        "---\nname: demo\ndescription: names an undeclared MCP server\nallowed-tools: Read, mcp__ghost__thing\n---\nBody.\n",
      ),
    ],
  },
  {
    id: "subagent-typod-tool",
    rule: "subagent-tool-contract",
    what: "a subagent declares a typo'd tool (`Grpe`)",
    files: [
      agent(
        "---\nname: rev\ndescription: declares a typo'd tool\ntools: Read, Grpe\n---\nReview it.\n",
      ),
    ],
  },
  {
    id: "subagent-never-available-tool",
    rule: "subagent-tool-contract",
    what: "a subagent declares a tool a subagent can never have (`AskUserQuestion`)",
    files: [
      agent(
        "---\nname: rev\ndescription: declares a never-available tool\ntools: Read, AskUserQuestion\n---\nReview it.\n",
      ),
    ],
  },
  {
    id: "subagent-typod-model",
    rule: "subagent-frontmatter",
    what: "a subagent declares a typo'd model (`sonnnet`) — silently falls back",
    files: [
      agent(
        "---\nname: rev\ndescription: declares a typo'd model\ntools: Read\nmodel: sonnnet\n---\nReview it.\n",
      ),
    ],
  },
  {
    id: "subagent-missing-frontmatter",
    rule: "subagent-frontmatter",
    what: "a subagent with no name/description — cannot register at all",
    files: [agent("Just prose, no frontmatter block at all.\n")],
  },
  {
    id: "subagent-disallowed-tools-typo",
    rule: "disallowed-tools-contract",
    what: "a subagent's deny-list entry is a typo (`Bahs`) — so it blocks nothing",
    files: [
      agent(
        "---\nname: rev\ndescription: deny-list entry is a typo\ntools: Read, Bash\ndisallowedTools: Bahs\n---\nReview it.\n",
      ),
    ],
  },
  {
    id: "hook-typod-event",
    rule: "hook-events",
    what: "a hook is registered on a typo'd event (`PreToolUze`) — never fires",
    hooks: GHOST_HOOK("PreToolUze"),
    files: [],
  },
  {
    id: "hook-script-missing",
    rule: "hook-script-exists",
    what: "a hook command names a script that is not on disk — silently runs nothing",
    hooks: GHOST_HOOK("PreToolUse"),
    files: [],
  },
  {
    id: "skill-malformed-frontmatter",
    rule: "frontmatter-valid",
    what: "a skill's `---` block exists but is not valid YAML",
    files: [
      skill(
        "---\nname: demo\ndescription: unbalanced [ bracket: and: colons\nallowed-tools: [Read\n---\nBody.\n",
      ),
    ],
  },
  {
    id: "skill-missing-frontmatter",
    rule: "skill-frontmatter",
    what: "a skill with no name/description — falls back to dir name + first paragraph",
    files: [skill("Just prose, no frontmatter block at all.\n")],
  },
  {
    id: "skill-description-overlap",
    rule: "description-overlap",
    what: "two model-invocable skills with near-identical descriptions — the selector cannot tell them apart",
    files: [
      skill(
        "---\nname: alpha\ndescription: Review the changed code for bugs and correctness problems before merging\n---\nBody.\n",
        "alpha",
      ),
      skill(
        "---\nname: beta\ndescription: Review the changed code for bugs and correctness issues before merging\n---\nBody.\n",
        "beta",
      ),
    ],
  },
  {
    id: "skill-resource-missing",
    rule: "skill-resource-resolves",
    what: "a skill body links a file that is not on disk",
    files: [
      skill(
        "---\nname: demo\ndescription: links a resource that does not exist\n---\nSee [the reference](./reference.md) for details.\n",
      ),
    ],
  },
  {
    id: "all-at-once",
    rule: "(combined)",
    what: "the original seven-defects-in-one-fixture run, kept so the published 0/7 and 1/7 figures stay reproducible",
    hooks: GHOST_HOOK("PreToolUze"),
    files: [
      skill(
        "---\nname: demo\ndescription: a skill declaring a tool that does not exist and an undeclared MCP server\nallowed-tools: Read, Bahs, mcp__ghost__thing\n---\nBody.\n",
      ),
      agent(
        "---\nname: rev\ndescription: a subagent with a typo'd tool, a never-available tool, and a typo'd model\ntools: Read, Grpe, AskUserQuestion\nmodel: sonnnet\n---\nReview it.\n",
      ),
    ],
  },
];

/** Build ONE isolated fixture for ONE case, in one of the two shapes a real user
 *  has: a repo-local `.claude/` harness, or a packaged plugin. The shape is
 *  load-bearing — the two do not score the same. */
function build(root, shape, kase) {
  const base = shape === "plugin" ? root : join(root, ".claude");
  mkdirSync(base, { recursive: true });

  // A BENIGN, VALID skill in every fixture. Without it a case whose defect lives
  // only in settings.json (the hook cases) leaves the directory otherwise empty,
  // and `validate` answers "No manifest found in directory" — a complaint about
  // the FIXTURE, not about the planted defect. Measured 2026-09-09: that made
  // two hook cases look FLAGGED in the plain shape and nearly overturned a
  // published claim that was in fact correct. The baseline keeps every run a
  // question about the defect.
  mkdirSync(join(base, "skills", "baseline"), { recursive: true });
  writeFileSync(
    join(base, "skills", "baseline", "SKILL.md"),
    "---\nname: baseline\ndescription: A valid skill present in every fixture so the directory is a real harness\n---\nBody.\n",
  );

  for (const f of kase.files ?? []) {
    const path =
      f.kind === "skill"
        ? join(base, "skills", f.name, "SKILL.md")
        : join(base, "agents", `${f.name}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.body);
  }

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
          ...(kase.hooks ? { hooks: kase.hooks } : {}),
        },
        null,
        2,
      ),
    );
  } else if (kase.hooks) {
    writeFileSync(
      join(base, "settings.json"),
      JSON.stringify({ hooks: kase.hooks }, null, 2),
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

/** A complaint about the fixture's own scaffolding is a PROBE ERROR, never a
 *  result: counting it as a hit is how a finding about an empty directory gets
 *  read as the tool catching a planted defect. Fail loudly instead. */
const SCAFFOLD_NOISE = /No manifest found|marketplace\.json/i;

const findingsOf = (out, kase, label) => {
  const found = out
    .split("\n")
    .filter((l) => l.trim().startsWith(">"))
    .map((l) => l.trim().replace(/^>\s*/, ""));
  const noise = found.filter((f) => SCAFFOLD_NOISE.test(f));
  if (noise.length > 0) {
    console.error(
      `PROBE ERROR [${kase.id} / ${label}] — validate complained about the fixture itself, not the planted defect:\n  ${noise.join("\n  ")}`,
    );
    process.exit(2);
  }
  return found;
};

const jsonIdx = process.argv.indexOf("--json");
const jsonPath = jsonIdx === -1 ? null : process.argv[jsonIdx + 1];
if (jsonIdx !== -1 && !jsonPath) {
  console.error("--json needs a path");
  process.exit(2);
}

const version = execFileSync("claude", ["--version"], {
  encoding: "utf8",
}).trim();
const versionNumber = /^([\d.]+)/.exec(version)?.[1] ?? version;
const tmp = mkdtempSync(join(tmpdir(), "vigiles-validate-probe-"));

const SHAPES = [
  ["plain", false],
  ["plain --strict", true],
  ["plugin", false],
  ["plugin --strict", true],
];

const results = [];
try {
  for (const kase of CASES) {
    const per = {};
    for (const [label, strict] of SHAPES) {
      const shape = label.startsWith("plugin") ? "plugin" : "plain";
      const dir = build(
        mkdtempSync(join(tmp, `${kase.id}-`.replace(/[^\w-]/g, ""))),
        shape,
        kase,
      );
      per[label] = findingsOf(run(dir, strict), kase, label);
    }
    results.push({ ...kase, files: undefined, hooks: undefined, per });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const flaggedAnywhere = (r) => SHAPES.some(([l]) => r.per[l].length > 0);

if (jsonPath) {
  const snapshot = {
    tool: "claude plugin validate",
    version: versionNumber,
    measuredAt: new Date().toISOString().slice(0, 10),
    command: "node tools/measure-validate-overlap.mjs --json <path>",
    shapes: SHAPES.map(([l]) => l),
    cases: results.map((r) => ({
      id: r.id,
      rule: r.rule,
      what: r.what,
      flagged: flaggedAnywhere(r),
      per: r.per,
    })),
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `[measure-validate-overlap] ${String(results.length)} case(s) → ${jsonPath} (claude ${versionNumber})`,
  );
} else {
  console.log(`claude --version → ${version}\n`);
  for (const r of results) {
    const hits = SHAPES.filter(([l]) => r.per[l].length > 0).map(([l]) => l);
    console.log(
      `${flaggedAnywhere(r) ? "FLAGGED " : "passed  "} ${r.id.padEnd(30)} ${
        hits.length ? `(${hits.join(", ")})` : ""
      }`,
    );
  }
  const n = results.filter(flaggedAnywhere).length;
  console.log(
    `\n${String(n)} of ${String(results.length)} planted defects flagged in ANY shape.`,
  );
  console.log(`
DISCRIMINATOR — silence only counts once you have shown the tool speaks.
Confirmed by separate probes, so the passes above are real passes and not a
surface it never opened:
  · invalid manifest JSON            → errors
  · hooks.json missing its root key  → errors
  · agent with no description        → warns
  · a manifest hook on a REAL event  → passes (verified with \`Setup\`, which IS
    a documented Claude Code event; \`PreToolUze\` and \`Sesion\` both warn)
`);
}
