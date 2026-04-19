# Formal Proofs for AI Agents

Scope: should vigiles reach past its current deterministic proofs (monotonicity,
NCD, Merkle, fixed-point, property tests in `src/proofs.ts`) into real formal
verification, and if so, how?

Bottom line up front: yes, but narrowly. Dafny is the only system where
"LLM writes code + spec + proof" is remotely credible today, and even then only
for small functions. Ship a `dafny()` enforce target first. Treat full
evolution-engine proof gating as a research preview, not a product.

---

## 1. Landscape

**Lean 4.** Dependent-type proof assistant, successor to Lean 3. Primary use is
formalized mathematics (mathlib has ~1.8M lines of formalized math) and
verification research. Production software use is negligible. Most
LLM-theorem-proving papers target Lean because miniF2F and putnamBench are Lean
benchmarks and mathlib is huge, clean training data. LLM-friendliness: highest
of any system by volume of tooling, but proofs are long, tactic-heavy, and
brittle.

**Coq / Rocq** (renamed 2024). The grand-daddy: CompCert (verified C compiler,
AbsInt ships it to Airbus), seL4 microkernel proofs, Iris separation logic.
Real production use, real Fortune-500 deployment via CompCert. LLM tooling
(Proverbot9001, CoqGym, Copra) is older and slower-moving than Lean's; the
pivot to the Rocq name also fractured the ecosystem briefly.

**Dafny.** Imperative/OO language with pre/postconditions and a built-in SMT
backend (Z3). Written by Rustan Leino at MSR, now at AWS. Used in production at
AWS: the ESDK (Encryption SDK), the Authenticated Encryption library, parts of
S3's ShardStore, and Dafny-to-Rust compilation for cryptographic components.
Dafny is the pragmatic choice: proof burden is 3-20 lines per function, not
hundreds. LLM-friendliness is very good; Microsoft's own "Laurel" and "Clover"
work specifically targets Dafny proof synthesis with LLMs.

**F\*.** Dependent types + SMT, developed at MSR and Inria. Powers Project
Everest: HACL\*, EverCrypt, Vale — these ship inside Firefox's NSS, the Linux
kernel crypto path, WireGuard, mbedTLS, and ZincCrypto. Real production use,
but learning curve is brutal. LLM tooling is thin; almost no papers target F\*
specifically.

**TLA+.** Leslie Lamport's specification language for concurrent and
distributed systems. AWS uses it heavily — DynamoDB, S3, EBS designs were
verified in TLA+ and Amazon has published about it. It does not verify code;
it verifies designs and finds protocol bugs via model checking (TLC) or proof
(TLAPS). LLM-friendliness is moderate — there are TLA+ generation papers but
it's a small community.

**Liquid Haskell.** Refinement types bolted onto GHC via SMT. Academic
darling, small industrial footprint (Galois, Awake Security historically).
Lightweight annotations, but depends on Haskell. LLM tooling: near zero.

**Verus.** Verification for Rust, developed at MSR/CMU. Pre/postconditions,
SMT-backed, targeting systems code. Still young (first stable release 2023)
but Microsoft has a concerted push, including a verified storage engine
(StorageNode in Verus) and verified parts of Hyper-V. LLM-friendliness: a few
2024-25 papers (AutoVerus, SAFE from UCSD) exist, results are preliminary.

**Kani.** Model checker for Rust from AWS, based on CBMC. Bounded verification,
not full proof — you prove properties hold for all inputs up to bound N. Very
practical and low-friction, and AWS uses it on Firecracker, s2n-quic, and
aws-nitro-enclaves. LLM-friendliness: no dedicated tooling but the assertion
style is easy to generate.

---

## 2. LLM-Assisted Theorem Proving: 2024-2026 State of the Art

The field has moved fast on olympiad-style math and almost not at all on
software verification. Honest pass rates below.

**LeanDojo (2023, updated 2024).** CMU infrastructure paper: extracted mathlib
as (state, tactic) pairs, released ReProver retrieval-augmented model. Baseline
of ~51% on miniF2F-test for small open models. Still the standard harness
everyone builds on.

**Lean Copilot (2024).** Song et al., runs local LLMs as Lean tactics
(`suggest_tactics`, `search_proof`). It's a human-in-the-loop authoring tool,
not an autonomous prover. Useful, not transformative.

**DeepSeek-Prover V1.5 (2024), V2 (2025).** Expert iteration over generated
proofs. V1.5 reached ~63% miniF2F-test, V2 pushed to ~88% with RL and
subgoal decomposition. State of the art for open models on olympiad math.

**Goedel-Prover (2025, Princeton).** Trained on ~1.6M auto-formalized
statements. ~64% miniF2F pass@32, ~7% on putnamBench pass@512. putnamBench is
brutally hard — even the best closed models are in the single digits to low
teens.

**AlphaProof (DeepMind, July 2024).** Silver-medal IMO 2024 performance (4/6
problems), Lean-based. Not released. Demonstrated that RL + massive compute
on Lean can reach elite human level on contest math. Zero transfer demonstrated
to real software.

**Baldur (Meta/Google 2023, cited through 2025).** Whole-proof generation for
Isabelle. ~41% on PISA benchmark with repair loop. Interesting because it
generates whole proofs rather than tactic-by-tactic — similar ergonomics to
how you'd want an agent to work.

**Copra (2024).** GPT-4-based in-context proof agent for Lean and Coq. Uses
error messages and retrieval. ~30% on miniF2F with GPT-4. Honest and modest.

**The benchmark gap.** miniF2F and putnamBench are olympiad math. For actual
software verification the closest thing is DafnyBench (Poesia et al., 2024),
~750 Dafny problems drawn from textbooks and real code. GPT-4 solves ~68%.
There is no equivalent large-scale Lean-for-software or Verus benchmark. This
matters: 88% on miniF2F tells you nothing about whether an LLM can verify your
sort function.

**Summary.** On olympiad math, top systems are at 60-88% and the curve is
steep. On real software verification, we have one benchmark (DafnyBench), one
system that clearly works (GPT-4 + Dafny), and lots of arXiv preprints with
<50% pass rates. Anyone claiming "LLMs write verified software" in 2026 is
selling a demo.

---

## 3. Dafny vs Lean 4 for Wiring to Claude

This is the core decision. Both can be driven by an LLM agent. They are not
equivalent.

| Dimension                 | Dafny                                     | Lean 4                               |
| ------------------------- | ----------------------------------------- | ------------------------------------ |
| Target user               | Programmers                               | Mathematicians, PL researchers       |
| Proof style               | Declarative pre/post + SMT auto-discharge | Interactive tactic proofs            |
| Typical burden            | 3-20 lines per function                   | 50-500 lines per theorem             |
| What you verify           | Imperative/OO code                        | Arbitrary propositions               |
| Backend                   | Z3 (automatic)                            | Kernel (manual)                      |
| Tooling maturity for code | Production (AWS)                          | Research                             |
| LLM pass rate in-domain   | ~68% (DafnyBench, GPT-4)                  | ~30-88% (miniF2F, math only)         |
| Production users          | AWS (ESDK, S3 ShardStore)                 | None at code level; mathlib for math |
| Error messages            | SMT counterexamples, often cryptic        | Type errors, very precise            |
| Install footprint         | ~50 MB, single binary                     | ~500 MB, elan toolchain              |

**The honest comparison.** Dafny is for verifying that a function satisfies a
spec. Lean 4 is for proving theorems. If you want to say "this sort function
returns a permutation that is sorted," Dafny does it in 5 lines. Lean 4 does it
in 80 lines plus lemmas. If you want to say "this elliptic curve satisfies the
Hasse bound," only Lean 4 can do that, and an LLM will not succeed unassisted.

**For vigiles' audience** — programmers who write `.spec.ts` to guide coding
agents — Dafny wins on every axis except theoretical expressiveness. The
audience overlap between vigiles users and people who can read a Lean proof is
near zero. The overlap between vigiles users and people who would accept a
Dafny precondition is much larger, because Dafny looks like code.

**LLM tooling.** Dafny's LLM story (Laurel, Clover, DafnyBench, plus Copilot
working decently on small Dafny files) is behind Lean's in raw research volume
but ahead in software-verification credibility. Lean's ecosystem is optimized
for formalizing existing math, not synthesizing new code-level specs.

**Recommendation: Dafny first, Lean as an experimental target later.**

---

## 4. Integration Patterns: Wiring a Prover to Claude

Four options, brief pros and cons. These are not exclusive.

### 4.1 Subagent calls prover via CLI

Claude dispatches a subagent with the prompt "run `dafny verify foo.dfy` and
fix errors until green." Subagent iterates until pass or budget exhausted.

Pros: zero infrastructure, uses existing Task tool, fits Claude Code today.
Cons: no caching, no shared proof state, subagent re-reads the whole file every
loop, burns tokens fast on complex proofs.

### 4.2 MCP server for Dafny/Lean

Stand up an MCP server exposing `verify`, `suggest_tactic`, `get_goal_state`,
`check_proof`. Claude calls these as tools.

Pros: structured, stateful, interactive proofs become tractable, sharable
across agents. Cons: building a good MCP server for an interactive prover is
real work — Lean-Dojo took a team, and Dafny's LSP is less interactive. This
is the right long-term answer and the expensive one.

### 4.3 PostToolUse hook running prover on changed files

Edit a `.dfy` file, hook fires `dafny verify`, output goes back into Claude's
context on failure.

Pros: mechanical, always on, cannot be skipped, fits vigiles' existing
"enforce this externally" philosophy. Cons: feedback is one-shot per edit, not
a conversation; large files re-verify from scratch.

### 4.4 `vigiles verify` CLI command on spec-annotated blocks

New CLI verb that scans the spec for `verify()` rules, extracts the referenced
proof obligations, runs the chosen prover, and produces an audit report. Same
shape as `vigiles check`.

Pros: matches vigiles' current audit-at-commit-time model; deterministic; easy
to integrate with CI; does not require Claude at all. Cons: not interactive —
if verification fails, the user/agent has to loop manually.

**Recommendation: start with 4.3 + 4.4.** Both are mechanical, both fit
vigiles' existing architecture, neither requires Lean-Dojo-grade engineering.
4.2 (MCP server) is the right v2 if users actually engage. 4.1 (subagent) is
already possible without any vigiles change.

---

## 5. What Vigiles Should Ship First

Three proposals, ordered by ambition. Ship the low one, prototype the medium,
do not build the high one yet.

### 5.1 Low: `dafny()` enforce target

```ts
enforce("dafny:ESDK/encrypt.dfy#EncryptIsInverseOfDecrypt");
```

Semantics: at `vigiles check` time, parse the reference, locate the `.dfy`
file, run `dafny verify` on it, confirm the named lemma/method exists and
verifies. Fits the existing stale-reference pattern in `src/linters.ts` — if
the lemma is renamed or deleted, check fails.

Effort: 1-2 weeks. Requires Dafny installed; follows the same model as the
existing pylint/clippy/rubocop checks. This is a natural extension of
vigiles' linter cross-referencing moat into the proof world.

Production-grade: yes, for projects that already use Dafny. Demo-grade for
anyone else. That's fine — vigiles never forced anyone to adopt pylint either.

### 5.2 Medium: `verify()` rule builder that emits a proof obligation file

```ts
verify({
  name: "MonotonicityProof",
  target: "src/proofs.ts#monotonicityLattice",
  obligations: [
    "forall s1 s2 :: merge(s1, s2) >= s1",
    "forall s1 s2 :: merge(s1, s2) >= s2",
    "forall s1 s2 :: merge(s1, s2) == merge(s2, s1)",
  ],
  backend: "dafny", // or "lean4"
});
```

Semantics: compiling the spec emits a `.dfy` skeleton with the obligations as
method postconditions. Running `vigiles verify` tries to discharge them — with
Dafny, often automatically; with Lean 4, the user (or an agent) fills in the
proof. Either way vigiles records pass/fail alongside its existing proof
record.

Effort: 4-8 weeks. The hard part is the TS-to-Dafny type bridge. Stay very
narrow — support int, bool, string, sequences, sets, and let users opt in per
function. Do not try to verify arbitrary TypeScript.

Production-grade: demo-grade initially. Becomes production-grade only for the
subset of code users are willing to hand-translate or re-write in Dafny. Pitch
it honestly: "for the 5% of your code that must be correct."

### 5.3 High: Proof-gated evolution engine

Today `src/evolve.ts` lets an LLM propose mutations to the spec, runs property
tests, and commits passing mutations to a Merkle history. The ambitious version
would require every mutation to also ship a proof obligation discharge —
"the new rule implies the old rule, verified by Dafny" — before the Merkle
commit is accepted.

Effort: 3-6 months minimum, mostly research. The fundamental problem is that
rule semantics are natural-language prose filtered through `enforce`, `check`,
and `guidance`. There is no formal meaning of "the new rule implies the old
rule" until someone defines one. You would need a specification logic for
instruction files. That is a PhD project, not a sprint.

Production-grade: no. Demo-grade at best, for a long time. Do not promise it.
It is worth keeping as a research direction because it would be a genuine
first — "the first self-evolving agent spec system with formally verified
mutations" — but the honest engineering answer is "we are not there yet."

---

## Closing Honesty Check

- LLMs solve 60-88% of olympiad-math problems in Lean. This does not transfer
  to arbitrary software verification.
- The one benchmark we have for code-level proof synthesis (DafnyBench) sits at
  ~68% for the best closed models. That means for every three verified
  functions, one is wrong.
- No production system today lets an LLM "write code + spec + proof" for
  general-purpose software. AWS's Dafny deployments are human-written with
  machine-checked proofs. That is a different workflow than what an agent
  would do.
- Vigiles' existing deterministic proofs (monotonicity lattice, NCD, Merkle,
  fixed-point, property tests) are already unusually rigorous for this product
  category. Adding a Dafny enforce target is a cheap, honest extension.
  Anything beyond that is marketing ahead of capability.

Recommendation: ship 5.1. Prototype 5.2 behind a flag. Write a blog post about
5.3 but do not build it.

---

## 6. Revised Assessment: Lean 4 Is Now Viable (April 2026)

The original recommendation was "Dafny first, Lean later." Three developments shift this:

### 6.1. Leanstral (Mistral, March 2026)

Mistral released Leanstral — the first open-source LLM agent built specifically for Lean 4. Key facts:

- Sparse MoE: 119B total parameters, 6.5B active per token (18x efficiency ratio)
- Interacts with the Lean 4 compiler via MCP — not guessing proofs, building them in dialogue with the verifier
- Apache 2.0 license, free API endpoint
- Generates both code AND machine-checkable proofs simultaneously

This directly addresses the "LLM-friendliness" gap that made Lean impractical. The existing doc says "the audience overlap between vigiles users and people who can read a Lean proof is near zero." Leanstral means the USER doesn't read the proof — the agent writes it, the Lean kernel checks it, vigiles records the receipt. The user sees "verified" or "not verified."

### 6.2. Cedar / AWS — Lean 4 for real software (not math)

AWS uses Lean 4 to verify Cedar, their authorization policy language. This is production software verification, not olympiad math. Their "verification-guided development" pattern:

1. Write a formal model of the system in Lean (~10x smaller than production code)
2. Prove key properties about the model (e.g., "forbid trumps permit," "default deny")
3. Differential random testing between the Lean model and the Rust production code
4. Result: found and fixed 25 bugs (4 via proofs, 21 via differential testing)

The Lean models run at 5 microseconds per test case. The most complex proof (validator soundness) was 4,686 lines and took 18 person-days. This is real engineering, not research.

**The Cedar pattern maps directly to vigiles:**

| Cedar                                     | vigiles                                         |
| ----------------------------------------- | ----------------------------------------------- |
| Policy language (Cedar)                   | Spec language (.spec.ts)                        |
| Authorization engine (Rust)               | Compiler (TypeScript)                           |
| Formal model (Lean)                       | Formal model of compileClaude() (Lean)          |
| Key properties ("forbid trumps permit")   | Key properties ("enforce() appears in output")  |
| Differential testing (Lean model vs Rust) | Differential testing (Lean model vs TypeScript) |

### 6.3. Cryspen / Hax — Lean 4 for cryptographic Rust verification

Cryspen's Hax toolchain transpiles annotated Rust to Lean, then verifies the Lean code. Used for SHA-3 and ML-KEM (post-quantum crypto). This demonstrates Lean 4 being used for systems-level software verification outside of pure math.

### 6.4. Revised Lean vs Dafny comparison

| Dimension                 | Dafny (2025 assessment)   | Lean 4 (April 2026 assessment)                      |
| ------------------------- | ------------------------- | --------------------------------------------------- |
| Production users for code | AWS (ESDK, S3)            | AWS (Cedar), Cryspen (crypto)                       |
| LLM agent support         | Copilot, Clover (MSR)     | **Leanstral (Mistral)** — purpose-built             |
| Integration mechanism     | CLI (dafny verify)        | **MCP server** (Leanstral uses it natively)         |
| Model size for vigiles    | ~200 lines Dafny          | ~200 lines Lean                                     |
| Proof style               | SMT auto-discharge        | Tactic proofs, but Leanstral writes them            |
| Community momentum        | Stable                    | **Growing fast** — mathlib, Cedar, Leanstral        |
| Cost to integrate         | Shell out to dafny binary | Shell out to lean binary, OR call Leanstral via MCP |

**Updated recommendation: Lean 4 first, Dafny as alternative.** The MCP-native integration (Leanstral talks to Lean via MCP, Claude Code talks to MCP tools) is a natural fit. Dafny remains viable for teams already using it.

---

## 7. The Cedar Pattern Applied to vigiles

The most practical path. Not verifying agent behavior (impossible). Verifying the compiler.

### 7.1. What to verify

vigiles's compiler transforms a spec into markdown. These properties should hold for ALL valid specs:

**Structural correctness:**

- Every `enforce()` rule in the spec appears as a `### Title` + `**Enforced by:**` block in the output
- Every `guidance()` rule appears as a `### Title` + `**Guidance only**` block
- Every `file()` path in `keyFiles` appears as a `` `path` `` in the Key Files section
- Every `cmd()` in `commands` appears as a `` `command` `` in the Commands section
- No rule in the spec is silently dropped from the output

**Hash integrity:**

- `computeHash(body) == embedded hash` after compilation
- Modifying any byte of the body changes the hash
- `verifyHash` returns true iff the hash matches

**Input fingerprinting:**

- `computeInputHash(files, basePath)` is deterministic: same files → same hash
- Changing any input file changes the hash
- Deleting a file changes the hash (MISSING sentinel)
- `computePerFileHashes` is consistent with `computeInputHash`

**Monotonicity (from proofs.ts):**

- `merge(s1, s2) >= s1` and `merge(s1, s2) >= s2` (adding rules never removes rules)
- `merge(s1, s2) == merge(s2, s1)` (commutativity)

**Sidecar manifest:**

- `diffSidecarManifest` reports `fresh: true` iff no file hashes changed
- `affectedSpecs` returns a superset of the actually-affected specs (no false negatives)

### 7.2. How to verify (Cedar-style)

1. **Lean model** (~200 lines): define `Spec`, `Rule`, `CompiledOutput` as Lean structures. Define `compile : Spec → CompiledOutput` as a pure function. Prove the properties above as theorems.

2. **Differential testing**: generate random specs (fast-check style), run them through both the Lean model and the TypeScript compiler, assert outputs match. This catches implementation bugs without writing Lean proofs for every edge case.

3. **Leanstral for proof authoring**: use Leanstral (via MCP or API) to draft the Lean proofs. Human reviews. This is the "agent writes proofs, kernel checks them, human audits" workflow.

### 7.3. What NOT to verify

- That the spec "correctly describes the project" — not formalizable (natural language semantics)
- That the agent follows the spec — not verifiable (agent behavior is non-deterministic)
- That linter rules are semantically correct — vigiles checks they exist and are enabled, not what they do
- That prose in `sections{}` is accurate — natural language, outside formal methods

### 7.4. Effort estimate

| Phase                        | Work                                                           | Effort        |
| ---------------------------- | -------------------------------------------------------------- | ------------- |
| Lean model of hash functions | Define `computeHash`, prove determinism + collision properties | 2-3 days      |
| Lean model of compile        | Define spec → output, prove structural properties              | 1-2 weeks     |
| Differential testing harness | Generate random specs, compare Lean vs TS                      | 3-5 days      |
| Monotonicity proofs          | Formalize the lattice from proofs.ts                           | 1 week        |
| Sidecar manifest proofs      | Prove consistency of diff/affected-specs                       | 3-5 days      |
| **Total**                    |                                                                | **4-6 weeks** |

With Leanstral assisting proof authoring, the proof-writing portion could be 2-3x faster. But human review is still required — machine-generated proofs are correct (the kernel checks them) but may be hard to read and maintain.

### 7.5. The property-test → Lean bridge

vigiles already has property tests in `proofs.ts` that test the right invariants via random sampling. The bridge to Lean:

```
Property test (proofs.ts)          →    Lean theorem
────────────────────────────       ────────────────
property("monotonic",              theorem mono :
  (s1, s2) =>                        ∀ s1 s2 : Spec,
    merge(s1, s2).rules.size >=        (compile (merge s1 s2)).rules.length ≥
    s1.rules.size                      (compile s1).rules.length
)
```

The left side samples 1000 random inputs and checks. The right side proves for ALL inputs. The invariant is the same — the formalization language is different.

For vigiles, this is the highest-value path: take the 6 existing property tests, formalize them in Lean, and ship the proofs alongside the property tests. The property tests remain the fast CI check. The Lean proofs are the "this was proven correct, not just tested" badge.

---

## 8. Integration: `lean()` enforce target

Like the proposed `dafny()` target, but for Lean 4:

```typescript
enforce("lean4:src/proofs.lean#monotonicity_theorem");
```

Semantics at `vigiles compile` time:

1. Parse the reference: file `src/proofs.lean`, theorem name `monotonicity_theorem`
2. Run `lean --run src/proofs.lean` (or `lake build`)
3. Confirm the theorem exists and type-checks (Lean's kernel verifies the proof)
4. If verification fails, emit a compile error

This extends vigiles's linter cross-referencing moat into formal proofs. The same pattern as `enforce("eslint/no-console")` — vigiles doesn't understand the proof, it just verifies it passes.

With Leanstral, the workflow becomes:

1. Developer writes a property test in proofs.ts
2. Agent (Leanstral) formalizes it as a Lean theorem + proof
3. Lean kernel verifies the proof
4. Developer adds `enforce("lean4:proofs.lean#theorem_name")` to the spec
5. vigiles verifies the proof at compile time, forever

---

## Additional Ideas (post-session)

### 5.4. Dafny-in-comments — inline formal specs

Mirror the inline enforce pattern but for formal contracts:
`<!-- vigiles:verify dafny "ensures result > 0" -->` next to a function.
vigiles extracts the contract, wraps the referenced function in a `.dfy`
file with the contract as a postcondition, runs `dafny verify`. The
developer writes zero Dafny — they write a one-line natural-language
contract in a markdown comment, and the tool does the wiring. If the
proof fails, the error goes back to the agent as a diagnostic. Same
adoption shape as inline enforce: one comment, zero new files, zero build
step. The agent can even generate the contract from the function's
docstring.

### 5.5. Property-test → Dafny bridge

fast-check properties in the spec (from `propertyTest()` in proofs.ts)
are already "lightweight formal methods" — they test an invariant over
random inputs. Bridge to Dafny: when a property covers a pure function,
offer to generate a Dafny contract from the property's invariant. The
property test IS the spec; Dafny just machine-checks it exhaustively
instead of sampling. The bridge is mechanical: `property("positive",
(n) => f(n) > 0)` → `ensures f(n) > 0`. The hard part is translating
the function body to Dafny, which is where the LLM earns its keep.

### 5.6. Proof receipts in the Merkle chain

When a Dafny/Lean verification passes during evolution, include the
proof receipt in the Merkle history node alongside the existing
monotonicity/NCD/bloom receipts. The chain becomes a certificate of
correctness: "this spec change was not just fitness-positive and
monotonically valid, it was FORMALLY VERIFIED by Z3/Lean kernel."
Consumers can distinguish "verified by deterministic proofs" from
"verified by formal prover" at the receipt level. The `verify()`
method already checks receipt hashes, so formal receipts get
tamper-evidence for free.
