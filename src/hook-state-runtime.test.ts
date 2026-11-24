/**
 * Runtime-owned named state, END TO END against the real CLI.
 *
 * The pure model is tested in `core/hook-state.test.ts`. Everything asserted HERE
 * lives in the trusted runtime and cannot be seen from a unit test: where the
 * store lands on disk, that a key can never address a path, that one hook's
 * record is what a DIFFERENT hook reads back, and that the write happens through
 * the runtime rather than through anything the hook can reach.
 *
 * That distinction is the whole reason this file exists. The predicates could all
 * be green while the runtime wrote to the wrong directory, or wrote nothing, and
 * an advisory hook whose success looks like silence would never tell anyone.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import { makeTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");

/** Records a fact when an MCP calendar tool ran — the WITNESS half. */
const WITNESS = `import { experimental_defineReact, tools, nothing, record } from "vigiles/hook";
export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("mcp__.*"),
  react: () => nothing(record("calendar.synced")),
});
`;

/** Reads that fact and self-throttles its own nudge — the READER half. */
const READER = `import { experimental_defineInject, state, inject, record } from "vigiles/hook";
export default experimental_defineInject({
  on: "UserPromptSubmit",
  needs: [state("calendar.synced"), state("calendar.nagged")],
  produce: (e) => {
    if (e.ctx["calendar.synced"].fresherThan("12h")) return inject("");
    if (e.ctx["calendar.nagged"].fresherThan("3h")) return inject("SHORT");
    return inject("FULL", record("calendar.nagged"));
  },
});
`;

/** Hand-builds its declaration, bypassing `record()`'s validation entirely. */
const SMUGGLER = `import { experimental_defineReact, nothing } from "vigiles/hook";
export default experimental_defineReact({
  on: "Stop",
  react: () => ({ ...nothing(), records: [
    { kind: "record", name: "../../../pwned", value: "x" },
    { kind: "record", name: "legit.key", value: "ok" },
  ] }),
});
`;

function makeFixture(hooks: Record<string, string>): string {
  const dir = makeTmpDir("hook-state");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, "node_modules", "vigiles"), "dir");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `{ "name": "state-fixture", "private": true, "type": "module" }\n`,
  );
  for (const [name, src] of Object.entries(hooks)) {
    writeFileSync(join(dir, ".claude", "hooks", name), src);
  }
  return dir;
}

function runHook(
  dir: string,
  hook: string,
  event: Record<string, unknown>,
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(
    process.execPath,
    [CLI, "hook-runtime", "run-program", `.claude/hooks/${hook}`],
    { cwd: dir, encoding: "utf-8", input: JSON.stringify(event) },
  );
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

const injected = (stdout: string): string =>
  (
    JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }
  ).hookSpecificOutput.additionalContext;

const statePath = (dir: string, key: string): string =>
  join(dir, ".vigiles", "state", ".claude", "hooks", `${key}.json`);

// ---------------------------------------------------------------------------

test("one hook RECORDS a fact and a DIFFERENT hook reads it back", () => {
  const dir = makeFixture({
    "witness.hook.mjs": WITNESS,
    "reader.hook.mjs": READER,
  });

  // 1. Nothing recorded yet. The reader must SPEAK — the direction that matters,
  //    because the failure this feature exists to end is a hook going quiet.
  const first = runHook(dir, "reader.hook.mjs", {});
  assert.equal(injected(first.stdout), "FULL");

  // 2. It recorded its OWN nudge, so the next turn escalates instead of repeating.
  assert.ok(existsSync(statePath(dir, "calendar.nagged")));
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "SHORT");

  // 3. The witness — a different hook, a different event — records the fact the
  //    reader is actually gated on. Nothing else in the session changes.
  const witnessed = runHook(dir, "witness.hook.mjs", {
    tool_name: "mcp__4f54037d-0499-426a-8573-6130f3da1ef8__list_events",
    tool_input: {},
    tool_response: "ok",
  });
  assert.equal(witnessed.code, 0);
  const entry = JSON.parse(
    readFileSync(statePath(dir, "calendar.synced"), "utf-8"),
  ) as { value: string; at: string; by: string };
  assert.equal(entry.value, "");
  assert.ok(!Number.isNaN(Date.parse(entry.at)), "at must be a real instant");
  assert.equal(
    entry.by,
    ".claude/hooks/witness.hook.mjs",
    "the store must name WHO claimed the fact — the only handle a human debugging this has",
  );

  // 4. …and the reader now goes quiet, on a fact it did not write.
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "");
});

test("the witness fires for a tool FAMILY, and not for an unrelated tool", () => {
  const dir = makeFixture({ "witness.hook.mjs": WITNESS });
  // The defect half, measured before the fix: an exact-string filter dropped this
  // event, so the hook was wired up, routed to, and silently never ran.
  runHook(dir, "witness.hook.mjs", {
    tool_name: "mcp__deadbeef__create_event",
    tool_input: {},
  });
  assert.ok(existsSync(statePath(dir, "calendar.synced")));

  // Clean half: a witness that fires on the wrong tool writes a FALSE fact, which
  // is worse than not firing. `Bash` must record nothing.
  const other = makeFixture({ "witness.hook.mjs": WITNESS });
  runHook(other, "witness.hook.mjs", { tool_name: "Bash", tool_input: {} });
  assert.ok(!existsSync(statePath(other, "calendar.synced")));
});

test("a key can never address a path: a smuggled write is refused, LOUDLY, and its valid sibling still lands", () => {
  const dir = makeFixture({ "smuggle.hook.mjs": SMUGGLER });
  const res = runHook(dir, "smuggle.hook.mjs", { stop_hook_active: false });

  assert.match(res.stderr, /refused to record \.\.\/\.\.\/\.\.\/pwned/);
  assert.equal(res.code, 0, "an advisory react must stay advisory");
  assert.ok(
    !existsSync(join(dir, "pwned.json")) &&
      !existsSync(join(dir, "..", "pwned.json")),
    "traversal must produce no file anywhere",
  );
  // Only the store directory exists, and only the valid key is in it — a refusal
  // must not silently drop the whole batch either.
  assert.deepEqual(
    readdirSync(join(dir, ".vigiles", "state", ".claude", "hooks")).sort(),
    ["legit.key.json"],
  );
  assert.equal(
    (
      JSON.parse(readFileSync(statePath(dir, "legit.key"), "utf-8")) as {
        value: string;
      }
    ).value,
    "ok",
  );
});

test("a react on Stop runs at all — it used to be dead, and dead looked exactly like quiet", () => {
  const dir = makeFixture({
    "stop.hook.mjs": `import { experimental_defineReact, notice, record, state } from "vigiles/hook";
export default experimental_defineReact({
  on: "Stop",
  needs: [state("retro.nagged")],
  react: (e) => e.ctx["retro.nagged"].fresherThan("1d")
    ? notice("QUIET")
    : notice("NUDGE", record("retro.nagged")),
});
`,
  });
  const first = runHook(dir, "stop.hook.mjs", { stop_hook_active: false });
  assert.match(first.stderr, /NUDGE/);
  assert.equal(first.code, 0);
  // Second Stop in the same day: the fact it recorded silences it.
  assert.match(
    runHook(dir, "stop.hook.mjs", { stop_hook_active: false }).stderr,
    /QUIET/,
  );
});

test("scope is the hook's DIRECTORY: siblings share a fact, a vendored plugin cannot see it", () => {
  const dir = makeFixture({
    "witness.hook.mjs": WITNESS,
    "reader.hook.mjs": READER,
  });
  // A second hook set, shipped somewhere else in the same checkout — the shape a
  // vendored plugin has.
  mkdirSync(join(dir, "vendor", "plugin", "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "vendor", "plugin", "hooks", "reader.hook.mjs"),
    READER,
  );

  runHook(dir, "witness.hook.mjs", {
    tool_name: "mcp__x__list_events",
    tool_input: {},
  });

  // The sibling in the SAME directory sees it and goes quiet (the requirement).
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "");

  // The plugin's identically-named hook, reading an identically-named key, does
  // NOT see it — so one plugin can neither read nor clobber another's facts.
  const foreign = spawnSync(
    process.execPath,
    [CLI, "hook-runtime", "run-program", "vendor/plugin/hooks/reader.hook.mjs"],
    { cwd: dir, encoding: "utf-8", input: "{}" },
  );
  assert.equal(
    injected(foreign.stdout),
    "FULL",
    "a different directory is a different namespace",
  );
  assert.ok(
    existsSync(
      join(
        dir,
        ".vigiles",
        "state",
        "vendor",
        "plugin",
        "hooks",
        "calendar.nagged.json",
      ),
    ),
    "the store MIRRORS the hook's directory, so a human can find the fact",
  );
});

test("a corrupt store entry makes the hook SPEAK, not go quiet", () => {
  const dir = makeFixture({ "reader.hook.mjs": READER });
  mkdirSync(join(dir, ".vigiles", "state", ".claude", "hooks"), {
    recursive: true,
  });
  // Both shapes of damage a real store can suffer: unparseable JSON, and valid
  // JSON whose timestamp is not a time. Either one must fail toward noise.
  writeFileSync(statePath(dir, "calendar.synced"), "{ this is not json");
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "FULL");

  writeFileSync(
    statePath(dir, "calendar.synced"),
    JSON.stringify({ value: "", at: "yesterday" }),
  );
  writeFileSync(
    statePath(dir, "calendar.nagged"),
    JSON.stringify({ value: "", at: new Date().toISOString() }),
  );
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "SHORT");

  // Clean half: a well-formed fresh entry really does silence it, so the test
  // above is measuring corruption handling and not a hook that always speaks.
  writeFileSync(
    statePath(dir, "calendar.synced"),
    JSON.stringify({ value: "", at: new Date().toISOString() }),
  );
  assert.equal(injected(runHook(dir, "reader.hook.mjs", {}).stdout), "");
});
