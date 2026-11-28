/**
 * The eval spec boundary for `execution` (vigiles#599) — parsed ONCE, before
 * anything is packaged or spent, into the {@link Execution} the runner trusts.
 *
 * A container's settings are an ALLOWLIST: only the {@link ContainerOptions}
 * fields, which cannot break the containment that stops every process an
 * attempt started. Any other field is refused by name, saying why, because an
 * eval file is often plain JavaScript and nothing else would catch it.
 */
import { z } from "zod";

import type { ContainerOptions, Execution } from "./container.js";
import { isObj, refuse } from "./eval-spec-parse.js";
import type { RunEnv } from "./run-env.js";

/**
 * What a spec's `execution` may say: the host (the default), or a container
 * with the settings that cannot break its containment.
 *
 * @public
 */
export type ExecutionSpec =
  | { readonly kind: "host" }
  | ({ readonly kind: "container" } & ContainerOptions);

const count = z.number().positive();
const intLimit = z.number().int();
const nonEmptyText = z.string().min(1).optional();

// One field per `ContainerOptions` key, no more and no fewer (`satisfies`), and
// the parse's output typed by `Execution`, so the schema and the type the
// container adapter reads cannot drift apart without a tsc error.
const containerOptionFields = {
  image: nonEmptyText,
  platform: nonEmptyText,
  pullPolicy: z.enum(["default", "always"]).optional(),
  networkMode: nonEmptyText,
  resourcesQuota: z
    .strictObject({ memory: count.optional(), cpu: count.optional() })
    .optional(),
  sharedMemorySize: z.number().int().positive().optional(),
  ulimits: z
    .record(
      z.string(),
      z.strictObject({ hard: intLimit.optional(), soft: intLimit.optional() }),
    )
    .optional(),
  extraHosts: z
    .array(z.strictObject({ host: z.string().min(1), ipAddress: z.string() }))
    .optional(),
  tmpFs: z.record(z.string(), z.string()).optional(),
  droppedCapabilities: z.array(z.string().min(1)).optional(),
} satisfies Record<keyof ContainerOptions, z.ZodType>;

const ALLOWED_CONTAINER_KEYS: readonly string[] = [
  "kind",
  ...Object.keys(containerOptionFields),
];

/** The first key of a container `execution` that is not an allowlisted option. */
function foreignContainerKey(raw: unknown): string | undefined {
  if (!isObj(raw) || raw.kind !== "container") return undefined;
  return Object.keys(raw).find((k) => !ALLOWED_CONTAINER_KEYS.includes(k));
}

function foreignKeyMessage(caller: string, key: string): string {
  return (
    `${caller}: execution.${key}: not a container option — it would break the containment ` +
    `that stops every process an attempt started (a reused or kept container, an extra env, mount, ` +
    `user, command or privilege lets one outlive the attempt or reach the host). ` +
    `The options are: ${Object.keys(containerOptionFields).join(", ")}.`
  );
}

function inheritedEnvMessage(caller: string): string {
  return (
    `${caller}: execution: { kind: "container" } needs env: { kind: "ephemeral" } — a container ` +
    `gets a complete environment and a throwaway HOME mounted in; an inherited env is your ` +
    `machine's, which is what the container keeps out.`
  );
}

const executionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host") }),
  z
    .strictObject({ kind: z.literal("container"), ...containerOptionFields })
    .transform(({ kind, ...options }): Execution => ({ kind, options })),
]);

/**
 * Parse an eval spec's `execution`. Absent → the host. A container needs an
 * ephemeral `env` (a container runs with a complete env and a throwaway HOME;
 * an inherited one would be the host's), and takes only the
 * {@link ContainerOptions} fields. Throws, naming the field, before any trial.
 */
export function parseExecution(
  raw: unknown,
  caller: string,
  env: RunEnv,
): Execution {
  if (raw === undefined) return { kind: "host" };
  const foreign = foreignContainerKey(raw);
  if (foreign !== undefined)
    throw new Error(foreignKeyMessage(caller, foreign));
  const parsed = executionSchema.safeParse(raw);
  if (!parsed.success) refuse(caller, "execution", parsed.error);
  if (parsed.data.kind === "container" && env.kind !== "ephemeral")
    throw new Error(inheritedEnvMessage(caller));
  return parsed.data;
}
