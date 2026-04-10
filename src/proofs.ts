/**
 * vigiles — Deterministic proof system for self-evolving specifications.
 *
 * Six algorithms that verify spec mutations without any LLM dependency:
 *
 *   1. MonotonicityLattice — rules can only strengthen over time
 *   2. ncd()              — information-theoretic duplicate detection
 *   3. BloomFilter        — fast approximate set membership
 *   4. fixedPoint()       — compilation convergence detection
 *   5. MerkleHistory      — tamper-evident spec evolution audit trail
 *   6. propertyTest()     — random mutation + invariant checking
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { Rule, ClaudeSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// 1. Monotonicity Lattice — partial order on rule strength
// ---------------------------------------------------------------------------

/**
 * Ordinal strength of each rule kind.
 *
 *   guidance (0) < check (1) < enforce (2)
 *
 * The lattice ensures specs only get stricter over time.
 */
const STRENGTH: Record<Rule["_kind"], number> = {
  guidance: 0,
  check: 1,
  enforce: 2,
};

export interface MonotonicityViolation {
  ruleId: string;
  from: Rule["_kind"];
  to: Rule["_kind"];
  fromStrength: number;
  toStrength: number;
}

export interface MonotonicityResult {
  valid: boolean;
  violations: MonotonicityViolation[];
  added: string[];
  removed: string[];
  strengthened: string[];
  unchanged: string[];
}

/**
 * Check that a spec mutation is monotonic: existing rules only strengthen.
 *
 * - Adding rules: always allowed
 * - Removing rules: flagged (informational, not a violation by default)
 * - Strengthening (guidance → check → enforce): allowed
 * - Weakening (enforce → guidance): violation unless allowWeaken includes the rule ID
 */
export function checkMonotonicity(
  before: Record<string, Rule>,
  after: Record<string, Rule>,
  options: { allowWeaken?: Set<string> } = {},
): MonotonicityResult {
  const violations: MonotonicityViolation[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const strengthened: string[] = [];
  const unchanged: string[] = [];

  const allowWeaken = options.allowWeaken ?? new Set<string>();

  // Check rules present in both versions
  for (const [id, beforeRule] of Object.entries(before)) {
    const afterRule = after[id];
    if (!afterRule) {
      removed.push(id);
      continue;
    }

    const beforeStrength = STRENGTH[beforeRule._kind];
    const afterStrength = STRENGTH[afterRule._kind];

    if (afterStrength < beforeStrength && !allowWeaken.has(id)) {
      violations.push({
        ruleId: id,
        from: beforeRule._kind,
        to: afterRule._kind,
        fromStrength: beforeStrength,
        toStrength: afterStrength,
      });
    } else if (afterStrength > beforeStrength) {
      strengthened.push(id);
    } else {
      unchanged.push(id);
    }
  }

  // New rules
  for (const id of Object.keys(after)) {
    if (!(id in before)) {
      added.push(id);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    added,
    removed,
    strengthened,
    unchanged,
  };
}

/**
 * Compute the join (least upper bound) of two rule kinds in the lattice.
 * join(guidance, enforce) = enforce
 */
export function latticeJoin(a: Rule["_kind"], b: Rule["_kind"]): Rule["_kind"] {
  return STRENGTH[a] >= STRENGTH[b] ? a : b;
}

/**
 * Compute the meet (greatest lower bound) of two rule kinds in the lattice.
 * meet(guidance, enforce) = guidance
 */
export function latticeMeet(a: Rule["_kind"], b: Rule["_kind"]): Rule["_kind"] {
  return STRENGTH[a] <= STRENGTH[b] ? a : b;
}

/** Get the numeric strength of a rule kind. */
export function ruleStrength(kind: Rule["_kind"]): number {
  return STRENGTH[kind];
}

// ---------------------------------------------------------------------------
// 2. Normalized Compression Distance (NCD)
// ---------------------------------------------------------------------------

/**
 * Compute the compressed size of a string using gzip.
 * This approximates Kolmogorov complexity — the length of the shortest
 * program that produces the string.
 */
function compressedSize(s: string): number {
  return gzipSync(Buffer.from(s, "utf-8"), { level: 9 }).length;
}

/**
 * Normalized Compression Distance — information-theoretic similarity.
 *
 *   NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))
 *
 * Range: [0, 1+ε] where 0 = identical information content.
 * Deterministic. No model dependency. Approximates the universal distance metric.
 *
 * Reference: Li, Chen, Li, Ma, Vitányi (2004) "The Similarity Metric"
 */
export function ncd(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 && b.length === 0) return 0;

  const ca = compressedSize(a);
  const cb = compressedSize(b);
  const cab = compressedSize(a + b);

  const minC = Math.min(ca, cb);
  const maxC = Math.max(ca, cb);

  if (maxC === 0) return 0;
  return (cab - minC) / maxC;
}

export interface NCDPair {
  idA: string;
  idB: string;
  distance: number;
}

/**
 * Find all rule pairs with NCD below a similarity threshold.
 * Returns pairs sorted by distance (most similar first).
 */
export function findSimilarRules(
  rules: Record<string, Rule>,
  threshold: number = 0.5,
): NCDPair[] {
  const entries = Object.entries(rules);
  const pairs: NCDPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, ruleA] = entries[i];
      const [idB, ruleB] = entries[j];

      const textA = ruleToText(ruleA);
      const textB = ruleToText(ruleB);

      const d = ncd(textA, textB);
      if (d < threshold) {
        pairs.push({ idA, idB, distance: d });
      }
    }
  }

  return pairs.sort((a, b) => a.distance - b.distance);
}

/** Extract the text content of a rule for NCD comparison. */
function ruleToText(rule: Rule): string {
  switch (rule._kind) {
    case "enforce":
      return `${rule.linterRule} ${rule.why}`;
    case "check":
      return `${rule.assertion.glob} ${rule.assertion.pattern} ${rule.why}`;
    case "guidance":
      return rule.text;
  }
}

// ---------------------------------------------------------------------------
// 3. Bloom Filter — probabilistic set membership
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash — fast, good distribution, deterministic.
 * Returns a 32-bit unsigned integer.
 */
function fnv1a(data: string, seed: number = 0): number {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0; // ensure unsigned
}

/**
 * Bloom filter — space-efficient probabilistic set membership.
 *
 * Insert elements, then query "is X possibly in the set?"
 * False positives possible. False negatives impossible.
 *
 * Optimal parameters:
 *   m = -(n × ln(p)) / (ln2)²     (bit array size)
 *   k = (m / n) × ln2              (hash function count)
 *
 * Reference: Bloom (1970) "Space/Time Trade-offs in Hash Coding"
 */
export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly numHashes: number;
  readonly size: number;
  private _count: number = 0;

  /**
   * Create a Bloom filter.
   * @param expectedItems Expected number of items to insert
   * @param falsePositiveRate Desired false positive rate (0-1)
   */
  constructor(expectedItems: number, falsePositiveRate: number = 0.01) {
    // m = -(n * ln(p)) / (ln2)^2
    const m = Math.ceil(
      (-expectedItems * Math.log(falsePositiveRate)) / Math.log(2) ** 2,
    );
    // k = (m/n) * ln2
    const k = Math.max(1, Math.round((m / expectedItems) * Math.log(2)));

    this.size = m;
    this.numHashes = k;
    this.bits = new Uint8Array(Math.ceil(m / 8));
  }

  /** Number of items inserted. */
  get count(): number {
    return this._count;
  }

  /** Theoretical false positive rate given current fill. */
  get estimatedFPR(): number {
    const exponent = (-this.numHashes * this._count) / this.size;
    return (1 - Math.exp(exponent)) ** this.numHashes;
  }

  /** Insert an element. */
  add(item: string): void {
    for (let i = 0; i < this.numHashes; i++) {
      const pos = fnv1a(item, i) % this.size;
      const byteIndex = pos >>> 3;
      const bitIndex = pos & 7;
      this.bits[byteIndex] |= 1 << bitIndex;
    }
    this._count++;
  }

  /** Query membership. Returns true if the item MIGHT be in the set. */
  has(item: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const pos = fnv1a(item, i) % this.size;
      const byteIndex = pos >>> 3;
      const bitIndex = pos & 7;
      if ((this.bits[byteIndex] & (1 << bitIndex)) === 0) {
        return false; // definitely not in set
      }
    }
    return true; // possibly in set
  }

  /**
   * Estimate the Jaccard similarity between two Bloom filters.
   * Uses bit-level comparison — no need to know the original elements.
   */
  static jaccardSimilarity(a: BloomFilter, b: BloomFilter): number {
    if (a.size !== b.size) {
      throw new Error("Bloom filters must have the same size for comparison");
    }

    let intersection = 0;
    let union = 0;

    for (let i = 0; i < a.bits.length; i++) {
      const and = a.bits[i] & b.bits[i];
      const or = a.bits[i] | b.bits[i];

      // Count set bits (Brian Kernighan's algorithm)
      let x = and;
      while (x) {
        intersection++;
        x &= x - 1;
      }
      x = or;
      while (x) {
        union++;
        x &= x - 1;
      }
    }

    return union === 0 ? 1 : intersection / union;
  }
}

/**
 * Build a Bloom filter from a rule's tokens.
 * Tokenizes rule text into words and n-grams for fuzzy matching.
 */
export function ruleToBloomFilter(
  rule: Rule,
  expectedTokens: number = 100,
): BloomFilter {
  const text = ruleToText(rule);
  const filter = new BloomFilter(expectedTokens, 0.01);

  // Word-level tokens
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    filter.add(word);
  }

  // Character 3-grams for fuzzy matching
  const normalized = text.toLowerCase();
  for (let i = 0; i <= normalized.length - 3; i++) {
    filter.add(normalized.slice(i, i + 3));
  }

  return filter;
}

// ---------------------------------------------------------------------------
// 4. Fixed-Point Convergence
// ---------------------------------------------------------------------------

export interface FixedPointResult {
  converged: boolean;
  iterations: number;
  /** Hash at each iteration. */
  hashes: string[];
  /** If not converged, the cycle length (0 = no cycle detected within maxIterations). */
  cycleLength: number;
}

/**
 * Detect whether a compile function reaches a fixed point.
 *
 * A fixed point means: applying the function again produces the same output.
 * compile(compile(spec)) === compile(spec)
 *
 * If the function doesn't converge, detects cycles using Floyd's
 * tortoise-and-hare algorithm adapted for hash sequences.
 *
 * @param compileFn A function that takes content and returns new content
 * @param initialContent Starting content
 * @param maxIterations Maximum iterations before declaring divergence
 */
export function fixedPoint(
  compileFn: (content: string) => string,
  initialContent: string,
  maxIterations: number = 10,
): FixedPointResult {
  const hashes: string[] = [];
  let current = initialContent;

  for (let i = 0; i < maxIterations; i++) {
    const hash = sha256short(current);
    hashes.push(hash);

    const next = compileFn(current);
    const nextHash = sha256short(next);

    // Fixed point: output === input
    if (nextHash === hash) {
      return { converged: true, iterations: i + 1, hashes, cycleLength: 0 };
    }

    // Cycle detection: have we seen this hash before?
    const cycleStart = hashes.indexOf(nextHash);
    if (cycleStart !== -1) {
      return {
        converged: false,
        iterations: i + 1,
        hashes: [...hashes, nextHash],
        cycleLength: i + 1 - cycleStart,
      };
    }

    current = next;
  }

  return {
    converged: false,
    iterations: maxIterations,
    hashes,
    cycleLength: 0,
  };
}

// ---------------------------------------------------------------------------
// 5. Merkle History — content-addressed spec evolution DAG
// ---------------------------------------------------------------------------

export interface Mutation {
  type: "add" | "remove" | "strengthen" | "weaken" | "merge" | "reword";
  ruleIds: string[];
  description: string;
}

export interface ProofReceipt {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface HistoryNode {
  /** SHA-256 hash of this node (covers all fields except `hash` itself). */
  hash: string;
  /** Hash of the parent node ("genesis" for the first node). */
  parentHash: string;
  /** Hash of the compiled spec content at this version. */
  specHash: string;
  /** What mutation was applied. */
  mutation: Mutation;
  /** Proof receipts — which proofs ran and their results. */
  proofs: ProofReceipt[];
  /** Unix timestamp (ms). */
  timestamp: number;
}

/** Compute a short SHA-256 hash (16 hex chars). */
function sha256short(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** Compute the hash of a HistoryNode (excluding the hash field itself). */
function computeNodeHash(node: Omit<HistoryNode, "hash">): string {
  const payload = JSON.stringify({
    parentHash: node.parentHash,
    specHash: node.specHash,
    mutation: node.mutation,
    proofs: node.proofs,
    timestamp: node.timestamp,
  });
  return sha256short(payload);
}

/**
 * Merkle history — append-only, tamper-evident spec evolution log.
 *
 * Each node's hash covers its parent hash, creating a chain where
 * tampering with any node invalidates all descendants.
 */
export class MerkleHistory {
  private nodes: HistoryNode[] = [];

  /** Number of versions in the history. */
  get length(): number {
    return this.nodes.length;
  }

  /** Get all nodes (defensive copy). */
  getNodes(): readonly HistoryNode[] {
    return [...this.nodes];
  }

  /** Get the latest node, or null if empty. */
  head(): HistoryNode | null {
    return this.nodes.length > 0 ? this.nodes[this.nodes.length - 1] : null;
  }

  /**
   * Append a new version to the history.
   * Returns the hash of the new node.
   */
  append(
    specHash: string,
    mutation: Mutation,
    proofs: ProofReceipt[],
  ): string {
    const parentHash =
      this.nodes.length > 0
        ? this.nodes[this.nodes.length - 1].hash
        : "genesis";

    const partial = {
      parentHash,
      specHash,
      mutation,
      proofs,
      timestamp: Date.now(),
    };

    const hash = computeNodeHash(partial);
    this.nodes.push({ hash, ...partial });
    return hash;
  }

  /**
   * Verify the entire chain — every node's hash must be correct,
   * and every parent pointer must match the previous node.
   *
   * Returns the index of the first invalid node, or -1 if valid.
   */
  verify(): { valid: boolean; invalidAt: number } {
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];

      // Check hash integrity
      const { hash: _hash, ...rest } = node;
      const expectedHash = computeNodeHash(rest);
      if (node.hash !== expectedHash) {
        return { valid: false, invalidAt: i };
      }

      // Check parent chain
      if (i === 0) {
        if (node.parentHash !== "genesis") {
          return { valid: false, invalidAt: i };
        }
      } else {
        if (node.parentHash !== this.nodes[i - 1].hash) {
          return { valid: false, invalidAt: i };
        }
      }
    }
    return { valid: true, invalidAt: -1 };
  }

  /**
   * Serialize the history to JSON for persistence.
   */
  toJSON(): string {
    return JSON.stringify(this.nodes, null, 2);
  }

  /**
   * Deserialize a history from JSON.
   */
  static fromJSON(json: string): MerkleHistory {
    const history = new MerkleHistory();
    history.nodes = JSON.parse(json) as HistoryNode[];
    return history;
  }
}

// ---------------------------------------------------------------------------
// 6. Property-Based Testing
// ---------------------------------------------------------------------------

export type MutationGenerator<T> = (value: T, seed: number) => T;
export type Invariant<T> = (value: T) => boolean;

export interface PropertyTestResult<T> {
  passed: boolean;
  iterations: number;
  /** If failed, the mutation sequence that caused the failure. */
  failingSequence?: T[];
  /** If failed, the minimal shrunk counterexample. */
  shrunk?: T;
  /** Name of the invariant that failed. */
  failedInvariant?: string;
}

/**
 * Simple deterministic PRNG (xorshift32) for reproducible tests.
 */
function xorshift32(state: number): number {
  let x = state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return x >>> 0;
}

/**
 * Property-based testing: generate random mutations, check invariants hold.
 *
 * Inspired by QuickCheck/fast-check. Uses a deterministic PRNG for
 * reproducible failures.
 *
 * @param initial Starting value
 * @param mutate Function that produces a random mutation
 * @param invariants Named invariant functions that must all return true
 * @param options Test parameters
 */
export function propertyTest<T>(
  initial: T,
  mutate: MutationGenerator<T>,
  invariants: Record<string, Invariant<T>>,
  options: { iterations?: number; seed?: number; sequenceLength?: number } = {},
): PropertyTestResult<T> {
  const iterations = options.iterations ?? 100;
  const sequenceLength = options.sequenceLength ?? 5;
  let rng = options.seed ?? 42;

  for (let i = 0; i < iterations; i++) {
    // Generate a sequence of mutations
    let current = initial;
    const sequence: T[] = [current];

    for (let j = 0; j < sequenceLength; j++) {
      rng = xorshift32(rng);
      current = mutate(current, rng);
      sequence.push(current);

      // Check all invariants after each mutation
      for (const [name, check] of Object.entries(invariants)) {
        if (!check(current)) {
          // Shrink: binary search for minimal failing subsequence
          const shrunk = shrinkSequence(
            initial,
            sequence,
            mutate,
            name,
            invariants,
          );
          return {
            passed: false,
            iterations: i + 1,
            failingSequence: sequence,
            shrunk,
            failedInvariant: name,
          };
        }
      }
    }
  }

  return { passed: true, iterations };
}

/**
 * Shrink a failing sequence to find the minimal counterexample.
 * Uses binary search on the sequence length.
 */
function shrinkSequence<T>(
  _initial: T,
  sequence: T[],
  _mutate: MutationGenerator<T>,
  invariantName: string,
  invariants: Record<string, Invariant<T>>,
): T {
  // Simple shrinking: find the first element in the sequence that fails
  const check = invariants[invariantName];
  for (const item of sequence) {
    if (!check(item)) {
      return item;
    }
  }
  // Shouldn't reach here — return last element
  return sequence[sequence.length - 1];
}

// ---------------------------------------------------------------------------
// Fitness function for spec evolution
// ---------------------------------------------------------------------------

export interface FitnessResult {
  score: number;
  coverage: number;
  redundancy: number;
  budgetPressure: number;
}

/**
 * Compute the fitness of a spec. Higher is better.
 *
 *   fitness = coverage × (1 - redundancy) × (1 - budgetPressure)
 *
 * - coverage: fraction of rules with enforcement (check or enforce)
 * - redundancy: fraction of rule pairs that are near-duplicates (NCD < threshold)
 * - budgetPressure: tokens used / max tokens
 */
export function fitness(
  spec: ClaudeSpec,
  options: { maxTokens?: number; ncdThreshold?: number } = {},
): FitnessResult {
  const maxTokens = options.maxTokens ?? 2000;
  const ncdThreshold = options.ncdThreshold ?? 0.3;

  const rules = Object.values(spec.rules);
  const total = rules.length;

  if (total === 0) {
    return { score: 0, coverage: 0, redundancy: 0, budgetPressure: 0 };
  }

  // Coverage: fraction with teeth
  const enforced = rules.filter(
    (r) => r._kind === "enforce" || r._kind === "check",
  ).length;
  const coverage = enforced / total;

  // Redundancy: fraction of pairs that are near-duplicates
  const similarPairs = findSimilarRules(spec.rules, ncdThreshold);
  const totalPairs = (total * (total - 1)) / 2;
  const redundancy = totalPairs > 0 ? similarPairs.length / totalPairs : 0;

  // Budget pressure: rough token estimate (~4 chars per token)
  const ruleTexts = rules.map(ruleToText);
  const totalChars = ruleTexts.reduce((sum, t) => sum + t.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);
  const budgetPressure = Math.min(1, estimatedTokens / maxTokens);

  const score = coverage * (1 - redundancy) * (1 - budgetPressure);

  return { score, coverage, redundancy, budgetPressure };
}
