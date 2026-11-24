/**
 * `e.command.dirs(program?)` on a CLOSED grammar — which directory each leaf
 * of a command runs in, for a gate that must judge the repository a command
 * touches rather than the one the session sits in.
 *
 * The grammar, and nothing beyond it:
 *  1. a chain of SIMPLE commands joined by `&&`, `;`, `||` (and a plain
 *     `a | b`); the directory carries only across `&&`;
 *  2. `cd <plain word>` that is absolute or starts with `./` or `../`;
 *  3. a program with plain argv, moved by its own row of the directory table;
 *  4. every `cd`/`pushd`/`popd` word in the raw line is one the grammar read;
 *  5. any other construct anywhere makes the whole line unknown;
 *  6. a gate that called `dirs()` and met an unknown leaf that may be the asked
 *     program gets `ask`, never `allow`.
 *
 * Unit tier: `decideProgram` is pure. Delivery on every harness is
 * `src/hook-dirs.test.ts`; real bash as the oracle is
 * `src/hook-dirs-oracle.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  experimental_defineHook,
  allow,
  deny,
  decideProgram,
  parseShellCommand,
  type CommandDirs,
} from "./hook-program.js";

const START = "/w/s";

/** Every leaf, rather than the leaves of one program. */
const EVERY = Symbol("every leaf");

const dirsOf = (
  command: string,
  program: string | typeof EVERY = "git pull",
): CommandDirs =>
  parseShellCommand(command, undefined, START).dirs(
    program === EVERY ? undefined : program,
  );

const known = (
  command: string,
  dirs: readonly string[],
  program?: string | typeof EVERY,
) => {
  assert.deepEqual(
    dirsOf(command, program),
    { kind: "candidates", dirs },
    command,
  );
};

const unknown = (command: string, program?: string | typeof EVERY) => {
  const d = dirsOf(command, program);
  assert.equal(d.kind, "unresolved", `${command} → ${JSON.stringify(d)}`);
};

describe("rule 1: a chain of simple commands; the directory carries only across &&", () => {
  test("a plain leaf runs where the call starts", () => {
    known("git pull", [START]);
  });
  test("an absolute or dot-relative cd carries across &&", () => {
    known("cd /r && git pull", ["/r"]);
    known("cd ../o && git pull", ["/w/o"]);
    known("cd ./a && cd ../b && git pull", ["/w/s/b"]);
    known("cd /a && git status && cd ./b && git pull", ["/a/b"]);
  });
  test("leaves that do not cd keep the directory", () => {
    known("git fetch && git pull", [START]);
  });
  test("after ; or || every later leaf is unknown", () => {
    for (const c of [
      "cd /r; git pull",
      "cd /r || git pull",
      "git status; git pull",
      "cd /r\ngit pull",
      "cd /r && git pull || git pull",
    ])
      unknown(c);
  });
  test("a plain pipeline keeps the directory for every part", () => {
    known("git log | head && git pull", [START]);
    known("cd /r && git pull | cat", ["/r"]);
  });
  test("without a program, every leaf but the cd", () => {
    known("cd /r && git pull && npm test", ["/r"], EVERY);
  });
  test("a leaf that does not run the program is not counted", () => {
    known("cd /r && git status", []);
  });
});

describe("rule 2: cd is read only for a plain absolute or ./ ../ word", () => {
  test("every other cd makes the later leaves unknown", () => {
    for (const c of [
      "cd repo && git pull",
      "cd - && git pull",
      "cd && git pull",
      "cd .. && git pull",
      "cd -P /r && git pull",
      'cd "/r" && git pull',
      "cd \\/r && git pull",
      "cd $HOME && git pull",
      "cd ~/r && git pull",
      "cd /r* && git pull",
      "cd /r{a,b} && git pull",
    ])
      unknown(c);
  });
});

describe("rule 3: a program moved by its own row of the table", () => {
  test("git -C is cumulative and joins the chain's directory", () => {
    known("git -C /r pull", ["/r"]);
    known("git -C a -C b pull", ["/w/s/a/b"]);
    known("cd /r && git -C sub pull", ["/r/sub"]);
    known("/usr/bin/git -C /r pull", ["/r"]);
    known("git -c user.name=x pull", [START]);
  });
  test("a .. in a table value, and git's repository overrides, are unknown", () => {
    for (const c of [
      "git -C ../o pull",
      "git --git-dir=/x pull",
      "git --work-tree /x pull",
      "git -c core.worktree=/x pull",
      "env GIT_DIR=/x git pull",
      "env GIT_WORK_TREE=/x git pull",
    ])
      unknown(c);
  });
  test("wrappers with options from their table", () => {
    known("env -C /r git pull", ["/r"]);
    known("env --chdir=/r git pull", ["/r"]);
    known("sudo -D /r git pull", ["/r"]);
    known("sudo -u bob git pull", [START]);
    known("env -i -C a sudo --chdir=b git pull", ["/w/s/a/b"]);
    known("nice -n 5 git pull", [START]);
    known("timeout -k 5 10 git -C /r pull", ["/r"]);
  });
  test("anything else in a wrapper is unknown", () => {
    for (const c of [
      "env -X git pull",
      "env -C/r git pull",
      "nohup git pull",
      "sudo -i git pull",
    ])
      unknown(c);
  });
});

describe("rule 3: the other rows of the table", () => {
  test("other rows of the table", () => {
    known("make -C /r deploy", ["/r"], "make");
    known("make deploy -C /r", ["/r"], "make");
    known("npm --prefix /r run build", ["/r"], "npm");
    known("terraform -chdir=/r apply", ["/r"], "terraform");
    known("cargo -C /r build", ["/r"], "cargo");
    known("bun --cwd /r test", ["/r"], "bun");
    known("just --working-directory /r build", ["/r"], "just");
    known("docker exec -w /app c ls", ["/app"], "docker exec");
    known("go build -C /r ./...", ["/r"], "go build");
    known("tofu -chdir=/r plan", ["/r"], "tofu");
    known("hg --cwd /r pull", ["/r"], "hg pull");
    known("cargo watch -C /r -x check", ["/r"], "cargo watch");
  });
  test("an option that points a program at another repository is unknown", () => {
    unknown("hg -R /x pull", "hg pull");
    unknown("hg --repository=/x pull", "hg pull");
    unknown("npm -C /x run build", "npm");
  });
  test("a table option spelled any other way is unknown", () => {
    unknown("make -sC /r deploy", "make");
    unknown("make --dir=/r deploy", "make");
    unknown("docker exec c ls", "docker exec");
  });
  test("an unplain word makes its own leaf unknown, not its neighbours", () => {
    known('git commit -m "msg" && git pull', [START]);
    unknown('git commit -m "msg" && git pull', "git commit");
    unknown('"g"it -C /r pull');
    unknown("$G -C /r pull");
  });
});

describe("rule 4: every cd word in the raw line is one the grammar read", () => {
  test("an uncounted cd, pushd or popd makes the whole line unknown", () => {
    for (const c of [
      'echo "cd /x" && git pull',
      "git pull # cd /x",
      "command cd /x && git pull",
      "builtin cd /x && git pull",
      "echo popd && git pull",
    ])
      unknown(c);
  });
});

describe("rule 5: any other construct makes the whole line unknown", () => {
  test("the two open review findings", () => {
    unknown("CDPATH=/x bash -c 'cd repo && git pull'");
    unknown("exit >/dev/null/x; git -C /foreign pull");
  });
  test("functions, loops, conditionals, groups, nested shells", () => {
    for (const c of [
      "f() { git pull; }; f",
      "for d in a; do git pull; done",
      "if true; then git pull; fi",
      "(git pull)",
      "{ git pull; }",
      "bash -c 'git pull'",
      "eval git pull",
      "source x && git pull",
      ". x && git pull",
    ])
      unknown(c);
  });
  test("redirects, assignments, substitutions, background and the rest", () => {
    for (const c of [
      "git pull > out",
      "X=1 git pull",
      "X=1 && git pull",
      "git -C $(pwd) pull",
      "pushd /x && git pull",
      "trap 'echo' EXIT && git pull",
      "exec git pull",
      "git pull &",
      "! git pull",
      "git log |& cat && git pull",
    ])
      unknown(c);
  });
  test("a line outside the grammar that cannot run the program has no candidates", () => {
    known("for x in a; do echo; done", []);
    unknown("for x in a; do echo; done", EVERY);
  });
});

describe("the start directory", () => {
  test("a relative leaf without a start is unresolved, an absolute one is not", () => {
    assert.deepEqual(parseShellCommand("git pull").dirs("git pull"), {
      kind: "unresolved",
      reason: "no-start-dir",
    });
    assert.deepEqual(parseShellCommand("cd /r && git pull").dirs("git pull"), {
      kind: "candidates",
      dirs: ["/r"],
    });
  });
});

describe("rule 6: a gate that called dirs() asks on an unknown leaf", () => {
  const guard = experimental_defineHook({
    on: "PreToolUse",
    decide: (e) => {
      const at = e.command.dirs("git pull");
      if (at.kind === "unresolved") return allow(); // the runtime asks
      return at.dirs.every((d) => d === START || d.startsWith(`${START}/`))
        ? allow()
        : deny("git pull outside the trusted checkout");
    },
  });
  const decide = (command: string) =>
    decideProgram(guard, {
      tool_name: "Bash",
      tool_input: { command },
      cwd: START,
    }).kind;

  test("known and trusted is allowed, known and foreign is denied", () => {
    assert.equal(decide("git pull"), "allow");
    assert.equal(decide("cd ./sub && git pull"), "allow");
    assert.equal(decide("cd /foreign && git pull"), "deny");
    assert.equal(decide("git -C /foreign pull"), "deny");
  });
  test("an unknown leaf that may be the program is asked about", () => {
    for (const c of [
      "cd /foreign; git pull",
      "cd repo && git pull",
      "CDPATH=/x bash -c 'cd repo && git pull'",
      "exit >/dev/null/x; git -C /foreign pull",
      '"g"it -C /foreign pull',
    ])
      assert.equal(decide(c), "ask", c);
  });
  test("an unknown leaf that cannot be the program is not", () => {
    assert.equal(decide("cd repo && npm test"), "allow");
    assert.equal(decide("for x in a; do echo; done"), "allow");
  });
});
