/**
 * How heavy are the instructions this harness loads WITHOUT BEING ASKED — and
 * what does the harness do when that is too much.
 *
 * WHY THIS IS NOT "the size of CLAUDE.md". Measured 2026-09-16 in a consumer
 * repo: a 4 101-line root instruction file was "cut" to 2 665 lines by moving
 * 225 837 characters of it into a sibling directory, and the cost of a request
 * did not move at all — because the harness loads that directory
 * unconditionally too. Splitting a file that is loaded either way relocates
 * bytes; it does not remove them. So the number that matters is the SUM over
 * everything loaded without a decision, and a per-file check silently INVITES
 * the evasion (it rewards the split that changes nothing).
 *
 * WHY THE UNIT IS PER-HARNESS AND NOT TOKENS. The harnesses measure different
 * things and neither gates on tokens:
 *
 *   - Claude Code counts CHARACTERS and WARNS ("Large file will impact
 *     performance"); the instructions still reach the model.
 *   - Codex counts BYTES (`project_doc_max_bytes`, default 32 KiB) and
 *     TRUNCATES — silently. Its own source says so: "Maximum number of bytes of
 *     the documentation that will be embedded. Larger files are *silently
 *     truncated*" (openai/codex#7138, CLOSED AS NOT PLANNED, so this is the
 *     standing behaviour rather than a bug in flight).
 *
 * That asymmetry is the whole point of reporting `onExceed`: over budget on
 * Claude Code costs money and attention, over budget on Codex means some of
 * your rules DO NOT EXIST for the model and nothing tells you which. The same
 * number carries a different severity per harness, so the harness must supply
 * it — hence a port field, not a constant.
 *
 * NOT A GATE, AND THAT IS MEASURED. Both corpora this was built against sit at
 * roughly four times the Claude Code threshold. A rule that fails every real
 * repo on day one is switched off on day one (`lint-rule-calibration`: severity
 * tracks confidence, and a check nobody leaves on catches nothing). So the
 * first consumer is `audit`, as a REPORT. It earns a severity when a corpus
 * exists that it would not immediately fail.
 */

/** What the harness counts, and what it does when the count is exceeded. */
export interface InstructionBudget {
  /** Claude Code counts characters; Codex counts bytes. Never tokens. */
  readonly unit: "chars" | "bytes";
  /** The harness's own threshold, in `unit`. */
  readonly limit: number;
  /**
   * `warns` — the instructions still reach the model (Claude Code).
   * `truncates` — everything past the limit DOES NOT EXIST for the model, with
   * no signal in the session (Codex). The difference is losing money versus
   * losing rules.
   */
  readonly onExceed: "warns" | "truncates";
  /** The vendor artifact this was read from, version included. */
  readonly capturedFrom: string;
  /**
   * Globs the harness loads WITHOUT the user asking — the set the SUM is taken
   * over. A file reachable only by an explicit read does not belong here; that
   * is exactly the distinction the relocation trick exploits.
   */
  readonly alwaysLoaded: readonly string[];
}

/** One file's contribution, so a report can say WHERE the weight is. */
export interface WeighedFile {
  readonly path: string;
  readonly size: number;
}

export interface InstructionWeight {
  readonly unit: "chars" | "bytes";
  readonly limit: number;
  readonly onExceed: "warns" | "truncates";
  /** Heaviest first — a report's first line should name the biggest payer. */
  readonly files: readonly WeighedFile[];
  /** The number that matters: everything loaded without a decision. */
  readonly total: number;
  /** `null` when within budget; otherwise how far over, in `unit`. */
  readonly overBy: number | null;
}

/** Size in the harness's own unit. Bytes and chars differ on any non-ASCII text. */
export function sizeIn(text: string, unit: "chars" | "bytes"): number {
  return unit === "chars" ? text.length : Buffer.byteLength(text, "utf8");
}

/**
 * Match a path against one glob. Deliberately tiny: the patterns here are
 * `alwaysLoaded` entries an ADAPTER writes, not user input — `CLAUDE.md`,
 * `.claude/rules/**`. `*` stops at a separator, `**` crosses them.
 */
function matchesGlob(path: string, glob: string): boolean {
  const rx = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${rx}$`).test(path);
}

/**
 * Weigh every unconditionally-loaded file in a file map.
 *
 * Takes a MAP rather than a directory so the same function serves the CLI and
 * the browser engine (the `scan-files.ts` split), and so a test states its
 * input instead of building a tree.
 */
export function weighInstructions(
  files: Readonly<Record<string, string>>,
  budget: InstructionBudget,
): InstructionWeight {
  const weighed = Object.entries(files)
    .filter(([path]) => budget.alwaysLoaded.some((g) => matchesGlob(path, g)))
    .map(([path, text]) => ({ path, size: sizeIn(text, budget.unit) }))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const total = weighed.reduce((sum, f) => sum + f.size, 0);
  return {
    unit: budget.unit,
    limit: budget.limit,
    onExceed: budget.onExceed,
    files: weighed,
    total,
    overBy: total > budget.limit ? total - budget.limit : null,
  };
}
