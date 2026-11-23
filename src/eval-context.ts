/**
 * The per-trial context check's plumbing for `runEval` (vigiles#416): decide
 * what the trial's first request must carry, point the run at the harness's
 * request-body channel, read it after the run, and delete the bodies.
 *
 * 🔴 THE BODIES NEVER OUTLIVE THE TRIAL. They hold the whole prompt and the
 * project's code; only the {@link ContextEvidence} (file names) goes into the
 * report and the cache. The directory sits beside the trial's work dir, never in
 * it, so a cache snapshot of the work dir cannot carry it either.
 */
import {
  contextEvidence,
  expectedInstructions,
  unobservableContext,
  type ContextEvidence,
} from "./core/context-evidence.js";
import type { HarnessRuntime } from "./core/runtime.js";

/** One trial's capture: the env to add, and how to read and clean up after. */
export interface TrialContextCapture {
  /** Env the run needs for the channel; empty when nothing is read. */
  readonly env: Readonly<Record<string, string>>;
  /** Empty the channel before an attempt, so a retried run reads its own request. */
  reset(): void;
  /** The evidence for the run that just finished. */
  finish(): ContextEvidence;
  /** Delete the request bodies. Safe to call twice. */
  dispose(): void;
}

const fixed = (evidence: ContextEvidence): TrialContextCapture => ({
  env: {},
  reset: () => undefined,
  finish: () => evidence,
  dispose: () => undefined,
});

/**
 * Start the check for one trial whose world (the files written to its work
 * dir) is `world`. `enabled: false` is the spec's `experimental_contextCheck`.
 */
export function startContextCapture(opts: {
  readonly runtime: HarnessRuntime;
  readonly world: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}): TrialContextCapture {
  const capture = opts.runtime.requestCapture;
  if (capture === undefined)
    return fixed({
      kind: "unobservable",
      why: "harness-has-no-channel",
      files: [],
    });
  const expected = expectedInstructions(capture.layout, opts.world);
  if (expected.length === 0) return fixed({ kind: "nothing-expected" });
  if (!opts.enabled) return fixed(unobservableContext(expected, "opted-out"));
  const channel = capture.open();
  return {
    env: channel.env,
    reset: () => {
      channel.reset();
    },
    finish: () => contextEvidence(expected, channel.firstRequest()),
    dispose: () => {
      channel.close();
    },
  };
}
