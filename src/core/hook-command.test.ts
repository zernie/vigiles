/**
 * The hook-line plan: every line `compile` and `init` would write, built from
 * the same template functions the writers call. A reader compares a wired line
 * against it by identity; nothing here parses a command line.
 *
 * Neutral root variable names: the plan is harness-agnostic, and a harness's
 * real tokens are covered where its adapter is
 * (`adapters/claude-code/hand-written-hooks.test.ts`).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  HOOK_CHECK_REF,
  INIT_NUDGE_COMMANDS,
  INSTALLED_HOOK_RUNTIME,
  commandNamesRef,
  hookGateRef,
  hookLinePlan,
  hookRuntimeRef,
  plannedHookLines,
  runProgramCommand,
  sessionCheckCommand,
} from "./hook-command.js";
import { withRoleExit } from "./hook-program.js";

const TOKENS = ["${PROJECT_DIR}"];
const REF = ".vigiles/hooks/x.hook.mjs";

test("a compiled hook's planned line is exactly what the writer's helpers produce", () => {
  const [line] = plannedHookLines({
    sources: [{ ref: REF, role: "react" }],
    runtime: INSTALLED_HOOK_RUNTIME,
    projectRootTokens: TOKENS,
  });
  assert.equal(
    line?.command,
    withRoleExit(
      runProgramCommand(hookRuntimeRef(TOKENS), hookGateRef(REF, TOKENS)),
      "react",
    ),
  );
  assert.equal(
    line?.command,
    'node "${PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "${PROJECT_DIR}/.vigiles/hooks/x.hook.mjs" || exit 0',
  );
  assert.deepEqual(line?.files, [
    "${PROJECT_DIR}/node_modules/vigiles/dist/cli.js",
    "${PROJECT_DIR}/.vigiles/hooks/x.hook.mjs",
    "${PROJECT_DIR}/.vigiles/hooks/x.hook.mjs.json",
  ]);
});

test("a gate ends `|| exit 2`; a harness with no root variable gets relative paths", () => {
  const [line] = plannedHookLines({
    sources: [{ ref: REF, role: "bash-gate" }],
    runtime: INSTALLED_HOOK_RUNTIME,
    projectRootTokens: undefined,
  });
  assert.equal(
    line?.command,
    "node node_modules/vigiles/dist/cli.js hook-runtime run-program .vigiles/hooks/x.hook.mjs || exit 2",
  );
});

test("a source compile never recorded a role for has no planned line; the session check and init's nudges always do", () => {
  const lines = plannedHookLines({
    sources: [{ ref: REF }],
    runtime: INSTALLED_HOOK_RUNTIME,
    projectRootTokens: TOKENS,
  }).map((l) => l.command);
  assert.deepEqual(lines, [
    sessionCheckCommand(TOKENS),
    ...Object.values(INIT_NUDGE_COMMANDS),
  ]);
  assert.equal(
    sessionCheckCommand(TOKENS),
    `sh "\${PROJECT_DIR}/${HOOK_CHECK_REF}" || exit 0`,
  );
});

test("hookLinePlan reads the role from the stamp and the runtime from package.json", () => {
  const files: Readonly<Record<string, string>> = {
    ".vigiles/hooks/x.hook.mjs.json": JSON.stringify({
      stamp: "s",
      role: "file-gate",
    }),
    "package.json": JSON.stringify({ name: "vigiles", bin: "dist/cli.js" }),
  };
  const plan = hookLinePlan([REF], (ref) => files[ref], TOKENS);
  assert.deepEqual(plan.sources, [REF]);
  assert.equal(
    plan.lines[0]?.command,
    'node "${PROJECT_DIR}/dist/cli.js" hook-runtime run-program "${PROJECT_DIR}/.vigiles/hooks/x.hook.mjs" || exit 2',
  );
  // An unreadable stamp, or a role that is not one, plans nothing for the source.
  for (const stamp of ["{ not json", JSON.stringify({ role: "nope" })]) {
    const none = hookLinePlan(
      [REF],
      (ref) => (ref === "package.json" ? undefined : stamp),
      TOKENS,
    );
    assert.equal(
      none.lines.length,
      1 + Object.keys(INIT_NUDGE_COMMANDS).length,
    );
  }
});

test("commandNamesRef is compile's merge key: either spelling of a ref, never a longer name", () => {
  const same = (w: string) => w.replace(/^\.\//, "");
  const names = (command: string) =>
    commandNamesRef(command, [REF], same, TOKENS);
  assert.equal(names(`node x "$PROJECT_DIR/${REF}"`), true);
  assert.equal(names(`node x "\${PROJECT_DIR}/${REF}" || exit 0`), true);
  assert.equal(names(`node x ./${REF} || exit 0`), true);
  assert.equal(names("node x .vigiles/hooks/my-x.hook.mjs"), false);
  // The root variables are the caller's (its harness layout): core strips no
  // variable it was not handed.
  assert.equal(names(`node x "$OTHER_DIR/${REF}"`), false);
  assert.equal(
    commandNamesRef(`node x "$PROJECT_DIR/${REF}"`, [REF], same, []),
    false,
  );
});
