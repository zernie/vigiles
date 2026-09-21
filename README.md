<!--
  README DIRECTION — read before editing; keep changes aligned.
  Front door + marketing asset for someone who lives in Claude Code / Codex.
  Optimize for a phone-skimmer who must come away knowing WHAT IT IS and wanting
  to run it — never scared off. Validated by a 6-persona cold-read (2026-07):
  newcomer / power-user / plugin-author / skeptical-senior / decision-maker /
  Codex-user. The fixes below trace to that review — don't regress them.

  HOOK = FELT PAIN, then breadth (founder direction 2026-07). Bold tagline is a
  specific second-person pain: "You have a rule your agent follows half the time
  — and no way to know which one." It's rhetorical (the reader's own uncertainty),
  NOT an ecosystem stat — do NOT reintroduce a bare "%"/number in the tagline (the
  doc mocks uncited stats: "'65% fewer tokens.' Says who?", so a fake stat up top
  reads as hypocrisy). Dev-native CRAFT bait, NOT enterprise fear (OSS dev tool,
  not a security product). The report-card + 5 rings RIGHT BELOW show the breadth
  so the specific hook doesn't read as narrow.

  DEFINE "HARNESS" on first use (the load-bearing noun, used ~15×) — gloss it as
  "the CLAUDE.md/AGENTS.md rules, skills, subagents, and hooks steering your
  agent." 4 of 6 personas bounced on it being undefined. Keep the gloss.

  INSTRUCTION-NEUTRAL NOUNS (Codex was the lowest score): body copy says CLAUDE.md
  OR AGENTS.md, never CLAUDE.md alone. The tagline may keep punch, but Codex must
  appear within the first sentence or two (the harness gloss names AGENTS.md), and
  every "adopts your CLAUDE.md"/"verifies your CLAUDE.md" gets "or AGENTS.md".

  CATEGORY = A TOOL YOU RUN (ESLint/Lighthouse/npm audit class), NOT a framework,
  NOT a lib-collection. The FAQ says this outright — it's the #1 thing that scares
  people off. The library/subpath exports are the automation door for the 5%.

  AUDIT vs LINT — ONE CONSISTENT, ACCURATE STORY (a persona caught 3 conflicting
  answers): `lint` = the CI gate on the deterministic checks (broken refs, tool
  contracts, dead hooks, skill collisions — Proofs 1 & 2). `audit` = those same
  checks + the Safety ring + two opt-in LIVE checks (MCP connects? skills fire?)
  + the graded report. Do NOT claim lint gates the lethal-trifecta Safety flag
  (it's an audit ring, not a default gating rule) and do NOT say lint is
  refs-only. The table row, the reconciliation line, and the Lint subsection must
  all agree.

  SPINE = proof/demo-led. Real, screenshotable catches on shipped plugins, THEN
  mechanism. Every proof traces to a real dogfood run (research/audit-captures/) — NEVER
  fabricate one. Order = most-RELATABLE first (broken tool ref → skill collision →
  rules-not-enforced → secrets-exfil gotcha LAST as the bite). The intro triplet
  maps to the three "vibes break silently" proofs (1, 2, 4); Proof 3 (your rules →
  enforced) pays off the TAGLINE's rule-follows-half-the-time pain. Security is ONE
  dev-native GOTCHA proof, never the brand. Add a repro
  line ("run `npx vigiles audit <any-repo>` for your own") + a one-line note that
  examples use CC subagents but the checks run on Codex too. FALSE CONFIDENCE is
  the coined term (a guard that looks like it works and silently doesn't), defined
  once in the Test section.

  FUNNEL: "How it works" opens with the audit/lint/test/eval verb-map table — the
  load-bearing "one tool, not four" fix. Frame it vibes → verified. Name that
  init/compile/eject manage the spec layer (personas noticed the verb-count gap).

  DON'T SHAME OSS: catches are ANONYMIZED (no obra/superpowers, madappgang,
  claude-flow by name) — real names live only in research/audit-captures/.
  Guard/compiled-hooks stay PARKED FOR LAUNCH as a hero section; the 2/7→7/7 finding is
  surfaced as ONE supporting, receipts-linked evidence line under Proof 4 (→
  docs/compiled-hooks.md §disler battery + src/hook-dogfood.test.ts) — reachable
  evidence under the Lighthouse umbrella, not the hero, not the brand.

  WEBSITE (added 2026-07-22): vigiles.sh is the LIVE interactive demo (grade any
  repo in the browser). The README is the AGENT's install door + the GitHub/npm
  landing — it LINKS to the site prominently (hero line + badge + the catches CTA
  + quick-start + docs) rather than re-embedding the whole proof. The 4 detailed
  Proof narratives were COLLAPSED to a 4-bullet list that leans on the live demo +
  docs/what-vigiles-catches.md (the site + that doc own the depth). Don't re-expand
  them here; deepen them on the site or in docs instead. Split of labour: site =
  marketing/try, README = install + 60-sec what, docs/ = the shared HOW.

  RULES: lead with the reader's CONCRETE PAIN; ≤ ~3-line paragraphs; ONE bold per
  block; ONE idea per sentence; NO internal vocabulary (moat/flywheel) / NO
  research/ links / NO enterprise/national-interest framing — name the user
  benefit; ~220-line body cap; push depth into docs/ and LINK it. Assets: the hero
  vigiles-audit.png is a REPRESENTATIVE report ("my-plugin", C 77) — the verdict-
  led header + category strip + ranked fixes + broken references. The "Your rules →
  enforced" preview is DEMOTED low + badged EXPERIMENTAL (the rule map is alpha —
  research/rule-enforcer-design.md §8). Re-render if the UI changes: `npm run build`
  (rebuilds report/dist/index.html from the SAMPLE fixture), then headless Chromium
  (puppeteer-core, executablePath /opt/pw-browsers/chromium) with
  prefers-color-scheme:dark emulated + a fullPage screenshot at deviceScaleFactor 2
  → vigiles-audit.png (2200px wide).
-->

<p align="center">
  <img src="logo.png" width="140" alt="vigiles logo" />
</p>

<h1 align="center">vigiles</h1>

<p align="center">
  <strong>You have a rule your agent follows half the time — and no way to know which one.</strong>
</p>

<p align="center">
  Verify your CLAUDE.md or AGENTS.md, skills, and hooks are real — and prove they actually work.
</p>

<p align="center">
  <a href="https://vigiles.sh"><strong>▶ Grade any public repo live at vigiles.sh</strong></a> — no install, runs in your browser.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vigiles"><img src="https://img.shields.io/npm/v/vigiles?color=orange" alt="npm version" /></a>
  <a href="https://github.com/zernie/vigiles/actions"><img src="https://img.shields.io/github/actions/workflow/status/zernie/vigiles/ci.yml?branch=main" alt="CI" /></a>
  <a href="https://github.com/zernie/vigiles/blob/main/LICENSE"><img src="https://img.shields.io/github/license/zernie/vigiles" alt="License" /></a>
  <a href="https://vigiles.sh"><img src="https://img.shields.io/badge/demo-vigiles.sh-f97316" alt="live demo" /></a>
</p>

---

**You review every PR. Nothing reviews your CLAUDE.md.**

Your **harness** — the CLAUDE.md or AGENTS.md rules, skills, subagents, and hooks steering your agent — is the one part nobody checks. Nobody verified it's real. Nobody tested it works. That's not a system. That's vibes.

And vibes break silently mid-task: a subagent wired to a tool that doesn't exist, two skills your agent can't tell apart, one helper quietly able to read your secrets and send them out.

vigiles[^name] checks your harness is _real_, not just well-formed — Claude Code and Codex alike. One command, no key, no config, safe on any repo:

```bash
npx vigiles audit
```

It's free and open-source, runs entirely on your machine, and never bills per token. (`eval` is the only step that calls a model — on your own Claude subscription.) Here's what it caught on plugins people actually ship. ↓

## What it caught

<p align="center">
  <img src="vigiles-audit.png" width="760" alt="vigiles audit report for my-plugin: a verdict header reading 'Two one-line fixes away from a B.' next to a C (77/100) grade, a five-category strip (Truthfulness, Triggering, Structure, Safety, Tested), ranked fix cards with '+N pts' impact badges, broken-reference findings — and, lower down and badged experimental, a 'Your rules → enforced' preview mapping a prose rule the config silently turns off" />
</p>

**Like Google's Lighthouse, but for your agent harness.** One command grades it A–F across six categories, leads with a plain-English verdict — _"two one-line fixes away from a B"_ — and ranks every fix by the points it buys back:

- **Truthfulness** — do the references resolve?
- **Triggering** — do skills fire, without colliding?
- **Structure** — are tool contracts and configs valid?
- **Safety** — any way for the agent to leak your data?
- **Tested** — does the harness ship deterministic tests?
- **Evaluated** — has anything measured whether your skills actually _fire_? (Distinct from `0`: if nothing asked, it says **not measured**.)

And it closes the loop from prose to enforcement: **your rules → enforced** maps each rule you wrote to the lint rule that actually enforces it — already on, one config line away, or silently turned off (below).

These are real scans of public plugins — run `npx vigiles audit <any-repo>` for your own. The examples below use Claude Code subagents; the same checks run on Codex `AGENTS.md`, skills, and hooks. ↓

Every one of these is **valid markdown** — parses fine, does the wrong thing. That's the gap a style linter can't see:

- **A tool your agent thinks it has and doesn't** — a subagent lists a tool that isn't available to it. The harness drops it silently; the agent loses a capability it believes it has.
- **Two skills your agent can't tell apart** — near-identical descriptions, so the agent (which picks by _reading_ them) fires the wrong one. One popular plugin ships 45 such pairs.
- **A rule you wrote that nothing enforces** — `"always use ==="` while `eqeqeq` is set to `"off"` in your ESLint config. Your CLAUDE.md says enforce it; your config quietly turns it off.
- **A subagent that can read your secrets and send them out** — one holding all three "lethal-trifecta" legs (reads data · takes untrusted web input · can send data out). A poisoned page makes it POST your `.env` anywhere — no exploit, just the tools it was given, hidden behind a healthy-looking grade.

**[▶ See these live at vigiles.sh](https://vigiles.sh)** — grade any repo · **[everything it catches →](docs/what-vigiles-catches.md)**. Point `audit` at a whole marketplace and it ranks every plugin the same way.

## How it works — vibes → verified

`audit` shows you where your setup is still vibes. Turning that into _verified_ is four commands over one engine — and almost none of it needs a model or a key.

| Command | Answers                        | Needs a model?           | When to run              |
| ------- | ------------------------------ | ------------------------ | ------------------------ |
| `audit` | Everything, graded A–F         | No — read-only[^audit]   | Anytime; it's the report |
| `lint`  | Do the structural checks pass? | No                       | CI gate, every push      |
| `test`  | Does the harness behave?       | No — a scripted stand-in | Every commit             |
| `eval`  | Does a skill actually help?    | Yes — your subscription  | On demand                |

**One engine, two doors.** `audit` is the local report; **`lint` is the CI gate** that fails the build on the same deterministic checks — broken refs, bad tool contracts, dead hooks, skill collisions (Proofs 1–2). `test` and `eval` go further: past _does it exist_ to _does it work_. (`init` / `compile` / `eject` manage the optional typed-spec layer for the structural rules no linter can express — a graduation step you rarely run by hand. If you use a spec, run `compile` in CI too: it is what re-derives that spec's refs, while `lint` verifies the compiled file is intact.) [How the verbs relate →](docs/commands-and-how-they-relate.md)

### 🔎 Lint — your instructions stop lying

Every path, script, symbol, and rule verified against reality — plus tool contracts, skill collisions, and dead hooks (the catches above). You don't write the checks, and you don't port anything into a spec: `lint` reads the `CLAUDE.md` or `AGENTS.md` you already hand-edit and checks it as-is. Rules that map to a real linter rule run in your own config (ESLint, Ruff), not a shadow layer.
**[How →](docs/verifying-instruction-files.md)**

### 🧪 Test — does the harness actually do its job?

A hook that blocks nothing, a skill that hijacks unrelated prompts, context that never reaches the model — each passes a naive "did it run?" check. That gap is **false confidence**: a guard that looks like it works and silently doesn't. vigiles tests the real thing — hooks block, skills fire, subagents finish what they promised, a stray `git push` is caught before it happens. It drives a scripted stand-in for the model, not a live call, so it needs no key and runs on every commit.
**[How testing works →](docs/harness-testing.md)** · Got a safety hook? **[Prove it blocks `rm -rf` and force-push →](docs/harness-testing.md#prove-a-guard-actually-blocks-the-disaster-battery)**

**Nothing you scan leaves your machine.** `lint`, `audit` and the deterministic test tiers make no network call at all — no telemetry, no analytics, no HTTP client in the package. Evals drive your own `claude` CLI on your own subscription, so no third party is introduced. **[What is and isn't transmitted →](docs/safety.md#does-vigiles-send-my-code-anywhere)**

### 📊 Eval — the only way to put a real number on cost

_"Caveman Mode cuts 65% of your tokens." Says who?_ vigiles A/Bs the claim on real coding tasks and hands you three numbers: the **token bill**, whether it hit its **target**, and whether your code still **works**.

```text
caveman vs baseline · sonnet · 7 tasks × 5 trials · $0 on your subscription
  output tokens   6% lower on average   (the claim was 65% — and it GREW on 2 of 7 tasks)
  bill            $0.5396 → $0.5334     (flat — output is only ~20% of the cost)
  correctness     1.0 → 1.0             (nothing broke)
```

Point it at any harness change that claims a number — does a compression skill pay for itself, is a subagent worth its cost, which model is cheapest here. promptfoo and DeepEval bill **per token, every run**; vigiles runs on your own Claude Pro/Max subscription, so you measure on every change, not once. A committed lock file (like `package-lock`) keeps CI honest without re-calling the model. (Claude Code today; Codex landing.)
**[Measure a skill →](docs/measuring-skills.md)**

## Quick start

**1. See what's broken** — read-only, no setup (or try it in your browser first at **[vigiles.sh](https://vigiles.sh)**):

```bash
npx vigiles audit
```

**2. Set it up** when you like what you see. Paste into Claude Code or Codex:

```text
Set up vigiles in this repo: run `npx vigiles init` and accept the defaults. If I
already have a CLAUDE.md or AGENTS.md, audit it and show me which references are
stale and which of my rules aren't enforced. Then write + run one harness test for
a hook or skill of mine. Don't run a real-model eval without asking me first.
```

Or run it yourself:

```bash
npx vigiles init   # sets up the typed spec for structural rules (non-destructive — eject reverses), adds CI,
                   # installs vigiles's skills + hooks as a Claude Code plugin. The plugin
                   # CONTENT goes to ~/.claude/, never your repo; init also commits a two-key
                   # reference to it in .claude/settings.json so teammates get prompted to
                   # install it rather than silently missing it. Codex: skills install globally.
```

**Already have a harness, or a non-JS repo?** `npx vigiles init --ci-only` sets up just the CI integrity gate — nothing installed, zero conflict. **[When to use gate vs full →](docs/agent-setup.md#non-interactive-setup-agents--ci)**

Interactive in a terminal, non-interactive for agents/CI (or `--yes`). **Works with Claude Code and Codex** — vigiles verifies `CLAUDE.md` and `AGENTS.md` the same way. **[Codex setup →](docs/harnesses.md)**

**Adoption is smooth: one command, then your agent does the rest.** `init` installs the **skills and hooks**, so a plain-English ask does the work — no specs to hand-write, no hooks to wire:

- _"test my skills"_ → scaffolds **and runs** a trigger/behaviour test, then commits its result so CI can check it (`test-harness`)
- _"harden my rules"_ → upgrades prose guidance into enforced linter rules (`strengthen`)
- _"add a rule to my CLAUDE.md or AGENTS.md"_ → edits the source and recompiles (`edit-spec`)

The **hooks** keep it honest in-loop — nudging the agent to tag a linter-rule mention so vigiles can verify it, or to re-run a test whose result just went stale — so there are no chores to remember.

<details>
<summary>What <code>init</code> sets up</summary>

- **Both lint and test** by default; scope with `--lint` / `--test`.
- **Already have a CLAUDE.md / AGENTS.md, skills, or subagents? `audit` and `lint` read them as-is** — nothing is moved or rewritten. For the structural rules that want a typed spec, `init` sets one up **non-destructively** (`eject` undoes it).
- Adds `vigiles` to `devDependencies`; installs the Claude Code plugin (skills + hooks) via the marketplace — globally, never vendored.
- Declares that plugin in your repo's `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`, merged into whatever is already there). This is a **reference, not content** — nothing is vendored, and it does **not** install the plugin for a teammate: an external-source plugin declared project-level [doesn't load until each person installs it](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces). What it buys is that Claude Code **prompts** them with the install command, instead of a fresh clone silently having the npm package and none of its skills.
- Wires CI as a `zernie/vigiles@v1` workflow (needs only read + PR-comment permissions) that posts a sticky PR comment + a `valid` output.

Targets Claude Code and Codex out of the box, or [your own harness](docs/authoring-an-adapter.md). Prefer to write tests yourself? JS **or** TS (`*.harness.{mjs,ts}`) — run with `npx vigiles test`.

</details>

## FAQ

- **Is this a framework I have to build around?** No. It's a tool you run — like ESLint, Lighthouse, or `npm audit`. One command, a report, an optional CI gate. There's a library API for automation, but you never touch it to get value.
- **Isn't this just a markdown linter?** No — it checks whether your instruction file is _true_ (every path/script/symbol/rule exists and is enabled), then tests and measures your harness. A style linter can't do any of that.
- **Does anything leave my machine?** No. `audit` and `lint` read your local repo — no upload, no account, no server. (`eval` is the only step that calls a model, on your own Claude subscription; the browser demo only reads a public repo you name via GitHub's API.)
- **What do I have to change to adopt it?** Almost nothing. Plain markdown works with zero new files, rules run in your existing linter, and the agent edits the specs for you. The typed spec is opt-in, only for structural checks a linter can't express — like TS's `strict` ([why?](docs/faq.md#why-are-the-strongest-guarantees-opt-in-not-the-default)).
- **Non-JS repo?** `npx vigiles lint` verifies your CLAUDE.md or AGENTS.md with no install (Ruff/Clippy/golangci-lint/detekt/… too — 11 linters across Python, Rust, Go, Kotlin, Java, Ruby, CSS).

**[Full FAQ →](docs/faq.md)**

**Not for you if** you want a model/capability benchmark or runtime guardrails in the request path — vigiles is build-/CI-time.

## Docs

**[vigiles.sh](https://vigiles.sh)** is the live demo — grade any repo in your browser. The **[docs index](docs/README.md)** is the full map, grouped by what you're doing:

- **Guides** — [verify instruction files](docs/verifying-instruction-files.md) · [test your harness](docs/harness-testing.md) · [measure a skill](docs/measuring-skills.md) · [ship a plugin](docs/for-plugin-authors.md) · [Codex & other harnesses](docs/harnesses.md)
- **Reference** — [CLI](docs/cli.md) · [configuration](docs/configuration.md) · [rules matrix](docs/verifying-instruction-files.md#the-validation-rules--the-full-matrix) · [testing API](docs/testing-api.md) · [full API](https://zernie.github.io/vigiles/api/)
- **Explanation** — [what it catches](docs/what-vigiles-catches.md) · [how it compares](docs/comparison.md) · [FAQ](docs/faq.md)

> **A name starting with `experimental_` is not covered by semver.** It may change
> shape or disappear in a patch release. Everything so named has a stable
> alternative, given in that feature's own docs page — and the prefix is the only
> signal you need to look for, since it is on every call site rather than on an
> import line you scrolled past. See [Stability](STABILITY.md).

**Project** — [Stability](STABILITY.md) · [Contributing](CONTRIBUTING.md) · [Related tools](docs/comparison.md#what-vigiles-composes-with) · ships as an [Agent Plugins](https://agent-plugins.org) 1.0.0 plugin ([how to do the same](docs/for-plugin-authors.md#6-ship-it-in-the-portable-agent-plugins-format))

<!-- The "companion to [Feedback Loop Is All You Need](https://zernie.com/blog/feedback-loop-is-all-you-need)"
     link is temporarily removed while AgenticDev paper #1 is under blind review: repo → blog is a
     deanonymization path (the reviewer-offer email links this repo). RESTORE after notification (2026-08-21). -->

## License

[MIT](LICENSE)

[^name]: **vigiles** — the watchmen of ancient Rome, who guarded the city (and fought its fires) by night. _Quis custodiet ipsos custodes?_ — "who watches the watchmen?" (Juvenal, _Satire VI_).

[^audit]: `audit` reads only by default. Two deeper checks — live MCP connections and skill-firing — are opt-in and ask before they run.
