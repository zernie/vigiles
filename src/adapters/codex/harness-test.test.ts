/**
 * Codex pillar-2 harness-test validation — proves the adapter-driven
 * `runHarnessTest` drives REAL `codex exec` (not just Claude Code) through the
 * public API. The runner picks codex's `HarnessTestDriver` off `codexAdapter`
 * (no sibling-adapter import), points real codex at the proven OpenAI-Responses
 * mock via the keyless `wireMock` flag recipe, and the scripted reply lands in
 * `r.output`.
 *
 * Pure unit coverage of the driver's arg/parse seams runs always; the real-codex
 * turn runs when `codex` is on PATH (installed in CI), skips otherwise.
 */
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";

import { runHarnessTest } from "../../harness-test.js";
import { codexAdapter } from "./adapter.js";
import { buildCodexArgs, parseCodexRun } from "./driver.js";

test("buildCodexArgs: exec flags, mock flags after exec, prompt last", () => {
  const args = buildCodexArgs({
    prompt: "do it",
    cwd: "/tmp/x",
    hasSettings: false,
    tools: [],
    transcript: false,
    mockArgs: ["-c", "model_provider=mock"],
  });
  expect(args[0]).toBe("exec");
  // The mock-wiring flags MUST come AFTER exec (else codex ignores them).
  const execIdx = args.indexOf("exec");
  const mockIdx = args.indexOf("model_provider=mock");
  expect(mockIdx).toBeGreaterThan(execIdx);
  // The prompt is the trailing positional.
  expect(args[args.length - 1]).toBe("do it");
  expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
});

test("buildCodexArgs: tools and allowedTools do not change the argv (Codex has no equivalent)", () => {
  const ctx = {
    prompt: "do it",
    cwd: "/tmp/x",
    hasSettings: false,
    transcript: false,
    mockArgs: ["-c", "model_provider=mock"],
  };
  expect(
    buildCodexArgs({ ...ctx, tools: ["Read"], allowedTools: ["Bash"] }),
  ).toEqual(buildCodexArgs(ctx));
});

test("parseCodexRun: returns trimmed stdout as the output, empty tools/hooks", () => {
  const r = parseCodexRun("  HELLO_CODEX\n");
  expect(r.output).toBe("HELLO_CODEX");
  expect(r.toolCalls).toEqual([]);
  expect(r.hooks).toEqual([]);
});

const codexAvailable = (): boolean => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const maybe = codexAvailable() ? test : test.skip;

maybe(
  "runHarnessTest drives real codex via codexAdapter",
  async () => {
    const r = await runHarnessTest(
      {
        prompt: "say exactly HELLO_CODEX and nothing else",
        model: [{ text: "HELLO_CODEX" }],
        // Codex has no confined path; an inline-only spec is trusted so the
        // default "auto" runs direct — pass false to be explicit.
        sandbox: false,
        timeoutMs: 60_000,
      },
      { adapter: codexAdapter },
    );
    try {
      // The scripted reply reached the agent's output...
      expect(r.output).toContain("HELLO_CODEX");
      expect(r.stdout).toContain("HELLO_CODEX");
      expect(r.exitCode).toBe(0);
      // ...and the mock recorded the request (the prompt reached the model).
      expect(r.modelRequests.length).toBeGreaterThanOrEqual(1);
      const sent = r.modelRequests
        .flatMap((req) => req.messages.map((m) => m.text))
        .join("\n");
      expect(sent).toContain("HELLO_CODEX");
    } finally {
      r.cleanup();
    }
  },
  90_000,
);
