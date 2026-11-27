/**
 * Type-level constraint: the public `EvalSpec` and the runtime schema that
 * refuses a malformed spec (`EVAL_SHAPE`, `src/eval-spec-shape.ts`) describe the
 * SAME arms and scoring fields — both exactly-one choices included.
 *
 * `EvalSpec` stays hand-written because it is generic in `M` and Zod infers no
 * generics; this equality is what stops it and the schema from drifting into
 * two rules — a `.mjs` caller refused for a spec TypeScript accepts, or the
 * reverse. Compiled with `tsc --noEmit` (npm run test:types); nothing runs.
 */
import type { z } from "zod";
import type { EvalSpec } from "../../dist/entries/index.js";
import type { EVAL_SHAPE } from "../../dist/eval-spec-shape.js";

/** The fields the schema decides; every other field of a spec passes through. */
type ShapeKey =
  | "arms"
  | "settings"
  | "plugin"
  | "pluginDir"
  | "skillsDir"
  | "interceptTools"
  | "checks"
  | "measure"
  | "stubSkillBodies"
  | "task"
  | "experimental_regressionCases";

/** Each union member cut to the shape fields, flattened and read-only. */
type ShapeOf<T> = T extends unknown
  ? { readonly [K in keyof Pick<T, Extract<keyof T, ShapeKey>>]: T[K] }
  : never;

/** Exact type identity — not mutual assignability, which an optional field passes. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type FromType = ShapeOf<EvalSpec>;
type FromSchema = ShapeOf<z.input<typeof EVAL_SHAPE>>;

export const bound: Equals<FromType, FromSchema> = true;
