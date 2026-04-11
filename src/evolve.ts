/**
 * vigiles — Evolution engine for self-evolving specifications.
 *
 * AI agents propose mutations. The engine applies them, runs the proof suite,
 * and only accepts mutations that pass all proofs AND improve fitness.
 *
 * Pattern: "LLM proposes, deterministic algorithm disposes."
 */

import type { Rule, ClaudeSpec, EnforceRule, GuidanceRule } from "./spec.js";
import {
  checkMonotonicity,
  findSimilarRules,
  BloomFilter,
  ruleToBloomFilter,
  fitness,
  ruleStrength,
  MerkleHistory,
  type Mutation,
  type ProofReceipt,
  type FitnessResult,
  type ReadonlyMerkleHistory,
} from "./proofs.js";
import { computeHash } from "./compile.js";

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

export interface AddRuleMutation {
  type: "add";
  ruleId: string;
  rule: Rule;
}

export interface RemoveRuleMutation {
  type: "remove";
  ruleId: string;
}

export interface StrengthenMutation {
  type: "strengthen";
  ruleId: string;
  /** For guidance→enforce, provide the linter rule to enforce. */
  linterRule?: string;
}

export interface WeakenMutation {
  type: "weaken";
  ruleId: string;
  justification: string;
}

export interface MergeRulesMutation {
  type: "merge";
  sourceIds: [string, string];
  mergedId: string;
  mergedRule: Rule;
}

export interface RewordMutation {
  type: "reword";
  ruleId: string;
  newText: string;
}

export type SpecMutation =
  | AddRuleMutation
  | RemoveRuleMutation
  | StrengthenMutation
  | WeakenMutation
  | MergeRulesMutation
  | RewordMutation;

// ---------------------------------------------------------------------------
// Mutation application
// ---------------------------------------------------------------------------

export interface MutationError {
  mutation: SpecMutation;
  reason: string;
}

/**
 * Shallow-clone a Rule. Rules are simple value types (primitive fields only),
 * so a spread is sufficient to decouple engine state from the caller's
 * mutation object — without this, later caller-side edits would silently
 * alter accepted engine state without re-running proofs.
 */
function cloneRule(rule: Rule): Rule {
  return { ...rule };
}

/**
 * Apply a mutation to a spec's rules, producing a new rule map.
 * Returns null + error if the mutation is invalid.
 */
export function applyMutation(
  rules: Record<string, Rule>,
  mutation: SpecMutation,
): { rules: Record<string, Rule>; error?: MutationError } {
  const next = { ...rules };

  switch (mutation.type) {
    case "add": {
      if (mutation.ruleId in next) {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" already exists`,
          },
        };
      }
      next[mutation.ruleId] = cloneRule(mutation.rule);
      return { rules: next };
    }

    case "remove": {
      if (!(mutation.ruleId in next)) {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" not found`,
          },
        };
      }
      const { [mutation.ruleId]: _removed, ...rest } = next;
      void _removed;
      return { rules: rest };
    }

    case "strengthen": {
      const rule = next[mutation.ruleId];
      if (!rule) {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" not found`,
          },
        };
      }

      if (rule._kind === "guidance") {
        if (mutation.linterRule) {
          // guidance → enforce
          next[mutation.ruleId] = {
            _kind: "enforce",
            linterRule: mutation.linterRule,
            why: rule.text,
            verify: true,
          } as EnforceRule;
        } else {
          return {
            rules,
            error: {
              mutation,
              reason:
                "Strengthening guidance requires a linterRule to enforce against.",
            },
          };
        }
      } else {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" is already at maximum strength (enforce)`,
          },
        };
      }
      return { rules: next };
    }

    case "weaken": {
      const rule = next[mutation.ruleId];
      if (!rule) {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" not found`,
          },
        };
      }

      if (rule._kind === "enforce") {
        next[mutation.ruleId] = {
          _kind: "guidance",
          text: rule.why,
        } as GuidanceRule;
      } else {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" is already at minimum strength (guidance)`,
          },
        };
      }
      return { rules: next };
    }

    case "merge": {
      const [idA, idB] = mutation.sourceIds;
      if (idA === idB) {
        return {
          rules,
          error: {
            mutation,
            reason: `Merge requires two distinct source rules; got "${idA}" twice`,
          },
        };
      }
      if (!(idA in next) || !(idB in next)) {
        return {
          rules,
          error: {
            mutation,
            reason: `One or both source rules not found: "${idA}", "${idB}"`,
          },
        };
      }
      // mergedId must not collide with an unrelated existing rule —
      // otherwise the assignment would silently overwrite that rule and
      // drop its constraints. Allowed only when mergedId is one of the
      // sources being consumed (renaming-in-place).
      if (
        mutation.mergedId in next &&
        mutation.mergedId !== idA &&
        mutation.mergedId !== idB
      ) {
        return {
          rules,
          error: {
            mutation,
            reason: `Merge target "${mutation.mergedId}" collides with an existing unrelated rule; pick a new id or remove the existing rule first`,
          },
        };
      }
      // Merge must not silently weaken enforcement. The merged rule's
      // strength must be at least as strong as the strongest source —
      // otherwise a caller could launder two enforced rules into a
      // single guidance rule and bypass monotonicity (because the
      // per-call allowWeaken for merge sources means removals don't
      // trigger the violation).
      const sourceStrengths = mutation.sourceIds.map((id) =>
        ruleStrength(next[id]._kind),
      );
      const maxSourceStrength = Math.max(...sourceStrengths);
      const mergedStrength = ruleStrength(mutation.mergedRule._kind);
      if (mergedStrength < maxSourceStrength) {
        return {
          rules,
          error: {
            mutation,
            reason: `Merged rule "${mutation.mergedId}" (${mutation.mergedRule._kind}) is weaker than source rules (strongest was ${maxSourceStrength === 1 ? "enforce" : "guidance"}). Merges may not downgrade enforcement.`,
          },
        };
      }
      const { [idA]: _a, [idB]: _b, ...rest } = next;
      void _a;
      void _b;
      return {
        rules: { ...rest, [mutation.mergedId]: cloneRule(mutation.mergedRule) },
      };
    }

    case "reword": {
      const rule = next[mutation.ruleId];
      if (!rule) {
        return {
          rules,
          error: {
            mutation,
            reason: `Rule "${mutation.ruleId}" not found`,
          },
        };
      }

      if (rule._kind === "guidance") {
        next[mutation.ruleId] = { ...rule, text: mutation.newText };
      } else if (rule._kind === "enforce") {
        next[mutation.ruleId] = { ...rule, why: mutation.newText };
      }
      return { rules: next };
    }
  }
}

// ---------------------------------------------------------------------------
// Proof suite runner
// ---------------------------------------------------------------------------

export interface ProofSuiteResult {
  passed: boolean;
  receipts: ProofReceipt[];
  fitness: FitnessResult;
}

/**
 * Run all proofs on a candidate spec mutation.
 *
 * Proofs:
 * 1. Monotonicity — rules don't weaken (unless explicitly allowed)
 * 2. NCD deduplication — no near-duplicate rules introduced
 * 3. Bloom filter overlap — fast cross-check for token similarity
 */
export function runProofSuite(
  before: Record<string, Rule>,
  after: Record<string, Rule>,
  options: {
    allowWeaken?: Set<string>;
    ncdThreshold?: number;
    maxTokens?: number;
  } = {},
): ProofSuiteResult {
  const receipts: ProofReceipt[] = [];
  const ncdThreshold = options.ncdThreshold ?? 0.3;

  // 1. Monotonicity
  const mono = checkMonotonicity(before, after, {
    allowWeaken: options.allowWeaken,
  });
  receipts.push({
    name: "monotonicity",
    passed: mono.valid,
    detail: mono.valid
      ? `${mono.strengthened.length} strengthened, ${mono.added.length} added`
      : `${mono.violations.length} violations: ${mono.violations.map((v) => `${v.ruleId} (${v.from}→${v.to})`).join(", ")}`,
  });

  // 2. NCD deduplication. Wrapped in try/catch so that an unknown rule
  // kind (legacy data / JS caller) surfaces as a clean proof failure
  // rather than crashing the whole audit pipeline.
  try {
    const similar = findSimilarRules(after, ncdThreshold);
    const ncdPassed = similar.length === 0;
    receipts.push({
      name: "ncd-dedup",
      passed: ncdPassed,
      detail: ncdPassed
        ? "No near-duplicate rules"
        : `${similar.length} near-duplicate pairs: ${similar.map((p) => `${p.idA}↔${p.idB} (${p.distance.toFixed(3)})`).join(", ")}`,
    });
  } catch (e) {
    receipts.push({
      name: "ncd-dedup",
      passed: false,
      detail: `Similarity check failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 3. Bloom filter cross-check (fast sanity check for token overlap).
  // Wrapped for the same reason as NCD: ruleToBloomFilter → ruleToText
  // throws on unknown rule kinds.
  try {
    let bloomPassed = true;
    const newRuleIds = Object.keys(after).filter((id) => !(id in before));
    const existingFilters = new Map<string, BloomFilter>();

    for (const [id, rule] of Object.entries(before)) {
      existingFilters.set(id, ruleToBloomFilter(rule));
    }

    const bloomOverlaps: string[] = [];
    for (const newId of newRuleIds) {
      const newFilter = ruleToBloomFilter(after[newId]);
      for (const [existingId, existingFilter] of existingFilters) {
        if (existingId === newId) continue;
        try {
          const similarity = BloomFilter.jaccardSimilarity(
            newFilter,
            existingFilter,
          );
          if (similarity > 0.7) {
            bloomOverlaps.push(
              `${newId}↔${existingId} (jaccard=${similarity.toFixed(3)})`,
            );
            bloomPassed = false;
          }
        } catch {
          // Different filter sizes — skip comparison
        }
      }
    }

    receipts.push({
      name: "bloom-overlap",
      passed: bloomPassed,
      detail: bloomPassed
        ? "No suspicious token overlap"
        : `High overlap: ${bloomOverlaps.join(", ")}`,
    });
  } catch (e) {
    receipts.push({
      name: "bloom-overlap",
      passed: false,
      detail: `Bloom filter check failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Compute fitness of the new spec. Guard against bad runtime data: fitness
  // recomputes similarity internally and would otherwise crash on unknown
  // rule kinds (legacy `check`, JS caller), propagating the throw up through
  // the engine. Fall back to a neutral fitness and mark the proof failed.
  const specForFitness = { rules: after } as ClaudeSpec;
  let fitnessResult: FitnessResult;
  try {
    fitnessResult = fitness(specForFitness, {
      maxTokens: options.maxTokens,
      ncdThreshold,
    });
  } catch (e) {
    receipts.push({
      name: "fitness",
      passed: false,
      detail: `Fitness computation failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    fitnessResult = {
      score: 0,
      coverage: 0,
      redundancy: 0,
      budgetPressure: 0,
    };
  }

  const allPassed = receipts.every((r) => r.passed);
  return { passed: allPassed, receipts, fitness: fitnessResult };
}

// ---------------------------------------------------------------------------
// Evolution Engine
// ---------------------------------------------------------------------------

export interface EvolutionResult {
  accepted: boolean;
  mutation: SpecMutation;
  proofs: ProofSuiteResult;
  beforeFitness: FitnessResult;
  afterFitness: FitnessResult;
  historyHash?: string;
  error?: string;
}

/**
 * The evolution engine: the core of the self-evolving spec system.
 *
 * Maintains a spec, a proof suite, and a Merkle history.
 * Accepts mutations that pass all proofs and improve (or maintain) fitness.
 */
export class EvolutionEngine {
  private rules: Record<string, Rule>;
  private readonly history: MerkleHistory;
  private readonly options: {
    allowWeaken: Set<string>;
    ncdThreshold: number;
    maxTokens: number;
    /** Accept mutations that don't improve fitness (only require proofs pass). */
    acceptNeutral: boolean;
  };

  constructor(
    initialRules: Record<string, Rule>,
    options: {
      allowWeaken?: Set<string>;
      ncdThreshold?: number;
      maxTokens?: number;
      acceptNeutral?: boolean;
      history?: MerkleHistory;
    } = {},
  ) {
    this.rules = Object.fromEntries(
      Object.entries(initialRules).map(([id, rule]) => [id, cloneRule(rule)]),
    );
    this.history = options.history ?? new MerkleHistory();
    this.options = {
      allowWeaken: options.allowWeaken ?? new Set(),
      ncdThreshold: options.ncdThreshold ?? 0.3,
      maxTokens: options.maxTokens ?? 2000,
      acceptNeutral: options.acceptNeutral ?? false,
    };

    // If a history was supplied, verify its chain integrity and that its
    // head corresponds to initialRules. A stale or mismatched history would
    // produce misleading provenance for subsequent mutations.
    if (options.history) {
      const verification = this.history.verify();
      if (!verification.valid) {
        throw new Error(
          `Supplied Merkle history is invalid at node ${String(verification.invalidAt)}. Tamper detected or corrupted chain.`,
        );
      }
      if (this.history.length > 0) {
        const expectedHash = computeHash(JSON.stringify(this.rules));
        const head = this.history.head();
        if (head && head.specHash !== expectedHash) {
          throw new Error(
            `Supplied Merkle history head does not match initialRules. ` +
              `History head specHash="${head.specHash}", expected="${expectedHash}". ` +
              `The history and rules are mismatched; refusing to record new mutations on the wrong chain.`,
          );
        }
      }
    }

    // Record genesis state
    if (this.history.length === 0) {
      const specHash = computeHash(JSON.stringify(this.rules));
      this.history.append(
        specHash,
        {
          type: "add",
          ruleIds: Object.keys(this.rules),
          description: "Genesis",
        },
        [{ name: "genesis", passed: true }],
      );
    }
  }

  /**
   * Get current rules as a deep defensive copy. Callers cannot mutate
   * engine state through the returned map because every rule is cloned —
   * otherwise a JS caller or a TS cast could silently alter accepted
   * state without running proofs or appending to history.
   */
  getRules(): Record<string, Rule> {
    return Object.fromEntries(
      Object.entries(this.rules).map(([id, rule]) => [id, cloneRule(rule)]),
    );
  }

  /**
   * Get a read-only view of the Merkle history.
   *
   * Callers can inspect nodes, verify the chain, and serialize it, but
   * cannot append new entries — that would bypass `propose()`'s proof and
   * fitness gates and corrupt the audit trail.
   */
  getHistory(): ReadonlyMerkleHistory {
    return this.history;
  }

  /** Get current fitness. */
  getFitness(): FitnessResult {
    return fitness({ rules: this.rules } as ClaudeSpec, {
      maxTokens: this.options.maxTokens,
      ncdThreshold: this.options.ncdThreshold,
    });
  }

  /**
   * Propose a mutation. The engine applies it, runs proofs, and accepts or rejects.
   *
   * Returns a detailed result including proof receipts and fitness comparison.
   */
  propose(mutation: SpecMutation): EvolutionResult {
    const beforeFitness = this.getFitness();

    // Apply the mutation
    const { rules: candidateRules, error } = applyMutation(
      this.rules,
      mutation,
    );
    if (error) {
      return {
        accepted: false,
        mutation,
        proofs: { passed: false, receipts: [], fitness: beforeFitness },
        beforeFitness,
        afterFitness: beforeFitness,
        error: error.reason,
      };
    }

    // For merge mutations, the source rule IDs are removed by design.
    // Add them to a per-call allowWeaken set so checkMonotonicity doesn't
    // reject the removal as a monotonicity violation — merging is the
    // intended constraint-reducing operation, not silent deletion.
    const perCallAllowWeaken = new Set(this.options.allowWeaken);
    if (mutation.type === "merge") {
      for (const id of mutation.sourceIds) {
        perCallAllowWeaken.add(id);
      }
    }

    // Run proof suite
    const proofResult = runProofSuite(this.rules, candidateRules, {
      allowWeaken: perCallAllowWeaken,
      ncdThreshold: this.options.ncdThreshold,
      maxTokens: this.options.maxTokens,
    });

    const afterFitness = proofResult.fitness;

    // Decision: all proofs pass AND fitness doesn't decrease.
    //
    // `acceptNeutral` relaxes strict improvement (>) to ≥ — i.e. it accepts
    // mutations that keep fitness the same. It must NOT accept regressions:
    // a previous version short-circuited on acceptNeutral, which meant any
    // proof-passing mutation was accepted regardless of score, silently
    // driving spec quality downward over time.
    const fitnessOk = this.options.acceptNeutral
      ? afterFitness.score >= beforeFitness.score
      : afterFitness.score > beforeFitness.score;
    const accepted = proofResult.passed && fitnessOk;

    let historyHash: string | undefined;

    if (accepted) {
      // Accept the mutation
      this.rules = candidateRules;

      // Record in Merkle history
      const specHash = computeHash(JSON.stringify(this.rules));
      const historyMutation: Mutation = {
        type: mutation.type === "merge" ? "merge" : mutation.type,
        ruleIds:
          mutation.type === "merge"
            ? [...mutation.sourceIds, mutation.mergedId]
            : ["ruleId" in mutation ? mutation.ruleId : "unknown"],
        description: describeMutation(mutation),
      };
      // Defensive copy: the same proofResult is returned to the caller,
      // so without this clone a caller mutating result.proofs.receipts
      // would retroactively alter the stored history node.
      historyHash = this.history.append(
        specHash,
        historyMutation,
        proofResult.receipts.map((r) => ({ ...r })),
      );
    }

    return {
      accepted,
      mutation,
      proofs: proofResult,
      beforeFitness,
      afterFitness,
      historyHash,
      error: !proofResult.passed
        ? `Proofs failed: ${proofResult.receipts
            .filter((r) => !r.passed)
            .map((r) => r.name)
            .join(", ")}`
        : !fitnessOk
          ? `Fitness decreased: ${beforeFitness.score.toFixed(3)} → ${afterFitness.score.toFixed(3)}`
          : undefined,
    };
  }

  /**
   * Propose multiple mutations in sequence.
   * Stops at the first rejection unless `continueOnReject` is true.
   */
  proposeAll(
    mutations: SpecMutation[],
    options: { continueOnReject?: boolean } = {},
  ): EvolutionResult[] {
    const results: EvolutionResult[] = [];
    for (const mutation of mutations) {
      const result = this.propose(mutation);
      results.push(result);
      if (!result.accepted && !options.continueOnReject) break;
    }
    return results;
  }
}

/** Human-readable description of a mutation. */
function describeMutation(mutation: SpecMutation): string {
  switch (mutation.type) {
    case "add":
      return `Add rule "${mutation.ruleId}" (${mutation.rule._kind})`;
    case "remove":
      return `Remove rule "${mutation.ruleId}"`;
    case "strengthen":
      return `Strengthen rule "${mutation.ruleId}"${mutation.linterRule ? ` → enforce(${mutation.linterRule})` : ""}`;
    case "weaken":
      return `Weaken rule "${mutation.ruleId}": ${mutation.justification}`;
    case "merge":
      return `Merge "${mutation.sourceIds[0]}" + "${mutation.sourceIds[1]}" → "${mutation.mergedId}"`;
    case "reword":
      return `Reword rule "${mutation.ruleId}"`;
  }
}
