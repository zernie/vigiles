/**
 * Example — the host twin of `orphan-process.eval.mjs`: the same task and
 * score, with `env: { kind: "local", inherit: "none" }`, so the attempt runs on your
 * machine.
 *
 * `.mjs` like every example here: it runs in plain node against the built
 * `dist/`, with no TypeScript loader.
 *
 * Here the background writer outlives the attempt and is still appending
 * while it is scored, so `orphanAlive` is 1 — the result the container run
 * prevents. The writer exits by itself after ~30 s, so nothing is left running
 * for long. Task and score: `orphan-process-task.mjs`.
 *
 *   npx vigiles eval examples/harness/orphan-process-host.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth and a built
 * dist/; no Docker. External users import `defineEval` from `"vigiles"`.
 */
import { defineEval } from "../../dist/entries/index.js";
import { measureOrphan, ORPHAN_TASK } from "./orphan-process-task.mjs";

export default defineEval({
  runEval: {
    // Named, so `vigiles eval --update` writes a committed lock.
    name: "orphan-process-host",
    env: { kind: "local", inherit: "none" }, // the container twin's HOME, on your machine
    task: ORPHAN_TASK,
    measure: measureOrphan,
    trials: 3,
    model: "haiku",
  },
});
