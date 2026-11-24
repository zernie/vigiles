/**
 * Where each leaf of a command line runs — `NormalizedLeaf.at`, the directory
 * model under `ShellCommand.dirs()`.
 *
 * A guard that blocks `git pull` in an untrusted repository let
 * `cd /foreign && git pull` through: the leaf `git pull` carried no directory,
 * so the guard judged it by the session's. Each leaf now carries every
 * directory it may run in, RELATIVE to where the command line starts (`.`),
 * or `unresolved` with the reason when that cannot be known from the text.
 * Never one silent guess.
 *
 * Unit tier, no shell: the oracle against real bash is
 * `src/hook-dirs-oracle.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  leafCommandsNormalized,
  readShell,
  type LeafDirs,
} from "./bash-effects.js";

/** The `at` of the `n`-th leaf whose head is `head`, as the gate reads the line. */
const at = (cmd: string, head = "git", n = 0): LeafDirs => {
  const leaf = readShell(cmd)
    .effects.flatMap((e) => (e.kind === "leaf" ? [e.leaf] : []))
    .filter((l) => l.head === head)[n];
  assert.ok(leaf, `no ${head} leaf #${n} in: ${cmd}`);
  return leaf.at;
};

const dirs = (cmd: string, head = "git", n = 0): readonly string[] => {
  const a = at(cmd, head, n);
  assert.equal(a.kind, "candidates", `${cmd}: ${JSON.stringify(a)}`);
  return a.kind === "candidates" ? [...a.dirs].sort() : [];
};

const reason = (cmd: string, head = "git"): string => {
  const a = at(cmd, head);
  assert.equal(a.kind, "unresolved", `${cmd}: ${JSON.stringify(a)}`);
  return a.kind === "unresolved" ? a.reason : "";
};

describe("one known directory", () => {
  test.each([
    ["git push -f", "."],
    ["git -C ../o push -f", "../o"],
    ["git -C a -C b push", "a/b"],
    ['git -C "" push', "."],
    ["git -C /abs/o push", "/abs/o"],
    ["git -C . push -f", "."],
    ["cd ../o && git push -f", "../o"],
    ["cd ../o || exit 1; git push", "../o"],
    ["cd ../o | git push", "."],
    ["cd ../o & git push", "."],
    ["env -C ../o git push -f", "../o"],
    ["cd && git push", "~"],
    ["cd ~/o && git push", "~/o"],
    ['cd "$HOME/o" && git push', "~/o"],
    ["cd a/../b && git push", "b"],
    ["cd a && git -C ../b push", "b"],
    ["pushd a && pushd b && popd && git push", "a"],
    ["cd a && cd - && git push", "."],
    ["if cd a; then git push; fi", "a"],
    ["while c; do git push; done", "."],
    ['eval "cd a" && git push', "a"],
    ["command cd a && git push", "a"],
    ["sudo cd a && git push", "."],
    ["echo $(cd a && git rev-parse HEAD)", "a"],
    ['bash -c "cd ../o && git push -f"', "../o"],
    ['cd x && bash -c "git push -f"', "x"],
    ['env -C x sh -c "cd y && git push"', "x/y"],
  ])("%s → %s", (cmd, dir) => {
    assert.deepEqual(dirs(cmd), [dir]);
  });
});

describe("more than one candidate when a cd may have failed", () => {
  test("cd x; cmd runs in the OLD directory when the cd fails", () => {
    assert.deepEqual(dirs("cd ../o; git push -f"), [".", "../o"]);
  });

  test("a subshell's cd stays inside it", () => {
    const cmd = "(cd ../o && git push -f); git push";
    assert.deepEqual(dirs(cmd, "git", 0), ["../o"]);
    assert.deepEqual(dirs(cmd, "git", 1), ["."]);
  });

  test("after pushd … && popd, either directory", () => {
    assert.deepEqual(
      dirs("pushd a && git push && popd; git status", "git", 1),
      [".", "a"],
    );
  });

  test("a cd in an if body: both outcomes", () => {
    assert.deepEqual(dirs("if c; then cd a; fi; git push"), [".", "a"]);
  });

  test("eval of a literal cd joins the line", () => {
    assert.deepEqual(dirs('eval "cd a"; git push'), [".", "a"]);
  });

  test("a command substitution's cd does not leak", () => {
    assert.deepEqual(dirs("echo $(cd a); git push"), ["."]);
  });
});

describe("unresolved, with the reason", () => {
  test.each([
    ['cd "$DIR" && git push -f', "dynamic-dir"],
    ['git -C "$D" push', "dynamic-dir"],
    ['env -C "$D" git push', "dynamic-dir"],
    ["cd - && git push", "oldpwd"],
    ["popd && git push", "dir-stack"],
    ["pushd && git push", "dir-stack"],
    ["f(){ cd a; }; f; git push", "opaque-dir-change"],
    ["source x.sh; git push", "opaque-dir-change"],
    [". x.sh; git push", "opaque-dir-change"],
    ['eval "$X"; git push', "opaque-dir-change"],
    ["GIT_DIR=../o/.git git push -f", "git-dir-override"],
    ["git --git-dir=../o/.git push", "git-dir-override"],
    ["git --work-tree ../o push", "git-dir-override"],
    ["export GIT_DIR=x; git push", "git-dir-override"],
    ["cd a; cd b; cd c; cd d; git push", "too-many-candidates"],
    ["cd a b && git push", "unsupported-cd-form"],
  ])("%s → %s", (cmd, why) => {
    assert.equal(reason(cmd), why);
  });

  test("a cd in a loop body is not guessed", () => {
    assert.equal(at("while c; do cd a; done; git push").kind, "unresolved");
  });
});

test("a leaf after exit never runs: no candidate", () => {
  assert.deepEqual(dirs("exit 0; git push"), []);
});

test("every leaf the old walk found is still found (C2)", () => {
  // The directory model must not lose a leaf: it adds a field, it does not
  // choose which leaves exist.
  const cmd =
    "cd a && { git push; } || (git fetch | git log) & if x; then git gc; fi; f(){ git status; }; echo $(git rev-parse HEAD)";
  const heads = leafCommandsNormalized(cmd).map((l) => l.argv.join(" "));
  for (const want of [
    "git push",
    "git fetch",
    "git log",
    "git gc",
    "git status",
    "git rev-parse HEAD",
  ])
    assert.ok(heads.includes(want), want);
});

// Review on #508: each of these was a silent "start directory" for a
// leaf bash runs elsewhere. The rule they pin: what the model does not
// explicitly understand makes the leaf unresolved, never keeps the old one.
describe("builtin-invoking forms move the shell too", () => {
  test.each([
    ["command -p cd /foreign && git pull", "/foreign"],
    ["command -- cd /foreign && git pull", "/foreign"],
    ["builtin cd /foreign && git pull", "/foreign"],
    ["builtin -- cd /foreign && git pull", "/foreign"],
    ["command builtin pushd /foreign && git pull", "/foreign"],
  ])("%s → %s", (cmd, dir) => {
    assert.deepEqual(dirs(cmd), [dir]);
  });

  test("command -v cd only describes it", () => {
    assert.deepEqual(dirs("command -v cd /foreign && git pull"), ["."]);
  });

  test("a builtin-invoker the model cannot read is unresolved", () => {
    assert.equal(at("command -x cd /foreign && git pull").kind, "unresolved");
    assert.equal(at('builtin "$B" /foreign && git pull').kind, "unresolved");
  });
});

describe("a child shell inherits the launching leaf's GIT_DIR", () => {
  test.each([
    "GIT_DIR=/foreign/.git bash -c 'git pull'",
    "GIT_WORK_TREE=/foreign bash -c 'git pull'",
    "env GIT_DIR=/foreign/.git sh -c 'git pull'",
    "GIT_DIR=/foreign/.git eval 'git pull'",
  ])("%s → git-dir-override", (cmd) => {
    assert.equal(reason(cmd), "git-dir-override");
  });

  test("git -c core.worktree= overrides the directory too", () => {
    assert.equal(
      reason("git -c core.worktree=/foreign pull"),
      "git-dir-override",
    );
    assert.equal(reason('git -c "$K" pull'), "git-dir-override");
  });
});

describe("dir-moving functions are found to a fixed point", () => {
  test("a chain of four", () => {
    assert.equal(
      reason(
        "a(){ b; }; b(){ c; }; c(){ d; }; d(){ cd /foreign; }; a; git pull",
      ),
      "opaque-dir-change",
    );
  });

  test("a chain of eight", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const defs = names
      .map((n, i) => `${n}(){ ${names[i + 1] ?? "cd /foreign"}; }`)
      .join("; ");
    assert.equal(reason(`${defs}; a; git pull`), "opaque-dir-change");
  });
});

describe("what changes cd's own inputs is not guessed", () => {
  test.each([
    "CDPATH=/foreign; cd x && git pull",
    "CDPATH=/foreign cd x && git pull",
    "export CDPATH=/foreign; cd x && git pull",
    "HOME=/foreign; cd && git pull",
    "cd a && OLDPWD=/foreign && cd - && git pull",
    "PWD=/foreign; cd .. && git pull",
    "shopt -s cdable_vars; cd x && git pull",
    "trap 'cd /foreign' DEBUG; git pull",
    'trap "$T" DEBUG; git pull',
    "cd $'\\x2fforeign' && git pull",
  ])("%s → unresolved", (cmd) => {
    assert.equal(at(cmd).kind, "unresolved");
  });

  test("a trap that does not move keeps the directory", () => {
    assert.deepEqual(dirs("trap 'rm -f t' EXIT; git pull"), ["."]);
  });
});
