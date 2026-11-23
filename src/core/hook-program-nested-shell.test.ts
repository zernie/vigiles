/**
 * vigiles#460 — a command handed to another program to run.
 *
 * A gate that blocks `git push -f` let `bash -c "git push -f"` through: the
 * matcher saw the leaf `bash`, and the quoted string was data to it. Two
 * answers, and nothing in between:
 *
 *  - READ — the plain forms `<shell> -c '<literal>'` and `eval '<literal>' …`
 *    are parsed again, and the rules apply to the inner command as if it had
 *    been typed directly;
 *  - CAN'T SEE — every other way of handing a command on (`find -exec`, `su -c`,
 *    `env -S`, `bash -c "$X"`, a shell with extra options, a shell reading
 *    stdin, …) turns the gate's `allow` into an `ask`, when the gate asked
 *    about the command at all. Never a silent `allow`.
 *
 * Unit tier: `decideProgram` is pure. The cross-harness delivery is
 * `src/hook-nested-shell.test.ts`; real bash as the oracle is
 * `src/hook-nested-shell-oracle.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  experimental_defineHook,
  allow,
  deny,
  ask,
  decideProgram,
  type Decision,
} from "./hook-program.js";

const forcePushGuard = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("force-push") : allow(),
});

const ev = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

const kind = (command: string, guard = forcePushGuard): Decision["kind"] =>
  decideProgram(guard, ev(command)).kind;

describe("the plain forms are READ: the inner command is judged as if typed", () => {
  test.each([
    `bash -c "git push -f"`,
    `sh -c 'git push -f'`,
    `eval 'git push -f'`,
    `eval git push -f`,
    `eval "git push" -f`,
    `dash -c 'git push --force origin main'`,
    `/bin/sh -c "git push -f"`,
    `sudo sh -c "git push -f"`,
    `env bash -c "git push -f"`,
    `cd x && bash -c "git push -f"`,
    `bash -c "cd ../o && git push -f"`,
    `bash -c "sh -c 'git push -f'"`,
    `bash -c "git pu""sh -f"`,
    `bash -c 'echo hi; eval "git push -f"'`,
  ])("%s is blocked", (command) => {
    assert.equal(kind(command), "deny");
  });

  test("a plain `git push -f` stays blocked", () => {
    assert.equal(kind("git push -f"), "deny");
  });

  test("an inner command that does not match stays allowed", () => {
    assert.equal(kind(`bash -c 'ls'`), "allow");
    assert.equal(kind(`sh -c 'git push origin main'`), "allow");
    assert.equal(kind(`eval 'git status'`), "allow");
  });

  test("a quoted string that is DATA, not code, is not read", () => {
    assert.equal(kind(`git commit -m "bash -c 'git push -f'"`), "allow");
    assert.equal(kind(`echo 'sh -c "git push -f"'`), "allow");
    assert.equal(kind(`grep -r 'eval git push -f' .`), "allow");
  });

  test("every word reads the inner command, not only runs()", () => {
    const writes = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) => (e.command.writesTo(["secrets"]) ? deny("w") : allow()),
    });
    const reads = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) => (e.command.touches(["~/.ssh"]) ? deny("r") : allow()),
    });
    const effects = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) => (e.command.isSideEffecting() ? deny("s") : allow()),
    });
    assert.equal(kind(`sh -c "echo x > secrets/k"`, writes), "deny");
    assert.equal(kind(`bash -c "sed -i s/a/b/ secrets/k"`, writes), "deny");
    assert.equal(kind(`eval 'cat ~/.ssh/id_rsa'`, reads), "deny");
    assert.equal(kind(`sh -c "rm -rf x"`, effects), "deny");
    assert.equal(kind(`bash -c 'ls'`, effects), "allow");
  });
});

describe("everything else that hides a command is CAN'T SEE: allow becomes ask", () => {
  test.each([
    `find . -exec git push -f \\;`,
    `find . -name x -execdir git push -f {} +`,
    `bash -c "$CMD"`,
    `bash -c "git push $F"`,
    `eval "$X"`,
    `bash -lc 'git push -f'`,
    `bash -e -c 'git push -f'`,
    `bash -c 'git push "$1"' _ -f`,
    `bash -c $'git push -f'`,
    `echo 'git push -f' | bash`,
    `bash <<< 'git push -f'`,
    `bash <<'EOF'\ngit push -f\nEOF`,
    `su -c 'git push -f' me`,
    `printf 'git push -f\\n' | unshare`,
    `printf 'git push -f\\n' | nsenter`,
    `printf 'git push -f\\n' | script -q /dev/null`,
    `sudo -s 'git push -f'`,
    `env -S 'git push -f'`,
    `watch -n1 'git push -f'`,
    `parallel 'git push -f' ::: a`,
    `flock /tmp/l -c 'git push -f'`,
    `script -qc 'git push -f' /dev/null`,
    `exec git push -f`,
    `builtin eval 'git push -f'`,
    `echo -f | xargs git push`,
    `bash -c "find . -exec git push -f \\;"`,
  ])("%s asks", (command) => {
    assert.equal(kind(command), "ask");
  });

  test("xargs with the whole command in view keeps today's deny", () => {
    // `xargs` is in the wrapper table, so `git push -f` is read and blocked
    // as before. What xargs may ADD from stdin is the unseen part, and it can
    // only turn an allow into an ask — never weaken this deny.
    assert.equal(kind(`xargs git push -f`), "deny");
  });

  test("the ask carries the reason: which program hid the command", () => {
    const d = decideProgram(forcePushGuard, ev(`find . -exec git push -f \\;`));
    assert.equal(d.kind, "ask");
    assert.ok(d.kind === "ask" && d.reason.includes("find"));
  });

  test("a gate that never asked about the command is not second-guessed", () => {
    const branchOnly = experimental_defineHook({
      on: "PreToolUse",
      decide: () => allow(),
    });
    assert.equal(kind(`bash -c "$CMD"`, branchOnly), "allow");
  });

  test("the gate's own deny and ask are final", () => {
    const always = (d: Decision) =>
      experimental_defineHook({
        on: "PreToolUse",
        decide: (e) => (e.command.runs("ls") ? allow() : d),
      });
    assert.equal(kind(`bash -c "$CMD"`, always(deny("no"))), "deny");
    const asked = decideProgram(always(ask("mine")), ev(`bash -c "$CMD"`));
    assert.deepEqual(asked, { kind: "ask", reason: "mine" });
  });

  test("a command with nothing hidden is decided exactly as before", () => {
    for (const c of ["git status", "ls | grep x", "npm test", "bash x.sh"])
      assert.equal(kind(c), "allow", c);
  });
});
