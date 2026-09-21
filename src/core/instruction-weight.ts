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

import type {
  InstructionChain,
  InstructionRole,
  InstructionScope,
  LoadedInstruction,
} from "./instruction-chain.js";

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
}

/** One file's contribution, so a report can say WHERE the weight is. */
export interface WeighedFile {
  readonly path: string;
  readonly size: number;
  /** What it is to the harness — a root file, a rule, an import. */
  readonly role: InstructionRole;
  /** `"local"` files are shown and never scored; see {@link InstructionScope}. */
  readonly scope: InstructionScope;
  /**
   * Set when this file got into the count through an IMPORT — who named it, and
   * with what text. The report prints it on the file's own line, because
   * `AGENTS.md` appearing in a Claude Code weight reads as a bug until the line
   * says `via @AGENTS.md in CLAUDE.md`. A total a reader cannot decompose is the
   * failure this report exists to prevent.
   */
  readonly via?: { readonly from: string; readonly token: string };
  /**
   * Set when this file pays into {@link InstructionWeight.committedTotal} but
   * NOT into {@link InstructionWeight.effectiveTotal}: a PER-MACHINE file in
   * this working copy supersedes it, so a teammate on the same commit loads it
   * and you do not. Names the file that did it.
   *
   * 🔴 THE ONE CASE WHERE THE TWO TOTALS MOVE IN OPPOSITE DIRECTIONS, and the
   * reason this is a field rather than a filter at the print site. Every other
   * per-machine effect is ADDITIVE — a `CLAUDE.local.md` appends its own bytes,
   * so `effective = committed + locals` — which is why it was safe for
   * `effectiveTotal` to be "the sum of everything loaded". Claude Code's
   * supersede rule breaks that: "Because `CLAUDE.local.md` counts, adding one
   * to keep your own uncommitted instructions in a project that relies on
   * `AGENTS.md` stops Claude from reading `AGENTS.md` for you." The gitignored
   * file changes the MEMBERSHIP of the load, not its size, and the committed
   * number has to keep a file this working copy never opens.
   *
   * A reader who could not see this on the file's own line would meet a
   * `committedTotal` larger than the `effectiveTotal` beside it with nothing
   * accounting for the gap — the undecomposable total this whole report exists
   * to prevent.
   */
  readonly supersededLocallyBy?: string;
}

export interface InstructionWeight {
  readonly unit: "chars" | "bytes";
  readonly limit: number;
  readonly onExceed: "warns" | "truncates";
  /** Heaviest first — a report's first line should name the biggest payer. */
  readonly files: readonly WeighedFile[];
  /**
   * The SCORED number: everything loaded without a decision that a TEAMMATE or
   * CI would also load. Per-machine files are excluded, which is what makes the
   * figure reproducible from a commit alone.
   */
  readonly committedTotal: number;
  /**
   * What THIS working copy actually loads. Never compared against the budget;
   * printed beside it so the difference is visible rather than silently either
   * counted or dropped.
   *
   * ⚠️ IT IS NOT "`committedTotal` PLUS THE PER-MACHINE FILES", and it used to
   * say so. A per-machine file can also SUBTRACT: Claude Code stops reading
   * `AGENTS.md` at all once a `CLAUDE.local.md` exists, so this number can come
   * out BELOW `committedTotal`. See {@link WeighedFile.supersededLocallyBy}.
   */
  readonly effectiveTotal: number;
  /** `null` when {@link committedTotal} is within budget; else how far over. */
  readonly overBy: number | null;
  /**
   * Files the chain NAMED and this run did not read — an import that does not
   * exist, points outside the repo, or sits past the import depth. Printed, not
   * dropped: a number missing a file it knows about would be the under-report
   * this whole module exists to prevent.
   */
  readonly unreadImports: readonly string[];
  /**
   * Globs and URLs the harness would expand at launch and vigiles will not walk
   * (OpenCode `instructions`). Reported for the same reason.
   */
  readonly unweighedPatterns: readonly string[];
  /**
   * A loaded file whose ENTIRE content is import tokens. Printed as a FINDING,
   * not as a size: such a `CLAUDE.md` is fourteen bytes and the repository it
   * describes loads tens of kilobytes, so the number on its own is a confident
   * wrong answer. See `InstructionChain.redirects` for why the shape is common.
   */
  readonly redirects: readonly {
    readonly path: string;
    readonly to: readonly string[];
  }[];
}

/** Size in the harness's own unit. Bytes and chars differ on any non-ASCII text. */
export function sizeIn(text: string, unit: "chars" | "bytes"): number {
  return unit === "chars" ? text.length : Buffer.byteLength(text, "utf8");
}

/**
 * Weigh a harness's LOADED chain against its own budget.
 *
 * 🔴 IT TAKES A CHAIN, NOT A GLOB LIST, AND THAT IS THE WHOLE FIX. This used to
 * filter the file map with `matchesGlob` over `budget.alwaysLoaded` — an adapter
 * string the core interpreted — and so it counted files the harness does not
 * load at launch (`paths:`-scoped rules, a sibling package's instruction file)
 * and a file no teammate has (`CLAUDE.local.md`). Which files load is the
 * harness's answer now (`PluginLayout.instructionChain`); this function only
 * adds up what it was told and says what it could not weigh.
 *
 * Takes the map as well as the chain because a chain is a CLASSIFICATION, not
 * a measurement: the sizes live in the bytes, and the same map serves the CLI
 * and the browser engine.
 */
export function weighInstructions(
  chain: InstructionChain,
  files: Readonly<Record<string, string>>,
  budget: InstructionBudget,
): InstructionWeight {
  /**
   * A committed file this working copy does NOT load, only because a
   * per-machine file supersedes it — so a teammate's total keeps it and ours
   * does not. Read straight off the chain's own reason rather than re-derived
   * from the path, which is why `byScope` is on {@link NotLoadedReason}.
   *
   * The other superseded entries — the ones a COMMITTED file silenced — are
   * correctly absent: nobody loads those, so they pay into neither total.
   */
  const supersededByLocal: readonly {
    readonly entry: LoadedInstruction;
    readonly by: string;
  }[] = chain.unloaded.flatMap((e) =>
    e.scope === "repo" &&
    e.reason.kind === "superseded" &&
    e.reason.byScope === "local"
      ? [{ entry: e, by: e.reason.by }]
      : [],
  );
  const weighOne = (
    entry: LoadedInstruction,
    supersededLocallyBy?: string,
  ): WeighedFile[] => {
    const text = files[entry.path];
    return text === undefined
      ? []
      : [
          {
            path: entry.path,
            size: sizeIn(text, budget.unit),
            role: entry.role,
            scope: entry.scope,
            ...(entry.via === undefined ? {} : { via: entry.via }),
            ...(supersededLocallyBy === undefined
              ? {}
              : { supersededLocallyBy }),
          },
        ];
  };
  const weighed = [
    ...chain.loaded.flatMap((e) => weighOne(e)),
    ...supersededByLocal.flatMap((s) => weighOne(s.entry, s.by)),
  ].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const sum = (of: readonly WeighedFile[]): number =>
    of.reduce((total, f) => total + f.size, 0);
  // COMMITTED is still "every `repo`-scoped file in the list", unchanged — the
  // superseded entry is a committed file and joins the list with `scope:
  // "repo"`, so the formula did not have to learn a second rule. EFFECTIVE is
  // the one that changed: it was `sum(weighed)`, which was only ever right
  // while the list held nothing this working copy fails to load.
  const committedTotal = sum(weighed.filter((f) => f.scope === "repo"));
  return {
    unit: budget.unit,
    limit: budget.limit,
    onExceed: budget.onExceed,
    files: weighed,
    committedTotal,
    effectiveTotal: sum(
      weighed.filter((f) => f.supersededLocallyBy === undefined),
    ),
    overBy:
      committedTotal > budget.limit ? committedTotal - budget.limit : null,
    unreadImports: [
      ...new Set(
        chain.imports
          .map((i) => i.path)
          .filter((path) => files[path] === undefined),
      ),
    ].sort(),
    unweighedPatterns: [
      ...new Set(chain.patterns.map((p) => p.pattern)),
    ].sort(),
    redirects: chain.redirects,
  };
}
