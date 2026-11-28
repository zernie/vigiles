/**
 * The container adapter against a real Docker daemon (vigiles#599): what an
 * attempt leaves behind (no process, no container), how it ends (by itself,
 * by the deadline, by a cancel), what it hands back (both streams, a large
 * stdout, the exit code), what it never shows (the env's values), and which
 * preflight kind each planted cause returns.
 *
 * The fake harness binary is `sh` in the public `node:24-slim` image, given
 * as `options.image`, so no test builds the real harness image. Skipped,
 * loudly, when no Docker daemon answers (under CI a missing daemon is a
 * failure, not a skip) or when this Node is older than testcontainers needs
 * (CI's Node 20 test job; the `container` job runs them on Node 22).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CONTAINER_VIGILES_CLI,
  type ContainerOptions,
  type ContainerRunArgs,
  type HarnessImageRecipe,
  type Mount,
} from "../core/container.js";
import type { AgentRunArgs } from "../core/eval-driver.js";
import { makeTmpDir } from "../core/tmp-root.js";
import {
  makeContainerHost,
  RUNNER_LABEL,
  type ContainerHostDeps,
} from "./container.io.js";
import { HOST_CA_IN_IMAGE, hostCaOf } from "./container-image.io.js";
import {
  nodePreflight,
  TESTCONTAINERS_NODE,
} from "./container-preflight.io.js";

const IMAGE = "node:24-slim";
const FAKE_HARNESS_IMAGE = "vigiles-test-fake-harness:1";
const SH: HarnessImageRecipe = { base: IMAGE, npmPackages: [], binary: "sh" };
/** The CA this machine's `NODE_EXTRA_CA_CERTS` names: the fake image trusts it as a built one does. */
const HOST_CA = hostCaOf(process.env);

const dockerAnswers =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status ===
  0;
const inCi = (process.env.CI ?? "") !== "";
const nodeOk = nodePreflight(process.versions.node) === undefined;
const SKIP_REASON = nodeOk
  ? "SKIPPED — no Docker daemon answers `docker info`, so the container tests did not run"
  : `SKIPPED — Node ${process.versions.node} is older than testcontainers needs, so the container tests did not run`;
const runDocker = nodeOk && (dockerAnswers || inCi);
if (!runDocker) {
  process.stderr.write(`⚠ src/host/container.io.test.ts: ${SKIP_REASON}\n`);
  // Loud skip, never a silent pass: the reporter names why nothing ran.
  it.skip(SKIP_REASON, () => {
    expect(runDocker).toBe(true);
  });
}
const withDocker = runDocker ? describe : describe.skip;

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const leftContainers = (): string =>
  docker("ps", "-aq", "--filter", `label=${RUNNER_LABEL}`);

const deps = (over: Partial<ContainerHostDeps> = {}): ContainerHostDeps => ({
  env: {},
  // A supported Node, so each test reaches the cause it plants; the Node check has its own test.
  nodeVersion: `${String(TESTCONTAINERS_NODE.major)}.${String(TESTCONTAINERS_NODE.minor)}.0`,
  importTestcontainers: () => import("testcontainers"),
  packVigiles: () => Promise.reject(new Error("no vigiles tarball in tests")),
  hostCa: () => undefined,
  ...over,
});
const host = makeContainerHost(deps());

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = makeTmpDir("container-test");
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
/** Removes what the planted stop failure leaves on purpose. */
const removeLeftContainers = (): void => {
  const left = leftContainers();
  if (left !== "") docker("rm", "-f", ...left.split("\n"));
};
afterAll(() => {
  if (dockerAnswers) removeLeftContainers();
});

function attempt(
  dir: string,
  script: string,
  over: Partial<AgentRunArgs> & { readonly options?: ContainerOptions } = {},
): ContainerRunArgs {
  const { options = { image: IMAGE }, ...run } = over;
  return {
    run: {
      task: "t",
      cwd: dir,
      model: "m",
      tools: [],
      hasSettings: false,
      pluginDir: undefined,
      timeoutMs: 60_000,
      env: { HOME: dir },
      replaceEnv: true,
      ...run,
    },
    argv: ["-c", script],
    mounts: [{ path: dir, mode: "rw" }],
    recipe: SH,
    options,
  };
}

async function ran(args: ContainerRunArgs) {
  const a = await host.run(args);
  if (a.kind !== "ran")
    throw new Error(`expected ran, got ${a.kind}: ${a.detail}`);
  return a.out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

withDocker("container run: the daemon", () => {
  it("answers under CI (a missing daemon fails here, it is not skipped)", () => {
    // Guards: CI never reports these tests green by skipping them.
    expect(dockerAnswers).toBe(true);
  });
});

withDocker("container run: nothing outlives the attempt", () => {
  it("a setsid orphan stops writing once run resolves", async () => {
    const dir = freshDir();
    const out = await ran(
      attempt(
        dir,
        `setsid sh -c 'while true; do date +%s%N >> "$1/tick"; sleep 0.1; done' tick "$PWD" </dev/null >/dev/null 2>&1 &
sleep 0.5; echo started`,
      ),
    );
    // Guards: the binary itself exited cleanly, so the orphan was really left running by it.
    expect(out).toMatchObject({ code: 0, stdout: "started\n" });
    const first = statSync(join(dir, "tick")).size;
    await sleep(1000);
    // Guards: the orphan wrote before the stop and wrote nothing after it (#626).
    expect(first).toBeGreaterThan(0);
    expect(statSync(join(dir, "tick")).size).toBe(first);
    // Guards: the container itself is gone, not only stopped.
    expect(leftContainers()).toBe("");
  });

  it("the deadline kills the run, marks it timed out, and removes the container", async () => {
    const started = Date.now();
    const out = await ran(
      attempt(freshDir(), "echo before; sleep 600", { timeoutMs: 1500 }),
    );
    // Guards: a killed run is code -1 with the signal named and timedOut set, never a clean 0.
    expect(out).toMatchObject({ code: -1, signal: "SIGKILL", timedOut: true });
    // Guards: what the run printed before the kill is kept.
    expect(out.stdout).toBe("before\n");
    // Guards: the stop is prompt, not the 600 s the binary asked for.
    expect(Date.now() - started).toBeLessThan(20_000);
    // Guards: no container is left by label.
    expect(leftContainers()).toBe("");
  });

  it("a cancel kills the run without marking it timed out", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 1500);
    const args = attempt(freshDir(), "sleep 600", {
      signal: controller.signal,
    });
    const out = await ran(args);
    // Guards: a cancel is never read as a timeout (#416), and still has no exit code.
    expect(out.timedOut).toBeUndefined();
    expect(out).toMatchObject({ code: -1, signal: "SIGKILL" });
    // Guards: the cancelled attempt's container is gone too.
    expect(leftContainers()).toBe("");
  });
});

withDocker("container run: what comes back", () => {
  it("keeps stdout, stderr and a non-zero exit apart", async () => {
    const out = await ran(
      attempt(freshDir(), "printf out; printf err >&2; exit 3"),
    );
    // Guards: the streams are not merged and the binary's own exit code is reported.
    expect(out).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("does not truncate a large stdout", async () => {
    const n = 2_500_000;
    const out = await ran(
      attempt(freshDir(), `head -c ${String(n)} /dev/zero | tr '\\0' a`),
    );
    // Guards: every byte of a ≥ 2 MB stdout arrives, unchanged.
    expect(out.stdout.length).toBe(n);
    expect(out.stdout.replaceAll("a", "")).toBe("");
  });

  it("puts the run's PATH in front of the image's, so a stub wins and the image stays reachable", async () => {
    const dir = freshDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho stub-git\n");
    chmodSync(join(bin, "git"), 0o755);
    const out = await ran({
      ...attempt(dir, "git; command -v node"),
      run: { ...attempt(dir, "").run, env: { HOME: dir, PATH: bin } },
    });
    // Guards: the stub dir shadows the image's git, and the image's own PATH still resolves node.
    expect(out).toMatchObject({
      code: 0,
      stdout: "stub-git\n/usr/local/bin/node\n",
    });
  });

  it("keeps a mounted file executable, at the same path", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\necho tool-ran\n");
    chmodSync(join(dir, "tool.sh"), 0o755);
    const out = await ran(
      attempt(dir, `stat -c %a "${dir}/tool.sh"; "${dir}/tool.sh"`),
    );
    // Guards: the mode survives the bind mount and the file runs from its host path.
    expect(out).toMatchObject({ code: 0, stdout: "755\ntool-ran\n" });
  });

  it("refuses a mount that does not exist instead of letting Docker create it", async () => {
    const missing = join(freshDir(), "missing");
    const args = {
      ...attempt(freshDir(), "true"),
      mounts: [{ path: missing, mode: "rw" as const }],
    };
    // Guards: a missing bind source throws before any container starts.
    await expect(host.run(args)).rejects.toThrow("does not exist");
    expect(leftContainers()).toBe("");
  });
});

const canary = (): string => `sk-canary-${randomUUID().replaceAll("-", "")}`;

withDocker("container run: the env never shows", () => {
  it("is in the exec, not in docker inspect", async () => {
    const key = canary();
    const args = attempt(
      freshDir(),
      'printf %s "${#VIGILES_CANARY_API_KEY}"; sleep 3',
      {
        env: { VIGILES_CANARY_API_KEY: key },
      },
    );
    const running = host.run(args);
    const inspected = await inspectWhileRunning();
    const a = await running;
    // Guards: the exec did get the key (its length came back)…
    expect(a.out.stdout).toBe(String(key.length));
    // Guards: …and the container's inspect output never held it.
    expect(inspected).not.toContain(key);
    expect(inspected).toContain(RUNNER_LABEL);
  });

  it("is redacted from a thrown Docker error", async () => {
    const key = canary();
    const args = attempt(freshDir(), "true", {
      env: { VIGILES_CANARY_API_KEY: key },
      options: { image: `localhost:1/${key}:never` },
    });
    const error = await host.run(args).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Guards: a transport failure throws (never a normal exit) and its message names no env value.
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(key);
    expect(String(error)).toContain("[redacted]");
  });
});

async function inspectWhileRunning(): Promise<string> {
  const deadline = Date.now() + 10_000;
  const poll = async (): Promise<string> => {
    const id = docker("ps", "-q", "--filter", `label=${RUNNER_LABEL}=attempt`);
    if (id !== "") return docker("inspect", id);
    if (Date.now() > deadline) throw new Error("no attempt container appeared");
    await sleep(100);
    return poll();
  };
  return poll();
}

withDocker("container run: a teardown that cannot be confirmed", () => {
  it("is stop-failed, with the env redacted from its detail", async () => {
    const key = canary();
    const real = await import("testcontainers");
    const client = await real.getContainerRuntimeClient();
    const refuse = () => Promise.reject(new Error(`remove refused ${key}`));
    const container = new Proxy(client.container, {
      get: (t, p, r): unknown =>
        p === "remove" ? refuse : Reflect.get(t, p, r),
    });
    const plantedClient = new Proxy(client, {
      get: (t, p, r): unknown =>
        p === "container" ? container : Reflect.get(t, p, r),
    });
    const planted = makeContainerHost(
      deps({
        importTestcontainers: () =>
          Promise.resolve({
            ...real,
            getContainerRuntimeClient: () => Promise.resolve(plantedClient),
          }),
      }),
    );
    const a = await planted.run(
      attempt(freshDir(), "echo hi", { env: { K: key } }),
    );
    // Guards: a container still listed after teardown is never a "ran" attempt.
    expect(a.kind).toBe("stop-failed");
    // Guards: the output is still handed back, and the detail says why without the env value.
    expect(a.out.stdout).toBe("hi\n");
    expect(a.kind === "stop-failed" ? a.detail : "").toContain("[redacted]");
    expect(a.kind === "stop-failed" ? a.detail : key).not.toContain(key);
    removeLeftContainers();
  });
});

const preflightArgs = (
  mounts: readonly Mount[],
  options: ContainerOptions = { image: FAKE_HARNESS_IMAGE },
  probe: {
    readonly recipe?: HarnessImageRecipe;
    readonly egressProbe?: string;
  } = {},
) => ({
  mounts,
  recipe: probe.recipe ?? SH,
  options,
  egressProbe: probe.egressProbe,
});

const noTc = () =>
  Promise.reject(
    Object.assign(new Error("Cannot find package 'testcontainers'"), {
      code: "ERR_MODULE_NOT_FOUND",
    }),
  );

describe("container preflight: causes found without Docker", () => {
  it("returns ryuk-disabled when Ryuk is turned off", async () => {
    const h = makeContainerHost(
      deps({ env: { TESTCONTAINERS_RYUK_DISABLED: "true" } }),
    );
    // Guards: without Ryuk a killed client leaves its containers running, so this stops trial 1.
    expect(await h.preflight(preflightArgs([]))).toEqual({
      kind: "ryuk-disabled",
    });
  });

  it("returns no-testcontainers when the package cannot be imported", async () => {
    const h = makeContainerHost(deps({ importTestcontainers: noTc }));
    // Guards: the optional peer dependency missing is its own cure, not a crash.
    expect(await h.preflight(preflightArgs([]))).toEqual({
      kind: "no-testcontainers",
    });
  });

  it("returns mount-failed for a mount Docker would create", async () => {
    const missing = join(freshDir(), "missing");
    // Guards: a missing bind source is refused here, before any container.
    expect(
      await host.preflight(preflightArgs([{ path: missing, mode: "rw" }])),
    ).toMatchObject({
      kind: "mount-failed",
      path: missing,
    });
  });
});

describe("container preflight: this Node", () => {
  it("returns node-too-old before loading testcontainers on an older Node", async () => {
    const load = vi.fn(noTc);
    const old = deps({ nodeVersion: "20.19.5", importTestcontainers: load });
    // Guards: Node 20 gets the Node cure, not the misleading import error.
    expect(await makeContainerHost(old).preflight(preflightArgs([]))).toEqual(
      nodePreflight("20.19.5"),
    );
    // Guards: the version is asked first, so the throwing import is never reached.
    expect(load).not.toHaveBeenCalled();
  });
});

withDocker("container preflight: the network the harness needs", () => {
  beforeAll(() => {
    buildFakeHarnessImage();
  });

  it("returns no-egress with the error code for a URL nothing answers", async () => {
    const url = "https://127.0.0.1:8/";
    // Guards: a request that fails in the container stops the run, naming the URL and why.
    expect(
      await host.preflight(
        preflightArgs([], { image: FAKE_HARNESS_IMAGE }, { egressProbe: url }),
      ),
    ).toEqual({ kind: "no-egress", url, detail: "ECONNREFUSED" });
  });

  it("returns no-egress under networkMode none", async () => {
    const url = "https://api.anthropic.com";
    const r = await host.preflight(
      preflightArgs(
        [],
        { image: FAKE_HARNESS_IMAGE, networkMode: "none" },
        { egressProbe: url },
      ),
    );
    // Guards: an offline container is asked, not assumed online: the model API is unreachable.
    expect(r).toMatchObject({ kind: "no-egress", url });
    // Guards: the detail is the request's own error code, not an empty string.
    expect(r.kind === "no-egress" ? r.detail : "").toMatch(/^E[A-Z_]+$/);
  });

  it("is not asked when the harness names no URL", async () => {
    // Guards: the control: the same offline container is ready when nothing needs the network.
    expect(
      await host.preflight(
        preflightArgs([], { image: FAKE_HARNESS_IMAGE, networkMode: "none" }),
      ),
    ).toEqual({ kind: "ready" });
  });
});

const reachSkip =
  "SKIPPED — the host has no NODE_EXTRA_CA_CERTS file, so the reachable-URL preflight did not run";
const reachRuns = runDocker && (HOST_CA !== undefined || inCi);
if (!reachRuns && runDocker) {
  process.stderr.write(`⚠ src/host/container.io.test.ts: ${reachSkip}\n`);
  // Loud skip, never a silent pass: the reporter names why nothing ran.
  it.skip(reachSkip, () => {
    expect(HOST_CA).toBeDefined();
  });
}
(reachRuns ? describe : describe.skip)(
  "container preflight: a reachable model API",
  () => {
    beforeAll(() => {
      buildFakeHarnessImage();
    });

    it("returns ready when the container reaches the URL, trusting the host CA", async () => {
      const url = "https://api.anthropic.com";
      // Guards: any HTTP status is reachable, behind a proxy that decrypts HTTPS once its CA is in the image.
      expect(
        await host.preflight(
          preflightArgs(
            [],
            { image: FAKE_HARNESS_IMAGE },
            { egressProbe: url },
          ),
        ),
      ).toEqual({ kind: "ready" });
    });
  },
);

withDocker("container preflight: the daemon and the image", () => {
  beforeAll(() => {
    buildFakeHarnessImage();
  });

  it("returns no-docker with the library's own detail", async () => {
    const real = await import("testcontainers");
    const h = makeContainerHost(
      deps({
        importTestcontainers: () =>
          Promise.resolve({
            ...real,
            getContainerRuntimeClient: () =>
              Promise.reject(new Error("no runtime (planted)")),
          }),
      }),
    );
    // Guards: a daemon that does not answer is no-docker, carrying what the library said.
    expect(await h.preflight(preflightArgs([]))).toEqual({
      kind: "no-docker",
      detail: "no runtime (planted)",
    });
  });

  it("returns image-failed when the recipe's image cannot be built", async () => {
    const h = makeContainerHost(
      deps({ packVigiles: () => Promise.resolve(Buffer.from("tarball")) }),
    );
    const recipe = {
      base: "localhost:1/vigiles-none:never",
      npmPackages: [],
      binary: "sh",
    };
    // Guards: a build that fails is reported before trial 1, not as trial 1's crash.
    expect(await h.preflight(preflightArgs([], {}, { recipe }))).toMatchObject({
      kind: "image-failed",
    });
  });

  it("returns image-failed when the image lacks the binary or vigiles", async () => {
    const lacking = { ...SH, binary: "vigiles-no-such-binary" };
    // Guards: a ready image that cannot run the harness is caught by name.
    expect(
      await host.preflight(
        preflightArgs([], { image: FAKE_HARNESS_IMAGE }, { recipe: lacking }),
      ),
    ).toEqual({
      kind: "image-failed",
      detail: "no vigiles-no-such-binary on PATH",
    });
    // Guards: an image without vigiles installed is caught too (the intercept hook needs it).
    expect(
      await host.preflight(preflightArgs([], { image: IMAGE })),
    ).toMatchObject({ kind: "image-failed" });
  });
});

withDocker("container preflight: the mounts", () => {
  beforeAll(() => {
    buildFakeHarnessImage();
  });

  it("returns mount-failed when a rw mount cannot be written from inside", async () => {
    const file = join(freshDir(), "a-file");
    writeFileSync(file, "x");
    // Guards: a mount the container cannot write into fails its round trip.
    expect(
      await host.preflight(preflightArgs([{ path: file, mode: "rw" }])),
    ).toMatchObject({
      kind: "mount-failed",
      path: file,
    });
  });

  it("returns ready for good mounts, and leaves no probe file behind", async () => {
    const rw = freshDir();
    const ro = freshDir();
    const r = await host.preflight(
      preflightArgs([
        { path: rw, mode: "rw" },
        { path: ro, mode: "ro" },
      ]),
    );
    // Guards: the control: every check passes when nothing is planted.
    expect(r).toEqual({ kind: "ready" });
    // Guards: the round trip cleans up after itself in the user's directory.
    expect(readdirSync(rw)).toEqual([]);
    expect(leftContainers()).toBe("");
  });
});

/**
 * `node:24-slim` plus a placeholder at vigiles's CLI path, and the host CA
 * trusted by `node` the way a built image trusts it; builds offline.
 */
function buildFakeHarnessImage(): void {
  const context = freshDir();
  mkdirSync(context, { recursive: true });
  if (HOST_CA !== undefined) writeFileSync(join(context, "ca.crt"), HOST_CA);
  const trust =
    HOST_CA === undefined
      ? ""
      : `COPY ca.crt ${HOST_CA_IN_IMAGE}\nENV NODE_EXTRA_CA_CERTS=${HOST_CA_IN_IMAGE}\n`;
  writeFileSync(
    join(context, "Dockerfile"),
    `FROM ${IMAGE}\n${trust}RUN mkdir -p ${dirname(CONTAINER_VIGILES_CLI)} && touch ${CONTAINER_VIGILES_CLI}\n`,
  );
  docker("build", "-q", "-t", FAKE_HARNESS_IMAGE, context);
}
