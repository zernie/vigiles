/**
 * `execution: { kind: "container" }` (vigiles#599): deciding a run can be a
 * container run (`planExecution`) and the checks before trial 1
 * (`readyExecution`), against a FAKE `ContainerHost` and a made-up harness —
 * no Docker, and the core names no real harness. The pipeline driving them is
 * in `./eval-container-wiring.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  ContainerRefusalError,
  macAuthRefusal,
  planExecution,
  preflightRefusal,
  readyExecution,
  type ReadyMachine,
} from "./eval-container.js";
import type { ContainerHost, ContainerPreflight } from "./core/container.js";
import type { EvalHost } from "./core/eval-host.js";
import type { ContainerImageDeclaration } from "./core/runtime.js";
import { evalHost } from "./host/workspace-host.io.js";

const VERSION = "2.1.300";

/** A fake container host that records what it was asked and answers `preflight`. */
function fakePort(preflight: ContainerPreflight = { kind: "ready" }): {
  readonly port: ContainerHost;
  readonly log: readonly string[];
  readonly asked: readonly Parameters<ContainerHost["preflight"]>[0][];
} {
  const log: string[] = [];
  const asked: Parameters<ContainerHost["preflight"]>[0][] = [];
  return {
    log,
    asked,
    port: {
      preflight: (args) => {
        log.push("preflight");
        asked.push(args);
        return Promise.resolve(preflight);
      },
      run: () => {
        log.push("run");
        return Promise.reject(new Error("planning never runs an attempt"));
      },
    },
  };
}

const hostWith = (port: ContainerHost): EvalHost => ({
  ...evalHost,
  engineFingerprint: () => ({ kind: "found", hash: "e1" }),
  container: port,
});

const IMAGE: ContainerImageDeclaration = {
  recipe: (raw) =>
    raw.startsWith(VERSION)
      ? {
          base: "node:24-slim",
          npmPackages: [`acme-agent@${VERSION}`],
          binary: "acme",
        }
      : undefined,
  egressProbe: (env) => env.ACME_BASE_URL ?? "https://api.acme.test",
  authEnv: ["ACME_TOKEN", "ACME_KEY"],
  authCure: "acme login --token",
};

/** A made-up harness runtime: the core names no real harness. */
const runtime = (
  containerImage?: ContainerImageDeclaration,
): Parameters<typeof planExecution>[1] => ({
  name: "acme",
  agentBinary: "acme",
  containerImage,
});

const CONTAINER = { kind: "container", options: {} } as const;

test("a harness whose adapter declares no image refuses a container run at plan time", () => {
  // Guards: a harness without an image (Codex today) fails loudly, by the
  // absence of its declaration, never by a harness name in the core.
  assert.throws(
    () => planExecution(CONTAINER, runtime(), hostWith(fakePort().port)),
    (err: unknown) =>
      err instanceof ContainerRefusalError &&
      err.message.includes("not supported for the acme harness"),
  );
});

test("a container run without the container adapter is refused, naming the door that wires it", () => {
  for (const host of [
    undefined,
    { ...hostWith(fakePort().port), container: undefined },
  ]) {
    // Guards: a run given no adapter refuses instead of running on the host.
    assert.throws(
      () => planExecution(CONTAINER, runtime(IMAGE), host),
      (err: unknown) =>
        err instanceof ContainerRefusalError &&
        err.message.includes("needs the container adapter"),
    );
  }
});

test("the host plan stays the host plan", () => {
  // Guards: the default needs no image, no adapter and no host.
  assert.deepEqual(planExecution({ kind: "host" }, runtime(), undefined), {
    kind: "host",
  });
});

const machine = (
  over: Partial<ReadyMachine> = {},
): ReadyMachine & {
  disposed: () => boolean;
} => {
  let disposed = false;
  return {
    rawVersion: () => `${VERSION}\n`,
    platform: "linux",
    env: {},
    probeMounts: () => ({
      mounts: [{ path: "/tmp/p", mode: "rw" }],
      dispose: () => {
        disposed = true;
      },
    }),
    disposed: () => disposed,
    ...over,
  };
};

const planned = (port: ContainerHost) =>
  planExecution(CONTAINER, runtime(IMAGE), hostWith(port));

test("readiness: an unreadable binary version refuses before Docker is asked", async () => {
  const fake = fakePort();
  // Guards: the image installs the host's version, so none means no image.
  await assert.rejects(
    readyExecution(
      planned(fake.port),
      machine({ rawVersion: () => "unknown" }),
    ),
    (err: unknown) =>
      err instanceof ContainerRefusalError &&
      err.message.includes("acme --version"),
  );
  // Guards: the container host was not asked anything.
  assert.deepEqual(fake.log, []);
});

test("readiness: on macOS without a token variable the run names the adapter's cure", async () => {
  const fake = fakePort();
  // Guards: the Keychain login is unreachable in a Linux container; the cure
  // and variable names come from the adapter's declaration.
  await assert.rejects(
    readyExecution(planned(fake.port), machine({ platform: "darwin" })),
    (err: unknown) =>
      err instanceof ContainerRefusalError &&
      err.message.includes("ACME_TOKEN or ACME_KEY") &&
      err.message.includes("acme login --token"),
  );
  // Guards: a set token variable lets the run proceed.
  const ready = await readyExecution(
    planned(fake.port),
    machine({ platform: "darwin", env: { ACME_KEY: "k" } }),
  );
  assert.equal(ready.kind, "container");
});

test("readiness: the preflight probes the URL the harness names for this env", async () => {
  const fake = fakePort();
  await readyExecution(
    planned(fake.port),
    machine({ env: { ACME_BASE_URL: "https://gw.example.test" } }),
  );
  // Guards: the URL follows the env the run gets, so a gateway user is asked about the gateway, not a fixed host.
  assert.equal(fake.asked[0]?.egressProbe, "https://gw.example.test");
});

test("readiness: the probe dirs are removed whatever the preflight answers", async () => {
  const m = machine();
  await assert.rejects(
    readyExecution(planned(fakePort({ kind: "ryuk-disabled" }).port), m),
  );
  // Guards: a refused preflight leaves no probe directory behind.
  assert.equal(m.disposed(), true);
});

test("macAuthRefusal is silent off macOS", () => {
  // Guards: a Linux host reads its auth file, no token variable needed.
  assert.equal(macAuthRefusal("linux", {}, IMAGE), undefined);
  // Guards: an empty variable is not a token.
  assert.notEqual(
    macAuthRefusal("darwin", { ACME_TOKEN: "" }, IMAGE),
    undefined,
  );
});

test("every preflight answer but ready stops the run with its own cure", () => {
  const cures: readonly [ContainerPreflight, string][] = [
    [
      { kind: "no-docker", detail: "x" },
      "Start Docker Desktop (macOS) or the docker service (Linux)",
    ],
    [{ kind: "no-testcontainers" }, "npm i -D testcontainers"],
    [{ kind: "testcontainers-failed", detail: "x" }, "Reinstall it"],
    [
      { kind: "node-too-old", have: "20.19.5", need: "22.22" },
      "Node 22.22 or newer",
    ],
    [{ kind: "ryuk-disabled" }, "TESTCONTAINERS_RYUK_DISABLED"],
    [{ kind: "mount-failed", path: "/p", detail: "x" }, "File sharing"],
    [
      { kind: "no-egress", url: "https://x.example", detail: "E" },
      "NODE_EXTRA_CA_CERTS",
    ],
    [{ kind: "image-failed", detail: "x" }, "Check the image name"],
  ];
  for (const [answer, cure] of cures) {
    const line = preflightRefusal(answer) ?? "";
    // Guards: each answer names the cure for ITS cause.
    assert.ok(line.includes(cure), `${answer.kind}: ${line}`);
    // Guards: one line, so the CLI prints it as one refusal.
    assert.ok(!line.includes("\n"), answer.kind);
  }
  // Guards: ready lets the run go on.
  assert.equal(preflightRefusal({ kind: "ready" }), undefined);
});

test("no-egress names the URL, the error and both cures on one line", () => {
  const line =
    preflightRefusal({
      kind: "no-egress",
      url: "https://api.example.test",
      detail: "SELF_SIGNED_CERT_IN_CHAIN\n",
    }) ?? "";
  // Guards: the user sees which URL a container could not reach.
  assert.ok(line.includes("https://api.example.test"), line);
  // Guards: and the error code the request failed with, so a TLS failure reads as one.
  assert.ok(line.includes("SELF_SIGNED_CERT_IN_CHAIN"), line);
  // Guards: the cure for a proxy that decrypts HTTPS is its CA in NODE_EXTRA_CA_CERTS.
  assert.ok(line.includes("NODE_EXTRA_CA_CERTS"), line);
  // Guards: an offline network mode is named as a cause too.
  assert.ok(line.includes('networkMode: "none"'), line);
  // Guards: one line even when the detail carried a newline.
  assert.ok(!line.includes("\n"), line);
});
