/**
 * `e.command.dirs(program?)` — which directories a command's leaves run in,
 * for a gate that must judge the repository a command touches rather than the
 * one the session sits in.
 *
 * Reported by an adopter: an untrusted-repository guard let
 * `cd /foreign && git pull` through, because nothing in the vocabulary said
 * where `git pull` would run. `dirs()` answers with absolute paths, resolved
 * against the directory the tool call starts in (the event's `cwd`), and
 * never guesses: a directory the text does not fix (`cd "$X"`) is
 * `unresolved`, and a gate that asked and then allowed is turned into an
 * `ask` — the rule a hidden command or a flag in a variable already follows
 * (vigiles#460, #497).
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
  ask,
  deny,
  decideProgram,
  parseShellCommand,
  type Decision,
} from "./hook-program.js";

const CWD = "/work/repo";

/** The adopter's shape: `git pull` only inside the session's checkout. */
const trustedPullGuard = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => {
    if (!e.command.runs("git pull")) return allow();
    const at = e.command.dirs("git pull");
    if (at.kind === "unresolved") return allow(); // the runtime asks
    return at.dirs.every((d) => d === CWD || d.startsWith(`${CWD}/`))
      ? allow()
      : deny("git pull outside the trusted checkout");
  },
});

const forcePushGuard = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("force-push") : allow(),
});

const ev = (command: string, cwd: string | null = CWD) => ({
  tool_name: "Bash",
  tool_input: { command },
  ...(cwd === null ? {} : { cwd }),
});

const decide = (
  command: string,
  guard = trustedPullGuard,
  cwd: string | null = CWD,
): Decision => decideProgram(guard, ev(command, cwd));

describe("dirs() resolves each leaf against the event's cwd", () => {
  const d = (cmd: string, program?: string) =>
    parseShellCommand(cmd, undefined, CWD).dirs(program);

  test.each([
    ["git pull", ["/work/repo"]],
    ["cd /foreign && git pull", ["/foreign"]],
    ["cd ../other && git pull", ["/work/other"]],
    ["git -C ../other pull", ["/work/other"]],
    ["cd sub; git pull", ["/work/repo/sub", "/work/repo"]],
    ["(cd /foreign && ls); git pull", ["/work/repo"]],
  ])("%s → %j", (cmd, want) => {
    assert.deepEqual(d(cmd, "git pull"), { kind: "candidates", dirs: want });
  });

  test("with no program, every leaf's directories, in order of appearance (the cd itself runs where it starts)", () => {
    assert.deepEqual(d("cd /a && ls; git status"), {
      kind: "candidates",
      dirs: ["/work/repo", "/a"],
    });
  });

  test("no leaf runs the program: no directory", () => {
    assert.deepEqual(d("ls", "git pull"), { kind: "candidates", dirs: [] });
  });

  test("~ stays ~: the gate does not read $HOME", () => {
    assert.deepEqual(d("cd ~/x && git pull", "git pull"), {
      kind: "candidates",
      dirs: ["~/x"],
    });
  });

  test("a directory the text does not fix is unresolved, with the reason", () => {
    assert.deepEqual(d('cd "$X" && git pull', "git pull"), {
      kind: "unresolved",
      reason: "dynamic-dir",
    });
  });

  test("without a start directory a relative one is unresolved, not guessed", () => {
    assert.deepEqual(parseShellCommand("git pull").dirs("git pull"), {
      kind: "unresolved",
      reason: "no-start-dir",
    });
    assert.deepEqual(parseShellCommand("cd /a && git pull").dirs("git pull"), {
      kind: "candidates",
      dirs: ["/a"],
    });
  });
});

describe("the adopter's guard", () => {
  test("cd /foreign && git pull is denied", () => {
    assert.equal(decide("cd /foreign && git pull").kind, "deny");
  });

  test.each([
    "git -C /foreign pull",
    "cd /foreign; git pull",
    "pushd /foreign && git pull",
    'bash -c "cd /foreign && git pull"',
    "cd .. && git pull",
  ])("%s is denied", (cmd) => {
    assert.equal(decide(cmd).kind, "deny");
  });

  test.each(["git pull", "cd sub && git pull", "(cd /foreign); git pull"])(
    "%s is allowed",
    (cmd) => {
      assert.equal(decide(cmd).kind, "allow");
    },
  );
});

describe("a directory the gate cannot know turns allow into ask", () => {
  test.each([
    'cd "$X" && git pull',
    "cd - && git pull",
    "source env.sh; git pull",
    "f(){ cd /x; }; f; git pull",
  ])("%s → ask", (cmd) => {
    const d = decide(cmd);
    assert.equal(d.kind, "ask");
    assert.match(d.kind === "ask" ? d.reason : "", /director/);
  });

  test('cd "$X" && git push -f asks a gate that asked where', () => {
    const pushWhere = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) => {
        if (!e.command.runs("git push", { force: true })) return allow();
        const at = e.command.dirs("git push");
        return at.kind === "candidates" && at.dirs.includes("/protected")
          ? deny("force-push in /protected")
          : allow();
      },
    });
    assert.equal(decide('cd "$X" && git push -f', pushWhere).kind, "ask");
    assert.equal(
      decide("cd /protected && git push -f", pushWhere).kind,
      "deny",
    );
    assert.equal(decide("git push -f", pushWhere).kind, "allow");
  });

  test("an event without cwd asks rather than placing a relative leaf", () => {
    assert.equal(decide("git pull", trustedPullGuard, null).kind, "ask");
  });

  test("a gate that never asked where is not second-guessed", () => {
    assert.equal(decide('cd "$X" && git push -f', forcePushGuard).kind, "deny");
    assert.equal(decide('cd "$X" && ls', forcePushGuard).kind, "allow");
  });

  test("an unresolved leaf that does not run the program asked about is not counted", () => {
    assert.equal(decide('(cd "$X" && ls); git pull').kind, "allow");
  });
});

describe("asking where never overrides the gate", () => {
  test("the gate's own deny and ask are final", () => {
    const strict = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) => {
        const at = e.command.dirs("git pull");
        return at.kind === "unresolved"
          ? deny(`unknown: ${at.reason}`)
          : allow();
      },
    });
    assert.deepEqual(
      decide('cd "$X" && git pull', strict),
      deny("unknown: dynamic-dir"),
    );
    const asking = experimental_defineHook({
      on: "PreToolUse",
      decide: (e) =>
        e.command.dirs().kind === "unresolved" ? ask("where?") : allow(),
    });
    assert.deepEqual(decide('cd "$X" && ls', asking), ask("where?"));
  });
});
