/**
 * vigiles — the LinterAdapter port.
 *
 * A "linter" was smeared across parallel registries (existence checks, config
 * checkers, a tool map, a suggestion enumerator, generate-types discoverers)
 * with nothing enforcing completeness — so adding one meant editing ~7 sites in
 * lockstep, and a missed site failed silently. This port makes a linter ONE
 * cohesive, type-enforced unit: the concrete `LINTERS` registry (in
 * `linters.ts`) is a `Record<BuiltinLinter, LinterAdapter>`, so a missing linter
 * or capability is a tsc error, and `linter-contract.test.ts` covers the
 * docs/prose parity a type can't see. Mirrors the `HarnessAdapter`/rule-set
 * patterns already used in the repo. See `research/linter-adapter-architecture.md`.
 *
 * This module is a TYPE-ONLY LEAF: it imports only a type from `spec.ts` (the
 * zero-import authoring surface), and owns the two shared domain types
 * (`ConfigEnabledStatus`, `DiscoveredRules`) so `linters.ts` and
 * `generate-types.ts` both depend on it without a cycle.
 */
import type { BuiltinLinter } from "./spec.js";

/**
 * The config-enabled state of a linter rule in a project.
 *
 * `unconfigured` and `unknown` are different facts and must not share a word:
 * `unconfigured` = the WHOLE config was read and no block sets the rule (ESLint
 * treats that as off); `unknown` = vigiles could not read it, or read only part
 * of it. Only a linter that can see every block of its config returns
 * `unconfigured` (today: ESLint flat config); the rest keep `unknown`.
 */
export type ConfigEnabledStatus =
  | "enabled"
  | "disabled"
  | "unconfigured"
  | "unknown";

/** A linter's enabled rules discovered from project config, for generate-types. */
export interface DiscoveredRules {
  linter: string;
  rules: string[];
  via: string;
}

/**
 * What asking a linter for its enabled rules produced. `none` (the linter is not
 * set up here, or switches nothing on) and `unreadable` (it is set up, and its
 * config could not be read) are different facts: the second is a problem the
 * user has to hear about, never an empty list.
 */
export type Discovery =
  | { readonly kind: "found"; readonly rules: DiscoveredRules }
  | { readonly kind: "none" }
  | {
      readonly kind: "unreadable";
      readonly linter: string;
      readonly reason: string;
    };

/**
 * A linter's capabilities — the variance that used to be IMPLICIT in which map
 * had an entry, now DECLARED (mirrors `AdapterCapabilities`). The conformance
 * test cross-checks each flag against the presence of its method.
 */
export interface LinterCapabilities {
  /**
   * How rule existence is verified:
   * - `node-api`: resolved from an installed package (eslint/stylelint).
   * - `cli`: a real command asks the tool (ruff/clippy/pylint/rubocop/detekt/…).
   * - `filesystem`: presence in a file counts (cedar).
   * - `format-only`: only the reference shape is validated, no tool (ktlint).
   */
  existenceCheck: "node-api" | "cli" | "filesystem" | "format-only";
  /** Has a real config-enabled read (`configEnabled` present). */
  configCheck: boolean;
  /** Can enumerate its rules for did-you-mean suggestions (`enumerateRules`). */
  catalogEnumeration: boolean;
  /** A found rule/policy counts as enabled with no separate config (cedar). */
  alwaysEnabled: boolean;
  /** Emits an `<Linter>Rule` .d.ts union via `discoverEnabled`. */
  generateTypes: boolean;
}

/**
 * One linter, bundled. The methods are optional per the capability flags — the
 * conformance test enforces `capabilities.X === (method !== undefined)`.
 */
export interface LinterAdapter {
  /** Matches the `LINTERS` key it is registered under (checked by conformance). */
  name: BuiltinLinter;
  capabilities: LinterCapabilities;
  /** The PATH tool for a `cli` linter (absent for node-api/filesystem/format-only). */
  cliTool?: string;
  /**
   * Verify a rule exists. A `cli` linter THROWS (with a user-facing message)
   * when the rule is unknown and otherwise returns `true`; node-api/filesystem
   * linters return a boolean. The dispatch treats both a `false` return and a
   * throw as "not found" (a throw additionally carries the tool's own message).
   * The optional `customDirs` threads a linter's configured rule directories
   * (cedar's `rulesDir`).
   */
  checkExists(
    rule: string,
    basePath: string,
    customDirs?: string | readonly string[],
  ): boolean;
  /** Config-enabled status; absent when `alwaysEnabled` or no config layer. */
  configEnabled?(rule: string, basePath: string): ConfigEnabledStatus;
  /** All known rule names, for closest-match suggestions; absent when unlistable. */
  enumerateRules?(basePath: string): Set<string>;
  /** Enabled rules discovered from project config, for generate-types. */
  discoverEnabled?(basePath: string): Discovery;
}
