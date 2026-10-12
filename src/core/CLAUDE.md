<!-- vigiles:sha256:aa5bdcf472969919 compiled from src/core/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Scope

Working in `src/core/`? This is the harness-AGNOSTIC domain (spec, compile, linters, the lint/audit detectors). The root `CLAUDE.md` holds the full positioning + rule set — read it first. Two invariants live closest to this code: the core must not import an adapter (`core ⊄ adapter`, eslint-enforced) and must not hard-code a Claude Code literal (read it from the injected layout/dialect). This file adds the rule for ADDING or CHANGING a detector.

## Rules

### Detector Meta

**Guidance only** — A deterministic DETECTOR here is one half of a RULE — and a rule is not done until it is DECLARED. Three things move together (sibling of one-detector-no-drift + rules-docs-in-sync): (1) the pure detector function (shared by `lint` AND `audit`, never reimplemented per surface; read the layout/dialect, never a CC literal); (2) its entry in `src/core/rule-meta.ts` — the `Record<RuleName, RuleMeta>` won't typecheck without it — declaring its DECIDABILITY BUCKET (structural-closed = a type could prevent it / external-decidable = needs the world, error-capable / heuristic-behavioral = warn-or-measure-only), surface, defaultSeverity, the detector name, and any upstreamPrevention; (3) its `docs/rules/<name>.md` (the coverage test binds the registry to the docs by an EXACT set match, so a missing meta or doc fails CI). The bucket is the CEILING, not a preference — a heuristic proxy may NEVER default to `error` (it cries wolf); a structural/external fact MAY, once proven FP-safe. Before writing a new detector, CLASSIFY the defect into a bucket — that decides whether it can ever gate. The full model + the prose behind the buckets is the root `lint-rule-calibration` rule and `research/enforcement-model.md`.
