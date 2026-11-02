/**
 * How a Node repository installs its pinned dependencies: the lockfile says
 * which tool, `packageManager` decides between two and pins the tool's version.
 * Shared by every kit whose linter ships through npm.
 */
import { posix } from "node:path";
import { z } from "zod";

/** What a repository says about its Node package manager. */
export interface NodeInstallFacts {
  /** Entry names at the repository root (lockfiles among them). */
  readonly lockfiles: readonly string[];
  /** The `packageManager` field of the root `package.json`, if any. */
  readonly packageManager?: string;
}

/** The install command, or why there is none. */
export type NodeInstallPlan =
  | {
      readonly kind: "plan";
      readonly install: readonly [string, ...string[]];
    }
  | { readonly kind: "none"; readonly reason: string };

type NodeTool = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILE_TOOL: Readonly<Record<string, NodeTool>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

const NO_SCRIPTS = "--ignore-scripts";
const FROZEN = "--frozen-lockfile";

/** The install arguments per tool; `as` is the tool spelled with its pin. */
const INSTALL_ARGS: Readonly<
  Record<NodeTool, (as: string, berry: boolean) => readonly string[]>
> = {
  npm: () => ["ci", NO_SCRIPTS, "--no-audit", "--no-fund"],
  pnpm: (as) => [as, "install", FROZEN, NO_SCRIPTS],
  yarn: (as, berry) =>
    berry
      ? [as, "install", "--immutable", "--mode=skip-build"]
      : [as, "install", FROZEN, NO_SCRIPTS, "--non-interactive"],
  bun: (as) => ["--yes", as, "install", FROZEN, NO_SCRIPTS],
};

const INSTALL_COMMAND: Readonly<Record<NodeTool, string>> = {
  npm: "npm",
  pnpm: "corepack",
  yarn: "corepack",
  bun: "npx",
};

/** Yarn 1 when unpinned: corepack would otherwise pick the newest (Berry). */
const UNPINNED: Readonly<Record<NodeTool, string>> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn@1",
  bun: "bun",
};

function planFor(tool: NodeTool, version: string | undefined): NodeInstallPlan {
  const as = version === undefined ? UNPINNED[tool] : `${tool}@${version}`;
  const berry = version !== undefined && !version.startsWith("1.");
  return {
    kind: "plan",
    install: [INSTALL_COMMAND[tool], ...INSTALL_ARGS[tool](as, berry)],
  };
}

/**
 * The install for a Node repository. No lockfile is no plan: an install without
 * one would not reproduce the repository's linter version, which is the point
 * of installing at all.
 */
export function nodeInstallPlan(facts: NodeInstallFacts): NodeInstallPlan {
  const tools = facts.lockfiles.flatMap((f) => {
    const tool = LOCKFILE_TOOL[f];
    return tool === undefined ? [] : [tool];
  });
  const pm = /^([^@]+)@([^+]+)/.exec(facts.packageManager ?? "");
  const declared = tools.find((t) => t === pm?.[1]);
  const tool = declared ?? tools[0];
  if (tool === undefined)
    return {
      kind: "none",
      reason: "no lockfile: the linter version would not be the repository's",
    };
  return planFor(tool, declared === undefined ? undefined : pm?.[2]);
}

const packageJsonSchema = z.object({ packageManager: z.string().optional() });

/** The `packageManager` field of a `package.json` text, if it has one. */
export function packageManagerIn(text: string | null): string | undefined {
  try {
    const parsed = packageJsonSchema.safeParse(JSON.parse(text ?? "{}"));
    return parsed.success ? parsed.data.packageManager : undefined;
  } catch {
    return undefined;
  }
}

const versionSchema = z.object({ version: z.string() });

/** The `version` of a package's `package.json` text, or null. */
export function versionIn(text: string | null): string | null {
  try {
    const parsed = versionSchema.safeParse(JSON.parse(text ?? "null"));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

/**
 * Every Node package manager's cache under `cacheDir`: one hand-written copy of
 * this filled the root disk with a 6.8 GB yarn cache, and Yarn Berry and bun
 * ignore `npm_config_cache`.
 */
export function nodeCacheEnv(
  cacheDir: string,
): Readonly<Record<string, string>> {
  const at = (name: string): string => posix.join(cacheDir, name);
  return {
    npm_config_cache: at("npm"),
    npm_config_store_dir: at("pnpm"),
    YARN_CACHE_FOLDER: at("yarn"),
    YARN_GLOBAL_FOLDER: at("yarn-global"),
    COREPACK_HOME: at("corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    BUN_INSTALL_CACHE_DIR: at("bun"),
    // Yarn Berry's default Plug'n'Play leaves no node_modules, so the linter
    // and its version could not be found where every other tool puts them.
    // The lockfile, not the linker, pins the versions.
    YARN_NODE_LINKER: "node-modules",
  };
}
