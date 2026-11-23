/**
 * Structural guard for the shipped GitHub Action (action.yml).
 *
 * Locks in the production-grade contract from the `prod-grade-gha-cli` rule so
 * a regression (reverting to a node20 entry, the deprecated ::set-output, a
 * dropped output, or an input that no longer maps to a CLI flag) fails here.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { load } from "js-yaml";

const actionPath = resolve(__dirname, "..", "action.yml");
const raw = readFileSync(actionPath, "utf-8");
const action = load(raw) as {
  inputs: Record<string, { default?: string; description?: string }>;
  outputs?: Record<string, { value?: string }>;
  runs: {
    using?: string;
    main?: string;
    steps?: ReadonlyArray<{
      readonly run?: string;
      readonly env?: Readonly<Record<string, string>>;
    }>;
  };
};

describe("action.yml — production-grade GitHub Action contract", () => {
  it("is a composite action over the CLI, not a node20 entry at an uncommitted dist/", () => {
    assert.equal(action.runs.using, "composite");
    assert.equal(
      action.runs.main,
      undefined,
      "must not point at dist/action.js",
    );
    assert.ok(Array.isArray(action.runs.steps) && action.runs.steps.length > 0);
  });

  it("never uses the deprecated ::set-output", () => {
    assert.ok(
      !raw.includes("::set-output"),
      "outputs must be written via $GITHUB_OUTPUT",
    );
  });

  it("declares the `valid` output, wired to a step output", () => {
    assert.ok(action.outputs?.["valid"], "missing outputs.valid");
    assert.match(
      action.outputs?.["valid"]?.value ?? "",
      /steps\.[\w-]+\.outputs\.valid/,
    );
    assert.ok(
      raw.includes("$GITHUB_OUTPUT"),
      "valid must be set via $GITHUB_OUTPUT",
    );
  });

  it("maps every functional input to a real CLI flag or command position", () => {
    // command/paths are positional; max-rules/catalog-only must reach the CLI.
    for (const input of [
      "command",
      "paths",
      "version",
      "max-rules",
      "catalog-only",
    ]) {
      assert.ok(action.inputs[input], `missing input: ${input}`);
    }
    assert.ok(
      raw.includes("--max-rules="),
      "max-rules must map to --max-rules",
    );
    assert.ok(
      raw.includes("--catalog-only"),
      "catalog-only must map to --catalog-only",
    );
  });

  it("supports `version: local` so the repo can dogfood it via uses: ./", () => {
    assert.ok(
      raw.includes('"local"') || raw.includes("== local"),
      "must branch on version=local to run the action's own build",
    );
    assert.ok(raw.includes("dist/cli.js"), "local path must run the built CLI");
  });

  it("reuses the published npm package for non-local versions", () => {
    assert.ok(
      raw.includes('npx --yes "vigiles@'),
      "must run npx vigiles@<version>",
    );
  });

  it("writes a job summary and posts a sticky PR comment", () => {
    for (const input of ["comment", "github-token"]) {
      assert.ok(action.inputs[input], `missing input: ${input}`);
    }
    assert.ok(raw.includes("$GITHUB_STEP_SUMMARY"), "must write a job summary");
    assert.ok(
      raw.includes("<!-- vigiles-action -->"),
      "must use a marker for a sticky (update-in-place) comment",
    );
    assert.ok(
      raw.includes("pull_request"),
      "comment must be gated to pull_request events",
    );
    // Update-or-create: both API calls present.
    assert.ok(raw.includes("-X PATCH") && raw.includes("-X POST"));
  });
});

/** The Action's one step, as GitHub runs it. */
const script = action.runs.steps?.[0]?.run ?? "";

/** Run the step in a scratch repo holding `files`; return the npx argv. */
function resolveRunner(
  files: Readonly<Record<string, string>>,
  version: string | undefined = action.inputs["version"]?.default,
  env: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "vigiles-action-"));
  try {
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(
      join(bin, "npx"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPX_LOG"\n',
      { mode: 0o755 },
    );
    // `npm ci` (the `test` install) lands in the same log, prefixed.
    writeFileSync(
      join(bin, "npm"),
      '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$NPX_LOG"\n',
      { mode: 0o755 },
    );
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body, { mode: 0o755 });
    }
    writeFileSync(join(root, "step.sh"), script);
    execFileSync("bash", [join(root, "step.sh")], {
      cwd: repo,
      stdio: "pipe",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        NPX_LOG: join(root, "npx.log"),
        GITHUB_OUTPUT: join(root, "out"),
        VIGILES_COMMAND: "lint",
        // Fixed by action.yml itself (not an input), so taken from the step.
        VIGILES_COMMANDS:
          action.runs.steps?.[0]?.env?.["VIGILES_COMMANDS"] ?? "",
        VIGILES_VERSION: version ?? "",
        VIGILES_ACTION_PATH: root,
        ...env,
      },
    });
    return readFileSync(join(root, "npx.log"), "utf-8").trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A consumer package.json declaring vigiles at `spec`. */
const declares = (spec: string): string =>
  JSON.stringify({ name: "consumer", devDependencies: { vigiles: spec } });

/**
 * WHICH vigiles the Action runs — by RUNNING its script, not by reading it.
 *
 * The defect: `version` defaulted to `latest`, so a consumer whose package.json
 * pins vigiles got a SECOND pin in CI that drifted from the first — the local
 * `npx vigiles lint` and the CI one could disagree, and one downstream repo
 * dropped the Action for exactly that reason. The default now runs the version
 * the consumer repo declares; `latest` only when it declares none.
 *
 * The step's bash runs for real against a scratch consumer repo. `npx` on PATH
 * is a stub that records its arguments, so nothing is downloaded or executed,
 * and `node` is the real one (the resolution reads package.json with it).
 */
describe("action.yml — which vigiles the default runs", () => {
  it("runs the consumer's INSTALLED vigiles when the repo declares and installed it", () => {
    assert.equal(
      resolveRunner({
        "package.json": declares("^33.3.0"),
        "node_modules/.bin/vigiles": "#!/bin/sh\n",
      }),
      "--no-install vigiles lint",
    );
  });

  it("runs the LOCKED version when declared but not installed", () => {
    assert.equal(
      resolveRunner({
        "package.json": declares("^33.3.0"),
        "package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "node_modules/vigiles": { version: "33.4.1" } },
        }),
      }),
      "--yes vigiles@33.4.1 lint",
    );
  });

  it("runs the DECLARED range when there is no install and no lockfile entry", () => {
    assert.equal(
      resolveRunner({ "package.json": declares("^33.3.0") }),
      "--yes vigiles@^33.3.0 lint",
    );
  });

  it("falls back to latest only when the repo does not declare vigiles", () => {
    assert.equal(
      resolveRunner({ "package.json": JSON.stringify({ name: "consumer" }) }),
      "--yes vigiles@latest lint",
    );
    assert.equal(resolveRunner({}), "--yes vigiles@latest lint");
  });

  it("an explicit version: input still wins over the repo's own pin", () => {
    assert.equal(
      resolveRunner(
        {
          "package.json": declares("^33.3.0"),
          "node_modules/.bin/vigiles": "#!/bin/sh\n",
        },
        "26",
      ),
      "--yes vigiles@26 lint",
    );
  });
});

/**
 * `preset` reaches the CLI as `--preset=<name>` — the same switch, so the
 * experimental group is one input away in CI. The value is passed through for
 * the CLI to validate (one validator, the config's), and empty adds nothing.
 */
describe("action.yml — the preset input", () => {
  const installed = {
    "package.json": declares("^33.3.0"),
    "node_modules/.bin/vigiles": "#!/bin/sh\n",
  };
  it("is declared, defaulting to empty", () => {
    assert.equal(action.inputs["preset"]?.default, "");
  });
  it("maps to --preset=", () => {
    assert.equal(
      resolveRunner(installed, undefined, { VIGILES_PRESET: "experimental" }),
      "--no-install vigiles lint --preset=experimental",
    );
  });
  it("adds nothing when empty", () => {
    assert.equal(
      resolveRunner(installed, undefined, { VIGILES_PRESET: "" }),
      "--no-install vigiles lint",
    );
  });
});

/**
 * `command: test` (#426, #202): the harness tier through the Action. Run for
 * real against a scratch consumer repo, like the version tests above: which
 * install runs, which flags reach the CLI, and that `changed-only` narrows a
 * pull_request to its base and leaves every other event running everything.
 */
describe("action.yml — command: test", () => {
  const installed = {
    "package.json": declares("^33.3.0"),
    "node_modules/.bin/vigiles": "#!/bin/sh\n",
  };
  const test = (
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>> = {},
  ): string =>
    resolveRunner(files, undefined, { VIGILES_COMMAND: "test", ...env });

  it("declares its inputs, off by default", () => {
    assert.equal(action.inputs["changed-only"]?.default, "false");
    assert.equal(action.inputs["min"]?.default, "");
    assert.equal(action.inputs["no-skip"]?.default, "false");
    assert.equal(action.inputs["install"]?.default, "true");
    assert.equal(action.inputs["install-claude"]?.default, "true");
  });

  it("runs the repo's installed vigiles, installing only the claude CLI, with a floor of one run", () => {
    assert.deepEqual(test(installed).split("\n"), [
      "npm install -g --no-audit --no-fund @anthropic-ai/claude-code",
      "--no-install vigiles test --min=1",
    ]);
  });

  // Without `claude` every harness file skips, and `0 passed, N skipped` used to
  // be a green run in which nothing was tested.
  it("installs the claude CLI only when the runner has none", () => {
    const withClaude = {
      ...installed,
      "node_modules/.bin/claude": "#!/bin/sh\n",
    };
    assert.doesNotMatch(test(withClaude), /claude-code/);
    assert.doesNotMatch(
      test(installed, { VIGILES_INSTALL_CLAUDE: "false" }),
      /claude-code/,
    );
  });

  it("an explicit min wins over the floor of one, and lint gets neither", () => {
    assert.match(test(installed, { VIGILES_MIN: "0" }), /test --min=0$/);
    const lint = resolveRunner(installed, undefined, {
      VIGILES_COMMAND: "lint",
    });
    assert.doesNotMatch(lint, /claude-code|--min/);
  });

  it("runs npm ci first when a lockfile exists and nothing is installed", () => {
    const log = test({
      "package.json": declares("^33.3.0"),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/vigiles": { version: "33.4.1" } },
      }),
    }).split("\n");
    assert.deepEqual(log, [
      "npm ci --no-audit --no-fund",
      "--yes vigiles@33.4.1 test",
    ]);
  });

  it("install: false skips the install", () => {
    const log = test(
      {
        "package.json": declares("^33.3.0"),
        "package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
      },
      { VIGILES_INSTALL: "false" },
    );
    assert.doesNotMatch(log, /npm ci/);
  });

  it("passes paths, min and no-skip through to the CLI", () => {
    assert.equal(
      test(installed, {
        VIGILES_PATHS: "a.harness.mjs, b/*.harness.mjs",
        VIGILES_MIN: "150",
        VIGILES_NO_SKIP: "true",
      }),
      "--no-install vigiles test a.harness.mjs b/*.harness.mjs --min=150 --no-skip",
    );
  });
});

describe("action.yml — command: test, changed-only", () => {
  const installed = {
    "package.json": declares("^33.3.0"),
    "node_modules/.bin/vigiles": "#!/bin/sh\n",
  };
  const test = (
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>> = {},
  ): string =>
    resolveRunner(files, undefined, { VIGILES_COMMAND: "test", ...env });

  // The Action decides nothing: the event, the base and the fetch are the
  // CLI's (core/changed-base.ts), so changed-only is the bare flag on every event.
  for (const event of ["pull_request", "push"]) {
    it(`changed-only maps to a bare --changed on ${event}`, () => {
      assert.equal(
        test(installed, {
          VIGILES_CHANGED_ONLY: "true",
          GITHUB_EVENT_NAME: event,
        }),
        "--no-install vigiles test --changed",
      );
    });
  }

  it("refuses a command it does not accept, before running anything", () => {
    assert.throws(
      () => resolveRunner(installed, undefined, { VIGILES_COMMAND: "eval" }),
      (e: { status?: number; stdout?: Buffer }) =>
        e.status === 2 && String(e.stdout).includes("unknown command 'eval'"),
    );
  });

  it("changed-only never narrows another command", () => {
    assert.equal(
      resolveRunner(installed, undefined, {
        VIGILES_CHANGED_ONLY: "true",
        GITHUB_EVENT_NAME: "pull_request",
      }),
      "--no-install vigiles lint",
    );
  });
});
