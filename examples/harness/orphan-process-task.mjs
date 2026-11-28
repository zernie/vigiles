/**
 * The task and the score shared by the two orphan-process evals (host and
 * container), so the only difference between them is `execution`.
 *
 * `.mjs` like every example here: it runs in plain node against the built
 * `dist/`, with no TypeScript loader.
 *
 * The agent starts a background writer and stops. The writer appends a line
 * every 0.2 s and exits by itself after 150 lines (~30 s), so a run that does
 * NOT end it — the host — leaves nothing running for long on the machine.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const HEARTBEAT = "heartbeat.log";

export const ORPHAN_TASK =
  "Run this exact command with the Bash tool, then reply DONE and stop:\n\n" +
  `nohup sh -c 'i=0; while [ $i -lt 150 ]; do date >> ${HEARTBEAT}; sleep 0.2; i=$((i+1)); done' >/dev/null 2>&1 &`;

/** The file's size in bytes, or -1 when it does not exist. */
const sizeOf = (path) => (existsSync(path) ? statSync(path).size : -1);

/** Block this thread for `ms` (`measure` is synchronous). */
const pause = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `started` is 1 when the agent did start the writer; `orphanAlive` is 1 when
 * the file still grows two seconds after the agent exited.
 */
export const measureOrphan = (ctx) => {
  const file = join(ctx.cwd, HEARTBEAT);
  const before = sizeOf(file);
  pause(2000);
  return {
    started: before > 0 ? 1 : 0,
    orphanAlive: sizeOf(file) > before ? 1 : 0,
  };
};
