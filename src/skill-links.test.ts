/**
 * The pure half of `init`'s skill linking (`src/skill-links.ts`): where the
 * package is, what each `<skills home>/<name>` entry should become, and what the
 * report says. The IO half lives in `cli-main.ts` and is exercised end to end by
 * `src/cli-init-skill-links.test.ts`.
 *
 * The defect these guard: a GLOBAL plugin install is a fact about one machine,
 * so a fresh clone or a fresh container had vigiles's skills on disk under
 * `node_modules/vigiles/skills/` and none of them visible to the agent.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  decideSkillLink,
  formatSkillLinks,
  linkFailureReason,
  linkPrecondition,
  locatePackage,
  planSkillLinks,
  skillLinksUsable,
  type SkillEntry,
} from "./skill-links.js";

const WANT = {
  target: "../../node_modules/vigiles/skills/test-harness",
  real: "/repo/node_modules/vigiles/skills/test-harness",
};

test("a missing entry is created, pointing at the package's skill", () => {
  assert.deepEqual(decideSkillLink("test-harness", { kind: "missing" }, WANT), {
    name: "test-harness",
    action: "create",
    target: WANT.target,
  });
});

test("an existing link with the same target is kept — re-running init changes nothing", () => {
  const entry: SkillEntry = {
    kind: "link",
    target: WANT.target,
    resolvesTo: null, // dangling: the clone has not run npm install yet
  };
  // Guards: a committed link that dangles in a fresh clone is OURS, not foreign.
  assert.deepEqual(decideSkillLink("test-harness", entry, WANT), {
    name: "test-harness",
    action: "keep",
  });
});

test("a link spelled differently but resolving to the same skill is kept", () => {
  const entry: SkillEntry = {
    kind: "link",
    target: "/repo/node_modules/vigiles/skills/test-harness",
    resolvesTo: WANT.real,
  };
  assert.equal(decideSkillLink("test-harness", entry, WANT).action, "keep");
});

test("the user's own directory of the same name is never replaced", () => {
  const d = decideSkillLink("test-harness", { kind: "directory" }, WANT);
  assert.equal(d.action, "refuse");
  assert.match(d.action === "refuse" ? d.reason : "", /directory/);
});

test("a file, a link elsewhere and a dangling link elsewhere are all refused, each named", () => {
  const cases: readonly [SkillEntry, RegExp][] = [
    [{ kind: "file" }, /a file/],
    [
      { kind: "link", target: "../mine/test-harness", resolvesTo: "/x" },
      /a link to \.\.\/mine\/test-harness/,
    ],
    [
      { kind: "link", target: "../gone/test-harness", resolvesTo: null },
      /a dangling link to \.\.\/gone\/test-harness/,
    ],
  ];
  for (const [entry, reason] of cases) {
    const d = decideSkillLink("test-harness", entry, WANT);
    assert.equal(d.action, "refuse", JSON.stringify(entry));
    assert.match(d.action === "refuse" ? d.reason : "", reason);
  }
});

test("locatePackage finds an installed package walking up to the repo root", () => {
  const found = locatePackage("/repo/packages/app", {
    isPackage: (dir) => dir === "/repo/node_modules/vigiles",
    isRepoRoot: (dir) => dir === "/repo",
  });
  assert.deepEqual(found, {
    kind: "installed",
    dir: "/repo/node_modules/vigiles",
  });
});

test("locatePackage never walks past the repo root — a link out of the repo breaks in every other clone", () => {
  const found = locatePackage("/home/me/repo", {
    isPackage: (dir) => dir === "/home/me/node_modules/vigiles",
    isRepoRoot: (dir) => dir === "/home/me/repo",
  });
  // Not installed INSIDE the repo → the link goes where npm will put the
  // devDependency `init` just declared.
  assert.deepEqual(found, {
    kind: "expected",
    dir: join("/home/me/repo", "node_modules", "vigiles"),
  });
});

test("locatePackage stops at the filesystem root when there is no repo marker", () => {
  const found = locatePackage("/a/b", {
    isPackage: () => false,
    isRepoRoot: () => false,
  });
  assert.equal(found.kind, "expected");
});

test("planSkillLinks links every shipped skill relative to the PHYSICAL skills home", () => {
  const plan = planSkillLinks({
    names: ["edit-spec", "test-harness"],
    site: { kind: "installed", dir: "/repo/node_modules/vigiles" },
    physicalHome: "/repo/.h/skills",
    entries: () => ({ kind: "missing" }),
    realOf: (name) => `/store/vigiles/skills/${name}`,
  });
  assert.equal(plan.pending, false);
  assert.deepEqual(plan.decisions, [
    {
      name: "edit-spec",
      action: "create",
      target: "../../node_modules/vigiles/skills/edit-spec",
    },
    {
      name: "test-harness",
      action: "create",
      target: "../../node_modules/vigiles/skills/test-harness",
    },
  ]);
});

test("planSkillLinks is pending when the package is not installed yet", () => {
  const plan = planSkillLinks({
    names: ["test-harness"],
    site: { kind: "expected", dir: "/repo/node_modules/vigiles" },
    physicalHome: "/repo/.agents/skills",
    entries: () => ({ kind: "missing" }),
    realOf: () => null,
  });
  assert.equal(plan.pending, true);
  assert.equal(
    plan.decisions[0]?.action === "create" && plan.decisions[0].target,
    "../../node_modules/vigiles/skills/test-harness",
  );
});

test("linkFailureReason names the Windows fix for EPERM, and only for EPERM", () => {
  assert.match(
    linkFailureReason("EPERM", "operation not permitted"),
    /Developer Mode/,
  );
  assert.doesNotMatch(linkFailureReason("EEXIST", "exists"), /Developer Mode/);
});

test("the report counts what happened, names every skipped skill and says how to get vigiles's", () => {
  const lines = formatSkillLinks({
    kind: "linked",
    home: ".h/skills",
    pending: false,
    results: [
      { name: "edit-spec", status: "created" },
      { name: "strengthen", status: "present" },
      { name: "test-harness", status: "skipped", reason: "a directory" },
    ],
  });
  const text = lines.join("\n");
  assert.match(text, /1 linked now, 1 already linked, 1 skipped/);
  assert.match(text, /\.h\/skills\/test-harness/);
  assert.match(text, /a directory/);
  assert.match(text, /commit/i);
});

test("a pending report says the links resolve after npm install", () => {
  const text = formatSkillLinks({
    kind: "linked",
    home: ".agents/skills",
    pending: true,
    results: [{ name: "edit-spec", status: "created" }],
  }).join("\n");
  assert.match(text, /npm install/);
});

test("not linking is LOUD, with the reason", () => {
  const text = formatSkillLinks({
    kind: "not-linked",
    reason: "no skills found",
  }).join("\n");
  assert.match(text, /NOT linked/);
  assert.match(text, /no skills found/);
});

test("skillLinksUsable: true only when at least one shipped skill is linked", () => {
  assert.equal(skillLinksUsable({ kind: "not-linked", reason: "x" }), false);
  assert.equal(
    skillLinksUsable({
      kind: "linked",
      home: ".h/skills",
      pending: false,
      results: [{ name: "a", status: "skipped", reason: "a directory" }],
    }),
    false,
  );
  assert.equal(
    skillLinksUsable({
      kind: "linked",
      home: ".h/skills",
      pending: true,
      results: [{ name: "a", status: "present" }],
    }),
    true,
  );
});

test("linkPrecondition: never link the vigiles repo to itself", () => {
  assert.match(
    linkPrecondition({
      isVigilesItself: true,
      dependsOnVigiles: false,
      installed: true,
    }) ?? "",
    /vigiles repository itself/,
  );
});

test("linkPrecondition: no dependency and nothing installed → no link (it could only ever dangle)", () => {
  assert.match(
    linkPrecondition({
      isVigilesItself: false,
      dependsOnVigiles: false,
      installed: false,
    }) ?? "",
    /no package.json dependency/,
  );
});

test("linkPrecondition: declared but not installed yet → link (npm install will resolve it)", () => {
  assert.equal(
    linkPrecondition({
      isVigilesItself: false,
      dependsOnVigiles: true,
      installed: false,
    }),
    null,
  );
  assert.equal(
    linkPrecondition({
      isVigilesItself: false,
      dependsOnVigiles: false,
      installed: true,
    }),
    null,
  );
});
