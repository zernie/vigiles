/**
 * Providers run WHEN READ, at most once per call (#396 piece (a)) — measured on
 * the REAL spawned runtime, because laziness is a property of how the host wires
 * `e.ctx`, not of `lazyContext` alone.
 *
 * Each provider is an inline `dangerously()` command that appends a line to a
 * marker file in a temp dir, so "did it run" and "how often" are observable
 * facts, not mocked ones.
 *
 * Harness scope (`test-both-harnesses`): the runtime's gate protocol is the
 * same on every harness and the payloads differ only in extra envelope fields
 * (turn id, model, permission mode), so every case runs under a bare payload
 * and an enveloped one. Harness names stay out of this file by lint rule.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");

const PAYLOADS: Record<string, (command: string) => object> = {
  bare: (command) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  }),
  enveloped: (command) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    turn_id: "t-1",
    model: "some-model",
    permission_mode: "default",
  }),
};

let dir: string;
beforeAll(() => {
  dir = makeTmpDir("lazy-providers");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, "node_modules", "vigiles"), "dir");
  writeFileSync(
    join(dir, "package.json"),
    `{ "name": "lazy-fixture", "private": true, "type": "module" }\n`,
  );
});
afterAll(() => {
  cleanupTmpDir(dir);
});

/** Write a gate whose provider commands touch `<name>.marker`; `body` is `decide`'s body. */
function writeHook(name: string, needs: string, body: string): string {
  const rel = `${name}.hook.mjs`;
  writeFileSync(
    join(dir, rel),
    `import { experimental_defineHook, deny, allow, dangerously } from "vigiles/hook";
export default experimental_defineHook({
  on: "PreToolUse",
  needs: [${needs}],
  decide: (e) => { ${body} },
});
`,
  );
  return rel;
}

const touch = (name: string, out = "x") =>
  `dangerously("${name}", "echo ${name} >> ${join(dir, name)}.marker && echo ${out}")`;

function run(hook: string, harness: string, command = "ls") {
  return spawnSync(
    process.execPath,
    [CLI, "hook-runtime", "run-program", hook],
    {
      cwd: dir,
      encoding: "utf-8",
      input: JSON.stringify(PAYLOADS[harness](command)),
    },
  );
}
const runs = (name: string): number => {
  const f = join(dir, `${name}.marker`);
  return existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").length : 0;
};

describe.each(Object.keys(PAYLOADS))("lazy providers, %s payload", (h) => {
  test("an unread side-effect provider does not run", () => {
    const hook = writeHook(
      `unread-${h}`,
      touch(`unread-${h}`),
      `return allow();`,
    );
    const r = run(hook, h);
    expect(r.status).toBe(0);
    expect(runs(`unread-${h}`)).toBe(0);
  });

  test("a read provider runs, once, even when read twice", () => {
    const n = `read-${h}`;
    const hook = writeHook(
      n,
      touch(n, "hello"),
      `return e.ctx["${n}"] === "hello" && e.ctx["${n}"] === "hello" ? deny("saw hello") : allow();`,
    );
    const r = run(hook, h);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("saw hello");
    expect(runs(n)).toBe(1);
  });

  test("a failing provider yields its default", () => {
    const n = `fail-${h}`;
    const hook = writeHook(
      n,
      `dangerously("${n}", "exit 3")`,
      `return e.ctx["${n}"] === "" ? deny("default") : allow();`,
    );
    const r = run(hook, h);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("default");
  });

  test("a provider that outlives the timeout yields its default, promptly", () => {
    const n = `hang-${h}`;
    const hook = writeHook(
      n,
      `dangerously("${n}", "sleep 30")`,
      `return e.ctx["${n}"] === "" ? deny("default") : allow();`,
    );
    const t0 = Date.now();
    const r = run(hook, h);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("default");
    expect(Date.now() - t0).toBeLessThan(25_000);
  }, 90_000);
});
