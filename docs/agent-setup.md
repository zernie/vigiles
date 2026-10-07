# Agent setup & workflows

**One command is all you need.** `npx vigiles init` handles everything
non-interactively — the agent runs it, the installed skills and hooks take over
(auto-compiling specs, blocking stray edits, nudging when something needs
attention), and there are no manual chores afterward. This guide covers what
`init` does, the per-agent specifics, and the fallbacks.

→ Back to [README](../README.md)

## Contents

- [What `init` does](#what-init-does)
- [Per-agent](#per-agent) — [Claude Code](#claude-code) · [Codex / Copilot](#codex--github-copilot) · [Multi-agent](#multi-agent-claude--codex) · [Cursor / Windsurf](#cursor--windsurf--other-formats)
- [Non-interactive setup (agents & CI)](#non-interactive-setup-agents--ci)
- [CI pipeline](#ci-pipeline)
- [What the agent gets wrong](#what-the-agent-gets-wrong)
- [See also](#see-also)

## What `init` does

`vigiles init` scans your project, **auto-detects which agents you already use**,
and sets both layers up. No `--target` flag needed unless you want to override.

| Signal                                     | What it means                                     |
| ------------------------------------------ | ------------------------------------------------- |
| `CLAUDE.md` exists                         | Claude Code in use — suggest migration if no spec |
| `AGENTS.md` exists                         | Codex / GitHub Copilot in use                     |
| `.claude/` directory                       | Claude Code project config                        |
| `.cursorrules`                             | Cursor in use — suggest rule-porter               |
| `.github/copilot-instructions.md`          | GitHub Copilot custom instructions                |
| `.windsurfrules`                           | Windsurf in use                                   |
| `rule-porter` / `rulesync` in package.json | Sync tool already installed                       |

**What it sets up by default:**

- **Lint layer** — a typed `.spec.ts` + generated types
- **Test layer** — a starter `vigiles.harness.mjs`
- **CI** — a `zernie/vigiles@v1` workflow at `.github/workflows/vigiles.yml`
- **Dependency** — `vigiles` added to `devDependencies`
- **Skills** — linked into the repo: one relative symlink per shipped skill, `.claude/skills/<name>` → `node_modules/vigiles/skills/<name>` (`.agents/skills/` for Codex), to commit
- **Plugin** — the Claude Code plugin, installed **globally** via the marketplace (into `~/.claude/plugins/`, never vendored into your repo); it carries the hooks

Scope with flags: `--lint` / `--test` (one layer or both), `--harness=claude,codex`,
`--no-gha`, `--no-plugin`, `--strict`.

## Per-agent

### Claude Code

Instruction file: `CLAUDE.md`.

**Skills come with the repo.** npm puts vigiles's skills at
`node_modules/vigiles/skills/`, a directory Claude Code never scans. So `init`
links each one into `.claude/skills/` — a relative link,
`.claude/skills/test-harness -> ../../node_modules/vigiles/skills/test-harness`,
the layout Claude Code [documents for a symlinked skill folder](https://code.claude.com/docs/en/skills)
("Claude Code reads `SKILL.md` from the target"). Commit the links: a fresh clone
or container has them as soon as `npm install` has run, with no plugin and no
prompt. A session that started before the install may need `/reload-skills` or a
restart.

- **Idempotent.** Re-running `init` keeps every link and adds only missing ones
  (for example a skill a newer vigiles ships). A link an earlier `init` made
  that now points elsewhere (the shape `node_modules/vigiles/skills/<same name>`)
  is rewritten to where the package is now.
- **Workspaces.** In a workspace member, `init` links to wherever the install
  actually put vigiles (the member's `node_modules` or the hoisted root). Before
  the install that place is not known yet, so `init` makes no links and says:
  run `npm install`, then `npx vigiles init`.
- **Your skills win.** An existing `.claude/skills/<name>` that is not vigiles's
  link — your own directory, a file, a link elsewhere — is never replaced; `init`
  names the skill you did not get.
- **Not graded as yours.** A skill linked in from `node_modules` is a
  dependency's, so `lint` never reports it as an untested surface.
- **No `package.json`?** Then no install will create `node_modules/vigiles`, and
  `init` makes no links (they could only dangle) — the plugin carries the skills.
- **Windows:** creating a symlink needs Developer Mode (or an elevated shell), and
  checking one out needs `git config core.symlinks true`. `init` says which link
  it could not create.

`vigiles audit` says out loud when the skills do not reach the agent: links that
dangle (`npm install`), neither links nor plugin, only this machine's plugin (a
fresh clone won't have them), or a skill an upgrade added that is not linked yet —
each with the command that fixes it.

**Hooks come with the plugin.** Once the plugin is installed, the agent no longer
has to remember to compile:

| Hook        | Trigger                                         | Action                                   |
| ----------- | ----------------------------------------------- | ---------------------------------------- |
| PreToolUse  | Agent tries to Edit/Write a compiled `.md` file | Blocks the edit, redirects to `.spec.ts` |
| PostToolUse | Agent edits a `.spec.ts` file                   | Auto-runs `vigiles compile`              |
| PostToolUse | Agent edits linter config or `package.json`     | Auto-runs `vigiles generate types`       |

`init` installs the plugin via the marketplace; by hand in a Claude Code session:

```
/plugin marketplace add zernie/vigiles
/plugin install vigiles@vigiles
```

⚠️ **Without the plugin**, run `vigiles compile` manually after editing specs. CI still catches stale files.

With both the links and the plugin on one machine, Claude Code lists each skill
twice — `test-harness` from the link and `vigiles:test-harness` from the plugin —
because [plugin skills are namespaced, so both load](https://code.claude.com/docs/en/skills).
They are the same files; either works.

Checking by hand? Look in **`~/.claude/plugins/installed_plugins.json`** for a
`vigiles@vigiles` entry — that is what `claude plugin install` writes for a
user-scope install. A repo's `.claude/settings.json` carries _project_-level
`enabledPlugins`, and a correctly-installed user-scope plugin **does not appear
there**; judging it from `settings.json` alone reports a working install as broken.

### What `init` commits to your repo — and what it can't

`init` writes a **declaration** into your `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "vigiles": { "source": { "source": "github", "repo": "zernie/vigiles" } }
  },
  "enabledPlugins": { "vigiles@vigiles": true }
}
```

It is **merged**, never overwritten — your hooks, permissions and other plugins
are preserved, an existing `vigiles` entry is left alone (it may point at a
fork), and an explicit `"vigiles@vigiles": false` is respected as a deliberate
disable. Re-running `init` changes nothing.

**What this does NOT do: install the plugin for anyone.** Per the Claude Code
[team-marketplaces docs](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces),
as of CC v2.1.195:

> A plugin that only the project's `.claude/settings.json` enables, and that
> comes from an external source such as a GitHub repository or npm package,
> doesn't load until the team member installs it. Until then, Claude Code reports
> the plugin as not installed and shows the `claude plugin install` command to run.

vigiles ships from a GitHub marketplace, so that is exactly our case, and the
boundary is deliberate — plugins execute arbitrary code with your privileges, so
a repo is not permitted to install one on your behalf.

So the declaration buys **one** thing: Claude Code tells a collaborator the
project wants this plugin and prints the install command. **Silent absence
becomes a prompt** — for the hooks. A fresh clone and a CI job still have no
plugin until someone installs it; they do have the skills, through the links.

Nothing is vendored: two small JSON keys are a _reference_; the plugin content
stays in the global cache, one copy shared across your repos.

The reachability warning above stays **advisory and never scored**: whether the
plugin is installed and whether `npm install` has run are machine state, and a
score must not move between a laptop and CI for the same source.

**Removing it** is a two-key edit — delete `extraKnownMarketplaces.vigiles` and
`enabledPlugins["vigiles@vigiles"]`. `eject` does **not** do this: `eject` is the
per-file inverse of `compile` ("hand this compiled file back to me"), and
repo-scoped plugin wiring isn't a property of any one file. Uninstalling the
global plugin is deliberately separate too — that install is shared by every repo
on your machine, so one project can't speak for the others (`claude plugin
uninstall vigiles@vigiles` if you do want it gone everywhere).

### Codex / GitHub Copilot

Instruction file: `AGENTS.md`, read directly — there is no plugin or hook system.
The enforcement path is:

```bash
npx vigiles init --harness=codex   # full setup: scaffolds AGENTS.md.spec.ts + types + CI + Codex skills
# 1. edit AGENTS.md.spec.ts (source of truth)
# 2. npx vigiles compile        → regenerates AGENTS.md
# 3. CI: npx vigiles lint && npx vigiles generate types --check
```

Use the full `init --harness=codex` (not `init --target=AGENTS.md`, which only
scaffolds the spec) — it's what generates `.vigiles/generated.d.ts` and the CI
config that step 3's `generate types --check` depends on. The authoring skills are
**linked** into `.agents/skills/` exactly as for Claude Code (Codex
["follows the symlink target"](https://learn.chatgpt.com/docs/build-skills)), so
they travel with the repo. Only when there is no `package.json` to link from does
`init` fall back to the global cross-agent `skills` CLI
(`npx skills add zernie/vigiles -a codex -s <skills> -g -y` → `~/.agents/skills/`) —
never both, because Codex lists two skills of the same name side by side. The
eval-lock and refs nudge hooks are wired into `.codex/config.toml`.

### Multi-agent (Claude + Codex)

Use a **single spec with multiple targets** — one source of truth, two outputs:

```typescript
export default instructionFile({
  target: ["CLAUDE.md", "AGENTS.md"],
  rules: { ... },
});
```

Both compile from the same spec with the same linter verification.

### Cursor / Windsurf / other formats

vigiles compiles to **markdown only** (CLAUDE.md, AGENTS.md). For non-markdown
formats (`.cursorrules`, `.github/copilot-instructions.md`, Windsurf), use a sync
tool to convert from the compiled markdown — [rule-porter](https://github.com/nichochar/rule-porter)
or [rulesync](https://github.com/dyoshikawa/rulesync). vigiles is the source-of-truth
compiler; sync tools handle the last mile.

## Non-interactive setup (agents & CI)

`init` **auto-detects a non-TTY** and runs without prompts — a prompt as simple as
_"set up vigiles in this repo"_ is enough:

```bash
npx vigiles init        # full: specs + skills/hooks + CI + devDep (the default)
npx vigiles init --ci-only # gate only: the CI integrity gate + devDep, nothing installed
```

**Which one?** Bare `init` sets up the **full** layers (the default). Use
**`--ci-only`** when the repo **already has its own harness** (its own hooks/skills, or
its own eval loop) or **isn't JS/Python** — you get the deterministic lint gate in CI
with **zero conflict**: no plugin, no scaffolded spec, no test. It's the same choice
the interactive wizard's first question offers; an agent picks it with the flag. A
non-interactive full run **prints a one-line pointer to `--ci-only`** in its summary, so
the alternative is discoverable even when nobody saw the wizard. Either way the setup
stays non-destructive and invites the richer layers later — nothing is forced.

**Fallback — install hooks directly.** The plugin already brings the hooks. To
commit project-level hooks instead of (or alongside) the plugin, write them to
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "FILE=$(cat | jq -r '.tool_input.file_path // empty') && case \"$FILE\" in *.md) [ -f \"$FILE\" ] && head -1 \"$FILE\" | grep -q 'vigiles:sha256:' && { echo \"BLOCKED: Edit the .spec.ts source instead.\" >&2; exit 2; } ;; esac; exit 0"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "FILE=$(cat | jq -r '.tool_input.file_path // empty') && case \"$(basename \"$FILE\")\" in eslint.config.*|.eslintrc*|package.json|pyproject.toml|Cargo.toml) npx vigiles generate types 2>&1 || true ;; esac && case \"$FILE\" in *.spec.ts) npx vigiles compile 2>&1 || true ;; esac"
      }
    ]
  }
}
```

**Recommended agent prompt** — if you want an agent to set up vigiles:

```
Set up vigiles for this project:
1. Run `npx vigiles init` (adds vigiles to devDependencies and installs the
   Claude Code plugin via the marketplace — nothing is vendored into the repo).
   If this repo already has its own harness or isn't JS/Python, use
   `npx vigiles init --ci-only` for the CI integrity gate alone (nothing installed).
2. Read the generated .spec.ts, fill in the project's actual conventions
3. Run `npm install`, then `npx vigiles compile` to verify
4. Commit the .spec.ts, compiled .md, .vigiles/generated.d.ts, and package.json
```

## CI pipeline

All agents share the same CI step:

```yaml
- name: Verify specs
  run: npx vigiles lint && npx vigiles generate types --check
```

It catches hash mismatches (someone edited the compiled `.md`), missing specs
(`require-instructions-spec`), and stale generated types.

## What the agent gets wrong

- **Editing CLAUDE.md directly** — the PreToolUse hook prevents this if installed.
- **Wrong rule names** — `enforce("no-console")` instead of `enforce("eslint/no-console")`. The compiler catches it.
- **Forgetting to compile** — the PostToolUse hook handles it automatically.
- **Headers inside sections** — the compiler catches `#`/`##` headers in section content.

## See also

- [Markdown mode](markdown-mode.md) — the no-spec on-ramp (inline `<!-- vigiles:enforce -->` comments).
- [CLI reference](cli.md) — every verb and flag.
- [Harnesses](harnesses.md) — how vigiles targets Claude Code, Codex, and beyond.
