/**
 * Type-level constraint: the shapes `experimental_regressionCases` speaks are
 * reachable from the root `vigiles` entry, and they are the ones `EvalSpec`
 * and `EvalReport` use. A type-only export is no runtime key, so the
 * ship-check's import cannot see it; this compile can. Compiled with
 * `tsc --noEmit` (npm run test:types); nothing runs.
 */
import type {
  CaseArmResult,
  CaseResult,
  EvalReport,
  EvalSpec,
  RegressionCaseEntry,
  RegressionCaseSpec,
} from "../../dist/entries/index.js";

/** Exact type identity — not mutual assignability, which an optional field passes. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type CasesBranch = Extract<
  EvalSpec,
  { readonly experimental_regressionCases: unknown }
>;

export const entries: Equals<
  CasesBranch["experimental_regressionCases"],
  readonly RegressionCaseEntry[]
> = true;
export const entryIsSpecPlusId: Equals<
  Omit<RegressionCaseEntry, "id">,
  Omit<RegressionCaseSpec, never>
> = true;
export const results: Equals<
  EvalReport["experimental_regressionCases"],
  readonly CaseResult[] | undefined
> = true;
export const arms: Equals<CaseResult["arms"][string], CaseArmResult> = true;
