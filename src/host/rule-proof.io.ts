/**
 * The host adapter for rule-proof: the machine's files and processes, behind
 * core's {@link RuleProofHost} port. Effects only — it knows no linter and
 * wires nothing; `src/entries/rule-proof.ts` does that. Not a harness: the
 * linters it runs belong to the repository being measured, not to an agent.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { globSync } from "glob";
import type { RuleProofHost } from "../core/rule-proof/port.js";
import type { ExecResult } from "../core/rule-proof/types.js";

/** `spawnSync`, its outcomes as {@link ExecResult}. */
const exec: RuleProofHost["exec"] = (command, args, options): ExecResult => {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error !== undefined)
    return /ETIMEDOUT/.test(res.error.message)
      ? { kind: "timeout" }
      : { kind: "spawn-error", message: res.error.message };
  if (res.status === null)
    return { kind: "killed", signal: String(res.signal) };
  return {
    kind: "exited",
    code: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
};

/** The machine, as the port asks for it. */
export const nodeHost: RuleProofHost = {
  exec,
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists: existsSync,
  list: (dir) => readdirSync(dir),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  files: (dir, patterns) =>
    globSync([...patterns], {
      cwd: dir,
      dot: true,
      nodir: true,
      posix: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    }),
};
