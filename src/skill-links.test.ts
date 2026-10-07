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
  isWithinProject,
  formatSkillLinks,
  linkFailureReason,
  linkPrecondition,
  locatePackage,
  planSkillLinks,
  portableTarget,
  relinkTempPath,
  skillLinksUsable,
  writeSkillLink,
  type LinkIo,
  type SkillEntry,
} from "./skill-links.js";
import { isVigilesSkillTarget } from "./core/skill-link-target.js";

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
    isWorkspaceRoot: () => false,
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
    isWorkspaceRoot: () => false,
  });
  // Not installed INSIDE the repo → the link goes where npm will put the
  // devDependency `init` just declared.
  assert.deepEqual(found, {
    kind: "expected",
    dir: join("/home/me/repo", "node_modules", "vigiles"),
  });
});

test("locatePackage: with no repo marker the project is the boundary — an ancestor's node_modules is not used", () => {
  // Guards: before `git init`, /work/node_modules/vigiles must not be taken for
  // /work/new-project's own: the committed links would leave the project.
  const found = locatePackage("/work/new-project", {
    isPackage: (dir) => dir === "/work/node_modules/vigiles",
    isRepoRoot: () => false,
    isWorkspaceRoot: () => false,
  });
  assert.equal(found.kind, "expected");
});

test("locatePackage: with no repo marker a package inside the project is still found", () => {
  const found = locatePackage("/work/new-project", {
    isPackage: (dir) => dir === "/work/new-project/node_modules/vigiles",
    isRepoRoot: () => false,
    isWorkspaceRoot: () => false,
  });
  assert.deepEqual(found, {
    kind: "installed",
    dir: "/work/new-project/node_modules/vigiles",
  });
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
    physicalHome: ".h/skills",
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
    physicalHome: ".agents/skills",
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
      physicalHome: ".h/skills",
      pending: false,
      results: [{ name: "a", status: "skipped", reason: "a directory" }],
    }),
    false,
  );
  assert.equal(
    skillLinksUsable({
      kind: "linked",
      home: ".h/skills",
      physicalHome: ".h/skills",
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

test("locatePackage: not installed inside a workspace → unsure, because the install may hoist vigiles to the workspace root", () => {
  // npm and yarn hoist a workspace member's dependency to the ROOT's
  // node_modules; pnpm keeps it in the member's own. Before the install there
  // is no way to know which, so a link would be a guess that can dangle forever.
  const found = locatePackage("/repo/packages/app", {
    isPackage: () => false,
    isRepoRoot: (dir) => dir === "/repo",
    isWorkspaceRoot: (dir) => dir === "/repo",
  });
  assert.equal(found.kind, "unsure");
});

test("locatePackage: the workspace root itself is not unsure — its own dependency lands in its own node_modules", () => {
  const found = locatePackage("/repo", {
    isPackage: () => false,
    isRepoRoot: (dir) => dir === "/repo",
    isWorkspaceRoot: (dir) => dir === "/repo",
  });
  assert.equal(found.kind, "expected");
});

test("locatePackage: installed in a workspace → the hoisted copy is found and used", () => {
  const found = locatePackage("/repo/packages/app", {
    isPackage: (dir) => dir === "/repo/node_modules/vigiles",
    isRepoRoot: (dir) => dir === "/repo",
    isWorkspaceRoot: (dir) => dir === "/repo",
  });
  assert.deepEqual(found, {
    kind: "installed",
    dir: "/repo/node_modules/vigiles",
  });
});

test("a link vigiles made earlier to a now-wrong place is replaced — it is provably ours", () => {
  // `init` before the install linked into the member's node_modules; npm then
  // hoisted to the root. The old link dangles; re-running init must fix it.
  const d = decideSkillLink(
    "test-harness",
    {
      kind: "link",
      target: "../../node_modules/vigiles/skills/test-harness",
      resolvesTo: null,
    },
    {
      target: "../../../../node_modules/vigiles/skills/test-harness",
      real: "/repo/node_modules/vigiles/skills/test-harness",
    },
  );
  assert.deepEqual(d, {
    name: "test-harness",
    action: "replace",
    target: "../../../../node_modules/vigiles/skills/test-harness",
  });
});

test("a dangling link elsewhere that merely shares the name is still refused", () => {
  const d = decideSkillLink(
    "test-harness",
    { kind: "link", target: "../../mine/test-harness", resolvesTo: null },
    WANT,
  );
  assert.equal(d.action, "refuse");
});

test("isVigilesSkillTarget: only a link into node_modules/vigiles/skills/<same name> is ours", () => {
  assert.equal(
    isVigilesSkillTarget(
      "../../node_modules/vigiles/skills/edit-spec",
      "edit-spec",
    ),
    true,
  );
  assert.equal(
    isVigilesSkillTarget(
      "..\\..\\node_modules\\vigiles\\skills\\edit-spec",
      "edit-spec",
    ),
    true,
  );
  assert.equal(
    isVigilesSkillTarget(
      "../../node_modules/vigiles/skills/strengthen",
      "edit-spec",
    ),
    false,
  );
  assert.equal(
    isVigilesSkillTarget(
      "../../node_modules/other/skills/edit-spec",
      "edit-spec",
    ),
    false,
  );
  assert.equal(
    isVigilesSkillTarget("../../mine/edit-spec", "edit-spec"),
    false,
  );
});

test("isWithinProject: the project and its descendants are inside, even a child named like `..x`; siblings and parents are not", () => {
  assert.equal(isWithinProject("/work/app", "/work/app"), true);
  assert.equal(isWithinProject("/work/app", "/work/app/.agent/skills"), true);
  assert.equal(
    isWithinProject("/work/app", "/work/app-dotfiles/.agent"),
    false,
  );
  assert.equal(isWithinProject("/work/app", "/work/app/..cache/skills"), true);
  assert.equal(isWithinProject("/work/app", "/work"), false);
  assert.equal(isWithinProject("/work/app", "/home/me/.agent"), false);
});

/** A recording filesystem over a map of `path -> link target`; `failOn` makes one call throw. */
function fakeLinks(
  initial: Record<string, string>,
  failOn?: "symlink" | "rename",
): { io: LinkIo; links: Map<string, string>; calls: string[] } {
  const links = new Map(Object.entries(initial));
  const calls: string[] = [];
  const io: LinkIo = {
    symlink: (target, path) => {
      calls.push(`symlink ${path}`);
      if (failOn === "symlink")
        throw new Error("EPERM: operation not permitted");
      if (links.has(path)) throw new Error("EEXIST: file already exists");
      links.set(path, target);
    },
    rename: (from, to) => {
      calls.push(`rename ${to}`);
      if (failOn === "rename") throw new Error("EXDEV: cannot move");
      const target = links.get(from);
      if (target === undefined) throw new Error("ENOENT");
      links.delete(from);
      links.set(to, target);
    },
    unlink: (path) => {
      calls.push(`unlink ${path}`);
      if (!links.delete(path)) throw new Error("ENOENT");
    },
  };
  return { io, links, calls };
}

const ENTRY = "/repo/.agent/skills/test-harness";

test("replace: leaves exactly the new link, and no temporary one", () => {
  const fs = fakeLinks({ [ENTRY]: "old/target" });
  writeSkillLink(fs.io, ENTRY, "new/target", "replace");
  assert.equal(fs.links.get(ENTRY), "new/target");
  assert.deepEqual(
    [...fs.links.keys()],
    [ENTRY],
    "no temporary link left behind",
  );
});

test("replace: when the new link cannot be created, the old link is still there", () => {
  const fs = fakeLinks({ [ENTRY]: "old/target" }, "symlink");
  assert.throws(() => {
    writeSkillLink(fs.io, ENTRY, "new/target", "replace");
  }, /EPERM/);
  // Guards: unlinking first loses a working skill whenever symlink() is refused.
  assert.equal(fs.links.get(ENTRY), "old/target");
});

test("replace: when the rename fails, the old link is still there and the temporary link is removed", () => {
  const fs = fakeLinks({ [ENTRY]: "old/target" }, "rename");
  assert.throws(() => {
    writeSkillLink(fs.io, ENTRY, "new/target", "replace");
  }, /EXDEV/);
  assert.deepEqual([...fs.links.entries()], [[ENTRY, "old/target"]]);
});

test("replace: an entry already at the temporary name is never deleted — the relink fails and both stay", () => {
  const fs = fakeLinks({
    [ENTRY]: "old/target",
    [relinkTempPath(ENTRY)]: "someone else's",
  });
  assert.throws(() => {
    writeSkillLink(fs.io, ENTRY, "new/target", "replace");
  }, /EEXIST/);
  // Guards: init deletes only what this call created; a file of the user's at
  // the temporary name is not ours to remove.
  assert.deepEqual(
    [...fs.links.entries()],
    [
      [ENTRY, "old/target"],
      [relinkTempPath(ENTRY), "someone else's"],
    ],
  );
  assert.ok(!fs.calls.some((c) => c.startsWith("unlink")), fs.calls.join(", "));
});

test("create: one symlink call, nothing else touched", () => {
  const fs = fakeLinks({});
  writeSkillLink(fs.io, ENTRY, "new/target", "create");
  assert.deepEqual(fs.calls, [`symlink ${ENTRY}`]);
});

test("portableTarget: a Windows relative target is committed with forward slashes", () => {
  // Guards: a backslash target committed from Windows dangles on Linux and macOS.
  assert.equal(
    portableTarget("..\\..\\node_modules\\vigiles\\skills\\test-harness", "\\"),
    "../../node_modules/vigiles/skills/test-harness",
  );
  assert.equal(
    portableTarget("../../node_modules/vigiles/skills/x", "/"),
    "../../node_modules/vigiles/skills/x",
  );
});
