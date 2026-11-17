/**
 * #396 (a) on Claude Code's payload: a react declared for `Bash` alone reads the
 * command it reacts to. The decode is core (`runReact`); this file pins the
 * PAYLOAD it is fed, as Claude Code sends it on `PostToolUse` for a shell call.
 * The Codex twin is ../codex/react-command.test.ts.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  experimental_defineReact,
  tools,
  notice,
  nothing,
  runReact,
} from "../../core/hook-program.js";

const pushNotice = experimental_defineReact({
  on: "PostToolUse",
  match: tools("Bash"),
  react: (e) =>
    e.command.runs("git push") ? notice(`pushed: ${e.command.raw}`) : nothing(),
});

const post = (command: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "x" },
  tool_response: { stdout: "", stderr: "", interrupted: false },
  cwd: "/repo",
});

test("a Bash-only react sees e.command on a Claude Code payload", () => {
  const pushed = runReact(pushNotice, post("git push origin main"));
  assert.equal(pushed.kind, "notice");
  if (pushed.kind === "notice")
    assert.equal(pushed.message, "pushed: git push origin main");
  assert.equal(runReact(pushNotice, post("git status")).kind, "none");
});

test("the command is the AST view, not a substring", () => {
  // A push inside a compound line is seen…
  assert.equal(
    runReact(pushNotice, post("cd repo && git push")).kind,
    "notice",
  );
  // …and a push merely QUOTED inside another command is not.
  assert.equal(runReact(pushNotice, post("echo 'git push'")).kind, "none");
});

test("a non-shell tool carrying no command does not fire the Bash-only react", () => {
  assert.equal(
    runReact(pushNotice, {
      tool_name: "Edit",
      tool_input: { file_path: "a.ts" },
    }).kind,
    "none",
  );
});
