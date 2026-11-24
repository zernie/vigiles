/**
 * Did the project's instruction files reach the model? — the per-trial evidence
 * `runEval` scores a trial on (vigiles#416).
 *
 * 🔴 WHY THIS EXISTS. A trial answers "how does the model behave WITH these
 * instructions", so a scored trial needs evidence the instructions were there.
 * Before this, the evidence was an assumption — "the file was in the directory,
 * so it loaded" — and it is false in at least six ways, every one exit 0
 * (measured on Claude Code 2.1.330 with the mock model): a trial directory inside
 * the harness's own scratchpad, `--setting-sources user`,
 * `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, a user-level `claudeMdExcludes`, a file
 * the author left out of `fixture`, and an `AGENTS.md` beside a `CLAUDE.md` that
 * does not import it. Fixing the six one by one is whack-a-mole; the fix is to
 * OBSERVE the request. What should arrive comes from the harness's own
 * instruction chain applied to the trial's world, never from the author.
 *
 * Pure: the world is a path → text map and the request is a string. Reading the
 * request off disk is the adapter's job (`HarnessRuntime.requestCapture`).
 */
import type { PluginLayout } from "./layout.js";
import {
  instructionCandidatePaths,
  resolveImports,
} from "./instruction-chain.js";

/** A file the harness should put in the model's first request, and its text. */
export interface ExpectedInstruction {
  readonly path: string;
  readonly text: string;
}

/**
 * Why a trial's context could not be checked.
 *
 * @public
 */
export type UnobservableWhy =
  /** The harness has a channel, but this run wrote no request body to read. */
  | "no-request-body"
  /** The harness has no request-body channel vigiles can read. */
  | "harness-has-no-channel"
  /** The eval spec set `experimental_contextCheck: false`. */
  | "opted-out"
  /** A cache entry recorded before this check existed was replayed. */
  | "replayed-without-evidence";

/**
 * What one trial shows about its instruction files. A tagged union, because
 * "not seen" has more than one reason and none of them may read as "passed".
 *
 * @public
 */
export type ContextEvidence =
  /** Every expected file is in the model's first request. */
  | { readonly kind: "delivered"; readonly files: readonly string[] }
  /** At least one expected file is absent: the trial is not scored. */
  | {
      readonly kind: "missing";
      readonly files: readonly string[];
      readonly delivered: readonly string[];
    }
  /** Expected files exist, but nothing could be observed. Never a pass. */
  | {
      readonly kind: "unobservable";
      readonly why: UnobservableWhy;
      readonly files: readonly string[];
    }
  /** The trial's world holds no instruction file the harness loads. */
  | { readonly kind: "nothing-expected" };

/**
 * The files the harness's instruction chain loads at a session rooted in this
 * world — `@`-imports included, each as its own file, because the client
 * expands an import into a block of its own.
 */
export function expectedInstructions(
  layout: PluginLayout,
  world: Readonly<Record<string, string>>,
): readonly ExpectedInstruction[] {
  const candidates = Object.fromEntries(
    instructionCandidatePaths(Object.keys(world), layout).map((p) => [
      p,
      world[p] ?? "",
    ]),
  );
  const withImports = resolveImports(layout, candidates, (p) => world[p]);
  return layout
    .instructionChain(withImports)
    .loaded.map((e) => ({ path: e.path, text: withImports[e.path] ?? "" }));
}

const BOM = "\uFEFF";
const FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
const HTML_COMMENT = /<!--[\s\S]*?-->/;

/**
 * The pieces of a file that must appear, in order, in the request.
 *
 * Measured (Claude Code 2.1.330, `repro/issue-416-context-check`): a file
 * reaches the request verbatim after CRLF→LF EXCEPT that the client strips a
 * leading BOM and removes HTML comments. So the file is normalised the same way
 * and split at every comment; each piece is trimmed, which also absorbs the
 * newline the client normalises at the end. A leading frontmatter block is
 * dropped too: if the client keeps it, what follows is still a substring.
 */
export function instructionSegments(text: string): readonly string[] {
  const lf = text.replace(/\r\n/g, "\n");
  const noBom = lf.startsWith(BOM) ? lf.slice(BOM.length) : lf;
  return noBom
    .replace(FRONTMATTER, "")
    .split(HTML_COMMENT)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Is every piece of `text` in `body`, in order? */
export function deliveredIn(text: string, body: string): boolean {
  const normalized = body.replace(/\r\n/g, "\n");
  const found = instructionSegments(text).reduce(
    (from, seg) => (from < 0 ? from : normalized.indexOf(seg, from)),
    0,
  );
  return found >= 0;
}

/**
 * The evidence for one trial: the expected files against the first request
 * body (`undefined` when the run wrote none).
 */
export function contextEvidence(
  expected: readonly ExpectedInstruction[],
  body: string | undefined,
): ContextEvidence {
  if (expected.length === 0) return { kind: "nothing-expected" };
  const files = expected.map((e) => e.path);
  if (body === undefined)
    return { kind: "unobservable", why: "no-request-body", files };
  const missing = expected.filter((e) => !deliveredIn(e.text, body));
  return missing.length === 0
    ? { kind: "delivered", files }
    : {
        kind: "missing",
        files: missing.map((e) => e.path),
        delivered: files.filter((f) => !missing.some((m) => m.path === f)),
      };
}

/** The evidence when nothing could be read, for a reason other than the body. */
export function unobservableContext(
  expected: readonly ExpectedInstruction[],
  why: UnobservableWhy,
): ContextEvidence {
  return expected.length === 0
    ? { kind: "nothing-expected" }
    : { kind: "unobservable", why, files: expected.map((e) => e.path) };
}

const WHY_TEXT: Readonly<Record<UnobservableWhy, string>> = {
  "no-request-body": "the run wrote no request body to read",
  "harness-has-no-channel": "this harness has no request-body channel",
  "opted-out": "experimental_contextCheck is false",
  "replayed-without-evidence":
    "replayed from a cache entry recorded without the check",
};

const count = (k: number, n: number): string =>
  `in ${String(k)} of ${String(n)} trials`;

function missingLines(trials: readonly ContextEvidence[]): readonly string[] {
  const files = [
    ...new Set(trials.flatMap((e) => (e.kind === "missing" ? e.files : []))),
  ];
  return files.map((f) => {
    const k = trials.filter(
      (e) => e.kind === "missing" && e.files.includes(f),
    ).length;
    return `✗ context: ${f} missing from the model's request ${count(k, trials.length)} — not scored`;
  });
}

function unobservableLines(
  trials: readonly ContextEvidence[],
): readonly string[] {
  const whys = [
    ...new Set(
      trials.flatMap((e) => (e.kind === "unobservable" ? [e.why] : [])),
    ),
  ];
  return whys.map((why) => {
    const k = trials.filter(
      (e) => e.kind === "unobservable" && e.why === why,
    ).length;
    return `⚠ context not checked: ${WHY_TEXT[why]} ${count(k, trials.length)}`;
  });
}

function deliveredLine(trials: readonly ContextEvidence[]): readonly string[] {
  const done = trials.filter((e) => e.kind === "delivered");
  const files = [...new Set(done.flatMap((e) => e.files))];
  return done.length === 0
    ? []
    : [
        `✓ context: ${files.join(", ")} delivered ${count(done.length, trials.length)}`,
      ];
}

/**
 * The report lines for one arm's trials, without indentation or arm name.
 * Empty when there are no trials (a report recorded before this check).
 */
export function contextSummaryLines(
  trials: readonly ContextEvidence[],
): readonly string[] {
  if (trials.length === 0) return [];
  if (trials.every((e) => e.kind === "nothing-expected"))
    return ["context: no instruction files in this arm — nothing to check"];
  return [
    ...missingLines(trials),
    ...unobservableLines(trials),
    ...deliveredLine(trials),
  ];
}

/** The `✗ context` lines across arms, or undefined when no trial missed one. */
export function contextFailure(
  arms: Readonly<
    Record<string, { readonly context?: readonly ContextEvidence[] }>
  >,
): string | undefined {
  const lines = Object.entries(arms).flatMap(([arm, r]) =>
    missingLines(r.context ?? []).map((l) => `${arm}: ${l}`),
  );
  return lines.length === 0 ? undefined : lines.join("\n");
}
