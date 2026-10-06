/**
 * The two arms of a paid output-style eval — the style on, the style off — built
 * from the style FILE, after one free run has shown the style reaches the model.
 *
 * Two silent failures this closes. A hand-typed arm name that misses the style's
 * name loads no style and raises no error, so the "with" arm is the "without"
 * arm and the eval compares a run with itself. And the paid tier cannot check
 * delivery at all: it drives the real API, so no request is captured. The free
 * run here uses the scripted model, where requests ARE captured, with the same
 * fixture the paid arm gets — so a style that would not load stops the eval
 * before the first billed trial.
 */
import { defaultAdapter } from "./adapter-registry.js";
import type { HarnessAdapter } from "./core/adapter.js";
import type { EvalArm } from "./eval.js";
import { outputStyleFixture, runHarnessTest } from "./harness-test.js";

/** The style on and the style off, ready for `paid_measureArms({ arms })`. */
export interface OutputStyleArms {
  /** The style file at its place in the work dir, selected in the settings. */
  readonly with: EvalArm;
  /** Nothing added: the harness's own default. */
  readonly without: EvalArm;
}

/**
 * Build the with/without arms for the style at `path` (a file in the shape the
 * harness loads, e.g. a Claude Code `.md` style). Spends nothing: the one run it
 * makes uses the scripted model. Throws, before any eval, when the harness has
 * no output styles, cannot tell the style's name, or the style does not reach
 * the model.
 *
 * @experimental One real-model run behind it; how arms are built may change
 * once a style can be authored as a compiled spec with its checks attached.
 */
export async function experimental_outputStyleArms(
  path: string,
  opts: { readonly adapter?: HarnessAdapter } = {},
): Promise<OutputStyleArms> {
  const adapter = opts.adapter ?? defaultAdapter;
  // The fixture is the style file alone: no hook or script runs, so there is
  // nothing to confine.
  const preflight = await runHarnessTest(
    {
      outputStyle: path,
      prompt: "hi",
      model: [{ text: "ok" }],
      sandbox: false,
    },
    { adapter },
  );
  preflight.cleanup();
  const { files, settings } = outputStyleFixture(path, adapter);
  return { with: { files, settings }, without: {} };
}
