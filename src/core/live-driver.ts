/**
 * HarnessLiveDriver — how vigiles drives THIS harness against a REAL model on
 * the user's own credentials, as `HarnessTestDriver` (`./harness-driver.js`) is
 * the same seam for the MOCK tiers.
 *
 * 🔴 IT IS WHAT `scan-behavioral.ts:buildProbe` BUILT BY SWITCHING ON A NAME.
 * That function answered four questions — which eval driver, how firing shows
 * in the trace, may the probe stub the bodies, is the runner reachable — and
 * answered all four from `harness === "codex"`. The switch is gone because each
 * adapter now brings the object; `ProbeHarness`, the hand-written
 * `"claude-code" | "codex"` union it switched on, is gone with it.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT FOUR BOOLEANS ON THE ADAPTER. A flag is a
 * legitimate capability only when it cannot disagree with the ports the adapter
 * already carries; a `skillFiring: boolean` beside an eval driver can, and a
 * `tsc` probe shows the type cannot relate them (an adapter carrying the Codex
 * eval driver and `skillFiring: true` compiles clean). That is the `subagents`
 * argument at `./adapter.ts` pointing the other way: there is a port here, so
 * the port is the thing, and the boolean would be a second copy of a fact the
 * port already holds. See `docs/design/port-redesign-names-half-2026-09-22.md`.
 */
import type { EvalDriver, Trace } from "./eval-driver.js";

/**
 * Whether a REAL model is reachable for the executing tiers, and on whose bill.
 *
 * A tagged union rather than a boolean because the CLI acts on all three arms
 * differently: it SKIPS on `none` (printing `fix`), RUNS on the other two, and
 * words the consent prompt "spends API credits" only on `metered`. A boolean
 * would have forced the wording question back onto a second predicate, which is
 * exactly the pair it replaces.
 *
 * WHAT THIS REPLACES: a per-harness name check OR-ed with one harness's env-var
 * knowledge, plus the two literal "authenticate … or set …" strings that printed
 * for every harness regardless of which one was driving.
 */
export type ModelAccess =
  | {
      readonly kind: "none";
      /** One line: what is missing, in THIS harness's words — the sentence the
       *  CLI prints instead of running. It names this harness's binary and
       *  credential, so a repo on one harness is never told to authenticate
       *  another one's CLI. */
      readonly fix: string;
    }
  /** Reachable on a plan the user already pays for: $0 metered for this run. */
  | { readonly kind: "subscription" }
  /** Reachable on a per-token key: this run bills. The consent prompt says so. */
  | { readonly kind: "metered" };

/**
 * How a skill's FIRING shows up in this harness's eval trace.
 *
 * `event` — a discrete skill-selection record in the trace, which the
 * selection-collision matrix and the adversarial gate REQUIRE: they ask "WHICH
 * skill fired", and an inference cannot answer that.
 *
 * `inferred` — no such record, so firing is deduced from something else the
 * model did (reading the skill's instruction file, say), which can be wrong in
 * BOTH directions. `caveat` is the sentence a report prints above an inferred
 * number, so a possibly-wrong figure never reads as a measurement.
 *
 * The same fact as `EvalDriver.experimental` (a public field, kept for
 * compatibility); `adapter-contract.test.ts` asserts the two agree.
 */
export type SkillFiringSignal =
  | { readonly kind: "event" }
  | { readonly kind: "inferred"; readonly caveat: string };

/**
 * The executing tiers' driver for one harness.
 *
 * 🔴 IT LIVES IN THE `harnessTesting: true` ARM, NOT BEHIND A FLAG OF ITS OWN.
 * On every implementation in this repo live-eval ⇔ mock-testable, and the
 * capability's own docblock already claims both ("deterministic harness tests +
 * evals"). A second flag equal to the first everywhere is the defect this port
 * redesign keeps removing — a fact stored twice with nothing relating the
 * copies. If a harness ever goes live WITHOUT going mockable (a closed CLI with
 * its own fixed model), split the arm then; today that shape has zero
 * implementations and splitting it now would freeze a guess into the type.
 */
export interface HarnessLiveDriver {
  /** The runner + parser that spawn the real binary and read its stream. */
  readonly evalDriver: EvalDriver;
  /**
   * See {@link ModelAccess}. Read from `env` where the harness allows it
   * (never a spent token); a binary probe where it does not. Takes the
   * environment rather than reading `process.env` so the decision is testable
   * and the adapter holds no ambient state.
   */
  access(env: Readonly<Record<string, string | undefined>>): ModelAccess;
  /** See {@link SkillFiringSignal}. */
  readonly firing: SkillFiringSignal;
  /**
   * The predicate "did `skill` fire" over one trace.
   *
   * `plugin.name` is the manifest name the DOMAIN read (some harnesses namespace
   * a plugin's skill as `<plugin>:<skill>`, others use the bare name); it is
   * HANDED IN, so this method reads no disk — the same bound `claims` and
   * `detect` keep, for the same reason.
   */
  firedFor(
    skill: string,
    plugin: { readonly name: string | null },
  ): (t: Trace) => boolean;
  /**
   * May the probe rebuild the plugin to skills-only STUBS before measuring?
   *
   * `false` means the real bodies are installed. That is a MEASURED LIMITATION,
   * not a capability: stubbing a plugin whose shape the harness did not define
   * is unvalidated, so the honest answer is to install the real skills and
   * detect firing regardless of body. Named here rather than keyed by harness
   * name in the probe, which is where it used to live.
   */
  readonly installsStubs: boolean;
}

/**
 * A live driver whose firing signal is a discrete EVENT — the only accepted
 * argument for the selection-collision matrix and the adversarial gate, which
 * cannot be computed from an inference.
 */
export type EventFiringDriver = HarnessLiveDriver & {
  readonly firing: { readonly kind: "event" };
};

/**
 * Narrows the DRIVER, which an inline `d.firing.kind === "event"` does not:
 * TypeScript narrows the discriminated PROPERTY, so the driver itself stays
 * `HarnessLiveDriver` and passing it where an {@link EventFiringDriver} is
 * wanted is still an error (measured — probe P2 in the design doc). The
 * negative arm keeps its `caveat`, which is what the n/a note prints.
 */
export function isEventFiring(d: HarnessLiveDriver): d is EventFiringDriver {
  return d.firing.kind === "event";
}
