# Self-Evolving Specification System

Design document for vigiles's self-evolving spec system. Specs mutate, proofs verify, only valid mutations survive. The system improves itself deterministically — AI proposes changes, algorithms prove correctness.

---

## Core Insight

vigiles already proves things at compile time: file references exist, linter rules are enabled, commands are in package.json. But these are **static assertions about the world**. The next frontier is **dynamic assertions about the spec itself** — proofs that the specification system is evolving correctly over time.

The key principle: **LLM proposes, deterministic algorithm disposes.** AI agents suggest spec mutations (new rules, strengthened enforcement, merged sections). A suite of proof algorithms verifies each mutation before it's accepted. No mutation enters the spec without passing every proof.

---

## Architecture

```
                    ┌─────────────┐
                    │  AI Agent    │
                    │  (proposer)  │
                    └──────┬──────┘
                           │ proposes mutation
                           ▼
                    ┌─────────────┐
                    │  Evolution   │
                    │  Engine      │
                    └──────┬──────┘
                           │ applies mutation to spec
                           ▼
              ┌────────────────────────┐
              │     Proof Suite        │
              │                        │
              │  ┌──────────────────┐  │
              │  │ Monotonicity     │  │  ← rules only strengthen;
              │  │ Lattice          │  │    removals require allowlist
              │  ├──────────────────┤  │
              │  │ NCD Similarity   │  │  ← no NEW duplicate pairs
              │  │ Distance         │  │    (pre-existing dups ignored)
              │  ├──────────────────┤  │
              │  │ Fixed-Point      │  │  ← compilation converges
              │  │ Convergence      │  │
              │  ├──────────────────┤  │
              │  │ Bloom Filter     │  │  ← token overlap vs surviving
              │  │ Index            │  │    rules only (excludes removed)
              │  ├──────────────────┤  │
              │  │ Property-Based   │  │  ← invariants hold under
              │  │ Testing          │  │    random mutations
              │  └──────────────────┘  │
              └────────────┬───────────┘
                           │ all proofs pass?
                           ▼
                    ┌─────────────┐
                    │ Merkle DAG  │  ← append to tamper-evident history
                    │ History     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Accept      │  → new spec version
                    └─────────────┘
```

---

## Proof Algorithms

### 1. Monotonicity Lattice (Rule Strength Ordering)

Rules form a lattice ordered by enforcement strength:

```
    enforce (1)      ← strongest: backed by external linter
        │
    guidance (0)     ← weakest: prose only
```

**Monotonicity proof**: Given spec version N and proposed version N+1, for every rule that exists in both versions, its strength in N+1 must be ≥ its strength in N. Weakening requires an explicit `allowWeaken` flag. **Removing** a rule is also a violation unless the rule ID is in `allowWeaken` — otherwise a bare `remove` mutation could pass on neutral fitness and silently delete constraints.

This is a **partial order** — rules can be added freely, but existing rules can only move UP the lattice (guidance → enforce). Catches the silent regression where someone downgrades an enforced rule or deletes it entirely.

The lattice extends to coverage: the set of enforced rule IDs in N+1 must be a superset of N's enforced IDs (minus any explicit allowlist).

**Algorithm**: O(n) comparison of rule maps. For each rule ID present in both versions, compare ordinal values.

### 2. Normalized Compression Distance (Rule Deduplication)

NCD is an information-theoretic metric that approximates Kolmogorov complexity:

```
NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))
```

Where C() is the compressed size (using zlib/gzip). Range: [0, 1+ε] where 0 = identical information content, 1 = maximally different.

**Use case**: Detect semantically similar rules that should be merged. Two rules about "no console.log" and "use structured logger instead of console" have low NCD because they share information content — even though they use different words.

**Why NCD over cosine similarity or embeddings?**

- Deterministic — same input always produces same output
- No model dependency — works offline, no API calls
- Language-agnostic — works on any string content
- Theoretically grounded — approximates the universal similarity metric (Li et al. 2004)

**Threshold**: NCD < 0.3 suggests near-duplication. NCD < 0.5 suggests related content worth reviewing.

### 3. Fixed-Point Convergence

Specs can trigger recompilation (e.g., a rule that references a generated file). The compilation must converge — running the compiler repeatedly must reach a fixed point where the output stops changing.

**Algorithm**: Iterate compilation up to N times (default 10). At each step, hash the output. If hash[i] === hash[i-1], fixed point reached. If after N iterations no fixed point, the spec is **divergent** — report the cycle.

**Formal basis**: This is the discrete analog of Banach's fixed-point theorem. The compiler is a contraction mapping on the space of markdown documents (most compilations reduce or preserve information). Convergence is guaranteed when the compiler is contractive.

**Practical check**: Most specs converge in 1 iteration (compilation is idempotent). Specs that reference their own output (self-referential) may take 2-3 iterations. Specs that never converge have a bug.

### 4. Bloom Filter Index

A space-efficient probabilistic data structure for approximate set membership.

**Use case**: Fast pre-filtering for rule similarity. Before computing expensive NCD comparisons (O(n²) for n rules), use a Bloom filter to quickly identify candidate pairs that share tokens.

**Parameters**:

- m = bit array size (calculated from desired false positive rate)
- k = number of hash functions (optimal: k = (m/n) × ln2)
- FPR ≈ (1 - e^(-kn/m))^k

For 1000 rules with 1% false positive rate: m ≈ 9,586 bits (~1.2 KB), k = 7.

**Hash functions**: FNV-1a with k different seeds. Fast, good distribution, no crypto overhead.

### 5. Merkle DAG History

Every spec version is a node in a content-addressed DAG:

```typescript
interface HistoryNode {
  hash: string; // SHA-256 of this node's content
  parentHash: string; // hash of previous version (or "genesis")
  specHash: string; // hash of the compiled spec
  mutation: Mutation; // what changed
  proofs: ProofResult[]; // which proofs were run and passed
  timestamp: number;
}
```

**Properties**:

- **Tamper-evident**: Changing any node invalidates all descendant hashes
- **Append-only**: New versions append to the DAG, never modify history
- **Verifiable**: Anyone can recompute the hash chain and verify integrity
- **Branchable**: Fork the DAG for parallel spec evolution (e.g., different teams)

**Verification**: Walk the chain from any node to genesis, recomputing hashes. If any hash mismatches, the history was tampered with.

### 6. Property-Based Testing

Generate random valid mutations and verify that invariants hold across all of them.

**Invariants**:

- **Idempotency**: Compiling a spec twice produces identical output (hash equality)
- **Monotonic coverage**: Adding a rule never decreases coverage percentage
- **Hash stability**: The hash of unchanged content is stable across compilations
- **Serialization roundtrip**: spec → JSON → spec produces equivalent result

**Mutation generators**:

- Add random guidance/enforce rule
- Strengthen random `guidance → enforce`
- Remove random rule
- Reorder rules
- Modify rule text

**Shrinking**: When an invariant fails, binary-search the mutation sequence to find the minimal failing case. Start with N mutations, try N/2, etc.

---

## Evolution Engine

### Mutation Operators

| Operator     | Input                        | Output                             | Proof Required                                                                                        |
| ------------ | ---------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `add`        | rule definition              | spec + new rule                    | NCD (no _new_ duplicate pairs), bloom (vs surviving rules)                                            |
| `remove`     | rule ID                      | spec − rule                        | Monotonicity (rejects unless rule in `allowWeaken`)                                                   |
| `strengthen` | rule ID + linterRule         | `guidance → enforce`               | Monotonicity (always passes by definition)                                                            |
| `weaken`     | rule ID + justification      | `enforce → guidance`               | Monotonicity (requires `allowWeaken`)                                                                 |
| `merge`      | two source IDs + merged rule | sources removed, merged rule added | Sources allowlisted for this call; merged rule must be ≥ strongest source; bloom excludes removed IDs |
| `reword`     | rule ID + new text           | updated rule text                  | NCD (no new duplicate pair introduced)                                                                |

Two rule kinds today (`enforce`, `guidance`) — the earlier `check` kind
was dropped. Strength ordering is `guidance < enforce`.

### Fitness Function

```
fitness(spec) = coverage × (1 - redundancy) × (1 - budget_pressure)
```

Where:

- **coverage** = enforced rules / total rules — fraction with teeth
- **redundancy** = fraction of rule pairs below the NCD threshold — penalizes duplication
- **budget_pressure** = tokens_used / max_tokens — penalizes bloat

Higher fitness = better spec. Range: [0, 1].

### Selection Protocol

1. AI agent proposes a mutation
2. Evolution engine applies mutation to produce candidate spec
3. Run full proof suite on candidate
4. If all proofs pass AND fitness(candidate) ≥ fitness(current): **accept**
5. If proofs fail: **reject** with diagnostic (which proof failed, why)
6. Append accepted mutation to Merkle history

This is a **hill-climbing** algorithm with proof-based constraints. The proofs prevent invalid moves; the fitness function guides toward better specs.

---

## Self-Evolution Loop

The full loop for autonomous spec improvement:

```
1. Agent analyzes codebase (linter violations, PR comments, test failures)
2. Agent proposes mutation: "Add enforce('eslint/no-floating-promises')"
3. Evolution engine:
   a. Apply mutation to spec
   b. Run proof suite:
      - Monotonicity: ✓ (adding a rule, not weakening)
      - NCD: ✓ (no NEW near-duplicate pair vs baseline)
      - Fixed-point: ✓ (compilation converges in 1 iteration)
      - Bloom filter: ✓ (no token overlap against surviving rules)
   c. Compute fitness: 0.73 → 0.76 (improvement)
   d. Accept mutation
4. Append to Merkle history with proof receipts
5. Recompile spec → new CLAUDE.md
6. Commit with evolution metadata
```

The agent can run this loop continuously. Each iteration is deterministically verified. The spec gets better over time without human intervention — but every change is auditable and reversible.

---

## Implementation

### Core Modules

| Module               | Purpose          | Key Exports                                                                                |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `src/proofs.ts`      | Proof algorithms | `MonotonicityLattice`, `ncd`, `BloomFilter`, `fixedPoint`, `MerkleHistory`, `propertyTest` |
| `src/evolve.ts`      | Evolution engine | `EvolutionEngine`, mutations, fitness, selection                                           |
| `src/proofs.test.ts` | Proof tests      | Comprehensive test suite for all algorithms                                                |

### Dependencies

All algorithms use only Node.js built-ins:

- `node:crypto` — SHA-256 for Merkle hashing
- `node:zlib` — gzip for NCD compression
- No external dependencies added

---

## Theoretical Foundations

| Algorithm               | Theory                                                 | Complexity                         | Reference                                               |
| ----------------------- | ------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------- |
| Monotonicity lattice    | Order theory, lattice algebra                          | O(n) per comparison                | Davey & Priestley, "Introduction to Lattices and Order" |
| NCD                     | Kolmogorov complexity, information theory              | O(n log n) per pair (compression)  | Li et al. 2004, "The Similarity Metric"                 |
| Fixed-point convergence | Banach fixed-point theorem, discrete dynamical systems | O(k × compile_time)                | Granas & Dugundji, "Fixed Point Theory"                 |
| Bloom filter            | Probabilistic data structures                          | O(k) per insert/query              | Bloom 1970, "Space/Time Trade-offs in Hash Coding"      |
| Merkle DAG              | Cryptographic hash chains, content addressing          | O(n) verification                  | Merkle 1987                                             |
| Property-based testing  | QuickCheck, fuzzing theory                             | O(n × m) for n tests × m mutations | Claessen & Hughes 2000                                  |

---

## What This Enables

1. **Autonomous spec improvement** — AI agents propose changes, proofs verify them, no human in the loop for routine improvements
2. **Auditable evolution** — Every change has a Merkle proof chain back to genesis
3. **Regression prevention** — Monotonicity lattice catches silent weakening
4. **Deduplication** — NCD + Bloom filter catch redundant rules before they bloat the spec
5. **Convergence guarantee** — Fixed-point analysis catches pathological self-referential specs
6. **Robustness testing** — Property-based testing finds edge cases humans miss
7. **Cross-project learning** — Bloom filter indices can be shared across projects for fast rule discovery without sharing actual content

---

## Open Questions

1. **Multi-agent convergence** — When multiple agents propose mutations concurrently, how to merge? CRDTs for spec evolution?
2. **Fitness landscape visualization** — Can we render the fitness landscape to help humans understand spec quality?
3. **Transfer learning** — Can Bloom filter indices from mature projects accelerate new project bootstrap?
4. **Formal verification** — Could we encode the monotonicity lattice in a proof assistant (Lean, Coq) for machine-checked proofs?
5. **Adversarial robustness** — Can a malicious agent craft mutations that pass all proofs but degrade spec quality in subtle ways?
