/**
 * Demo spec for the `compile` beat on the landing page — same shape as the real
 * scv-scan skill in test/dogfood/trailofbits-skills-curated@6d05be4 (same
 * domain, same allowed-tools list), with one addition: `disallowedTools`.
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
