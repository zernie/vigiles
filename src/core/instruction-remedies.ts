/**
 * Where always-loaded text can go instead of being deleted.
 *
 * Every finding that says "too much is loaded on every request" — the weight
 * ceiling, the ratchet's growth, the refusal to record a heavier baseline, a
 * section over its character budget — ends with this list. Without it the one
 * move the message offers is "cut content", and the reader deletes rules that
 * still matter instead of moving each one to the carrier that loads it only
 * when it applies. The order is the order to try: the cheapest carrier that
 * still fires at the right moment first, deletion last.
 */
export const MOVE_OUT_OF_ALWAYS_LOADED =
  "Move what does not apply to every request: " +
  "a rule for one folder → that folder's nested CLAUDE.md or AGENTS.md, loaded only when the agent works there · " +
  "a step tied to one action → a hook · " +
  "a procedure for one kind of task → a skill · " +
  "a fact a machine can check → a lint rule or a test, then delete the prose · " +
  "measurements and history → docs, linked, not loaded · " +
  "text another file already says → delete it.";
