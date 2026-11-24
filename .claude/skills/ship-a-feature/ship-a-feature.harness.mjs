/**
 * ship-a-feature — colocated harness, run by `vigiles test` (free tier).
 *
 *   npx vigiles test .claude/skills/ship-a-feature/ship-a-feature.harness.mjs
 *
 * NAMED AFTER THE SKILL AND IN ITS OWN DIRECTORY on purpose: vigiles credits
 * coverage by placement (`isColocatedTest` — `<name>.harness.*` beside the
 * SKILL.md), not by a test that merely mentions the surface.
 *
 * What it proves, in three tiers:
 *
 *   A. The skill's OWN executable checks FIRE on each defect they were written
 *      for and stay QUIET on a clean case — driven over throwaway git fixtures
 *      through `runScript` (the public primitive), one fixture per measured
 *      failure. A check that has never been seen firing is indistinguishable
 *      from a dead one.
 *   B. The SKILL.md is loadable as a model-invocable skill and its body still
 *      points at the script (deleting the command turns this back into prose).
 *   C. (needs `claude`; skips LOUDLY otherwise) the skill, loaded the way it
 *      ships, ACTIVATES and its body reaches the model — a scripted mock, $0.
 *
 * What it does NOT prove: that the description fires on a real "add a feature"
 * prompt and stays quiet on a bug fix. That needs a real model —
 * `examples/harness/dogfood/ship-a-feature.trigger.eval.mjs`.
 */
import { runScript, runHarnessTest } from "vigiles";
// `scriptModel` / `claudeAvailable` are Claude-Code-specific and live behind the
// per-harness door, not the agnostic root — the same REACHABLE question this
// skill asks, answered the hard way while writing its own harness.
import { scriptModel, claudeAvailable } from "vigiles/harness/claude-code";
import { packageSkillsDir } from "../../../dist/eval.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(DIR, "..", "..", "..");
const SCRIPT = join(DIR, "scripts", "ship-check.mjs");
const NAME = "ship-a-feature";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const git = (cwd, args) =>
  spawnSync("git", ["-c", "user.name=h", "-c", "user.email=h@x", ...args], {
    cwd,
    stdio: "ignore",
  });

/**
 * A tiny package with one door, one documented neighbour and a candidate symbol
 * `shipFeature`. Each knob reproduces ONE of the measured failures; all knobs
 * default to the clean shape.
 */
function fixture({
  reachable = true,
  neighbourDocumented = true,
  documented = true,
  findable = true,
  crossLinked = false,
  tag = false,
  symbol = "shipFeature",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "ship-a-feature-"));
  const w = (p, s) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  w(
    "package.json",
    JSON.stringify({
      name: "fixture",
      type: "module",
      exports: { ".": "./dist/index.js" },
    }),
  );
  w("dist/index.js", reachable ? `export function ${symbol}() {}\n` : "");
  w("dist/extra.js", `export function ${symbol}() {}\n`); // exists, but behind no door
  w(
    "src/index.ts",
    `/** Neighbour. */\nexport function neighbour(): void {}\n\n` +
      `/**\n * The candidate.${tag ? "\n * @experimental" : ""}\n */\nexport function ${symbol}(): void {}\n`,
  );
  w(
    "docs/guide.md",
    documented
      ? `## Doing ${symbol} things \u2014 the long way\n\nUse \`${symbol}()\` here.\n`
      : "Nothing yet.\n",
  );
  // A second page. DOCUMENTED is satisfied by one; FINDABLE wants a reader who
  // is NOT already inside guide.md to be able to reach the capability — either
  // because a second page names it, or because one links to its section.
  w(
    "docs/sibling.md",
    documented && findable
      ? `See \`${symbol}()\` for this.\n`
      : crossLinked
        ? `See [the section](guide.md#doing-${symbol.toLowerCase()}-things--the-long-way).\n`
        : "An unrelated page.\n",
  );
  // Baseline surface: only the neighbour, documented. Committed, so the diff the
  // script READS is exactly what regenerating after the change would show.
  w(
    "api-surface/fixture.api.md",
    "// @public\nexport function neighbour(): void;\n",
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "baseline"]);
  w(
    "api-surface/fixture.api.md",
    `// @public${neighbourDocumented ? "" : " (undocumented)"}\nexport function neighbour(): void;\n\n` +
      `// @public\nexport function ${symbol}(): void;\n`,
  );
  return root;
}

const check = (root, args) =>
  runScript(`node "${SCRIPT}" --root "${root}" --no-regen ${args}`, {
    cwd: root,
    timeoutMs: 60_000,
  });
const text = (r) => r.stdout + r.stderr;

const cases = [
  // ── A. the checks fire on their defect, and only then ──────────────────────
  [
    "clean fixture + --stable passes every check, exit 0, no ✗",
    () => {
      const root = fixture();
      try {
        const r = check(
          root,
          'shipFeature --stable "used by two consumers since the fixture epoch"',
        );
        assert(
          r.exitCode === 0,
          `expected exit 0, got ${String(r.exitCode)}:\n${text(r)}`,
        );
        assert(
          !text(r).includes("✗"),
          `clean run printed a finding:\n${text(r)}`,
        );
        for (const c of [
          "REACHABLE",
          "SURFACE",
          "DOCUMENTED",
          "FINDABLE",
          "MARKED",
        ])
          assert(text(r).includes(`✓ ${c}`), `no ✓ ${c} line:\n${text(r)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "REACHABLE fires when the symbol is behind no exports door (failure 1)",
    () => {
      const root = fixture({ reachable: false });
      try {
        const r = check(root, 'shipFeature --stable "x"');
        assert(
          r.exitCode === 1,
          `expected exit 1, got ${String(r.exitCode)}:\n${text(r)}`,
        );
        assert(text(r).includes("✗ REACHABLE"), `no ✗ REACHABLE:\n${text(r)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "SURFACE fires when the regenerated diff makes a NEIGHBOUR undocumented (failure 2)",
    () => {
      const root = fixture({ neighbourDocumented: false });
      try {
        const r = check(root, 'shipFeature --stable "x"');
        assert(r.exitCode === 1, `expected exit 1:\n${text(r)}`);
        assert(
          text(r).includes("✗ SURFACE") && text(r).includes("neighbour"),
          `SURFACE must name the neighbour that lost its doc:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "DOCUMENTED fires when docs/ and README name the symbol nowhere (failure 3)",
    () => {
      const root = fixture({ documented: false });
      try {
        const r = check(root, 'shipFeature --stable "x"');
        assert(r.exitCode === 1, `expected exit 1:\n${text(r)}`);
        assert(
          text(r).includes("✗ DOCUMENTED"),
          `no ✗ DOCUMENTED:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "MARKED refuses an untagged, unprefixed export until --stable states why (failure 4)",
    () => {
      const root = fixture();
      try {
        const r = check(root, "shipFeature");
        assert(
          r.exitCode === 1,
          `expected exit 1 without --stable:\n${text(r)}`,
        );
        assert(
          text(r).includes("✗ MARKED") && text(r).includes("@experimental"),
          `MARKED must ask the experimental question:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "MARKED passes a tagged + prefixed export with no --stable (the lint rule owns the name)",
    () => {
      const root = fixture({ tag: true, symbol: "experimental_shipFeature" });
      try {
        const r = check(root, "experimental_shipFeature");
        assert(r.exitCode === 0, `expected exit 0:\n${text(r)}`);
        assert(text(r).includes("✓ MARKED"), `no ✓ MARKED:\n${text(r)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "GATE fails when the tree moves during the run (failure 5) and is quiet when it does not",
    () => {
      const root = fixture();
      try {
        const moving = runScript(
          `node "${SCRIPT}" --gate --root "${root}" --cmd "sh -c 'echo moved >> moving.txt'"`,
          { cwd: root, timeoutMs: 60_000 },
        );
        assert(
          moving.exitCode === 1 && text(moving).includes("✗ GATE"),
          `a gate whose command edited the tree must fail:\n${text(moving)}`,
        );
        const frozen = runScript(
          `node "${SCRIPT}" --gate --root "${root}" --cmd "true"`,
          { cwd: root, timeoutMs: 60_000 },
        );
        assert(
          frozen.exitCode === 0 && text(frozen).includes("✓ GATE"),
          `a gate on a frozen tree must pass:\n${text(frozen)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "GATE propagates the command's real exit code, not a pipe's (failure 7)",
    () => {
      const root = fixture();
      try {
        const r = runScript(
          `node "${SCRIPT}" --gate --root "${root}" --cmd "sh -c 'exit 3'"`,
          { cwd: root, timeoutMs: 60_000 },
        );
        assert(
          r.exitCode === 3,
          `expected the command's exit 3, got ${String(r.exitCode)}:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "FINDABLE fires when one page names it and nothing links to that section",
    () => {
      // The measured 2026-09-02 shape: experimental_equivalentDisasters (since
      // renamed experimental_alternateSpellings) was documented, once, under its own heading in a guide about a DIFFERENT
      // feature, with no inbound link. DOCUMENTED passed; a reader could not
      // get there. Both halves are asserted, because a FINDABLE that fired on
      // the clean fixture too would be telling us nothing.
      const root = fixture({ findable: false });
      try {
        const r = check(root, 'shipFeature --stable "two consumers"');
        assert(
          text(r).includes("✗ FINDABLE"),
          `no ✗ FINDABLE on the one-page shape:\n${text(r)}`,
        );
        assert(
          text(r).includes("✓ DOCUMENTED"),
          `DOCUMENTED should still pass — the fault is reach, not absence:\n${text(r)}`,
        );
        assert(
          r.exitCode !== 0,
          `unreachable docs must fail the run:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  [
    "FINDABLE accepts one page when another LINKS to its section anchor",
    () => {
      // The cheap real fix is a pointer, not a duplicated explanation, so the
      // check has to accept a pointer. Without this case the rule would push
      // authors to copy prose onto a second page.
      const root = fixture({ findable: false, crossLinked: true });
      try {
        const r = check(root, 'shipFeature --stable "two consumers"');
        assert(
          text(r).includes("✓ FINDABLE"),
          `a linked anchor should satisfy FINDABLE:\n${text(r)}`,
        );
        assert(
          !text(r).includes("✗"),
          `cross-linked fixture printed a finding:\n${text(r)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  ],
  // ── B. the skill file itself ───────────────────────────────────────────────
  [
    "SKILL.md is model-invocable, named after its directory, and points at the script",
    () => {
      const md = readFileSync(join(DIR, "SKILL.md"), "utf8");
      const fm = yaml.load(md.split(/^---$/m)[1]);
      assert(
        fm && fm.name === NAME,
        `frontmatter name is ${JSON.stringify(fm?.name)}, dir is ${NAME}`,
      );
      assert(
        fm["disable-model-invocation"] !== true,
        "the skill is disable-model-invocation — it must FIRE on 'add a feature', that is its whole point",
      );
      assert(
        /add(ing)?.*(export|feature|capability)/i.test(String(fm.description)),
        "description no longer names adding an export/feature/capability — the trigger surface is gone",
      );
      assert(
        md.includes("scripts/ship-check.mjs") && existsSync(SCRIPT),
        "the body no longer names scripts/ship-check.mjs (or the script is gone): the checks are advice again",
      );
      assert(
        md.includes("--gate"),
        "the body lost the --gate step: the frozen-tree / foreground / exit-code rules become prose",
      );
    },
  ],
  // ── C. loaded as it ships, it activates and its body reaches the model ─────
  [
    "the skill activates and its body reaches the model (scripted mock, $0)",
    async () => {
      if (!claudeAvailable()) {
        console.log(
          "    ⊘ `claude` CLI not found — activation tier skipped (tiers A+B still ran)",
        );
        return;
      }
      const pluginDir = packageSkillsDir(join(REPO, ".claude", "skills"));
      const r = await runHarnessTest({
        pluginDir,
        sandbox: false,
        transcript: true,
        timeoutMs: 180_000,
        allowedTools: ["Skill", "Read"],
        prompt: "I am adding a new export to vigiles.",
        model: scriptModel([
          { tool: "Skill", input: { skill: `vigiles-loose-skills:${NAME}` } },
          { text: "done" },
        ]),
      });
      try {
        const call = r.toolCalls.find((c) => c.name === "Skill");
        assert(
          call && !call.isError,
          `${NAME} never activated (${call ? call.resultText : "no Skill call"})`,
        );
        const reached = r.modelRequests
          .map((q) => [q.system, ...q.messages.map((m) => m.text)].join("\n"))
          .join("\n");
        assert(
          reached.includes("scripts/ship-check.mjs"),
          `the skill loaded but its body never reached the model across ${String(r.modelRequests.length)} requests`,
        );
      } finally {
        r.cleanup();
        rmSync(pluginDir, { recursive: true, force: true });
      }
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
console.log(
  failed === 0
    ? `\n${String(cases.length)} passed.`
    : `\n${String(failed)} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
