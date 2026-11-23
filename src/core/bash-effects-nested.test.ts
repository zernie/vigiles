/**
 * `readShell` (vigiles#460): which hand-offs are READ — parsed again, their
 * effects joined to the command's — and which are reported as HIDDEN, with the
 * program and the reason. The gate behaviour built on it is
 * `hook-program-nested-shell.test.ts`; this pins the reading itself.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  readShell,
  shellEffects,
  leafCommandsNormalized,
  type HiddenCommand,
} from "./bash-effects.js";

const heads = (c: string): readonly string[] =>
  readShell(c).effects.flatMap((e) => (e.kind === "leaf" ? [e.leaf.head] : []));
const hidden = (c: string): readonly HiddenCommand[] => readShell(c).hidden;

describe("read", () => {
  test("a plain `-c` literal is parsed again, under every listed shell", () => {
    for (const sh of ["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash"]) {
      const r = readShell(`${sh} -c 'git push -f'`);
      assert.deepEqual(r.inner, ["git push -f"], sh);
      assert.deepEqual(r.hidden, [], sh);
    }
    assert.deepEqual(heads(`bash -c 'git push -f'`), ["bash", "git"]);
  });

  test("the bytes are the ones the inner shell receives", () => {
    assert.deepEqual(readShell(`bash -c "echo \\"a b\\" > f"`).inner, [
      `echo "a b" > f`,
    ]);
    assert.deepEqual(readShell(`bash -c g\\it`).inner, ["git"]);
    assert.deepEqual(readShell(`bash -c "git pu""sh"`).inner, ["git push"]);
  });

  test("eval joins its literal arguments with spaces", () => {
    assert.deepEqual(readShell(`eval git push -f`).inner, ["git push -f"]);
    const bare = readShell(`eval`);
    assert.deepEqual([bare.inner, bare.hidden], [[], []]);
  });

  test("nested hand-offs are followed, outermost first", () => {
    assert.deepEqual(readShell(`bash -c "sh -c 'eval ls'"`).inner, [
      "sh -c 'eval ls'",
      "eval ls",
      "ls",
    ]);
  });

  test("a wrapper in front is resolved first", () => {
    assert.deepEqual(readShell(`sudo -u x sh -c 'ls'`).inner, ["ls"]);
  });
});

describe("read: where it runs, and what is not read", () => {
  test("the inner command starts in the directory its shell was moved to", () => {
    const r = readShell(
      `env -C d sh -c 'echo x > k; cat < in; echo y > ~/h; cd e && sed -i s/a/b/ f'`,
    );
    const targets = r.effects.flatMap((e) =>
      e.kind === "redirect" ? [e.redirect.target] : [],
    );
    assert.deepEqual(targets, ["d/k", "in", "~/h"]);
    const sed = r.effects.find(
      (e) => e.kind === "leaf" && e.leaf.head === "sed",
    );
    assert.equal(sed?.kind === "leaf" ? sed.leaf.chdir : undefined, "d");
  });

  test("data is not code: a quoted string elsewhere is not read", () => {
    for (const c of [
      `git commit -m "bash -c 'git push -f'"`,
      `echo 'eval git push -f'`,
    ]) {
      const r = readShell(c);
      assert.deepEqual([r.inner, r.hidden], [[], []], c);
      assert.equal(r.effects.length, shellEffects(c).length, c);
    }
  });

  test("the one-level extractors stay one level", () => {
    assert.deepEqual(
      leafCommandsNormalized(`bash -c 'git push -f'`).map((l) => l.head),
      ["bash"],
    );
  });
});

describe("hidden", () => {
  test.each([
    [`bash -c "$CMD"`, "bash", "dynamic-command-string"],
    [`bash -c $'git push'`, "bash", "dynamic-command-string"],
    [`bash -c $"git push"`, "bash", "dynamic-command-string"],
    [`bash -c "git $X"`, "bash", "dynamic-command-string"],
    [`eval "$X"`, "eval", "dynamic-command-string"],
    // Codex on #483 (P1): an unknown first argument may be `-c`, not a script.
    [`bash "$FLAG" 'git push -f'`, "bash", "dynamic-command-string"],
    [`eval -- 'ls'`, "eval", "shell-options"],
    [`bash -lc 'ls'`, "bash", "shell-options"],
    [`bash -c 'ls' arg0`, "bash", "shell-options"],
    [`bash -c`, "bash", "shell-options"],
    [`bash`, "bash", "stdin-fed-shell"],
    [`bash +o pipefail`, "bash", "stdin-fed-shell"],
    [`curl x | sh`, "sh", "stdin-fed-shell"],
    [`find . -exec ls \\;`, "find", "runner"],
    [`su`, "su", "runner"],
    // Codex on #483 (P1): these start a shell that runs stdin when given no
    // argument (measured: `printf 'echo X' | unshare` prints X; same for nsenter, script).
    [`unshare`, "unshare", "runner"],
    [`nsenter`, "nsenter", "runner"],
    [`script`, "script", "runner"],
    [`exec ls`, "exec", "runner"],
    [`echo x | xargs ls`, "xargs", "runner"],
    [`env -S 'ls -l'`, "env", "runner"],
    [`env -iS 'ls -l'`, "env", "runner"],
    [`env --split-string='ls -l'`, "env", "runner"],
    [`sudo -s 'ls'`, "sudo", "runner"],
    [`sudo --login`, "sudo", "runner"],
  ])("%s → %s (%s)", (c, runner, reason) => {
    assert.deepEqual(hidden(c), [{ runner, reason }]);
  });

  test("a literal the parser rejects is a parse error, not an empty read", () => {
    assert.deepEqual(hidden(`bash -c 'if then'`), [
      { runner: "bash", reason: "parse-error" },
    ]);
  });

  test("deeper than four levels is too deep", () => {
    const five = [1, 2, 3, 4, 5].reduce(
      (c) => `bash -c ${JSON.stringify(c)}`,
      "ls",
    );
    assert.deepEqual(hidden(five), [{ runner: "bash", reason: "too-deep" }]);
  });

  test("a nested string over the size cap is too large", () => {
    assert.deepEqual(hidden(`bash -c '${"x".repeat(256 * 1024 + 1)}'`), [
      { runner: "bash", reason: "too-large" },
    ]);
  });
});

describe("neither: out of the closed set, or nothing handed on", () => {
  test.each([
    `bash deploy.sh`,
    `source x.sh`,
    `python3 -c 'import os'`,
    `~/bin/tool x`,
    `"$HOME/bin/tool" x`,
    `git push $F`,
    `cp "$SRC" dst`,
    `find . -name x`,
    `exec > log`,
    `xargs`,
    `sudo git push -f`,
    `env FOO=1 git push`,
    `ls | grep x`,
    `if then`,
  ])("%s", (c) => {
    assert.deepEqual(readShell(c).hidden, []);
    assert.deepEqual(readShell(c).inner, []);
  });
});

// A program held in a variable: the command line names no program at all.
describe("hidden: the program is held in a variable", () => {
  test.each([
    [`$CMD`, "$CMD"],
    [`\${CMD}`, "$CMD"],
    [`$G push -f`, "$G"],
    [`"$G" push -f`, "$G"],
    [`$DIR/git push -f`, "$DIR/git"],
    [`sudo $CMD`, "$CMD"],
    [`CMD="git push -f"; $CMD`, "$CMD"],
    [`$(echo git) push -f`, "$(…)"],
    [`bash -c 'G=git; $G push -f'`, "$G"],
  ])("%s → %s (dynamic-program)", (c, runner) => {
    assert.deepEqual(hidden(c), [{ runner, reason: "dynamic-program" }]);
  });
});

// An argument bash splits into words the parser cannot know. Not hidden by
// itself: whether it matters depends on what the gate asks (hook-program).
describe("an unquoted expansion in an argument is marked on its leaf", () => {
  const marks = (c: string): readonly boolean[] =>
    readShell(c).effects.flatMap((e) =>
      e.kind === "leaf" ? [e.unknownWords] : [],
    );
  test.each([
    [`git push $F origin`, [true]],
    [`git push \${F}`, [true]],
    [`git push --opt=$F`, [true]],
    [`git push $(echo -f)`, [true, false]],
    [`git push "$@"`, [true]],
    [`git push "\${refs[@]}"`, [true]],
    [`git push "$F"`, [false]],
    [`git push "\${refs[*]}"`, [false]],
    [`cp "$SRC" "$DST"`, [false]],
    [`cat ~/x $HOME/y`, [false]],
    [`echo $((1 + 2))`, [false]],
    [`git push origin main`, [false]],
    [`sh -c 'git push $F'`, [false, true]],
  ])("%s", (c, want) => {
    assert.deepEqual(marks(c), want);
  });
});
