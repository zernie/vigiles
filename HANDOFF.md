# HANDOFF — volatile cross-session state

> **Overwrite each session; keep ≤120 lines.** The durable map is
> `research/roadmap.md` — this is the orientation pointer, not the record.
> The SessionStart hook injects this file so a new session starts oriented — **read it
> first.** Git-TRACKED + EPHEMERAL container, so an update persists ONLY if you
> **commit + push**. **REFRESH IT before you end the session** (and on any "handoff"
> request). A **Stop hook** nudges you at ≥5 commits without a refresh.
>
> ⚠️ **THIS FILE IS PUBLIC** (open-source repo). NO STRATEGY here — business
> direction, monetization, competitive framing, and personal plans live ONLY in the
> private `zernie/mine` repo under `vigiles/` (migrated 2026-07-13 from the old
> git-crypt `startup/` vault). HANDOFF may say strategy exists there, never name or
> describe its contents. NEVER name a specific user/company/figure here (public). (See `doc-tiers`.)

## RESUME HERE

**`vigiles.sh` is LIVE** 🎉 — landing at `/`, TypeDoc docs at `/api`, valid TLS. Site auto-deploys
via `pages.yml` on push to main. Demo UX + real-F default MERGED (PRs #100–#106).

**PR #114 MERGED** (JVM/Go linters 7→11, audit/init/compile hardening, adoption UX).
**PR #116 MERGED** (`c8910bd`) — the LinterAdapter port stages 0–3 (registry + conformance + generate-types + CI
parity + `add-a-linter` skill) + report-view card lightening. **Vlad's issues #107/#109/#110/#111/#113 — CLOSED +
personally replied** (v14.12.0; #107 1d dirty-tree + #113 looser-match stated as deferred).

**THE LINTERADAPTER PORT IS NOW COMPLETE.** `LINTERS: Record<BuiltinLinter, LinterAdapter>` (`src/core/linters.ts`)
is the LITERAL single dispatch source — a missing linter is a tsc error, `linter-contract.test.ts` catches docs/site
drift, and `add-a-linter` (`.claude/skills/`) is the authoring guide. To add a linter: `BUILTIN_LINTERS` (`spec.ts`)
→ register in `LINTERS` via `nodeApiAdapter`/`cliAdapter` (checkExists/configEnabled inline) → docs row → CI install.

**PR #117 MERGED** (`c9b2a96`) — the follow-up (Stage 4 + site-chip derivation + cedar P1) off main.
Stage 4 = collapsed the 4 legacy dispatch maps (`LINTER_RESOLVERS`/`CLI_RULE_CHECKS`/`LINTER_CONFIG_CHECKERS`/
`CLI_TOOL_FOR_LINTER` + `getCliRuleSet`) into the adapters, behavior byte-preserved (golden `linters.test.ts` 307
green; done by a background subagent, dispatch reviewed). Site = `Wedge.tsx` now DERIVES the linter chip strip from
`BUILTIN_LINTERS` via a new `@engine/spec` alias (can't go stale; conformance test guards the derivation). Cedar =
KEPT + P1 roadmap item ("Cedar verification depth — beyond presence"); its reference docs already exist in
`docs/linter-support.md` § Cedar Policies. Stale-ref sweep: `CONTRIBUTING.md` + `ci.yml` comment + roadmap + research
index all de-referenced the deleted maps. Full suite green (2352 passed | 24 skipped), site builds + bundles the names.

**DOGFOOD BATCH — DONE.** A 4-agent Sonnet fan-out found **14 verified, source-traced bugs**; founder's call was
**FIX, not file**. **All 14 fixed + pushed**, each with a regression test; full `vitest` suite green (2327 passing).
The process is now CODIFIED as `.claude/skills/dogfood-cli` (the find+fix fan-out method + every lesson).

Fixed (by commit): **#108** marketplace `owner` · **#112+C3/C4/C5** config parse-don't-validate · **I2** Codex install
`-s`-scoped to `SHIPPED_SKILLS` · **D2** hook-block exit-2-in-comment · **A/I3** `audit`+`init` honor config `harness`
(via `resolveHarnessSelection`) · **E1 (P0)** real on-disk surface paths not the phantom `.claude/...` key (both
`ScanAgent/ScanSkill.path` AND frontmatter-family findings, disk+browser) · **C2** clean top-level error message (no
stack trace) + exit 2 · **D1** `hook-script-exists` ignores a glob (`find -name "*.js"`) · **E2** default `lint`
integrity-checks compiled subagents · **E3** `init` reports unmapped frontmatter keys even on malformed YAML · **I1/I4**
CI-workflow gates `npm install` on package.json + the lint job on the lint pillar.
Bonus finds fixed en route: a pre-existing `scanFiles`<->`scanPlugin` parity failure (browser `ownTestSignal`), a
literal NUL byte in scan-core (read as binary), and a missed I2 e2e assertion (only the FULL suite caught it).

**VLAD'S ISSUES #107/#109/#110/#111/#113 — ALL FIXED** (fanned out per the dogfood-cli skill: #109 linters +
#110 scan-FPs on background agents, verified + integrated). #107 skill `allowed-tools` list + `context:fork` adopt
(1d dirty-tree deferred as founder UX) · #109 JVM/Go linter catalogs (detekt/ktlint/checkstyle/golangci-lint, 7→11) ·
#110 example-link + shell-comment scan FPs · #111 non-JS harness guide · #113 include docs. Full suite green.

**PR #114 REVIEW-FIX + PREVENTION PASS — PUSHED.** After the meta-analysis, addressed the Codex bot P2s +
prevention: (a) skill-resource-resolves LINK RECALL — a markdown link is real UNLESS an illustrative cue (don't
also require a use-verb, or `Resources: [API](x.md)` goes unchecked); bare inline path keeps the stricter gate; +
recall test. (b) detekt CLI check threads `basePath` not `process.cwd()`. (c) #4 adopt-surface ROUND-TRIP GATE
(every standard skill frontmatter field survives adopt→compile→re-adopt — the #107 drift class). (d) dogfood-cli
skill: "two recurring bug classes" (unverified external contract → parse-don't-validate + unit shape assertion;
incomplete fix → grep siblings + one choke-point + gate test). Full suite green (2332 passing).

**⏳ PENDING FOUNDER DECISION — adopt.ts markdown parsing.** Founder flagged (correctly) that `adopt.ts`
`splitBlocks` parses CLAUDE.md/agent BODY structure with HAND-ROLLED REGEX (`HEADING_RE`/`FENCE_RE` + manual
fence toggle), a `prefer-existing-solutions` gap. REAL BUG exposed: the fence toggle matches any 3+ backtick run,
so a nested/mismatched fence (4-backtick block containing ```) mis-splits a `##`inside code as a heading; setext
headings missed too. (Skills unaffected — body is verbatim; frontmatter IS js-yaml.) FIX = swap boundary-detection
to`markdown-it` `token.map` line ranges, keep VERBATIM slicing on source offsets (never AST-reserialize — breaks
round-trip), add a nested-fence fixture. Tradeoff: adds 1 runtime dep to a deliberately dep-light CLI (13 deps).
Recommended DO IT (markdown-it, browser-safe, minimal). AWAITING founder: do-on-#114 vs file-separately.

**GATE-FAILURE RULE (founder, standing): if a skill/hook/rule DIDN'T CATCH an issue the founder had to spot,
FIX THE GATE FIRST.** (e.g. the mobile-overflow CI gate + the responsive-grid lesson in `.claude/skills/landing-site`.)

**FLAG (founder's call):** the PR-CREATION harness auto-appends a `claude.ai/code/session_…` URL to PR bodies
(public no-session-links rule). Using the GitHub MCP `create/update_pull_request` (as this session did) AVOIDS it.
If a PR is opened another way, edit the body to end at the `claude.com/claude-code` line.

**FETCH-TAIL DOCUMENTED — do NOT chase Codex's `fetchRepo` P2s.** Demo fetches a BOUNDED set; invariant = NEVER GRADE
PARTIAL DATA. Canonical: `research/browser-demo-fetch-limits.md`.

**TOP GOAL (`.claude/skills/landing-site`): maximize visitors who RUN `npx vigiles audit`.** HOLD every `site/` change
against the skill (READ it before touching `site/`); screenshot desktop AND full 390px mobile.

### 🎯 DO NEXT

0. **The linter work is DONE** — PR #116 + #117 both merged; the LinterAdapter port is complete and the roadmap's
   "Vlad's real-harness pass" block is moved to "Shipped recently". No open linter follow-up.
   The GHA PR-comment grade (item 6) stays deprioritized (later-adoption, not guaranteed after gate-first init).
1. **Item 4b b2 (per-grade OG card)** — the ONLY remaining share-loop piece: a card showing `owner/repo · actual grade`.
   Needs a SERVERLESS OG endpoint (GitHub Pages is static, can't vary `<meta>` by `?repo=`) → bundles with **4c**
   (time-boxed upload, needs backend). b1 (generic card) is SHIPPED (`site/public/og.png` + tags in `site/index.html`).
2. **Item 5 (one opt-in README badge)** — after the share loop; badge-fatigue data says exactly one.
3. **STRENGTHEN THE IN-REPORT INVITATION (the real growth lever, per adoption-design.md §1 reasoning).** The terminal
   nudge is now value-framed (why a spec), but the HTML report's adoption surface (Adopt/adoptability preview) deserves
   its OWN focused pass with screenshots + a Fable cold-visitor review — "make a skeptic WANT a spec/eval by showing
   what it'd catch". This is where richer-feature adoption is won (gate is opt-in, so the invitation must carry it).
4. **davila7-F reconciliation** — featured at F but not MIT-vendored/opted-in; prefer the live `?repo=` grade or apply
   the vendoring policy before the leaderboard hardens.

### Codex trigger-rate is EXPERIMENTAL

Deterministic Codex audit = full parity (KEEP). Real-model **trigger-rate** on Codex is NOT trustworthy
(no skill-fire event → `codexSkillFired` infers from `SKILL.md` reads); marked `⚠ EXPERIMENTAL` across the API +
`docs/harness-testing-codex.md`. Promote only after a LIVE oracle-accuracy run (needs `codex` + quota).

### STILL OPEN

- **Multi-harness audit DX** — DEFERRED (audit is CLAUDE-CODE-FOCUSED); design in `research/audit-harness-dx.md`,
  scope entry in `roadmap.md` (Later).
- **Backend audit service (rate-limited LLM)** — `roadmap.md` (Later); the demo reference/behavioral-gap fix.
- **Codex trigger-rate promotion** — the live oracle-accuracy run above (blocked on codex + quota).
- Personal/launch/calendar follow-ups → PRIVATE `zernie/mine` only. Do not restate here.

## Design-of-record

- **`research/rule-enforcer-design.md`** — THE front door (STATUS: ALPHA). Pipeline
  diagram, the rescue-ladder/no-signal-fold decisions, the category↔lane↔glyph table,
  §8 scope-freeze+backlog, §9 testing. Read FIRST. (`rule-enforcer-multilang-design.md`
  is the older build-log; it defers to this doc.)
- **`research/dogfood-corpus.md`** — the dogfood map + policy (read before touching any
  dogfood artifact). The word "dogfood" covers FOUR different things — only
  `test/dogfood/` is the SHA-pinned vendored corpus; `examples/harness/dogfood/`=skill
  examples (model-gated MANUAL), `rule-enforcer/gold/`=package-internal, `research/audit-captures/`
  =captured audit OUTPUT (not tests).

## Gotchas (still live)

- **CI won't trigger on Claude-authored commits** — `ci.yml` fires on `pull_request` but
  GitHub suppresses workflow runs for commits authored by `Claude <noreply@…>`. If a PR's
  checks don't start: Approve-and-run-workflows in the PR UI, or Close→Reopen the PR.
  (`pr-title.yml` on `pull_request_target` always runs.)
- **Real-model evals run in-container on the SUBSCRIPTION** (`claude -p`; `$0` metered).
  Cold start ~20s+; a first probe may time out — retry longer.
- **A SKILL.md is NOT a skill unless registered** — bare `SKILL.md` in cwd never loads;
  use `arm.pluginDir`/`skillsDir`. `CLAUDE.md` DOES auto-load as memory.
- **The 100% coverage gate is an EXPLICIT allowlist** in `vitest.config.mjs`
  (`coverage.include`). A new pillar file must be added there + real-IO seams marked
  `/* v8 ignore */`.
- **`measure()` is SINGLE-arg** — `measure(spec)` where `checks`/`trials`/`model` live
  INSIDE the one object. (Root `CLAUDE.md` eval.ts desc still wrongly says
  "measure(spec, { trials, checks })" — fix the spec later.)
- `CLAUDE.md` (root + `src/` + `research/`) is COMPILED from `.spec.ts` — edit the spec +
  recompile (`node dist/cli.js compile <spec>`), NEVER hand-edit (a PostToolUse hook does).
- **COMMIT SIGNING is BROKEN in-container** (0-byte pubkey) → "Unverified"; email correct.
- **`add_repo` is same-owner only** — fetch external files via
  `curl https://raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH` (through the proxy).
- Commits/PR: NO session links / NO raw model-id strings. Conventional-Commit titles;
  a public-API removal/rename needs `!` (drives the semantic-release major bump).

## Don't re-read unless the task needs it

- strategy KB — PRIVATE `zernie/mine` repo under `vigiles/` (`add_repo zernie/mine`).
- `research/roadmap.md` — the front-door (technical) roadmap.
