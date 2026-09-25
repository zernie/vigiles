# Dogfood corpus — real, SHA-pinned OSS plugins

This is vigiles's **dogfood corpus**: SHA-pinned slices of real, third-party
Claude Code plugins, committed so the loader, scanner, and rules are tested
against **reality** — offline, model-free, in every CI run. Consumed by
`src/adapters/claude-code/vendor.test.ts` (loader invariants),
`src/scan-vendor.test.ts` (golden rule verdicts), `src/scan-cli.test.ts` (CLI
e2e), and the hook/sandbox/agent suites.

Saved audit **reports** from dogfood runs live separately in `research/audit-captures/`
(the human-readable `audit`/`lint` output); this dir holds the **inputs** (the
plugin snapshots) the tests load.

## The policy (why this dir exists)

We kept re-fetching OSS to dogfood and throwing the result away. Don't. The rule:

1. **Save what you dogfood, when the license allows.** Any plugin we scan that is
   **MIT/permissively licensed** gets a SHA-pinned slice here, so the finding is
   reproducible forever — not a one-off scan that vanishes when the session ends.
2. **SHA-pinned + never modified.** The directory name carries the upstream commit
   SHA (`name@sha`); the snapshot is frozen, so an upstream fix never changes our
   fixture and the verdict stays deterministic.
3. **Minimal slice, not a mirror.** Vendor only the structural files a check needs
   (frontmatter, manifests, hook scripts) — never an 800-file repo. For breadth we
   can't justify copying, record the scan in the **sweep manifest** below instead.
4. **No-LICENSE upstreams are NOT copied.** A plugin with no LICENSE
   (all-rights-reserved) is never committed here; its bug is still reported with
   repro steps in `research/oss-pr-drafts.md` and a fix can go upstream.

To add a slice: snapshot the minimal files into `test/dogfood/<name>@<sha>/`, add
a row to the right table below, and assert its verdict in `src/scan-vendor.test.ts`
(an FP-guard for a clean plugin, or a true-positive for a bug fixture).

## Conformance / loader slices (clean, well-formed)

| Slice (`dir@sha`)                | Upstream                                          | Purpose                                   |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `superpowers@6fd4507`            | github.com/obra/superpowers                       | loader invariants; the known dangling ref |
| `oh-my-claudecode@deee3a4`       | oh-my-claudecode                                  | loader + coverage rungs                   |
| `wshobson-accessibility@cf6059d` | github.com/wshobson/agents (accessibility plugin) | loader + coverage rungs                   |

These carry their own `*.COVERAGE.md`. They double as **FP-guards**: every
high-precision rule (including the five newest) must stay at **zero** on them, or
`scan-vendor.test.ts` fails (the don't-cry-wolf regression).

## Rule fixtures (real-bug true-positives + calibration guards)

Kept **because** they pin a detector against reality — either a real defect it
must keep catching (true-positive) or a real-but-benign shape it must NOT flag
(calibration FP-guard). Samples for testing, **not** an endorsement; frozen at
their SHA.

| Slice (`dir@sha`)             | Upstream                                                                                                         | License                                            | Reproduces (verified)                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `madappgang-frontend@6097ad4` | github.com/MadAppGang/claude-code (`plugins/frontend/agents/tester.md`)                                          | MIT — Copyright (c) 2024 MadAppGang - Jack Rudenko | **True-positive (×3):** `subagent-tool-contract` (`AskUserQuestion` never available to a subagent), `frontmatter-valid` (the one-line `description:` isn't valid YAML), **and** a hard `lethal-trifecta` (Read/Bash + WebFetch/WebSearch + Bash/WebFetch = read-private ∧ ingest-untrusted ∧ exfiltrate) |
| `claude-octopus@5a9cab8`      | github.com/nyldn/claude-octopus (`skills/flow-define/SKILL.md` + `.claude/skills/flow-define/SKILL.md`, both from the same commit)                        | MIT — Copyright (c) 2026 nyldn                     | **True-positive** for the **surface-scope shadowing** bug (2026-08-18). Upstream ships each skill TWICE — 61 under `skills/`, 57 under `.claude/skills/`, **50 names in both, and all 50 pairs differ**. vigiles read one discovery level and materialized it under the OTHER one's canonical key, so 71 files that exist on disk were never opened and the report named files it had not read. This slice is one such pair: the `skills/` copy is well-formed, the `.claude/skills/` copy has a multi-line unquoted `description:` that strict YAML rejects. Locks (a) both copies load as separate surfaces and (b) `frontmatter-valid` is attributed to the copy that is actually broken. Manifest deliberately NOT vendored — it lists 60+ skills the slice doesn't carry. |
| `davila7-perf-guard@869640b`  | github.com/davila7/claude-code-templates (`cli-tool/components/hooks/performance/performance-budget-guard.json`) | MIT — Copyright (c) 2025 Daniel (San) Ávila        | **Calibration FP-guard** for `hook-block-ineffective`. Its description says it "blocks deployments" but it's a `PostToolUse` hook that `exit 2`s — which on PostToolUse FEEDS stderr back to the model (a legitimate channel), not a failed block. Since block-vs-feedback intent isn't deterministically separable, the detector must **NOT** flag it (else it cries wolf on every nudge/lint hook, incl. vigiles's own `refs-nudge.sh`). Locks the don't-cry-wolf calibration. Vendored as `.claude/settings.json`. |
| `trailofbits-skills-curated@6d05be4` | github.com/trailofbits/skills-curated (whole marketplace — 29 plugins, minimal slice: every `SKILL.md`/`agents/*.md`/`plugin.json`/`LICENSE`) | CC BY-SA 4.0 (repo); some plugins MIT | **True-positive, breadth (×29, not a bug-fixture single):** every plugin flagged `lethal-trifecta` (advisory) and `untested surface` (advisory); 28 of 31 skills applicable to the trifecta check have `fence: "none"` — 0 use `disallowed-tools:` despite 38 real `allowed-tools:` declarations in the same repo. A real security company's own reviewed marketplace, own contribution guide telling authors to write `allowed-tools:`. Consumed by `site/scripts/gen-trailofbits-expected.mjs` for the landing page's `test`/`compile` beats — see `./trailofbits-skills-curated@6d05be4/SOURCE` for the full measurement. |

## Sweep manifest — broader scans (verdict saved even where files aren't)

The deterministic `vigiles audit` run across whole repos, recorded so the breadth
isn't lost when we don't copy every file. Re-runnable: **`bash tools/dogfood-sweep.sh`**
(fetches the pinned repo list, audits every plugin, tallies findings — refresh this
table from its output). ✓ = scanned clean on the new detectors; ✗ = a real finding
(slice vendored above or repro in `oss-pr-drafts.md`).

| Repo                                 | License    | Scanned                  | New-detector verdict                                          |
| ------------------------------------ | ---------- | ------------------------ | ------------------------------------------------------------- |
| `wshobson/agents`                    | MIT        | 85 plugins, 158 skills   | ✓ clean (FP-guard breadth)                                    |
| `MadAppGang/claude-code`             | MIT        | ~6 plugins, 131 skills   | ✓ clean on new detectors (older `tester` bug vendored)        |
| `davila7/claude-code-templates`      | MIT        | 872 skills, 59 hook cmps | ✓ clean on the new detectors (`performance-budget-guard` vendored as a calibration FP-guard — PostToolUse exit-2 is feedback, correctly not flagged) |
| `obra/superpowers`                   | (see repo) | 1 plugin                 | ✓ clean on new detectors                                      |
| `disler/claude-code-hooks-mastery`   | (see repo) | 1 plugin                 | ✓ clean                                                       |
| `disler/…-multi-agent-observability` | (see repo) | 2 plugins                | ✓ clean                                                       |
| `gmickel/flow-next`                  | (see repo) | 2 plugins                | ✓ clean                                                       |
| `anthropics/claude-code-action`      | MIT        | 1 plugin                 | ✓ clean                                                       |

Total this sweep: **156 audit targets across 8 repos** — one true positive
(davila7), zero false positives on the five new detectors. Earlier sessions also
scanned `trailofbits/react-pdf` + `skills-curated`, `ananddtyagi/cc-marketplace` +
`sugar`, and `TheBushidoCollective/han`; their findings hardened `scan.ts`
(multi-line quoted descriptions, relative `./hooks`, existence-guarded hooks,
marketplace dedup) and seeded `research/oss-pr-drafts.md`.
