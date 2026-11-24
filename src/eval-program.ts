/**
 * The program `vigiles eval` spawns for each eval file: it runs
 * {@link main} from `./eval-entry.js` and nothing else.
 *
 * `eval-entry.ts` must start nothing when it is imported — `cli-main.ts` and
 * the tests import it — and an ES module has no `require.main` to tell
 * "imported" from "run as the program". So the program is this separate file.
 */
import { main } from "./eval-entry.js";

void main();
