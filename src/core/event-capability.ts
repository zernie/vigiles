/**
 * What a hook event CARRIES and what it HONOURS — the one table three lists had
 * been disagreeing across.
 *
 * THE DEFECT THIS EXISTS FOR (measured 2026-09-16, six fixtures compiled at HEAD
 * and run through `hook-runtime run-program`): a compiled hook can name a role
 * and an event that cannot work together, and nothing says so. A prompt-gate on
 * `PreToolUse` reads an absent `prompt` as `""` and allows everything. A
 * stop-gate on `SessionStart` exits 2 into an event that ignores it. A file-gate
 * on `Stop` matches a tool on an event that carries none. `lint` and `audit`
 * found ZERO on that fixture; `tsc` caught one of six, and `vigiles compile`
 * does not run `tsc` at all.
 *
 * The facts needed to reject all of them already existed — scattered across
 * `hookEvents` (dialect), `noEffectHookEvents` (dialect),
 * `permissionDecisionHookEvents` (dialect) and `injectableEvents` (hookProtocol),
 * three of them optional, none of them relating an event to what it CARRIES. A
 * list per question cannot answer a question about the pair.
 *
 * WHY THE DIALECT AND NOT THE HOOK PROTOCOL (which is where the fourth list
 * lives, and where the original proposal put this): the dialect is REQUIRED of
 * every adapter while `hookProtocol` is optional — OpenCode has hook events and
 * no shell-hook protocol — and `scanFiles`, the browser-side engine, is handed a
 * layout and a dialect and never a protocol. Putting the table on the protocol
 * would have meant widening a public signature to carry one list to the place
 * three already are.
 *
 * WHY IT IS PARTIAL, AND WHY THAT IS THE HONEST SHAPE: Claude Code documents 31
 * hook events. We know the capabilities of nine. Filling in the other 22 would
 * be inventing facts about somebody else's product, which is the failure mode
 * `vocabulary.ts` was written to stop — so this mirrors it: a recorded capture,
 * a partial table, and a TOTAL classifier whose fourth answer is `unknown`.
 * Unknown is FAIL-OPEN by design: a check that cannot know stays silent rather
 * than accusing, because a false rejection at compile time costs more than a
 * missed one (`lint-rule-calibration`).
 */

/**
 * The channels a hook can reach the harness through. Distinct from the ROLE an
 * author writes: a role is a promise about the return type, a channel is what
 * the harness will actually do with it.
 *
 * - `veto` — a deny STOPS the thing (the tool call, the prompt, the stopping).
 * - `ask` — a decision can defer to the human instead of allow/deny.
 * - `inject` — `additionalContext` reaches the MODEL.
 * - `feedback` — a non-zero exit reaches the model as text, but stops nothing.
 * - `halt` — the whole turn can be ended (Claude Code's `continue: false`).
 */
export type HookChannel = "veto" | "ask" | "inject" | "feedback" | "halt";

/** What the event hands the hook — and therefore what a decide() can read. */
export type EventPayload = "tool" | "prompt" | "stop" | "session" | "none";

/**
 * How a deny must be SPELLED on this event. Deliberately NOT folded into
 * `honours: "ask"`, though on Claude Code both are `PreToolUse` alone and the
 * merge would look free today: "this event can ask a human" and "this event's
 * deny needs a structured field rather than an exit code" are different facts
 * about different mechanisms, and a coincidence on one harness is not a reason
 * to make them inexpressible apart on the next.
 */
export type DenyShape = "exit-code" | "permission-decision";

/** Everything the compiler needs to judge one (role, event) pair. */
export interface EventCapability {
  readonly carries: EventPayload;
  readonly honours: readonly HookChannel[];
  /** Whether a tool matcher is meaningful here (it needs `carries: "tool"`). */
  readonly matcher: boolean;
  readonly denyShape: DenyShape;
}

/**
 * A capability table for the events an adapter has actually recorded, with the
 * vendor artifact it was read from — the same shape, and the same reason, as
 * {@link HarnessVocabulary}.
 */
export interface EventCapabilityTable {
  /** e.g. `"code.claude.com/docs/en/hooks + measured on claude-code 2.1.273"`. */
  readonly capturedFrom: string;
  readonly events: Readonly<Record<string, EventCapability>>;
}

/** Total: every name gets an answer, and `unknown` is one of them. */
export type CapabilityVerdict =
  | { readonly kind: "known"; readonly event: string; readonly capability: EventCapability } // prettier-ignore
  | { readonly kind: "unknown"; readonly event: string };

/** Look one event up in a table that may not hold it. */
export function capabilityOf(
  table: EventCapabilityTable | undefined,
  event: string,
): CapabilityVerdict {
  const capability = table?.events[event];
  return capability === undefined
    ? { kind: "unknown", event }
    : { kind: "known", event, capability };
}

/**
 * Does this event honour this channel? THREE answers, never two — collapsing
 * `unknown` into `false` is how a partial table turns into a confident wrong
 * rejection, which is the bug this module is written against.
 */
export function honoursChannel(
  table: EventCapabilityTable | undefined,
  event: string,
  channel: HookChannel,
): boolean | "unknown" {
  const v = capabilityOf(table, event);
  return v.kind === "unknown" ? "unknown" : v.capability.honours.includes(channel); // prettier-ignore
}

/** The events honouring a channel — the derived form of the old flat lists. */
export function eventsHonouring(
  table: EventCapabilityTable | undefined,
  channel: HookChannel,
): readonly string[] {
  return Object.entries(table?.events ?? {})
    .filter(([, c]) => c.honours.includes(channel))
    .map(([name]) => name);
}

/**
 * The events where a BLOCK DECISION reaches nobody — neither vetoing the action
 * nor feeding the model. The derived replacement for `noEffectHookEvents`.
 *
 * 🔴 IT IS NOT `honours === []`, and getting that wrong is what the derivation
 * caught: `noEffectHookEvents` is named for "no effect" but MEANS "no effect OF
 * A BLOCK". Claude Code's `SessionStart` is in that list and honours `inject`
 * perfectly well — exit 2 is what it ignores. An `honours.length === 0` reading
 * would have dropped SessionStart from the derived list and quietly changed
 * what `hook-block-ineffective` flags.
 *
 * So the predicate is "honours neither veto nor feedback": a deny there stops
 * nothing and tells nobody, which is the property the check is about. An event
 * absent from the table is NOT reported (the old flat list could not express
 * "we have not looked"; this can).
 */
export function blockIneffectiveEvents(
  table: EventCapabilityTable | undefined,
): readonly string[] {
  return Object.entries(table?.events ?? {})
    .filter(
      ([, c]) => !c.honours.includes("veto") && !c.honours.includes("feedback"),
    )
    .map(([name]) => name);
}

/** The derived replacement for `permissionDecisionHookEvents`. */
export function permissionDecisionEvents(
  table: EventCapabilityTable | undefined,
): readonly string[] {
  return Object.entries(table?.events ?? {})
    .filter(([, c]) => c.denyShape === "permission-decision")
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// The READERS. Every consumer goes through these rather than touching a field
// directly, so the capability table is preferred where it exists and the legacy
// flat list is read in exactly ONE place per fact — here. That is what makes the
// deprecation real: the old fields still work for a third-party adapter that has
// not written a table, and nothing else in the codebase has to know that.
// ---------------------------------------------------------------------------

/** Enough of a dialect to answer the event questions, without importing one. */
export interface EventFactSource {
  readonly eventCapabilities?: EventCapabilityTable;
  /* eslint-disable @typescript-eslint/no-deprecated -- the ONE legacy read per
     fact, which is the point of routing every consumer through this module. */
  readonly noEffectHookEvents?: readonly string[];
  readonly permissionDecisionHookEvents?: readonly string[];
  /* eslint-enable @typescript-eslint/no-deprecated */
}

/** Events honouring `inject`: the table, else the protocol's legacy list. */
export function injectableEventsOf(
  source: EventFactSource | undefined,
  legacy: readonly string[] | undefined,
): readonly string[] {
  return source?.eventCapabilities
    ? eventsHonouring(source.eventCapabilities, "inject")
    : (legacy ?? []);
}

/** Events where a block reaches nobody: the table, else the legacy list. */
export function blockIneffectiveEventsOf(
  source: EventFactSource | undefined,
): readonly string[] {
  return source?.eventCapabilities
    ? blockIneffectiveEvents(source.eventCapabilities)
    : (source?.noEffectHookEvents ?? []);
}

/** Events whose deny needs the structured field: the table, else the list. */
export function permissionDecisionEventsOf(
  source: EventFactSource | undefined,
): readonly string[] {
  return source?.eventCapabilities
    ? permissionDecisionEvents(source.eventCapabilities)
    : (source?.permissionDecisionHookEvents ?? []);
}
