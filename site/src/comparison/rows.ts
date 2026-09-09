/**
 * The COMPARISON rows — what can go wrong in an agent harness, in a plain sentence.
 *
 * WHY ROWS ARE DEFECTS, NOT PRODUCTS. A grid with product columns invites a cell to
 * be filled from a competitor's documentation. Every row here is a thing that breaks
 * in a real harness; a column may only answer it if a script in `tools/` actually RAN
 * that tool against a planted instance of it.
 *
 * TWO ZONES, and keeping them apart is the honest part. `claude plugin validate` is a
 * genuine peer on CONFIG (zone "config") and is not attempting BEHAVIOUR (zone
 * "behaviour") at all — it is a manifest checker, not a test runner. Scoring it on
 * whether it measures a skill's trigger rate would be a rigged row, so behaviour rows
 * carry no competitor cell and say why.
 *
 * `probeCase` keys into `validate-overlap.json`, written by
 * `node tools/measure-validate-overlap.mjs --json`. A row without one renders
 * "not probed" — never an ✗ against somebody else's product.
 */

export type Zone = "config" | "behaviour";

export interface ComparisonRow {
  /** The defect as a sentence a plugin author would recognise. */
  what: string;
  /** The plain gloss — shown inline, because a hover tooltip is invisible on a phone. */
  gloss: string;
  /** The vigiles rule slug, when one check owns this row (links to its page). */
  slug?: string;
  /** Key into the measured snapshot. Absent ⇒ no competitor cell is rendered. */
  probeCase?: string;
  /** Collapsing bucket. Thirteen flat rows read as a lint-rule dump on a marketing
   *  page; four named groups read as an argument. Behaviour rows need none. */
  group?: string;
  zone: Zone;
}

export const ROWS: readonly ComparisonRow[] = [
  // ── zone: config — measured against a real run of `claude plugin validate` ──
  {
    zone: "config",
    what: "A subagent asks for a tool that is spelled wrong",
    gloss:
      "The harness drops the tool silently. Your agent quietly cannot use it.",
    slug: "subagent-tool-contract",
    probeCase: "subagent-typod-tool",
    group: "Tools the harness silently drops",
  },
  {
    zone: "config",
    what: "A subagent asks for a tool no subagent can ever have",
    gloss:
      "AskUserQuestion is not available to subagents. It is dropped without a word.",
    slug: "subagent-tool-contract",
    probeCase: "subagent-never-available-tool",
    group: "Tools the harness silently drops",
  },
  {
    zone: "config",
    what: "A skill asks for a tool that does not exist",
    gloss: "Same silent drop, on the skill side of the harness.",
    slug: "subagent-tool-contract",
    probeCase: "skill-tool-does-not-exist",
    group: "Tools the harness silently drops",
  },
  {
    zone: "config",
    what: "A skill names an MCP server the plugin never declares",
    gloss:
      "The tool can never resolve, so the step that needed it fails at runtime.",
    slug: "mcp-tool-resolves",
    probeCase: "skill-undeclared-mcp-server",
    group: "Paths and names that point at nothing",
  },
  {
    zone: "config",
    what: "A subagent names a model that does not exist",
    gloss:
      "It silently falls back to the default — you are billed for a model you did not choose.",
    slug: "subagent-frontmatter",
    probeCase: "subagent-typod-model",
    group: "Units that never register",
  },
  {
    zone: "config",
    what: "A subagent has no name or description",
    gloss: "It cannot register at all, so it can never be dispatched.",
    slug: "subagent-frontmatter",
    probeCase: "subagent-missing-frontmatter",
    group: "Units that never register",
  },
  {
    zone: "config",
    what: "A deny-list entry is misspelled, so it blocks nothing",
    gloss:
      "You believe a tool is forbidden. The typo means it stays available.",
    slug: "disallowed-tools-contract",
    probeCase: "subagent-disallowed-tools-typo",
    group: "Tools the harness silently drops",
  },
  {
    zone: "config",
    what: "A hook is registered on an event that does not exist",
    gloss:
      "One letter off and the hook is never wired to anything. The config is still valid.",
    slug: "hook-events",
    probeCase: "hook-typod-event",
    group: "Paths and names that point at nothing",
  },
  {
    zone: "config",
    what: "A hook points at a script that was never committed",
    gloss:
      "The path parses fine. The guard you think protects you runs nothing.",
    slug: "hook-script-exists",
    probeCase: "hook-script-missing",
    group: "Paths and names that point at nothing",
  },
  {
    zone: "config",
    what: "A skill's settings block is not valid YAML",
    gloss:
      "Fields may not parse as you intended, so the skill loads with the wrong metadata.",
    slug: "frontmatter-valid",
    probeCase: "skill-malformed-frontmatter",
    group: "Units that never register",
  },
  {
    zone: "config",
    what: "A skill has no name or description",
    gloss:
      "It falls back to the directory name and first paragraph — a weak trigger surface.",
    slug: "skill-frontmatter",
    probeCase: "skill-missing-frontmatter",
    group: "Units that never register",
  },
  {
    zone: "config",
    what: "Two skills describe themselves almost identically",
    gloss: "The model cannot tell them apart, so the wrong one fires.",
    slug: "description-overlap",
    probeCase: "skill-description-overlap",
    group: "The model picks the wrong one",
  },
  {
    zone: "config",
    what: "A skill links to a file that is not there",
    gloss: "The step that told the agent to read it silently does nothing.",
    slug: "skill-resource-resolves",
    probeCase: "skill-resource-missing",
    group: "Paths and names that point at nothing",
  },

  // ── zone: behaviour — no competitor cell, and the reason is the point ──
  {
    zone: "behaviour",
    what: "Does this skill actually fire when it should?",
    gloss:
      "Undecidable by reading the file — it depends on a model choosing. vigiles measures it across varied prompts and reports recall and precision.",
  },
  {
    zone: "behaviour",
    what: "Does your safety hook actually block a destructive command?",
    gloss:
      "Measured against a catalogue of disaster commands. The hand-written guard the ecosystem copies blocks 2 of 7; a compiled hook blocks 7 of 7.",
  },
  {
    zone: "behaviour",
    what: "Does a subagent stay inside the tools it declared?",
    gloss:
      "`tools:` is documentation, not a fence. vigiles turns the declared contract into a rail enforced while the agent runs.",
  },
  {
    zone: "behaviour",
    what: "Does the lint rule your CLAUDE.md claims to enforce exist — and is it still on?",
    gloss:
      "Your instructions say you enforce a rule. vigiles resolves it against your real linter config and fails CI when someone switches it off.",
  },
] as const;
