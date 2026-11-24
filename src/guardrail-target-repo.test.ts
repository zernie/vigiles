/**
 * Cross-repository cases for the guardrail battery (#418): a guard that reads
 * the branch of its OWN folder is caught (a miss and a false denial on the
 * crossings), a guard that resolves the TARGET passes every row, and a guard
 * that never reads repository state gets no verdict — never a pass. Real git
 * repositories, real bash/node hooks via runHook, and a compiled gate decided
 * in-process. No model.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  experimental_crossRepo,
  formatGuardrailReport,
  guardrail,
  runGuardrail,
  type CrossRepoRow,
} from "./guardrail-check.js";
import { assertChecks } from "./check.js";
import type {
  CrossRepoFixture,
  CrossRepoSetup,
} from "./guardrail-target-repo.js";
import { allow, deny, experimental_defineHook } from "./core/hook-program.js";
import { ADAPTERS } from "./adapter-registry.js";
import { cleanupTmpDir, makeTmpDir } from "./core/test-utils.js";

/** The owner's sketch: a force push must be blocked on main, allowed on a feature branch. */
const FORCE_PUSH_ON_MAIN: CrossRepoSetup = {
  command: "git push -f origin HEAD",
  blockIn: (repo) => {
    repo.branch("main");
  },
  allowIn: (repo) => {
    repo.branch("feature/x");
  },
};

function writeHook(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** The #418 defect: asks git for the branch of the folder it was started in. */
function naiveGuard(dir: string): string {
  return `bash ${writeHook(
    dir,
    "naive.sh",
    `#!/usr/bin/env bash
input=$(cat)
case "$input" in *push*) ;; *) exit 0 ;; esac
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = "main" ]; then echo "no force push to main" >&2; exit 2; fi
exit 0
`,
  )}`;
}

/** Resolves the repository the command targets: `cd X &&` and `git -C X`. */
function targetAwareGuard(dir: string): string {
  return `node ${writeHook(
    dir,
    "aware.mjs",
    `import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const event = JSON.parse(readFileSync(0, "utf-8"));
let cmd = event.tool_input.command;
let at = event.cwd ?? process.cwd();
const cd = cmd.match(/^cd '([^']*)' && (.*)$/);
if (cd) { at = cd[1]; cmd = cd[2]; }
const gc = cmd.match(/^git -C '([^']*)' (.*)$/);
if (gc) { at = gc[1]; cmd = "git " + gc[2]; }
if (!/^git push\\b/.test(cmd)) process.exit(0);
const branch = execFileSync("git", ["branch", "--show-current"], { cwd: at, encoding: "utf-8" }).trim();
if (branch === "main") { process.stderr.write("no force push to main\\n"); process.exit(2); }
`,
  )}`;
}

function constantGuard(dir: string, exitCode: number): string {
  return `bash ${writeHook(dir, `const-${String(exitCode)}.sh`, `#!/usr/bin/env bash\ncat >/dev/null\nexit ${String(exitCode)}\n`)}`;
}

const byId = (rows: readonly CrossRepoRow[], id: string) => {
  const r = rows.find((x) => x.event.id === id);
  assert.ok(r, `no row ${id} in ${rows.map((x) => x.event.id).join(", ")}`);
  return r;
};

const FORMS = ["cd", "git-C", "worktree"] as const;

test("a guard that reads its own folder's branch: controls pass, every crossing fails — on every harness's protocol", () => {
  const dir = makeTmpDir("target-naive");
  try {
    const guard = naiveGuard(dir);
    for (const adapter of ADAPTERS) {
      const rows = runGuardrail(
        guard,
        experimental_crossRepo(FORCE_PUSH_ON_MAIN),
        { protocol: adapter.hookProtocol },
      ).rows;
      assert.equal(rows.length, 12, adapter.name);
      for (const form of FORMS) {
        const ok = (id: string, blocked: boolean) => {
          const r = byId(rows, `${form}:${id}`);
          assert.equal(r.run, "ran", `${adapter.name} ${r.event.id}`);
          assert.equal(r.blocked, blocked, `${adapter.name} ${r.event.id}`);
        };
        ok("allowed->itself", false);
        ok("blocked->itself", true);
        ok("allowed->blocked", false); // the miss: judged feature/x, not main
        ok("blocked->allowed", true); // the false denial: judged main
      }
    }
    const report = formatGuardrailReport(
      guard,
      runGuardrail(
        guard,
        experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["cd"] }),
      ).rows,
    );
    assert.match(
      report,
      /✗ cd form: started in feature\/x, targeted main → allowed \(expected block\): judged the start folder/,
    );
    assert.match(
      report,
      /✗ cd form: started in main, targeted feature\/x → blocked \(expected allow\): judged the start folder/,
    );
    assert.match(
      report,
      /✅ cd form \(control\): started in main, targeted itself → blocked/,
    );
    assert.throws(
      () => {
        assertChecks(
          runGuardrail(guard, experimental_crossRepo(FORCE_PUSH_ON_MAIN)),
          [guardrail()],
        );
      },
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("failed 6 cross-repository case(s)") &&
        e.message.includes("not the folder the session started in") &&
        !e.message.includes("NOT A VERDICT"),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that resolves the target passes every row of every form, on every harness's protocol", () => {
  const dir = makeTmpDir("target-aware");
  try {
    const guard = targetAwareGuard(dir);
    for (const adapter of ADAPTERS) {
      const rows = runGuardrail(
        guard,
        experimental_crossRepo(FORCE_PUSH_ON_MAIN),
        { protocol: adapter.hookProtocol },
      ).rows;
      for (const r of rows) {
        assert.equal(r.run, "ran", `${adapter.name} ${r.event.id}`);
        assert.equal(
          r.blocked,
          r.expect === "block",
          `${adapter.name} ${r.event.id}`,
        );
      }
      assert.doesNotThrow(() => {
        assertChecks(
          runGuardrail(guard, experimental_crossRepo(FORCE_PUSH_ON_MAIN), {
            protocol: adapter.hookProtocol,
          }),
          [guardrail()],
        );
      });
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a guard that ignores the repository fails a control, so its crossings are not a verdict — never a pass", () => {
  const dir = makeTmpDir("target-constant");
  try {
    for (const exitCode of [0, 2]) {
      const guard = constantGuard(dir, exitCode);
      const rows = runGuardrail(
        guard,
        experimental_crossRepo(FORCE_PUSH_ON_MAIN),
      ).rows;
      for (const r of rows.filter((x) => !x.event.control)) {
        assert.equal(r.run, "control-failed", r.event.id);
        assert.equal(r.ran, false);
        assert.equal(r.blocked, exitCode === 2, "the answer is still recorded");
      }
      assert.throws(
        () => {
          assertChecks(
            runGuardrail(guard, experimental_crossRepo(FORCE_PUSH_ON_MAIN)),
            [guardrail()],
          );
        },
        (e: unknown) =>
          e instanceof Error &&
          e.message.includes("6 cross-repository case(s) are NOT A VERDICT") &&
          e.message.includes("control failed") &&
          !e.message.includes("judged the start folder"),
      );
      assert.match(
        formatGuardrailReport(guard, rows),
        /⊘ a form whose control failed has no verdict/,
      );
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

// The compiled path: `git.branch` is gathered where the runtime gathers it —
// the folder the session started in — so a gate built on it has the #418
// defect too, and the crossings say so.
const MAIN_PUSH_GATE = experimental_defineHook({
  on: "PreToolUse",
  needs: ["git.branch", "cwd"],
  decide: (e) =>
    e.ctx["git.branch"] === "main" && e.command.runs("git push")
      ? deny(`no push from main (in ${e.ctx.cwd})`)
      : allow(),
});

test("a compiled gate decides on facts gathered in the start repository", () => {
  const rows = runGuardrail(
    MAIN_PUSH_GATE,
    experimental_crossRepo(FORCE_PUSH_ON_MAIN),
  ).rows;
  assert.equal(rows.length, 12);
  for (const r of rows) {
    assert.equal(r.run, "ran", r.event.id);
    const startedBlocked = r.event.start === "blocked";
    assert.equal(r.blocked, startedBlocked, r.event.id);
  }
  assert.throws(() => {
    assertChecks(
      runGuardrail(MAIN_PUSH_GATE, experimental_crossRepo(FORCE_PUSH_ON_MAIN)),
      [guardrail()],
    );
  }, /judged the start folder/);
});

test("the repositories exist during setup, have a commit, and are removed afterwards — also when a setup throws", () => {
  const dir = makeTmpDir("target-fixture");
  const seen: CrossRepoFixture[] = [];
  try {
    runGuardrail(
      constantGuard(dir, 0),
      experimental_crossRepo({
        ...FORCE_PUSH_ON_MAIN,
        forms: ["cd"],
        allowIn: (repo) => {
          seen.push(repo);
          assert.ok(repo.git("rev-parse", "HEAD").length >= 7);
          repo.branch("feature/x");
          assert.equal(repo.git("branch", "--show-current"), "feature/x");
        },
      }),
    );
    assert.equal(seen.length, 1);
    assert.equal(existsSync(seen[0].dir), false);

    let kept = "";
    assert.throws(
      () =>
        runGuardrail(
          "true",
          experimental_crossRepo({
            ...FORCE_PUSH_ON_MAIN,
            blockIn: (repo) => {
              kept = repo.dir;
              repo.git("checkout", "no-such-branch");
            },
          }),
        ).rows,
      /git checkout no-such-branch failed/,
    );
    assert.notEqual(kept, "");
    assert.equal(existsSync(kept), false);
  } finally {
    cleanupTmpDir(dir);
  }
});

test("the worktree form aims at a linked worktree of the start repository", () => {
  const rows = runGuardrail(
    MAIN_PUSH_GATE,
    experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["worktree"] }),
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.event.id),
    [
      "worktree:allowed->itself",
      "worktree:blocked->itself",
      "worktree:allowed->blocked",
      "worktree:blocked->allowed",
    ],
  );
  const cross = byId(rows, "worktree:allowed->blocked");
  assert.match(
    String(cross.event.input["command"]),
    /^cd '.*\/main' && git push/,
  );
});

test("the default forms follow the command, and a form that cannot spell it is refused", () => {
  const gh = { ...FORCE_PUSH_ON_MAIN, command: "gh pr merge 1" };
  const dir = makeTmpDir("target-forms");
  const rows = (() => {
    try {
      return runGuardrail(constantGuard(dir, 0), experimental_crossRepo(gh))
        .rows;
    } finally {
      cleanupTmpDir(dir);
    }
  })();
  assert.deepEqual(
    [...new Set(rows.map((r) => r.event.via))],
    ["cd", "worktree"],
  );
  assert.throws(
    () =>
      runGuardrail("true", experimental_crossRepo({ ...gh, forms: ["git-C"] }))
        .rows,
    (e: unknown) => e instanceof TypeError && e.message.includes("git-C"),
  );
  assert.throws(
    () =>
      runGuardrail("true", experimental_crossRepo({ ...gh, forms: [] })).rows,
    TypeError,
  );
});

test("a cross-repository set refuses `cwd`: each case starts in the repository it built", () => {
  // The disaster set's own fields (`events`, `harmless`, …) live on the
  // disaster-set value, so combining them with this set cannot be written.
  assert.throws(
    () =>
      runGuardrail("true", experimental_crossRepo(FORCE_PUSH_ON_MAIN), {
        cwd: "/tmp",
      }),
    (e: unknown) => e instanceof TypeError && e.message.includes("`cwd`"),
  );
});

test("experimental_crossRepo settles the forms when it is built, before any repository exists", () => {
  const set = experimental_crossRepo(FORCE_PUSH_ON_MAIN);
  assert.equal(set.kind, "cross-repo");
  assert.deepEqual(set.forms, ["cd", "git-C", "worktree"]);
  assert.throws(
    () => experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: [] }),
    TypeError,
  );
});

test("a compiled gate whose non-built-in need ctx does not supply is refused before any repository is built", () => {
  const gate = experimental_defineHook({
    on: "PreToolUse",
    needs: [
      { kind: "inline", name: "pr.state", run: "gh pr view", dangerous: false },
    ],
    decide: () => allow(),
  });
  assert.throws(
    () => runGuardrail(gate, experimental_crossRepo(FORCE_PUSH_ON_MAIN)).rows,
    (e: unknown) => e instanceof TypeError && e.message.includes("pr.state"),
  );
});

test("a condition that never selects the aimed command fails the blocked control: no verdict, and the report says not selected", () => {
  const dir = makeTmpDir("target-condition");
  try {
    const rows = runGuardrail(
      naiveGuard(dir),
      experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["cd"] }),
      { condition: "Bash(terraform apply*)" },
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.run),
      ["not-selected", "not-selected", "control-failed", "control-failed"],
    );
    assert.equal(
      runGuardrail(
        naiveGuard(dir),
        experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["cd"] }),
        { condition: "Bash(git push *)" },
      ).rows.filter((r) => r.run === "ran").length,
      4,
      "a condition matching the aimed command selects every case",
    );
    assert.match(
      formatGuardrailReport("guard", rows),
      /✗ cd form \(control\): started in main, targeted itself → allowed \(not selected\) \(expected block\): control failed/,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("a hook the shell never launched is reported as not run on every case, not as a control failure", () => {
  const dir = makeTmpDir("target-crashed");
  try {
    const guard = `bash ${join(dir, "missing.sh")}`;
    const rows = runGuardrail(
      guard,
      experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["cd"] }),
    ).rows;
    assert.ok(rows.every((r) => !r.ran));
    assert.match(
      formatGuardrailReport(guard, rows),
      /⊘ cd form \(control\).*NOT RUN/,
    );
    assert.deepEqual(
      new Set(rows.map((r) => r.run)),
      new Set(["never-launched"]),
    );
    assert.throws(
      () => {
        assertChecks(
          runGuardrail(
            guard,
            experimental_crossRepo({ ...FORCE_PUSH_ON_MAIN, forms: ["cd"] }),
          ),
          [guardrail()],
        );
      },
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("NOT RUN") &&
        !e.message.includes("NOT A VERDICT"),
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test("an inherited GIT_DIR (tests run from a git hook) never reaches the fixtures: the caller's repository is left untouched", () => {
  const dir = makeTmpDir("target-git-dir");
  const before = process.env["GIT_DIR"];
  try {
    const caller = join(dir, "caller");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: caller,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: join(caller, ".git"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      }).trim();
    execFileSync("git", ["init", "-q", "-b", "caller-branch", caller]);
    git("commit", "-q", "--allow-empty", "-m", "caller");
    const head = git("rev-parse", "HEAD");
    process.env["GIT_DIR"] = join(caller, ".git");
    runGuardrail(naiveGuard(dir), experimental_crossRepo(FORCE_PUSH_ON_MAIN));
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "caller-branch");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("branch", "--list", "main", "feature/x"), "");
  } finally {
    if (before === undefined) delete process.env["GIT_DIR"];
    else process.env["GIT_DIR"] = before;
    cleanupTmpDir(dir);
  }
});
