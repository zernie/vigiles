/**
 * The known-flag registry, and the rejection of everything else.
 *
 * ## The defect this closes
 *
 * Every subcommand parsed its own flags by asking `args.includes("--x")` and
 * ignored the rest. So a typo was accepted in silence:
 *
 * ```
 * $ npx vigiles audit --this-flag-does-not-exist
 * Detected harness: claude-code
 * …a complete, confident audit…
 * EXIT=0
 * ```
 *
 * That is not cosmetic, because audit's flags govern what LEAVES THE MACHINE:
 * `--no-html`, `--no-json`, `--out=<dir>`, `--serve`. `--no-htlm` writes the HTML
 * report while the author believes they suppressed it. For a tool whose thesis is
 * "prose isn't policy", accepting an argument it did not understand and carrying
 * on is the same class of error it names elsewhere: the argument is PRESENT, so
 * the property is assumed enforced.
 *
 * The sharper case, observed: `vigiles audit --json /some/path`. `--json` is real
 * but takes no value, so the PATH fell through to the positional scan directory.
 * The audit then ran over a directory with no harness in it and reported
 * "No loadable harness surface — nothing to grade yet", `skills: 0`, grade F,
 * exit 0 — output indistinguishable from a genuine audit of a repo that scores
 * badly. A confident measurement OF THE WRONG OBJECT, silently.
 *
 * ## Why a table and not a parser library
 *
 * The flags are already parsed at their point of use, and moving that would be a
 * large behavioural change for a validation fix. This adds the ONE thing the
 * ad-hoc parsing cannot do — say no to what it doesn't recognise. A dogfood test
 * (src/scan-cli.test.ts, "every flag the help text advertises is accepted")
 * drives the real `vigiles --help` and asserts the table hasn't drifted from it,
 * so a flag documented but not registered is a test failure rather than a
 * rejection in a user's face.
 */

import type { Verb } from "./cli-commands.js";

/**
 * A known flag. `--foo` is a bare switch; `--foo=` takes a value with `=`
 * (`flagValue()` only ever reads the `=` form, so a space-separated value is
 * genuinely NOT supported and must not be silently accepted).
 */
export type FlagSpec = string;

/**
 * Flags every verb accepts: the config overrides applied in `main()` before
 * dispatch (see `applyConfigFlags`) plus the harness override, which the shared
 * `harnessFlagFrom` reads for lint/compile/audit/generate/init.
 */
export const SHARED_FLAGS: readonly FlagSpec[] = [
  "--max-rules=",
  "--catalog-only",
  "--harness=",
  "--help",
];

/**
 * Per-verb flags, derived from what each handler actually READS (not from the
 * help text — the help text is checked AGAINST this, in src/scan-cli.test.ts).
 */
export const COMMAND_FLAGS: Record<Verb, readonly FlagSpec[]> = {
  // parseSetupArgs() + the --target= fast path in main().
  init: [
    "--target=",
    "--strict",
    "--report-only",
    "--yes",
    "-y",
    "--force",
    "--lint",
    "--no-lint",
    "--test",
    "--no-test",
    "--no-gha",
    "--no-plugin",
    "--ci-only",
    "--full",
  ],
  compile: [],
  eject: ["--keep-spec"],
  lint: [
    "--bundles=",
    "--summary",
    "--json",
    "--json-out=",
    "--update-baseline",
  ],
  // handleRunScripts (free tier — no lock flags).
  test: ["--min=", "--all", "--yes", "--no-interactive", "--no-skip"],
  // handleRunScripts + resolveEvalLockEnv + the trials knob.
  eval: [
    "--min=",
    "--all",
    "--yes",
    "--no-interactive",
    "--no-skip",
    "--trials=",
    "--check",
    "--update",
  ],
  audit: [
    "--json",
    "--md",
    "--single",
    "--out=",
    "--no-html",
    "--no-json",
    "--no-open",
    "--serve",
    "--no-serve",
    "--no-interactive",
    "--yes",
    "--capability-diff=",
    "--fail-on-widen",
    // The model trigger tier, reached from audit under consent (handleMeasure /
    // runAutoTrigger).
    "--prompts=",
    "--model=",
    "--concurrency=",
    "--min-prompts=",
    "--trials=",
  ],
  generate: ["--check", "--files=", "--spec-import="],
  // Emitted into hooks configs, never typed by hand: its argv is whatever the
  // harness passes through, so validating it would break the runtime contract.
  "hook-runtime": [],
};

/** Verbs whose argv is machine-supplied and must NOT be validated. */
const UNVALIDATED: ReadonlySet<string> = new Set(["hook-runtime"]);

/** The flag token of an arg, without its `=value` (`--out=x` → `--out`). */
function tokenOf(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

function accepts(spec: FlagSpec, arg: string): boolean {
  return spec.endsWith("=")
    ? arg.startsWith(spec)
    : arg === spec || tokenOf(arg) === spec;
}

/** Every flag this verb knows, shared ones included. */
export function knownFlagsFor(command: string): readonly FlagSpec[] {
  const own = COMMAND_FLAGS[command as Verb] ?? [];
  return [...SHARED_FLAGS, ...own];
}

/**
 * Args that look like flags but no spec accepts. `--` (the argv terminator) and
 * anything after it are left alone; a lone `-` is a positional by convention.
 */
export function unknownFlags(
  command: string,
  argv: readonly string[],
): string[] {
  if (UNVALIDATED.has(command)) return [];
  const known = knownFlagsFor(command);
  const out: string[] = [];
  for (const arg of argv) {
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (known.some((spec) => accepts(spec, arg))) continue;
    out.push(arg);
  }
  return out;
}

/** Levenshtein distance, iterative two-row. Small inputs; clarity over speed. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The closest known flag to a typo, or undefined when nothing is close enough.
 * The threshold is deliberately tight — a wrong suggestion is worse than none,
 * because it invites the reader to "fix" a flag they never meant to type.
 */
export function nearestFlag(
  unknown: string,
  known: readonly FlagSpec[],
): string | undefined {
  const target = tokenOf(unknown);
  let best: { flag: string; d: number } | undefined;
  for (const spec of known) {
    const flag = spec.endsWith("=") ? spec.slice(0, -1) : spec;
    const d = distance(target, flag);
    if (!best || d < best.d) best = { flag: spec, d };
  }
  return best && best.d <= Math.max(2, Math.floor(target.length / 4))
    ? best.flag
    : undefined;
}

/** The message printed to stderr for one unrecognised flag. */
export function formatUnknownFlag(command: string, flag: string): string {
  const known = knownFlagsFor(command);
  const near = nearestFlag(flag, known);
  const lines = [`✗ vigiles ${command}: unknown flag "${flag}".`];
  if (near) lines.push(`  Did you mean \`${near}\`?`);
  lines.push(
    `  Flags for \`${command}\`: ${[...known].sort().join(" ")}`,
    `  \`vigiles ${command} --help\` lists them with descriptions.`,
  );
  return lines.join("\n");
}
