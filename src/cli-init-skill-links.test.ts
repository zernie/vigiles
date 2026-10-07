/**
 * `vigiles init` links vigiles's skills into the repo — through the REAL built
 * CLI, in a scratch repo, so the IO half (`linkVigilesSkills` in cli-main.ts) is
 * exercised as a user runs it. The pure half is `src/skill-links.test.ts`.
 *
 * The defect: the Claude Code plugin install lands in the home directory, one
 * machine's state. A fresh container's home is empty and a repo-declared plugin
 * only PROMPTS, so headless sessions had the skills in
 * `node_modules/vigiles/skills/` and none of them visible. A committed link
 * travels with the clone.
 *
 * Both harnesses are driven, because the linking is harness-neutral (the skills
 * home is the layout's) while what happens to the GLOBAL install is not: the
 * Claude Code plugin still runs (it carries the hooks), the Codex `skills` CLI
 * install is skipped (it carried only skills).
 *
 * No network and no global install here, on purpose: Codex's global install is
 * skipped when the links are made, and every run puts a PATH holding only
 * `node` in front, so the Claude Code plugin step reports "not installed"
 * instead of reaching the marketplace. HOME is a scratch dir in every run.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { SHIPPED_SKILLS } from "./setup-plan.js";
import { getAdapter } from "./adapter-registry.js";
import { skillsHome } from "./core/layout.js";
import { relinkTempPath } from "./skill-links.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

// eslint-disable-next-line local/no-harness-names -- `init --harness=<name>` takes these names; the test types them as a user does
const [CC, CX] = ["claude", "codex"] as const;

/** The layout's skills home for an `init` harness name. */
function homeOf(harness: string): string {
  const adapter = getAdapter(harness);
  const home = adapter === undefined ? null : skillsHome(adapter.layout);
  assert.ok(home !== null, `no skills home for ${harness}`);
  return home;
}

interface Scratch {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
}

/** A scratch repo + HOME + a PATH that holds only `node`; removed afterwards. */
function withScratch(fn: (s: Scratch) => void): void {
  const s: Scratch = {
    root: mkdtempSync(join(tmpdir(), "vigiles-init-links-")),
    home: mkdtempSync(join(tmpdir(), "vigiles-init-home-")),
    bin: mkdtempSync(join(tmpdir(), "vigiles-init-bin-")),
  };
  symlinkSync(process.execPath, join(s.bin, "node"));
  try {
    fn(s);
  } finally {
    [s.root, s.home, s.bin].forEach((d) => {
      rmSync(d, { recursive: true, force: true });
    });
  }
}

/** Run the built `init` (no lint/test/CI layers — only the install step matters). */
function init(s: Scratch, harness: string): string {
  try {
    return execFileSync(
      process.execPath,
      [
        CLI,
        "init",
        "--no-lint",
        "--no-test",
        "--no-gha",
        `--harness=${harness}`,
      ],
      {
        cwd: s.root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
        env: { ...process.env, HOME: s.home, PATH: s.bin, CI: "1" },
      },
    );
  } catch (e) {
    throw new Error(`init failed: ${String(e)}`, { cause: e });
  }
}

/** A consumer repo: `.git`, a package.json that depends on vigiles, optionally installed. */
function consumer(root: string, installed: boolean): void {
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", devDependencies: { vigiles: "^4" } }),
  );
  if (!installed) return;
  const pkg = join(root, "node_modules", "vigiles");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vigiles" }));
  SHIPPED_SKILLS.forEach((s) => {
    mkdirSync(join(pkg, "skills", s), { recursive: true });
    writeFileSync(join(pkg, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  });
}

test("Claude Code: one relative link per skill, each resolving to the package's SKILL.md; the plugin step still runs", () => {
  withScratch((s) => {
    consumer(s.root, true);
    const out = init(s, CC);
    SHIPPED_SKILLS.forEach((name) => {
      const entry = join(s.root, homeOf(CC), name);
      assert.equal(
        readlinkSync(entry),
        `../../node_modules/vigiles/skills/${name}`,
      );
      assert.ok(readFileSync(join(entry, "SKILL.md"), "utf-8").includes(name));
    });
    assert.ok(out.includes("6 linked now, 0 already linked, 0 skipped"), out);
    // Guards: the plugin is the only carrier of the hooks — still attempted.
    assert.ok(out.includes(`plugin for ${CC} was NOT installed`), out);
  });
});

test("a harness whose global install carries only skills: links into its skills home and skips that install", () => {
  withScratch((s) => {
    consumer(s.root, true);
    const out = init(s, CX);
    SHIPPED_SKILLS.forEach((name) => {
      assert.equal(
        readlinkSync(join(s.root, homeOf(CX), name)),
        `../../node_modules/vigiles/skills/${name}`,
      );
    });
    assert.ok(out.includes(`No global ${CX} skills install`), out);
    assert.ok(!out.includes("skills add zernie/vigiles"), out);
  });
});

test("re-running init keeps every link and creates none", () => {
  withScratch((s) => {
    consumer(s.root, true);
    init(s, CC);
    const out = init(s, CC);
    assert.ok(out.includes("0 linked now, 6 already linked, 0 skipped"), out);
  });
});

test("the user's own skill of the same name is never replaced, and the report names it", () => {
  withScratch((s) => {
    consumer(s.root, true);
    const mine = join(s.root, homeOf(CC), "test-harness");
    mkdirSync(mine, { recursive: true });
    writeFileSync(
      join(mine, "SKILL.md"),
      "---\nname: test-harness\n---\nmine\n",
    );
    const out = init(s, CC);
    assert.ok(readFileSync(join(mine, "SKILL.md"), "utf-8").endsWith("mine\n"));
    assert.ok(out.includes("5 linked now, 0 already linked, 1 skipped"), out);
    assert.ok(
      out.includes(`${homeOf(CC)}/test-harness left alone — it is a directory`),
      out,
    );
  });
});

test("before npm install: the links go where npm will put the package, and the report says to install", () => {
  withScratch((s) => {
    consumer(s.root, false);
    const out = init(s, CC);
    assert.equal(
      readlinkSync(join(s.root, homeOf(CC), "test-harness")),
      "../../node_modules/vigiles/skills/test-harness",
    );
    assert.ok(out.includes("run npm install"), out);
  });
});

test("no package.json: no links (they could only dangle), and the global install is still attempted", () => {
  withScratch((s) => {
    mkdirSync(join(s.root, ".git"));
    const out = init(s, CX);
    assert.equal(existsSync(join(s.root, homeOf(CX))), false);
    assert.ok(
      out.includes(
        "skills were NOT linked — this repo has no package.json dependency",
      ),
      out,
    );
    assert.ok(!out.includes(`No global ${CX} skills install`), out);
  });
});

/** An npm workspace: the root declares `packages/*`; `packages/app` depends on vigiles. */
function workspace(root: string): string {
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }),
  );
  const app = join(root, "packages", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "app", devDependencies: { vigiles: "^4" } }),
  );
  return app;
}

/** What `npm install` does in a workspace: hoist vigiles to the ROOT's node_modules. */
function hoistInstall(root: string): void {
  const pkg = join(root, "node_modules", "vigiles");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "vigiles" }));
  SHIPPED_SKILLS.forEach((s) => {
    mkdirSync(join(pkg, "skills", s), { recursive: true });
    writeFileSync(join(pkg, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  });
}

test("a workspace member before npm install: no guessed links, and the report says install first, then init", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    const out = init({ ...s, root: app }, CC);
    assert.equal(existsSync(join(app, homeOf(CC))), false);
    assert.ok(out.includes("run npm install, then npx vigiles init"), out);
  });
});

test("a workspace member after npm install: the links point at the hoisted package and resolve", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    hoistInstall(s.root);
    init({ ...s, root: app }, CC);
    const entry = join(app, homeOf(CC), "test-harness");
    assert.equal(
      readlinkSync(entry),
      "../../../../node_modules/vigiles/skills/test-harness",
    );
    assert.ok(existsSync(join(entry, "SKILL.md")));
  });
});

test("re-running init replaces a link vigiles made earlier that now points at the wrong place", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    // The state an older `init` left: links into the member's own node_modules.
    mkdirSync(join(app, homeOf(CC)), { recursive: true });
    SHIPPED_SKILLS.forEach((name) => {
      symlinkSync(
        `../../node_modules/vigiles/skills/${name}`,
        join(app, homeOf(CC), name),
        "dir",
      );
    });
    hoistInstall(s.root);
    const out = init({ ...s, root: app }, CC);
    assert.ok(out.includes("6 relinked"), out);
    assert.ok(existsSync(join(app, homeOf(CC), "test-harness", "SKILL.md")));
  });
});

test("the commit hint lists the links init relinked, not only the ones it created", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    mkdirSync(join(app, homeOf(CC)), { recursive: true });
    SHIPPED_SKILLS.forEach((name) => {
      symlinkSync(
        `../../node_modules/vigiles/skills/${name}`,
        join(app, homeOf(CC), name),
        "dir",
      );
    });
    hoistInstall(s.root);
    const out = init({ ...s, root: app }, CC);
    // Guards: a relinked link is a changed file in git — a hint without it
    // leaves the repo with a dirty tree and a commit that looks complete.
    const hint = out.split("\n").find((l) => l.includes("git add")) ?? "";
    SHIPPED_SKILLS.forEach((name) => {
      assert.ok(hint.includes(`${homeOf(CC)}/${name}`), `${name}: ${hint}`);
    });
  });
});

/** An empty directory outside every scratch repo, removed afterwards. */
function withOutside(fn: (outside: string) => void): void {
  const outside = mkdtempSync(join(tmpdir(), "vigiles-init-outside-"));
  try {
    fn(outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

test("a skills home reached through a link that leaves the repository gets nothing written to it", () => {
  withScratch((s) => {
    withOutside((outside) => {
      consumer(s.root, true);
      // `.claude` is a link to a shared dotfiles directory outside the repo.
      symlinkSync(outside, join(s.root, dirname(homeOf(CC))), "dir");
      const out = init(s, CC);
      // Guards: following the link would write skill links into someone
      // else's directory, and commit a link that only this machine resolves.
      assert.equal(existsSync(join(outside, "skills")), false, out);
      assert.ok(out.includes("skills were NOT linked"), out);
      assert.ok(out.includes("outside the repository"), out);
    });
  });
});

test("a skills directory that is itself a link out of the repository is left alone", () => {
  withScratch((s) => {
    withOutside((outside) => {
      consumer(s.root, true);
      mkdirSync(join(s.root, ".agents"));
      symlinkSync(outside, join(s.root, homeOf(CX)), "dir");
      const out = init(s, CX);
      assert.deepEqual(readdirSync(outside), [], out);
      assert.ok(out.includes("outside the repository"), out);
    });
  });
});

test("a skills home that is a link to somewhere inside the repository is still linked", () => {
  withScratch((s) => {
    consumer(s.root, true);
    mkdirSync(join(s.root, "tooling", "claude"), { recursive: true });
    symlinkSync(
      join(s.root, "tooling", "claude"),
      join(s.root, dirname(homeOf(CC))),
    );
    const out = init(s, CC);
    assert.ok(
      existsSync(join(s.root, "tooling", "claude", "skills", "test-harness")),
      out,
    );
    assert.ok(out.includes("6 linked now"), out);
  });
});

/** The state an older `init` left in a workspace member: links into the member's own node_modules. */
function staleLinks(app: string): void {
  mkdirSync(join(app, homeOf(CC)), { recursive: true });
  SHIPPED_SKILLS.forEach((name) => {
    symlinkSync(
      `../../node_modules/vigiles/skills/${name}`,
      join(app, homeOf(CC), name),
      "dir",
    );
  });
}

test("relinking leaves only the skill links in the home — no temporary entry survives", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    staleLinks(app);
    hoistInstall(s.root);
    init({ ...s, root: app }, CC);
    assert.deepEqual(
      readdirSync(join(app, homeOf(CC))).sort(),
      [...SHIPPED_SKILLS].sort(),
    );
  });
});

test("a link that cannot be rewritten keeps its old target, and the others are still relinked", () => {
  withScratch((s) => {
    const app = workspace(s.root);
    staleLinks(app);
    hoistInstall(s.root);
    const [stuck, ...rest] = SHIPPED_SKILLS;
    // A directory squatting on the name the replacement is built under makes
    // creating that one link fail, the way a refused symlink() does.
    mkdirSync(relinkTempPath(join(app, homeOf(CC), stuck)));
    const out = init({ ...s, root: app }, CC);
    // Guards: removing the old link before creating the new one loses the
    // skill whenever the second step fails.
    assert.equal(
      readlinkSync(join(app, homeOf(CC), stuck)),
      `../../node_modules/vigiles/skills/${stuck}`,
    );
    rest.forEach((name) => {
      assert.equal(
        readlinkSync(join(app, homeOf(CC), name)),
        `../../../../node_modules/vigiles/skills/${name}`,
      );
    });
    assert.ok(out.includes(`${homeOf(CC)}/${stuck} left alone`), out);
    assert.ok(out.includes("1 skipped"), out);
  });
});
