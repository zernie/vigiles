/**
 * claudeCodeRuntime — the Claude Code `HarnessRuntime` (spawn `claude`, reach the
 * mock via `ANTHROPIC_BASE_URL` with a dummy `ANTHROPIC_API_KEY`). The runners
 * (`harness-test.ts`, `eval.ts`) read the binary + env from here instead of
 * hard-coding them; a Codex adapter defines `codexRuntime` and its runner uses it.
 */
import type { HarnessImageRecipe } from "../../core/container.js";
import type {
  ContainerImageDeclaration,
  HarnessRuntime,
  RunEnvPolicy,
} from "../../core/runtime.js";
import { claudeCodeRequestCapture } from "./request-capture.io.js";

/**
 * What a child `claude` run may inherit from its caller. The runners apply it
 * through `src/core/run-env.ts`; this object is the only place the names live.
 *
 * `keep` — auth and backend selection only, as an allowlist. It replaced a
 * `CLAUDE_*` prefix pass-through, which carried the parent session's identity
 * into every scrubbed run. Measured 2026-10-07 on 2.1.292: a child started with
 * the parent's session variables ran as the parent session, and a host-brokered
 * child (`ANTHROPIC_BASE_URL`) authenticated with NO `CLAUDE_*` variable at all.
 * Every `CLAUDE_*` name below is one the prefix used to carry and that selects
 * or supplies credentials (each is referenced by the 2.1.292 binary).
 * `CLAUDE_CONFIG_DIR` is left out on purpose: it points the child at the real
 * config directory (settings, hooks, sessions, tasks) that the throwaway HOME
 * exists to hide.
 *
 * `sessionIdentity` — the parent session. The first six were observed in a live
 * session's env on 2026-10-07; the rest are session-identifying names present
 * in the 2.1.292 binary, removed by name rather than by a measured effect.
 */
const claudeCodeRunEnv: RunEnvPolicy = {
  keep: [
    // Anthropic API auth + endpoint.
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    // Carried over from the earlier list; not referenced by the 2.1.292 binary.
    "ANTHROPIC_API_URL",
    "ANTHROPIC_DEFAULT_HEADERS",
    // Subscription token (`claude setup-token`) and client certificates.
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    // Cloud backends: the switch, the auth skip, and region/profile — never
    // the secret-shaped AWS_* access keys.
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "CLOUD_ML_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ],
  keepHomeFiles: [".claude/.credentials.json"],
  sessionIdentity: [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_REMOTE_SESSION_UUID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CLOUD_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_RUNNER_SESSION_ID",
    "CLAUDE_RUNNER_SESSION_UUID",
    "CLAUDE_PID",
  ],
};

/** `x.y.z`, each part only digits: the token of `--version` that names the release. */
const isFullVersion = (token: string): boolean => {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => /^\d+$/.test(p));
};

/** Where `claude` sends model requests unless a backend variable points it elsewhere. */
const CLAUDE_MODEL_API_ORIGIN = "https://api.anthropic.com";

/** Switches that send `claude`'s model requests to a cloud whose host the env does not name. */
const CLOUD_BACKENDS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * The image a container eval attempt of `claude` runs in: Node 24 slim, with
 * the npm package of the SAME version as the host's binary (the full
 * `x.y.z`, not the `major.minor` cache key: the image must be the binary the
 * host measured). A subscription login on macOS is in the Keychain, which a
 * Linux container cannot read, so a container run needs a token in the env;
 * `claude setup-token` mints one. The preflight asks whether a container can
 * reach where `claude` sends model requests: `ANTHROPIC_BASE_URL` when set,
 * else the API's origin, and nothing under a cloud backend (any value of its
 * switch counts, so a doubtful one is not probed rather than refused).
 */
const claudeCodeContainerImage: ContainerImageDeclaration = {
  recipe(rawVersion: string): HarnessImageRecipe | undefined {
    const version = rawVersion.trim().split(" ").find(isFullVersion);
    return version === undefined
      ? undefined
      : {
          base: "node:24-slim",
          npmPackages: [`@anthropic-ai/claude-code@${version}`],
          binary: "claude",
        };
  },
  egressProbe(env) {
    if (CLOUD_BACKENDS.some((name) => (env[name] ?? "") !== ""))
      return undefined;
    const base = env.ANTHROPIC_BASE_URL ?? "";
    return base === "" ? CLAUDE_MODEL_API_ORIGIN : base;
  },
  authEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  authCure: "claude setup-token",
};

export const claudeCodeRuntime: HarnessRuntime = {
  name: "claude-code",
  agentBinary: "claude",
  modelBaseUrlEnv: "ANTHROPIC_BASE_URL",
  modelApiKeyEnv: "ANTHROPIC_API_KEY",
  mockApiKey: "sk-vigiles-mock",
  /**
   * Claude Code reaches the mock purely through env (no argv flags): the
   * base-URL var + a dummy key. The returned `env` is the overlay the runner
   * layers over `process.env`, so the spawn env is identical to `mockModelEnv`.
   */
  wireMock(baseUrl: string): {
    readonly args: readonly string[];
    readonly env: Record<string, string>;
  } {
    return {
      args: [],
      env: {
        [claudeCodeRuntime.modelBaseUrlEnv]: baseUrl,
        [claudeCodeRuntime.modelApiKeyEnv]: claudeCodeRuntime.mockApiKey,
      },
    };
  },
  /**
   * Claude Code keys on **major.minor**: a minor/major bump is where the system
   * prompt + tool defs actually move (0.2 → 1.0 → 2.0 → 2.1, ~quarterly), while
   * the daily patch stream rarely changes behavior — so keying patches would
   * churn the cache for no signal. Falls back to the trimmed raw string when no
   * semver is found. (If a specific patch is known to matter, clear the cache or
   * bump `CACHE_FORMAT_VERSION`.)
   */
  versionKey(raw: string): string {
    const m = /(\d+)\.(\d+)\.\d+/.exec(raw);
    return m ? `${m[1]}.${m[2]}` : raw.trim();
  },
  runEnv: claudeCodeRunEnv,
  requestCapture: claudeCodeRequestCapture,
  containerImage: claudeCodeContainerImage,
};

/**
 * Build the spawn env that points the agent CLI at the mock model: the caller's
 * environment plus the runtime's base-URL var (→ the mock's URL) and a dummy
 * API key. Pure (no spawn), so it's unit-tested directly — the testable seam of
 * the otherwise un-coverable real-subprocess path.
 */
export function mockModelEnv(
  runtime: HarnessRuntime,
  baseUrl: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    [runtime.modelBaseUrlEnv]: baseUrl,
    [runtime.modelApiKeyEnv]: runtime.mockApiKey,
  };
}
