# `vigiles/spec`

What a spec **author** imports: the builders for an instruction file, a rule, a
verified reference, a skill and a subagent, their types, and the assertion that
reads a subagent's result.

**For:** people who write `CLAUDE.md.spec.ts`, `SKILL.md.spec.ts` or an agent
spec. Compiling is the CLI's job (`npx vigiles compile`, `npx vigiles lint`), not
this entry's. Specs written against `vigiles/spec` accept any tool at any purity;
for a compile-time check against the Claude Code tool catalog import the typed
builders from [`vigiles/harness/claude-code`](harness-claude-code.md).

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).
Guides: [spec format](../spec-format.md), [skills](../skills.md) and
[railway-oriented subagents](../railway-subagents.md).

## Typical tasks

### Describe a CLAUDE.md

A spec is the default export. References are checked when you compile: a missing
file, script or linter rule fails the build.

```ts
import { instructionFile, enforce, guidance, file, prose } from "vigiles/spec";

export default instructionFile({
  sections: {
    scope: prose`Read ${file("docs/README.md")} before changing the docs.`,
  },
  rules: {
    "no-console": enforce("eslint/no-console", "Use the structured logger."),
    "keep-it-short": guidance("Keep each section under 30 lines."),
  },
});
```

### Describe a skill with gated steps

```ts
import { experimental_skill, cmd, project, prose } from "vigiles/spec";

export default experimental_skill({
  name: "ship-pr",
  description: "Run the checks and open a PR once they pass",
  inputs: [experimental_skill.input("branch", "branch to open the PR from")],
  body: prose`## Reference\n\nDomain knowledge the model reads.`,
  steps: [
    experimental_skill.step("Run the linter and fix issues.", {
      gate: cmd("npm run lint"),
    }),
    experimental_skill.step("Run the tests; fix until green.", {
      gate: project("test"),
      retry: 3,
    }),
  ],
  postcondition: project("test"),
});
```

### Give a subagent a typed result

```ts
import { experimental_agent, file, prose } from "vigiles/spec";
const { result } = experimental_agent;

export default experimental_agent({
  name: "implementer",
  description: "Implement the planned change and report what it touched.",
  tools: ["Read", "Edit", "Bash"],
  output: result(
    { files: "string[]", summary: "string" },
    { reason: "string", step: "string" },
  ),
  body: prose`Finish with the vigiles:ok block. See ${file("docs/spec-format.md")}.`,
});
```

### Assert a subagent's outcome without a model judge

```ts
import { experimental_agent, experimental_assertAgentOk } from "vigiles/spec";
const { result } = experimental_agent;

const implementer = result(
  { files: "string[]", summary: "string" },
  { reason: "string", step: "string" },
);

// Throws unless `output` ends with a valid ok block; returns the typed value.
const ok = experimental_assertAgentOk(output, implementer);
console.log(ok.files);
```

## Exports

### Instruction files and rules

- `instructionFile`: define the spec of a `CLAUDE.md` or `AGENTS.md`.
- `enforce`: a rule backed by an external tool; compile verifies the linter rule exists and is enabled.
- `guidance`: a prose-only rule, optionally with a `details` link into a file.
- `guard`: a rule that runs a command when watched files change.
- `prose`: a tagged template for text that embeds verified references.
- `experimental_effect`: a tagged template that marks a side-effect boundary inside a body.

### Verified references

- `file`: a path, checked to exist.
- `cmd`: a command, checked against `package.json` scripts.
- `symbol`: a symbol in a file, checked to be defined there.
- `ref`: another skill or instruction file, rendered as a link.
- `dir`: a directory, checked to exist.
- `glob`: a pattern, checked to match at least one path.
- `project`: a portable gate that resolves to the host project's `test`, `build` or `lint` command.

### Skills and subagents

- `experimental_skill`: define a `SKILL.md`; its `.input` and `.step` members declare arguments and gated steps.
- `experimental_agent`: define a subagent; its members (`result`, `delegate`, `railway`, `needs`, `pipeStep`, `start`, `andThen`, `pipe`) build typed outcomes and compositions.
- `experimental_assertAgentOk`: parse a subagent's final text against its `result()` and return the ok value, or throw.

### Types: specs and rules

- `ClaudeSpec`: what `instructionFile` returns.
- `InstructionTarget`: a file the spec compiles to, such as `CLAUDE.md` or `AGENTS.md`.
- `InstructionFragment`: a piece of prose or a reference inside a template.
- `EffectRegion`: the fragment `experimental_effect` returns.
- `Rule`: any rule a spec can hold.
- `EnforceRule`: a rule made by `enforce`.
- `GuidanceRule`: a rule made by `guidance`.
- `GuardRule`: a rule made by `guard`.
- `RuleDetails`: a `details` link, a file plus an optional heading anchor.
- `RuleDetailsOptions`: the `details` and `anchor` options of `guidance` and `enforce`.
- `RuleRender`: how a rule is rendered into the compiled file.
- `EnforcementRef`: any reference to an enforcement tool.
- `LinterRule`: a linter rule such as `eslint/no-console`.
- `BuiltinLinter`: the linter names vigiles knows.
- `StrictLinterRule`: `LinterRule` narrowed to the enabled rules when generated types exist.
- `VigilesRef`: a rule vigiles checks itself, `vigiles/<id>`.
- `Gate`: a command, file or role a skill step or postcondition must satisfy.
- `RoleGate`: the gate `project` returns.
- `ProjectRole`: the roles `project` accepts.

### Types: references

- `Ref`: any reference from the list above.
- `FileRef`, `CmdRef`, `SymbolRef`, `SkillRef`, `DirRef`, `GlobRef`: what `file`, `cmd`, `symbol`, `ref`, `dir` and `glob` return.
- `VerifiedRef`, `VerifiedPath`, `VerifiedCmd`, `VerifiedDir`, `VerifiedGlob`: strings branded as checked.
- `StrictFile`, `StrictCmd`: `file` and `cmd` arguments narrowed to known paths and scripts when generated types exist.
- `KnownLinterRules`, `KnownNpmScripts`, `KnownProjectFiles`: the interfaces `npx vigiles generate types` fills in.

### Types: skills

- `SkillSpec`: what `experimental_skill` returns.
- `SkillSpecInput`: what `experimental_skill` accepts.
- `SkillInput`: one declared argument.
- `SkillStep`: one gated step.

### Types: subagents and pipelines

- `AgentSpec`: what `experimental_agent` returns.
- `AgentSpecInput`: what `experimental_agent` accepts.
- `TypedAgentSpec`: an `AgentSpec` that remembers its `result()` shapes.
- `AuthoredPurity`: the `purity` values you can write: `pure`, `bounded` or `dangerously-unrestricted`.
- `AllowedAt`: the tools a purity level admits.
- `ToolVocabulary`: the tool names a harness allows at each purity level.
- `OpenToolVocabulary`: the default vocabulary, which accepts any tool.
- `OutputContract`: a subagent's declared success and error shapes.
- `OutputFieldType`: the field types a result can hold.
- `Shape`: a record of field names to field types.
- `OkOf`: the ok shape of a typed agent.
- `TypedOutcome`: the type-level carrier of an agent's success and error shapes.
- `Railway`: a finite sequence of subagents with a bounded error track.
- `RailwayStep`: one `delegate` step of a `Railway`.
- `Pipeline`: a typed chain of subagents whose handoffs are checked at compile time.
- `PipeStep`: one step of a `Pipeline`.
- `NeedsContract`: what a step needs from the step before it.
- `Supplies`: the type that says whether one step's ok shape satisfies the next step's needs.
- `Handoff`: the cross-file check that a producer's ok shape feeds a consumer.
- `KnownAgentName`: the agent names `delegate` accepts, filled in by generated types.
