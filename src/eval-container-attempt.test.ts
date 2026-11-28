/**
 * The pure pieces of one container attempt (`./eval-container-attempt.ts`):
 * its mounts, its launcher, the hook exits that refuse it, and how the report
 * names its image. The attempt driven through the pipeline is in
 * `./eval-container-wiring.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  attemptMounts,
  containmentOf,
  executionCacheView,
  executionLockView,
  hookCouldNotRun,
  interceptCommand,
  launcherFor,
} from "./eval-container-attempt.js";
import type { ContainerPlan } from "./eval-container.js";

/** A container plan whose port is never called by the pieces under test. */
const plan: ContainerPlan = {
  kind: "container",
  options: {},
  image: {
    recipe: () => undefined,
    egressProbe: () => undefined,
    authEnv: [],
    authCure: "login",
  },
  binary: "acme",
  port: {
    preflight: () => Promise.reject(new Error("not asked")),
    run: () => Promise.reject(new Error("not asked")),
  },
  engine: { kind: "found", hash: "e1" },
};

test("attemptMounts: the agent writes its dirs and reads the plugin and the base", () => {
  const mounts = attemptMounts({
    cwd: "/w",
    home: "/h",
    baseDir: "/b",
    stubRoot: "/s",
    captureDirs: ["/c"],
    pluginDir: "/pd",
    pluginRoot: "/pr",
  });
  // Guards: a plugin and the workspace base are read-only to the agent.
  assert.deepEqual(Object.fromEntries(mounts.map((m) => [m.path, m.mode])), {
    "/w": "rw",
    "/h": "rw",
    "/b": "ro",
    "/s": "rw",
    "/c": "rw",
    "/pd": "ro",
    "/pr": "ro",
  });
});

test("the host keeps its launcher and intercept command; a container uses the image's", () => {
  const host = { node: "/usr/bin/node", cli: "/pkg/dist/cli.js" };
  // Guards: the host path is the launcher it was given, unchanged.
  assert.equal(launcherFor({ kind: "host" }, host), host);
  // Guards: the host intercept command keeps its exact shape.
  assert.equal(
    interceptCommand(host),
    '"/usr/bin/node" "/pkg/dist/cli.js" hook-runtime intercept-tool',
  );
});

test("hookCouldNotRun: only a missing or non-executable command refuses", () => {
  const fire = (exitCode: number | undefined) => ({
    name: "h",
    event: "PreToolUse",
    exitCode,
    blocked: exitCode !== 0,
    output: "",
  });
  // Guards: 126 and 127 mean the command is not in the image.
  assert.ok(hookCouldNotRun([fire(126)])?.includes("exit 126"));
  assert.ok(hookCouldNotRun([fire(127)])?.includes("exit 127"));
  // Guards: a hook that ran and blocked (2) or passed is the harness measured.
  assert.equal(hookCouldNotRun([fire(0), fire(2), fire(undefined)]), undefined);
});

test("containmentOf: a named image is reported as named", () => {
  const named = containmentOf({
    kind: "container",
    plan: { ...plan, options: { image: "acme/agent:1" } },
    recipe: { base: "b", npmPackages: [], binary: "acme" },
  });
  // Guards: the report says the image that ran, not the recipe it bypassed.
  assert.deepEqual(named, { kind: "container", image: "acme/agent:1" });
});

test("a lock ignores which vigiles the built image carries; the cache does not", () => {
  const rebuilt: ContainerPlan = {
    ...plan,
    engine: { kind: "found", hash: "e2" },
  };
  const recipe = { base: "b", npmPackages: [], binary: "acme" };
  // Guards: a vigiles upgrade (a new engine hash) leaves a committed container
  // lock fresh, so CI's lock check does not go red on every engine change.
  assert.deepEqual(executionLockView(rebuilt), executionLockView(plan));
  // Guards: the local cache never replays an attempt recorded under another build.
  assert.notDeepEqual(
    executionCacheView({ kind: "container", plan: rebuilt, recipe }),
    executionCacheView({ kind: "container", plan, recipe }),
  );
});

test("a lock tells a named image from a built one", () => {
  const named: ContainerPlan = { ...plan, options: { image: "acme/agent:1" } };
  // Guards: swapping the built image for a named one makes the lock stale.
  assert.notDeepEqual(executionLockView(named), executionLockView(plan));
});
