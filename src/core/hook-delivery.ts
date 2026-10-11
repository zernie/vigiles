/**
 * Did a hook's TEXT reach the model? — the observed-output twin of
 * `noticeDelivery` (which answers the same question for a compiled react
 * BEFORE anything runs).
 *
 * 🔴 THE DEFECT THIS EXISTS FOR, MEASURED 2026-10-11 IN A DOWNSTREAM REPO. Its
 * main knowledge-base linter ran as a `PostToolUse` hook, wrote every finding to
 * stderr and exited 0 — for weeks. Probe: exit 0, 0 bytes of stdout, 237 bytes
 * of stderr. Every `runHook`-based test of it was green, because every one of
 * them asserted on `r.stderr`, which is exactly the stream nobody reads. The
 * host's hooks documentation is explicit:
 *
 *   "Claude never sees stderr from a hook that exits 0. [...] To surface a
 *    warning to Claude from a `PostToolUse` or `PostToolUseFailure` hook, exit 2
 *    instead so Claude sees the stderr even though the tool already ran."
 *    — code.claude.com/docs/en/hooks § Exit code 0, read 2026-10-11
 *
 * "The hook printed it" and "the model received it" are the repo's own
 * `fired ≠ landed` split, at the unit tier. A test of a nudge must assert the
 * second, and the second is a function of FOUR facts — the event, the exit
 * code, which stream carried the text, and what the harness's capability table
 * says that event honours. This module is that function. Pure: no process, no
 * harness literal (the table and the block code are injected), so a test and
 * the runtime agree about delivery without running a harness.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM:
 * - an event with no row in the table is `unknown`, never `undelivered` — the
 *   same fail-open stance as `capabilityOf`. A harness with no table at all
 *   (Codex today) can still be judged on the ONE fact its port carries, the
 *   legacy `injectableEvents`: `additionalContext` there is `delivered`, and
 *   anything else is `unknown`;
 * - a BLOCK is reported as `blocked`, not as delivery. Where the block reason
 *   goes differs per event (a vetoed prompt shows it to the user only), the
 *   capability table does not record that, and a block is not a nudge — its
 *   assertion is `assertHookBlocked`;
 * - `systemMessage` is not judged: it is addressed to the user by design.
 */
import type { EventCapabilityTable } from "./event-capability.js";
import { capabilityOf } from "./event-capability.js";

/** A route by which hook text reached the model. */
export type DeliveryChannel =
  /** `hookSpecificOutput.additionalContext` on an event honouring `inject`. */
  | "additional-context"
  /** Plain (non-JSON) stdout at exit 0, on an event honouring `stdout-context`. */
  | "plain-stdout"
  /** stderr at the block exit code, on an event honouring `feedback`. */
  | "exit-code-feedback"
  /** JSON `decision: "block"` + `reason`, on an event honouring `feedback`. */
  | "decision-reason";

/** Text the hook printed that reached NO channel the model reads. */
export interface StrandedOutput {
  readonly stream: "stdout" | "stderr";
  readonly bytes: number;
  /** Why it went nowhere — phrased as an instruction, not a verdict. */
  readonly why: string;
}

/**
 * The verdict. FIVE answers, because "the model saw nothing" has four distinct
 * causes and a test failure must name the right one (`make-the-distinction-a-type`):
 * the hook said nothing, it said something on a dead stream, it blocked
 * instead, or we do not know this event.
 */
export type HookDelivery =
  | {
      readonly kind: "delivered";
      readonly via: readonly DeliveryChannel[];
      /** Output that ALSO went nowhere — informational, not a failure. */
      readonly stranded: readonly StrandedOutput[];
    }
  /** The hook vetoed the action. Not a nudge; see the module header. */
  | { readonly kind: "blocked"; readonly stranded: readonly StrandedOutput[] }
  /** The hook printed text and none of it reached the model. Never empty. */
  | { readonly kind: "undelivered"; readonly stranded: readonly StrandedOutput[] } // prettier-ignore
  /**
   * Nothing addressed to the model: empty streams, or control-only JSON
   * (`permissionDecision: "allow"`, a user-facing `systemMessage`).
   */
  | { readonly kind: "silent" }
  /** The table has no row for this event, so delivery cannot be judged. */
  | { readonly kind: "unknown"; readonly event: string; readonly why: string };

/** What a finished hook process left behind — the observable half. */
export interface HookEmission {
  readonly event: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as one JSON object, or null when it is plain text / empty. */
  readonly json: Readonly<Record<string, unknown>> | null;
}

/** The harness facts the verdict needs — injected, never a literal. */
export interface DeliveryFacts {
  /** The dialect's capability table, when the adapter has one. */
  readonly table: EventCapabilityTable | undefined;
  /** The protocol's block exit code (exit 2 on both shipped harnesses). */
  readonly blockExitCode: number;
  /** The protocol's deny decision values (`"block"`, `"deny"`). */
  readonly denyDecisionValues: readonly string[];
  /** The protocol's halt-the-turn field, if it has one. */
  readonly haltsTurnField?: string;
  /**
   * The legacy flat list of events honouring `additionalContext` — the fallback
   * for an adapter with no table. Ignored when `table` is present.
   */
  readonly injectableEvents?: readonly string[];
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

function hookSpecific(json: HookEmission["json"]): Record<string, unknown> {
  const h = json?.hookSpecificOutput;
  return typeof h === "object" && h !== null
    ? (h as Record<string, unknown>)
    : {};
}

/** True iff the JSON or the exit code expresses a veto under this protocol. */
function vetoExpressed(e: HookEmission, f: DeliveryFacts): boolean {
  if (e.exitCode === f.blockExitCode) return true;
  const permission = hookSpecific(e.json).permissionDecision;
  const decision = permission ?? e.json?.decision;
  if (typeof decision === "string" && f.denyDecisionValues.includes(decision))
    return true;
  return f.haltsTurnField !== undefined && e.json?.[f.haltsTurnField] === false;
}

/**
 * Judge one finished hook run. Pure.
 *
 * Order matters and is the specification:
 * 1. nothing printed → `silent` (true on every event, known or not);
 * 2. no table row → `delivered` only on the one fact the legacy list proves,
 *    else `unknown`;
 * 3. a veto on an event that honours one → `blocked`;
 * 4. otherwise collect every channel that carried text, and every stream that
 *    carried text to no channel; at least one channel → `delivered`.
 */
export function hookOutputDelivery(
  e: HookEmission,
  f: DeliveryFacts,
): HookDelivery {
  const hasStdout = e.stdout.trim().length > 0;
  const hasStderr = e.stderr.trim().length > 0;
  if (!hasStdout && !hasStderr) return { kind: "silent" };

  const context = hookSpecific(e.json).additionalContext;
  const verdict = capabilityOf(f.table, e.event);
  if (verdict.kind === "unknown") {
    const legacy = f.table === undefined ? (f.injectableEvents ?? []) : [];
    if (nonEmpty(context) && legacy.includes(e.event)) {
      return { kind: "delivered", via: ["additional-context"], stranded: [] };
    }
    return {
      kind: "unknown",
      event: e.event,
      why:
        e.event === ""
          ? "the event carries no hook_event_name, so there is no event to judge against"
          : `the harness's capability table has no row for \`${e.event}\`, so ` +
            `where its output goes is not recorded — add the row (with its basis) ` +
            `to judge it`,
    };
  }
  const honours = verdict.capability.honours;

  if (honours.includes("veto") && vetoExpressed(e, f)) {
    return { kind: "blocked", stranded: [] };
  }

  const via: DeliveryChannel[] = [];
  const stranded: StrandedOutput[] = [];
  const atBlock = e.exitCode === f.blockExitCode;
  // A JSON object on stdout is applied on any exit code (the host's own
  // exit-code table: valid JSON is "Success" at exit 0 and at any other code,
  // and its fields are still read at exit 2). Plain text is context only at 0.
  if (e.json !== null) {
    if (nonEmpty(context)) {
      if (honours.includes("inject")) via.push("additional-context");
      else
        stranded.push({
          stream: "stdout",
          bytes: byteLength(e.stdout),
          why:
            `\`${e.event}\` does not honour additionalContext — the text is ` +
            `dropped. Move the hook to an event that injects context.`,
        });
    }
    const decision = e.json.decision;
    if (
      typeof decision === "string" &&
      f.denyDecisionValues.includes(decision) &&
      nonEmpty(e.json.reason) &&
      honours.includes("feedback")
    ) {
      via.push("decision-reason");
    }
  } else if (hasStdout) {
    if (e.exitCode === 0 && honours.includes("stdout-context")) {
      via.push("plain-stdout");
    } else {
      stranded.push({
        stream: "stdout",
        bytes: byteLength(e.stdout),
        why:
          e.exitCode === 0
            ? `plain stdout on \`${e.event}\` is not added to the model's ` +
              `context (it goes to the debug log). Emit JSON ` +
              `\`hookSpecificOutput.additionalContext\` instead.`
            : `plain stdout is only ever context at exit 0; this hook exited ` +
              `${String(e.exitCode)}.`,
      });
    }
  }

  if (hasStderr) {
    if (atBlock && honours.includes("feedback")) {
      via.push("exit-code-feedback");
    } else {
      stranded.push({
        stream: "stderr",
        bytes: byteLength(e.stderr),
        why:
          e.exitCode === 0
            ? `stderr from a hook that exits 0 reaches no channel the model ` +
              `reads. Emit JSON \`hookSpecificOutput.additionalContext\` on ` +
              `stdout${honours.includes("feedback") ? `, or exit ${String(f.blockExitCode)} (\`${e.event}\` feeds that stderr back to the model)` : ""}.`
            : atBlock
              ? `exit ${String(f.blockExitCode)} on \`${e.event}\` neither ` +
                `stops anything nor feeds stderr to the model.`
              : `exit ${String(e.exitCode)} is a non-blocking error: at most ` +
                `the first line of stderr is shown to the USER, never to the model.`,
      });
    }
  }

  if (via.length > 0) return { kind: "delivered", via, stranded };
  // Control-only JSON (`permissionDecision: "allow"`, a bare `systemMessage`)
  // printed something, but nothing addressed to the model — that is silence,
  // not a stranded nudge.
  if (stranded.length === 0) return { kind: "silent" };
  return { kind: "undelivered", stranded };
}
