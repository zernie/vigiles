/**
 * What a child `claude` run inherits from a caller that is itself a live Claude
 * Code session — the eval tier's spawn env (`ephemeralRunEnv`, `resolveSpawnEnv`)
 * under Claude Code's declared `runEnv`.
 *
 * Measured on Claude Code 2.1.292 (2026-10-07): a child `claude -p` started with
 * the parent's session variables ran AS the parent session (a task it created
 * landed in the parent's live task list), and auth still worked with those
 * variables removed. Before this file, the ephemeral env passed every `CLAUDE_*`
 * variable through by prefix, and the default path passed the whole env.
 */
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";

import { ephemeralRunEnv, resolveSpawnEnv } from "../../eval.js";
import { claudeCodeRuntime } from "./runtime.js";

/** Observed in a live Claude Code session's env on 2026-10-07 (values made up). */
const PARENT_IDENTITY = {
  CLAUDE_CODE_SESSION_ID: "parent-session",
  CLAUDE_CODE_REMOTE_SESSION_ID: "parent-remote",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-socket-token",
  CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/run/parent/ingress-token",
};

const AUTH = {
  ANTHROPIC_API_KEY: "sk-real",
  ANTHROPIC_BASE_URL: "https://proxy.example",
  ANTHROPIC_AUTH_TOKEN: "auth-token",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_REGION: "us-east-1",
};

const parentEnv = {
  HOME: "/home/real",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GH_TOKEN: "ghp_secret",
  CLAUDE_CONFIG_DIR: "/home/real/.claude",
  ...AUTH,
  ...PARENT_IDENTITY,
};

const identityNames = Object.keys(PARENT_IDENTITY);

test("ephemeral env: the child gets none of the parent session's identity", () => {
  const env = ephemeralRunEnv(parentEnv, { home: "/tmp/h" });
  for (const k of identityNames) assert.equal(env[k], undefined, k);
});

test("ephemeral env: the auth Claude Code needs still reaches the child", () => {
  const env = ephemeralRunEnv(parentEnv, { home: "/tmp/h" });
  for (const [k, v] of Object.entries(AUTH)) assert.equal(env[k], v, k);
});

test("ephemeral env: CLAUDE_CONFIG_DIR is dropped — it would point the child back at the real config", () => {
  const env = ephemeralRunEnv(parentEnv, { home: "/tmp/h" });
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.HOME, "/tmp/h");
});

test("ephemeral env: an eval-injected name cannot smuggle identity back in", () => {
  const env = ephemeralRunEnv(parentEnv, {
    home: "/tmp/h",
    allow: ["CLAUDE_CODE_SESSION_ID"],
  });
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
});

test("default (inherited) spawn env: the parent's identity is removed, the rest is inherited", () => {
  const env = resolveSpawnEnv({ env: { X: "1" } }, parentEnv);
  for (const k of identityNames) assert.equal(env[k], undefined, k);
  assert.equal(env.X, "1");
  assert.equal(env.HOME, "/home/real"); // not scrubbed: the inherited env
  assert.equal(env.GH_TOKEN, "ghp_secret");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
});

test("a REAL child process started with the default spawn env sees no parent identity", () => {
  const env = resolveSpawnEnv({}, { ...process.env, ...PARENT_IDENTITY });
  const r = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
    { env, encoding: "utf-8" },
  );
  const seen = z.array(z.string()).parse(JSON.parse(r.stdout));
  for (const k of identityNames) assert.equal(seen.includes(k), false, k);
});

test("Claude Code declares its identity and its auth in one place, disjoint", () => {
  const policy = claudeCodeRuntime.runEnv;
  assert.ok(policy, "claudeCodeRuntime declares a runEnv");
  for (const k of identityNames) assert.ok(policy.sessionIdentity.includes(k));
  const both = policy.keep.filter((k) => policy.sessionIdentity.includes(k));
  assert.deepEqual(both, []);
  // The auth file the throwaway HOME is seeded with — and nothing else.
  assert.deepEqual(policy.keepHomeFiles, [".claude/.credentials.json"]);
});
