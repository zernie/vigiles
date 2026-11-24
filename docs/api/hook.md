# `vigiles/hook`

The vocabulary for authoring a **compiled hook**: a pure typed function from an
event to a decision, which `vigiles compile` turns into the harness's hook
protocol. You never write the exit code, the JSON field or the matcher.

**For:** hook authors. This entry is the **only** import a compiled hook may
have, and it does no file, process or module loading, so a hook built from it
can only decide. Testing a hook is a separate entry,
[`vigiles/hook/testing`](hook-testing.md), so no test helper is reachable from
inside a hook.

The six `experimental_define*` builders carry the experimental marking for the
whole vocabulary: every other name here is only reachable from inside one of
them. For the roles, the vocabulary in depth, compiling and wiring, and the
limits, read [Compiled hooks](../compiled-hooks.md).

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).

## Typical tasks

### Block a dangerous shell command

A Bash gate sees the command as a parsed `ShellCommand`, so `runs` catches the
operation in any spelling, including inside `cd x && …` or `bash -c "…"`.

<!-- vigiles:check -->

```ts
import { experimental_defineHook, deny, allow } from "vigiles/hook";

export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true })
      ? deny("no force-push to a protected branch")
      : allow(),
});
```

Save it as `.vigiles/hooks/<name>.hook.mjs` (or `.hook.ts`) and run
`npx vigiles compile`. See [Compile and wire](../compiled-hooks.md#compile-and-wire).

### Keep edits inside a directory

A file gate sees the path as a `FilePath`. Write prefixes repo-relative; the
runtime reconciles the absolute path the harness sends.

<!-- vigiles:check -->

```ts
import { experimental_defineFileGate, tools, allow, deny } from "vigiles/hook";

export default experimental_defineFileGate({
  on: "PreToolUse",
  match: tools("Edit", "Write"),
  decide: (e) =>
    e.path.under(["src", "docs"]) ? allow() : deny("edit only src/ and docs/"),
});
```

### Refuse a prompt, or keep the agent going

<!-- vigiles:check -->

```ts
import {
  experimental_definePromptGate,
  experimental_defineStopGate,
  deny,
  allow,
} from "vigiles/hook";

export const secrets = experimental_definePromptGate({
  on: "UserPromptSubmit",
  decide: (e) =>
    /sk-[a-z0-9]{20}/i.test(e.prompt)
      ? deny("your prompt looks like it contains a secret key")
      : allow(),
});

export const untilGreen = experimental_defineStopGate({
  on: "Stop",
  decide: (e) =>
    e.stopHookActive ? allow() : deny("keep going until `npm test` passes"),
});
```

A compiled hook file has one default export; the two are shown side by side
here only to save space.

### Add context, or react after a tool ran

An inject returns an `Injection` and has no `deny`. A react runs after the tool,
so it cannot block: it returns `run(cmd)`, `notice(msg)` or `nothing()`.

<!-- vigiles:check -->

```ts
import {
  experimental_defineInject,
  experimental_defineReact,
  inject,
  notice,
  nothing,
  tools,
} from "vigiles/hook";

export const briefing = experimental_defineInject({
  on: "SessionStart",
  produce: () => inject("Run `npm run check` before you open a PR."),
});

export const onFailure = experimental_defineReact({
  on: "PostToolUse",
  match: tools("Bash"),
  react: (e) =>
    e.response.isError() ? notice("read the error before retrying") : nothing(),
});
```

### Decide on repository state

A hook does no I/O. It declares the facts it needs, and the runtime gathers them
and hands them in as `e.ctx`. Reading an undeclared fact is a `tsc` error.

<!-- vigiles:check -->

```ts
import { experimental_defineHook, deny, allow, provide } from "vigiles/hook";

export default experimental_defineHook({
  on: "PreToolUse",
  needs: ["git.branch", provide("k8sCtx", "kubectl config current-context")],
  decide: (e) =>
    (e.ctx["git.branch"] === "main" && e.command.runs("git push")) ||
    (e.ctx.k8sCtx === "prod" && e.command.runs("kubectl delete"))
      ? deny("not against main or prod")
      : allow(),
});
```

### Remember a fact between calls

`state(key)` in `needs` reads a fact; `record(key, value?)` in the return value
writes one. The runtime owns where it lives.

<!-- vigiles:check -->

```ts
import {
  experimental_defineReact,
  state,
  record,
  run,
  nothing,
} from "vigiles/hook";

export default experimental_defineReact({
  on: "Stop",
  needs: [state("calendar.synced")],
  react: (e) =>
    e.ctx["calendar.synced"].olderThan("1h")
      ? run("./bin/sync-calendar.sh", record("calendar.synced"))
      : nothing(),
});
```

More: [Remembering a fact](../compiled-hooks.md#remembering-a-fact--state-and-record),
and to seed a fact in a test, `experimental_hookState` on
[`vigiles/hook/testing`](hook-testing.md).

## Exports

### Roles (the entry points)

| Name                            | What it is                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `experimental_defineHook`       | A Bash tool gate (`PreToolUse`): `decide(e)` returns a `Decision`, with `e.command` a `ShellCommand`.    |
| `experimental_defineFileGate`   | A file tool gate (`PreToolUse` on Edit/Write): `decide(e)` gets `e.path`, a `FilePath`.                  |
| `experimental_definePromptGate` | A prompt gate (`UserPromptSubmit`): `decide(e)` gets `e.prompt`; `deny` blocks the prompt.               |
| `experimental_defineStopGate`   | A stop gate (`Stop` / `SubagentStop`): `deny` keeps the agent going; honour `e.stopHookActive`.          |
| `experimental_defineInject`     | An inject (`SessionStart` / `UserPromptSubmit`): `produce(e)` returns an `Injection`; it cannot block.   |
| `experimental_defineReact`      | A react (`PostToolUse`, `Stop`): `react(e)` returns a `Reaction`; it sees `e.response` and cannot block. |

Every gate takes `mode`: `"enforce"` (the default) or `"observe"`, which records
what it would have blocked and lets everything through
([Observe mode](../compiled-hooks.md#observe-mode-shadow-rollout)).

### Outputs

| Name                       | What it is                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `allow`, `deny`, `ask`     | A gate's `Decision`. `deny(reason)` is the only one that blocks; `ask(reason)` defers to the user.    |
| `inject`                   | An inject's output: context text added for the model.                                                 |
| `run`, `notice`, `nothing` | A react's output: run a command (its effect is classified when built), tell the agent, or do nothing. |
| `tools`                    | Which tools a file gate or a react matches; the names keep their literal types.                       |
| `responseView`             | Build the `ResponseView` a react reads from a raw tool response (`isError()`, `contains()`).          |

### Facts a hook may declare in `needs`

| Name             | What it is                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `provide`        | An inline fact from a provably read-only command; `compile` rejects any other command.            |
| `dangerously`    | An inline fact from a command that is not provably read-only: the loud, greppable escape.         |
| `defineProvider` | Declare a reusable provider in `.vigiles/providers/<name>.provider.{mjs,ts}`.                     |
| `provider`       | Reference a registered provider by name.                                                          |
| `state`          | Read a remembered fact; it arrives as a `StateFact`.                                              |
| `record`         | Write a fact, declared in the return value of a hook, so recording and acting cannot drift apart. |

The built-in facts are `git.branch`, `git.isDirty`, `git.root`, `cwd`,
`os.platform` and `env.isCI` ([Deciding on external state](../compiled-hooks.md#deciding-on-external-state-context-providers)).

### Types: events

| Type             | What it describes                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `BashToolEvent`  | What a Bash gate decides on: `command`, `ctx`.                                                        |
| `FileToolEvent`  | What a file gate decides on: `path`, `ctx`.                                                           |
| `PromptEvent`    | What a prompt gate decides on: `prompt`, `ctx`.                                                       |
| `StopEvent`      | What a stop gate decides on: `stopHookActive`, `ctx`.                                                 |
| `SessionEvent`   | What an inject produces from: the event name, its `source`, `ctx`.                                    |
| `ReactEvent`     | What a react sees: the tool response and `ctx`.                                                       |
| `BashReactEvent` | A react declared for Bash alone: a `ReactEvent` plus `command`.                                       |
| `ToolReactEvent` | Any other react: no `command` field, so reading one is a `tsc` error.                                 |
| `ShellCommand`   | The parsed command: `runs`, `touches`, `writesTo`, `writeTargets`, `pipesToShell`, `isSideEffecting`. |
| `FilePath`       | The path of a file tool: `under(prefixes)`, `raw`, `rel`.                                             |
| `ResponseView`   | A tool response as a react reads it: `isError()`, `contains(needle)`.                                 |

### Types: hooks and their outputs

| Type             | What it describes                                                       |
| ---------------- | ----------------------------------------------------------------------- |
| `HookProgram`    | What `experimental_defineHook` returns: a Bash gate.                    |
| `FileGateHook`   | What `experimental_defineFileGate` returns.                             |
| `PromptGateHook` | What `experimental_definePromptGate` returns.                           |
| `StopGateHook`   | What `experimental_defineStopGate` returns.                             |
| `InjectHook`     | What `experimental_defineInject` returns.                               |
| `ReactHook`      | What `experimental_defineReact` returns.                                |
| `AnyHook`        | Any of the six; what the test runners on `vigiles/hook/testing` accept. |
| `HookMode`       | `"enforce"` or `"observe"`.                                             |
| `Decision`       | A gate's output: allow, deny or ask, with a reason.                     |
| `Injection`      | An inject's output.                                                     |
| `Reaction`       | A react's output: a run, a notice or nothing.                           |
| `RunReaction`    | The `run(cmd)` reaction, carrying the command's classified effect.      |

### Types: facts and state

| Type                 | What it describes                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `HookCtx`            | The typed `e.ctx`: exactly the facts declared in `needs`.                                                       |
| `NeedSpec`           | One entry of `needs`: a built-in name, an inline or registered provider, or a `state`.                          |
| `ProviderName`       | A built-in fact name.                                                                                           |
| `ProviderResults`    | The built-in facts and their value types.                                                                       |
| `InlineProvider`     | What `provide` and `dangerously` return.                                                                        |
| `RegisteredProvider` | What `defineProvider` returns.                                                                                  |
| `RegisteredRef`      | What `provider(name)` returns.                                                                                  |
| `ProviderRegistry`   | Registered providers by name.                                                                                   |
| `StateFact`          | A remembered fact: `recorded`, `value`, `at`, `ageSeconds` (`Infinity` when never), `fresherThan`, `olderThan`. |
| `StateNeed`          | What `state(key)` returns.                                                                                      |
| `StateWrite`         | What `record(key, value?)` returns.                                                                             |
| `Duration`           | A span such as `"90s"`, `"30m"`, `"1h"`, `"7d"`.                                                                |
