/**
 * vigiles#501 — a short flag means what ITS command's manual says.
 *
 * The normalizer used to expand short flags through one table for every
 * program, so `-n` was `--no-verify` everywhere. For `git commit` it is; for
 * `git push` it is `--dry-run`, for `sed` it is "quiet", for `kubectl delete`
 * `-f` is `--filename`, not `--force`. A guard that blocks
 * `git push --no-verify` blocked every dry run.
 *
 * The table is now keyed by program and subcommand (the one #500 introduced for
 * the battery's spelling generator), and a program with no row gets no
 * expansion: its flags are exactly what was typed.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  knownGlobalOptionOf,
  leafCommandsNormalized,
  subcommandAliasRows,
} from "./bash-effects.js";
import {
  allow,
  decideProgram,
  deny,
  experimental_defineHook,
  parseShellCommand,
} from "./hook-program.js";

const leaf = (cmd: string) => {
  const [l] = leafCommandsNormalized(cmd);
  assert.ok(l, `expected a leaf for: ${cmd}`);
  return l;
};

describe("the normalized leaf expands a short flag only through its command's row", () => {
  test("git push -n is a dry run, not --no-verify", () => {
    assert.equal(leaf("git push -n origin main").hasFlag("no-verify"), false);
  });

  test("git commit -n is --no-verify", () => {
    assert.ok(leaf("git commit -n -m x").hasFlag("no-verify"));
  });

  test("kubectl delete -f is --filename, not --force", () => {
    assert.equal(leaf("kubectl delete -f pod.yaml").hasFlag("force"), false);
  });

  test("sed -n keeps exactly the flag that was typed", () => {
    assert.deepEqual([...leaf("sed -n p notes.txt").flags], ["n"]);
  });

  test("rm -rf still reads both forms of both flags", () => {
    const l = leaf("rm -rf build");
    for (const f of ["r", "f", "recursive", "force"])
      assert.ok(l.hasFlag(f), f);
  });

  test("the subcommand is found past git's own options", () => {
    assert.ok(leaf("git -C . commit -n -m x").hasFlag("no-verify"));
    assert.ok(leaf("git -c user.name=x push -f").hasFlag("force"));
  });

  test("pip install -i is still --index-url", () => {
    assert.ok(leaf("pip install -i http://x/simple p").hasFlag("index-url"));
  });
});

describe("runs() asks the same per-command question", () => {
  const runs = (cmd: string, pattern: string) =>
    parseShellCommand(cmd).runs(pattern);

  test("a dry-run push is not a --no-verify push", () => {
    assert.equal(
      runs("git push -n origin main", "git push --no-verify"),
      false,
    );
  });

  test("a -n commit is a --no-verify commit", () => {
    assert.equal(runs("git commit -n -m x", "git commit --no-verify"), true);
  });

  test("kubectl delete -f is not kubectl delete --force", () => {
    assert.equal(
      runs("kubectl delete -f pod.yaml", "kubectl delete --force"),
      false,
    );
  });

  test("git push -f is still git push --force", () => {
    assert.equal(runs("git push -f origin main", "git push --force"), true);
  });

  test("the long form typed is still found for a program with no row", () => {
    assert.equal(runs("docker rm --force c1", "docker rm --force"), true);
    assert.equal(runs("docker rm -f c1", "docker rm -f"), true);
  });

  test("{ force: true } still means -f or --force, as documented", () => {
    assert.equal(
      parseShellCommand("git push -f").runs("git push", { force: true }),
      true,
    );
  });
});

describe("a wrapper option's value is not the program", () => {
  test.each([
    "env -a x git push -f",
    "env --argv0 x git push -f",
    "sudo -T 5 git push -f",
  ])("%s is a force push", (cmd) => {
    assert.equal(
      parseShellCommand(cmd).runs("git push", { force: true }),
      true,
    );
    assert.equal(leaf(cmd).head, "git");
  });
});

// Codex on #508: a dynamic operand of git's own option used to be dropped
// before the subcommand was found, so `git -C "$PWD" commit -n` read `commit`
// as the value of `-C` and `-n` was no longer `--no-verify` — a regression
// against the old single table. A dynamic word keeps its slot until the
// subcommand is found, and a subcommand that cannot be found asks.
describe("a dynamic word never moves the subcommand", () => {
  const decide = (cmd: string) =>
    decideProgram(noVerifyGuard, {
      tool_name: "Bash",
      tool_input: { command: cmd },
    }).kind;

  test.each(['git -C "$PWD" commit -n -m x', 'git -c "$K=$V" commit -n -m x'])(
    "%s is a --no-verify commit",
    (cmd) => {
      assert.equal(parseShellCommand(cmd).runs("git commit --no-verify"), true);
      assert.equal(decide(cmd), "deny");
    },
  );

  test.each([
    "git $OPTS commit -n -m x",
    'git "$SUB" -n -m x',
    "git --attr-source x commit -n -m x",
    "git --some-new-option x commit -n -m x",
  ])("%s may be a --no-verify commit: the gate asks", (cmd) => {
    assert.notEqual(decide(cmd), "allow");
  });

  test("a literal subcommand after known options still decides", () => {
    assert.equal(decide("git --no-pager -c a=b push -n origin main"), "allow");
  });
});

const noVerifyGuard = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git commit --no-verify") ? deny("no-verify") : allow(),
});

// Codex on #508 (a074cf2): `pip --isolated install -i URL pkg` looked up a
// `pip --isolated` row. Every program with per-subcommand rows skips its OWN
// global options to find the subcommand; an option not in its table makes
// the short-flag question "may match", never "no".
describe("every program with subcommand rows skips its own global options", () => {
  test("pip --isolated install -i is --index-url", () => {
    assert.ok(
      leaf("pip --isolated install -i https://x/simple pkg").hasFlag(
        "index-url",
      ),
    );
  });

  const rows = subcommandAliasRows();
  test("the sweep covers every program with subcommand rows", () => {
    assert.deepEqual([...new Set(rows.map((r) => r.program))].sort(), [
      "git",
      "pip",
    ]);
  });

  test.each(rows)(
    "$program <known global> $sub -$short is --$long",
    ({ program, sub, long, short }) => {
      const known = knownGlobalOptionOf(program);
      assert.ok(known !== undefined, `${program} has no global-option table`);
      assert.ok(
        leaf(`${program} ${known} ${sub} -${short} x`).hasFlag(long),
        `${program} ${known} ${sub} -${short}`,
      );
    },
  );

  test.each(rows)(
    "$program <unknown option> $sub -$short may be --$long: the gate asks",
    ({ program, sub, long, short }) => {
      const guard = experimental_defineHook({
        on: "PreToolUse",
        decide: (e) =>
          e.command.runs(`${program} ${sub} --${long}`) ? deny("x") : allow(),
      });
      const kind = decideProgram(guard, {
        tool_name: "Bash",
        tool_input: { command: `${program} --zz-unknown v ${sub} -${short} x` },
      }).kind;
      assert.notEqual(kind, "allow");
    },
  );
});
