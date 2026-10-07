/**
 * The environment a child agent run inherits, decided by the harness's declared
 * `RunEnvPolicy` and nothing else. The harness here is MADE UP on purpose: the
 * point is that any adapter can declare its own auth names and its own session
 * identity, and the core applies them without knowing a single harness.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { scrubbedRunEnv, withoutSessionIdentity } from "./run-env.js";
import type { RunEnvPolicy } from "./runtime.js";

/** A harness that authenticates with ACME_TOKEN and marks its session with two vars. */
const acme: RunEnvPolicy = {
  keep: ["ACME_TOKEN", "ACME_REGION"],
  keepHomeFiles: [".acme/token"],
  sessionIdentity: ["ACME_SESSION_ID", "ACME_PARENT_SOCKET"],
};

/** What the parent process looks like while an ACME session is running. */
const parent = {
  HOME: "/home/real",
  TMPDIR: "/var/real-tmp",
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm",
  ACME_TOKEN: "secret-auth",
  ACME_REGION: "eu",
  ACME_CONFIG_DIR: "/home/real/.acme",
  ACME_SESSION_ID: "parent-session",
  ACME_PARENT_SOCKET: "/tmp/parent.sock",
  GH_TOKEN: "ghp_x",
  UNSET: undefined,
};

test("scrubbedRunEnv: a fresh HOME/TMPDIR, the OS essentials, and only the auth the harness declared", () => {
  const env = scrubbedRunEnv(parent, { home: "/tmp/h", policy: acme });
  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm",
    ACME_TOKEN: "secret-auth",
    ACME_REGION: "eu",
    HOME: "/tmp/h",
    TMPDIR: "/tmp/h",
  });
});

test("scrubbedRunEnv: the parent's session identity never passes, even when the caller allows it by name", () => {
  const env = scrubbedRunEnv(parent, {
    home: "/tmp/h",
    policy: acme,
    allow: ["ACME_SESSION_ID", "VIGILES_X"],
  });
  assert.equal(env.ACME_SESSION_ID, undefined);
  assert.equal(env.ACME_PARENT_SOCKET, undefined);
});

test("scrubbedRunEnv: the caller's extra names pass (the eval's own VIGILES_* overlay)", () => {
  const env = scrubbedRunEnv(
    { ...parent, VIGILES_X: "1" },
    { home: "/tmp/h", policy: acme, allow: ["VIGILES_X"] },
  );
  assert.equal(env.VIGILES_X, "1");
});

test("scrubbedRunEnv: a config-dir var the harness did not declare is dropped — it would point the child back at the real config", () => {
  const env = scrubbedRunEnv(parent, { home: "/tmp/h", policy: acme });
  assert.equal(env.ACME_CONFIG_DIR, undefined);
});

test("scrubbedRunEnv without a policy: only the OS essentials (a mock run needs no auth)", () => {
  const env = scrubbedRunEnv(parent, { home: "/tmp/h" });
  assert.deepEqual(Object.keys(env).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TERM",
    "TMPDIR",
  ]);
});

test("withoutSessionIdentity: drops exactly the declared identity, keeps the rest of the inherited env", () => {
  const env = withoutSessionIdentity(parent, acme);
  assert.equal(env.ACME_SESSION_ID, undefined);
  assert.equal(env.ACME_PARENT_SOCKET, undefined);
  assert.equal("ACME_SESSION_ID" in env, false);
  // Everything else is the inherited env, unchanged — this is the overlay path.
  assert.equal(env.HOME, "/home/real");
  assert.equal(env.GH_TOKEN, "ghp_x");
  assert.equal(env.ACME_TOKEN, "secret-auth");
  assert.equal("UNSET" in env, false);
});

test("withoutSessionIdentity without a policy: the inherited env, minus unset values", () => {
  const env = withoutSessionIdentity(parent);
  assert.equal(env.ACME_SESSION_ID, "parent-session");
  assert.equal("UNSET" in env, false);
});
