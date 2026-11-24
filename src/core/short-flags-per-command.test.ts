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

import { leafCommandsNormalized } from "./bash-effects.js";
import { parseShellCommand } from "./hook-program.js";

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
