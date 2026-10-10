/**
 * A tool stub that answers PER INVOCATION — the pure core.
 *
 * A stub shadows a binary on PATH (`gh`, `git`, `psql`) so a run that calls it
 * gets a recorded answer instead of the real service. The earlier stub printed
 * ONE answer for every argv. That is a test double answering by default, and a
 * default answer is a fabricated observation: a stub set up to answer
 * `gh issue create` with an issue URL also answered a script's
 * `gh api repos/o/r/issues?…` with that URL, the script failed to parse it as
 * JSON, and a model that read the stub's source stopped trusting it.
 *
 * So a stub is a non-empty list of RULES over the argv TOKEN ARRAY. Each rule has
 * a positional pattern (an exact string or a RegExp per token, and an explicit
 * trailing `rest` for "any further tokens"), an optional order-free `contains`
 * for flags, and a reply. The first matching rule answers. An argv no rule
 * matches is UNANSWERED: the stub exits non-zero, the call is logged, and the
 * run fails — the same choice `script-overrun.ts` made for a scripted model that
 * runs past its script.
 *
 * Argv is a list, not a line: joining it loses token boundaries (`--title "a b"`
 * is one token), and a RegExp over the joined line matches across them.
 *
 * Everything here is pure and JSON-serialisable, because the same rules are
 * read by the stub process (one per invocation), folded into the eval cache key
 * and the lock, and printed in failure messages. No zod here on purpose: this
 * module is on the stub process's path, which runs once per `gh` call.
 */

import { join } from "node:path";

/** "Any number of further tokens, including none." Only valid as the LAST token. */
export interface ArgvRest {
  readonly kind: "rest";
}

/** The `rest` marker. One frozen value, so a pattern carries no free-form object. */
export const ARGV_REST: ArgvRest = Object.freeze({ kind: "rest" as const });

/** One positional token: exact string, or a RegExp tested against that one token. */
export type ArgvToken = string | Readonly<RegExp>;

/**
 * A positional pattern: token i matches argv token i. Without a trailing
 * {@link ARGV_REST} the argv must have EXACTLY this many tokens, so a read rule
 * `["api", /^repos\//]` does not also answer `api repos/… -f title=x`.
 */
export type ArgvPattern =
  | readonly ArgvToken[]
  | readonly [...ArgvToken[], ArgvRest];

/** What the fake binary does when a rule answers. */
export interface StubAnswer {
  /** Printed to stdout. Default "". */
  readonly stdout?: string;
  /** Printed to stderr. Default none. */
  readonly stderr?: string;
  /** Exit code, 0–255. Default 0. */
  readonly exitCode?: number;
}

/**
 * `always`: every matching call gets the answer. `inOrder`: the k-th matching
 * call gets `answers[k-1]`, and a call past the end is UNANSWERED — repetition
 * is something a rule says, never a default.
 */
export type StubReply =
  | ({ readonly kind: "always" } & StubAnswer)
  | {
      readonly kind: "inOrder";
      readonly answers: readonly [StubAnswer, ...StubAnswer[]];
    };

/** One rule: an argv pattern, optional order-free tokens, and a reply. */
export interface StubRule {
  readonly argv: ArgvPattern;
  /**
   * Tokens that must each match some argv token AFTER the positional prefix, in
   * any order — for flags a model writes in any order (`--repo o/r` or `-R o/r`).
   * Needs a trailing `rest` in `argv` (without it nothing follows the prefix).
   */
  readonly contains?: readonly ArgvToken[];
  readonly reply: StubReply;
}

/** A stub for one binary: its name on PATH and its rules, first match wins. */
export interface ToolStub {
  readonly name: string;
  readonly rules: readonly [StubRule, ...StubRule[]];
}

/**
 * What happened to one invocation. Three cases, because the two ways a call goes
 * unanswered need different fixes: no rule matched (add a rule), or a rule
 * matched but its `inOrder` answers ran out (add an answer).
 */
export type StubOutcome =
  | {
      readonly kind: "answered";
      /** 0-based rule index. */
      readonly rule: number;
      /** 0-based answer index (always 0 for an `always` reply). */
      readonly answer: number;
    }
  | { readonly kind: "no-rule" }
  | { readonly kind: "exhausted"; readonly rule: number };

/** One recorded invocation of a stub. */
export interface StubCall {
  readonly tool: string;
  readonly argv: readonly string[];
  readonly outcome: StubOutcome;
}

const isRest = (t: ArgvToken | ArgvRest): t is ArgvRest =>
  typeof t === "object" && !(t instanceof RegExp);
const isPlainToken = (t: ArgvToken | ArgvRest): t is ArgvToken => !isRest(t);

/** Does one pattern token match one argv token? A RegExp is stateless here: `g`/`y` are refused at parse. */
const tokenMatches = (pattern: ArgvToken, token: string): boolean =>
  typeof pattern === "string" ? pattern === token : pattern.test(token);

/**
 * The positional tokens of a pattern, and whether it ends in `rest`. `rest` can
 * only be last (the type says so; the parse refuses it elsewhere).
 */
function splitPattern(p: ArgvPattern): {
  readonly fixed: readonly ArgvToken[];
  readonly open: boolean;
} {
  const tokens: readonly (ArgvToken | ArgvRest)[] = p;
  const fixed = tokens.filter(isPlainToken);
  return { fixed, open: fixed.length !== tokens.length };
}

/** Does `rule` match `argv`? Positional prefix, then `contains` over the tail. Pure, total. */
export function matchArgv(
  rule: Pick<StubRule, "argv" | "contains">,
  argv: readonly string[],
): boolean {
  const { fixed, open } = splitPattern(rule.argv);
  const lengthOk = open
    ? argv.length >= fixed.length
    : argv.length === fixed.length;
  if (!lengthOk) return false;
  if (!fixed.every((t, i) => tokenMatches(t, argv[i] ?? ""))) return false;
  const tail = argv.slice(fixed.length);
  return (rule.contains ?? []).every((c) =>
    tail.some((t) => tokenMatches(c, t)),
  );
}

/** How many times each rule of `tool` has already answered, from the log so far. */
export function priorAnswers(
  calls: readonly StubCall[],
  tool: string,
): ReadonlyMap<number, number> {
  const rules = calls.flatMap((c) =>
    c.tool === tool && c.outcome.kind === "answered" ? [c.outcome.rule] : [],
  );
  return rules.reduce<ReadonlyMap<number, number>>(
    (m, r) => new Map([...m, [r, (m.get(r) ?? 0) + 1]]),
    new Map(),
  );
}

/** The decision for one invocation: (rules, answers so far, argv) → outcome. Pure, total. */
export function decideInvocation(
  stub: ToolStub,
  prior: ReadonlyMap<number, number>,
  argv: readonly string[],
): StubOutcome {
  const rule = stub.rules.findIndex((r) => matchArgv(r, argv));
  if (rule < 0) return { kind: "no-rule" };
  const reply = stub.rules[rule]?.reply;
  if (reply === undefined || reply.kind === "always")
    return { kind: "answered", rule, answer: 0 };
  const k = prior.get(rule) ?? 0;
  return k < reply.answers.length
    ? { kind: "answered", rule, answer: k }
    : { kind: "exhausted", rule };
}

/** Whether an outcome left the call without an answer. */
export function isUnanswered(o: StubOutcome): boolean {
  return o.kind !== "answered";
}

/** The answer an `answered` outcome refers to; `undefined` for an unanswered one. */
export function answerFor(
  stub: ToolStub,
  o: StubOutcome,
): StubAnswer | undefined {
  if (o.kind !== "answered") return undefined;
  const reply = stub.rules[o.rule]?.reply;
  if (reply === undefined) return undefined;
  return reply.kind === "always" ? reply : reply.answers[o.answer];
}

// --- encoding: the rules file the stub process reads, and the cache/lock key --

type EncodedToken =
  | string
  | { readonly kind: "re"; readonly source: string; readonly flags: string }
  | ArgvRest;

function encodeToken(t: ArgvToken | ArgvRest): EncodedToken {
  if (typeof t === "string") return t;
  if (t instanceof RegExp)
    return { kind: "re", source: t.source, flags: t.flags };
  return { kind: "rest" };
}

/**
 * Serialise a stub to JSON. A RegExp becomes `{kind:"re",source,flags}` —
 * `JSON.stringify(/x/)` is `{}`, which would make two different rules hash the
 * same in the cache key and the lock.
 */
export function encodeStub(stub: ToolStub): string {
  return JSON.stringify({
    name: stub.name,
    rules: stub.rules.map((r) => ({
      argv: r.argv.map(encodeToken),
      ...(r.contains === undefined
        ? {}
        : { contains: r.contains.map(encodeToken) }),
      reply: r.reply,
    })),
  });
}

// --- reading data back: narrowing, never a cast ----------------------------------
//
// Two readers: the stub process (the rules file and the log — vigiles' own
// output, so a bad shape is an internal error) and the spec boundary (after its
// zod parse, to get the typed value without a cast). Neither pays for zod.

function internal(what: string): never {
  throw new Error(
    `vigiles stub: ${what} — an internal error, please report it.`,
  );
}

const isObj = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof RegExp);

const listOf = (v: unknown, what: string): readonly unknown[] =>
  Array.isArray(v) ? v : internal(`${what} is not a list`);

function nonEmpty<T>(xs: readonly T[], what: string): readonly [T, ...T[]] {
  const [first, ...more] = xs;
  return first === undefined ? internal(`${what} is empty`) : [first, ...more];
}

function toToken(v: unknown): ArgvToken | ArgvRest {
  if (typeof v === "string" || v instanceof RegExp) return v;
  if (isObj(v) && v.kind === "rest") return ARGV_REST;
  if (isObj(v) && typeof v.source === "string" && typeof v.flags === "string")
    return new RegExp(v.source, v.flags);
  return internal("a rule token is not a string, a RegExp or rest");
}

function toPattern(v: unknown): ArgvPattern {
  const tokens = listOf(v, "argv").map(toToken);
  const fixed = tokens.filter(isPlainToken);
  const last = tokens.at(-1);
  const open = last !== undefined && isRest(last);
  if (fixed.length !== tokens.length - (open ? 1 : 0))
    return internal("rest is not the last token");
  return open ? [...fixed, ARGV_REST] : fixed;
}

function toAnswer(v: unknown): StubAnswer {
  if (!isObj(v)) return internal("an answer is not an object");
  const { stdout, stderr, exitCode } = v;
  return {
    ...(typeof stdout === "string" ? { stdout } : {}),
    ...(typeof stderr === "string" ? { stderr } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
  };
}

function toReply(v: unknown): StubReply {
  if (!isObj(v)) return internal("a reply is not an object");
  if (v.kind === "always") return { kind: "always", ...toAnswer(v) };
  if (v.kind === "inOrder")
    return {
      kind: "inOrder",
      answers: nonEmpty(listOf(v.answers, "answers").map(toAnswer), "answers"),
    };
  return internal("a reply has an unknown kind");
}

function toRule(v: unknown): StubRule {
  if (!isObj(v)) return internal("a rule is not an object");
  return {
    argv: toPattern(v.argv),
    ...(v.contains === undefined
      ? {}
      : {
          contains: listOf(v.contains, "contains")
            .map(toToken)
            .filter(isPlainToken),
        }),
    reply: toReply(v.reply),
  };
}

/** A typed {@link ToolStub} from a value already known to have its shape. */
export function toToolStub(v: unknown): ToolStub {
  if (!isObj(v) || typeof v.name !== "string")
    return internal("a stub has no name");
  return {
    name: v.name,
    rules: nonEmpty(listOf(v.rules, "rules").map(toRule), "rules"),
  };
}

/**
 * Read back what {@link encodeStub} wrote. The input is vigiles' own output,
 * written after the spec was parsed, so a bad shape is an internal error.
 */
export function decodeStub(json: string): ToolStub {
  return toToolStub(JSON.parse(json));
}

// --- the invocation log --------------------------------------------------------

/** One log line for one call (no trailing newline). */
export function stubLogLine(call: StubCall): string {
  return JSON.stringify(call);
}

function toOutcome(v: unknown): StubOutcome {
  if (!isObj(v)) return internal("a log outcome is not an object");
  const { kind, rule, answer } = v;
  if (kind === "no-rule") return { kind };
  if (kind === "exhausted" && typeof rule === "number") return { kind, rule };
  if (
    kind === "answered" &&
    typeof rule === "number" &&
    typeof answer === "number"
  )
    return { kind, rule, answer };
  return internal("a log outcome has an unknown kind");
}

function toStubCall(v: unknown): StubCall {
  if (!isObj(v) || typeof v.tool !== "string")
    return internal("a log line has no tool");
  return {
    tool: v.tool,
    argv: listOf(v.argv, "argv").map((t) =>
      typeof t === "string" ? t : internal("an argv token is not a string"),
    ),
    outcome: toOutcome(v.outcome),
  };
}

/** Read the JSONL log the stub processes appended. Blank lines are skipped. */
export function parseStubLog(jsonl: string): readonly StubCall[] {
  return jsonl.split("\n").flatMap((line, i) => {
    if (line.trim() === "") return [];
    try {
      return [toStubCall(JSON.parse(line))];
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        `vigiles: stub log line ${String(i + 1)} is unreadable (${why}) — an internal error, please report it.`,
        { cause: e },
      );
    }
  });
}

// --- the author-facing diagnostic ---------------------------------------------

function showToken(t: ArgvToken | ArgvRest): string {
  if (typeof t === "string") return JSON.stringify(t);
  if (t instanceof RegExp) return `/${t.source}/${t.flags}`;
  return "experimental_stub.rest";
}

/** A pattern the way a rule is written: `["issue", "create", experimental_stub.rest]`. */
export function describePattern(p: readonly (ArgvToken | ArgvRest)[]): string {
  return `[${p.map(showToken).join(", ")}]`;
}

const whyUnanswered = (o: StubOutcome): string =>
  o.kind === "exhausted"
    ? `rule #${String(o.rule + 1)} has no answer left (its inOrder answers ran out)`
    : "no rule matches";

/** One unanswered argv, `n` times: why, the rules it was tried against, the rule to add. */
function describeMiss(
  c: StubCall,
  n: number,
  stubs: readonly ToolStub[],
): string {
  const times = n > 1 ? ` ×${String(n)}` : "";
  const rules = (stubs.find((s) => s.name === c.tool)?.rules ?? []).map(
    (r, i) => `\n      #${String(i + 1)} ${describePattern(r.argv)}`,
  );
  const tried =
    rules.length === 0 ? "" : `; the rules for ${c.tool} are:${rules.join("")}`;
  return (
    `  ${c.tool} ${JSON.stringify(c.argv)}${times} — ${whyUnanswered(c.outcome)}${tried}\n` +
    `    add: { argv: ${describePattern(c.argv)}, reply: { kind: "always", stdout: "…" } }`
  );
}

/**
 * The failure message for a run with unanswered calls, addressed to the AUTHOR
 * (the model only ever sees a neutral one-liner). Each distinct argv once, with
 * a count; the rules it was tried against; and a rule for that exact command to
 * add. It never suggests a catch-all: answering everything is the defect this
 * exists to stop. `undefined` when every call was answered.
 */
export function unansweredMessage(
  calls: readonly StubCall[],
  stubs: readonly ToolStub[],
): string | undefined {
  const missed = calls.filter((c) => isUnanswered(c.outcome));
  if (missed.length === 0) return undefined;
  const keyOf = (c: StubCall): string =>
    `${c.tool}\u0000${JSON.stringify(c.argv)}\u0000${c.outcome.kind}`;
  const distinct = [...new Map(missed.map((c) => [keyOf(c), c])).values()];
  const lines = distinct.map((c) =>
    describeMiss(c, missed.filter((m) => keyOf(m) === keyOf(c)).length, stubs),
  );
  return (
    `${String(missed.length)} stub call(s) went unanswered — the agent ran a command no rule scripts, ` +
    `so the trial measured an answer nobody wrote:\n${lines.join("\n")}\n` +
    `  Add a rule for each command the agent really runs, with the answer the real tool gives ` +
    `(record it once; do not invent it). A rule that answers every argv would hide this again.`
  );
}

// --- one invocation, end to end (the stub process runs this) ------------------

/**
 * The exit code of an unanswered call. Not 127: that tells the caller "not
 * installed", and a model changes plans for the wrong reason.
 */
export const UNANSWERED_EXIT_CODE = 97;

/**
 * What an unanswered call prints to stderr — the only thing the MODEL sees. One
 * fixed line: no argv, no rules, no "add a rule". Instructions here would tell
 * the model it is in a test and what the author will do, and the rest of the
 * trial would measure a reaction to that. The diagnostic goes to the author,
 * from the log, through {@link unansweredMessage}.
 */
export function unsupportedLine(name: string): string {
  return `${name}: unsupported invocation (vigiles stub)\n`;
}

/** Where a stub root keeps its files (`name` picks the per-stub ones). Pure path arithmetic. */
export function stubPaths(
  root: string,
  name = "",
): {
  readonly binDir: string;
  readonly rulesDir: string;
  readonly rules: string;
  readonly log: string;
  readonly bin: string;
} {
  return {
    binDir: join(root, "bin"),
    rulesDir: join(root, "rules"),
    rules: join(root, "rules", `${name}.json`),
    log: join(root, "calls.jsonl"),
    bin: join(root, "bin", name),
  };
}

/** The two file operations one invocation needs — injected, so the decision stays testable. */
export interface StubIo {
  /** File contents, or null when the file does not exist. */
  readonly readFile: (path: string) => string | null;
  /** Append text; one call per log line (`O_APPEND`, one write). */
  readonly appendFile: (path: string, text: string) => void;
}

/** What the stub process prints and how it exits. */
export interface StubProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * One invocation: read the rules and the log so far, decide, append one log
 * line, return what to print. It never reads stdin: a caller that leaves the
 * pipe open (Node's `execFile` does) would block until its own timeout.
 *
 * Concurrency, said plainly: two simultaneous calls of the same `inOrder` rule
 * can both read "answered k times" and both get answer k. One line per write
 * keeps the log itself intact.
 */
export function runStub(
  root: string,
  name: string,
  argv: readonly string[],
  io: StubIo,
): StubProcessResult {
  const paths = stubPaths(root, name);
  const json = io.readFile(paths.rules);
  if (json === null)
    return {
      stdout: "",
      stderr: `vigiles stub: no rules file for ${name} under ${root} — an internal error, please report it.\n`,
      exitCode: UNANSWERED_EXIT_CODE,
    };
  const stub = decodeStub(json);
  const prior = priorAnswers(parseStubLog(io.readFile(paths.log) ?? ""), name);
  const outcome = decideInvocation(stub, prior, argv);
  io.appendFile(paths.log, stubLogLine({ tool: name, argv, outcome }) + "\n");
  return printed(name, answerFor(stub, outcome));
}

/** What the process prints for an answer — or the neutral miss line for none. */
function printed(
  name: string,
  answer: StubAnswer | undefined,
): StubProcessResult {
  if (answer === undefined)
    return {
      stdout: "",
      stderr: unsupportedLine(name),
      exitCode: UNANSWERED_EXIT_CODE,
    };
  return {
    stdout: answer.stdout ?? "",
    stderr: answer.stderr ?? "",
    exitCode: answer.exitCode ?? 0,
  };
}
