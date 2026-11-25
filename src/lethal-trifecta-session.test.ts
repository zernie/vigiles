/**
 * #392 — a unit that only INHERITS the session's tools is one fact about the
 * session, not a finding about the unit.
 *
 * One fixture holds every shape, per registered harness: units that only inherit
 * (an unfenced skill; one whose `allowed-tools:` supplies no leg; a subagent with
 * no `tools:` line), units whose fence or contract does not work (a fence that
 * closes no leg, an empty one, frontmatter that does not parse), and units that
 * add a leg themselves (a pre-approved `Bash`, a pre-approved MCP tool, an
 * explicit all-three `tools:`). Pinned through the real engines and the CLI:
 *   - the finding's `cause` is the same in the disk and the browser engine;
 *   - `lint` reports each `fence`/`unit` finding at its own file and nothing,
 *     not even a grouped line, for the inheriting units;
 *   - `audit` states the session cause once; Safety charges it once, a broken
 *     fence with it, so a half-done fence never scores worse than none;
 *   - a harness with no skill fence and no subagents reports none of it;
 *   - moving a unit from "adds a leg" to "inherits" never raises the penalty.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { range } from "remeda";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import type { HarnessAdapter } from "./core/adapter.js";
import { skillsHome } from "./core/layout.js";
import { scanPlugin, formatScanReport, type ScanReport } from "./scan.js";
import { scanFiles } from "./scan-files.js";
import { auditScore } from "./audit-score.js";
import {
  W_TRIFECTA,
  W_TRIFECTA_MAX,
  trifectaExposure,
  trifectaPenalty,
} from "./score-core.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { ADAPTERS, defaultAdapter } from "./adapter-registry.js";
import { applyRules } from "./core/apply-rules.js";
import { defaultSeverities, type ScanInput } from "./core/rule.js";
import { ruleResolver } from "./overrides.js";
import { RULES, RULE_GROUPS } from "./rules/index.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

const shown = <S extends ScanInput>(scan: S) =>
  applyRules(RULES, RULE_GROUPS, ruleResolver(defaultSeverities(RULES)), scan);

const unitMd = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: A unit used by the session fixture here\n${extra}---\nbody\n`;

/** Skill name → frontmatter lines, and the cause each must carry. */
const SKILLS: Record<string, readonly [string, string]> = {
  plain: ["", "session"],
  edits: ["allowed-tools: Edit, Write, Bash(echo ready:*)\n", "session"],
  // read-only tools run without a prompt, so pre-approving them adds nothing
  readers: ["allowed-tools: Read, Grep, Glob\n", "session"],
  shell: ["allowed-tools: Read, Bash\n", "unit"],
  query: ["allowed-tools: mcp__acme__run_query\n", "unit"],
  half: ["disallowed-tools: Read\n", "fence"],
  empty: ["disallowed-tools: []\n", "fence"],
  badyaml: ["allowed-tools: [unclosed\n", "fence"],
  // a fence that closes no leg leaves a pre-approval where it was
  shellempty: ["allowed-tools: Read, Bash\ndisallowed-tools: []\n", "unit"],
  shellhalf: ["allowed-tools: Read, Bash\ndisallowed-tools: Read\n", "unit"],
  // …unless the fence denies the pre-approved tool itself
  readdenied: ["allowed-tools: Read\ndisallowed-tools: Read\n", "fence"],
};
const AGENTS: Record<string, readonly [string, string]> = {
  broad: ["", "session"],
  triager: ["tools: Read, WebFetch, Bash\n", "unit"],
  broken: ["tools: [Read\n", "fence"],
  careful: ["tools: Read, Grep\n", "none"],
};

/** The harness's agents folder, beside its skills folder; null without subagents. */
function agentsHome(a: HarnessAdapter): string | null {
  const agent = a.layout.surfaces.agent;
  if (!a.subagents || agent === undefined || agent === "") return null;
  const root = a.layout.userSurfaceRoot;
  return root === undefined || root === "" ? agent : `${root}/${agent}`;
}

function fixtureFiles(
  a: HarnessAdapter,
  skills = SKILLS,
): Record<string, string> {
  const sk = skillsHome(a.layout) ?? "skills";
  const ag = agentsHome(a);
  return {
    ...Object.fromEntries(
      Object.entries(skills).map(([n, [fm]]) => [
        `${sk}/${n}/SKILL.md`,
        unitMd(n, fm),
      ]),
    ),
    ...(ag === null
      ? {}
      : Object.fromEntries(
          Object.entries(AGENTS).map(([n, [fm]]) => [
            `${ag}/${n}.md`,
            unitMd(n, fm),
          ]),
        )),
  };
}

function put(files: Record<string, string>): string {
  const dir = makeTmpDir("trifecta-session");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function readTree(root: string, d = root): Record<string, string> {
  return Object.fromEntries(
    readdirSync(d).flatMap((e) => {
      const abs = join(d, e);
      return statSync(abs).isDirectory()
        ? Object.entries(readTree(root, abs))
        : [[relative(root, abs), readFileSync(abs, "utf-8")]];
    }),
  );
}

const causes = (r: ScanReport): Record<string, string> =>
  Object.fromEntries(r.trifectaFindings.map((t) => [t.name, t.finding.cause]));

function expectedCauses(a: HarnessAdapter): Record<string, string> {
  const rows = [
    ...Object.entries(SKILLS),
    ...(agentsHome(a) === null ? [] : Object.entries(AGENTS)),
  ];
  return Object.fromEntries(
    rows.flatMap(([n, [, c]]) => (c === "none" ? [] : [[n, c]])),
  );
}

/** Whether this harness reads a skill-level `disallowed-tools:` at all. */
const fenced = (a: HarnessAdapter): boolean =>
  a.dialect.skillFrontmatterKeys.includes("disallowed-tools");

for (const a of ADAPTERS.filter(fenced)) {
  const scan = (dir: string): ScanReport =>
    scanPlugin(dir, a.layout, a.dialect);

  test(`both engines give every finding the same cause (#392, ${a.name})`, () => {
    const dir = put(fixtureFiles(a));
    const browser = scanFiles(readTree(dir), a.layout, a.dialect);
    assert.deepEqual(causes(scan(dir)), expectedCauses(a));
    assert.deepEqual(causes(browser), expectedCauses(a));
    cleanupTmpDir(dir);
  });

  test(`audit names every unit once, one line per distinct finding (#392, ${a.name})`, () => {
    const dir = put(fixtureFiles(a));
    const r = scan(dir);
    const text = formatScanReport(shown(r));
    const start = text.indexOf("Lethal trifecta");
    // The section runs to the next unindented heading: groups inside it are
    // separated by blank lines.
    const after = text.slice(start).split("\n").slice(1);
    const end = after.findIndex((l) => l !== "" && !l.startsWith(" "));
    const section = end === -1 ? after : after.slice(0, end);
    // Units in the same state share one group (three lines: mark + problem,
    // → edit, the units), so there are exactly as many groups as distinct
    // findings, never one per unit.
    const marks = section.filter((l) => /^ {2}[⚠✗] /.test(l));
    const distinct = new Set(
      r.trifectaFindings.map((t) => `${t.finding.problem}\n${t.finding.edit}`),
    );
    assert.equal(marks.length, distinct.size, text);
    const nameLines = section.filter(
      (l) => l.startsWith("    ") && !l.startsWith("    → "),
    );
    for (const n of Object.keys(expectedCauses(a))) {
      const named = nameLines.filter((l) => l.trim().split(" · ").includes(n));
      assert.equal(named.length, 1, `${n}: ${text}`);
    }
    cleanupTmpDir(dir);
  });

  test(`Safety charges the inheriting units once, however many (#392, ${a.name})`, () => {
    const safety = (count: number): number | null | undefined => {
      const sk = skillsHome(a.layout) ?? "skills";
      const dir = put(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `${sk}/s${String(i)}/SKILL.md`,
            unitMd(`s${String(i)}`),
          ]),
        ),
      );
      const s = auditScore(scan(dir)).categories.find(
        (c) => c.key === "Safety",
      )?.score;
      cleanupTmpDir(dir);
      return s;
    };
    assert.equal(safety(1), 100 - W_TRIFECTA);
    assert.equal(safety(60), 100 - W_TRIFECTA);
  });

  test(`a unit that adds a leg is charged per unit, a broken fence with the session (#392, ${a.name})`, () => {
    const dir = put(fixtureFiles(a));
    const e = trifectaExposure(scan(dir));
    const c = Object.values(expectedCauses(a));
    assert.equal(e.exposed, c.filter((x) => x === "unit").length);
    assert.equal(e.inherited, c.filter((x) => x !== "unit").length);
    assert.ok(e.penalty <= W_TRIFECTA_MAX);
    cleanupTmpDir(dir);
  });

  test(`fencing never lowers Safety: none → a fence that closes nothing → one that closes a leg (${a.name})`, () => {
    const penalty = (fm: string): number => {
      const dir = put(fixtureFiles(a, { ...SKILLS, plain: [fm, ""] }));
      const p = trifectaExposure(scan(dir)).penalty;
      cleanupTmpDir(dir);
      return p;
    };
    const none = penalty("");
    const broken = penalty("disallowed-tools: WebFetch\n");
    const closed = penalty("disallowed-tools: WebFetch, WebSearch, Bash\n");
    assert.ok(broken <= none, `${String(broken)} > ${String(none)}`);
    assert.ok(closed <= broken);
  });
}

for (const a of ADAPTERS.filter((x) => !fenced(x) && !x.subagents)) {
  test(`a harness with no skill fence and no subagents reports none of it (${a.name})`, () => {
    const dir = put(fixtureFiles(a));
    const r = scanPlugin(dir, a.layout, a.dialect);
    assert.ok(r.skills.length >= 6, "precondition: the skills are read");
    assert.deepEqual(r.trifectaFindings, []);
    assert.ok(!formatScanReport(shown(r)).includes("Lethal trifecta"));
    cleanupTmpDir(dir);
  });
}

test("lint still names every unit that holds the trifecta: nothing is silenced (#392)", () => {
  // #392 changes the score and the audit report, not lint: a unit that only
  // inherits the session is as exposed as before, so CI must still see it.
  const a = defaultAdapter;
  const dir = put(fixtureFiles(a));
  const out = spawnSync("node", [CLI, "lint"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout;
  const start = out.indexOf("trifecta check:");
  assert.ok(start >= 0, out);
  const section = out.slice(start).split(/\n\s*\n(?=\S)/)[0] ?? "";
  for (const [name, cause] of Object.entries(expectedCauses(a)))
    if (cause !== "none")
      assert.match(section, new RegExp(`\\b${name}\\b`), `${name}\n${section}`);
  cleanupTmpDir(dir);
});

/** Every (exposed ≥ 1, inherited, assessable ≤ 60) split a report can have. */
const SPLITS = range(1, 61).flatMap((assessable) =>
  range(1, assessable + 1).flatMap((exposed) =>
    range(0, assessable - exposed + 1).map(
      (inherited) => [exposed, inherited, assessable] as const,
    ),
  ),
);

/** Move one unit from "adds a leg" to "inherits": never dearer, rows add up. */
function checkMove(
  exposed: number,
  inherited: number,
  assessable: number,
): void {
  const before = trifectaPenalty(exposed, inherited, assessable);
  const after = trifectaPenalty(exposed - 1, inherited + 1, assessable);
  const at = `${String(exposed)}+${String(inherited)}/${String(assessable)}`;
  assert.ok(after.penalty <= before.penalty, at);
  assert.ok(before.penalty >= 1 && before.penalty <= W_TRIFECTA_MAX, at);
  assert.equal(before.unitPenalty + before.sessionPenalty, before.penalty, at);
  // each row charges only its own kind of unit
  if (inherited === 0) assert.equal(before.sessionPenalty, 0, at);
  if (exposed === 1) assert.equal(after.unitPenalty, 0, at);
}

test("moving a unit from adds-a-leg to inherits never raises the trifecta penalty (#392)", () => {
  // The mixed case a reviewer found: 12 assessable units, dropping one
  // pre-approval took 2 + 2 to 1 + 3, and two separately rounded shares went 10 → 11.
  assert.ok(
    trifectaPenalty(1, 3, 12).penalty <= trifectaPenalty(2, 2, 12).penalty,
  );
  for (const [exposed, inherited, assessable] of SPLITS)
    checkMove(exposed, inherited, assessable);
});
