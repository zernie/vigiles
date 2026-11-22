/**
 * `instruction-ref-resolves` — a markdown link or a code-span path in an
 * instruction file, a subagent or a command that names a path the tree does
 * not hold: the agent follows the pointer and finds nothing. One finding per
 * reference, at its file and line (#383, #442). A path that exists only
 * somewhere else, or inside a submodule, is a note.
 *
 * In the `experimental` group: a code span is prose, and whether a path-shaped
 * one is a pointer is a heuristic (bucket C) whose precision has not been
 * measured yet — so it is off by default, never in the score, and on at `warn`
 * through `vigiles:experimental`. See docs/rules/instruction-ref-resolves.md.
 */
import { referenceFinding } from "../core/reference-graph.js";
import { defineRule, type Finding, type ScanInput } from "../core/rule.js";

/** What a broken pointer costs, in the finding's own words. */
const CONSEQUENCE = "the agent follows the pointer and finds nothing.";

/** Every link and mention that is broken or noted, as findings. */
function findings(scan: ScanInput): readonly Finding[] {
  return scan.references
    .filter((r) => r.kind !== "import")
    .flatMap((r) => referenceFinding(r, CONSEQUENCE) ?? []);
}

export const instructionRefResolves = defineRule({
  id: "instruction-ref-resolves",
  group: "experimental",
  bucket: "heuristic-behavioral",
  surface: ["instruction", "subagent"],
  defaultSeverity: "off",
  cure: "edit",
  summary:
    "A link or code-span path in an instruction file, subagent or command names a path that exists.",
  detector: "referenceGraph",
  findings,
});
