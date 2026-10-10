# Observing a run — what it CALLED, WROTE, and TOUCHED

Read this when the question is about **what a run did**, not about which tier to
pick. Every predicate here ships today.

## Observing a run (what it CALLED, WROTE, and TOUCHED)

The table above is keyed on the harness _surface_ under test. Half the real
questions are keyed on the **observation** instead — "what did this skill
actually do?" — and they have answers already. Reach for these before building
anything; every one of them ships today.

| The question you're actually asking                                     | Use                                                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which tools did it call, and with what arguments?                       | `trace.toolCalls` · `tool` / `toolWith` checks · `parseToolCalls` (`vigiles`)                                                                                     |
| Did it call a tool it must not?                                         | `notTool(name)`                                                                                                                                                   |
| Did it call **only** tools from a known set?                            | `onlyTools([...])` — the white-list, symmetric to `assertWroteOnly`                                                                                               |
| Did it stay inside the `allowed-tools` its own frontmatter declares?    | `skillContract(dir).surface` — builds that check FROM the declaration                                                                                             |
| What files did the run write?                                           | `filesWritten` · `wrote(path)` / `didNotWrite(path)` · `r.file(path)`                                                                                             |
| Did it write **only** where it was supposed to?                         | `assertWroteOnly([...])` / `assertNoWrite()` — needs `{ sandbox: "auto" }`                                                                                        |
| Run a tool call but **don't let it execute** — capture the args instead | the `interceptTools` option on `measure` / `runEval` (a `ToolIntercept[]`)                                                                                        |
| Let a CLI the agent (or its script) calls **answer** — `gh`, `psql`     | `stubs: [experimental_stub(name, rules)]` on `runEval`; read `ctx.stubCalls`, check with `experimental_stub.called(...)` — an argv no rule answers fails the eval |
| Did a subagent do it, and which one?                                    | `subagent(name, [...])` · `SubagentTrace`                                                                                                                         |
| Was it an MCP tool?                                                     | `mcp(server, toolName)`                                                                                                                                           |
| Assert the whole effect boundary deterministically                      | `assertChecks` + the checks above (see `examples/harness/effect-boundary.harness.mjs`)                                                                            |

`interceptTools` is the one worth knowing about, because it is not obvious it
exists: it denies a tool its **real execution** via an auto-wired `PreToolUse`
hook while still recording the call and its arguments into the trace. That is
how you test a skill that would otherwise mutate a real external service — a
calendar, an upload — without mocking anything yourself.

**Verify a skill against its own declaration** with `skillContract` — it reads
the `allowed-tools:` the skill already claims and hands back ready checks, so
the claim is verified instead of restated:

```ts
import { skillContract, assertChecks } from "vigiles";

const c = skillContract(".claude/skills/my-skill");
assertChecks(trace, [c.activation, ...c.surface]);
```

Two of its states are **findings**, not clean bills, and their `surface` check
fails rather than passing on nothing: `undeclared` (no `allowed-tools:` line, so
the skill inherits _every_ tool) and `malformed` (frontmatter that isn't valid
YAML, so a strict loader reads no contract at all — one unquoted `: ` does it).

⚠️ **What is still NOT checked.** `onlyTools` compares tool _names_, so a narrow
allowlist entry like `Bash(node scripts/x.mjs:*)` is satisfied by any `Bash` call
at all. Scope inside a tool is unverified — say so rather than implying the
assertion is total.
