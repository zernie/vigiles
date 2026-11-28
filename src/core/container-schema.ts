/**
 * The schema of a container env's settings (`env: { kind: "docker" }`,
 * vigiles#599): an ALLOWLIST of the {@link ContainerOptions} fields, which
 * cannot break the containment that stops every process an attempt started.
 * Any other field is refused by name, saying why, because an eval file is
 * often plain JavaScript and nothing else would catch it. Read by the `env`
 * parse in `./run-env-parse.ts`; pure.
 */
import { z } from "zod";

import type { ContainerOptions } from "./container.js";

/** A plain object (not an array), readable by key. */
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const count = z.number().positive();
const intLimit = z.number().int();
const nonEmptyText = z.string().min(1).optional();

// One field per `ContainerOptions` key, no more and no fewer (`satisfies`), so
// the schema and the type the container adapter reads cannot drift apart
// without a tsc error.
export const containerOptionFields = {
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
  "home",
  ...Object.keys(containerOptionFields),
];

/** The first key of a container env that is neither `kind`, `home` nor an allowlisted option. */
export function foreignContainerKey(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.kind !== "docker") return undefined;
  return Object.keys(raw).find((k) => !ALLOWED_CONTAINER_KEYS.includes(k));
}

export function foreignKeyMessage(caller: string, key: string): string {
  return (
    `${caller}: env.${key}: not a container option — it would break the containment ` +
    `that stops every process an attempt started (a reused or kept container, an extra env, mount, ` +
    `user, command or privilege lets one outlive the attempt or reach the host). ` +
    `The options are: ${Object.keys(containerOptionFields).join(", ")}.`
  );
}
