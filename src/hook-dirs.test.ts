/**
 * `e.command.dirs()` through the real runtime, on EVERY registered harness
 * protocol: the process a harness spawns (`vigiles hook-runtime run-program`),
 * fed a payload carrying the harness's `cwd`, its exit code and JSON read back
 * by `runHook` under each adapter's protocol.
 *
 * What differs per harness is only where `cwd` comes from — Claude Code moves
 * it with the agent's own `cd` between calls, Codex documents it as the
 * session's directory — and both send it, so both place a leaf the same way.
 * The decision is harness-neutral (unit tier: `src/core/hook-program-dirs.test.ts`).
 */
import { describe, test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runHook } from "./run-hook.js";
import { ADAPTERS } from "./adapter-registry.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = resolve(REPO_ROOT, "dist", "hook.js");
const TRUSTED = "/work/repo";

let dir = "";
let hookCmd = "";

beforeAll(() => {
  dir = makeTmpDir();
  const file = resolve(dir, "trusted-pull.hook.mjs");
  writeFileSync(
    file,
    `import { experimental_defineHook, deny, allow } from ${JSON.stringify(HOOK_DIST)};
const TRUSTED = ${JSON.stringify(TRUSTED)};
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) => {
    if (!e.command.runs("git pull")) return allow();
    const at = e.command.dirs("git pull");
    if (at.kind === "unresolved") return allow();
    return at.dirs.every((d) => d === TRUSTED || d.startsWith(TRUSTED + "/"))
      ? allow()
      : deny("git pull outside the trusted checkout");
  },
});
`,
  );
  hookCmd = `node ${CLI} hook-runtime run-program ${file}`;
});

afterAll(() => {
  cleanupTmpDir(dir);
});

const protocols = ADAPTERS.flatMap((a) =>
  a.hookProtocol ? [[a.name, a.hookProtocol] as const] : [],
);

test("more than one harness is covered", () => {
  assert.ok(protocols.length >= 2, `only ${protocols.length} hook protocol`);
});

describe.each(protocols)("%s", (_name, protocol) => {
  const run = (command: string) =>
    runHook(
      hookCmd,
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: TRUSTED,
      },
      { cwd: dir, protocol },
    );

  test("a pull in another repository is blocked", () => {
    for (const c of ["cd /foreign && git pull", "git -C /foreign pull"])
      assert.equal(run(c).blocked, true, c);
  });

  test("a pull in the trusted checkout is allowed", () => {
    for (const c of ["git pull", "cd ./sub && git pull"]) {
      const r = run(c);
      assert.equal(r.blocked, false, c);
      assert.notEqual(r.decision, "ask", c);
    }
  });

  test("a directory the hook cannot know is asked about, not allowed", () => {
    for (const c of ['cd "$X" && git pull', "cd /foreign; git pull"]) {
      const r = run(c);
      assert.equal(r.blocked, false, c);
      assert.equal(r.decision, "ask", c);
    }
  });
});
