/**
 * The eval spec boundary for `stubs` and `env` — parsed ONCE, before anything is
 * packaged or spent, into the plain data the runner then trusts.
 *
 * An eval file is often plain JavaScript, so no type checks its literal. A shape
 * the runner would silently mis-read must fail here, naming the field and the
 * rewrite. Two such shapes are the reason this module exists:
 *
 * - the old argv-blind stub `{ name, stdout }`, which printed one answer for
 *   every invocation (a fabricated observation for every command nobody
 *   anticipated);
 * - a spec with no `env`, which used to inherit your HOME and environment by
 *   default — so a comparison measured the author's machine.
 *
 * zod lives HERE and not in `stub-rules.ts`: the stub process reads its rules
 * once per `gh` call and must not pay for a schema library; the rules file it
 * reads is this parse's output, written by vigiles.
 */
import { z } from "zod";

import {
  ARGV_REST,
  toToolStub,
  type ArgvRest,
  type ToolStub,
} from "./stub-rules.js";
import { planHome, type RunEnv } from "./run-env.js";

/** `stubs[0].rules[1].argv` from a zod issue path. */
function pathText(root: string, path: readonly PropertyKey[]): string {
  return path.reduce(
    (acc: string, k) =>
      typeof k === "number" ? `${acc}[${String(k)}]` : `${acc}.${String(k)}`,
    root,
  );
}

function refuse(
  caller: string,
  root: string,
  error: Readonly<z.ZodError>,
): never {
  const lines = error.issues.map(
    (i) => `${caller}: ${pathText(root, i.path)}: ${i.message}`,
  );
  throw new Error(lines.join("\n"));
}

// --- stubs ---------------------------------------------------------------------

const regexToken = z.instanceof(RegExp).refine((r) => !r.global && !r.sticky, {
  message:
    "a RegExp token may not carry the flags g and y — test() would carry lastIndex from one call to the next",
});
const token = z.union([z.string(), regexToken]);
const restToken = z
  .strictObject({ kind: z.literal("rest") })
  .transform((): ArgvRest => ARGV_REST);
/** A plain object (not an array, not a RegExp), readable by key. */
const isObj = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof RegExp);
const isRestToken = (t: unknown): boolean => isObj(t) && t.kind === "rest";

const argvPattern = z
  .array(z.union([token, restToken]))
  .refine((p) => p.slice(0, -1).every((t) => !isRestToken(t)), {
    message: "experimental_stub.rest may appear only as the last token",
  });

const answerFields = {
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
};
const reply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("always"), ...answerFields }),
  z.strictObject({
    kind: z.literal("inOrder"),
    answers: z
      .array(z.strictObject(answerFields))
      .min(1, { message: "an inOrder reply needs at least one answer" }),
  }),
]);

const rule = z
  .strictObject({
    argv: argvPattern,
    contains: z.array(token).optional(),
    reply,
  })
  .refine((r) => r.contains === undefined || isRestToken(r.argv.at(-1)), {
    message:
      "`contains` matches tokens after the positional prefix, so it needs a trailing experimental_stub.rest in `argv`",
    path: ["contains"],
  });

const stub = z.strictObject({
  name: z
    .string()
    .min(1)
    .refine((n) => !/[/\\]/.test(n) && n !== "." && n !== "..", {
      message:
        "a bare binary name, as it is looked up on PATH (no path separator)",
    }),
  rules: z.array(rule).min(1, {
    message: "a stub needs at least one rule — one per command the agent runs",
  }),
});

/** Is this the removed `{ name, stdout?, stderr?, exitCode? }` shape? */
const isOldShape = (s: unknown): s is Readonly<Record<string, unknown>> =>
  isObj(s) &&
  !("rules" in s) &&
  ["stdout", "stderr", "exitCode"].some((k) => k in s);

function oldShapeMessage(
  caller: string,
  i: number,
  s: Readonly<Record<string, unknown>>,
): string {
  const name = typeof s.name === "string" ? s.name : "<tool>";
  const stdout =
    typeof s.stdout === "string" ? JSON.stringify(s.stdout) : '"…"';
  return (
    `${caller}: stubs[${String(i)}] (${JSON.stringify(name)}) is the old shape \`{ name, stdout }\`, which printed one answer for EVERY invocation — ` +
    `a command nobody scripted got that answer as if the tool had said it. A stub is now a list of rules, one per command the agent runs:\n` +
    `    experimental_stub(${JSON.stringify(name)}, [\n` +
    `      { argv: ["<command>", experimental_stub.rest], reply: { kind: "always", stdout: ${stdout} } },\n` +
    `      // one rule per further command; an invocation no rule answers fails the run\n` +
    `    ])\n` +
    `  The argv a run used is printed when it goes unanswered, so the first run tells you which rules to add.`
  );
}

/**
 * Parse an eval spec's `stubs`. Absent → `[]`. Throws, naming the field, on the
 * old shape, a malformed rule, a stateful RegExp, or two stubs of one name.
 */
export function parseToolStubs(
  raw: unknown,
  caller: string,
): readonly ToolStub[] {
  if (raw === undefined) return [];
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const old = items.findIndex(isOldShape);
  const oldItem = items[old];
  if (isOldShape(oldItem))
    throw new Error(oldShapeMessage(caller, old, oldItem));
  const parsed = z.array(stub).safeParse(raw);
  if (!parsed.success) refuse(caller, "stubs", parsed.error);
  const names = parsed.data.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined)
    throw new Error(
      `${caller}: two stubs named ${JSON.stringify(dup)} — one binary has one stub; put both rule lists in it.`,
    );
  // The zod output has the shape; `toToolStub` gives it the type, without a cast.
  return parsed.data.map(toToolStub);
}

// --- env -----------------------------------------------------------------------

const homeSeed = z.strictObject({
  kind: z.literal("files"),
  files: z.record(z.string(), z.string()),
});
const runEnv = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ephemeral"), home: homeSeed.optional() }),
  z.strictObject({
    kind: z.literal("inherit"),
    reason: z.string().refine((r) => r.trim() !== "", {
      message: "say why this run must see your real HOME and environment",
    }),
  }),
]);

function envRequiredMessage(caller: string): string {
  return (
    `${caller}: \`env\` is required — say where each trial runs:\n` +
    `    env: { kind: "ephemeral" }               a throwaway HOME and a scrubbed environment; only the harness's own auth passes\n` +
    `    env: { kind: "inherit", reason: "…" }    your real HOME and environment; the reason is printed with the report\n` +
    `  There is no default. Inheriting measures your machine (your config, your tokens), and an ephemeral run\n` +
    `  fails on its first trial if your auth is not where the harness expects it — so the choice is yours to make.`
  );
}

/**
 * Parse an eval spec's `env`, including its seeded HOME: every seed path is
 * HOME-relative, stays inside HOME, and does not overwrite one of the harness's
 * own auth files (`keepHomeFiles`). Throws before any trial on a bad value.
 */
export function parseRunEnv(
  raw: unknown,
  caller: string,
  keepHomeFiles: readonly string[],
): RunEnv {
  if (raw === undefined) throw new Error(envRequiredMessage(caller));
  if (isObj(raw) && raw.kind === "inherit" && "home" in raw)
    throw new Error(
      `${caller}: env.home: \`home\` exists only on an ephemeral env: seeding would write into your real HOME. ` +
        `Use env: { kind: "ephemeral", home: … }.`,
    );
  const parsed = runEnv.safeParse(raw);
  if (!parsed.success) refuse(caller, "env", parsed.error);
  const env = parsed.data;
  if (env.kind === "ephemeral" && env.home !== undefined) {
    const plan = planHome(env.home, keepHomeFiles);
    if (plan.kind === "refused")
      throw new Error(`${caller}: env.home.files: ${plan.reason}`);
  }
  return env;
}
