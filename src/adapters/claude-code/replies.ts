/**
 * Every reply the agent wrote in one run, in order — read off Claude Code's
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

const parseLine = (line: string): AssistantLine | null => {
  try {
    const r = AssistantLineSchema.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

/**
 * The main agent's replies with text, one per message. A message streamed as
 * several events (one per content block) is joined under its `message.id`; a
 * subagent's messages (a non-null `parent_tool_use_id`) are not the agent's
 * replies; a message holding only tool calls has no text and is left out.
 */
export function parseReplies(streamJson: string): readonly string[] {
  const events = streamJson
    .split("\n")
    .map(parseLine)
    .flatMap((e, i) =>
      e !== null && (e.parent_tool_use_id ?? null) === null
        ? [
            {
              id: e.message.id ?? `#${String(i)}`,
              text: textOf(e.message.content),
            },
          ]
        : [],
    );
  const ids = [...new Set(events.map((e) => e.id))];
  return ids
    .map((id) =>
      events
        .filter((e) => e.id === id)
        .map((e) => e.text)
        .join(""),
    )
    .filter((text) => text !== "");
}
