/**
 * `reference-resolves` — an `@path` import in an instruction file that names a
 * file the tree does not hold (or holds under another case): the harness
 * loads nothing in its place, silently. One finding per import, at its file
 * and line (#442).
 *
 * Graded, in `structural`: the harness itself loads the file, so a missing one
 * is a fact, not a reading of prose (decidability bucket B). The links and
 * code-span mentions the same graph finds are a different bucket and a
 * different rule (`instruction-ref-resolves`, experimental until measured).
 * The detector is core's `referenceGraph`; the score counts the same edges
 * through `brokenImports`. See docs/rules/reference-resolves.md.
 */
import { brokenImports, referenceFinding } from "../core/reference-graph.js";
import { defineRule, type Finding, type ScanInput } from "../core/rule.js";

/** What a broken import costs, in the finding's own words. */
const CONSEQUENCE = "the harness loads nothing for this import.";

/** Every import that is broken, or sits in a submodule, as findings. */
function findings(scan: ScanInput): readonly Finding[] {
  return scan.references
    .filter((r) => r.kind === "import")
    .flatMap((r) => referenceFinding(r, CONSEQUENCE) ?? []);
}

export const referenceResolves = defineRule({
  id: "reference-resolves",
  group: "structural",
  bucket: "external-decidable",
  surface: ["instruction"],
  defaultSeverity: "warn",
  cure: "edit",
  summary: "An `@path` import in an instruction file names a file that exists.",
  detector: "referenceGraph",
  scoredBy: brokenImports.name,
  findings,
});
