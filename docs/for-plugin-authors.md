# Shipping plugins with vigiles

**You shipped a plugin — but do its skills fire for the people who install it?** A description that never triggers, a hook whose `${CLAUDE_PLUGIN_ROOT}` path resolves to nothing on someone else's machine, a subagent missing the frontmatter that registers it — all of it looks fine in your repo and silently breaks for your users. This guide catches it before you ship.

> The [README](../README.md) has the pitch — this is the full guide for **plugin and marketplace authors**: how to ship a plugin that's structurally sound and whose skills actually fire for the people who install it.

If you run agents on your own repo, start with the [linting guide](verifying-instruction-files.md) instead — this page is the plugin-author journey, end to end. Every step here is deterministic and **needs no API key**, except the one model-gated check (step 3), which runs on your own subscription.

## Contents

1. [Scan a draft for structural health](#1-scan-a-draft-for-structural-health)
2. [Fix what it flags](#2-fix-what-it-flags)
3. [Make your skills actually fire](#3-make-your-skills-actually-fire)
4. [Rank against the field](#4-rank-against-the-field)
5. [Test and gate it in CI](#5-test-and-gate-it-in-ci)
6. [Ship it in the portable Agent Plugins format](#6-ship-it-in-the-portable-agent-plugins-format)

## The workflow at a glance

vigiles turns "I have a markdown plugin" into "I have a verified harness" in four moves — lowest-effort first. Each is a separate command; you can stop at any step:

| Step | Command          | What it does                                                                                                                                                                  |
| ---- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **`audit`**      | Read-only report: what you ship, what's broken, what surfaces aren't spec-managed yet. Writes nothing.                                                                        |
| 2    | **`init`**       | Turns your existing `CLAUDE.md` / skills / subagents into typed `.spec.ts` specs, faithfully and non-destructively (`eject` reverses).                                        |
| 3    | **`strengthen`** | _(Optional)_ A skill your agent invokes that upgrades prose guidance into enforced linter rules, so lint can verify your references are real _and enabled_, not just present. |
| 4    | **`lint`**       | CI gate: every path, script, rule, and tool contract must resolve. The deterministic guardrail.                                                                               |

**About the report's "Create spec" buttons:** the HTML report is a shareable static file, so it can't touch your repo. The buttons **copy the exact `npx vigiles init …` command to your clipboard** — you paste it, and your local CLI writes the spec. A report can hand you the command; only your own machine can run it. The terminal and `--json` outputs print the same commands.

## 1. Scan a draft for structural health

Point `audit` at your plugin directory. It runs with no model and no API key. It reports what you ship and what's broken:

```bash
npx vigiles audit ./my-plugin
```

It surfaces defects that quietly break a plugin for every user who installs it — the things a "does the JSON parse?" check sails past:

- **Hook script that resolves to nothing** — a `${CLAUDE_PLUGIN_ROOT}` typo or a missing file, so the hook silently never runs.
- **Skill with no description** — it can never be selected by the model.
- **Subagent tool contract** naming a tool that doesn't exist — a typo, or a never-available tool that just fails at runtime.
- **MCP server that can't start** (no `command`/`url`), or a tool whose server isn't declared.
- **Two skills whose descriptions overlap** so closely the selector can't tell them apart — the wrong one fires.

Each finding is a concrete, located defect — not a style nit. Add `--json` for a machine-readable report to wire into your own tooling.

## 2. Fix what it flags

The output is your to-do list. Resolve the broken hook paths, give every skill a description, correct the tool-contract typos, declare your MCP servers, and differentiate any colliding skill descriptions. Re-run `audit` until it's clean — this is the free, fast loop you run before every release.

If your plugin ships an instruction file (`CLAUDE.md` / `AGENTS.md`), also run [`vigiles lint`](verifying-instruction-files.md) on it. That verifies every path, script, and linter rule it names is real and enabled.

## 3. Make your skills actually fire

A skill only helps if its description reliably **triggers** on the prompts your users actually type — and stays quiet on the ones it shouldn't hijack. That's **recall** and **precision**. A well-formed description tells you nothing about either.

This is the model-gated trigger tier, measured on your own subscription. As a local report, `audit` runs it interactively — it **asks once** (then remembers):

```bash
# audit asks "run the executing checks?" — say yes; probes are auto-generated from
# each skill's description (zero setup). A curated set (+ the selection-collision
# matrix) is used if you supply one:
#   { "my-skill": { "prompts": ["how do I …", "…"], "irrelevant": ["…"] } }
npx vigiles audit ./my-plugin --prompts=prompts.json
```

**The selection-collision matrix** runs each skill's own prompts against your _whole_ skill set and records which skill actually fired. The diagonal is recall (the right skill fired); off-diagonal mass means a **sibling hijacked the prompt** — two skills so alike the model picks the wrong one. It's the behavioral confirmation of the deterministic [description-overlap](#1-scan-a-draft-for-structural-health) finding, and it's body-stubbed (the skill's procedure never runs), so it measures _selection_ cheaply. Most valuable when several skills do similar things.

**For automation / CI** (no human to consent), drive the primitives directly in a test:

- **`measureTriggerRate`** — recall across varied prompts, plus precision when you supply irrelevant ones, so a too-broad description that hijacks unrelated work fails too. Pair with `assertRates(report, { min, maxFalsePositive })`.
- **`measureSelectionMatrix`** — the selection-collision matrix as an assertable value: prompts are auto-derived from your descriptions (zero setup), or supply your own. Pair with `assertNoCollision({ maxOffDiagonal })` to **fail the build when one skill hijacks a sibling's prompt**. It's Claude-Code-only (import from `vigiles/harness/claude-code`), since it reads which skill the selector chose.

That's the designed path for testing skills in a script. See [measuring skills](measuring-skills.md) and the [testing API](testing-api.md).

## 4. Rank against the field

Give `audit` more than one plugin and it ranks every one by structural health. You get a 0–100 score and an A–F grade, worst issues first, **no key**. Two ways to do that:

```bash
# 1) Pass several plugin directories explicitly:
npx vigiles audit ./plugin-a ./plugin-b ./plugin-c

# 2) Point it at a repo that ships a marketplace.json (e.g.
#    .claude-plugin/marketplace.json) — audit expands it into its members:
npx vigiles audit ./marketplace
```

⚠️ A single plain folder with no `marketplace.json` is scanned as **one** plugin (its root), not a ranking. Pass the child dirs explicitly (option 1) to rank them.

Use this to see where your plugin lands against the rest of a collection before you publish, and to find the highest-impact fixes. The marketplace ranking is the **structural** signal — it's deterministic and covers every member at once.

The model-gated trigger tier (step 3) is **per-plugin**, not a marketplace operation. Point it at an individual plugin directory, not the marketplace root:

```bash
npx vigiles audit ./marketplace/my-plugin   # then say yes to run the checks
```

## 5. Test and gate it in CI

Ship the checks — don't just run them once. A `*.harness.mjs` (or `.ts`) test pins a hook's block/allow decision and a skill's trigger behaviour so a regression fails the build:

```bash
npx vigiles test    # the deterministic tiers — free, no key, every commit
npx vigiles eval    # the real-model tiers — on your own subscription
```

Wire `lint` and `test` into CI via the [GitHub Action](github-action.md). `lint` is the deterministic gate — `audit` is a local report, not a CI step. The deterministic tiers run on every commit for free; the real-model evals stay on a dev's subscription, not a metered CI token.

If your plugin ships **safety hooks**, author them as compiled hooks so they can't silently fail open — see [compiled hooks](compiled-hooks.md).

## 6. Ship it in the portable Agent Plugins format

[Agent Plugins](https://agent-plugins.org) is a vendor-neutral packaging standard for agent plugins, published at v1.0.0 by a steering committee from Amazon, Cursor, Microsoft, OpenAI and Vercel. One manifest at your plugin root, skills where the spec says to look — and a client implementing the standard loads your plugin without a per-vendor repackage.

⚠️ **Be realistic about reach today.** Adoption is early, and the manifest location is where clients differ:

| Client          | Reads the standard's root `plugin.json`? | Where it looks               |
| --------------- | ---------------------------------------- | ---------------------------- |
| **VS Code**     | ✅ Yes — `skills/` + `mcp.json`          | root `plugin.json`           |
| **Claude Code** | ❌ Not documented                        | `.claude-plugin/plugin.json` |
| **Codex**       | ❌ Not documented                        | `.codex-plugin/plugin.json`  |

So conforming is **additive, not a replacement**: it buys portability to clients that implement the standard, while the harness you actually target still reads its own manifest. That's why vigiles ships both.

**vigiles ships in this shape itself.** Its root [`plugin.json`](https://github.com/zernie/vigiles/blob/main/plugin.json) targets the 1.0.0 schema, and a CI gate keeps it conformant and in sync with the Claude Code manifest beside it.

The smallest conformant plugin is two files:

```
my-plugin/
├── plugin.json                 # required manifest
└── skills/
    └── my-skill/
        └── SKILL.md            # discovered at this fixed path
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin"
}
```

`$schema` and `name` are the only required fields. `version`, `description`, `author`, `homepage`, `repository`, `license` and `keywords` are optional metadata — and the schema is **closed**, so an unrecognised top-level key is a warning, not a place to stash extras. Vendor-specific data goes under `extensions`, keyed by a reverse-domain namespace.

**Two things the standard does not cover yet**, so plan for them:

| Surface       | Where it lives                                                                             |
| ------------- | ------------------------------------------------------------------------------------------ |
| **Hooks**     | Not in 1.0.0. Claude Code hooks stay in `.claude-plugin/plugin.json`; Codex's in its TOML. |
| **Subagents** | Not in 1.0.0. Same — they stay in your harness's own layout.                               |

So a plugin that ships hooks carries **both** manifests: the neutral `plugin.json` for portability, and the harness's own for what the harness alone understands. Keep their `name` / `version` / `description` identical — two hand-maintained manifests drift, and the drift is invisible until something loads the stale one. A three-line test that compares them is cheaper than finding out later ([ours](https://github.com/zernie/vigiles/blob/main/src/agent-plugins-manifest.test.ts)).

**`vigiles audit` reads a plugin laid out this way** — no flag, no config. Everything under `skills/` (descriptions, trigger collisions, the lethal-trifecta check, test coverage), plus the MCP servers in your root `mcp.json`, so a server that can't start or a tool naming an undeclared server is still caught.

One detail worth knowing: the standard's `mcp.json` is read **only when your root `plugin.json` pins an `agent-plugins.org` `$schema`**. `mcp.json` is a generic filename, so without that declaration vigiles leaves the file alone rather than guessing it's yours.

## See also

- [Verifying instruction files](verifying-instruction-files.md) — lint a `CLAUDE.md` / `AGENTS.md`.
- [Harness testing](harness-testing.md) · [Measuring skills](measuring-skills.md) — the test and eval tiers in depth.
- [Compiled hooks](compiled-hooks.md) — safety hooks that can't fail open.
- [CLI reference](cli.md) · [Skills](skills.md) · [Harnesses](harnesses.md) (Claude Code + Codex).
