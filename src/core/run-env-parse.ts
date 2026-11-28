/**
 * The eval spec boundary for `env` — parsed ONCE, before any trial, into a
 * {@link NormalizedRunEnv}. The deprecated `inherit`/`ephemeral` spellings are
 * turned into their `local` forms here, with one warning naming the new
 * spelling, so no code past this point can branch on them.
 *
 * An eval file is often plain JavaScript, so no type checks its literal. A
 * spec with no `env` (which used to inherit your HOME and environment by
 * default), a seed on your real HOME, a field on the wrong kind and a container
 * setting outside the allowlist (`./container-schema.ts`) are each refused
 * naming the field and the rewrite. Pure.
 */
import { z } from "zod";

import {
  containerOptionFields,
  foreignContainerKey,
  foreignKeyMessage,
} from "./container-schema.js";
import { refuse } from "./eval-spec-parse.js";
import {
  normalizeRunEnv,
  planHome,
  runHome,
  type NormalizedRunEnv,
  type RunEnv,
} from "./run-env.js";

const LOCAL_ALL = 'env: { kind: "local", inherit: "all", reason: "…" }';
const LOCAL_NONE = 'env: { kind: "local", inherit: "none" }';
const DOCKER = 'env: { kind: "docker" }';

const homeSeed = z.strictObject({
  kind: z.literal("files"),
  files: z.record(z.string(), z.string()),
});
const reason = z.string().refine((r) => r.trim() !== "", {
  message: "say why this run must see your real HOME and environment",
});
const runEnv = z.discriminatedUnion("kind", [
  z.discriminatedUnion("inherit", [
    z.strictObject({
      kind: z.literal("local"),
      inherit: z.literal("all"),
      reason,
    }),
    z.strictObject({
      kind: z.literal("local"),
      inherit: z.literal("none"),
      home: homeSeed.optional(),
    }),
  ]),
  z.strictObject({
    kind: z.literal("docker"),
    home: homeSeed.optional(),
    ...containerOptionFields,
  }),
  z.strictObject({ kind: z.literal("inherit"), reason }),
  z.strictObject({ kind: z.literal("ephemeral"), home: homeSeed.optional() }),
]);

function envRequiredMessage(caller: string): string {
  return (
    `${caller}: \`env\` is required — say where each trial runs:\n` +
    `    ${LOCAL_ALL}    your real HOME and environment; the reason is printed with the report\n` +
    `    ${LOCAL_NONE}                 a throwaway HOME and a scrubbed environment; only the harness's own auth passes\n` +
    `    ${DOCKER}                                 the same throwaway HOME, in a fresh container per attempt (needs Docker)\n` +
    `  There is no default. Inheriting measures your machine (your config, your tokens), and a throwaway HOME\n` +
    `  fails on its first trial if your auth is not where the harness expects it — so the choice is yours to make.`
  );
}

type Raw = Readonly<Record<string, unknown>>;

/** A plain object (not an array), readable by key. */
const isRecord = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLocal = (raw: Raw, inherit: "all" | "none"): boolean =>
  raw.kind === "local" && raw.inherit === inherit;

/**
 * The combinations refused with their own rewrite before the schema reads
 * them, each naming its field. In order: the docker rule must win over the
 * container allowlist, which would call `inherit` a container option.
 */
const SHAPE_RULES: readonly {
  readonly applies: (raw: Raw) => boolean;
  readonly message: string;
}[] = [
  {
    applies: (raw) =>
      (raw.kind === "inherit" || isLocal(raw, "all")) && "home" in raw,
    message:
      "env.home: `home` exists only on a throwaway HOME: seeding would write into your real HOME. " +
      'Use env: { kind: "local", inherit: "none", home: … } or env: { kind: "docker", home: … }.',
  },
  {
    applies: (raw) => isLocal(raw, "none") && "reason" in raw,
    message:
      'env.reason: `reason` exists only on inherit: "all", where the run sees your real HOME; a throwaway HOME needs none. ' +
      `Drop it, or use ${LOCAL_ALL}.`,
  },
  {
    applies: (raw) => raw.kind === "docker" && "inherit" in raw,
    message:
      "env.inherit: a docker run always starts from a throwaway HOME and a scrubbed environment, so it takes no `inherit`. " +
      `Drop it, or use ${LOCAL_ALL} to run on your real HOME.`,
  },
  {
    applies: (raw) => raw.kind === "local" && !("inherit" in raw),
    message:
      `env.inherit: a local run says what it inherits: ${LOCAL_NONE} (a throwaway HOME) ` +
      `or ${LOCAL_ALL} (your real HOME and environment).`,
  },
];

function shapeRefusal(raw: unknown, caller: string): string | undefined {
  if (!isRecord(raw)) return undefined;
  const rule = SHAPE_RULES.find((r) => r.applies(raw));
  if (rule !== undefined) return `${caller}: ${rule.message}`;
  const foreign = foreignContainerKey(raw);
  return foreign === undefined ? undefined : foreignKeyMessage(caller, foreign);
}

/** Why a throwaway HOME's seed is refused, or undefined when it is fine or there is none. */
function seedRefusal(
  env: NormalizedRunEnv,
  caller: string,
  keepHomeFiles: readonly string[],
): string | undefined {
  const home = runHome(env);
  if (home.kind === "real") return undefined;
  const plan = planHome(home.seed, keepHomeFiles);
  return plan.kind === "refused"
    ? `${caller}: env.home.files: ${plan.reason}`
    : undefined;
}

/** The warning a deprecated spelling prints, naming the new one; undefined for a current one. */
function deprecationOf(env: RunEnv, caller: string): string | undefined {
  switch (env.kind) {
    case "inherit":
      return `${caller}: env: { kind: "inherit" } is deprecated — write ${LOCAL_ALL}. The run and its lock stay the same.`;
    case "ephemeral":
      return `${caller}: env: { kind: "ephemeral" } is deprecated — write ${LOCAL_NONE} (a \`home\` stays as it is). The run and its lock stay the same.`;
    case "local":
    case "docker":
      return undefined;
  }
}

/** A parsed `env`: its current spelling, and the warning to print once when the spec used an old one. */
export interface ParsedRunEnv {
  readonly env: NormalizedRunEnv;
  /** The kind the spec wrote, so a report echoes an old spelling as it was written. */
  readonly written: RunEnv["kind"];
  readonly deprecation: string | undefined;
}

/**
 * Parse an eval spec's `env`, including its seeded HOME: every seed path is
 * HOME-relative, stays inside HOME, and does not overwrite one of the harness's
 * own auth files (`keepHomeFiles`). A container env takes only the
 * `ContainerOptions` fields. Throws before any trial on a bad value, naming
 * the field.
 */
export function parseRunEnv(
  raw: unknown,
  caller: string,
  keepHomeFiles: readonly string[],
): ParsedRunEnv {
  if (raw === undefined) throw new Error(envRequiredMessage(caller));
  const shape = shapeRefusal(raw, caller);
  if (shape !== undefined) throw new Error(shape);
  const parsed = runEnv.safeParse(raw);
  if (!parsed.success) refuse(caller, "env", parsed.error);
  const env = normalizeRunEnv(parsed.data);
  const seed = seedRefusal(env, caller, keepHomeFiles);
  if (seed !== undefined) throw new Error(seed);
  return {
    env,
    written: parsed.data.kind,
    deprecation: deprecationOf(parsed.data, caller),
  };
}
