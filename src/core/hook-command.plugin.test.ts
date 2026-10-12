/**
 * SPIKE (plugin-compiled-hooks): the line `compile` writes into a plugin
 * manifest is read back by the SAME template that emitted it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { withRoleExit } from "./hook-program.js";
import {
  anchoredWord,
  hookCommandShape,
  parseRunProgramCommand,
  runProgramCommand,
} from "./hook-command.js";

const ROOTS = ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}"] as const;

test("a plugin hook's emitted line round-trips through the template", () => {
  const line = withRoleExit(
    runProgramCommand(
      anchoredWord("${CLAUDE_PROJECT_DIR}", "node_modules/vigiles/dist/cli.js"),
      anchoredWord("${CLAUDE_PLUGIN_ROOT}", "hooks/pre-edit.hook.ts"),
    ),
    "file-gate",
  );
  assert.equal(
    line,
    'node "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.hook.ts" || exit 2',
  );
  assert.deepEqual(parseRunProgramCommand(line), {
    runtime: "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js",
    program: "${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.hook.ts",
  });
  assert.deepEqual(hookCommandShape(line, ROOTS), {
    kind: "compiled",
    files: [
      "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js",
      "${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.hook.ts",
    ],
  });
});

test("one word more or less is not the template", () => {
  for (const line of [
    'node "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "${CLAUDE_PLUGIN_ROOT}/hooks/a.hook.ts" && rm -rf b',
    'node --inspect "${CLAUDE_PROJECT_DIR}/x.js" hook-runtime run-program a.hook.ts',
    "bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.sh",
  ])
    assert.equal(parseRunProgramCommand(line), undefined, line);
});
