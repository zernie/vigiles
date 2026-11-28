/**
 * Example — ending every process an attempt started
 * (`env: { kind: "docker" }`).
 *
 * `.mjs` like every example here: it runs in plain node against the built
 * `dist/`, with no TypeScript loader.
 *
 * The agent starts a background writer and stops. In a container vigiles
 * stops it, and checks it is gone, before the attempt is scored, so
 * `orphanAlive` is 0. Its twin, `orphan-process-host.eval.mjs`, runs the same
 * task on the host and scores 1: the pair shows the score can tell the two
 * apart. Task and score: `orphan-process-task.mjs`.
 *
 *   npx vigiles eval examples/harness/orphan-process.eval.mjs
 *
 * Real model → real cost. Needs Docker, `npm i -D testcontainers`, the `claude`
 * CLI + model auth, and a built dist/. External users import `defineEval` from
 * `"vigiles"`.
 */
import { defineEval } from "../../dist/entries/index.js";
import { measureOrphan, ORPHAN_TASK } from "./orphan-process-task.mjs";

export default defineEval({
  runEval: {
    // Named, so `vigiles eval --update` writes a committed lock.
    name: "orphan-process-container",
    env: { kind: "docker" }, // a throwaway HOME, in a container per attempt
    task: ORPHAN_TASK,
    measure: measureOrphan,
    trials: 3,
    model: "haiku",
  },
});
