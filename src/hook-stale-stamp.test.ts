/**
 * ONLY A HOOK'S OWN DECISION BLOCKS — through the real runtime (`vigiles
 * hook-runtime run-program`) and through the line `vigiles compile` wires, on
 * both harnesses.
 *
 * The contract (`core/hook-exit.ts`): exit 2 only when the hook's `decide`
 * denied; exit 1, with one stderr line naming the cause and the fix, for every
 * failure — a stale stamp, a hook that will not load, an event that is not
 * JSON, a react command that fails; exit 0 otherwise. What a failure does to the
 * action is the wiring's failure policy: on Claude Code an `onFailure` key
 * (`block` for a tool gate, `continue` for every other role); on Codex, which
 * has no such key, the `|| exit N` ending it always had.
 *
 * The incident this exists for: an `inject` hook wired on `UserPromptSubmit`,
 * edited and not recompiled. The runtime exited 2 on EVERY prompt, so the human
 * was locked out of their own session.
 *
 * P0 of the change is a gate that stops protecting, so the deny arm is asserted
 * beside every failure arm, and the property test feeds every failure kind to
 * every role and asserts the exit is never 2.
 */
import { describe, test, expect } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { ADAPTERS, detectAdapter } from "./adapter-registry.js";
import type { DispatchKind } from "./core/hook-program.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = pathToFileURL(resolve(REPO_ROOT, "dist", "hook.js")).href;

/** Every registered harness that runs shell hooks — the runtime is theirs. */
const HARNESSES = ADAPTERS.flatMap((a) =>
  a.shellHooks ? [{ adapter: a, protocol: a.hookProtocol }] : [],
);
type Harness = (typeof HARNESSES)[number];

const BASH_GATE = `import { experimental_defineHook, deny, allow } from "${HOOK_DIST}";
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("rm", { force: true }) ? deny("DANGEROUS-RM") : allow(),
});`;

const INJECT = `import { experimental_defineInject, inject } from "${HOOK_DIST}";
export default experimental_defineInject({
  on: "UserPromptSubmit",
  produce: () => inject("THE-HOOK-BODY-RAN"),
});`;

/** One hook per role, each of which would leave a trace if its body ran. */
const ROLE_FIXTURES: Readonly<
  Record<DispatchKind, { source: string; payload: Record<string, unknown> }>
> = {
  "bash-gate": {
    source: BASH_GATE,
    payload: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    },
  },
  "file-gate": {
    source: `import { experimental_defineFileGate, deny, tools } from "${HOOK_DIST}";
export default experimental_defineFileGate({ on: "PreToolUse", match: tools("Write"), decide: () => deny("THE-HOOK-BODY-RAN") });`,
    payload: {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", content: "x" },
    },
  },
  "prompt-gate": {
    source: `import { experimental_definePromptGate, deny } from "${HOOK_DIST}";
export default experimental_definePromptGate({ on: "UserPromptSubmit", decide: () => deny("THE-HOOK-BODY-RAN") });`,
    payload: { hook_event_name: "UserPromptSubmit", prompt: "hello" },
  },
  "stop-gate": {
    source: `import { experimental_defineStopGate, deny } from "${HOOK_DIST}";
export default experimental_defineStopGate({ on: "Stop", decide: () => deny("THE-HOOK-BODY-RAN") });`,
    payload: { hook_event_name: "Stop" },
  },
  inject: {
    source: INJECT,
    payload: { hook_event_name: "UserPromptSubmit", prompt: "hello" },
  },
  react: {
    source: `import { experimental_defineReact, notice, tools } from "${HOOK_DIST}";
export default experimental_defineReact({ on: "PostToolUse", match: tools("Write"), react: () => notice("THE-HOOK-BODY-RAN") });`,
    payload: {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/a.ts", content: "x" },
    },
  },
};

const ROLES: readonly DispatchKind[] = [
  "bash-gate",
  "file-gate",
  "prompt-gate",
  "stop-gate",
  "inject",
  "react",
];

/** The same hook, with its answer replaced by a throw (`decide`, `produce` or `react`). */
function throwing(source: string): string {
  const out = source.replace(
    /(decide|produce|react): (\(e\)|\(\)) =>[\s\S]*?(?=,?\s*\}\);\s*$)/,
    '$1: () => { throw new Error("BOOM"); }',
  );
  if (out === source) throw new Error(`no answer to replace in: ${source}`);
  return out;
}

/** Make `dir` read as this harness's project: its own settings file, empty. */
function plantHarness(dir: string, h: Harness): void {
  const { layout } = h.adapter;
  const settings = join(dir, layout.settingsPath);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, layout.settings.render({}));
}

/** A hook source in `hooks/`, with or without a sidecar whose stamp no longer matches. */
function plantHook(
  dir: string,
  name: string,
  source: string,
  stamp: "stale" | "none",
): string {
  const file = join(dir, "hooks", name);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(file, source);
  if (stamp === "stale") {
    mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".vigiles", "hooks", `${name}.json`),
      JSON.stringify({ file, stamp: "0000000000000000" }) + "\n",
    );
  }
  return file;
}

/** Run the REAL runtime on `file` with `stdin` exactly as given. */
function runtime(dir: string, file: string | undefined, stdin: string) {
  const r = spawnSync(
    "node",
    [CLI, "hook-runtime", "run-program", ...(file ? [file] : [])],
    {
      cwd: dir,
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    },
  );
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fire(
  h: Harness,
  dir: string,
  file: string,
  payload: Record<string, unknown>,
) {
  return runHook(
    `node ${CLI} hook-runtime run-program ${file}`,
    { cwd: dir, ...payload },
    { cwd: dir, protocol: h.protocol },
  );
}

/** One line on stderr: the cause and the fix, never a block's reason. */
function expectFailureLine(stderr: string, ...mentions: string[]): void {
  const line = stderr
    .split("\n")
    .find((l) => l.startsWith("vigiles: ") && l.includes(" failed — "));
  expect(line, stderr).toBeDefined();
  expect(line).toMatch(/\. Fix: .+\.$/);
  for (const m of mentions) expect(line).toContain(m);
}

test("covers more than one harness", () => {
  expect(HARNESSES.length).toBeGreaterThan(1);
});

for (const h of HARNESSES) {
  describe(`through the runtime on ${h.adapter.name}`, () => {
    test("(1) a bash gate whose decide denies a dangerous command still exits 2", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        expect(detectAdapter(dir).name).toBe(h.adapter.name);
        const file = plantHook(dir, "gate.hook.mjs", BASH_GATE, "none");
        const r = fire(h, dir, file, ROLE_FIXTURES["bash-gate"].payload);
        expect(r.exitCode).toBe(2);
        expect(r.blocked).toBe(true);
        expect(r.stderr).toContain("DANGEROUS-RM");
        // …and the same gate on a harmless command passes.
        const ok = fire(h, dir, file, {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        });
        expect(ok.exitCode).toBe(0);
      } finally {
        cleanupTmpDir(dir);
      }
    });

    test("(2) the same gate with a stale stamp exits 1, its body not run", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        const file = plantHook(dir, "gate.hook.mjs", BASH_GATE, "stale");
        const r = fire(h, dir, file, ROLE_FIXTURES["bash-gate"].payload);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).not.toContain("DANGEROUS-RM");
        expectFailureLine(r.stderr, file, `vigiles compile ${file}`, "{}");
      } finally {
        cleanupTmpDir(dir);
      }
    });

    test("(3) THE INCIDENT: an inject hook on UserPromptSubmit with a stale stamp exits 1, body not run", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        const file = plantHook(dir, "heartbeat.hook.mjs", INJECT, "stale");
        const r = fire(h, dir, file, ROLE_FIXTURES.inject.payload);
        expect(r.exitCode).toBe(1);
        expect(r.blocked).toBe(false);
        expect(r.stdout).not.toContain("THE-HOOK-BODY-RAN");
        expect(r.stdout.trim()).toBe("");
        expectFailureLine(r.stderr, file, `vigiles compile ${file}`);
      } finally {
        cleanupTmpDir(dir);
      }
    });
  });
}

/**
 * Every way the runtime can fail before the hook answers, each built in `dir`
 * for a hook of `role`: returns the hook file to run and the stdin to send.
 */
const FAILURES: Readonly<
  Record<
    string,
    (
      dir: string,
      role: DispatchKind,
    ) => { file: string | undefined; stdin: string; says?: string }
  >
> = {
  "stale stamp": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}.hook.mjs`,
      ROLE_FIXTURES[role].source,
      "stale",
    ),
    stdin: JSON.stringify({ cwd: dir, ...ROLE_FIXTURES[role].payload }),
    says: "does not match its compiled stamp",
  }),
  "missing hook file": (dir, role) => ({
    file: join(dir, "hooks", `${role}-gone.hook.mjs`),
    stdin: JSON.stringify({ cwd: dir, ...ROLE_FIXTURES[role].payload }),
  }),
  "module load error": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}-broken.hook.mjs`,
      `${ROLE_FIXTURES[role].source}\nthis is not javascript (`,
      "none",
    ),
    stdin: JSON.stringify({ cwd: dir, ...ROLE_FIXTURES[role].payload }),
  }),
  "no default export": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}-empty.hook.mjs`,
      "export const x = 1;\n",
      "none",
    ),
    stdin: JSON.stringify({ cwd: dir, ...ROLE_FIXTURES[role].payload }),
  }),
  "a throw inside the hook's own code": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}-throws.hook.mjs`,
      throwing(ROLE_FIXTURES[role].source),
      "none",
    ),
    stdin: JSON.stringify({ cwd: dir, ...ROLE_FIXTURES[role].payload }),
    says: "BOOM",
  }),
  "unparsable event JSON": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}.hook.mjs`,
      ROLE_FIXTURES[role].source,
      "none",
    ),
    stdin: "{ not json",
  }),
  "empty stdin": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}.hook.mjs`,
      ROLE_FIXTURES[role].source,
      "none",
    ),
    stdin: "",
  }),
  "a JSON event that is not an object": (dir, role) => ({
    file: plantHook(
      dir,
      `${role}.hook.mjs`,
      ROLE_FIXTURES[role].source,
      "none",
    ),
    stdin: "[1,2]",
  }),
  "no hook file argument": () => ({ file: undefined, stdin: "{}" }),
};

describe("(4) every failure kind × every role exits 1, never 2", () => {
  for (const [kind, build] of Object.entries(FAILURES)) {
    for (const role of ROLES) {
      test(`${kind} on a ${role}`, () => {
        const dir = makeTmpDir();
        try {
          const { file, stdin, says } = build(dir, role);
          const r = runtime(dir, file, stdin);
          expect(r.exitCode, r.stderr).not.toBe(2);
          expect(r.exitCode, r.stderr).toBe(1);
          expect(r.stdout).not.toContain("THE-HOOK-BODY-RAN");
          expect(r.stderr).not.toContain("THE-HOOK-BODY-RAN");
          expectFailureLine(r.stderr, ...(says === undefined ? [] : [says]));
        } finally {
          cleanupTmpDir(dir);
        }
      });
    }
  }

  test("a react whose command exits 2 is a failure (1), not a block", () => {
    const dir = makeTmpDir();
    try {
      const file = plantHook(
        dir,
        "fmt.hook.mjs",
        `import { experimental_defineReact, run, tools } from "${HOOK_DIST}";
export default experimental_defineReact({ on: "PostToolUse", match: tools("Write"), react: () => run("exit 2") });`,
        "none",
      );
      const r = runtime(
        dir,
        file,
        JSON.stringify({ cwd: dir, ...ROLE_FIXTURES.react.payload }),
      );
      expect(r.exitCode, r.stderr).toBe(1);
      expectFailureLine(r.stderr, "exited 2");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

test("the runtime module itself missing (a broken install) is a failure (1), in one line", () => {
  // The CLI shim alone, without `hook-runtime.js` beside it: first with the
  // exit-code module, then without even that.
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, "core"), { recursive: true });
    copyFileSync(CLI, join(dir, "cli.js"));
    copyFileSync(
      resolve(REPO_ROOT, "dist", "core", "hook-exit.js"),
      join(dir, "core", "hook-exit.js"),
    );
    const shim = () =>
      spawnSync(
        "node",
        [join(dir, "cli.js"), "hook-runtime", "run-program", "x.hook.mjs"],
        { input: "{}", encoding: "utf-8" },
      );
    const withExitModule = shim();
    expect(withExitModule.status).toBe(1);
    expect(withExitModule.stderr.trim().split("\n")).toHaveLength(1);
    expectFailureLine(withExitModule.stderr, "did not load");
    rmSync(join(dir, "core", "hook-exit.js"));
    const bare = shim();
    expect(bare.status).toBe(1);
    expect(bare.stderr.trim().split("\n")).toHaveLength(1);
    expectFailureLine(bare.stderr, "did not load");
  } finally {
    cleanupTmpDir(dir);
  }
});

/** A compiled hook may import only `vigiles/hook`, which the link below resolves. */
const asConsumer = (source: string): string =>
  source.replaceAll(`"${HOOK_DIST}"`, '"vigiles/hook"');

/** A consumer repo for `h`: vigiles installed (a link to this build), the hook in `.vigiles/hooks/`, compiled. */
function consumer(h: Harness, name: string, source: string): string {
  const dir = makeTmpDir();
  plantHarness(dir, h);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, join(dir, "node_modules", "vigiles"));
  writeFileSync(join(dir, "package.json"), '{"name":"t"}\n');
  mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".vigiles", "hooks", name), asConsumer(source));
  const r = spawnSync("node", [CLI, "compile", `.vigiles/hooks/${name}`], {
    cwd: dir,
    encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return dir;
}

interface Handler {
  readonly command: string;
  readonly onFailure?: unknown;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One wired entry as handlers: Claude Code nests them under `hooks`, Codex's entry is the handler. */
function handlersOf(entry: unknown): Handler[] {
  if (!isRecord(entry)) return [];
  if (Array.isArray(entry.hooks)) return entry.hooks.flatMap(handlersOf);
  return typeof entry.command === "string"
    ? [{ command: entry.command, onFailure: entry.onFailure }]
    : [];
}

/** Every handler `compile` wired under `event`, read back through the harness's own codec. */
function handlers(h: Harness, dir: string, event: string): Handler[] {
  const { layout } = h.adapter;
  const parsed: unknown = layout.settings.parse(
    readFileSync(join(dir, layout.settingsPath), "utf-8"),
  );
  const hooks = isRecord(parsed) ? parsed.hooks : undefined;
  const entries = isRecord(hooks) ? hooks[event] : undefined;
  return Array.isArray(entries) ? entries.flatMap(handlersOf) : [];
}

const usesHandlerField = (h: Harness): boolean =>
  h.adapter.layout.hookFailureWiring === "handler-field";

for (const h of HARNESSES) {
  test(`the wiring on ${h.adapter.name}: a tool gate's blocks on failure, a nudge's continues`, () => {
    const gate = consumer(h, "gate.hook.mjs", BASH_GATE);
    const nudge = consumer(h, "heartbeat.hook.mjs", INJECT);
    try {
      const [g] = handlers(h, gate, "PreToolUse");
      const [n] = handlers(h, nudge, "UserPromptSubmit");
      if (usesHandlerField(h)) {
        expect(g.onFailure).toBe("block");
        expect(n.onFailure).toBe("continue");
        // No ending: the runtime's own 1 must reach the harness, not a 2.
        expect(g.command).not.toMatch(/\|\|\s*exit/);
        expect(n.command).not.toMatch(/\|\|\s*exit/);
      } else {
        // The documented gap: no failure key on this harness, so the policy
        // stays on the shell ending, unchanged.
        expect(g.onFailure).toBeUndefined();
        expect(g.command).toMatch(/\|\| exit 2$/);
        expect(n.command).toMatch(/\|\| exit 0$/);
      }
    } finally {
      cleanupTmpDir(gate);
      cleanupTmpDir(nudge);
    }
  });

  test(`the wiring on ${h.adapter.name}: the WIRED gate still denies (2), and edited after compile it is a failure under its policy`, () => {
    const dir = consumer(h, "gate.hook.mjs", BASH_GATE);
    try {
      const [g] = handlers(h, dir, "PreToolUse");
      const fireWired = () =>
        runHook(
          g.command,
          { cwd: dir, ...ROLE_FIXTURES["bash-gate"].payload },
          { cwd: dir, protocol: h.protocol },
        );
      const deny = fireWired();
      expect(deny.exitCode).toBe(2);
      expect(deny.stderr).toContain("DANGEROUS-RM");
      writeFileSync(
        join(dir, ".vigiles", "hooks", "gate.hook.mjs"),
        `${asConsumer(BASH_GATE)}\n// edited\n`,
      );
      const stale = fireWired();
      expect(stale.stderr).not.toContain("DANGEROUS-RM");
      // Claude Code: 1, and `onFailure: block` refuses the call. Codex: the
      // `|| exit 2` ending turns the failure into a block, as before.
      expect(stale.exitCode).toBe(usesHandlerField(h) ? 1 : 2);
    } finally {
      cleanupTmpDir(dir);
    }
  });
}
