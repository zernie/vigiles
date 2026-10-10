/**
 * The stub binaries as processes: what a caller of `gh` actually gets back, what
 * the log records, and — the measured hazard — that a stub never blocks on an
 * open stdin.
 *
 * The argv shapes are the ones a real model and a real status script used (see
 * `core/stub-rules.test.ts` for the matching itself). These tests spawn the
 * BUILT CLI (`dist/cli.js hook-runtime stub`), because the shim a run puts on
 * PATH execs it; `npm run coverage` builds first.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  ARGV_REST,
  UNANSWERED_EXIT_CODE,
  encodeStub,
  runStub,
  unsupportedLine,
  type StubIo,
  type ToolStub,
} from "./core/stub-rules.js";
import {
  readStubCalls,
  removeStubDir,
  stubShim,
  writeStubDir as writeStubDirWith,
} from "./tool-stub.js";

const LAUNCHER = { node: process.execPath, cli: resolve("dist", "cli.js") };
const writeStubDir = (stubs: readonly ToolStub[]) =>
  writeStubDirWith(stubs, LAUNCHER);

const ISSUE_URL = "https://github.com/o/r/issues/9001\n";
const GH: ToolStub = {
  name: "gh",
  rules: [
    {
      argv: ["issue", "create", ARGV_REST],
      contains: ["o/r"],
      reply: { kind: "always", stdout: ISSUE_URL },
    },
    {
      argv: ["api", /^repos\/o\/r\/(?:issues|pulls)\?/],
      reply: { kind: "always", stdout: "[]" },
    },
  ],
};
const CREATE = [
  "issue",
  "create",
  "--repo",
  "o/r",
  "--title",
  "init in a Yarn PnP repo links into node_modules that never exists",
  "--body",
  "`vigiles init` creates links into `node_modules`; \"$HOME\" 'quoted'.\n\nNoted for later.",
];
const READ = ["api", "repos/o/r/issues?state=open&per_page=100"];

const run = (bin: string, argv: readonly string[]) =>
  spawnSync(join(bin, "gh"), [...argv], { encoding: "utf-8" });

test("the stub answers per invocation: an issue URL for the create, [] for the read, a neutral miss for a probe", () => {
  const dir = writeStubDir([GH]);
  try {
    const file = join(dir.binDir, "gh");
    assert.ok((statSync(file).mode & 0o111) !== 0, "stub is executable");

    const created = run(dir.binDir, CREATE);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout, ISSUE_URL);

    const read = run(dir.binDir, READ);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, "[]");
    assert.deepEqual(JSON.parse(read.stdout), []);

    const probe = run(dir.binDir, ["auth", "status"]);
    assert.equal(probe.status, UNANSWERED_EXIT_CODE);
    assert.equal(probe.stdout, "");
    // What the MODEL reads: one fixed line, no instruction, no argv echo.
    assert.equal(probe.stderr, unsupportedLine("gh"));
    assert.doesNotMatch(probe.stderr, /rule|test|add|auth/);

    assert.deepEqual(readStubCalls(dir), [
      {
        tool: "gh",
        argv: CREATE,
        outcome: { kind: "answered", rule: 0, answer: 0 },
      },
      {
        tool: "gh",
        argv: READ,
        outcome: { kind: "answered", rule: 1, answer: 0 },
      },
      { tool: "gh", argv: ["auth", "status"], outcome: { kind: "no-rule" } },
    ]);
  } finally {
    removeStubDir(dir);
  }
});

test("the stub lives BESIDE the work dir: its own temp root, and removal leaves nothing", () => {
  const dir = writeStubDir([GH]);
  const root = dir.root;
  assert.equal(dirname(dir.binDir), root);
  assert.doesNotMatch(root, /\.vigiles-stubs/);
  removeStubDir(dir);
  assert.equal(existsSync(root), false);
});

test("inOrder holds across processes: answer 1, answer 2, then unanswered", () => {
  const dir = writeStubDir([
    {
      name: "git",
      rules: [
        {
          argv: ["push", ARGV_REST],
          reply: {
            kind: "inOrder",
            answers: [
              {
                stderr: "! [rejected] main -> main (fetch first)\n",
                exitCode: 1,
              },
              { stdout: "To o/r.git\n" },
            ],
          },
        },
      ],
    },
  ]);
  try {
    const git = (argv: string[]) =>
      spawnSync(join(dir.binDir, "git"), argv, { encoding: "utf-8" });
    const first = git(["push", "origin", "main"]);
    assert.equal(first.status, 1);
    assert.equal(first.stderr, "! [rejected] main -> main (fetch first)\n");
    const second = git(["push"]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, "To o/r.git\n");
    const third = git(["push"]);
    assert.equal(third.status, UNANSWERED_EXIT_CODE);
    assert.deepEqual(
      readStubCalls(dir).map((c) => c.outcome.kind),
      ["answered", "answered", "exhausted"],
    );
  } finally {
    removeStubDir(dir);
  }
});

test("a caller that leaves stdin OPEN (Node execFile) gets its answer at once — the stub never reads stdin", async () => {
  // Measured: `execFile("cat", [], { timeout: 3000 })` is killed after 3 s, because
  // execFile gives the child a pipe and never closes it. A status script calls
  // `gh api <endpoint>` exactly that way; a stub that drained stdin would hang every
  // such call until the caller's timeout and report it as a failure.
  const dir = writeStubDir([GH]);
  try {
    const started = Date.now();
    const result = await new Promise<{
      killed: boolean;
      stdout: string;
      failed: boolean;
    }>((done) => {
      const child = execFile(
        join(dir.binDir, "gh"),
        READ,
        { timeout: 4000, encoding: "utf8" },
        (error, stdout) => {
          done({ killed: child.killed, stdout, failed: error !== null });
        },
      );
    });
    assert.equal(
      result.killed,
      false,
      "the stub blocked on stdin and was killed",
    );
    assert.equal(result.failed, false);
    assert.equal(result.stdout, "[]");
    assert.ok(Date.now() - started < 3000, "answered well before the timeout");
  } finally {
    removeStubDir(dir);
  }
});

test("two stubs side by side keep their own rules and share one call log", () => {
  const dir = writeStubDir([
    GH,
    {
      name: "curl",
      rules: [
        {
          argv: ["-s", ARGV_REST],
          reply: { kind: "always", stdout: "{}" },
        },
      ],
    },
  ]);
  try {
    assert.equal(run(dir.binDir, READ).stdout, "[]");
    const curl = spawnSync(join(dir.binDir, "curl"), ["-s", "https://x"], {
      encoding: "utf-8",
    });
    assert.equal(curl.stdout, "{}");
    assert.deepEqual(
      readStubCalls(dir).map((c) => c.tool),
      ["gh", "curl"],
    );
  } finally {
    removeStubDir(dir);
  }
});

test("readStubCalls on a stub nobody called is empty, not an error", () => {
  const dir = writeStubDir([GH]);
  try {
    assert.deepEqual(readStubCalls(dir), []);
  } finally {
    removeStubDir(dir);
  }
});

test("the shim quotes every path so a quote or space cannot break out of it", () => {
  const shim = stubShim(
    { node: "/opt/my node/bin/node", cli: "/x/it's/cli.js" },
    "/tmp/r",
    "gh",
  );
  assert.equal(
    shim,
    `#!/bin/sh\nexec '/opt/my node/bin/node' '/x/it'\\''s/cli.js' 'hook-runtime' 'stub' '/tmp/r' 'gh' "$@"\n`,
  );
});

// --- the runtime's decision, in-process (what the spawned process runs) -------

/** An in-memory filesystem for the runtime: rules files plus the log. */
function memIo(init: Readonly<Record<string, string>>): StubIo & {
  readonly files: Record<string, string>;
} {
  const files: Record<string, string> = { ...init };
  return {
    files,
    readFile: (p) => files[p] ?? null,
    appendFile: (p, s) => {
      files[p] = (files[p] ?? "") + s;
    },
  };
}

test("runStub: decides from the rules file and the log so far, appends one line per call", () => {
  const io = memIo({ "/s/rules/gh.json": encodeStub(GH) });
  assert.deepEqual(runStub("/s", "gh", READ, io), {
    stdout: "[]",
    stderr: "",
    exitCode: 0,
  });
  assert.deepEqual(runStub("/s", "gh", ["--version"], io), {
    stdout: "",
    stderr: unsupportedLine("gh"),
    exitCode: UNANSWERED_EXIT_CODE,
  });
  assert.equal(io.files["/s/calls.jsonl"]?.trimEnd().split("\n").length, 2);
});

test("runStub: a missing rules file is an internal error said to the author, never a silent answer", () => {
  const io = memIo({});
  const r = runStub("/s", "gh", READ, io);
  assert.equal(r.exitCode, UNANSWERED_EXIT_CODE);
  assert.match(r.stderr, /vigiles stub: no rules file for gh/);
  assert.equal(io.files["/s/calls.jsonl"], undefined);
});
