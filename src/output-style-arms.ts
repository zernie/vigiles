/**
 * The two arms of a paid output-style eval — the style on, the style off — built
 * from the style FILE, after one free run has shown the style reaches the model.
 *
 * Three silent failures this closes. A hand-typed arm name that misses the
 * style's name loads no style and raises no error, so the "with" arm is the
 * "without" arm and the eval compares a run with itself. A bare "without" arm
 * still loads a style the user switched on for every project, which is the same
 * comparison from the other side. And the paid tier cannot check delivery at
 * all: it drives the real API, so no request is captured. The free run here
 * uses the scripted model, where requests ARE captured, with the same fixture
 * the paid arm gets — so a style that would not load stops the eval before the
 * first billed trial. That free run uses a throwaway HOME and none of the
 * caller's environment beyond the OS essentials.
 */
import { defaultAdapter } from "./adapter-registry.js";
import type { HarnessAdapter } from "./core/adapter.js";
import type { EvalArm } from "./eval.js";
import { outputStyleFixture, runHarnessTestIn } from "./harness-test.js";

/** The style on and the style off, ready for `paid_measureArms({ arms })`. */
export interface OutputStyleArms {
  /** The style file at its place in the work dir, selected in the settings. */
  readonly with: EvalArm;
  /** Every style switched off, including one the user set for all projects. */
  readonly without: EvalArm;
}

/**
 * Build the with/without arms for the style at `path` (a file in the shape the
 * harness loads, e.g. a Claude Code `.md` style), for the harness the paid tier
 * drives. Spends nothing: the one run it makes uses the scripted model. Throws,
 * before any eval, when the harness has no output styles, cannot tell the
 * style's name, or the style does not reach the model.
 *
 * @experimental One real-model run behind it; how arms are built may change
 * once a style can be authored as a compiled spec with its checks attached.
 */
export async function experimental_outputStyleArms(
  path: string,
): Promise<OutputStyleArms> {
  return outputStyleArmsWith(path, defaultAdapter);
}

/**
 * {@link experimental_outputStyleArms} on a given adapter. Not public: the paid
 * tier drives only the default harness, so arms built for another one would be
 * run by a harness they were not checked on.
 */
export async function outputStyleArmsWith(
  path: string,
  adapter: HarnessAdapter,
): Promise<OutputStyleArms> {
  // A throwaway HOME: this run happens on every import of an eval file (even
  // `vigiles eval --check`), so it must not read the machine's user config or
  // run as the session that imported it. What it proves — the style reaches the
  // model — is a fact about the fixture, not about this machine.
  const preflight = await runHarnessTestIn(
    { outputStyle: path, prompt: "hi", model: [{ text: "ok" }] },
    { adapter },
    "throwaway",
  );
  preflight.cleanup();
  const { files, settings } = outputStyleFixture(path, adapter);
  const none = adapter.layout.outputStyles?.selectNone ?? {};
  return { with: { files, settings }, without: { settings: none } };
}
