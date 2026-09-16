/**
 * Claude Code's hook-event capability table — what each event carries and what
 * it honours. The CAPTURE half of `core/event-capability.ts`; see that module
 * for why the table is partial and why `unknown` is fail-open.
 *
 * NINE of the vendor's 31 events are recorded here, and the other 22 are absent
 * ON PURPOSE. These nine are the ones a capability is actually KNOWN for —
 * either documented by the vendor or measured against a real binary — and every
 * row below carries which. The 22 absent ones are not "no capabilities"; they
 * are "we have not looked", and the classifier says so rather than guessing.
 *
 * Adding a row is a claim about somebody else's product, so it needs a basis in
 * the comment beside it: `doc` (the vendor documents it) or `measured <date> on
 * <version>` (we ran it). "Probably the same as its sibling event" is not a
 * basis — `SubagentStop` is in here on the vendor's own wording, not on its
 * resemblance to `Stop`.
 */
import type { EventCapabilityTable } from "../../core/event-capability.js";

export const claudeCodeEventCapabilities: EventCapabilityTable = {
  capturedFrom:
    "code.claude.com/docs/en/hooks (claude-code 2.1.273) + inject/veto measured 2026-09-16 headless",
  events: {
    // doc: SessionStart context is prepended to the session. MEASURED 2026-09-16:
    // inject lands; exit 2 is ignored entirely (it is in noEffectHookEvents).
    SessionStart: {
      carries: "session",
      honours: ["inject"],
      matcher: false,
      denyShape: "exit-code",
    },
    // doc: exit 2 blocks the prompt and erases it; stdout becomes context.
    UserPromptSubmit: {
      carries: "prompt",
      honours: ["veto", "inject"],
      matcher: false,
      denyShape: "exit-code",
    },
    // doc: the one event whose deny needs `hookSpecificOutput.permissionDecision`
    // (the legacy top-level `decision` is ignored), and the one that can `ask`.
    // MEASURED 2026-09-16: additionalContext also lands here — the reason this
    // table exists at all, since `injectableEvents` had said otherwise on an
    // assumption nobody had run.
    PreToolUse: {
      carries: "tool",
      honours: ["veto", "ask", "inject"],
      matcher: true,
      denyShape: "permission-decision",
    },
    // doc: exit 2 feeds stderr back to the MODEL but the tool has already run —
    // feedback, never a veto. This distinction is why `hook-block-ineffective`
    // does not flag PostToolUse and would cry wolf if it did.
    PostToolUse: {
      carries: "tool",
      honours: ["feedback", "inject"],
      matcher: true,
      denyShape: "exit-code",
    },
    // doc: exit 2 blocks the agent from stopping (the gate-until-tests-pass
    // shape). MEASURED 2026-09-16: inject lands too.
    Stop: {
      carries: "stop",
      honours: ["veto", "inject"],
      matcher: false,
      denyShape: "exit-code",
    },
    // doc: same block semantics as Stop, for a subagent. Inject NOT claimed —
    // it was not measured, and Stop's behaviour is not evidence about it.
    SubagentStop: {
      carries: "stop",
      honours: ["veto"],
      matcher: false,
      denyShape: "exit-code",
    },
    // doc + noEffectHookEvents: a block decision here is silently ignored
    // ENTIRELY — no veto AND no model feedback. A hook on these three is inert
    // whatever it returns, which is exactly what `honours: []` says.
    SessionEnd: {
      carries: "none",
      honours: [],
      matcher: false,
      denyShape: "exit-code",
    },
    Notification: {
      carries: "none",
      honours: [],
      matcher: false,
      denyShape: "exit-code",
    },
    PreCompact: {
      carries: "none",
      honours: [],
      matcher: false,
      denyShape: "exit-code",
    },
  },
};
