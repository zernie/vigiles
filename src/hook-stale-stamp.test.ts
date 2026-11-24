/**
 * A STALE STAMP NEVER BLOCKS A PROMPT OR A NON-GATE HOOK — through the real
 * runtime (`vigiles hook-runtime run-program`), on both harnesses.
 *
 * The incident, reproduced exactly: a user edited the source of an `inject` hook
 * wired on `UserPromptSubmit` and did not recompile. The runtime found the stamp
 * stale and exited 2 on EVERY prompt, so the human was locked out of their own
 * session — no prompt is a repair action. The contract now: one loud stderr
 * warning naming the file and `vigiles compile <file>`, the hook body NOT run,
 * exit 0. A tool gate on a tool call still refuses, so its tamper protection is
 * unchanged where the agent can repair it in the same loop.
 *
 * Both harnesses (`test-both-harnesses`): Claude Code reads the event's recorded
 * capability; Codex records none, so the runtime falls back to whether the
 * payload carries a tool call — both must land on the same answers.
 */
import { describe, test, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runHook } from "./run-hook.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import { ADAPTERS, detectAdapter } from "./adapter-registry.js";
import { capabilityOf } from "./core/event-capability.js";
import { staleStampResponse } from "./core/hook-stamp.js";
import type { DispatchKind } from "./core/hook-program.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
const HOOK_DIST = pathToFileURL(resolve(REPO_ROOT, "dist", "hook.js")).href;

const INJECT = `import { experimental_defineInject, inject } from "${HOOK_DIST}";
export default experimental_defineInject({
  on: "UserPromptSubmit",
  produce: () => inject("THE-HOOK-BODY-RAN"),
});`;

const PROMPT_GATE = `import { experimental_definePromptGate, deny } from "${HOOK_DIST}";
export default experimental_definePromptGate({
  on: "UserPromptSubmit",
  decide: () => deny("THE-HOOK-BODY-RAN"),
});`;

const BASH_GATE = `import { experimental_defineHook, allow } from "${HOOK_DIST}";
export default experimental_defineHook({ on: "PreToolUse", decide: () => allow() });`;

const ROLES: readonly DispatchKind[] = [
  "bash-gate",
  "file-gate",
  "prompt-gate",
  "stop-gate",
  "inject",
  "react",
];

/** Every registered harness that runs shell hooks — the runtime is theirs. */
const HARNESSES = ADAPTERS.flatMap((a) =>
  a.shellHooks ? [{ adapter: a, protocol: a.hookProtocol }] : [],
);

/** Make `dir` read as this harness's project: its own settings file, empty. */
function plantHarness(dir: string, h: (typeof HARNESSES)[number]): void {
  const { layout } = h.adapter;
  const settings = join(dir, layout.settingsPath);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, layout.settings.render({}));
}

/**
 * Every (role, event) pair of this harness's own event list where the policy
 * would refuse though it must not: a non-tool-gate role, or an event that
 * carries no tool call (by its recorded capability; by its payload otherwise).
 * Plus the one refusal it must keep: a tool gate on `PreToolUse`.
 */
function policyViolations(
  adapter: (typeof HARNESSES)[number]["adapter"],
): string[] {
  const table = adapter.dialect.eventCapabilities;
  const refusesWrongly = adapter.dialect.hookEvents.flatMap((event) => {
    const capability = capabilityOf(table, event);
    const toolCall =
      capability.kind === "known"
        ? capability.capability.carries === "tool"
        : event.includes("ToolUse");
    return ROLES.filter(
      (role) =>
        staleStampResponse(role, { capability, carriesToolCall: toolCall })
          .kind === "refuse" &&
        (!toolCall || (role !== "bash-gate" && role !== "file-gate")),
    ).map((role) => `${role} refuses on ${event}`);
  });
  const gate = staleStampResponse("bash-gate", {
    capability: capabilityOf(table, "PreToolUse"),
    carriesToolCall: true,
  });
  return gate.kind === "refuse"
    ? refusesWrongly
    : [...refusesWrongly, "bash-gate does not refuse on PreToolUse"];
}

/** A compiled hook whose source was edited after compile: the sidecar no longer matches. */
function plantStaleHook(dir: string, name: string, source: string): string {
  const file = join(dir, "hooks", name);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(file, source);
  mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
  writeFileSync(
    join(dir, ".vigiles", "hooks", `${name}.json`),
    JSON.stringify({ file, stamp: "0000000000000000" }) + "\n",
  );
  return file;
}

function fire(
  h: (typeof HARNESSES)[number],
  dir: string,
  file: string,
  payload: Record<string, unknown>,
) {
  // No project variable: every harness puts the session's `cwd` in the payload,
  // and that is the root the runtime resolves.
  return runHook(
    `node ${CLI} hook-runtime run-program ${file}`,
    { cwd: dir, ...payload },
    { cwd: dir, protocol: h.protocol },
  );
}

test("covers more than one harness", () => {
  expect(HARNESSES.length).toBeGreaterThan(1);
});

for (const h of HARNESSES) {
  test(`${h.adapter.name}: over its own events, a prompt, a session or a stop never refuses`, () => {
    expect(policyViolations(h.adapter)).toEqual([]);
  });

  describe(`a stale stamp on ${h.adapter.name}`, () => {
    test("THE INCIDENT: an inject hook on UserPromptSubmit warns, skips its body, and lets the prompt through", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        expect(detectAdapter(dir).name).toBe(h.adapter.name);
        const file = plantStaleHook(dir, "heartbeat.hook.mjs", INJECT);
        const r = fire(h, dir, file, {
          hook_event_name: "UserPromptSubmit",
          prompt: "hello",
        });
        expect(r.exitCode).toBe(0);
        expect(r.blocked).toBe(false);
        // ONE loud warning, naming the file and the exact fix.
        expect(r.stderr).toMatch(/does not match its compiled stamp/);
        expect(r.stderr).toContain(`vigiles compile ${file}`);
        expect(r.stderr).toMatch(/SKIPPED on UserPromptSubmit/);
        // The unverified body did not run: nothing was injected.
        expect(r.stdout).not.toContain("THE-HOOK-BODY-RAN");
        expect(r.stdout.trim()).toBe("");
      } finally {
        cleanupTmpDir(dir);
      }
    });

    test("a prompt-gate is not a tool gate either: no block on a prompt, body not run", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        expect(detectAdapter(dir).name).toBe(h.adapter.name);
        const file = plantStaleHook(dir, "filter.hook.mjs", PROMPT_GATE);
        const r = fire(h, dir, file, {
          hook_event_name: "UserPromptSubmit",
          prompt: "hello",
        });
        expect(r.exitCode).toBe(0);
        expect(r.stderr).not.toContain("THE-HOOK-BODY-RAN");
        expect(r.stderr).toContain(`vigiles compile ${file}`);
      } finally {
        cleanupTmpDir(dir);
      }
    });

    test("a tool gate on a tool call still REFUSES — the agent can repair it in the same loop", () => {
      const dir = makeTmpDir();
      try {
        plantHarness(dir, h);
        expect(detectAdapter(dir).name).toBe(h.adapter.name);
        const file = plantStaleHook(dir, "gate.hook.mjs", BASH_GATE);
        const r = fire(h, dir, file, {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
        });
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toMatch(
          /does not match its compiled stamp \(tampered\)/,
        );
        expect(r.stderr).toMatch(/FILE WRITE, not a command/);
      } finally {
        cleanupTmpDir(dir);
      }
    });
  });
}
