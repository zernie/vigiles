/**
 * The Ruff kit: the pin read from a repository's files, the report read back,
 * the settings written as TOML, and the install plan it hands the steps.
 */
import { describe, expect, it } from "vitest";
import { parseRuffReport, ruffConfigToml, ruffKit, ruffPin } from "./ruff.js";

describe("parseRuffReport", () => {
  const dir = "/repo";
  const files = ["a.py", "b.py", "c.py"];
  it("files with no diagnostic are linted with zero hits", () => {
    const out = JSON.stringify([
      { code: "E501", filename: "/repo/a.py", message: "long" },
      { code: "F401", filename: "/repo/a.py", message: "other rule" },
      { code: "invalid-syntax", filename: "/repo/b.py", message: "bad" },
    ]);
    expect(parseRuffReport(out, dir, files, "E501")).toEqual({
      kind: "parsed",
      files: [
        { path: "a.py", kind: "linted", hits: 1 },
        { path: "b.py", kind: "parse-error", message: "bad" },
        { path: "c.py", kind: "linted", hits: 0 },
      ],
    });
  });
  it("older Ruff spells a parse error E999 or null", () => {
    const out = JSON.stringify([
      { code: "E999", filename: "/repo/a.py", message: "old" },
      { code: null, filename: "/repo/b.py", message: "null" },
    ]);
    expect(parseRuffReport(out, dir, files, "E501")).toMatchObject({
      files: [{ kind: "parse-error" }, { kind: "parse-error" }, {}],
    });
  });
  it("output that is not the report is unreadable", () => {
    expect(parseRuffReport("error: x", dir, files, "E501")).toMatchObject({
      kind: "unreadable",
    });
  });
});

describe("ruffPin", () => {
  it("a lockfile first", () => {
    const lock = '[[package]]\nname = "ruff"\nversion = "0.4.2"\n';
    expect(ruffPin({ "uv.lock": lock })).toBe("0.4.2");
    expect(ruffPin({ "poetry.lock": lock })).toBe("0.4.2");
    expect(ruffPin({ "pdm.lock": lock })).toBe("0.4.2");
  });
  it("then an exact pin in requirements or pyproject", () => {
    expect(ruffPin({ "requirements-dev.txt": "black\nruff==0.3.1\n" })).toBe(
      "0.3.1",
    );
    expect(
      ruffPin({
        "pyproject.toml": '[dependency-groups]\ndev = ["ruff == 0.5.0"]\n',
      }),
    ).toBe("0.5.0");
  });
  it("then the pre-commit hook's rev", () => {
    const pc =
      "repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.6.9\n";
    expect(ruffPin({ ".pre-commit-config.yaml": pc })).toBe("0.6.9");
  });
  it("no pin, a ranged pin, or an unreadable file is no pin", () => {
    expect(ruffPin({})).toBeNull();
    expect(ruffPin({ "requirements.txt": "ruff>=0.3\n" })).toBeNull();
    expect(ruffPin({ "uv.lock": "not toml [" })).toBeNull();
    expect(ruffPin({ "uv.lock": "a = 1\n" })).toBeNull();
    expect(ruffPin({ "pyproject.toml": "not toml [" })).toBeNull();
    expect(ruffPin({ "pyproject.toml": "[project]\nname = 1\n" })).toBeNull();
    expect(ruffPin({ ".pre-commit-config.yaml": "a: [" })).toBeNull();
    expect(ruffPin({ ".pre-commit-config.yaml": "repos: 3" })).toBeNull();
    expect(
      ruffPin({
        ".pre-commit-config.yaml":
          "repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n",
      }),
    ).toBeNull();
    expect(
      ruffPin({ "uv.lock": '[[package]]\nname = "black"\nversion = "1"\n' }),
    ).toBeNull();
  });
});

describe("ruffKit", () => {
  const root = (files: Readonly<Record<string, string>>) => ({
    names: Object.keys(files),
    read: (name: string) => files[name] ?? null,
  });
  it("installs and runs the pinned version through uvx", () => {
    const plan = ruffKit.plan(
      root({ "requirements.txt": "ruff==0.4.2\n", "README.md": "" }),
    );
    if (plan.kind !== "plan") throw new Error(plan.reason);
    expect(plan.install).toEqual(["uvx", "ruff@0.4.2", "--version"]);
    expect(plan.command("/r")).toEqual(["uvx", "ruff@0.4.2"]);
    expect(plan.version(() => null)).toBe("0.4.2");
  });
  it("a pin file that cannot be read is no pin", () => {
    expect(
      ruffKit.plan({ names: ["requirements.txt"], read: () => null }),
    ).toEqual({
      kind: "none",
      stage: "no-pin",
      reason:
        "no exact Ruff pin in a lockfile, requirements, pyproject.toml or pre-commit",
    });
  });
  it("the settings go to a TOML file in the cache dir; only exit 0 carries a report", () => {
    const reading = {
      linter: "ruff" as const,
      rule: "E501",
      settings: { "line-length": 100 },
      scope: { files: ["**/*.py"], ignores: [] },
    };
    const call = ruffKit.invocation(reading, ["a.py"], {
      dir: "/r",
      cacheDir: "/c",
    });
    expect(call.configPath).toBe("/r/.vigiles-rule-proof.ruff.toml");
    expect(call.configText).toBe("line-length = 100\n");
    expect(call.args.slice(-5)).toEqual([
      "--select",
      "E501",
      "--config",
      "/r/.vigiles-rule-proof.ruff.toml",
      "a.py",
    ]);
    expect(ruffKit.reportCodes).toEqual([0]);
    expect(ruffKit.env("/c")).toEqual({ UV_CACHE_DIR: "/c/uv" });
    expect(ruffConfigToml({})).toBe("");
  });
});
