/**
 * Demo spec for the `compile` beat on the landing page — a skill with a narrow
 * `tools: [Read, Grep, Glob]` allow-list, plus the one line no skill in
 * test/dogfood/trailofbits-skills-curated@6d05be4 declares: `disallowedTools`.
 * Not a copy of any marketplace skill's list (until 2026-09-26 this comment
 * said it matched scv-scan's; scv-scan actually allows Bash, Write and Task).
 *
 * Compiled and audited for real by gen-trailofbits-expected.mjs; its generated
 * frontmatter and its `vigiles audit` score are written to the fixture, not
 * retyped in the TSX. Edit this file and the numbers on the landing page move
 * with it — that is the point of the demo.
 */
import { experimental_skill } from "vigiles/spec";

export default experimental_skill({
  name: "solidity-audit",
  description:
    "Audits Solidity codebases for smart contract vulnerabilities. Use when reviewing contracts for security issues.",
  tools: ["Read", "Grep", "Glob"],
  disallowedTools: ["Bash", "WebFetch", "WebSearch"],
  body: `# solidity-audit\n\nRead the contract, grep for known patterns, report findings.\n`,
});
