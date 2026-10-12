/**
 * `hookCommandShape` — what a static reader may say about a hook command line,
 * and nothing more.
 *
 * Three answers. A line vigiles WROTE (`hook-runtime …`, the session check) is
 * read by its own template, so the files it runs are known exactly. A
 * hand-written line that STARTS by running a literal path (`./x.sh`,
 * `bash ${ROOT}/x.sh`) has that one file to check. Everything else is opaque:
 * the reader does not guess which word is the script.
 *
 * The root tokens are passed in, so this suite spells them in neutral names —
 * the classifier is harness-agnostic, and a harness's real tokens are covered
 * where the adapter is (`adapters/claude-code/hand-written-hooks.test.ts`,
 * `adapters/codex/codex.test.ts`).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { HOOK_CHECK_REF, hookCommandShape } from "./hook-command.js";

const ROOTS = ["${PLUGIN_ROOT}", "${PROJECT_DIR}"] as const;
const shape = (command: string) => hookCommandShape(command, ROOTS);

test("a line vigiles compiled is read by its template: runner and program, exactly", () => {
  assert.deepEqual(
    shape(
      'node "${PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$PROJECT_DIR/.vigiles/hooks/x.hook.mjs" || exit 0',
    ),
    {
      kind: "compiled",
      files: [
        "${PROJECT_DIR}/node_modules/vigiles/dist/cli.js",
        "${PROJECT_DIR}/.vigiles/hooks/x.hook.mjs",
      ],
    },
  );
  // The relative spelling a harness without a project-root variable gets.
  assert.deepEqual(
    shape(
      "node node_modules/vigiles/dist/cli.js hook-runtime run-program .vigiles/hooks/x.hook.mjs || exit 2",
    ),
    {
      kind: "compiled",
      files: ["node_modules/vigiles/dist/cli.js", ".vigiles/hooks/x.hook.mjs"],
    },
  );
});

test("a runtime started through npx names no file — npm resolves it", () => {
  assert.deepEqual(shape("npx vigiles hook-runtime refs"), {
    kind: "compiled",
    files: [],
  });
  assert.deepEqual(
    shape("npx --no-install vigiles hook-runtime eval-lock-nudge"),
    { kind: "compiled", files: [] },
  );
  assert.deepEqual(shape("npx vigiles hook-runtime run-program a.hook.mjs"), {
    kind: "compiled",
    files: ["a.hook.mjs"],
  });
});

test("the start-of-session check `compile` writes is vigiles's own line too", () => {
  assert.deepEqual(shape(`sh "\${PROJECT_DIR}/${HOOK_CHECK_REF}" || exit 0`), {
    kind: "compiled",
    files: [`\${PROJECT_DIR}/${HOOK_CHECK_REF}`],
  });
});

test("our words inside someone else's line are not our line", () => {
  // The template is the WHOLE line. A command that merely mentions the verb,
  // or chains more work after it, is hand-written.
  assert.equal(shape("echo hook-runtime run-program x.mjs").kind, "opaque");
  assert.equal(
    shape("node dist/cli.js hook-runtime run-program a.mjs && rm -rf b").kind,
    "script",
  );
  assert.equal(shape("sh ./other.sh || exit 0").kind, "script");
});

test("a hand-written line that starts by running a literal path has that one file to check", () => {
  const script = (command: string) => {
    const s = shape(command);
    return s.kind === "script" ? s.file : s.kind;
  };
  assert.equal(script("./hooks/x.sh"), "./hooks/x.sh");
  assert.equal(
    script("${PLUGIN_ROOT}/hooks/x.sh --flag"),
    "${PLUGIN_ROOT}/hooks/x.sh",
  );
  assert.equal(
    script('"$PROJECT_DIR"/hooks/x.sh'),
    "${PROJECT_DIR}/hooks/x.sh",
  );
  assert.equal(
    script("bash ${PLUGIN_ROOT}/hooks/x.sh"),
    "${PLUGIN_ROOT}/hooks/x.sh",
  );
  assert.equal(
    script('node "$PROJECT_DIR/hooks/x.mjs" || true'),
    "${PROJECT_DIR}/hooks/x.mjs",
  );
  assert.equal(script("python3 hooks/x.py"), "hooks/x.py");
  // Only the head is read: whatever follows it is not searched for paths.
  assert.equal(
    script('bash ${PLUGIN_ROOT}/hooks/x.sh && find . -name "*.js"'),
    "${PLUGIN_ROOT}/hooks/x.sh",
  );
});

test("anything else is opaque — no word is guessed to be the script", () => {
  for (const command of [
    "sh -c 'node hooks/x.mjs'",
    "node -e \"require('./hooks/x.js')\"",
    'cd "$PLUGIN_ROOT" && node hooks/x.mjs',
    "[ ! -f scripts/gen.py ] || scripts/gen.py",
    'node "$(dirname "$0")/x.js"',
    '"$HOME"/x.sh',
    'bash "${PROJECT_DIR:-.}/x.sh"',
    "FILE=$(cat | jq -r .x) && echo $FILE",
    "npx prettier --check .",
    "guard.sh",
    "bash",
    "bash -x hooks/x.sh",
    "if true; then ./x.sh; fi",
    "bash hooks/*.sh",
    "unterminated 'quote",
  ]) {
    assert.deepEqual(shape(command), { kind: "opaque" }, command);
  }
});
