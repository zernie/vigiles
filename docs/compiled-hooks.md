# Compiled hooks — author a hook that can't be wrong

> ⚠️ **Compiled hooks are experimental.** They compile, they run in production in
> two repos, and every property below is tested — but the authoring vocabulary is
> not settled, and it is not covered by semver. The six entry points are named
> `experimental_defineHook`, `experimental_defineFileGate`,
> `experimental_definePromptGate`, `experimental_defineStopGate`,
> `experimental_defineInject` and `experimental_defineReact`. **Write them out at
> every call site** — do not alias the prefix away at the import. This notice used
> to advise exactly that, and the advice defeated the mechanism it was attached
> to: measured 2026-08-21, with the alias in place the marker survived at **0 of
> 5** call sites in the only user-facing example, because a reader 200 lines down
> sees `defineHook(...)` and cannot tell it is provisional. A prefix stripped on
> import is a subpath with extra steps.
> [What would have to be true to drop the prefix](#status--pending).
>
> **Stable alternative:** a hand-written shell hook wired in `settings.json`. Same
> events, same protocol, none of the guarantees this page is about.

**A hook is the harness's deterministic gate: the one place that can _stop_ the agent before it does something irreversible.** But a hook today is opaque shell (`bash guard.sh`), and the parts you hand-write are exactly the parts that fail silently. The [README](../README.md) has the pitch; this is the full guide.

vigiles lets you author a hook as a **pure typed function** `(event) => Decision` against a **closed vocabulary** (`vigiles/hook`), then compiles it to the harness protocol. The point isn't ergonomics — it's that **whole classes of hook bugs become unrepresentable**: you can't write the bug because the API has no way to express it.

## Contents

- [The bug classes it eliminates](#the-bug-classes-it-eliminates)
- [The roles](#the-roles)
- [The vocabulary](#the-vocabulary)
- [Testing a hook that remembers](#testing-a-hook-that-remembers)
- [Observe mode (shadow rollout)](#observe-mode-shadow-rollout)
- [Deciding on external state (context providers)](#deciding-on-external-state-context-providers)
- [Compile and wire](#compile-and-wire)
- [Where things live](#where-things-live)
- [Testing a compiled hook](#testing-a-compiled-hook)
- [Proof: the OSS dogfood](#proof-the-oss-dogfood)
- [Limitations & trade-offs (the cons)](#limitations--trade-offs-the-cons)
- [See also](#see-also)

## The bug classes it eliminates

**A compiled hook eliminates an entire class of bugs by construction** — not by catching them after the fact, but by making them impossible to write. Each row below is a _verified_, common failure of hand-written hooks (sources linked):

| Bug class                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why it can't happen                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False confidence** — the #1 pain: `exit 1` instead of `exit 2`, the wrong JSON field (`decision` vs `permissionDecision`), a wrong `jq` path → a guard that _looks_ like it blocks and silently allows ([RFC #45427](https://github.com/anthropics/claude-code/issues/45427), [#24327](https://github.com/anthropics/claude-code/issues/24327)).                                                                                                                                                                                                                                                                                                                     | You never write the protocol. You return `deny(reason)`; the compiler emits the correct exit code / JSON field for the event. The bug has no place to live.                                                                               |
| **Matcher bypass** — neither `Bash(git push:*)` nor `Bash(git push *--force*)` matches an ABSOLUTE program head, so `/usr/bin/git push --force` never spawns the hook (measured on 2.1.263, `tools/measure-if-matcher-forms.mjs`; it holds for the prefix spelling Anthropic ships in its own `security-guidance` plugin). A hand-written `grep` misses its own set. ⚠️ This row used to cite [#30519](https://github.com/anthropics/claude-code/issues/30519) and claim the native matcher misses `cd repo && git push -f`; the same run caught that compound command in both spellings, so the claim is withdrawn pending a focused re-measure rather than repeated. | `command.runs("git push", { force: true })` is **AST-backed** — it sees the real `git push` leaf however it's wrapped (compound, subshell, pipeline). A `grep` false-_positive_ is gone too.                                              |
| **Capability creep / supply chain** — a hook is arbitrary code; a copied or edited one can read secrets or phone home ([CVE-2025-59536](https://www.cve.org/CVERecord?id=CVE-2025-59536)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Capability = API surface.** An `import` of anything but `vigiles/hook` (or `eval`/`Function`) **does not compile**. The compiled artifact is **stamped** (SHA-256) — a later hand-edit breaks the stamp and the runtime **refuses** it. |
| **Category mistakes** — "block on a `SessionStart`/`PostToolUse` hook", whose decision is a documented no-op ([#4362](https://github.com/anthropics/claude-code/issues/4362)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Each role has its own return type. An inject/react hook has **no `deny`** in its vocabulary, so the mistake is a **`tsc` type error**, not a silent no-op.                                                                                |

The unifying idea: a hook is a tiny program, and a closed, typed vocabulary shrinks its state space until the bad states are simply not expressible.

## The roles

**A hook's output depends on when it fires.** vigiles gives each role its own builder and its own return type, so the wrong output for an event won't type-check:

- **`experimental_defineHook` / `experimental_defineFileGate`** — a **tool gate** (`PreToolUse`). Returns a `Decision`: `allow()`, `deny(reason)`, or `ask(reason)`. `deny` is the only thing that blocks; the compiler maps it to `exit 2`. `experimental_defineHook` sees the Bash command (`e.command`); `experimental_defineFileGate` sees the file path (`e.path`).
- **`experimental_definePromptGate`** — a **prompt gate** (`UserPromptSubmit`). Sees the prompt **text** (`e.prompt`) and returns a `Decision`. `deny` blocks/erases the prompt — useful as a security filter that refuses a prompt leaking a secret or carrying an injection.
- **`experimental_defineStopGate`** — a **stop gate** (`Stop` / `SubagentStop`). Returns a `Decision`. `deny` keeps the agent **going** (gate-until-tests-pass; the reason is fed back to the model). Honour `e.stopHookActive` (the loop guard): `allow` when it's set, or you can wedge the agent in a stop→continue loop.
- **`experimental_defineInject`** — an **inject** (`SessionStart` / `UserPromptSubmit`). Returns an `Injection` (`inject(text)`) — context added to the model. It has **no `deny`**: a no-decision event can't block.
- **`experimental_defineReact`** — a **react** (`PostToolUse`). Returns a `Reaction` — `run(cmd)`, `notice(msg)`, or `nothing()`. The tool already ran, so it **can't block**. It sees the tool's **response** (`e.response`, e.g. react only on a failure), and `run(cmd)`'s effect is **classified at construction** (read-only / side-effecting), so every reaction is auditable without running it. A `notice(msg)` reaches the agent as injected context — see [Where a notice arrives](#where-a-notice-arrives).

Every **gate** (tool / prompt / stop) takes an optional `mode` — see [Observe mode](#observe-mode-shadow-rollout).

## The vocabulary

The entire surface a hook may touch (that's the safety guarantee):

```ts
import { experimental_defineHook, deny, allow } from "vigiles/hook";

// Block any force-push to a protected branch — including one hidden in a
// compound command, which a glob/grep matcher misses.
export default experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true })
      ? deny("no force-push to a protected branch")
      : allow(),
});
```

- **`tools(...names)`** — which tools a file gate or react matches. A bash gate
  needs none: a `BashToolEvent` is Bash by construction, so the matcher is emitted
  for you and there is no field to get wrong.
- **`e.command`** (Bash) — an AST-backed `CommandView`:
  - `runs(program, { force? })` — a leaf runs `program` (e.g. `"git reset --hard"`), optionally forced.
  - `touches(prefixes)` — a leaf **mentions** a path under one of `prefixes` (e.g. `["~/.ssh", ".env"]`) — secret reads.
  - `writesTo(prefixes)` — a leaf **creates or modifies** a file under one of `prefixes`: redirection targets (`cmd > f`, `>>`, `>|`, `&>`) plus the writing argv position of `sed -i`, `cp` / `mv` / `install` (destination), `tee`, `dd of=`, `truncate`, `shred`.
  - `writeTargets(prefixes)` — the same write targets as the **list of files** rather than a boolean, for a gate that has to tell _which_ file (`writeTargets(PAPER_SOURCES).some(isPaperSource)`); `writesTo` is exactly `writeTargets(prefixes).length > 0`. Spelling is as-written after normalization (quotes removed by the parser, `$HOME` canonicalized, a leaf's own `env -C` / `sudo -D` directory resolved), duplicates collapsed — so filter by basename or suffix. `prefixes` is required and there is no unfiltered form: a consumer holding the raw list has to re-implement prefix matching by hand, which is where every measured gate bypass came from.
  - `pipesToShell()` — pipes into a bare shell (`curl … | sh`) — remote-code execution. A shell _with_ a script file (`sh deploy.sh`) is **not** flagged.
  - `isSideEffecting()` — the deterministic Bash-effect classifier's verdict.

  > **`touches` ≠ `writesTo` — conflating them is the trap.** `touches` answers _mentioned_: `grep -c x notes/S.md` matches, and so does `rm -rf notes`. `isSideEffecting()` does not rescue it, because it classifies the **whole command line** — `grep -c x notes/S.md 2>/dev/null` is side-effecting (there's a redirection), so a `touches() && isSideEffecting()` gate blocks a plain read. Use `writesTo` to gate writes and `touches` for "don't even look at this path". Deletion is reported by neither — pair with `runs("rm")` if a gate needs it.

  > **Both are DENYLISTS, so they over-block on purpose — the opposite bias from `under` below.** A miss here is an **allow**, not silence, so an answer the matcher cannot prove is reported as a **match**. Concretely: a token spelled absolutely (`/home/u/repo/notes/x.md`) matches `touches(["notes"])` whether or not a project root is available, and a token in a _sibling_ checkout matches too, because a repo-relative prefix cannot rule it out. Prefix spelling is forgiving in the same direction — `"notes"`, `"notes/"` and `"notes/**"` all name the same directory.
  >
  > Bounded, though: the prefix's path segments must actually occur in the token, so ordinary commands stay untouched. Two cases still miss, and both belong to the parser rather than the matcher — `cd notes && cat x.md` (a leaf's argument is not resolved against a preceding `cd`), and an _absolute_ prefix against a _relative_ token when no root is available at all.
  >
  > Until 2026-08-12 this bias did not exist: `touches` compared a repo-relative prefix against a raw token with no root anywhere in `decideProgram`, so **spelling a path absolutely walked straight past any gate written with a relative prefix.** Measured against a real shipped guard, `sed -i s/a/b/ <abs>/paper.tex` and `cp /tmp/a <abs>/paper.tex` both exited 0 while their relative spellings exited 2.

- **`e.path`** (Edit/Write) — a `PathView` with `under(prefixes)` for path confinement, plus `raw` (the path as the tool sent it) and `rel` (the same path repo-relative, or `undefined` — see below).

  > **Write your prefixes repo-relative; the runtime handles the rest.** Claude Code's Edit/Write/MultiEdit tools send an **absolute** `file_path`, so `under(["src"])` has to reconcile the two. It does that with the project root — `$CLAUDE_PROJECT_DIR`, else the event's own `cwd`, never the hook process's working directory (under a git worktree that can be a different checkout). An absolute prefix (`under(["/etc"])`) is matched against the absolute path instead, so both spellings work.
  >
  > `under` is the **allowlist / coverage** primitive, and an unprovable answer is `false`: a path in another checkout, or an absolute path with no root in sight, matches no repo-relative prefix. A confinement gate (`under(ok) ? allow() : deny()`) therefore fails closed, and a nudge stays quiet. The reverse shape — `under(secret) ? deny() : allow()` — reads that `false` as **allow**, so do not build a denylist on it. When there is genuinely no root, the runtime says so on stderr rather than deciding silently.
  >
  > Testing a file hook? Build the event with **`fileToolEvents(path)`** (from `vigiles`), which returns _both_ spellings. Hand-written relative events are what let three shipped hooks stay dead while their tests passed.

- **`e.prompt`** (UserPromptSubmit) — the user's prompt text (a plain string).
- **`e.stopHookActive`** (Stop) — the loop guard; `allow()` when it's `true`.
- **`e.response`** (PostToolUse react) — a `ResponseView`: `isError()` (the tool failed) and `contains(needle)`.
- **`allow()` / `deny(reason)` / `ask(reason)`** — the gate decision (every gate role).
- **`inject(text)`** — inject output. **`run(cmd)` / `notice(msg)` / `nothing()`** — react output.
- **`state(name)` in `needs`, `record(name, value?)` in a return** — **runtime-owned named memory**, so a hook can remember a fact without reaching for the filesystem. See below.

### Remembering a fact — `state()` and `record()`

A hook that should speak _at most once an hour_, or only _after something else actually happened_, has to remember something. By hand that means a stamp file: a path, a format, and two hooks racing for the same one — and it means the hook can reach the filesystem at all, which is the capability compiling took away.

So the hook does not write. It **declares** a fact, and the runtime writes it:

```ts
export default experimental_defineReact({
  on: "Stop",
  needs: [state("calendar.synced")],
  react: (e) =>
    e.ctx["calendar.synced"].olderThan("1h")
      ? run("./bin/remind.sh") // meanwhile whoever DID the sync returns
      : nothing(), //   record("calendar.synced")
});
```

> ⚠️ Two shapes worth pinning: the role is **`experimental_defineReact`** (a `react` is what returns `run()`/`nothing()`), and **`needs` is an array**. The fact lands on `e.ctx` under the key you named — `e.ctx["calendar.synced"]` — not under a label of your choosing.

A key is a **name, not a path** — the runtime decides where it lives, so two hooks cannot disagree about a file. Reading one gives a `StateFact`:

| field                                       | meaning                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `recorded`                                  | has this key **ever** been written — the only way to tell "never" from "long ago" |
| `value`                                     | the recorded string (`""` when never)                                             |
| `at`                                        | ISO-8601 instant (`""` when never)                                                |
| `ageSeconds`                                | seconds since — **`Infinity` when never recorded, never `null`**                  |
| `fresherThan(within)` / `olderThan(within)` | `"90s"`, `"30m"`, `"1h"`, `"7d"`                                                  |

> 🔴 **`Infinity` rather than `null` is a safety property, not a style choice.** The natural throttle is `if (ageSeconds < LIMIT) return nothing()`. In JavaScript `null < 3600` is `true`, so a key that was **never** recorded would read as _fresh_, and a newly installed hook would go silent forever — quietest exactly when it was just added. With `Infinity` every "younger than X" test is false on a missing key, so the hook fires. An unparseable timestamp is treated the same way, as never-recorded: that fails toward **noise** instead of toward a silence nobody can notice.

Throttling is not a separate feature — it is this one, read as "when did I last speak". And `record` is a **declaration in the return value**, not a call the hook makes, so a hook cannot record that something happened while doing nothing: the two cannot drift apart.

### Testing a hook that remembers

A throttle only does anything interesting against an **old** fact — and "old" is not something a test can produce by waiting. So the store is seedable, through one handle on the `vigiles` test surface:

```js
import { experimental_hookState, runHook } from "vigiles";

const st = experimental_hookState(hookFile, { cwd: projectRoot });
st.clear(); // start from "never recorded"

st.seed("retro.nagged", { ago: "4d" }); //  → the hook speaks
st.seed("retro.nagged", { ago: "10m" }); // → the hook stays quiet
st.seed("retro.nagged", { value: "main", at: someDate }); // exact instant

st.read("retro.nagged"); // the same StateFact the hook's e.ctx[key] gets

// …then run the hook for real and assert what it did with that fact.
const r = runHook(`npx vigiles hook-runtime run-program ${hookFile}`, event, {
  cwd: projectRoot,
});
```

| on the handle                   | what it does                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `seed(key, { ago, at, value })` | write a fact as if the hook had recorded it, then read it back; `ago` **backdates**     |
| `read(key)`                     | the fact exactly as `e.ctx[key]` will see it — `Infinity` when never recorded, no throw |
| `clear()`                       | forget the facts **this hook** recorded — a co-located hook's are left alone            |
| `dir`                           | where they live — for a failure message, **not** a path to build on                     |

Three things to know:

- **Pass the same `cwd` the hook will run under.** The store's location is derived from the hook's path and the project root, so a handle built with a different root points at a different (empty) store.
- **It writes through the runtime's own writer**, so a seeded fact and a recorded one are the same file. That is the point: a seeder with its own copy of the path rule agrees with the runtime only until someone edits the derivation, and then fails green.
- **The store is shared per DIRECTORY, and `clear()` is scoped to this hook's own writes.** That sharing is the feature — it is how one hook reads a fact another recorded — so hooks shipped side by side keep their facts in one place. `clear()` therefore forgets only what _this_ hook wrote, and leaves a co-located hook's facts (and any entry with no recorded owner) in place. When a test wants the store completely empty rather than this hook's share of it, give it a **throwaway `cwd`**: the store hangs off that root, so a fresh root is a fresh store.

It is on `vigiles`, **not** on `vigiles/hook`. `vigiles/hook` is the only import a compiled hook may have, and its guarantee is that it hands out no writer — so the seeding handle lives where a test can reach it and a hook cannot.

A prompt gate and a stop gate read like any other gate — they just decide over a different event:

```ts
import { experimental_definePromptGate, deny, allow } from "vigiles/hook";

// Refuse a prompt that looks like it's pasting a secret key.
export default experimental_definePromptGate({
  on: "UserPromptSubmit",
  decide: (e) =>
    /sk-[a-z0-9]{20}/i.test(e.prompt)
      ? deny("your prompt looks like it contains a secret key")
      : allow(),
});
```

```ts
import { experimental_defineStopGate, deny, allow } from "vigiles/hook";

// Don't let the agent stop while the tests are red.
export default experimental_defineStopGate({
  on: "Stop",
  decide: (e) =>
    e.stopHookActive // a prior block already fired — let it stop now (loop guard)
      ? allow()
      : deny("keep going until `npm test` passes"),
});
```

## Observe mode (shadow rollout)

**Switching a new gate straight to blocking is risky.** What if it's too aggressive and stops work you wanted? Every gate takes a `mode`:

- **`enforce`** (default) — block on `deny`.
- **`observe`** — the **shadow / rollout** mode: compute the same decision, **record** what it _would_ have blocked, and **let everything through**. Watch the log, confirm it only flags the bad stuff, then promote to `enforce`.

```ts
export default experimental_defineHook({
  on: "PreToolUse",
  mode: "observe", // ← shadow: record, don't block
  decide: (e) =>
    e.command.runs("git push", { force: true })
      ? deny("force-push to a protected branch")
      : allow(),
});
```

In observe mode the runtime exits `0` (never blocks) and appends a record to **`.vigiles/hook-observations.jsonl`** (`{ ts, hook, event, would, reason }`) plus a one-line `⚠ [vigiles observe]` note. It's **harness-neutral** — exit 0 + a local record behaves identically on Claude Code and Codex, no harness-specific field names involved.

## Deciding on external state (context providers)

**A pure gate can only see the command/path/prompt/response.** But a real guard often needs external state to decide — "is this a push to `main`?", "is the tree dirty?". A hand-written hook would shell out (`$(git branch --show-current)`); a compiled hook **can't do I/O** (that's the capability guarantee).

The fix is the same one Cedar/OPA/Gatekeeper use: **the hook never fetches — it declares what it needs, and the trusted runtime gathers those read-only facts and hands them in** as `e.ctx`.

```ts
import { experimental_defineHook, deny, allow } from "vigiles/hook";

export default experimental_defineHook({
  on: "PreToolUse",
  needs: ["git.branch"], //                ← declared; gathered by the runtime
  decide: (e) =>
    e.ctx["git.branch"] === "main" && e.command.runs("git push")
      ? deny("no direct pushes to main")
      : allow(),
});
```

The guarantee is intact and **stronger**: the hook still does zero I/O. The runtime runs `git branch --show-current` (provably read-only) and injects the result. `needs` is **typed** — reading an undeclared fact (`e.ctx["cwd"]` here) is a `tsc` error, and an unknown provider name **won't compile** — so the capability surface stays explicit and auditable.

**Built-in providers:** `git.branch`, `git.isDirty`, `git.root`, `cwd`, `os.platform`, `env.isCI` — zero-arg, read-only. A provider that can't resolve (e.g. not a git repo) yields its default, never an error. The set is deliberately small. A 20+ OSS survey found most facts a hook reads are already event data, and the long tail belongs in the opt-out, not a growing catalog. (`env.isCI` uses the [`ci-info`](https://www.npmjs.com/package/ci-info) library — the one fact where a maintained lib beat hand-rolling. Git facts stay read-only shell commands; platform is `process.platform`.)

**The lightweight opt-out — `provide` / `dangerously`.** For a one-off, off-catalog fact you don't want to register a whole provider for, declare an **inline** command right in `needs`:

```ts
import { experimental_defineHook, deny, allow, provide } from "vigiles/hook";

export default experimental_defineHook({
  on: "PreToolUse",
  needs: [provide("k8sCtx", "kubectl config current-context")], // read-only, inline
  decide: (e) =>
    e.ctx.k8sCtx === "prod" && e.command.runs("kubectl delete")
      ? deny("no kubectl delete against prod")
      : allow(),
});
```

The trusted runtime runs the command (so `decide` still does zero I/O) and hands its stdout in as `e.ctx[name]`. `provide(name, cmd)` requires a **provably read-only** command (compile rejects it otherwise). `dangerously(name, cmd)` is the **loud, greppable escape** for a command that isn't — the `dangerouslySetInnerHTML` / `unsafe` convention, so a security review can search for that one word.

**Reusable registered providers.** For a fact several hooks share, register it once in `.vigiles/providers/<name>.{mjs,ts}` and reference it by name:

```ts
// .vigiles/providers/k8sCtx.mjs
import { defineProvider } from "vigiles/hook";
export default defineProvider({
  name: "k8sCtx",
  run: "kubectl config current-context",
});

// any hook:  needs: [provider("k8sCtx")]  →  e.ctx.k8sCtx
```

`vigiles compile` validates each provider is read-only (or `dangerous: true`) and that every `provider()` ref resolves to a registered file.

**The opt-out ladder** (you're **never trapped**): built-in providers → inline `provide` / `dangerously` → **registered `defineProvider`** (reusable, named) → the **shell lane** (a hand-written `.sh` for arbitrary in-decision logic, verified with the disaster battery). You always know which rung you're on.

## Compile and wire

**Put your hook source in `.vigiles/hooks/`.** The typed program is harness-neutral — it imports `vigiles/hook` and compiles to _whichever_ harness you target — so it lives in vigiles's own dir, not a harness's `.claude/`. Then:

```bash
npx vigiles compile                                  # discovers .vigiles/hooks/* (and your specs)
npx vigiles compile .vigiles/hooks/safe-bash-guard.mjs   # …or target one file
```

There is **no separate `compile-hook` verb** — compiling a typed authoring artifact into the harness's native format is _one_ verb, whatever the artifact (a `.spec.ts` → markdown, a hook → a wired config). `compile`:

1. Runs the **capability check** (an out-of-vocabulary import fails the build).
2. **Merges** the hook block into the active harness's config — `.claude/settings.json` (JSON) or `.codex/config.toml` (TOML) — **idempotently**, keyed by the hook path. Recompiling updates in place and never clobbers your own hand-written hooks.
3. Writes a **tamper-evident stamp** beside the source.

The merged block routes the live event to **`vigiles hook-runtime run-program <file>`**:

```jsonc
// .claude/settings.json — written (not pasted) by `vigiles compile`
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "npx vigiles hook-runtime run-program .vigiles/hooks/safe-bash-guard.mjs",
          },
        ],
      },
    ],
  },
}
```

`hook-runtime run-program` is a **hidden runtime entrypoint** — invoked by the harness on every matching event, never typed by hand. It loads your typed program, **verifies the stamp** (a hand-edited artifact is refused — fail closed), and dispatches by role: a gate `exit 2`s on `deny`, an inject prints `additionalContext`, a react runs its classified command. You wrote none of that protocol. (`compile` is the one-time _wiring_ step; `hook-runtime` is the per-event _executor_ the wiring points at — see the [CLI surface](cli.md) for why they're distinct.)

Hooks can be authored in JavaScript (`.mjs`) or TypeScript (run under `tsx` / Node ≥ 23.6). `vigiles/hook` is the **only** import a compiled hook may use.

**Multi-harness.** The typed program is harness-neutral; only the merged config differs. `vigiles compile --harness=codex` merges a Codex `config.toml` `[[hooks.<event>]]` block (an anchored-regex matcher) instead of Claude Code's `settings.json` JSON. **A repo that declares both harnesses** (`harness: ["claude-code", "codex"]` in `.vigilesrc.json`) gets the SAME hook installed into **both** configs — `vigiles compile` (no flag) fans out to every declared harness, so a hook is never silently wired on one and missing on the other. The gate runtime is shared, since Codex vetoes a tool call via `exit 2` exactly as Claude Code does. **Inject** output (`additionalContext`) is confirmed shared with Codex too, so an inject hook compiles for both — `compile --harness=codex` only warns if you target an event that harness doesn't honor for injection (each harness declares its `injectableEvents`). **React** output is the one piece still Claude-Code-confirmed only, so `compile --harness=codex` warns loudly on a react hook rather than ship a maybe-no-op.

## Where things live

Everything is committed, and the source is **adapter-agnostic** — one hook compiles to any harness you target:

| Artifact            | Location                                       | Why                                                                 |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| **Hook source**     | `.vigiles/hooks/*.{mjs,ts}`                    | harness-neutral — one source, fans out to any harness               |
| **Provider source** | `.vigiles/providers/*.{mjs,ts}`                | registered context providers (`defineProvider`), referenced by name |
| **Tamper stamp**    | `.vigiles/hooks/<name>.json`                   | the runtime verifies it before running the hook                     |
| **Wiring**          | `.claude/settings.json` / `.codex/config.toml` | `compile` merges it in per harness (a multi-harness repo gets both) |

Hooks are **not** auto-discovered by sitting just anywhere — they must be under `.vigiles/hooks/` (or named explicitly to `compile`). Because they share one dir, basenames are unique, so the stamp keys safely on the basename.

### Editing a compiled hook (the stamp, and the way out)

The stamp makes the runtime **refuse** a hook whose source no longer matches what was compiled. That's the point — but it also applies while **you** are editing the hook, and a stale `PreToolUse` Bash gate blocks _every_ Bash command, `vigiles compile` included. That would wedge the repo: you couldn't recompile, because the stale gate refused to let you.

**The way out is a file write, not a command.** A Bash gate never gated file tools, so both of these work while every command is refused:

- **edit the hook's source back** to what was compiled; or
- **clear its stamp** — write `{}` into `.vigiles/hooks/<name>.json` (or delete it). The hook then loads and runs **unstamped**, and — this is the part that matters — it goes back to **enforcing**. You are not disarming the gate, you are un-sticking it. Then recompile through the normal gate:

```bash
npx vigiles compile .vigiles/hooks/guard.mjs
```

The refusal prints the exact sidecar path, so you don't have to work it out:

```
vigiles: hook guard.mjs does not match its compiled stamp (tampered).
vigiles: if YOU edited it, the way out is a FILE WRITE, not a command — this
  refusal blocks the recompile too. Either edit guard.mjs back to what was
  compiled, or clear its stamp by writing `{}` into
  /repo/.vigiles/hooks/guard.mjs.json. The hook then runs UNSTAMPED but still
  ENFORCES, so `vigiles compile guard.mjs` goes through the normal gate.
```

If a hook stops **loading** entirely (a conflicted `package.json` so Node can't resolve `vigiles/hook`, a typo mid-edit), the same fail-closed refusal applies — and the way out is again a **file write**. Writes to the hook's own source, its stamp sidecar, or `package.json` / `.vigilesrc.json` are allowed while every command is refused. That set is complete rather than a guess: a compiled hook may import nothing but `vigiles/hook`, so its load path is the hook file plus the config that resolves that specifier. Fix whichever is broken and the hook loads again; the gate then decides normally, and `git merge --abort` is an ordinary allowed command — through the gate rather than around it.

**A write, under a tool that writes.** The escape admits `Write`, `Edit` and `MultiEdit` — the tools measured to write a file and carry `file_path`. A `Read` of the same path is refused: a read repairs nothing, and while the wedged hook is registered for `Read` it would otherwise walk straight out through the escape. An unrecognised tool name is refused as well; the list does not need to be complete, only non-empty, because a _new_ writing tool wedges nothing — you still repair with `Write`. (`NotebookEdit` is absent on purpose: it writes, but its input field is `notebook_path`, so it never carries the path this door reads.)

**In this repository only.** The allowed write is the file the runtime itself derived, not a path that merely ends the same way: both the event's path and the runtime's are resolved against the project root before they are compared, so `/repo/package.json` and `package.json` are the same file while `/home/another-project/package.json` is refused. That path could not repair the failure anyway, and a wedge in one checkout has no business handing out a write in another. Node walks the `package.json` chain upward, so a monorepo package's own `package.json` **is** on the list; a sibling directory's is not.

> **Why no command is allowed, including git.** `git merge --abort`, `git rebase --abort` and `git checkout -- <path>` used to be, on the reasoning that they only move the tree to states git already holds and execute no repo code. Measured against git 2.43.0 with hooks installed in `.git/hooks/`, that is false for all three: `git checkout -- <path>` runs `post-checkout`, and both aborts run `reference-transaction` (it fires on **any** ref update, which each of them performs). `.git/hooks/*` is writable by exactly the actor this door assumes, so the whitelist was an arbitrary-execution path standing open precisely while the gate enforced nothing — the same mistake as the `vigiles compile` escape, one layer down: a command believed inert because of what it _means_ rather than what it _does_. `git -c core.hooksPath=<empty>` does suppress them (measured), but it puts free-form structure back into the accepted string and buys nothing, because a file write already un-wedges the repo.

> **Why `vigiles compile` is not in that list.** It used to be. Two things settled it, both measured rather than argued. During a load wedge `vigiles compile` exits 1 (`Cannot load hook …: Invalid package config`) — it loads the hook through the very resolver that just failed, so it could never repair that state. And it was the only escape that _ran code_: over five review rounds it was found to admit a payload through composition (`curl … | sh && vigiles compile`), through its operand (`vigiles compile /tmp/payload.spec.ts`, which the CLI dynamically imports), through its executable path (`/tmp/vigiles compile`), and through the working directory (`cd /tmp/evil && vigiles compile`). Recognising a trusted _action_ from an untrusted _string_ has unbounded degrees of freedom — argv, cwd, `PATH`, `node_modules` resolution, config discovery — so the primitive was removed rather than constrained a fifth time.

Everything else still fails closed. This doesn't soften the tamper guarantee that matters: while the stamp is stale the hook is enforcing **nothing** (it refuses every call), and anyone able to rewrite a hook's source can equally rewrite `.claude/settings.json`. What the stamp buys is that a smuggled capability can never run **silently** — unchanged.

## Testing a compiled hook

**Because the decision is a pure function, you test it deterministically** — no model, and (cheapest) no subprocess. Three levels, by cost:

**1. In-process (cheapest).** Load the hook FILE with `loadHook(path)` and pass it plus a raw event to the assertions — no `node` spawn, no CLI, milliseconds:

```ts
import { it } from "vitest";
import { loadHook, assertHookDenies, assertHookAllows } from "vigiles";

const guard = await loadHook(".vigiles/hooks/guard.mjs");

it("blocks a force-push, even hidden in a compound command", () => {
  assertHookDenies(guard, {
    tool_name: "Bash",
    tool_input: { command: "cd x && git push -f" },
  });
  assertHookAllows(guard, {
    tool_name: "Bash",
    tool_input: { command: "git status" },
  });
});
```

`loadHook` is the same loader the runtime uses (so a hook that loads in a test loads identically in production) and it is what makes this tier reachable from a `.harness.mjs` file, which has a hook's PATH and not its object. A TypeScript hook (`guard.hook.ts`) loads the same way under tsx / Node ≥ 23.6. If you already have the object — a static `import guard from "./guard.mjs"` — pass it directly.

**React hooks get their own pair.** A react can't block, so the gate assertions don't apply; use `assertHookNotices(hook, event, matcher?)` and `assertHookSilent(hook, event)`:

```ts
import { assertHookNotices, assertHookSilent } from "vigiles";

const warn = await loadHook(".vigiles/hooks/warn-on-failure.mjs");
const after = (isError) => ({
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  tool_response: isError ? { error: "boom" } : { stdout: "ok" },
});

assertHookNotices(warn, after(true), /read the error/);
assertHookSilent(warn, after(false));
```

### Where a notice arrives

A `notice(msg)` is delivered as `hookSpecificOutput.additionalContext` on stdout — the same mechanism vigiles's own shipped nudges use — so **the agent reads it**. It is still not a block: a react has no `deny`, and it always exits 0.

Delivery is **per event and per harness**, and vigiles will not pretend otherwise:

|                                                |                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| event the harness injects (e.g. `PostToolUse`) | the notice is delivered as `additionalContext`                                                                   |
| event it does not (e.g. `Stop`)                | nothing is emitted on stdout, and `vigiles compile` **warns at install time**, naming the events that would work |

The event set is the adapter's `injectableEvents`, not a hard-coded list, so a Codex hook is gated on Codex's answer.

> 🔴 **This was a real defect, found by dogfooding.** Until 2026-09-07 a notice went to **stderr and nowhere else**. Per Claude Code's hook documentation, stderr from a hook that exits 0 goes to the debug log only — "Claude never sees it" — and a react always exits 0. So a notice reached **nobody**: not the model, not the user, not the transcript. The docs stated the mechanic ("writes to stderr") and never the consequence, which is exactly the false-confidence shape compiled hooks exist to remove. It was caught when this repo wired up its own first compiled hook.

> ⚠️ **Don't test a react hook by reading a stream.** A `notice(…)` goes to **stderr** (the debug log) _and_ — on an event this harness injects — to **stdout** as `hookSpecificOutput.additionalContext`. So a stream probe gets a different answer depending on the event, and a probe built on `execFileSync` once reported a perfectly healthy react hook as **dead**. These assertions read the reaction itself, so no stream enters into it.

Runnable end to end: [`examples/harness/compiled-hook-inprocess.harness.mjs`](../examples/harness/compiled-hook-inprocess.harness.mjs) (with its two hook files) is exactly this pattern, and runs in CI.

`runHookProgram(hook, event)` is the underlying primitive — it returns a normalized outcome (`{ kind: "decision" | "injection" | "reaction", … }`) dispatched by role, so an inject or react hook is just as testable as a gate.

**2. Through the real runtime.** `runHook("node … hook-runtime run-program guard.mjs", event)` drives the actual compiled CLI (stamp check + dispatch) — proves the wired artifact behaves, still no model. Pair it with the disaster battery: `assertBlocksDisasters("node … hook-runtime run-program guard.mjs")` proves the gate blocks every textbook disaster.

**3. Does it fire in the assembled harness?** `runHarnessTest` (a scripted mock model emits the tool call; assert the hook blocked) — the delivery question, key-free, and capped by [how the harness delivers events to hooks](#limitations--trade-offs-the-cons).

See [Testing your harness](harness-testing.md) for the tiers in full.

## Proof: the OSS dogfood

We pointed the [`DISASTER_CATALOG`](harness-testing.md#prove-a-guard-actually-blocks-the-disaster-battery) battery (force-push, compound force-push, `reset --hard`, `rm -rf`, `--no-verify`, private-SSH-key read, `curl | sh`) at the widely-copied `disler/claude-code-hooks-mastery` safety hook: it blocks **2 of 7**, silently missing the other five. The compiled equivalent ([`examples/harness/safe-bash-guard.mjs`](../examples/harness/safe-bash-guard.mjs)) blocks **7 of 7** — same intent, no blind spots, no protocol bug. The contrast is a runnable, model-free regression test ([`src/hook-dogfood.test.ts`](../src/hook-dogfood.test.ts)).

### One command, many spellings — `experimental_alternateSpellings()`

`experimental_alternateSpellings(events)` takes a list of hook test cases (shell commands wrapped as `PreToolUse` events — the battery above) and returns **more test cases**: the same commands re-spelled every way the shell runs identically. It is a test-input generator for a safety hook. It does not check anything and it does not touch your hook.

**What breaks without it.** Your guard's rule says "block a command containing `--force`". The seven battery commands are each written one way, so the battery is green. Someone types `git push "--force" origin main`. The shell strips the quotes and force-pushes; your guard sees a different string and allows it. Nothing fails, so nothing tells you.

That is not hypothetical. Before this function existed, we tried 30 hand-written re-spellings of the seven battery commands against the guard behind the "7 of 7" above. It blocked **8 of 30**. Three that got through:

```text
git push "--force" origin main           # the flag in quotes
sudo git push --force origin main        # a wrapper in front
/usr/bin/git push --force origin main    # the full path to git
```

None of these is an evasion trick. Quoting a flag is ordinary typing. The "7 of 7" was true, and it had been measured on the only seven spellings anyone had written down. (8 of 30 is the **before** number — the shipped guard now blocks every generated spelling, see below.)

**What it generates.** For each command, the rewrites the shell reads identically:

- the flag in quotes: `"--force"`, `'--force'`
- the short and long form of a flag: `-f` / `--force`, `-n` / `--no-verify`
- the full or backslash-escaped command path: `/usr/bin/git`, `/bin/git`, `\git`
- a pass-through wrapper in front: `sudo`, `env`, `command`, `nice -n 5`, `timeout 30`
- a per-command environment assignment in front: `FOO=1 git push --force` (the shell strips the assignment and runs the rest)
- a quote pair inside or around the command name: `g""it`, `"git"`, `gi"t"`
- ANSI-C quoting of the name: `$'git'`
- a backslash before an ordinary letter: `g\it` (the shell drops it — `sh -c 'g\it --version'` prints git's version)
- runs of spaces, or tabs, between words: `git   push    --force`

Seven commands become 136 (today's count; it grows as rewrite rules are added). The last four are the shell's own obfuscations: `sh` removes them before the command runs, so a guard that matches the source text (a `grep`, a substring) sees a different string while the shell sees the same command. Against a guard that greps for each of the seven command strings, most of them get through. Which ones depends on how that guard matches, and the difference is sharp: an ANCHORED matcher (`case "$cmd" in "git push --force"*`, a `startsWith`) blocks **0 of the 14** environment-assignment spellings, because the prefix moves the start of the string. An unanchored `grep` blocks 12 of those 14 and falls to the quoting ones instead.

It returns **only the rewrites**, never the originals — so spread both into the same checker:

```ts
import {
  DISASTER_CATALOG,
  experimental_alternateSpellings,
  assertBlocksDisasters,
} from "vigiles";

const guard = "node … hook-runtime run-program guard.mjs";
assertBlocksDisasters(guard, {
  events: [
    ...DISASTER_CATALOG,
    ...experimental_alternateSpellings(DISASTER_CATALOG),
  ],
});
```

Passing the generator alone would test the seven originals zero times. Each rewrite keeps the original's id with a suffix (`force-push~4`), so a failure names the spelling that got through.

On its first run the generated set found a miss the 30 hand-written cases had not: `git commit -n -m 'skip hooks'`. The guard asked for the literal `--no-verify`, and `-n` is git's short form of it. The matcher behind `runs()` was fixed to recognise both spellings, and the shipped guard now blocks all 136. [`src/hook-dogfood.test.ts`](../src/hook-dogfood.test.ts) keeps it that way in CI.

**Nobody has to label the new cases.** Two questions decide whether a rewrite belongs in the battery, and both are already answered:

| Question                | Answered by                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Is it dangerous?        | The original command a human put in the battery. The rewrite inherits that.                       |
| Is it the same command? | The shell parser vigiles already uses to read commands (the one behind `runs()` and `touches()`). |

If a rewrite fails the second check, the generator throws instead of quietly dropping it. A silent drop would shrink the battery while it still looked like it ran.

**If you know promptfoo — feature parity.** Each rewrite rule here is what promptfoo calls a _strategy_: a transform that turns test cases into more test cases, applied on top of the base set. The table maps the two.

| promptfoo                                                                  | vigiles                                                               | Note                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic` (include the un-transformed cases)                                 | the `[...DISASTER_CATALOG, ...]` spread                               | Same question, answered explicitly at the call site.                                                                                                                                                                    |
| `base64`, `rot13`, `hex`, `leetspeak`, `homoglyph`, `morse`, `piglatin`, … | quoted head, ANSI-C quoting, escaped letter, whitespace               | Same axis — an encoding the _target_ decodes. A model may decode base64; a shell does not, so those are not emitted (they would blame a correct guard). The shell decodes quotes, `$'…'` and backslashes, so those are. |
| `jailbreak`, `crescendo`, `goat`, … (a model rewrites the attack)          | none                                                                  | Deliberately absent. It costs money and is non-deterministic; every spelling here is produced and checked with no model.                                                                                                |
| `retry` (re-run previously failed cases)                                   | none                                                                  | The battery is deterministic; a failed case fails the same way every run.                                                                                                                                               |
| —                                                                          | the equivalence check (a rewrite that is not the same command throws) | promptfoo strategies are not required to preserve meaning. Here every emitted spelling is one the shell provably runs identically, so a miss is always a guard bug, never an ambiguous input.                           |

**What it cannot find.** The generator decides "same command" with the same shell parser the compiled guard's `runs()` uses. That makes every spelling it emits trustworthy, and it sets the limit: it can only produce spellings that parser already understands. It tests whether your guard matches the _operation_ rather than one way of typing it; it cannot find a blind spot in the parser itself, because it would share it. `g\it` is the example: a reader tried it, the shell ran git, the parser read `g\it`, and the guard behind "7 of 7" let it through — while the 73-case battery of the day could not have produced it. The parser was fixed, the spelling joined the battery, and the shipped guard now blocks all 136. A spelling the parser does not understand still has to come from a person.

**What it deliberately does not generate.** `eval "$(…)"`, `sh -c "…"`, a command name held in a variable (`$CMD push --force`), a command decoded from base64. The parser cannot tell what those will run, so they are never emitted. That is on purpose: a guard built on `runs()` genuinely cannot see through `eval "$(echo … | base64 -d)"` either. Emitting such cases would mark a correct guard as broken, and a check that flags correct guards gets switched off.

⚠️ **Also check that ordinary commands still pass.** This measures blocking only, so a guard that denies everything scores 100%. Run a few everyday commands (`git push origin main`, `git commit -m fix`, `cat README.md`) through `verifyGuardrail` and assert none is blocked. The dogfood test does both halves.

Beyond the headline number, the **structural** wins over hand-written guards are each isolated in their own CI test ([`src/hook-oss-comparison.test.ts`](../src/hook-oss-comparison.test.ts)), so the headline is not the only evidence:

- **Evasion** — the AST catches the compound `cd … && git push -f` a substring/glob misses.
- **Precision** — no `grep` false-positive on a benign `echo`.
- **Protocol** — a mis-wired `exit 1` is false confidence; the compiled exit code can't be wrong.

The honest other side: stateful guards, broad I/O, and delivery are NOT compiled-hook wins. (The delivery floor is not what it was — see [Limitations](#limitations--trade-offs-the-cons) for what moved and what did not.)

## Limitations & trade-offs (the cons)

Compiled hooks are neither free nor magic. The honest downsides:

- ❌ **Delivery floor — a gate is a strong default, not an unbypassable wall.** Compiling fixes a hook's _authoring_ and _logic_, **not** how the harness _delivers_ events to it.

  **What changed (2026-08-24).** Claude Code's [#34692](https://github.com/anthropics/claude-code/issues/34692) — a `PreToolUse` hook not firing for a subagent's tool calls — was closed not-planned and quoted here for months as a standing limit. It is **fixed**: measured against a stock `@anthropic-ai/claude-code@2.1.241` from the registry, a subagent's own `Bash` reaches the hook and an exit-2 deny stops it (the parent's identical command in the same run is the control). The event even carries `agent_type`, naming which subagent made the call. `src/subagent-delivery.test.ts` pins this in both directions, so a regression goes red instead of quietly returning to the old behaviour.

  **What did NOT change.** A model can still route around a tool entirely ([#45427](https://github.com/anthropics/claude-code/issues/45427) / [#32376](https://github.com/anthropics/claude-code/issues/32376) — a Bash heredoc instead of `Write`), and a compiled hook removes the bugs that are _yours_, not the harness's. The most robust claim remains about **logic**, not live enforcement, and [guardrail verification](harness-testing.md) is still the companion that survives any delivery gap. **Never call a gate "unbypassable."**

  Scope of the measurement, stated plainly: it drives `claude -p` (headless). Interactive sessions are unmeasured, and subagent nesting (depth 2) does not occur there at all.

- ⚠️ **Runtime cost.** Every matching event spawns `node` and dynamic-imports your program — tens to hundreds of ms per call. Fine for a `PreToolUse` gate. Think twice before a hot-path `PostToolUse` react that fires on every edit.
- ⚠️ **Buy-in.** It's a dependency plus a build step, and you author in JS/TS, not a 3-line inline `bash` hook. For a trivial one-liner the compiled path is heavier — the payoff is on the guards that actually have to be _correct_.
- ⚠️ **A bounded vocabulary is a ceiling, by design** — but be precise about which bound. (1) What a hook can _do_: `checkHookImports` forbids any import but `vigiles/hook` (no `fs`/`net`/`child_process`), so a hook that must _call a service, read a file, or hold cross-invocation state_ to decide can't be expressed. That is the **deliberate** ceiling — it _is_ the safety guarantee, and such hooks stay hand-written (keep a plain shell hook and verify it with the disaster battery). (2) What a hook can _see_: the AST matchers (`runs`/`touches`/`pipesToShell`/`under`) are a **soft, extensible** limit, not a fundamental one — if you need to match a shape they don't expose yet, the fix is a new matcher, not a redesign.
- ⚠️ **Compiling proves the protocol, not your policy.** A compiled hook can't have the wrong exit code — but it can still `deny` the wrong thing. Compiling is necessary, not sufficient. Test the _logic_ with [guardrail verification](harness-testing.md).
- ℹ️ **Codex inject/ask output is unconfirmed.** The gate (`deny` → exit 2) path is cross-harness today. An inject/react hook's _output_ shape is Claude-Code-confirmed only, so `compile --harness=codex` **warns loudly** on those rather than ship a maybe-no-op (see [Compile and wire](#compile-and-wire)).

## Status / pending

The vocabulary's six entry points carry the `experimental_` prefix. This section
says what that prefix is claiming and what would retire it — the roadmap for the
feature lives with the feature, not on a separate stability page.

They are `experimental_defineHook`, `experimental_defineFileGate`,
`experimental_definePromptGate`, `experimental_defineStopGate`,
`experimental_defineInject` and `experimental_defineReact` — everything this page
has been about.

Only the entry points carry the prefix, and that placement is the whole point:
every other name in `vigiles/hook` — `allow`, `deny`, `tool`, `pathView`,
`commandView`, `state`, `record`, `notice`, `run` — is reachable ONLY from inside
a `define*` call. Prefixing the chokepoint makes the marking structural for the
whole vocabulary; prefixing thirty names could not, because nothing would stop
the thirty-first from shipping unmarked. Same reasoning as
`experimental_skill.input()` (see [`skills.md`](skills.md#status--pending)), applied to a larger surface.

**Why it is not settled, stated as gaps rather than as a disclaimer:**

- The vocabulary grew a whole new axis in one release. Runtime-owned named state
  (`record`/`state`) landed 2026-08-12 to close a measured hole — seven advisory
  hooks in the dogfood repo were still hand-written shell for one uniform reason,
  every one of them both read and wrote a stamp file, and throttling was
  inexpressible. An API that gained a dimension that recently has not been
  pressure-tested by anyone but its author.
- Consumers are still few, and all of them belong to the author. A vocabulary
  nobody else has had to live with is a vocabulary whose sharp edges are unknown.

  What this bullet said until 2026-09-07 — _"neither is this repository's own
  harness, which still wires its hooks as plain shell"_ — is no longer true.
  `.vigiles/hooks/test-tier-nudge.hook.mjs` is this repo's own first compiled
  hook: a `react` that reminds a contributor which **test tier** a file they just
  edited belongs to, throttled with `record`/`state` so it speaks at most hourly
  and again whenever the tier changes. It was written to use the _least_-used
  corner of the vocabulary on purpose. Its tests are `src/test-tier-nudge.test.ts`
  (pure classification in-process, then both throttle directions against the real
  runtime via [`experimental_hookState`](#testing-a-hook-that-remembers)).

**What would have to be true to drop the prefix:** ~~a supported way to seed and
read named state in a test~~ (closed — see below), and at least one consumer who
did not write the API.

The state-seeding item is **closed as of 2026-09-07**. It read: _"Testing a hook
that uses named state is archaeology today. The runtime derives the store's path
from the hook's own location and validates the key charset, so a test that wants
to seed 'this fact was recorded four days ago' must reconstruct a private path.
The dogfood repo does exactly that, hard-coded, and it broke when the facts were
renamed."_ `experimental_hookState` on the `vigiles` test surface is that API —
[Testing a hook that remembers](#testing-a-hook-that-remembers). It is a thin
handle over the store functions the live runtime calls, not a second copy of the
path rule, and both directions are pinned end to end against the real runtime: a
gate that FIRES on a four-day-old seeded fact and STAYS QUIET on a ten-minute-old
one, plus the reverse direction — a fact the RUNTIME recorded, read back through
the handle.

What that leaves is the second half: consumers. One consumer who did not write
the API, living with a stateful hook long enough to find its edges. vigiles's own
harness now counts as a stateful consumer (above), which closes the narrower
"the product does not use the feature it ships" version of this — but the author
grading his own API is not the evidence the prefix is waiting on.

An earlier version of this list also demanded an idempotent `compile`. That was
already false when it was written: the merge is keyed by the hook's canonicalized
path (`mergeHooksJson`, `src/hook-install.ts`), so recompiling replaces the entry
in place — across five spellings of the same path, and beside a hand-wired block
that used `$CLAUDE_PROJECT_DIR` and quotes. Fixed in #168 and pinned by two
regression tests in `src/hook-install.test.ts`; this page kept saying otherwise
for two weeks. Re-measured 2026-09-07: five consecutive compiles, byte-identical
`settings.json`, one entry.

**Stable alternative:** a hand-written shell hook wired in `settings.json`. The
events and the protocol are the harness's, not ours — nothing about them is
experimental. What you give up is the typed vocabulary and everything it makes
unrepresentable.

## See also

- [Testing your harness](harness-testing.md) — the test tiers; `runHook` unit-tests a hook's decision, and `assertBlocksDisasters` proves a guardrail blocks.
- [Verifying your instruction files](verifying-instruction-files.md) — the linting layer (references are _true_); compiled hooks are the **gate** instrument beside it.
- [CLI & GitHub Action](cli.md) — `compile` / `hook-runtime` reference.
- [API reference (generated)](https://zernie.github.io/vigiles/api/) — every `vigiles/hook` symbol (`experimental_defineHook`, `provide`/`dangerously`/`defineProvider`, the `Decision`/`Reaction` types, …).
