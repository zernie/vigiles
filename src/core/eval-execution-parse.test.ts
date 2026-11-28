/**
 * The eval spec boundary for `execution`: absent and `host` are the host runner,
 * a container takes only its allowlisted options and an ephemeral env, and
 * every other shape is refused by name before a trial runs.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseExecution } from "./eval-execution-parse.js";
const EPHEMERAL = { kind: "ephemeral" } as const;
const INHERIT = { kind: "inherit", reason: "my plugins" } as const;

test("execution: absent and `host` are the host runner, on any env", () => {
  // Guards: a spec written before `execution` existed runs exactly as before.
  assert.deepEqual(parseExecution(undefined, "runEval", INHERIT), {
    kind: "host",
  });
  // Guards: the explicit default is the same value as the absent one.
  assert.deepEqual(parseExecution({ kind: "host" }, "runEval", INHERIT), {
    kind: "host",
  });
});

test("execution: a container with allowlisted options parses into them", () => {
  const parsed = parseExecution(
    {
      kind: "container",
      networkMode: "none",
      resourcesQuota: { memory: 2, cpu: 1 },
      droppedCapabilities: ["NET_RAW"],
    },
    "runEval",
    EPHEMERAL,
  );
  // Guards: the options reach the container adapter as given, `kind` split off.
  assert.deepEqual(parsed, {
    kind: "container",
    options: {
      networkMode: "none",
      resourcesQuota: { memory: 2, cpu: 1 },
      droppedCapabilities: ["NET_RAW"],
    },
  });
  // Guards: a bare container is valid (vigiles builds the image).
  assert.deepEqual(
    parseExecution({ kind: "container" }, "runEval", EPHEMERAL),
    { kind: "container", options: {} },
  );
});

test("execution: a container on an inherited env is refused, saying why", () => {
  // Guards: an inherited env is the host's, which a container exists to keep out.
  assert.throws(
    () => parseExecution({ kind: "container" }, "runEval", INHERIT),
    /execution: \{ kind: "container" \} needs env: \{ kind: "ephemeral" \}/,
  );
});

test("execution: a field outside the allowlist is refused as breaking containment", () => {
  for (const key of ["privileged", "env", "bindMounts", "reuse", "user"]) {
    // Guards: each setting that would let a process outlive or escape the
    // attempt has no way in, and the message names the field and why.
    assert.throws(
      () =>
        parseExecution(
          { kind: "container", [key]: true },
          "runEval",
          EPHEMERAL,
        ),
      new RegExp(
        `execution\\.${key}: not a container option — it would break the containment`,
      ),
    );
  }
});

test("execution: a wrong value or an unknown kind is refused naming the field", () => {
  // Guards: an option's value is checked, not only its name.
  assert.throws(
    () =>
      parseExecution(
        { kind: "container", pullPolicy: "sometimes" },
        "runEval",
        EPHEMERAL,
      ),
    /runEval: .*execution/s,
  );
  // Guards: a kind that is neither host nor container is not read as host.
  assert.throws(
    () => parseExecution({ kind: "vm" }, "runEval", EPHEMERAL),
    /runEval: .*execution/s,
  );
  // Guards: `host` takes no options, so a stray one is not silently dropped.
  assert.throws(
    () => parseExecution({ kind: "host", image: "x" }, "runEval", EPHEMERAL),
    /runEval: .*execution/s,
  );
});
