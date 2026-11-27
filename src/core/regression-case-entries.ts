/**
 * The `experimental_regressionCases` key of an eval spec (vigiles#416), parsed
 * once at the boundary: each entry is a {@link RegressionCaseSpec} plus the
 * `id` that names it in the report and in refusals. Pure: no file is read,
 * nothing runs. A malformed entry is refused with a path-named line before
 * `skipIf` and before any trial.
 */
import { z } from "zod";
import type { RegressionCaseSpec } from "./regression-case.js";

/**
 * One regression case of an eval: a fix commit of your own repository, the
 * world it is measured in, and how a trial is scored.
 *
 * @experimental
 * @public
 */
export type RegressionCaseEntry = RegressionCaseSpec & {
  /** Names the case in the report and in refusals: `[a-z0-9][a-z0-9-]*`, unique in the array. */
  readonly id: string;
};

/** Why an eval spec is refused before anything runs: its shape, not the machine. */
export class EvalSpecRefusalError extends Error {
  override readonly name = "EvalSpecRefusalError";
}

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

const nonEmpty = z.string().refine((s) => s.trim() !== "", {
  message: "must not be empty",
});
const sha = z.string().regex(SHA, { message: "must be a full 40-hex SHA" });
const argv = z.array(nonEmpty).min(1, { message: "must not be empty" });
const paths = z.array(nonEmpty).readonly();

const entry: Readonly<z.ZodType<RegressionCaseEntry>> = z.strictObject({
  id: z.string().regex(ID, { message: "must match [a-z0-9][a-z0-9-]*" }),
  repo: nonEmpty,
  commit: sha,
  head: sha,
  tests: z.strictObject({
    run: z.array(nonEmpty).min(1, { message: "must not be empty" }),
    data: paths,
  }),
  testCommand: argv,
  build: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("command"), argv }),
    z.strictObject({ kind: z.literal("none"), reason: nonEmpty }),
  ]),
  deps: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("node-modules"),
      roots: z.array(nonEmpty).min(1).readonly().optional(),
    }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
  symptom: z.strictObject({ kind: z.literal("file"), path: nonEmpty }),
  source: paths.optional(),
  hide: paths.optional(),
  runs: z.int().min(1).optional(),
  scoringTimeoutMs: z.int().min(1).optional(),
});

const entries = z
  .array(entry)
  .min(1, { message: "must hold at least one case" })
  .superRefine((list, ctx) => {
    list
      .filter((e, i) => list.findIndex((o) => o.id === e.id) !== i)
      .forEach((e) => {
        ctx.addIssue({
          code: "custom",
          path: [list.lastIndexOf(e), "id"],
          message: `repeats the id "${e.id}"; each case needs its own`,
        });
      });
  });

/** `[0].tests.run` from a zod issue path. */
const pathText = (path: readonly PropertyKey[]): string =>
  path
    .map((k) => (typeof k === "number" ? `[${String(k)}]` : `.${String(k)}`))
    .join("");

/**
 * `experimental_regressionCases`, or undefined when the spec sets none.
 * Throws an {@link EvalSpecRefusalError} naming each malformed field.
 */
export function parseRegressionCases(
  raw: unknown,
): readonly RegressionCaseEntry[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = entries.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new EvalSpecRefusalError(
    parsed.error.issues
      .map(
        (i) => `experimental_regressionCases${pathText(i.path)}: ${i.message}`,
      )
      .join("\n"),
  );
}

/** The roots whose lockfiles key a case's installs: `deps.roots`, default `["."]`. */
export function depsRoots(spec: RegressionCaseSpec): readonly string[] {
  return spec.deps.kind === "none" ? [] : (spec.deps.roots ?? ["."]);
}
