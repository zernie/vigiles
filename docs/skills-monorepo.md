# Adopting vigiles in a skills monorepo (no `plugin.json`)

> The [README](../README.md) has the pitch; this is the how-to for a repo that is
> **not** a published `.claude-plugin/` marketplace — a CI-tested skill library, or
> a plain Claude Code repo where your skills live under `.claude/`. If `audit`
> reported `F (0/100) — no loadable plugin surface`, this page is for you.

## The three repo shapes vigiles recognizes

You do **not** need a `plugin.json` or a marketplace layout. vigiles loads any of
these as first-class:

| Shape                      | Where skills live                                                                           | Typical repo                     |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| **Published plugin**       | `skills/<name>/SKILL.md` + `.claude-plugin/plugin.json`                                     | a marketplace plugin             |
| **Skills library**         | `skills/<name>/SKILL.md` at the repo root, no manifest                                      | a CI-tested skill monorepo       |
| **Plain Claude Code repo** | `.claude/skills/<name>/SKILL.md` (+ `.claude/agents`, `.claude/settings.json`, `CLAUDE.md`) | a normal user repo, not a plugin |

Point `audit`/`lint` at the repo root and vigiles reads every shape it finds.
You can also point it at a **single skill directory** (the dir holding one
`SKILL.md`) and it scans just that skill.

```bash
npx vigiles audit .                      # the whole repo
npx vigiles audit skills/rca-investigation   # one skill dir
```

ℹ️ **A repo with BOTH `skills/` and `.claude/skills/` is audited as both**, because
Claude Code loads both:

> Plugin skills use a `plugin-name:skill-name` namespace, so they can't conflict
> with other levels. For example, `my-plugin/skills/deploy/SKILL.md` becomes
> `/my-plugin:deploy` and loads alongside a `deploy` skill in your project's
> `.claude/skills/`.
> — [Claude Code docs, "Where skills live"](https://code.claude.com/docs/en/skills)

So the same NAME in both places is **two skills**, not one, and vigiles reports two
surfaces at their two real paths plus a warning that the repo carries two discovery
levels. (Until 2026-08, vigiles read one location and reported it under the other
one's path — measured on a real plugin, 50 skill names existed in both trees and
all 50 pairs differed, so fifty audited "skills" named files that were never opened.)

The deterministic sandbox is a project directory, so it registers the **project**
scope only; exercise a plugin scope through `pluginDir` (a real `--plugin-dir`
install), which is what a session does with an installed plugin anyway.

⚠️ vigiles reads your **project** `.claude/` only. It never scans the machine-global
`~/.claude/` install — CI results stay reproducible and independent of the runner's
home dir.

## Shared `scripts/` / `references/` trees — `sharedDirs`

Many skill libraries keep **one** top-level `scripts/` (or `references/`) tree that
several skills point at, instead of a copy beside every `SKILL.md`:

```
repo/
  skills/eval-generator/SKILL.md   # body references `scripts/promptfoo/leak_scan.py`
  scripts/promptfoo/leak_scan.py   # ...which lives HERE, at the repo root
```

By default a bundled reference resolves against the skill's **own** directory, so
the ref above would be reported as a missing bundled resource. Declare your shared
dirs in `.vigilesrc.json` and vigiles **also** resolves those refs against the repo
root:

```json
{
  "sharedDirs": ["scripts", "references"]
}
```

- ✅ **Opt-in.** A repo that omits `sharedDirs` behaves exactly as before
  (skill-dir-only resolution) — no change.
- ✅ **Scoped.** Only a ref whose **first path segment** is a declared shared dir
  gets repo-root resolution. A ref outside those dirs is never masked by a
  same-named file at the repo root, so a genuinely-missing bundled resource is
  still flagged.

## What resolves and what's skipped in a `SKILL.md` body

The bundled-resource check is deliberately high-precision (it won't cry wolf on a
legitimate authoring style):

| In the body                                                | Treated as                                 |
| ---------------------------------------------------------- | ------------------------------------------ |
| `scripts/run.sh`, `[api](references/api.md)`               | a concrete ref — checked                   |
| `references/*.md`, `scripts/tests/test_<target>_*.py`      | a glob / placeholder — **skipped**         |
| `references/linter-cards/{trivial,contextual}/<linter>.md` | a template placeholder — **skipped**       |
| `Read ~/.claude/docs/x.md`                                 | an external home/global path — **skipped** |
| `${CLAUDE_PLUGIN_ROOT}/x`, `https://…`, `/abs/path`        | var / URL / absolute — **skipped**         |

## Centralized tests — `{surface}` in `include`

A skills monorepo usually keeps its suites in one tree
(`tests/<skill>/evals/…`) rather than beside each skill. Say so with the
`{surface}` placeholder, which is replaced with each skill's own name before
matching:

```json
{
  "rules": {
    "untested-skill": [
      "warn",
      { "include": ["tests/{surface}/evals/promptfooconfig*.yaml"] }
    ]
  }
}
```

Without the placeholder a custom glob widens what counts as a test file but
never says which skill a file covers, so it credits nothing.
[Full rules and the trade-off →](rules/untested-skill.md)

## Which surfaces gate CI

`audit` is a **local report** (like Lighthouse). For CI, use `vigiles lint` — the
deterministic gate. The lethal-trifecta findings are summarized with a count (one
line per subagent; skills that declare no `disallowed-tools:` fence collapse into a
single aggregate line, since that is the default state of nearly every skill —
see [lethal-trifecta](rules/lethal-trifecta.md#skills-the-fence-is-disallowed-tools)).
Gate on "no NEW trifecta" via the `lethal-trifecta` lint rule rather than eyeballing
the list.

**Scoping.** `vigiles lint` (no path) lints the whole repo — the normal CI call.
Pass a single directory (`vigiles lint packages/foo`) to scope every surface rule
to just that subtree; a file, several paths, or none falls back to the whole repo.
A surface outside the path you pass — and the machine-global `~/.claude` — never
enters the report.

## See also

- [Measuring skills](measuring-skills.md) — A/B a skill on your subscription.
- [Verifying instruction files](verifying-instruction-files.md) — the lint rules.
