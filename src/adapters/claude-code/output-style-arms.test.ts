/**
 * `experimental_outputStyleArms` against the REAL `claude` binary and the scripted mock
 * model: the arms a paid style eval compares, built from the style FILE, with
 * delivery proven by one free run first. Skipped where the CLI is absent.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { claudeAvailable, claudeCodeDriver } from "../../harness-test.js";
import {
  experimental_outputStyleArms,
  outputStyleArmsWith,
} from "../../output-style-arms.js";
import { claudeCodeAdapter } from "./adapter.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeOutputStyles as rules } from "./output-style.js";
import { claudeCodeRuntime } from "./runtime.js";

const STYLE = resolve("test/fixtures/output-styles/status-footer.md");
const maybe = claudeAvailable() ? test : test.skip;

describe("experimental_outputStyleArms on Claude Code (real binary, scripted model)", () => {
  maybe(
    "builds a with arm selected by the name in the file, and a without arm on the default style",
    async () => {
      const arms = await experimental_outputStyleArms(STYLE);
      expect(arms).toEqual({
        with: {
          files: {
            ".claude/output-styles/status-footer.md": readFileSync(
              STYLE,
              "utf-8",
            ),
          },
          settings: { outputStyle: "Status Footer" },
        },
        // Not `{}`: a bare arm would load a style the user set for every project.
        without: { settings: { outputStyle: "default" } },
      });
    },
    180_000,
  );

  maybe(
    "throws before any paid trial when the style does not reach the model",
    async () => {
      const blind = {
        ...claudeCodeAdapter,
        layout: {
          ...claudeCodeLayout,
          outputStyles: { ...rules, reached: () => false },
        },
      };
      await expect(outputStyleArmsWith(STYLE, blind)).rejects.toThrow(
        /"Status Footer" never reached the model/,
      );
    },
    180_000,
  );
});

describe("experimental_outputStyleArms refuses before running", () => {
  test("when the file does not exist", async () => {
    await expect(
      experimental_outputStyleArms("nope/missing.md"),
    ).rejects.toThrow(/outputStyle: no such file: nope\/missing\.md/);
  });
});

describe("the free preflight runs in a throwaway HOME, never as the caller's session", () => {
  test("the agent it spawns gets a fresh HOME, no parent session identity, no caller secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vigiles-preflight-env-"));
    const record = join(dir, "env.json");
    // A stand-in for the agent binary: records the env it was started with,
    // sends the mock one request (so delivery can be judged), prints a result.
    const fake = join(dir, "fake-agent.mjs");
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));`,
        'await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {',
        '  method: "POST", headers: { "content-type": "application/json" },',
        '  body: JSON.stringify({ model: "m", max_tokens: 1, system: "s", tools: [{ name: "Bash" }], messages: [{ role: "user", content: "hi" }] }),',
        "}).then((r) => r.text());",
        'console.log(JSON.stringify({ type: "result", result: "ok" }));',
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const adapter = {
      ...claudeCodeAdapter,
      layout: {
        ...claudeCodeLayout,
        outputStyles: { ...rules, reached: () => true },
      },
      harnessTestDriver: () =>
        Promise.resolve({
          ...claudeCodeDriver,
          runtime: { ...claudeCodeRuntime, agentBinary: fake },
        }),
    };
    const parent = {
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
      CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/run/parent/token",
      GH_TOKEN: "ghp_caller_secret",
    };
    const saved = Object.fromEntries(
      Object.keys(parent).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, parent);
    try {
      await outputStyleArmsWith(STYLE, adapter);
      const env = z
        .record(z.string(), z.string())
        .parse(JSON.parse(readFileSync(record, "utf-8")));
      for (const k of Object.keys(parent)) expect(env[k], k).toBeUndefined();
      expect(env.HOME).toBeDefined();
      expect(env.HOME).not.toBe(process.env.HOME ?? homedir());
      expect(env.TMPDIR).toBe(env.HOME);
      expect(env.ANTHROPIC_API_KEY).toBe(claudeCodeRuntime.mockApiKey);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
