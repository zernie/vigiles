/**
 * Type-level constraint: typed purity. The `vigiles/harness/claude-code` `agent` /
 * `experimental_skill` builders enforce the `purity` floor AGAINST the Claude Code tool
 * catalog at `tsc` time — a strict addition to the runtime/compile purity
 * checks. Compiled with `tsc --noEmit` (npm run test:types); it asserts types,
 * it is not executed. `// @ts-expect-error` marks the must-NOT-compile cases.
 *
 * Mirrors the SHIPPED ladder (src/core/effects.ts): pure = read-only only;
 * bounded = read-only ∪ Write/Edit/NotebookEdit ∪ Bash; no purity / dangerous =
 * open. The core (harness-agnostic) `experimental_agent()` is unconstrained by default.
 */
import {
  experimental_agent,
  experimental_skill,
} from "../../dist/entries/harness/claude-code.js";
import {
  experimental_agent as coreAgent,
  experimental_skill as coreSkill,
} from "../../dist/core/spec.js";

// ---------------------------------------------------------------------------
// CC-bound `agent` — these MUST compile.
// ---------------------------------------------------------------------------

// pure + read-only tools → OK
experimental_agent({
  name: "reviewer",
  description: "read-only review",
  purity: "pure",
  tools: ["Read", "Grep", "Glob"],
});

// `LS` is NOT a Claude Code tool — it left the catalog with `BashOutput`,
// `KillBash` and `MultiEdit` (2026-08-17). A retired name must fail at tsc time,
// not merely be absent from the list above: absence proves nothing.
experimental_agent({
  name: "bad-retired-tool",
  description: "names a tool that does not exist",
  purity: "pure",
  // @ts-expect-error `LS` is not in the built-in catalog
  tools: ["Read", "LS"],
});

// bounded + Bash → OK (bounded ADMITS Bash; its command is gated at runtime)
experimental_agent({
  name: "fixer",
  description: "bounded worker",
  purity: "bounded",
  tools: ["Read", "Bash", "Write", "Edit", "NotebookEdit"],
});

// no purity → ANY tools compile (open default, backwards-compatible)
experimental_agent({
  name: "open",
  description: "no purity floor",
  tools: ["Bash", "mcp__server__tool", "whatever"],
});

// dangerously-unrestricted → ANY tools compile (the loud escape hatch)
experimental_agent({
  name: "yolo",
  description: "escape hatch",
  purity: "dangerously-unrestricted",
  tools: ["Bash", "mcp__server__tool"],
});

// ---------------------------------------------------------------------------
// CC-bound `agent` — these MUST NOT compile.
// ---------------------------------------------------------------------------

experimental_agent({
  name: "bad-pure",
  description: "pure cannot take a side-effecting tool",
  purity: "pure",
  // @ts-expect-error pure + Bash (side-effecting) is rejected at tsc time
  tools: ["Read", "Bash"],
});

experimental_agent({
  name: "bad-pure-write",
  description: "pure cannot take Write",
  purity: "pure",
  // @ts-expect-error pure + Write (side-effecting) is rejected at tsc time
  tools: ["Read", "Write"],
});

experimental_agent({
  name: "bad-bounded-mcp",
  description: "bounded cannot take an MCP / unknown tool",
  purity: "bounded",
  // @ts-expect-error bounded + an mcp__ tool (unknown-effect) is rejected
  tools: ["Read", "mcp__server__tool"],
});

// ---------------------------------------------------------------------------
// CC-bound `experimental_skill` — the same constraint applies.
// ---------------------------------------------------------------------------

experimental_skill({
  name: "pure-skill",
  description: "read-only skill",
  purity: "pure",
  tools: ["Read", "Grep"],
});

experimental_skill({
  name: "bad-pure-skill",
  description: "pure skill cannot take Bash",
  purity: "pure",
  // @ts-expect-error pure skill + Bash is rejected at tsc time
  tools: ["Read", "Bash"],
});

experimental_skill({
  name: "open-skill",
  description: "no purity → open",
  tools: ["Bash", "mcp__server__tool"],
});

// ---------------------------------------------------------------------------
// Core (harness-agnostic) `agent` / `experimental_skill` — UNCONSTRAINED by default, so even
// `purity: "pure"` + a side-effecting tool COMPILES (the runtime/compile checks
// are the backstop for the untyped import). Backwards compatibility.
// ---------------------------------------------------------------------------

coreAgent({
  name: "core-open",
  description: "core agent accepts any tools at any purity",
  purity: "pure",
  tools: ["Bash", "mcp__server__tool", "anything"],
});

coreSkill({
  name: "core-open-skill",
  description: "core skill accepts any tools at any purity",
  purity: "pure",
  tools: ["Bash", "Write"],
});
