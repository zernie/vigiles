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
 * THE BUDGET IS NOT A GATE, AND THAT IS MEASURED. Both corpora this was built
 * against sit at roughly four times the Claude Code threshold. A rule that
 * fails every real repo on day one is switched off on day one
 * (`lint-rule-calibration`: severity tracks confidence, and a check nobody
 * leaves on catches nothing). So going over it is a finding the baseline store
 * can accept (`./always-loaded-limits.ts`, `./baseline-store.ts`): green on
 * day one at any size the repository recorded, red the day it grows.
 */

import type {
  InstructionRole,
  InstructionScope,
  InstructionViews,
  LoadedInstruction,
} from "./instruction-chain.js";
import { sizeIn } from "./harness-unit.js";
import { importResolution, type DirListing } from "./instruction-imports.js";

/** What the harness counts, and what it does when the count is exceeded. */
export interface InstructionBudget {
  /** Claude Code counts characters; Codex counts bytes. Never tokens. */
  readonly unit: "chars" | "bytes";
  /**
   * The budget, in `unit`. For Codex it is the harness's own cut-off. For Claude
   * Code it is the harness's FLOOR: the CLI warns per file at 5% of the model's
   * context window in characters (never below 40 000) and on the sum at 120 000
   * or that per-file limit, so on a 1M-token model it warns far later than this.
   */
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
  readonly notLoadedHere?: {
    /** The per-machine file that did it — a superseder, or a settings file. */
    readonly by: string;
    readonly why: "superseded" | "excluded";
  };
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
   * Files the chain NAMED that EXIST and this run did not weigh — an import
   * past the import depth (a second hop). Printed, not dropped: a number
   * missing a file it knows about would be the under-report this whole module
   * exists to prevent. An import that does not resolve is NOT here: that is a
   * finding of its own (`./instruction-imports.ts`), printed once, where it is
   * written.
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

/** Re-exported from its neutral home, where every always-loaded part is sized. */
export { sizeIn } from "./harness-unit.js";

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
 * Takes BOTH views (`instructionViews`): this copy's chain for what it loads,
 * the committed one for what a teammate loads — see {@link notLoadedHereOf}.
 *
 * Takes the map as well as the chain because a chain is a CLASSIFICATION, not
 * a measurement: the sizes live in the bytes, and the same map serves the CLI
 * and the browser engine.
 */
export function weighInstructions(
  views: InstructionViews,
  files: Readonly<Record<string, string>>,
  budget: InstructionBudget,
  /** The repository's names, to tell an import that exists from one that does not. */
  list: DirListing,
): InstructionWeight {
  const chain = views.effective;
  const weighOne = (
    entry: LoadedInstruction,
    notLoadedHereBy?: NotLoadedHere,
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
            ...(notLoadedHereBy === undefined
              ? {}
              : { notLoadedHere: notLoadedHereBy }),
          },
        ];
  };
  const weighed = [
    ...chain.loaded.flatMap((e) => weighOne(e)),
    ...notLoadedHereOf(views).flatMap((s) => weighOne(s.entry, s.marker)),
  ].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const sum = (of: readonly WeighedFile[]): number =>
    of.reduce((total, f) => total + f.size, 0);
  // COMMITTED is "every `repo`-scoped file in the list": the files a teammate
  // loads that this copy does not join the list from the COMMITTED view with
  // their own scope, so the formula did not have to learn a second rule.
  // EFFECTIVE is everything this copy loads.
  const committedTotal = sum(weighed.filter((f) => f.scope === "repo"));
  return {
    unit: budget.unit,
    limit: budget.limit,
    onExceed: budget.onExceed,
    files: weighed,
    committedTotal,
    effectiveTotal: sum(weighed.filter((f) => f.notLoadedHere === undefined)),
    overBy:
      committedTotal > budget.limit ? committedTotal - budget.limit : null,
    unreadImports: unreadImportsOf(views, list),
    unweighedPatterns: [
      ...new Set(chain.patterns.map((p) => p.pattern)),
    ].sort(),
    redirects: chain.redirects,
  };
}

/** Who stopped this copy loading a committed file, and how. */
type NotLoadedHere = NonNullable<WeighedFile["notLoadedHere"]>;

/**
 * The files the COMMITTED view loads and this copy does not — a teammate's
 * total keeps them, ours does not — each with the per-machine file that did it.
 *
 * 🔴 READ OFF THE COMMITTED VIEW (`instructionViews`), NOT OFF THE EFFECTIVE
 * CHAIN'S REASONS. It used to be "the `repo` entries `unloaded` because a
 * `local` superseder or a `local` settings exclusion removed them" — right for
 * the file itself and blind to what that file IMPORTS, because a chain never
 * names the imports of a file it does not load. Measured: `AGENTS.md` importing
 * `docs/x.md`, with a `CLAUDE.local.md` beside it, put 112 into
 * `committedTotal` where a teammate loads 162. The same blindness took a
 * broken import out of the grade, so both now read the one committed view.
 *
 * The marker is the effective chain's own reason for the file (`superseded`,
 * or `excluded-by-settings`, each with `byScope: "local"`); a file the committed
 * view took through an import inherits its importer's. Nothing else can make
 * the two views differ, so a file with neither is not listed.
 */
function notLoadedHereOf(views: InstructionViews): readonly {
  readonly entry: LoadedInstruction;
  readonly marker: NotLoadedHere;
}[] {
  const here = new Set(views.effective.loaded.map((e) => e.path));
  const committed = new Map(views.committed.loaded.map((e) => [e.path, e]));
  const reasonOf = new Map(
    views.effective.unloaded.flatMap((e): [string, NotLoadedHere][] => {
      if (e.reason.kind === "superseded" && e.reason.byScope === "local")
        return [[e.path, { by: e.reason.by, why: "superseded" }]];
      if (
        e.reason.kind === "excluded-by-settings" &&
        e.reason.byScope === "local"
      )
        return [[e.path, { by: e.reason.by, why: "excluded" }]];
      return [];
    }),
  );
  const markerOf = (
    entry: LoadedInstruction | undefined,
  ): NotLoadedHere | undefined => {
    if (entry === undefined) return undefined;
    const own = reasonOf.get(entry.path);
    if (own !== undefined || entry.via === undefined) return own;
    return markerOf(committed.get(entry.via.from));
  };
  return views.committed.loaded
    .filter((e) => !here.has(e.path))
    .flatMap((entry) => {
      const marker = markerOf(entry);
      return marker === undefined ? [] : [{ entry, marker }];
    });
}

/**
 * The imports that EXIST and the chain did not classify — sorted, unique.
 *
 * NOT "absent from the map": a second-hop target can be in the map (the import
 * pass read it because its importer was also a candidate) and still not be in
 * the chain, because the second hop is named, never taken. What makes an import
 * unread is that the chain did not classify its target; one that does not
 * resolve at all is the instruction-import finding's, not this list's.
 */
function unreadImportsOf(
  views: InstructionViews,
  list: DirListing,
): readonly string[] {
  const chains = [views.effective, views.committed];
  const classified = new Set(
    chains.flatMap((c) => [...c.loaded, ...c.unloaded]).map((e) => e.path),
  );
  return [
    ...new Set(
      chains
        .flatMap((c) => c.imports)
        .map((i) => i.path)
        .filter(
          (path) =>
            !classified.has(path) && importResolution(path, list) === null,
        ),
    ),
  ].sort();
}
