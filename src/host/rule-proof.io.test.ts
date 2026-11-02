/**
 * `experimental_ruleProof` end to end, on fake repositories and no network.
 *
 * The install command is answered by a fake `exec` (an install is a download);
 * everything after it runs for real: ESLint from this repository's own
 * `node_modules`, Ruff from PATH (a loud skip where it is absent, as the gated
 * linter tests do). Both halves for every verdict: a pair that proves, a pair
 * that does not, a run that never happened.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nodeHost } from "./rule-proof.io.js";
import { experimental_ruleProof } from "../entries/rule-proof.js";
import { ruleProofWith as overHost } from "../core/rule-proof/run.js";
import {
  PROOF_KITS,
  type EslintReading,
  type RuffReading,
} from "../core/rule-proof/kits/index.js";
import type { RuleProofHost } from "../core/rule-proof/port.js";

type Exec = RuleProofHost["exec"];
const realExec = nodeHost.exec;
/** The real host, with `exec` replaced. */
const ruleProofWith = (exec: Exec) =>
  overHost({ ...nodeHost, exec }, PROOF_KITS);

// Tests run from the repository root, as every suite here does.
const VIGILES = resolve(process.cwd());
const ESLINT_VERSION: unknown = JSON.parse(
  readFileSync(join(VIGILES, "node_modules/eslint/package.json"), "utf8"),
);

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => {
    rmSync(d, { recursive: true, force: true });
  });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rule-proof-"));
  made.push(d);
  return d;
}

function repo(files: Readonly<Record<string, string>>): string {
  const dir = tmp();
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  });
  return dir;
}

/** A Node repository whose `node_modules` holds this repository's ESLint. */
function eslintRepo(files: Readonly<Record<string, string>>): string {
  const dir = repo({ "package-lock.json": "{}", ...files });
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    join(VIGILES, "node_modules/eslint"),
    join(dir, "node_modules/eslint"),
  );
  symlinkSync("../eslint/bin/eslint.js", join(dir, "node_modules/.bin/eslint"));
  return dir;
}

const ok = { kind: "exited", code: 0, stdout: "", stderr: "" } as const;

/** Real runs, except the install command, which answers `installResult`. */
const installAnswers =
  (installResult: ReturnType<Exec>): Exec =>
  (command, args, options) => {
    const isInstall =
      ["npm", "corepack", "npx"].includes(command) ||
      (command === "uvx" && args[1] === "--version");
    if (isInstall) return installResult;
    // The pinned Ruff runs through uvx; here, the ruff on PATH answers it.
    if (command === "uvx") return realExec("ruff", args.slice(1), options);
    return realExec(command, args, options);
  };

const proof = ruleProofWith(installAnswers(ok));

const consoleReading: EslintReading = {
  linter: "eslint",
  rule: "no-console",
  options: [],
  scope: { files: ["src/**/*.js"], ignores: ["src/vendor/**"] },
};

const pair = {
  bad: { path: "src/planted/bad.js", text: "console.log(1);\n" },
  good: { path: "src/planted/good.js", text: "export const x = 1;\n" },
};

function installedEslint(dir: string) {
  const installed = proof.install("eslint", dir, { cacheDir: tmp() });
  if (installed.kind !== "installed") throw new Error(installed.reason);
  return installed.linter;
}

describe("experimental_ruleProof (the entry root)", () => {
  it("is the steps over the real host and the kit set", () => {
    expect(
      experimental_ruleProof.install("eslint", repo({}), { cacheDir: tmp() }),
    ).toMatchObject({
      kind: "not-installed",
      stage: "no-lockfile",
    });
  });
  it("a reading of another linter does not type-check", () => {
    const linter = installedEslint(eslintRepo({}));
    const ruffReading: RuffReading = {
      linter: "ruff",
      rule: "E501",
      settings: {},
      scope: { files: ["**/*.py"], ignores: [] },
    };
    // @ts-expect-error — a PinnedLinter of ESLint takes only an ESLint reading
    const wrong = () => proof.prove(linter, ruffReading, pair);
    expect(typeof wrong).toBe("function");
  });
});

describe("install (eslint)", () => {
  it("pins the version the repository's lockfile installed", () => {
    const linter = installedEslint(eslintRepo({}));
    expect(linter.linter).toBe("eslint");
    expect(ESLINT_VERSION).toMatchObject({ version: linter.version });
  });
  it("no lockfile: not installed, and says why", () => {
    expect(proof.install("eslint", repo({}), { cacheDir: tmp() })).toEqual({
      kind: "not-installed",
      stage: "no-lockfile",
      reason: "no lockfile: the linter version would not be the repository's",
    });
  });
});

describe("install (eslint): failures", () => {
  it("a failed install, a timeout, a missing ESLint are three different facts", () => {
    const failing = ruleProofWith(
      installAnswers({
        kind: "exited",
        code: 1,
        stdout: "",
        stderr: "403 Forbidden",
      }),
    );
    expect(
      failing.install("eslint", repo({ "yarn.lock": "" }), { cacheDir: tmp() }),
    ).toEqual({
      kind: "not-installed",
      stage: "install",
      reason: "corepack exited 1: 403 Forbidden",
    });
    const slow = ruleProofWith(installAnswers({ kind: "timeout" }));
    expect(
      slow.install("eslint", repo({ "yarn.lock": "" }), { cacheDir: tmp() }),
    ).toMatchObject({
      kind: "not-installed",
      stage: "timeout",
    });
    const killed = ruleProofWith(
      installAnswers({ kind: "killed", signal: "SIGKILL" }),
    );
    expect(
      killed.install("eslint", repo({ "yarn.lock": "" }), { cacheDir: tmp() }),
    ).toEqual({
      kind: "not-installed",
      stage: "install",
      reason: "corepack was killed by SIGKILL",
    });
    const missing = ruleProofWith(
      installAnswers({ kind: "spawn-error", message: "ENOENT" }),
    );
    expect(
      missing.install("eslint", repo({ "package-lock.json": "{}" }), {
        cacheDir: tmp(),
      }),
    ).toEqual({
      kind: "not-installed",
      stage: "install",
      reason: "npm could not start: ENOENT",
    });
    expect(
      proof.install("eslint", repo({ "package-lock.json": "{}" }), {
        cacheDir: tmp(),
      }),
    ).toEqual({
      kind: "not-installed",
      stage: "no-linter",
      reason:
        "the install left no node_modules/eslint: the repository does not depend on it",
    });
  });
});

describe("install (eslint): packageManager", () => {
  it("reads packageManager, and survives a package.json that is not JSON", () => {
    const seen: string[][] = [];
    const recording = ruleProofWith((command, args) => {
      seen.push([command, ...args]);
      return ok;
    });
    recording.install(
      "eslint",
      repo({
        "pnpm-lock.yaml": "",
        "package.json": '{"packageManager":"pnpm@9.1.0"}',
      }),
      { cacheDir: tmp() },
    );
    recording.install(
      "eslint",
      repo({ "pnpm-lock.yaml": "", "package.json": "{" }),
      {
        cacheDir: tmp(),
      },
    );
    recording.install(
      "eslint",
      repo({ "pnpm-lock.yaml": "", "package.json": '{"packageManager":1}' }),
      { cacheDir: tmp() },
    );
    expect(seen.map((a) => a[1])).toEqual(["pnpm@9.1.0", "pnpm", "pnpm"]);
  });
});

describe("prove (eslint)", () => {
  it("proved: the planted violation flagged, its twin clean; planted files removed", () => {
    const dir = eslintRepo({ "src/a.js": "x;\n" });
    const result = proof.prove(installedEslint(dir), consoleReading, pair);
    expect(result.kind).toBe("proved");
    expect(existsSync(join(dir, "src/planted"))).toBe(false);
    expect(existsSync(join(dir, ".vigiles-rule-proof.config.mjs"))).toBe(false);
  });
  it("a planted file beside existing ones removes only itself", () => {
    const dir = eslintRepo({ "src/a.js": "x;\n" });
    const flat = {
      bad: { path: "src/bad.js", text: "console.log(1);\n" },
      good: { path: "src/good.js", text: "export const x = 1;\n" },
    };
    expect(proof.prove(installedEslint(dir), consoleReading, flat).kind).toBe(
      "proved",
    );
    expect(existsSync(join(dir, "src/a.js"))).toBe(true);
    expect(existsSync(join(dir, "src/bad.js"))).toBe(false);
  });
  it("not proved: a reading whose options let the violation through", () => {
    const dir = eslintRepo({});
    const lenient = { ...consoleReading, options: [{ allow: ["log"] }] };
    expect(proof.prove(installedEslint(dir), lenient, pair)).toEqual({
      kind: "not-proved",
      badHits: 0,
      goodHits: 0,
    });
  });
  it("a planted file outside the scope, or on an existing path, is never written", () => {
    const dir = eslintRepo({ "src/planted/good.js": "keep me\n" });
    const linter = installedEslint(dir);
    expect(
      proof.prove(linter, consoleReading, {
        ...pair,
        bad: { path: "lib/bad.js", text: "" },
      }),
    ).toEqual({
      kind: "not-run",
      stage: "pair-outside-scope",
      reason: "lib/bad.js is not in the reading's scope",
    });
    expect(proof.prove(linter, consoleReading, pair)).toEqual({
      kind: "not-run",
      stage: "pair-path-taken",
      reason: "src/planted/good.js already exists in the repository",
    });
    expect(readFileSync(join(dir, "src/planted/good.js"), "utf8")).toBe(
      "keep me\n",
    );
  });
});

describe("prove (eslint): no verdict", () => {
  it("a pair whose second file cannot be written leaves nothing behind", () => {
    const dir = eslintRepo({ "src/occupied": "a file, not a directory\n" });
    const blockedPair = {
      bad: { path: "src/bad.js", text: "console.log(1);\n" },
      good: { path: "src/occupied/good.js", text: "export const x = 1;\n" },
    };
    expect(
      proof.prove(installedEslint(dir), consoleReading, blockedPair),
    ).toMatchObject({
      kind: "not-run",
      stage: "pair-path-taken",
    });
    expect(existsSync(join(dir, "src/bad.js"))).toBe(false);
    const firstFails = { bad: blockedPair.good, good: blockedPair.bad };
    expect(
      proof.prove(installedEslint(dir), consoleReading, firstFails),
    ).toMatchObject({
      stage: "pair-path-taken",
    });
    expect(existsSync(join(dir, "src/bad.js"))).toBe(false);
  });
});

describe("prove (eslint): a snapshot", () => {
  it("a proved reading is a snapshot: changing the caller's object later changes nothing", () => {
    const dir = eslintRepo({ "src/a.js": "console.log(1);\n" });
    const allow = { allow: ["warn"] };
    const reading = { ...consoleReading, options: [allow] };
    const warnPair = {
      bad: { path: "src/planted/bad.js", text: "console.log(1);\n" },
      good: { path: "src/planted/good.js", text: "console.warn(1);\n" },
    };
    const proved = proof.prove(installedEslint(dir), reading, warnPair);
    if (proved.kind !== "proved") throw new Error(proved.kind);
    allow.allow.push("log");
    expect(proof.flagged(proved.reading)).toMatchObject({
      flagged: ["src/a.js"],
    });
  });
  it("a file already at the scratch config path is never overwritten", () => {
    const dir = eslintRepo({ ".vigiles-rule-proof.config.mjs": "keep me\n" });
    expect(proof.prove(installedEslint(dir), consoleReading, pair)).toEqual({
      kind: "not-run",
      stage: "scratch-path-taken",
      reason: ".vigiles-rule-proof.config.mjs already exists in the repository",
    });
    expect(
      readFileSync(join(dir, ".vigiles-rule-proof.config.mjs"), "utf8"),
    ).toBe("keep me\n");
  });
  it("a planted file that does not parse is no verdict", () => {
    const dir = eslintRepo({});
    expect(
      proof.prove(installedEslint(dir), consoleReading, {
        ...pair,
        bad: { path: "src/bad.js", text: "let = ;\n" },
      }),
    ).toMatchObject({ kind: "not-run", stage: "parse" });
  });
  it("a config that does not load is not-run, never 'silent'", () => {
    const dir = eslintRepo({});
    const unknownPlugin = { ...consoleReading, rule: "nope/rule" };
    expect(
      proof.prove(installedEslint(dir), unknownPlugin, pair),
    ).toMatchObject({
      kind: "not-run",
      stage: "config-load",
    });
  });
});

describe("flagged (eslint)", () => {
  it("only a proved reading runs; per file: flagged, parse error, outside scope dropped", () => {
    const dir = eslintRepo({
      "src/a.js": "console.log(1);\n",
      "src/b.js": "export const b = 1;\n",
      "src/c.js": "let = ;\n",
      "src/vendor/v.js": "console.log(1);\n",
      "lib/l.js": "console.log(1);\n",
    });
    const proved = proof.prove(installedEslint(dir), consoleReading, pair);
    if (proved.kind !== "proved") throw new Error(proved.kind);
    expect(proof.flagged(proved.reading)).toEqual({
      kind: "ran",
      linted: 2,
      flagged: ["src/a.js"],
      parseErrors: ["src/c.js"],
      ignored: [],
    });
  });
});

describe("flagged (eslint): no verdict", () => {
  it("a run that times out is not-run, not an empty result", () => {
    const dir = eslintRepo({ "src/a.js": "console.log(1);\n" });
    const linter = installedEslint(dir);
    const proved = proof.prove(linter, consoleReading, pair);
    if (proved.kind !== "proved") throw new Error(proved.kind);
    const timing = ruleProofWith(() => ({ kind: "timeout" }));
    expect(timing.flagged(proved.reading)).toEqual({
      kind: "not-run",
      stage: "timeout",
      reason: "the linter ran past its time limit",
    });
    expect(timing.prove(linter, consoleReading, pair)).toMatchObject({
      stage: "timeout",
    });
  });
});

describe("flagged (eslint): output that is not a report", () => {
  it("output that is not a report is config-load, whatever the exit code", () => {
    const dir = eslintRepo({ "src/a.js": "console.log(1);\n" });
    const linter = installedEslint(dir);
    const garbled = ruleProofWith(() => ({
      kind: "exited",
      code: 0,
      stdout: "hi",
      stderr: "",
    }));
    expect(garbled.prove(linter, consoleReading, pair)).toMatchObject({
      stage: "config-load",
    });
    const missing = ruleProofWith(() => ({
      kind: "exited",
      code: 0,
      stdout: "[]",
      stderr: "",
    }));
    expect(missing.prove(linter, consoleReading, pair)).toEqual({
      kind: "not-run",
      stage: "config-load",
      reason: "the linter reported nothing for src/planted/bad.js",
    });
    const onlyBad = JSON.stringify([
      { filePath: join(dir, "src/planted/bad.js"), messages: [] },
    ]);
    const half = ruleProofWith(() => ({
      kind: "exited",
      code: 0,
      stdout: onlyBad,
      stderr: "",
    }));
    expect(half.prove(linter, consoleReading, pair)).toMatchObject({
      reason: "the linter reported nothing for src/planted/good.js",
    });
    const gone = ruleProofWith(() => ({
      kind: "spawn-error",
      message: "ENOENT",
    }));
    expect(gone.prove(linter, consoleReading, pair)).toEqual({
      kind: "not-run",
      stage: "config-load",
      reason: "the linter could not start: ENOENT",
    });
    const killed = ruleProofWith(() => ({ kind: "killed", signal: "SIGSEGV" }));
    expect(killed.prove(linter, consoleReading, pair)).toMatchObject({
      reason: "the linter was killed by SIGSEGV",
    });
  });
});

function hasRuff(): boolean {
  try {
    execSync("which ruff", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const lineReading: RuffReading = {
  linter: "ruff",
  rule: "E501",
  settings: { "line-length": 20 },
  scope: { files: ["**/*.py"], ignores: ["vendor/**"] },
};

describe("install (ruff)", () => {
  it("pins the repository's Ruff version", () => {
    const dir = repo({ "requirements-dev.txt": "ruff==0.4.2\n" });
    expect(proof.install("ruff", dir, { cacheDir: tmp() })).toMatchObject({
      kind: "installed",
      linter: { linter: "ruff", version: "0.4.2" },
    });
  });
  it("no pin: not installed — a guessed version changes the answer", () => {
    expect(
      proof.install("ruff", repo({ "requirements.txt": "ruff>=0.3\n" }), {
        cacheDir: tmp(),
      }),
    ).toEqual({
      kind: "not-installed",
      stage: "no-pin",
      reason:
        "no exact Ruff pin in a lockfile, requirements, pyproject.toml or pre-commit",
    });
  });
  it("a pin file that cannot be read is no pin", () => {
    const unreadable = overHost({ ...nodeHost, read: () => null }, PROOF_KITS);
    expect(
      unreadable.install(
        "ruff",
        repo({ "requirements.txt": "ruff==0.4.2\n" }),
        {
          cacheDir: tmp(),
        },
      ),
    ).toMatchObject({ kind: "not-installed", stage: "no-pin" });
  });
  it("uvx failing to fetch that version is an install failure", () => {
    const failing = ruleProofWith(
      installAnswers({
        kind: "exited",
        code: 2,
        stdout: "",
        stderr: "no such version",
      }),
    );
    expect(
      failing.install("ruff", repo({ "requirements.txt": "ruff==9.9.9\n" }), {
        cacheDir: tmp(),
      }),
    ).toEqual({
      kind: "not-installed",
      stage: "install",
      reason: "uvx exited 2: no such version",
    });
  });
});

const ruffRepo = (files: Readonly<Record<string, string>>): string =>
  repo({ "requirements.txt": "ruff==0.0.0\n", ...files });
const ruffPair = {
  bad: {
    path: "planted/bad.py",
    text: "x = 'aaaaaaaaaaaaaaaaaaaaaaaaa'\n",
  },
  good: { path: "planted/good.py", text: "x = 1\n" },
};
function installedRuff(dir: string) {
  const installed = proof.install("ruff", dir, { cacheDir: tmp() });
  if (installed.kind !== "installed") throw new Error(installed.reason);
  return installed.linter;
}

describe.skipIf(!hasRuff())(
  "prove + flagged (ruff, gated on a ruff binary)",
  () => {
    it("proved, then the flagged files of the repository", () => {
      const dir = ruffRepo({
        "a.py": "y = 'aaaaaaaaaaaaaaaaaaaaaaaaa'\n",
        "b.py": "y = 1\n",
        "c.py": "def (:\n",
        "vendor/v.py": "y = 'aaaaaaaaaaaaaaaaaaaaaaaaa'\n",
      });
      const proved = proof.prove(installedRuff(dir), lineReading, ruffPair);
      if (proved.kind !== "proved") throw new Error(JSON.stringify(proved));
      expect(proof.flagged(proved.reading)).toEqual({
        kind: "ran",
        linted: 2,
        flagged: ["a.py"],
        parseErrors: ["c.py"],
        ignored: [],
      });
    });
    it("not proved when the reading's settings let the line through", () => {
      const dir = ruffRepo({});
      const loose = { ...lineReading, settings: { "line-length": 200 } };
      expect(proof.prove(installedRuff(dir), loose, ruffPair)).toEqual({
        kind: "not-proved",
        badHits: 0,
        goodHits: 0,
      });
    });
  },
);

describe.skipIf(!hasRuff())(
  "ruff readings cannot change what is measured (gated on a ruff binary)",
  () => {
    it("a reading's force-exclude cannot hide the twin (it would read clean)", () => {
      const dir = ruffRepo({});
      const hiding = {
        ...lineReading,
        settings: {
          "line-length": 20,
          "force-exclude": true,
          exclude: ["planted/good.py"],
        },
      };
      const bothLong = {
        ...ruffPair,
        good: { path: "planted/good.py", text: ruffPair.bad.text },
      };
      expect(proof.prove(installedRuff(dir), hiding, bothLong)).toEqual({
        kind: "not-proved",
        badHits: 1,
        goodHits: 1,
      });
    });
    it("a reading's fix setting cannot rewrite the planted violation away", () => {
      const dir = ruffRepo({});
      const fixing = {
        ...lineReading,
        rule: "F401",
        settings: { fix: true },
      };
      const unused = {
        bad: { path: "planted/bad.py", text: "import os\n" },
        good: { path: "planted/good.py", text: "x = 1\n" },
      };
      expect(proof.prove(installedRuff(dir), fixing, unused).kind).toBe(
        "proved",
      );
    });
    it("a relative `extend` resolves against the repository", () => {
      const dir = ruffRepo({
        "pyproject.toml": "[tool.ruff]\nline-length = 20\n",
      });
      const extending = {
        ...lineReading,
        settings: { extend: "./pyproject.toml" },
      };
      expect(proof.prove(installedRuff(dir), extending, ruffPair).kind).toBe(
        "proved",
      );
    });
    it("settings Ruff rejects are config-load", () => {
      const dir = ruffRepo({});
      const wrong = { ...lineReading, settings: { "no-such-setting": 1 } };
      expect(proof.prove(installedRuff(dir), wrong, ruffPair)).toMatchObject({
        kind: "not-run",
        stage: "config-load",
      });
    });
  },
);

describe("nodeHost.exec", () => {
  const opts = { cwd: tmpdir(), env: {}, timeoutMs: 10_000 };
  it("exit code and output", () => {
    expect(
      realExec(
        "node",
        [
          "-e",
          "process.stdout.write('o');process.stderr.write('e');process.exit(3)",
        ],
        opts,
      ),
    ).toEqual({ kind: "exited", code: 3, stdout: "o", stderr: "e" });
  });
  it("a process killed by a signal is not a timeout", () => {
    expect(
      realExec("node", ["-e", "process.kill(process.pid, 'SIGKILL')"], opts),
    ).toEqual({
      kind: "killed",
      signal: "SIGKILL",
    });
  });
  it("a timeout and a missing binary are their own kinds", () => {
    expect(
      realExec("node", ["-e", "setTimeout(()=>{},5000)"], {
        ...opts,
        timeoutMs: 100,
      }),
    ).toEqual({
      kind: "timeout",
    });
    expect(realExec("no-such-binary-xyz", [], opts)).toMatchObject({
      kind: "spawn-error",
    });
  });
});
