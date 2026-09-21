# @vigiles/rule-enforcer

The opt-in **rule-enforcer** tier of vigiles. It turns a natural-language agent
rule (from a `CLAUDE.md` / `AGENTS.md`) into a self-tested lint rule, and — this
is the point — **refuses to ship a checker it can't prove sound.**

This package is loaded **only** by vigiles's opt-in power tier (behind an
explicit consent, alongside the live-MCP and skill-firing executing checks). The
default `vigiles audit` / `lint` surface stays deterministic and model-free; the
package boundary is what keeps that promise. The deterministic half — mapping a
prose rule to an _existing_ off-the-shelf lint rule and reporting whether it's
enforced — already ships in `vigiles audit` as the **rule inventory**
(`src/rule-inventory.ts`). This tier does the part that inventory can't: the
model-based **synthesis** of a rule for the residue, gated.

> Folded in 2026-07-14 from the former standalone `zernie/agent-rules-compiler`
> repo (now archived with a pointer here), to stop two repositories carrying one
> engine.

## The pipeline

```
prose rule (CLAUDE.md)
  → classify: mechanizable vs semantic
  → [mechanizable] REUSE: map to an existing off-the-shelf rule if one exists
                          (catalog/rule-map.json — the plugin index)
  → [no existing rule] SYNTHESIZE a checker + an INDEPENDENT self-test
        · JS/TS → an ESLint rule module (generated/<slug>.js)
        · Python → an ast-grep rule OBJECT (generated/<slug>.json — data, not code)
  → TRUST GATE (two-stage, blind gold-set):
        rule must pass its self-test AND a blind gold set it never saw
        pass → kept (safe to enforce)   fail → abstain (no false confidence)
  → [semantic] not mechanizable — handed back as labeled prose
  → kept rules run against the real code (actual enforcement)
```

The gate is the trust anchor: a synthesized checker that matches a rule's
_surface_ but not its _intent_ (the measured "vibe-linting" failure — most
LLM-synthesized checkers silently leak) is caught by the blind gold set and sent
to `abstain` instead of shipping a green check nobody should trust.

## Engines: one gate, two languages

The verdict logic is language-agnostic; the two per-engine primitives (self-test
+ gold execution) live behind an injected executor in `executors/<engine>.js`. A
corpus entry names its `engine` (absent ⇒ `eslint`), so adding a language is a new
executor object, never a forked gate.

- **`eslint`** — JS/TS. The synthesized artifact is an ESLint rule _module_
  (`create(context)`), self-tested with `RuleTester`, executed with `Linter`.
- **`astgrep-py`** — Python. The synthesized artifact is an ast-grep rule
  _object_ (`generated/<slug>.json`, the same shape as ast-grep YAML), executed
  in-process via `@ast-grep/napi` + `@ast-grep/lang-python`. Because the artifact
  is **data, not code**, its trust surface is strictly smaller than a synthesized
  JS function — nothing is imported or executed except the fixed ast-grep matcher.

We deliberately do **not** synthesize a pylint/astroid checker: that means a
Python subprocess, a second test harness, and a synthesized _code_ artifact,
where ast-grep gives a declarative _data_ artifact in-process. (`prefer-existing-solutions`:
the root already adopts ast-grep in `src/core/symbols.ts`.) This lane is
synthesis-only — mapping Python prose to an _existing_ Ruff/Pylint rule is the
root cross-referencing engine's job (`src/core/linters.ts`), not duplicated here.

**Two-stage integrity is provenance, not engine.** Stage 1 cases are authored
_with_ the checker (shared blind spots); Stage 2 gold is authored blind against
the prose, seeded with the failure taxonomy. A `provenanceViolations` guard in the
gate fails loudly if any gold case is reused verbatim in a self-test, so the
independence Stage 2 depends on can't silently erode (engine-agnostic — it hardens
the ESLint lane too). The Python lane's payoff case is **P2 `py-no-print`**: a
naive `print($A)` passes its single-arg self-test but misses `print()` and
`print(a, b)` on the gold → `abstain-gold` (a _recall_ leak, complementing R10's
_precision_ leak on the ESLint side).

## Layout

- `catalog/rule-map.json` — the **plugin index**: prose-intent → existing
  off-the-shelf rule across ESLint core + popular plugins (the REUSE tier).
- `rules/corpus.json` — the real prose-rule corpus (provenance-tagged).
- `gold/` — the blind gold sets + a second rater's labels (inter-rater
  reliability). `gold/SOUNDNESS.md` documents the methodology.
- `gate.js` — the two-stage trust gate (`npm run gate`), engine-dispatched.
- `executors/` — the per-engine self-test + gold-execution primitives
  (`eslint.js`, `astgrep-py.js`); the gate injects one per corpus entry.
- `run-demo.js` — end-to-end demo over `demo-project/` (`npm run demo`, ESLint lane).
- `generated/`, `selftest/`, `synth-agent/` — synthesized rule artifacts + self-tests
  (ESLint rule modules `*.js`; ast-grep Python rule objects `*.json`; exact bytes).
- `measure*.js`, `soundness*.js` — the leak measurement + soundness harness.

## Running

```bash
cd compiler
npm install
npm run gate    # runs the trust gate over the corpus
npm run demo    # end-to-end: compile → gate → enforce on demo-project/
```

## Paper artifact

The two-stage adversarial gold-set gate + its measurement (most synthesized
checkers silently leak; the gate catches it) is the artifact for the companion
paper "Prose Isn't Policy". The reproducible bundle is a zip of this
subdirectory — no separate repo required.
