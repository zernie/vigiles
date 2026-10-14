/**
 * `skill-resource-resolves` — a SKILL.md body that points at a bundled file
 * (`scripts/…`, `references/…`, `assets/…`, or a relative markdown link with an
 * extension) that is not beside the SKILL.md: the agent reads the instruction
 * and gets nothing. The first rule that is a module of its own (PR #387); the
 * rest follow in vigiles#390.
 *
 * The DETECTOR is a domain capability and stays in core
 * (`skillResourceIssues`, run once per skill by the scan, shared by `lint` and
 * `audit`). This module is the POLICY around it: the rule's id, group, default
 * and cure, and how a finding reads.
 *
 * In the `experimental` group: measured precision 44% on public repositories,
 * below the bar a graded check must clear — so it is off by default, never in
 * the audit score, and on at `warn` through `vigiles:experimental`. A ref that
 * misses beside the SKILL.md but exists at the repository root is a NOTE
 * (#382): it works inside this repository and breaks once the skill is
 * installed elsewhere, so it is printed and never counted. See
 * docs/rules/skill-resource-resolves.md.
 */
import { defineRule, type Finding, type ScanInput } from "../core/rule.js";
import { repoRootOnlyAdvice } from "../core/skill-resources.js";

/** Every resource reference of every skill, as the findings a report prints. */
function findings(scan: ScanInput): readonly Finding[] {
  return scan.skills.flatMap((skill) =>
    skill.resourceIssues.map((f): Finding => {
      const at = `bundled resource "${f.ref}" (line ${String(f.line)})`;
      const base = { path: skill.path, line: f.line, subject: skill.name };
      return f.resolution === "missing"
        ? {
            ...base,
            kind: "finding",
            message: `${at} is referenced but missing — the agent reads the instruction and gets nothing.`,
          }
        : { ...base, kind: "note", message: `${at} ${repoRootOnlyAdvice(f)}` };
    }),
  );
}

export const skillResourceResolves = defineRule({
  id: "skill-resource-resolves",
  group: "experimental",
  bucket: "external-decidable",
  surface: ["skill"],
  defaultSeverity: "off",
  cure: "edit",
  summary: "A SKILL.md's bundled-file reference exists under the skill dir.",
  detector: "skillResourceIssues",
  findings,
});
