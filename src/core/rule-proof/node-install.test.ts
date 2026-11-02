/**
 * How a Node repository installs its pinned dependencies, read from its
 * lockfiles and `packageManager`, and where every package manager's cache goes.
 */
import { describe, expect, it } from "vitest";
import {
  nodeCacheEnv,
  nodeInstallPlan,
  packageManagerIn,
  versionIn,
} from "./node-install.js";

describe("nodeInstallPlan", () => {
  it("npm: ci with scripts off", () => {
    expect(
      nodeInstallPlan({ lockfiles: ["README.md", "package-lock.json"] }),
    ).toEqual({
      kind: "plan",
      install: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    });
  });
  it("packageManager decides the tool and its version, through corepack", () => {
    expect(
      nodeInstallPlan({
        lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
        packageManager: "pnpm@8.6.0+sha512.abc",
      }),
    ).toEqual({
      kind: "plan",
      install: [
        "corepack",
        "pnpm@8.6.0",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
    });
  });
});

describe("nodeInstallPlan: yarn, bun, none", () => {
  it("yarn 1 and yarn berry take different flags", () => {
    expect(nodeInstallPlan({ lockfiles: ["yarn.lock"] })).toEqual({
      kind: "plan",
      install: [
        "corepack",
        "yarn@1",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--non-interactive",
      ],
    });
    expect(
      nodeInstallPlan({
        lockfiles: ["yarn.lock"],
        packageManager: "yarn@4.1.0",
      }),
    ).toEqual({
      kind: "plan",
      install: [
        "corepack",
        "yarn@4.1.0",
        "install",
        "--immutable",
        "--mode=skip-build",
      ],
    });
  });
  it("bun runs through npx at its pinned version", () => {
    expect(
      nodeInstallPlan({ lockfiles: ["bun.lock"], packageManager: "bun@1.1.0" }),
    ).toEqual({
      kind: "plan",
      install: [
        "npx",
        "--yes",
        "bun@1.1.0",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
    });
    expect(nodeInstallPlan({ lockfiles: ["bun.lockb"] })).toMatchObject({
      install: [
        "npx",
        "--yes",
        "bun",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
    });
  });
});

describe("nodeInstallPlan: no lockfile", () => {
  it("no lockfile is no plan: the version would not be pinned", () => {
    expect(nodeInstallPlan({ lockfiles: [] })).toEqual({
      kind: "none",
      reason: "no lockfile: the linter version would not be the repository's",
    });
    expect(
      nodeInstallPlan({ lockfiles: [], packageManager: "pnpm@9.0.0" }),
    ).toMatchObject({ kind: "none" });
  });
});

describe("versionIn", () => {
  it("the version of a package.json, or null for anything else", () => {
    expect(versionIn('{"version":"9.1.0"}')).toBe("9.1.0");
    expect(versionIn(null)).toBeNull();
    expect(versionIn("{")).toBeNull();
    expect(versionIn('{"version":1}')).toBeNull();
  });
});

describe("packageManagerIn", () => {
  it("the field, or nothing for a missing, broken or odd package.json", () => {
    expect(packageManagerIn('{"packageManager":"pnpm@9.1.0"}')).toBe(
      "pnpm@9.1.0",
    );
    expect(packageManagerIn(null)).toBeUndefined();
    expect(packageManagerIn("{")).toBeUndefined();
    expect(packageManagerIn('{"packageManager":1}')).toBeUndefined();
  });
});

describe("nodeCacheEnv", () => {
  it("every Node package manager's cache lives under the cache dir", () => {
    expect(nodeCacheEnv("/w")).toEqual({
      npm_config_cache: "/w/npm",
      npm_config_store_dir: "/w/pnpm",
      YARN_CACHE_FOLDER: "/w/yarn",
      YARN_GLOBAL_FOLDER: "/w/yarn-global",
      COREPACK_HOME: "/w/corepack",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      BUN_INSTALL_CACHE_DIR: "/w/bun",
    });
  });
});
