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
import { execFileSync, spawnSync } from "node:child_process";
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
        // These tests read the MAIN command's argv; the audit summary (#474)
        // is its own npx call with its own suite below.
        VIGILES_AUDIT_SUMMARY: "false",
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

  it("runs npm ci first when a lockfile exists and nothing is installed", () => {
    const log = test({
      "package.json": declares("^33.3.0"),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/vigiles": { version: "33.4.1" } },
      }),
    }).split("\n");
    // dependencies first, then the agent CLI, then the run with its floor
    assert.equal(log.length, 3);
    assert.equal(log[0], "npm ci --no-audit --no-fund");
    assert.ok(log[1]?.startsWith(GLOBAL_INSTALL), log[1]);
    assert.equal(log[2], "--yes vigiles@33.4.1 test --min=1");
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
        VIGILES_INSTALL_CLAUDE: "false",
      }),
      "--no-install vigiles test a.harness.mjs b/*.harness.mjs --min=150 --no-skip",
    );
  });
});

/** The Action installs the agent CLI globally; the package is the Action's business. */
const GLOBAL_INSTALL = "npm install -g ";
const installsCli = (log: string): boolean =>
  log.split("\n").some((l) => l.startsWith(GLOBAL_INSTALL));

// Without the `claude` binary every harness file skips, and `0 passed, N skipped`
// used to be a green run in which nothing was tested.
describe("action.yml — command: test installs the agent CLI and floors at one run", () => {
  const installed = {
    "package.json": declares("^33.3.0"),
    "node_modules/.bin/vigiles": "#!/bin/sh\n",
  };
  const test = (
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>> = {},
  ): string =>
    resolveRunner(files, undefined, { VIGILES_COMMAND: "test", ...env });

  it("installs the CLI, then runs with a floor of one run", () => {
    const log = test(installed).split("\n");
    assert.equal(log.length, 2);
    assert.ok(log[0]?.startsWith(GLOBAL_INSTALL), log[0]);
    assert.equal(log[1], "--no-install vigiles test --min=1");
  });

  it("installs the CLI only when the runner has none", () => {
    const withCli = { ...installed, "node_modules/.bin/claude": "#!/bin/sh\n" };
    assert.equal(installsCli(test(withCli)), false);
    assert.equal(
      installsCli(test(installed, { VIGILES_INSTALL_CLAUDE: "false" })),
      false,
    );
  });

  // Codex on #477: `version: local` runs `node` directly, so a copy only in
  // node_modules/.bin was "found" but invisible to the harness files' lookup.
  it("puts a repo-local CLI on PATH for the run, whatever runs vigiles", () => {
    // `version: local` runs `node <action>/dist/cli.js`; this stand-in records
    // whether the harness files would find `claude` on PATH.
    const probe =
      'const { spawnSync } = require("node:child_process");\n' +
      'const found = spawnSync("sh", ["-c", "command -v claude"]).status === 0;\n' +
      'require("node:fs").appendFileSync(process.env.NPX_LOG, `on-path=${found}\\n`);\n';
    const log = resolveRunner(
      {
        ...installed,
        "node_modules/.bin/claude": "#!/bin/sh\n",
        "dist/cli.js": probe,
      },
      "local",
      { VIGILES_COMMAND: "test", VIGILES_ACTION_PATH: "." },
    );
    assert.equal(installsCli(log), false);
    assert.match(log, /on-path=true/);
  });

  it("an explicit min wins over the floor of one, and lint gets neither", () => {
    assert.match(test(installed, { VIGILES_MIN: "0" }), /test --min=0$/);
    const lint = resolveRunner(installed, undefined, {
      VIGILES_COMMAND: "lint",
    });
    assert.equal(installsCli(lint), false);
    assert.doesNotMatch(lint, /--min/);
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
          VIGILES_INSTALL_CLAUDE: "false",
        }),
        "--no-install vigiles test --min=1 --changed",
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

/** An `npx` that logs its argv and answers by flag (see the suite below). */
function writeStubNpx(bin: string): void {
  writeFileSync(
    join(bin, "npx"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$*" >> "$NPX_LOG"',
      // Where each call ran, and whether that folder is the PR base's copy (the
      // base commit carries `base-only.txt`; the head deletes it).
      '[[ -n "${NPX_WHERE_LOG:-}" ]] && printf "%s|%s|%s\\n" "$([[ -e base-only.txt ]] && echo base || echo head)" "$([[ -e dist/built.js ]] && echo built || echo unbuilt)" "$*" >> "$NPX_WHERE_LOG"',
      'case " $* " in',
      '  *" --md "*) printf "%s" "${STUB_MD:-}"; exit "${STUB_MD_EXIT:-0}" ;;',
      '  *" --json"*) printf "{}"; exit 0 ;;',
      "esac",
      '[[ -n "${STUB_MAIN_BYTES:-}" ]] && head -c "$STUB_MAIN_BYTES" /dev/zero | tr "\\0" x',
      'exit "${STUB_MAIN_EXIT:-0}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** A consumer repo that declares and installed vigiles. */
function writeInstalledConsumer(repo: string): void {
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "c", devDependencies: { vigiles: "^40" } }),
  );
  mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules", ".bin", "vigiles"), "", {
    mode: 0o755,
  });
}

const MARKER = "<!-- vigiles-audit-summary -->";
const SECTION = `${MARKER}\n### Audit: **B** · 85/100\n`;

interface StepRun {
  readonly status: number;
  readonly log: string;
  readonly summary: string;
  readonly output: string;
}

function runStep(
  env: Readonly<Record<string, string>>,
  prepare: (
    repo: string,
    root: string,
  ) => Readonly<Record<string, string>> = () => ({}),
): StepRun {
  const root = mkdtempSync(join(tmpdir(), "vigiles-action-summary-"));
  try {
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    symlinkSync(process.execPath, join(bin, "node"));
    writeStubNpx(bin);
    writeInstalledConsumer(repo);
    const prepared = prepare(repo, root);
    writeFileSync(join(root, "step.sh"), script);
    const summary = join(root, "summary.md");
    const output = join(root, "out");
    writeFileSync(summary, "");
    writeFileSync(output, "");
    const ran = spawnSync("bash", [join(root, "step.sh")], {
      cwd: repo,
      stdio: "pipe",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        NPX_LOG: join(root, "npx.log"),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        VIGILES_COMMAND: "lint",
        VIGILES_COMMANDS:
          action.runs.steps?.[0]?.env?.["VIGILES_COMMANDS"] ?? "",
        VIGILES_VERSION: "",
        VIGILES_ACTION_PATH: root,
        VIGILES_AUDIT_SUMMARY: "true",
        STUB_MD: SECTION,
        ...env,
        ...prepared,
      },
    });
    return {
      status: ran.status ?? 1,
      log: readFileSync(join(root, "npx.log"), "utf-8"),
      summary: readFileSync(summary, "utf-8"),
      output: readFileSync(output, "utf-8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const auditCalls = (log: string): string[] =>
  log.split("\n").filter((l) => l.includes(" audit "));

/**
 * The audit summary in the sticky comment and the job summary (#474), by
 * RUNNING the step. `npx` is a stub that logs its argv and answers by flag:
 * `--md` prints `$STUB_MD` and exits `$STUB_MD_EXIT`, `--json` prints a base
 * report, anything else (the main command) exits `$STUB_MAIN_EXIT`.
 *
 * The property held: the section is default-on, one input turns it off, and
 * NOTHING about it can change the job's result — an audit that errors, or an
 * older vigiles that prints terminal text for `--md`, leaves a one-line note.
 */
describe("action.yml — the audit summary", () => {
  it("is declared, defaulting to on", () => {
    assert.equal(action.inputs["audit-summary"]?.default, "true");
    assert.ok(
      raw.includes("VIGILES_AUDIT_SUMMARY: ${{ inputs.audit-summary }}"),
    );
  });

  it("on: runs `audit . --md` and puts its section in the job summary", () => {
    const r = runStep({});
    assert.equal(r.status, 0);
    assert.deepEqual(auditCalls(r.log), ["--no-install vigiles audit . --md"]);
    assert.ok(r.summary.includes(SECTION), r.summary);
  });

  it("off: runs no audit and adds no section", () => {
    const r = runStep({ VIGILES_AUDIT_SUMMARY: "false" });
    assert.equal(r.status, 0);
    assert.deepEqual(auditCalls(r.log), []);
    assert.ok(!r.summary.includes(MARKER));
  });

  it("an audit that errors leaves a one-line note and a passing job", () => {
    const r = runStep({ STUB_MD: "", STUB_MD_EXIT: "2" });
    assert.equal(r.status, 0);
    assert.match(r.output, /valid=true/);
    assert.ok(!r.summary.includes(MARKER));
    const note = r.summary.split("\n").filter((l) => /audit summary/i.test(l));
    assert.equal(note.length, 1, r.summary);
  });

  it("an older vigiles printing terminal text for --md is not pasted in", () => {
    const r = runStep({ STUB_MD: "Detected harness: x\nrings…\n" });
    assert.equal(r.status, 0);
    assert.ok(!r.summary.includes("Detected harness"), r.summary);
    assert.match(r.summary, /audit summary/i);
  });

  // Codex on #480: GitHub refuses a comment over 65,536 characters. The audit
  // section and up to 60 KB of log used to be added up with no shared budget, so
  // a big repo's sticky comment stopped updating and showed a stale result.
  it("keeps the whole comment under GitHub's limit, and keeps the result and grade", () => {
    const big = `${SECTION}${"- finding\n".repeat(4000)}`;
    const r = runStep({ STUB_MD: big, STUB_MAIN_BYTES: "70000" });
    assert.equal(r.status, 0);
    assert.ok(r.summary.length < 65536, String(r.summary.length));
    assert.ok(r.summary.includes("passed"), "the result line");
    assert.ok(r.summary.includes(SECTION), "the grade");
  });

  it("never turns a failing command green, nor a passing one red", () => {
    const failed = runStep({ STUB_MAIN_EXIT: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.output, /valid=false/);
    assert.ok(failed.summary.includes(SECTION));
  });
});

/**
 * A `prepare` for {@link runStep}: apply `toBase`, commit the repo as the PR
 * base, apply `toHead` as the PR's change, and point the event payload at the
 * base sha.
 */
function prBase(
  toHead: (repo: string) => void,
  toBase: (repo: string) => void = () => undefined,
): (repo: string, root: string) => Readonly<Record<string, string>> {
  return (repo, root) => {
    toBase(repo);
    const git = (...a: string[]): void => {
      execFileSync("git", a, {
        cwd: repo,
        stdio: "pipe",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    };
    git("init", "-q");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    toHead(repo);
    writeFileSync(
      join(root, "event.json"),
      JSON.stringify({ pull_request: { number: 7, base: { sha } } }),
    );
    return { GITHUB_EVENT_PATH: join(root, "event.json") };
  };
}

describe("action.yml — the audit summary on a pull request", () => {
  it("audits the base and passes it as --compare=", () => {
    const r = runStep(
      { GITHUB_EVENT_NAME: "pull_request" },
      prBase((repo) => {
        writeFileSync(join(repo, "CLAUDE.md"), "# head\n");
      }),
    );
    assert.equal(r.status, 0);
    const calls = auditCalls(r.log);
    assert.equal(calls.length, 2, r.log);
    assert.match(calls[0] ?? "", /audit \S+ --json$/);
    assert.match(calls[1] ?? "", /audit \. --md --compare=\S+$/);
  });

  // Codex on #480: the base audit must read the BASE's config. Run from the
  // head checkout, the head's `.vigilesrc.json#exclude` is rooted at the head,
  // never matches the base copy's paths, and an excluded skill counts in the
  // base only — a fake score change on an unchanged harness.
  it("audits the base from inside the base copy, so its own config applies", () => {
    const where = join(mkdtempSync(join(tmpdir(), "vigiles-where-")), "log");
    writeFileSync(where, "");
    const r = runStep(
      { GITHUB_EVENT_NAME: "pull_request", NPX_WHERE_LOG: where },
      // The base commit carries `base-only.txt`; the head deletes it.
      prBase(
        (head) => {
          rmSync(join(head, "base-only.txt"));
        },
        (base) => {
          writeFileSync(join(base, "base-only.txt"), "");
        },
      ),
    );
    const calls = readFileSync(where, "utf-8").split("\n");
    rmSync(dirname(where), { recursive: true, force: true });
    assert.equal(r.status, 0);
    const base = calls.filter((l) => l.includes(" --json"));
    assert.equal(base.length, 1, calls.join("\n"));
    assert.match(base[0] ?? "", /^base\|[a-z]+\|.* audit \. --json$/);
    const head = calls.filter((l) => l.includes(" --md"));
    assert.match(head[0] ?? "", /^head\|/);
  });

  // Found dogfooding #480: the Action's comment on its own PR read "base D → B,
  // Truthfulness 85 → 100" for a PR that touched no hook. The base copy (`git
  // archive`) had no `dist/`, so a hook running `dist/cli.js` was "missing" in the
  // base only. What the checkout has but git ignores (installed deps, build
  // output) is the environment, not the PR: both sides must see it.
  it("gives the base copy the checkout's git-ignored files, so only tracked content differs", () => {
    const where = join(mkdtempSync(join(tmpdir(), "vigiles-where-")), "log");
    writeFileSync(where, "");
    const r = runStep(
      { GITHUB_EVENT_NAME: "pull_request", NPX_WHERE_LOG: where },
      prBase(
        (head) => {
          mkdirSync(join(head, "dist"));
          writeFileSync(join(head, "dist", "built.js"), "");
        },
        (base) => {
          writeFileSync(join(base, ".gitignore"), "dist/\n");
        },
      ),
    );
    const calls = readFileSync(where, "utf-8").split("\n");
    rmSync(dirname(where), { recursive: true, force: true });
    assert.equal(r.status, 0);
    const base = calls.filter((l) => l.includes(" --json"));
    assert.equal(base.length, 1, calls.join("\n"));
    assert.match(base[0] ?? "", /^[a-z]+\|built\|/);
  });

  it("on a pull request with no base to read, still compares, so the CLI says why", () => {
    const r = runStep({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: "/dev/null",
    });
    assert.equal(r.status, 0);
    const calls = auditCalls(r.log);
    assert.equal(calls.length, 1, r.log);
    assert.match(calls[0] ?? "", /audit \. --md --compare=\S+$/);
  });
});
