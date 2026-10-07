/**
 * codexDriver — the Codex `HarnessTestDriver`. Lets the adapter-driven
 * `runHarnessTest` drive real `codex exec` against the proven OpenAI-Responses
 * mock (`startCodexMock`), keylessly, via the `wireMock` flag recipe in
 * `runtime.ts`. The Codex-side analogue of `claudeCodeDriver`.
 *
 * Scope: pillar-2 deterministic harness testing of the *output* turn — codex's
 * non-interactive `exec` runs the scripted mock to completion and the final
 * assistant text lands in `parseRun().output`. Tool-call / hook stream parsing
 * is left empty (the JSONL schema isn't worth fully parsing for the output
 * check); a test that needs those uses Claude Code today.
 */
import { spawnSync } from "node:child_process";

import type {
  HarnessTestDriver,
  HarnessDriverContext,
  HarnessMockHandle,
  ModelTurn,
  ParsedRun,
} from "../../core/harness-driver.js";
import { codexRuntime } from "./runtime.js";
import { startCodexMock } from "./mock-model.js";

/**
 * The non-interactive `codex exec` argv. The mock-wiring `-c` flags
 * (`ctx.mockArgs`, from `runtime.wireMock`) MUST follow `exec` — placed before
 * `exec` they're parsed as global flags and ignored (codex falls back to the
 * real OpenAI provider). `--ephemeral` +
 * `--dangerously-bypass-approvals-and-sandbox` make it run unattended;
 * `--skip-git-repo-check` lets it run in a bare temp dir; `--ignore-user-config`
 * keeps the host's `~/.codex` out. The prompt is the trailing positional.
 * Pure, so the arg shape is unit-tested.
 */
export function buildCodexArgs(ctx: HarnessDriverContext): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    ...ctx.mockArgs,
    "-c",
    'model="gpt-5-codex"',
    ctx.prompt,
  ];
}

/**
 * Extract the final assistant text from codex stdout. Codex `exec` prints the
 * assistant message as plain text (no `--json` here); we return the trimmed
 * stdout as the output. Pure, so it's unit-tested without spawning codex.
 */
export function parseCodexRun(stdout: string): ParsedRun {
  return { toolCalls: [], hooks: [], output: stdout.trim() };
}

/* v8 ignore start -- spawns the real codex CLI; exercised by the gated
   codex-backed suite, the pure helpers above carry the testable logic. */
function codexAvailable(): boolean {
  try {
    return (
      // vigiles:free-tier — availability probe; `--version` prints and exits.
      spawnSync(codexRuntime.agentBinary, ["--version"], {
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
}

async function startCodexMockHandle(
  script: readonly ModelTurn[],
): Promise<HarnessMockHandle> {
  const mock = await startCodexMock(
    script.map((t) => ({ text: t.text ?? "" })),
  );
  return {
    url: mock.url,
    get requests() {
      // Codex requests carry only the flattened prompt; adapt to ModelRequest.
      return mock.requests.map((r) => ({
        system: "",
        messages: [{ role: "user", text: r.prompt }],
      }));
    },
    get count() {
      // Turns SERVED: a request past the end of the script gets a 400.
      return Math.min(mock.requests.length, script.length);
    },
    close: () => mock.close(),
  };
}

export const codexDriver: HarnessTestDriver = {
  runtime: codexRuntime,
  buildArgs: buildCodexArgs,
  startMock: startCodexMockHandle,
  parseRun: parseCodexRun,
  available: codexAvailable,
};
/* v8 ignore stop */
