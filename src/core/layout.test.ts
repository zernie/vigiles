/**
 * The agent-file DEPTH rule and the identifier it implies — the two things three
 * separate discoverers used to spell for themselves (scan's `makeClassifier`,
 * `test-coverage.ts`, `test-coverage-files.ts`). Unit-tested here, next to the
 * layout they belong to, so the rule has one home and one set of cases.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { AGENT_FILE_LEAF_RE, agentSurfaceName, skillsHome } from "./layout.js";

/** The fragment as the scan classifier bounds it: `(?:^|/)agents/` … `$`. */
const scanRe = new RegExp(`(?:^|/)agents/${AGENT_FILE_LEAF_RE}$`);
/** The fragment as the coverage discoverers bound it: `^agents/` … `$`. */
const coverageRe = new RegExp(`^agents/${AGENT_FILE_LEAF_RE}$`);

test("AGENT_FILE_LEAF_RE matches an agent file at any depth", () => {
  for (const p of [
    "agents/top.md",
    "agents/review/security.md",
    "agents/review/deep/perf.md",
    ".claude/agents/team/nested.md",
    "plugins/team/agents/the-architect/review-security.md",
  ]) {
    assert.ok(scanRe.test(p), `should match: ${p}`);
  }
});

test("AGENT_FILE_LEAF_RE does not match a non-.md file or the bare dir", () => {
  for (const p of ["agents/notes.txt", "agents/", "agents", "agentsfoo.md"]) {
    assert.equal(scanRe.test(p), false, `should NOT match: ${p}`);
  }
});

test("the fragment is anchor-free, so both callers can bound it their own way", () => {
  // The scan classifier accepts a nested plugin root; the coverage discoverers
  // anchor at the repo root. Same fragment, different bounds — which is the
  // whole reason it is a fragment and not a finished RegExp.
  assert.ok(scanRe.test("plugins/team/agents/x.md"));
  assert.equal(coverageRe.test("plugins/team/agents/x.md"), false);
  assert.ok(coverageRe.test("agents/x.md"));
});

test("agentSurfaceName scopes a nested agent by its subfolder path", () => {
  // Per the docs: `agents/review/security.md` in plugin `my-plugin` registers as
  // `my-plugin:review:security`. Scanning one plugin dir does not know the
  // plugin prefix, so this is that identifier minus the prefix.
  assert.equal(
    agentSurfaceName("agents/review/security.md", "agents"),
    "review:security",
  );
  assert.equal(agentSurfaceName(".claude/agents/a/b/c.md", "agents"), "a:b:c");
});

test("agentSurfaceName degenerates to the basename at the top level", () => {
  // 🔴 Load-bearing: this is why no existing report moves. Every agent vigiles
  // could see before recursion was top-level, so every name it printed before is
  // the name it prints now.
  assert.equal(agentSurfaceName("agents/top.md", "agents"), "top");
  assert.equal(agentSurfaceName(".claude/agents/top.md", "agents"), "top");
});

test("agentSurfaceName honours a non-Claude-Code agent dir", () => {
  assert.equal(agentSurfaceName("agent/review/x.md", "agent"), "review:x");
  assert.equal(agentSurfaceName(".opencode/agent/x.md", "agent"), "x");
});

test("agentSurfaceName requires a real path boundary", () => {
  // `my-agents/x.md` merely ENDS in the keyword — the same trap the classifier's
  // `(?:^|/)` anchor exists for. Without this, a repo with a `my-agents/` dir
  // would get names derived from a dir the harness never reads.
  assert.equal(agentSurfaceName("my-agents/x.md", "agents"), null);
  assert.equal(agentSurfaceName("theagents/x.md", "agents"), null);
});

test("agentSurfaceName skips PAST a non-boundary hit, exactly as the regex does", () => {
  // 🔴 The half a single `indexOf` gets wrong. `myagents/` contains the marker
  // without sitting on a boundary, but a REAL `agents/` follows it — and the
  // classifier, whose `(?:^|/)agents/` keeps scanning, calls this file an agent.
  // Rejecting on the first raw hit would return null here, so the classifier and
  // the name would disagree about the same file and it would silently fall back
  // to a basename — losing the uniqueness the scoped name exists to guarantee.
  assert.equal(
    agentSurfaceName("myagents/x/agents/y.md", "agents"),
    "y",
    "must find the boundary-anchored `agents/`, not give up at `myagents/`",
  );
  assert.equal(
    agentSurfaceName("myagents/agents/deep/z.md", "agents"),
    "deep:z",
  );
  // …and this is the pairing that proves it: the classifier agrees.
  assert.ok(scanRe.test("myagents/x/agents/y.md"));
});

test("agentSurfaceName returns null when there is nothing to name", () => {
  assert.equal(agentSurfaceName("skills/x/SKILL.md", "agents"), null);
  assert.equal(agentSurfaceName("agents/x.md", ""), null, "no agent dir");
  assert.equal(agentSurfaceName("agents/", "agents"), null, "bare dir");
  assert.equal(agentSurfaceName("agents/x.txt", "agents"), null, "not .md");
});

test("skillsHome is where a REPO keeps its skills: the skill surface under the user root", () => {
  // `init` links the shipped skills here, so it must be the directory the
  // harness scans for a project — derived from the two fields that say so.
  assert.equal(
    skillsHome({ surfaces: { skill: "skills" }, userSurfaceRoot: ".h" }),
    ".h/skills",
  );
  // A layout whose surface carries its own prefix has no user root.
  assert.equal(skillsHome({ surfaces: { skill: ".x/skills" } }), ".x/skills");
});

test("skillsHome is null for a layout with no skill surface", () => {
  assert.equal(skillsHome({ surfaces: { agent: "agents" } }), null);
  assert.equal(
    skillsHome({ surfaces: { agent: "agents" }, userSurfaceRoot: ".x" }),
    null,
  );
});
