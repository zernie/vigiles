/**
 * The machine side of scoring a regression case, against real git and real
 * processes: the carry of kept rows (bytes and exec bit only, never through a
 * link) and the scoring process (exit code, scrubbed env, fresh HOME,
 * timeout, group kill).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../core/tmp-root.js";
import type { TouchedRow } from "../core/workspace.js";
import { IDENTITY } from "./git-env.io.js";
import { carryRows, runScoring } from "./regression-case.io.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (label: string): string => {
  const dir = makeTmpDir(label);
  cleanup.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...IDENTITY },
  });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A bare git dir holding one blob; returns the dir and the blob id. */
function blobIn(text: string): {
  readonly gitDir: string;
  readonly blob: string;
} {
  const gitDir = tmp("case-base");
  git(gitDir, "init", "-q", "--bare", ".");
  const blob = execFileSync(
    "git",
    ["--git-dir", gitDir, "hash-object", "-w", "--stdin"],
    {
      input: text,
      encoding: "utf-8",
    },
  ).trim();
  return { gitDir, blob };
}

const node = (code: string): readonly string[] => [
  process.execPath,
  "-e",
  code,
];

describe("carryRows", () => {
  it("writes a file's blob with its exec bit, never through a link at the path, and applies a deletion", () => {
    const { gitDir, blob } = blobIn("fixed\n");
    const dest = tmp("case-dest");
    const outside = tmp("case-outside");
    write(outside, "victim.txt", "untouched\n");
    mkdirSync(join(dest, "src"));
    symlinkSync(join(outside, "victim.txt"), join(dest, "src/a.sh"));
    write(dest, "src/old.ts", "old\n");
    const rows: readonly TouchedRow[] = [
      {
        status: "M",
        path: "src/a.sh",
        entry: { kind: "file", mode: "100755", blob },
      },
      { status: "D", path: "src/old.ts", entry: { kind: "absent" } },
    ];
    carryRows(gitDir, rows, dest);
    // Guards: a write through a link would land outside the scoring tree.
    expect(readFileSync(join(outside, "victim.txt"), "utf-8")).toBe(
      "untouched\n",
    );
    expect(lstatSync(join(dest, "src/a.sh")).isFile()).toBe(true);
    expect(readFileSync(join(dest, "src/a.sh"), "utf-8")).toBe("fixed\n");
    expect(statSync(join(dest, "src/a.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(dest, "src/old.ts"))).toBe(false);
  });
});

describe("carryRows on other rows", () => {
  it("writes nothing for a non-file row", () => {
    const { gitDir } = blobIn("x");
    const dest = tmp("case-dest");
    carryRows(
      gitDir,
      [{ status: "A", path: "lib", entry: { kind: "symlink" } }],
      dest,
    );
    // Guards: a symlink row carries no content even if a caller passes one.
    expect(existsSync(join(dest, "lib"))).toBe(false);
  });
});

describe("carryRows through what the tree already holds", () => {
  it("refuses a row whose way into the tree goes through a link the template holds", () => {
    const { gitDir, blob } = blobIn("process.exit(0);\n");
    const dest = tmp("case-dest");
    write(dest, "test/oracle.js", "real oracle\n");
    write(dest, "test/keep.js", "kept\n");
    mkdirSync(join(dest, "src"));
    symlinkSync("../test", join(dest, "src/alias"));
    const refused = carryRows(
      gitDir,
      [
        {
          status: "A",
          path: "src/alias/oracle.js",
          entry: { kind: "file", mode: "100644", blob },
        },
        { status: "D", path: "src/alias/keep.js", entry: { kind: "absent" } },
      ],
      dest,
    );
    // Guards: a kept write under an internal link would land on the oracle and fake a pass.
    expect(readFileSync(join(dest, "test/oracle.js"), "utf-8")).toBe(
      "real oracle\n",
    );
    expect(existsSync(join(dest, "test/keep.js"))).toBe(true);
    expect(refused).toBe(2);
  });
});

describe("carryRows when the way in changes", () => {
  it("refuses a row under a file, and carries one whose link a kept row removed first", () => {
    const { gitDir, blob } = blobIn("new\n");
    const dest = tmp("case-dest");
    write(dest, "src/a", "a file\n");
    write(dest, "test/oracle.js", "real oracle\n");
    symlinkSync("../test", join(dest, "src/alias"));
    const refused = carryRows(
      gitDir,
      [
        {
          status: "A",
          path: "src/a/b.js",
          entry: { kind: "file", mode: "100644", blob },
        },
        { status: "D", path: "src/alias", entry: { kind: "absent" } },
        {
          status: "A",
          path: "src/alias/oracle.js",
          entry: { kind: "file", mode: "100644", blob },
        },
      ],
      dest,
    );
    // Guards: a file on the way is refused; a link the agent deleted is gone before the write.
    expect(refused).toBe(1);
    expect(readFileSync(join(dest, "src/a"), "utf-8")).toBe("a file\n");
    expect(lstatSync(join(dest, "src/alias")).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "test/oracle.js"), "utf-8")).toBe(
      "real oracle\n",
    );
  });
});

/**
 * Whether `pid` still runs. A killed process whose parent is gone can stay a
 * zombie under a container's PID 1 that never reaps; a zombie runs nothing.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return true;
  const text = readFileSync(stat, "utf-8");
  return (
    text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3) !== "Z"
  );
}

describe("runScoring", () => {
  it("returns the exit code, and says when a command could not start or was killed", async () => {
    const cwd = tmp("case-run");
    const at = { cwd, timeoutMs: 20_000 };
    // Guards: a passing and a failing test are told apart by the exit code alone.
    expect(await runScoring(node("process.exit(0)"), at)).toEqual({
      kind: "exited",
      code: 0,
    });
    expect(await runScoring(node("process.exit(3)"), at)).toEqual({
      kind: "exited",
      code: 3,
    });
    // Guards: a missing binary is its own kind, never an exit code a test could also return.
    expect(await runScoring(["vigiles-no-such-binary-x"], at)).toMatchObject({
      kind: "not-started",
    });
    // Guards: a process killed by a signal is not "could not start".
    expect(
      await runScoring(node('process.kill(process.pid, "SIGKILL")'), at),
    ).toEqual({ kind: "signalled", signal: "SIGKILL" });
  });

  it("runs with a fresh HOME, CI=1 and without the caller's other variables", async () => {
    const cwd = tmp("case-run");
    const out = join(cwd, "env.json");
    process.env.VIGILES_CASE_SECRET = "leak";
    try {
      await runScoring(
        node(
          `const e = process.env; require("fs").writeFileSync(${JSON.stringify(out)}, [e.HOME, e.CI, e.VIGILES_CASE_SECRET ?? "unset"].join("\\n"))`,
        ),
        { cwd, timeoutMs: 20_000 },
      );
    } finally {
      delete process.env.VIGILES_CASE_SECRET;
    }
    const [home = "", ci, secret] = readFileSync(out, "utf-8").split("\n");
    // Guards: a suite that passes only with the user's HOME or a secret in the env must not score as reproducible.
    expect(secret).toBe("unset");
    expect(ci).toBe("1");
    expect(home).not.toBe(process.env.HOME);
    // Guards: the fresh HOME is removed after the run.
    expect(existsSync(home)).toBe(false);
  });
});

describe("runScoring process groups", () => {
  it("a process past the timeout is timed out, and its whole group is killed", async () => {
    const cwd = tmp("case-run");
    const pidFile = join(cwd, "child.pid");
    const code = [
      `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const run = await runScoring(node(code), { cwd, timeoutMs: 1_500 });
    // Guards: a hung suite reads as timed out, never as an exit.
    expect(run).toEqual({ kind: "timed-out", ms: 1_500 });
    const pid = Number(readFileSync(pidFile, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));
    // Guards: a server the suite started does not outlive the scoring run.
    expect(running(pid)).toBe(false);
  });

  it("kills what a passing process left behind in its group", async () => {
    const cwd = tmp("case-run");
    const pidFile = join(cwd, "child.pid");
    const code = [
      `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });`,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "c.unref();",
    ].join("\n");
    // Guards: silent on correct — a passing run still reads exit 0.
    expect(await runScoring(node(code), { cwd, timeoutMs: 20_000 })).toEqual({
      kind: "exited",
      code: 0,
    });
    const pid = Number(readFileSync(pidFile, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));
    // Guards: a watcher left behind by a passing suite is killed with the group.
    expect(running(pid)).toBe(false);
  });
});
