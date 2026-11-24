/**
 * The harness-neutral FACTS Claude Code's run parser puts in a `Trace` — which
 * skills fired, and the shell command a tool call ran — so a check like
 * `skill(id)` or `runs(program)` asks the adapter instead of knowing which tool
 * this harness activates skills or runs commands through.
 *
 * WHERE THE FACTS COME FROM, and only there:
 * - a skill fired = a `Skill` tool call (its `input.skill` is the namespaced
 *   id). Reading or writing that skill's `SKILL.md`, grepping for its name, or
 *   another tool whose input happens to carry a `"name"` equal to it, is NOT a
 *   fire — each of those is a measured false positive of a substring detector
 *   (see `trace-facts.test.ts`). A skill that ran but left only its EFFECTS in
 *   the log (`node verify-cites.mjs`) is a miss no parser can recover.
 * - a shell command = the `Bash` tool's `input.command`.
 */
import type { SkillFacts, ToolCall } from "../../core/harness-driver.js";
import { isStreamOutput } from "./replies.js";

/** The shell command a Claude Code tool call ran, or undefined for any other call. */
export function bashCommandOf(
  name: string,
  input: unknown,
): string | undefined {
  if (name !== "Bash" || typeof input !== "object" || input === null)
    return undefined;
  if (!("command" in input)) return undefined;
  return typeof input.command === "string" ? input.command : undefined;
}

/** The skill id a `Skill` tool call activated, or undefined. */
function skillIdOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("skill" in input))
    return undefined;
  return typeof input.skill === "string" && input.skill.length > 0
    ? input.skill
    : undefined;
}

/**
 * Which skills fired in a Claude Code run. Not observable when the run was not
 * streamed: the plain `json` result carries no tool calls, so "no `Skill` call"
 * there means "not captured", not "did not fire".
 */
export function streamSkillFacts(
  stdout: string,
  toolCalls: readonly ToolCall[],
): SkillFacts {
  if (!isStreamOutput(stdout))
    return {
      observable: false,
      harness: "claude-code",
      why: "the run was not streamed, so no tool call was captured — pass `transcript: true`",
    };
  return {
    observable: true,
    fired: toolCalls.flatMap((c) => {
      const id = c.name === "Skill" ? skillIdOf(c.input) : undefined;
      return id === undefined
        ? []
        : [{ id, isError: c.isError, resultText: c.resultText }];
    }),
  };
}
