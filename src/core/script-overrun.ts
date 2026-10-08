/**
 * Running past the end of a scripted model is an error.
 *
 * A harness test scripts the turns the agent should take, then asserts on what
 * happened. When the agent asks for more turns than the script has, the mock
 * used to answer with a copy of the LAST turn: a looping agent (a Stop hook
 * that keeps blocking, a retry, a reaction to a tool result) then ran on turns
 * nobody scripted, a final `{ tool }` re-ran its side effect, and the test went
 * green over a run it never described (#340). Pure and shared by both mocks
 * (Anthropic Messages, OpenAI Responses) and the runner that fails the test.
 */
import type { ModelRequest } from "./harness-driver.js";

/** The first request the script could not answer. */
export interface ScriptOverrun {
  /** How many turns the script had. */
  readonly scripted: number;
  /** 1-based number of the agent request that had no turn left. */
  readonly request: number;
  /** The last message that request carried (what the agent was reacting to). */
  readonly lastMessage: string;
}

const MAX_QUOTED = 160;

const quote = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTED ? `${flat.slice(0, MAX_QUOTED)}...` : flat;
};

/** Why a test failed because the agent outran its script. */
export function scriptOverrunMessage(o: ScriptOverrun): string {
  const last =
    o.lastMessage.trim() === ""
      ? ""
      : ` The request carried this last message: "${quote(o.lastMessage)}".`;
  return (
    `the agent asked for more model turns than the script has: ${String(o.scripted)} turn(s) scripted, ` +
    `and agent request #${String(o.request)} had none left.${last} ` +
    "The mock does not repeat the last turn, because a looping agent would then pass on turns nobody scripted. " +
    "Script every turn the agent should take."
  );
}

/**
 * The first agent request past the end of a script of `scripted` turns, read
 * off the recorded requests (side-channel calls never consume a turn, so they
 * do not count). Undefined when the agent stayed inside the script.
 */
export function findScriptOverrun(
  scripted: number,
  requests: readonly ModelRequest[],
): ScriptOverrun | undefined {
  const agent = requests.filter((r) => r.sideChannel !== true);
  const first = agent[scripted];
  if (first === undefined) return undefined;
  return {
    scripted,
    request: scripted + 1,
    lastMessage: first.messages.at(-1)?.text ?? "",
  };
}

/** {@link findScriptOverrun} and {@link scriptOverrunMessage} in one: the message, or undefined. */
export function overrunMessageFor(
  scripted: number,
  requests: readonly ModelRequest[],
): string | undefined {
  const overrun = findScriptOverrun(scripted, requests);
  return overrun === undefined ? undefined : scriptOverrunMessage(overrun);
}
