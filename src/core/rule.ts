/**
 * THE RULE PORT — what a lint rule IS, as core sees it. Core declares it; each
 * rule implements it as a module in `src/rules/<id>.ts`; `src/rules/index.ts`
 * assembles the set; and only a composition root (`src/cli-main.ts`, the
 * browser demo's entry) hands that set to the generic machinery here — the
 * config schema (`configFor`), the presets, `init`'s policy, and (next) the
 * scan's rule findings. The same shape as the harness ports: core never imports
 * a rule, never spells a rule id and never names a group, and three ESLint
 * fences hold that (`local/no-rule-ids`, `local/no-group-names`, the
 * `boundaries` rule layer — see `eslint.config.mjs`).
 *
 * WHY NOT A REGISTRY IN CORE. One was proposed and rejected (2026-10-14): a
 * `core/rule-registry.ts` importing every rule moves the list into one file but
 * leaves core depending on the rules, which is the dependency this port exists
 * to remove (`.claude/skills/hexagonal-architecture/SKILL.md`, mistake 2).
 *
 * WHY THE DETECTOR STAYS IN CORE. A detector (`skillResourceIssues`,
 * `lethalTrifectaIssues`) is a domain capability — a pure function over a
 * parsed artifact, shared by `lint` and `audit` (one-detector-no-drift). What a
 * rule module adds is the POLICY around it: its id, group, default, cure, and
 * how a finding reads.
 *
 * Harness-agnostic data; no adapter fact.
 */
import type { z } from "zod";
import type { SkillResourceFinding } from "./skill-resources.js";

/**
 * The decidability class of a defect — the single fact that sets its ceiling.
 *
 * - `structural-closed` — decidable from the artifact's own content over a CLOSED
 *   vocabulary; a TYPE could make it impossible for authors who route through the
 *   typed constructor. Ceiling: unrepresentable / won't-typecheck.
 * - `external-decidable` — decidable, but needs the EXTERNAL world (the
 *   filesystem, a linter catalog, another file/server). No type can read those,
 *   so the ceiling is a hard ERROR at compile-cross-ref or lint — never a type.
 * - `heuristic-behavioral` — undecidable or a fuzzy proxy ("are these too
 *   similar?", "does this fire?"). Ceiling: a WARNING or a model-MEASUREMENT. By
 *   the math, not by laziness; an `error` here would cry wolf.
 *
 * The bucket is the CEILING; `defaultSeverity` is where the rule sits TODAY. A
 * bucket-A/B rule at `warn` is a CANDIDATE for promotion to `error`; a bucket-C
 * rule at `warn` is permanent.
 */
export type RuleBucket =
  | "structural-closed"
  | "external-decidable"
  | "heuristic-behavioral";

/** The artifact surface a rule reads (coarse; a rule may span several). */
export type RuleSurface =
  | "instruction"
  | "skill"
  | "subagent"
  | "hook"
  | "output-style"
  | "mcp"
  | "plugin"
  | "docs";

/** Where a rule sits by default — `"off"` is the normalized form of `false`. */
export type RuleDefaultSeverity = "error" | "warn" | "off";

/**
 * What fixes a rule's finding: `"edit"` (the user edits their own file), a CLI
 * verb, or a public export. Data, so a test can hold the line that a rule ON by
 * default is never curable only through an `experimental_` export.
 */
export type RuleCure =
  | "edit"
  | { readonly cli: "compile" | "init" }
  | { readonly export: string };

/**
 * One finding as every surface prints it — `lint`'s line, `audit`'s terminal
 * block, the `AuditReport` JSON and the HTML report all read this one shape, so
 * they cannot drift on what a finding says.
 */
export interface Finding {
  /**
   * `finding` — what the rule reports (`✗`/`⚠`, counted at the rule's
   * severity); `note` — informational, never counted, so it never fails CI.
   */
  readonly kind: "finding" | "note";
  /** The file the finding is in, relative to the scanned directory. */
  readonly path: string;
  /** 1-based line in that file, when the rule knows it. */
  readonly line?: number;
  /** The surface the finding is about (a skill's name). */
  readonly subject: string;
  /** What is wrong and, for a note, how to cure it — one sentence. */
  readonly message: string;
}

/**
 * What a rule module reads off a scan — the part of the loaded harness that
 * migrated rules need, typed HERE so a rule module never imports the app's
 * `ScanReport` (`boundaries` refuses rule → app, type imports included). It
 * grows as rules migrate (vigiles#390), only ever by what the loaded plugin
 * already carries, never by a field named after one rule.
 */
export interface ScanInput {
  readonly skills: readonly {
    readonly name: string;
    /** Repo-relative path of the SKILL.md. */
    readonly path: string;
    /** Every bundled-resource reference in its body that is not beside it. */
    readonly resourceIssues: readonly SkillResourceFinding[];
  }[];
}

/**
 * A lint rule, declared — the ESLint `meta` pattern, one module per rule.
 * Unmigrated rules are rows of this shape in `src/rules/index.ts` (no
 * `findings`); a migrated rule is `src/rules/<id>.ts` and declares how its
 * findings read.
 */
export interface RuleSpec {
  /** The rule's id: its key in `.vigilesrc.json#rules` and its doc's file name. */
  readonly id: string;
  /**
   * The rule's GROUP — a key of the group record the root hands in
   * (`src/rules/groups.ts`). Membership is this field; every list of a group's
   * rules is derived from it.
   */
  readonly group: string;
  /** The decidability class → the rule's strongest possible ceiling. */
  readonly bucket: RuleBucket;
  /** The artifact surface(s) the rule reads (non-empty). */
  readonly surface: readonly RuleSurface[];
  /** Where the rule sits by default today (≤ the bucket's ceiling). */
  readonly defaultSeverity: RuleDefaultSeverity;
  /** One-line "what it checks" (tracks the docs matrix row). */
  readonly summary: string;
  /** The shared pure detector function (one-detector-no-drift traceability). */
  readonly detector: string;
  /**
   * The upstream construct that makes this SAME defect impossible for authors
   * who route through it — a TYPE (structural-closed) or a COMPILE cross-ref.
   */
  readonly upstreamPrevention?: string;
  /** What fixes a finding. */
  readonly cure: RuleCure;
  /**
   * The schema of the rule's options, when it takes any: the config then
   * accepts `["warn" | "error", options]` beside a bare severity.
   */
  readonly options?: z.ZodType;
  /**
   * A migrated rule's findings, read off the scan (`ScanInput`) and phrased
   * the way every surface prints them. `applyRules` calls it for a rule that is
   * on; `lint` counts what it returns at each finding's own severity.
   */
  readonly findings?: (scan: ScanInput) => readonly Finding[];
  /**
   * For a rule not yet migrated to a module: the scan field its findings sit
   * in, so `applyRules` can blank them when the rule is off. Only a field that
   * is shown and never scored is declared (see `./apply-rules.ts`).
   */
  readonly legacy?: { readonly scanField: string };
}

/**
 * A rule GROUP — keyed by confidence, so membership says how far a rule may be
 * trusted. The concrete record is outer-layer data (`src/rules/groups.ts`);
 * core reads only these fields.
 */
export interface RuleGroupSpec {
  /**
   * Whether the group's findings may move the audit score. An ungraded group's
   * findings are shown apart and never summed.
   */
  readonly graded: boolean;
  /** How a report heads the group's block. */
  readonly label: string;
  /** One line under the label, when the label alone does not say enough. */
  readonly blurb?: string;
  /**
   * The preset that turns the group up, and the severity it sets. A preset is
   * a name `.vigilesrc.json#extends` and `--preset=` accept.
   */
  readonly preset?: {
    readonly name: `${string}:${string}`;
    readonly severity: "error" | "warn";
  };
  /**
   * What `vigiles init` does with the group: `"extends"` — writes its preset
   * into `extends` (the group a fresh repo gates on); `"--strict"` — writes its
   * rules at `error` only under that flag. Absent: `init` writes nothing.
   */
  readonly init?: "extends" | "--strict";
}

/** A group record, as the root hands it in. */
export type RuleGroups = Readonly<Record<string, RuleGroupSpec>>;

/**
 * Declare a rule, keeping its literal types (the id, the options schema) so the
 * set's precise config type can be derived from it.
 */
export function defineRule<const S extends RuleSpec>(spec: S): S {
  return spec;
}

/** The ids of a rule set, as a union. */
export type RuleIdOf<R extends readonly RuleSpec[]> = R[number]["id"];

/** A rule's shipped default, as the config spells it (`false` for off). */
export function configDefault(rule: RuleSpec): "warn" | "error" | false {
  return rule.defaultSeverity === "off" ? false : rule.defaultSeverity;
}

/** Every rule's shipped default, keyed by id. */
export function defaultSeverities(
  rules: readonly RuleSpec[],
): Readonly<Record<string, "warn" | "error" | false>> {
  return Object.fromEntries(rules.map((r) => [r.id, configDefault(r)]));
}

/**
 * What `vigiles init` writes, derived from the groups' `init` fields — so
 * `init` follows the group record instead of carrying its own lists.
 */
export interface InitPolicy {
  /** The preset `init` writes into `extends`. */
  readonly preset: string;
  /** Every preset name, so `init` can read an existing `extends`. */
  readonly presets: readonly string[];
  /**
   * The rules that preset RAISES (its rules whose default is not already the
   * preset's severity) — what `--report-only` writes at `warn` instead.
   */
  readonly presetRules: readonly string[];
  /**
   * The rules `init --strict` writes at `error`: the `--strict` groups' rules
   * that are ON by default. An opt-in rule (off by default, e.g. one that does
   * nothing without its options) stays opt-in.
   */
  readonly strictRules: readonly string[];
}

/** {@link InitPolicy} from a rule set and its groups. */
export function initPolicyOf(
  rules: readonly RuleSpec[],
  groups: RuleGroups,
): InitPolicy {
  const extended = Object.values(groups).find((g) => g.init === "extends");
  const inGroup = (init: RuleGroupSpec["init"]) =>
    rules.filter((r) => groups[r.group]?.init === init);
  return {
    preset: extended?.preset?.name ?? "",
    presets: Object.values(groups).flatMap((g) =>
      g.preset ? [g.preset.name] : [],
    ),
    presetRules: inGroup("extends")
      .filter((r) => r.defaultSeverity !== extended?.preset?.severity)
      .map((r) => r.id),
    strictRules: inGroup("--strict")
      .filter((r) => r.defaultSeverity !== "off")
      .map((r) => r.id),
  };
}
