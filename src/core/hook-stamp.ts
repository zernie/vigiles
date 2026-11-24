/**
 * A compiled hook's STAMP — whether its source still matches what `compile`
 * stamped, and what the runtime does when it does not. One home for both
 * questions, so the runtime, `lint` and `audit` cannot disagree on what "stale"
 * means (`one-detector-no-drift`).
 *
 * THE INCIDENT THIS SHAPE EXISTS FOR (2026-11): a user edited the source of an
 * `inject` hook wired on `UserPromptSubmit` and did not recompile. The runtime
 * found the stamp stale and exited 2 — on EVERY prompt. A prompt is not a tool
 * call, so the agent could not repair anything in that loop, and the human
 * could not type their way out: each prompt was blocked before it was read.
 * CI stayed green, because nothing in `lint` compared a hook to its stamp.
 *
 * So the response to a stale stamp is now a decision over two facts, made in
 * ONE pure function ({@link staleStampResponse}):
 *
 * 1. the hook's declared ROLE — only a TOOL gate (`bash-gate`, `file-gate`)
 *    exists to block, and only a tool call can be answered with a repair (a
 *    file write to the hook or its sidecar) in the same loop;
 * 2. the live EVENT — even a tool gate refuses only where a deny actually
 *    vetoes a tool call.
 *
 * Everything else is warned about loudly and SKIPPED: the unverified body does
 * not run, and the session goes on.
 *
 * No `node:crypto` here: the hasher is handed in, so this module stays
 * importable by the browser-safe scan engine and costs the runtime nothing.
 */
import type { CapabilityVerdict } from "./event-capability.js";
import type { DispatchKind } from "./hook-program.js";
import { HOOKS_DIR } from "./hook-paths.js";

/**
 * What a hook's stamp sidecar says about its source. Five answers, because
 * "not stale" has three different reasons and only one of them is "checked and
 * fine" (`make-the-distinction-a-type`).
 */
export type StampCheck =
  /** No sidecar: never compiled, or a fixture — it runs unstamped. */
  | { readonly kind: "no-sidecar" }
  /** A sidecar without a `stamp` — the documented manual clear (`{}`). */
  | { readonly kind: "cleared" }
  /** The sidecar is not JSON, or the source cannot be read: nothing to compare. */
  | { readonly kind: "unreadable"; readonly what: "sidecar" | "source" }
  | { readonly kind: "matches" }
  /** The source changed after `compile` stamped it. */
  | { readonly kind: "stale"; readonly stamp: string };

/** `stamp` out of a sidecar's text; `undefined` when there is none, `null` when the text is not JSON. */
function stampField(text: string): string | undefined | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || !("stamp" in parsed))
      return undefined;
    const { stamp } = parsed;
    return typeof stamp === "string" && stamp !== "" ? stamp : undefined;
  } catch {
    return null;
  }
}

/**
 * Compare a hook source with its sidecar. `undefined` text = the file is
 * absent. `stampOf` is the compile-time hasher (`stampHook`), injected.
 */
export function checkHookStamp(
  sidecarText: string | undefined,
  sourceText: string | undefined,
  stampOf: (source: string) => string,
): StampCheck {
  if (sidecarText === undefined) return { kind: "no-sidecar" };
  const stamp = stampField(sidecarText);
  if (stamp === null) return { kind: "unreadable", what: "sidecar" };
  if (stamp === undefined) return { kind: "cleared" };
  if (sourceText === undefined) return { kind: "unreadable", what: "source" };
  return stampOf(sourceText) === stamp
    ? { kind: "matches" }
    : { kind: "stale", stamp };
}

/**
 * What the runtime does with a hook whose stamp is stale.
 *
 * - `refuse` — exit 2, the existing fail-closed path (with its repair escape):
 *   blocking IS this hook's job and the agent can repair it in the same loop.
 * - `skip` — one loud stderr warning naming the fix, the body NOT run, exit 0.
 *   `reason` says which of the two facts ruled the refusal out.
 */
export type StaleStampResponse =
  | { readonly kind: "refuse" }
  | {
      readonly kind: "skip";
      /**
       * `not-a-tool-gate` — the role never blocks a tool call (an inject, a
       * react, or a gate over a prompt or a stop, where no tool write can
       * repair it in the same loop); `event-cannot-veto` — a tool gate firing
       * on an event whose deny stops no tool call.
       */
      readonly reason: "not-a-tool-gate" | "event-cannot-veto";
    };

/** The live event, as much as the runtime knows about it. */
export interface StaleStampEvent {
  /** The event's capability on the active harness (`unknown` when unrecorded). */
  readonly capability: CapabilityVerdict;
  /** Whether the payload itself carries a tool call (`tool_name`). */
  readonly carriesToolCall: boolean;
}

/**
 * Role first, event second. An event the harness has not recorded falls back
 * to the payload: a tool gate keeps refusing on an unrecorded event only when
 * that event carries a tool call — the closest the runtime can come to "the
 * agent can answer this with a write" without inventing a capability.
 */
export function staleStampResponse(
  role: DispatchKind,
  event: StaleStampEvent,
): StaleStampResponse {
  switch (role) {
    case "inject":
    case "react":
    case "prompt-gate":
    case "stop-gate":
      return { kind: "skip", reason: "not-a-tool-gate" };
    case "bash-gate":
    case "file-gate":
      return vetoesToolCall(event)
        ? { kind: "refuse" }
        : { kind: "skip", reason: "event-cannot-veto" };
  }
}

function vetoesToolCall(event: StaleStampEvent): boolean {
  const { capability } = event;
  if (capability.kind === "unknown") return event.carriesToolCall;
  return (
    capability.capability.carries === "tool" &&
    capability.capability.honours.includes("veto")
  );
}

/** The one command that repairs a stale stamp — shared by every message. */
export function stampFixCommand(hookFile: string): string {
  return `vigiles compile ${hookFile}`;
}

/** A hook source whose stamp no longer matches it — the scan's finding. */
export interface StaleHookStamp {
  /** The sidecar, repo-relative (`.vigiles/hooks/<name>.json`). */
  readonly sidecar: string;
  /** The hook source the sidecar stamps, as `compile` recorded it. */
  readonly source: string;
}

/** The source a sidecar names: its `file`, else the hook beside it in `.vigiles/hooks/`. */
function sourceOf(sidecarRef: string, sidecarText: string): string {
  try {
    const parsed: unknown = JSON.parse(sidecarText);
    if (parsed !== null && typeof parsed === "object" && "file" in parsed) {
      const { file } = parsed;
      if (typeof file === "string" && file !== "") return file;
    }
  } catch {
    /* not JSON: `checkHookStamp` reports it unreadable; the name is only a fallback */
  }
  return sidecarRef.replace(/\.json$/, "");
}

/**
 * Every stamp sidecar under `.vigiles/hooks/` whose hook source no longer
 * matches it. `sidecarRefs` are repo-relative; `readText` is the engine's file
 * port (`undefined` = absent). A source that cannot be read is NOT reported
 * here — a missing file a compiled hook needs is `hook-script-exists`' finding.
 */
export function staleHookStamps(
  sidecarRefs: readonly string[],
  readText: (ref: string) => string | undefined,
  stampOf: (source: string) => string,
): readonly StaleHookStamp[] {
  return sidecarRefs
    .filter((ref) => ref.startsWith(`${HOOKS_DIR}/`) && ref.endsWith(".json"))
    .flatMap((sidecar) => {
      const text = readText(sidecar);
      if (text === undefined) return [];
      const source = sourceOf(sidecar, text);
      const check = checkHookStamp(text, readText(source), stampOf);
      return check.kind === "stale" ? [{ sidecar, source }] : [];
    });
}
