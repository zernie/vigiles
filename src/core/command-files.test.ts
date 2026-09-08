/**
 * Command-file-reference suite (vitest, unit tier — nothing is spawned).
 *
 * Both directions, because either alone is worthless here: the detector must
 * NAME the script an interpreter runs (or the sweep keeps scoring hooks that
 * cannot start), and must stay SILENT on the eight shapes measured in the wild
 * that merely look path-ish (or it accuses working hooks of being broken).
 */
import { describe, it, expect } from "vitest";
import { commandFileRefs } from "./command-files.js";

describe("commandFileRefs — names the script a command would run", () => {
  it("finds an interpreter's script, relative or absolute", () => {
    expect(commandFileRefs("python3 .claude/hooks/guard.py").refs).toEqual([
      ".claude/hooks/guard.py",
    ]);
    expect(commandFileRefs("bash /opt/hooks/plan-gate.sh").refs).toEqual([
      "/opt/hooks/plan-gate.sh",
    ]);
  });

  it("finds a script by EXTENSION even behind an unknown runner", () => {
    // The interpreter table is not load-bearing on its own: this is the half
    // that keeps a runtime nobody listed from becoming a silent miss.
    expect(commandFileRefs("some-exotic-runner hooks/guard.py").refs).toEqual([
      "hooks/guard.py",
    ]);
  });

  it("finds an interpreter's script with NO extension and no slash", () => {
    expect(commandFileRefs("python3 guard").refs).toEqual(["guard"]);
  });

  it("finds a head that is itself a path", () => {
    expect(commandFileRefs("./hooks/guard.sh --flag").refs).toEqual([
      "./hooks/guard.sh",
    ]);
  });

  it("expands only the variables whose value it was given", () => {
    expect(
      commandFileRefs('node "$ROOT"/scripts/run.cjs', { ROOT: "/plug" }).refs,
    ).toEqual(["/plug/scripts/run.cjs"]);
    // Unknown variable ⇒ the whole word is unresolved, and we invent nothing.
    expect(commandFileRefs('node "$ROOT"/scripts/run.cjs').refs).toEqual([]);
  });

  it("reaches a leaf nested in a pipeline or a compound", () => {
    expect(
      commandFileRefs("cat | python3 hooks/a.py && bash hooks/b.sh").refs,
    ).toEqual(["hooks/a.py", "hooks/b.sh"]);
  });

  it("reports a parse failure rather than pretending the command is clean", () => {
    const r = commandFileRefs("bash -c 'unterminated");
    expect(r.parsed).toBe(false);
    expect(r.refs).toEqual([]);
  });
});

describe("commandFileRefs — silent on everything that only looks path-ish", () => {
  // The eight shapes the WIDE rule got wrong across davila7's 107 real hook
  // registrations. Each is a working hook; flagging any of them is crying wolf.
  it.each([
    ["cat ~/.claude/session_start.tmp"],
    ["rm ~/.claude/bash_start.tmp"],
    ["mv ~/.claude/performance.csv ~/.claude/performance.csv.tmp"],
    ["tail -n 100 ~/.claude/performance.csv"],
    ["echo N/A"],
  ])("stays quiet on %s", (command) => {
    expect(commandFileRefs(command).refs).toEqual([]);
  });

  it("skips a URL, a flag and an env assignment", () => {
    expect(commandFileRefs("curl https://example.com/install.sh").refs).toEqual(
      [],
    );
    expect(commandFileRefs("python3 -m json.tool").refs).toEqual([]);
    expect(commandFileRefs("FOO=a/b.sh true").refs).toEqual([]);
  });

  it("skips the inline program text of -c / -e", () => {
    // Program text, not a path — the shell never looks for it on disk.
    expect(commandFileRefs("bash -c exit").refs).toEqual([]);
    expect(commandFileRefs("node -e process.exit").refs).toEqual([]);
    expect(commandFileRefs(`bash -c 'echo hi; exit 0'`).refs).toEqual([]);
  });

  it("stops at the interpreter's FIRST operand — the rest are its arguments", () => {
    // `production` is an argument to the script, not a second script. Reporting
    // it would accuse a working hook of naming a missing file.
    expect(
      commandFileRefs("bash hooks/deploy.sh production --yes").refs,
    ).toEqual(["hooks/deploy.sh"]);
    expect(commandFileRefs("python3 guard extra").refs).toEqual(["guard"]);
  });

  it("does not descend into a command substitution", () => {
    // `which` PRINTS where a program lives; it does not run it.
    expect(commandFileRefs("bash $(which guard.sh)").refs).toEqual([]);
  });

  it("skips a glob, a substitution and a BARE head", () => {
    expect(commandFileRefs("bash hooks/*.sh").refs).toEqual([]);
    expect(commandFileRefs("bash $(which guard.sh)").refs).toEqual([]);
    // A bare head may be a builtin or a function — `echo` has no file.
    expect(commandFileRefs("echo watching").refs).toEqual([]);
    expect(commandFileRefs("true").refs).toEqual([]);
  });
});

describe("commandFileRefs — an extension is not a licence to execute", () => {
  it("does not report a file a DATA-ONLY head merely names", () => {
    // 🔴 THE EXTENSION RULE NEEDED A HEAD. `rm` never executes its operand, so
    // an ordinary cleanup hook whose file is INTENTIONALLY absent was reported
    // as running a missing script — crying wolf on a hook that is perfectly
    // fine, which is the one error this module says it will not make.
    expect(commandFileRefs("rm -f /tmp/stale.sh").refs).toEqual([]);
    expect(commandFileRefs("mv old/hook.py archive/hook.py").refs).toEqual([]);
    expect(commandFileRefs("cat .claude/hooks/guard.sh").refs).toEqual([]);
    expect(commandFileRefs("git add scripts/build.sh").refs).toEqual([]);
  });

  it("still reports a script an INTERPRETER head runs, extension or not", () => {
    // The narrowing touches only the extension branch: a listed interpreter
    // speaks for its first operand exactly as before, so nothing measured on
    // the corpus is lost. (Re-measured 2026-09-08 on davila7: 5 hits before,
    // 5 after.)
    expect(
      commandFileRefs("python3 .claude/hooks/change-logger.py").refs,
    ).toEqual([".claude/hooks/change-logger.py"]);
    expect(
      commandFileRefs("bash .claude/hooks/shell-wrapper-guard.sh").refs,
    ).toEqual([".claude/hooks/shell-wrapper-guard.sh"]);
  });

  it("still reports an extension under an UNKNOWN head", () => {
    // The branch is narrowed, not removed — its whole job is the runtime we
    // failed to list, and an unlisted head is still unknown to us.
    expect(commandFileRefs("some-exotic-runner hooks/guard.py").refs).toEqual([
      "hooks/guard.py",
    ]);
  });

  it("still reports a data-only head that IS itself a path", () => {
    // `DATA_ONLY_HEADS` silences the operand rule, never the head rule: the
    // shell must find `./rm` to run it whatever its name suggests.
    expect(commandFileRefs("./tools/rm --all").refs).toEqual(["./tools/rm"]);
  });
});

describe("the interpreter behind a pass-through wrapper", () => {
  // Codex round 2, P1: `env python3 guard` named NO file — `env` is not an
  // interpreter and `guard` carries no extension — so a hook whose script is
  // absent pre-flighted clean, ran, exited 2 (python's cannot-open-script code,
  // which is this harness's DENY code) and was scored as a perfect block. The
  // fix asks `stripWrappers` in `core/bash-effects.ts`, which already owns the
  // wrapper list for the effect classifier, rather than starting a second one.
  it.each([
    ["env python3 guard", "guard"],
    ["command python3 guard", "guard"],
    ["timeout 5 python3 guard", "guard"],
    ["sudo python3 guard", "guard"],
    ["env FOO=bar python3 .claude/hooks/g.py", ".claude/hooks/g.py"],
    ["sudo timeout 5 python3 guard", "guard"], // recursive, via stripWrappers
    ["/usr/bin/env python3 guard", "guard"], // the list keys on basenames
  ])("%s names %s", (command, script) => {
    expect(commandFileRefs(command).refs).toEqual([script]);
  });

  it("reports a wrapped head that is itself a path", () => {
    expect(commandFileRefs("env ./hooks/guard.sh").refs).toEqual([
      "./hooks/guard.sh",
    ]);
  });

  it("says NOTHING when a wrapper changes directory", () => {
    // `guard` is resolved against a directory this module was never told about,
    // so naming it would accuse a guard that is on disk where it belongs. The
    // cost is the hook's measurement, which is the safe direction here.
    expect(commandFileRefs("env -C /elsewhere python3 guard").refs).toEqual([]);
  });

  it("does NOT unwrap through a word it could not resolve", () => {
    // An unresolvable word stops the unwrapping rather than being unwrapped
    // through: guessing which word is the head is how a wrong file gets named.
    expect(commandFileRefs("env $RUNNER guard").refs).toEqual([]);
  });

  it("leaves `exec` alone — a NAMED remainder, not a fixed one", () => {
    // `exec` is a pass-through, but it is not in `WRAPPER_HEADS`, and that list
    // is also the safety matcher's. Adding it belongs there, with the measuring
    // that a change to the matcher deserves — not in a private copy here. This
    // test exists so the gap is recorded rather than rediscovered.
    expect(commandFileRefs("exec python3 guard").refs).toEqual([]);
  });

  it("still leaves an unwrapped command exactly as it was", () => {
    expect(commandFileRefs("python3 guard").refs).toEqual(["guard"]);
    expect(commandFileRefs("bash hooks/g.sh production").refs).toEqual([
      "hooks/g.sh",
    ]);
  });
});
