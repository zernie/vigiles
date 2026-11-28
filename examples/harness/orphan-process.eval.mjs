/**
 * Example — ending every process an attempt started (`execution`).
 *
 * `.mjs` like every example here: it runs in plain node against the built
 * `dist/`, with no TypeScript loader.
 *
 * The task has the agent start a background writer and stop. On your machine
 * that writer outlives the attempt and is still appending while the attempt is
 * scored; in a container vigiles stops it, and checks it is gone, first. The
 * score reads that directly: `orphanAlive` is 1 when the file still grows
 * after the agent has exited, 0 when nothing is left to write it.
 *
 *   npx vigiles eval examples/harness/orphan-process.eval.mjs
 *
 * Real model → real cost. Needs Docker, `npm i -D testcontainers`, the `claude`
 * CLI + model auth, and a built dist/. External users import `defineEval` from
 * `"vigiles"`.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineEval } from "../../dist/entries/index.js";

const HEARTBEAT = "heartbeat.log";

/** The file's size in bytes, or -1 when it does not exist. */
const sizeOf = (path) => (existsSync(path) ? statSync(path).size : -1);

/** Block this thread for `ms` (`measure` is synchronous). */
const pause = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export default defineEval({
  runEval: {
    // Named, so `vigiles eval --update` writes a committed lock.
    name: "orphan-process-container",
    env: { kind: "ephemeral" }, // required with a container
    execution: { kind: "container" },
    task:
      "Run this exact command with the Bash tool, then reply DONE and stop:\n\n" +
      `nohup sh -c 'while :; do date >> ${HEARTBEAT}; sleep 0.2; done' >/dev/null 2>&1 &`,
    measure: (ctx) => {
      const file = join(ctx.cwd, HEARTBEAT);
      const before = sizeOf(file);
      pause(2000);
      return {
        started: before > 0 ? 1 : 0, // the agent did start the writer
        orphanAlive: sizeOf(file) > before ? 1 : 0, // it is still writing while scored
      };
    },
    trials: 3,
    model: "haiku",
  },
});
