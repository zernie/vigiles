/**
 * vigiles — safe-by-default confinement for executing untrusted harness code.
 *
 * `runHarnessTest` runs the real `claude` CLI, which runs the real hooks of
 * whatever plugin you load. For code YOU authored (inline `settings`/`files`)
 * that's fine — trust is implicit. But pointing it at someone else's `plugin` /
 * `pluginDir` executes THEIR hooks with your privileges. This module makes that
 * safe by default: untrusted code is confined under bubblewrap, or — if no
 * sandbox is available — the run refuses rather than executing unconfined.
 *
 * Confinement (proven on bwrap 0.9): `--unshare-all` gives a fresh network
 * namespace whose loopback is auto-up but has NO external route — so the
 * scripted mock, co-launched INSIDE the namespace, is reachable over 127.0.0.1
 * while a malicious hook cannot phone home. The filesystem is `--ro-bind`
 * read-only except the throwaway work dir, a fresh empty `$HOME`, and an IO dir
 * used to hand the script in and stream captured requests back out.
 *
 * The policy (`decideSandbox`), trust test (`specTrusted`), and bwrap argv
 * (`bwrapArgs`) are pure and unit-tested; the executor (`runSandboxed`) needs a
 * real bwrap and is covered by the integration test, which skips where bwrap is
 * absent — the same pattern as the real-`claude` paths.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { claudeCodeRuntime } from "./adapters/claude-code/runtime.js";

import { type ModelTurn, type ModelRequest } from "./mock-model.js";
import { makeTmpDir } from "./core/tmp-root.js";

/**
 * How to treat code execution. `"auto"` (default) is safe-by-default: trusted
 * code runs directly, untrusted code is sandboxed if possible and otherwise
 * refuses. `false` is the dangerous opt-out — run unconfined (you audited it, or
 * you trust the outer container). `"strict"` forces confinement even for trusted
 * code and throws if no sandbox is available.
 */
export type SandboxMode = "auto" | "strict" | false;

let cachedAvailable: boolean | undefined;

/**
 * Whether this environment can ACTUALLY confine untrusted code under bubblewrap.
 * **Linux only.** Critically, `bwrap --version` succeeding is NOT enough: many CI
 * runners and hardened hosts ship bubblewrap but disable the **unprivileged user
 * namespaces** it depends on, so a real confined exec fails even though the binary
 * is present. We probe that real capability — a throwaway `bwrap --unshare-all …
 * true` — and cache it, so we never *claim* confinement we can't deliver.
 * `decideSandbox` then correctly refuses untrusted code in such an environment
 * (rather than running it in a "sandbox" that doesn't actually sandbox), and the
 * sandbox-gated tests skip instead of failing. The result is cached because the
 * probe spawns a process and the answer can't change within a run.
 */
export function sandboxAvailable(): boolean {
  if (cachedAvailable === undefined) cachedAvailable = probeSandbox();
  return cachedAvailable;
}

function probeSandbox(): boolean {
  /* v8 ignore start -- non-Linux has no bwrap; CI/coverage runs on Linux */
  if (process.platform !== "linux") return false;
  /* v8 ignore stop */
  try {
    // The capability that fails when user namespaces are disabled is the
    // namespace creation itself (`--unshare-all`), so probe exactly that.
    return (
      spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"], {
        stdio: "ignore",
        timeout: 10_000,
      }).status === 0
    );
  } catch {
    /* v8 ignore start -- defensive: spawnSync only throws on a fork failure */
    return false;
    /* v8 ignore stop */
  }
}

/**
 * Is this spec's executed code trusted? Inline `settings`/`files` you authored
 * are trusted; any external `plugin` / `pluginDir` brings in third-party hooks
 * and is NOT — committing it to your repo is the same trust decision as a
 * dependency, so the trust boundary follows provenance: foreign = confined.
 */
export function specTrusted(spec: {
  plugin?: string;
  pluginDir?: string;
}): boolean {
  return spec.plugin === undefined && spec.pluginDir === undefined;
}

/** The chosen action for a run: execute directly, confine it, or refuse. */
export type SandboxDecision =
  | { readonly action: "direct" }
  | { readonly action: "sandbox" }
  | { readonly action: "throw"; readonly reason: string };

/**
 * The pure safe-by-default policy. Untrusted code NEVER runs unconfined unless
 * the caller explicitly opted out (`mode: false`). This is the whole security
 * contract, isolated as a pure function so it is exhaustively unit-tested.
 */
export function decideSandbox(opts: {
  trusted: boolean;
  mode: SandboxMode;
  available: boolean;
}): SandboxDecision {
  // Explicit dangerous opt-out: run unconfined, trusted or not.
  if (opts.mode === false) return { action: "direct" };
  // Force confinement regardless of trust; refuse if we can't.
  if (opts.mode === "strict") {
    return opts.available
      ? { action: "sandbox" }
      : {
          action: "throw",
          reason:
            "sandbox: 'strict' requires Linux + bubblewrap (bwrap), which was not available",
        };
  }
  // auto: trusted code runs directly; untrusted must be confined or refused.
  if (opts.trusted) return { action: "direct" };
  return opts.available
    ? { action: "sandbox" }
    : {
        action: "throw",
        reason:
          "refusing to execute an untrusted plugin's hooks without a sandbox: " +
          "the sandbox needs Linux + bubblewrap (bwrap) — install it to run " +
          "confined, or pass sandbox: false to run unconfined if you trust this " +
          "code / the outer container",
      };
}

/**
 * The bubblewrap confinement argv (everything before the command): a fresh
 * network namespace (`--unshare-all`, loopback-only, no egress), a read-only
 * system, writable mounts limited to the work dir, the IO dir, and a fresh empty
 * HOME (inside the IO dir so it needs no mountpoint on the read-only root, and so
 * no host credentials/config leak in), and a **cleared environment** —
 * `--clearenv` drops every host variable (API keys, cloud creds) and only PATH /
 * HOME / TMPDIR are set back, so untrusted code can't even read your secrets.
 * Pure, so the confinement shape is asserted in a unit test.
 */
export function bwrapArgs(opts: {
  cwd: string;
  ioDir: string;
  home: string;
  path: string;
}): string[] {
  return [
    // New user/net/pid/ipc/uts/cgroup namespaces. The net namespace has only a
    // loopback route, so the in-sandbox mock is reachable but egress is blocked.
    "--unshare-all",
    // Drop ALL inherited env (host secrets); only the essentials are set back.
    "--clearenv",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Writable: the work dir and the IO dir (later binds override the ro-bind).
    "--bind",
    opts.cwd,
    opts.cwd,
    "--bind",
    opts.ioDir,
    opts.ioDir,
    // A fresh empty HOME so no host credentials/config are visible.
    "--setenv",
    "HOME",
    opts.home,
    "--setenv",
    "TMPDIR",
    opts.ioDir,
    // PATH must be set back explicitly (cleared above) so node/claude resolve.
    "--setenv",
    "PATH",
    opts.path,
    "--chdir",
    opts.cwd,
    "--die-with-parent",
    "--new-session",
  ];
}

/**
 * `--setenv K V` pairs to add back specific variables after `--clearenv` — e.g.
 * a hook's configured env (the `GUARD=path` a plugin's command relies on), which
 * `bwrapArgs`' `--clearenv` would otherwise drop. Pure, so it's unit-tested.
 */
export function setenvArgs(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) out.push("--setenv", k, v);
  return out;
}

/** Parse the in-sandbox mock's ndjson request log into {@link ModelRequest}s. */
export function parseRequestLog(ndjson: string): ModelRequest[] {
  const out: ModelRequest[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ModelRequest);
    } catch {
      /* a partially-written final line — skip */
    }
  }
  return out;
}

/** A network egress attempt a confined hook made — recorded, then blocked. */
export interface EgressAttempt {
  readonly host: string;
  readonly port: number;
  /** ms epoch when the attempt was recorded. */
  readonly ts: number;
  /**
   * Allowlist mode (`egress: { allow }`) only: whether this host was on the
   * allowlist (and so reachable). Undefined for the `recordEgress` proxy, where
   * every attempt is blocked.
   */
  readonly allowed?: boolean;
  /** Allowlist mode: packets the nftables counter recorded for this host. */
  readonly packets?: number;
  /** Allowlist mode: bytes the nftables counter recorded for this host. */
  readonly bytes?: number;
}

/**
 * Parse the egress recorder's ndjson log into {@link EgressAttempt}s. Pure, so
 * the record-shape and the malformed-line tolerance are unit-tested without a
 * sandbox. A line missing host/port is skipped (a partially-flushed final line).
 */
export function parseEgressLog(ndjson: string): EgressAttempt[] {
  const out: EgressAttempt[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<EgressAttempt>;
      if (typeof o.host === "string" && typeof o.port === "number") {
        out.push({ host: o.host, port: o.port, ts: Number(o.ts) || 0 });
      }
    } catch {
      /* a partially-written final line — skip */
    }
  }
  return out;
}

/**
 * The files in `after` that are new or changed vs `before` — i.e. what a confined
 * run wrote to its work dir. Each tree maps a relative path to a content
 * signature (size + mtime). Pure, so the diff is unit-tested without a sandbox.
 */
export function diffTrees(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [path, sig] of Object.entries(after)) {
    if (before[path] !== sig) out.push(path);
  }
  return out.sort();
}

/** The raw output of a sandboxed run: exit code, captured stdout, and requests. */
export interface SandboxRunOut {
  readonly code: number;
  readonly stdout: string;
  readonly requests: readonly ModelRequest[];
}

/**
 * Co-launch the scripted mock and `claude` inside ONE bubblewrap network
 * namespace: the mock serves on the sandbox's loopback (reachable), egress is
 * blocked, and captured requests stream out through the bound IO dir. Paths come
 * in via env so the wrapper needs no escaping; `claude`'s args are the wrapper's
 * positional params (`"$@"`).
 */
const WRAPPER = [
  // start the in-sandbox mock; it writes its port to $VIG_PORT when ready
  'node "$VIG_MOCKENTRY" "$VIG_SCRIPT" "$VIG_REQS" "$VIG_PORT" &',
  "MOCKPID=$!",
  "i=0",
  'while [ ! -s "$VIG_PORT" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done',
  // base-URL / API-key vars + the agent binary come from the runtime port.
  `export ${claudeCodeRuntime.modelBaseUrlEnv}="http://127.0.0.1:$(cat "$VIG_PORT")"`,
  `export ${claudeCodeRuntime.modelApiKeyEnv}=${claudeCodeRuntime.mockApiKey}`,
  `${claudeCodeRuntime.agentBinary} "$@"`,
  "code=$?",
  'kill "$MOCKPID" 2>/dev/null',
  'exit "$code"',
].join("\n");

/* v8 ignore start -- spawns bwrap + the real claude CLI; exercised by the
   bwrap-backed integration test (skipped without bwrap), not the unit gate —
   the pure policy/args/parse helpers above carry the testable logic. */
export function runSandboxed(opts: {
  cwd: string;
  claudeArgs: readonly string[];
  script: readonly ModelTurn[];
  timeoutMs: number;
}): Promise<SandboxRunOut> {
  const ioDir = makeTmpDir("sbx");
  const home = join(ioDir, "home");
  mkdirSync(home);
  const scriptF = join(ioDir, "script.json");
  const reqsF = join(ioDir, "requests.ndjson");
  const portF = join(ioDir, "port");
  writeFileSync(scriptF, JSON.stringify(opts.script));
  writeFileSync(reqsF, "");
  // The mock entry is only runnable as built JS. In production __dirname is
  // dist/ (sibling); under vitest the source runs from src/, so fall back to
  // the built dist/ copy.
  const mockEntry =
    [
      join(__dirname, "mock-entry.js"),
      join(__dirname, "..", "dist", "mock-entry.js"),
    ].find((p) => existsSync(p)) ?? join(__dirname, "mock-entry.js");
  const args = [
    ...bwrapArgs({
      cwd: opts.cwd,
      ioDir,
      home,
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    }),
    "--setenv",
    "VIG_MOCKENTRY",
    mockEntry,
    "--setenv",
    "VIG_SCRIPT",
    scriptF,
    "--setenv",
    "VIG_REQS",
    reqsF,
    "--setenv",
    "VIG_PORT",
    portF,
    "sh",
    "-c",
    WRAPPER,
    "sh",
    ...opts.claudeArgs,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn("bwrap", args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", () => {
      /* hook diagnostics — not needed for the captured result */
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const requests = parseRequestLog(
        existsSync(reqsF) ? readFileSync(reqsF, "utf-8") : "",
      );
      rmSync(ioDir, { recursive: true, force: true });
      resolvePromise({ code: code ?? 0, stdout, requests });
    });
  });
}
/* v8 ignore stop */
