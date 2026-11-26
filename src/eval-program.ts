/**
 * The program `vigiles eval` spawns for each eval file. It is the process EDGE
 * of {@link main} in `./eval-run.js`: it reads the file from `argv`, the trial
 * override from `VIGILES_TRIALS`, and exits with the code `main` answers.
 *
 * `eval-run.ts` must start nothing when it is imported — `paid_runEval` and
 * the tests import it — and an ES module has no `require.main` to tell
 * "imported" from "run as the program". So the program is this separate file.
 *
 * It is a COMPOSITION ROOT (listed in `CLI_ROOT`, eslint.config.mjs): it wires
 * the machine adapter that copies a repository, so `experimental_workspace`
 * works from an eval file the same way it does through `paid_runEval`.
 */
import { trialsOverride } from "./eval-entry.js";
import { main } from "./eval-run.js";
import { repoCopyHost } from "./host/workspace-host.io.js";

const file = process.argv.at(2);
if (file === undefined) {
  console.error(
    "vigiles: eval-entry expects one eval file. Run `vigiles eval <file>`.",
  );
  process.exit(2);
}
process.exit(
  await main(file, {
    trials: trialsOverride(process.env["VIGILES_TRIALS"]),
    host: repoCopyHost,
  }),
);
