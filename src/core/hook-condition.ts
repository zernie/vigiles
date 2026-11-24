/**
 * HOOK CONDITIONS — the neutral shape of "this hook only runs when the tool call
 * matches", and the reason `runGuardrail` can no longer fabricate a green.
 *
 * 🔴 THE DEFECT THIS EXISTS FOR, measured 2026-09-07. Claude Code hooks support a
 * per-action `if` field: a permission-rule pattern (`"Bash(git push *--force*)"`)
 * that decides whether the hook command is spawned AT ALL. vigiles knew nothing
 * about it — `normalizeHooks` dropped the key and `runHook` took a bare command
 * string — so a real published guard
 * (test/dogfood/davila7-force-push-blocker@869640b) whose body is an
 * unconditional `echo …"permissionDecision":"deny"…` was reported by
 * `verifyGuardrail` as blocking **7/7** of the disaster battery, including
 * `rm -rf /`, `cat ~/.ssh/id_rsa` and `curl | sh` — actions its `if` means it can
 * never even see. That is the FALSE CONFIDENCE class this product sells against,
 * produced by the product's own verifier.
 *
 * WHY EVALUATE RATHER THAN ABSTAIN. Three options were on the table: evaluate the
 * condition, report every conditional hook as "unknown", or refuse. Evaluating
 * wins because the question is DECIDABLE on exactly the inputs that matter — a
 * static command with resolvable command names, which is what a battery feeds —
 * and because the harness's own matcher is CONSERVATIVE: where Claude Code cannot
 * tell, it RUNS the hook. Mirroring that means uncertainty can only ever ADD a
 * run, never subtract one, so this can turn a true green into a miss in no case
 * (no crying wolf) while still refusing to invent the green the davila7 hook got.
 * "Unknown" would have degraded a genuinely matching guard's true result, and
 * refusing would break every existing caller.
 *
 * WHAT IS NEUTRAL AND WHAT IS NOT. That a hook may carry a condition, and that a
 * condition is only meaningful on the events the harness evaluates it on, are
 * neutral facts modelled here. The GRAMMAR (`Tool(pattern)`, glob semantics, how
 * a shell command is decomposed before matching) is Claude Code's permission-rule
 * syntax and lives in its adapter, reached through {@link HookProtocol.condition}.
 * A harness with no such feature simply leaves the field unset and every hook is
 * unconditional — the behaviour every consumer had before this existed.
 */

/**
 * The tool call a condition is evaluated against — the parts of a hook event that
 * can decide whether the hook runs.
 */
export interface HookConditionCall {
  /** The hook event name, e.g. `"PreToolUse"`. */
  readonly event: string;
  /** The tool being called, e.g. `"Bash"`. */
  readonly tool: string;
  /** The tool's input payload (`tool_input`) — the command, path, … */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Whether a conditional hook runs for one call, and the reason.
 *
 * Both fields are always present, so there is no state where a caller reads a
 * verdict without knowing why — the reason is what a guardrail report needs in
 * order to say "not run" instead of the indistinguishable "did not block".
 */
export interface HookConditionVerdict {
  /** True iff the harness would spawn the hook for this call. */
  readonly runs: boolean;
  /** One line naming why — rendered by the guardrail report. */
  readonly why: string;
}

/**
 * A harness's support for hook conditions — carried on {@link HookProtocol} as an
 * optional, additive field. Absent ⇒ the harness has no such feature and every
 * hook is unconditional.
 */
export interface HookConditionSupport {
  /**
   * The config key the condition is written under (Claude Code: `"if"`). Used to
   * read it out of raw settings and to name it in a report; a test binds this to
   * the key `normalizeHooks` actually reads, so the two cannot drift.
   */
  readonly field: string;
  /**
   * The events on which the harness evaluates the condition. A hook that declares
   * a condition and registers on any OTHER event never runs at all — so the list
   * is not decoration, it decides.
   */
  readonly evaluatedOn: readonly string[];
  /**
   * Decide whether a hook declaring `condition` runs for this call. MUST be
   * conservative in the direction of `runs: true` — an undecidable input is a
   * reason to run the hook, never a reason to claim it was skipped.
   */
  matches(condition: string, call: HookConditionCall): HookConditionVerdict;
}

/**
 * The one entry point a runner uses: apply a harness's condition support to a
 * call, including the event rule the port's `evaluatedOn` list implies.
 *
 * `undefined`/empty condition ⇒ unconditional (runs). No support declared ⇒ the
 * harness has no conditions, so a hook that carries one is not something we can
 * reason about; we RUN it, which is the pre-existing behaviour and the safe
 * direction (see the module header on why uncertainty must only add runs).
 */
export function decideHookCondition(
  condition: string | null | undefined,
  call: HookConditionCall,
  support: HookConditionSupport | undefined,
): HookConditionVerdict {
  if (condition === null || condition === undefined || condition.trim() === "")
    return { runs: true, why: "no condition declared" };
  if (!support)
    return {
      runs: true,
      why: "this harness declares no hook-condition support — treated as unconditional",
    };
  if (!support.evaluatedOn.includes(call.event))
    return {
      runs: false,
      why: `\`${support.field}\` is only evaluated on ${support.evaluatedOn.join("/")}, not ${call.event} — the hook never runs`,
    };
  return support.matches(condition, call);
}
