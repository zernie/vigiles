# FAQ

Quick answers to the questions people ask before adopting vigiles. The
[README](../README.md) has the pitch; this fills in the "but wait…".

## Isn't this just a markdown linter?

No. A markdown linter checks _style_ — heading levels, line length. vigiles checks whether your instruction file is **true**: every file path, script, code symbol, and linter rule it names must actually **exist and be enabled**, resolved against your real repo and your real linter config.

A renamed file or a disabled rule is caught before your agent ever acts on the stale claim. And that's just the Lint layer — vigiles also **tests** your hooks/skills and **measures** whether a skill helps. See [verifying instruction files](verifying-instruction-files.md).

## Why a typed spec — and do I have to write TypeScript?

**No — your agent writes the spec, not you.** `init` adopts your existing CLAUDE.md _into_ one faithfully: every heading becomes a verbatim section, no rule invented. The `edit-spec` / `strengthen` skills author and maintain it from plain-English asks, recompiling on save. You rarely touch it by hand.

The spec is the default because markdown has no structure to check against. A typed `.spec.ts` gives you:

- **Autocomplete** — rule names and paths resolve as you type.
- **Edit-time red squiggles** — a dead path is caught before lint, not after.
- **Reuse** — compose and share rules across files and repos.

**Not ready for a spec?** Lint plain markdown with zero new files — inline `<!-- vigiles:enforce -->` comments, no TypeScript — and `vigiles eject` turns a spec back into markdown anytime. The deeper compiler-grade guarantees are **gradual and opt-in, like TypeScript's `strict`** — [here's why](#why-are-the-strongest-guarantees-opt-in-not-the-default).

## Why are the strongest guarantees opt-in, not the default?

Because "opt-in" here means **gradual, not permissive** — and the deepest tier needs a typed program to work on. Three things to separate:

- **The default already catches real breakage.** On your plain markdown — no spec, no TypeScript — vigiles fails CI on a typo'd tool, a dead hook, a broken MCP server, or two skills the model can't tell apart. A clean repo stays green. You get protection at rung zero; opt-in never means vigiles ignores what's actually broken.
- **Compiler-grade proofs need a program to check.** Guarantees like _"a config that leaks won't compile"_ or _"a multi-agent pipeline whose handoffs don't line up won't compile"_ are properties of a typed `.spec.ts` — the same way `tsc` can type-check a `.ts` file but has nothing to check in inert prose. A markdown `CLAUDE.md` gives a compiler nothing to verify. So this tier is "opt-in" mainly in the sense that **you first have to have written the typed spec.** It can't be retrofitted onto a file that isn't a program.
- **Gradual is how adoption actually works** — the same bet TypeScript made with `strict`. You climb a ladder (markdown → inline `<!-- vigiles:enforce -->` comments → frontmatter → typed spec), and **each rung pays off without forcing the next.** Demanding the deep end at the front door is how a tool ends up with no users. And the guarantee loses no strength by being opt-in: once the spec exists, an unsafe config genuinely won't `tsc`.

In short: **structural correctness is free and on by default; mathematical-strength proofs are opt-in because they require you to bring a typed program** — and forcing that at adoption time is the surest way to get zero adopters.

## Does `init` overwrite or touch my files?

No. `init` is **non-destructive**. If you already have a `CLAUDE.md` / `AGENTS.md`, it **adopts** it into a spec — every heading becomes a verbatim section, no rule invented — but **leaves your file exactly as-is**. You only switch a file to spec-managed when _you_ run `vigiles compile`, with a diff to review.

`vigiles eject` hands any managed file back as plain markdown you own. It's never a one-way door.

## Does it work with Claude Code _and_ Codex?

Yes. vigiles targets Claude Code today and OpenAI Codex via
[`vigiles/harness/codex`](harnesses.md); the CLI auto-detects which one your repo uses
(`.claude/` vs `AGENTS.md` / `.codex/`). The Lint layer is harness-agnostic; the
Test layer drives the real `claude` / `codex` CLI. You can even
[teach it your own harness](authoring-an-adapter.md).

Separately, vigiles reads plugins packaged to
[Agent Plugins](https://agent-plugins.org). That is a **packaging format, not
another agent** — a plugin shipped that way still runs inside Claude Code, Codex
or VS Code, so it does not add a harness. What it does add: if your plugin uses
that layout, its skills and its root `mcp.json` are audited with no flag and no
config. vigiles ships as a conformant plugin itself
([how to do the same](for-plugin-authors.md#6-ship-it-in-the-portable-agent-plugins-format)).

## Do I need an API key? What does it cost?

**Most of vigiles needs no model and no key.** Lint and the deterministic Test tiers run in milliseconds on every commit, free.

The only thing that needs a model is a real-model **eval**. That runs on **your own Claude Pro/Max subscription** via the `claude` CLI — **$0 of metered API tokens**. Tools like promptfoo / DeepEval hit a metered API and bill per token on every run. See [measuring skills](measuring-skills.md).

## What does `vigiles audit` actually run — and why did it "find nothing"?

`audit` has two layers, and by default you get only the first:

- **The deterministic read (always on).** A plain `audit` **executes nothing**. It reads your files and reports structural facts — a broken hook path, an undeclared MCP server, a tool-contract typo, two near-identical descriptions, a subagent holding all three lethal-trifecta legs. Safe on any repo, identical on every OS, no key.
- **The executing checks (only with your yes).** Two questions can't be answered by reading: _does each skill actually fire?_ (recall + precision) and _do two skills fight over the same prompt?_ (the selection-collision matrix). Answering them runs the real model on your subscription, so `audit` **asks once** at a terminal and remembers your choice in `.vigilesrc.json` (`audit.measure`). Headless — CI, an agent, `--json` — it stays a read and prints a one-line nudge. It never hangs and never executes on its own.

**So if `audit` graded a skill-heavy repo a clean A and "found little," it almost certainly ran only the deterministic read.** The behavioral findings — the skills that never fire, the ones that collide — live behind that one consent. Say yes at a terminal, or measure in a script with [`measureTriggerRate`](measuring-skills.md), to see them.

`audit` is a **local report, like Lighthouse — not a CI gate.** For CI, use [`vigiles lint`](verifying-instruction-files.md), which is deterministic and gates real breakage. The full author workflow is in [shipping plugins](for-plugin-authors.md).

## Does it work on a non-JavaScript repo (Python, Rust, Go…)?

✅ **Yes for Lint** — `npx vigiles lint` verifies your `CLAUDE.md` against your repo and linters (Ruff, Clippy, Pylint, RuboCop, golangci-lint, detekt, … alongside ESLint — 11 in all, covering Python, Rust, Go, Kotlin, Java, Ruby, and CSS) with **no install**.

✅ **Yes for the typed spec too** — `npx vigiles compile` needs no `package.json` and no `npm install`. The CLI resolves a spec's `vigiles/spec` import from its own install, so `init` → `compile` → `lint` works end to end on a repo that has no Node toolchain. Prefer no TypeScript at all? Inline-comment mode is equally supported.

## Is it safe to run `init`? What if I change my mind?

Safe. `init` never overwrites instruction files (see above) — an adopted file is left byte-for-byte alone until you run `compile` yourself and review the diff.

To back out: `vigiles eject <file>` returns the file to plain markdown and removes the spec. Uninstalling the dev dependency leaves your repo as plain markdown plus CI you can delete. Nothing is locked in.

## Testing guards

These are about `runGuardrail` and its check `guardrail()`, the disaster battery. The full page is
[Prove a guard actually blocks](harness-testing.md#prove-a-guard-actually-blocks-the-disaster-battery).

### How do I add my own cases, or replace the defaults?

The cases are a value, `disasters(options)`. Three options, one rule: passing
an option **replaces** its default; to **add**, spread the default in. `events`
are the disasters (default `DISASTER_CATALOG`), `spellings` their other
spellings, `harmless` the look-alikes that must pass.

```ts
import { assertChecks } from "vigiles";
import {
  DISASTER_CATALOG,
  disasters,
  guardrail,
  runGuardrail,
} from "vigiles/hook/testing";

const mine = {
  id: "push-main",
  label: "plain push to main",
  category: "destructive-git" as const,
  tool: "Bash",
  input: { command: "git push origin main" },
};
const guard = "bash hooks/guard.sh";
assertChecks(runGuardrail(guard, disasters({ events: [mine] })), [guardrail()]); // replace
assertChecks(
  runGuardrail(guard, disasters({ events: [...DISASTER_CATALOG, mine] })),
  [guardrail()],
); // add
```

### How do I turn off the look-alikes or the spellings?

Pass an empty list: `disasters({ harmless: [] })` or
`disasters({ spellings: [] })`. The disasters themselves always run.

### Why is my guard test slow, or timing out?

By default the battery has 199 cases. A command-string hook is started once
per case — a small `node guard.js` took about 8 s here — so give that test a
30–60 s timeout (`test(name, fn, 60_000)`), or turn a half off. A compiled hook
is decided in-process, about 1.3 s for the same cases.

### Why did my guard fail on a spelling it never saw?

Because it contains the same operation. `git push "--force" origin main`,
`sudo git push --force origin main`, `( git push --force origin main )` and
`bash -c 'git push --force origin main'` all force-push; a guard that matches the text `git push --force` lets them through.
The failure names the spelling by its id (`force-push~12`). Decide on the parsed
command (`vigiles/hook` `runs()`) and every generated spelling passes.

### Why did my conditional guard pass a look-alike?

A command hook with an `if` (say `Bash(git push *)`) is never started for
`echo 'git push --force'`, so the harness lets that command through. That is
what "allowed" means, so the look-alike passes. A _disaster_ the `if` does not
select is still a miss.

### What does `crashed` mean?

The hook never really ran. A command hook that exits non-zero on every call,
prints no decision, and shows an interpreter or loader error on stderr — a
missing script, a missing `lib/common.sh` — is reported as `run: "crashed"`
with the end of its stderr, not as a score. It is a best-effort reading from
outside; a compiled hook never needs it.

### Compiled hook or string hook?

Write guards as compiled hooks (`vigiles/hook`). The battery calls `decide()`
directly and the answer is exact. A command string can only be watched from
outside: a hook that never started, or that branches on its input, can look
like it works.

## How is the Eval layer different from promptfoo / DeepEval?

Two things set it apart.

**Cost:** promptfoo / DeepEval bill per token against a metered API on every run. vigiles answers most questions with no model at all and runs the rest on your subscription.

**What's under test:** vigiles loads your harness **exactly as it ships** — the real agent + your real `CLAUDE.md` + hooks. It A/Bs it on real tasks and reports cost + the target metric + a correctness check. A "saved tokens" win that breaks the code isn't counted as a win. See [measuring skills](measuring-skills.md).

## See also

- [Verifying instruction files](verifying-instruction-files.md) — the Lint layer.
- [Testing your harness](harness-testing.md) — hooks, skills, subagents.
- [Measuring skills](measuring-skills.md) — the affordable eval.
- [CLI reference](cli.md) · [Harnesses](harnesses.md) · [Safety & sandboxing](safety.md)
