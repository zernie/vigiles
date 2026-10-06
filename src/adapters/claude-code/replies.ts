/**
 * Every reply the agent ended a turn with, in order — read off Claude Code's
 * `--output-format stream-json`. The `result` event carries only the LAST one,
 * so a reply a Stop hook made the agent follow up on was invisible to a test,
 * and with it anything that reply printed (a second status footer, measured on
 * Claude Code 2.1.291: two `assistant` events, one `result` holding the second).
 */
import { z } from "zod";

/** The parts of an `assistant` stream line this reads; the rest is ignored. */
const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  parent_tool_use_id: z.string().nullish(),
  message: z.object({
    id: z.string().optional(),
    content: z.array(z.unknown()),
  }),
});
type AssistantLine = Readonly<z.infer<typeof AssistantLineSchema>>;

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });

const textOf = (content: readonly unknown[]): string =>
  content
    .map((block) => TextBlock.safeParse(block))
    .flatMap((r) => (r.success ? [r.data.text] : []))
    .join("");

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const parseLine = (line: string): AssistantLine | null => {
  const r = AssistantLineSchema.safeParse(parseJson(line));
  return r.success ? r.data : null;
};

/** A stream-json run opens with a `system` event; plain `json` output has none. */
const StreamStartSchema = z.object({ type: z.literal("system") });

const isStream = (lines: readonly string[]): boolean =>
  lines.some(
    (l) =>
      StreamStartSchema.safeParse(parseJson(l)).success ||
      parseLine(l) !== null,
  );

const ToolUseBlock = z.object({ type: z.literal("tool_use") });

/** Whether the model answered at all: any `assistant` event, subagents included. */
export function reachedModel(streamJson: string): boolean {
  return streamJson.split("\n").some((l) => parseLine(l) !== null);
}

/**
 * The main agent's replies, one per message that ended a turn. A message
 * streamed as several events (one per content block) is joined under its
 * `message.id`. Left out: a subagent's messages (a non-null
 * `parent_tool_use_id`); a message that also calls a tool, whose text is
 * narration on the way to the call (measured on Claude Code 2.1.292: the
 * narration and the `tool_use` share one id); a message with no text.
 * `undefined` when the output is not a stream, so a check can say the run
 * was not streamed instead of reading "no replies".
 */
export function parseReplies(
  streamJson: string,
): readonly string[] | undefined {
  const lines = streamJson.split("\n");
  if (!isStream(lines)) return undefined;
  const events = lines.map(parseLine).flatMap((e, i) =>
    e !== null && (e.parent_tool_use_id ?? null) === null
      ? [
          {
            id: e.message.id ?? `#${String(i)}`,
            text: textOf(e.message.content),
            callsTool: e.message.content.some(
              (b) => ToolUseBlock.safeParse(b).success,
            ),
          },
        ]
      : [],
  );
  const ids = [...new Set(events.map((e) => e.id))];
  return ids
    .map((id) => events.filter((e) => e.id === id))
    .filter((parts) => !parts.some((e) => e.callsTool))
    .map((parts) => parts.map((e) => e.text).join(""))
    .filter((text) => text !== "");
}
