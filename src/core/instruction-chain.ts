/**
 * The INSTRUCTION CHAIN — which of a repo's instruction-shaped files a harness
 * actually LOADS at a repo-root session, in what order, and for every one it
 * does not load, WHY.
 *
 * 🔴 WHY THIS IS A PORT METHOD AND NOT A LIST OF GLOBS. It replaced
 * `HarnessDialect.instructionBudget.alwaysLoaded` — an array of glob strings an
 * adapter wrote and the CORE interpreted, with its own `matchesGlob` plus a
 * private repo walk in `scan.ts` (`readAlwaysLoaded`: `glob.endsWith("/**")` →
 * recurse, `glob.startsWith("**\/")` → walk every non-dot directory). Three
 * things were wrong with that at once, and they share one cause:
 *
 *   1. **An adapter drove the domain's walk.** `codexDialect` shipped
 *      `"**\/AGENTS.md"`, so registering that adapter made vigiles read every
 *      directory of somebody else's repository. The whole discovery refactor
 *      (`./surface-discovery.ts`) exists to make that impossible for SURFACES;
 *      instructions had a side door. The discovery lint did not catch it
 *      because that lint polices EXCLUSION — which paths are skipped — not who
 *      chose the walk.
 *   2. **The printed weight was wrong on BOTH harnesses, in opposite
 *      directions.** Codex does not load every `AGENTS.md` in a repo: from the
 *      project root it walks DOWN to the cwd taking at most one file per
 *      directory, so a sibling package's file pays into a budget no session
 *      ever pays. Claude Code's `paths:`-scoped rules and its nested
 *      `CLAUDE.md` files load ON DEMAND, not at launch, so counting them
 *      inflates the one number the whole feature exists to report.
 *   3. **An uncommitted file was scored.** `CLAUDE.local.md` was in the glob
 *      list, so a published grade depended on a gitignored file — irreproducible
 *      between two teammates on the same commit, and invisible to the browser
 *      twin, which reads a GitHub tree and can never see it.
 *
 * None of the three is expressible as a better glob, because none of them is a
 * question about WHERE a file is. Whether a rule loads depends on its own
 * frontmatter; whether a committed file loads depends on a SIBLING file
 * (`AGENTS.override.md` takes the directory's one slot); and which files are
 * candidates at all depends on the REPOSITORY'S OWN SETTINGS — Codex's
 * `project_doc_fallback_filenames` and Claude Code's `claudeMdExcludes` are two
 * independent vendors arriving at the same shape. Content, siblings, settings:
 * a path lookup can see none of them, which is what makes this a method.
 *
 * ── WHAT THE METHOD MAY AND MAY NOT DO ──────────────────────────────────────
 * It receives the map the DOMAIN enumerated ({@link instructionCandidatePaths})
 * and returns a classification of those keys. It never names a root, never
 * reaches a `node:` module, and is pure in its argument. The properties are
 * asserted for every implementation in `src/adapter-properties.test.ts`:
 *
 *   (i)   `loaded ∪ unloaded ⊆ keys(F)` — an adapter cannot widen the read
 *   (ii)  every `imports[i].path` literally occurs in `F[imports[i].from]`
 *   (iii) every `patterns[i].pattern` likewise
 *   (iv)  pure and monotone: `chain(F)` is stable, and adding files that are
 *         not instruction-shaped changes nothing
 *
 * (ii) is the one worth reading twice. An import IS a widening of the read —
 * `@docs/style.md` points outside the dot-directory bound — and it is allowed
 * anyway, because the bound exists so that REGISTERING AN ADAPTER cannot widen
 * what vigiles reads in someone else's repository, and an `@import` token is a
 * concrete path written by the REPOSITORY OWNER in their own instruction file.
 * The adapter only FINDS it; it does not choose it, which is exactly what (ii)
 * makes checkable. Leaving imports out would under-report the weight, and an
 * under-report reads as "you are fine" — the failure mode this whole feature
 * exists to prevent.
 */
import type { PluginLayout } from "./layout.js";

/** What a file IS to the harness that loads it. */
export type InstructionRole =
  /** The committed team file at a directory's root (`CLAUDE.md`, `AGENTS.md`). */
  | "root"
  /** One machine's file beside it (`CLAUDE.local.md`, `AGENTS.override.md`). */
  | "root-local"
  /** A file under {@link PluginLayout.rulesDir}. */
  | "rule"
  /** A repo-configured alternate name (Codex `project_doc_fallback_filenames`). */
  | "fallback"
  /** Reached through an `@path` token in a loaded file, not by location. */
  | "import";

/**
 * Team instruction (committed) or one machine's?
 *
 * 🔴 `"local"` IS READ AND LINTED, NEVER SCORED, and that is a decision with a
 * measurement behind it rather than a preference. The browser twin reads a
 * GitHub tree, so it can never see a gitignored file; any design that scored
 * one would put the CLI and the browser permanently out of agreement about the
 * same commit, and would make a published grade irreproducible between two
 * teammates. So the weight carries TWO numbers — `committedTotal` (what a
 * teammate or CI sees) and `effectiveTotal` (what this working copy actually
 * loads) — and only the first is judged against the budget.
 */
export type InstructionScope = "repo" | "local";

/** One file the harness loads, and what it is to it. */
export interface LoadedInstruction {
  /** Repo-relative POSIX path — always a key of the map that was handed in. */
  readonly path: string;
  readonly role: InstructionRole;
  readonly scope: InstructionScope;
  /**
   * Set only on `role: "import"` — WHO named this file, and with what text.
   *
   * 🔴 IT IS A FIELD AND NOT A PRINT-SITE LOOKUP BECAUSE THE READER CANNOT
   * DECOMPOSE THE NUMBER WITHOUT IT. `AGENTS.md` appearing in a CLAUDE CODE
   * weight looks like a bug — whether it got there by LOCATION or because
   * somebody wrote an import is a difference the size cannot show — and the only
   * thing that makes it legible, and actionable, is the line the user wrote:
   * `via @AGENTS.md in CLAUDE.md`. A total a reader cannot take apart is the
   * failure mode this whole report exists to prevent.
   */
  readonly via?: { readonly from: string; readonly token: string };
}

/**
 * Why a file the domain enumerated is NOT in the loaded chain.
 *
 * A tagged union so an unloaded entry WITHOUT a reason is unrepresentable.
 * That is what issue #262's `shadows` field was reaching for and could not be:
 * "shadowing" is not a semantic the core can own, because what differs between
 * harnesses is the COMBINATION RULE, not the fact of hiding — Claude Code
 * APPENDS `CLAUDE.local.md` after `CLAUDE.md` (both are in context), Codex takes
 * `AGENTS.override.md` INSTEAD OF `AGENTS.md`. The ordered `loaded` list already
 * expresses the first; `{kind:"replaced"}` expresses the second.
 */
export type NotLoadedReason =
  /** Another file took this directory's one slot — Codex reads at most one. */
  | { readonly kind: "replaced"; readonly by: string }
  /** Loaded only when the agent reads a matching file — never at launch. */
  | {
      readonly kind: "on-demand";
      readonly when: "path-scoped" | "subdirectory";
    }
  /** A repo setting removed it — Claude Code's `claudeMdExcludes`. */
  | { readonly kind: "excluded-by-settings"; readonly key: string }
  /**
   * A file of a DIFFERENT instruction family is present, and its presence turns
   * this whole family off — Claude Code reading `AGENTS.md` only when no
   * `CLAUDE.md` counts.
   *
   * 🔴 NOT THE SAME THING AS `replaced`, AND CONFLATING THEM WOULD LOSE THE ONE
   * FACT THAT MATTERS. `replaced` is Codex taking at most ONE file per
   * directory out of a same-named family, so the loser is a near-copy of the
   * winner in the same place. `superseded` is a cross-family switch: the
   * superseding file may sit in a different directory (`.claude/CLAUDE.md`),
   * carries entirely different content, and — the part `replaced` has no room
   * for — MAY NOT BE COMMITTED.
   *
   * 🔴 WHICH IS WHY `byScope` IS A FIELD AND NOT A LOOKUP AT THE PRINT SITE.
   * When the superseding file is `"local"`, a gitignored file has changed the
   * MEMBERSHIP of the load, not just its size: a teammate on the same commit
   * loads this file and this working copy does not. `weighInstructions` reads
   * exactly this field to keep `committedTotal` right in that case — see
   * `WeighedFile.supersededLocallyBy`. A consumer that only knew `by` would
   * have to re-derive the scope from the path, which is the "second list"
   * defect this redesign removes.
   */
  | {
      readonly kind: "superseded";
      /** The file whose presence did it. */
      readonly by: string;
      /** Whether that file is committed, or one machine's. */
      readonly byScope: InstructionScope;
    };

export interface UnloadedInstruction extends LoadedInstruction {
  readonly reason: NotLoadedReason;
}

/** A path a loaded file NAMES, the text that names it, and the file it is in. */
export interface NamedImport {
  /** The repo-relative path the token resolves to. */
  readonly path: string;
  /**
   * The token EXACTLY as the author wrote it (`@AGENTS.md`). Reported because
   * it is the thing the user can act on — they typed that line — and because it
   * is what the property test checks: a token must literally occur in `from`.
   */
  readonly token: string;
  /** The loaded file that names it. */
  readonly from: string;
}

/** A glob or URL a loaded file names, and the file that names it. */
export interface PatternFrom {
  readonly pattern: string;
  readonly from: string;
}

export interface InstructionChain {
  /** Loaded at a repo-root session, in the order the harness concatenates them. */
  readonly loaded: readonly LoadedInstruction[];
  /** Instruction-shaped keys this harness does NOT load, each with why. */
  readonly unloaded: readonly UnloadedInstruction[];
  /**
   * Concrete repo-relative paths the loaded files name as imports. The adapter
   * only reports them; the domain reads them in a second, bounded pass, and an
   * import that was named but not read is printed rather than dropped.
   */
  readonly imports: readonly NamedImport[];
  /**
   * Patterns or URLs the harness would expand at launch and the domain will NOT
   * walk (OpenCode's `instructions: ["packages/*\/AGENTS.md"]`). Reported so the
   * weight can say "plus N pattern(s) not weighed" instead of a number that is
   * silently wrong. Never read.
   */
  readonly patterns: readonly PatternFrom[];
  /**
   * A loaded file whose ENTIRE content is import tokens — a REDIRECT, not
   * instructions, and a finding rather than a footnote.
   *
   * 🔴 WHY THIS IS A NAMED SHAPE. Four of the six real imports in the measured
   * corpus are `@AGENTS.md`, written when Claude Code did not yet read
   * `AGENTS.md` natively (anthropics/claude-code#34235; it does since v2.1.277 —
   * see `adapters/claude-code/dialect.ts`), and the idiom that follows is a
   * `CLAUDE.md` holding that one line and nothing else. THE SHAPE DID NOT GO
   * AWAY WITH THE VENDOR CHANGE: those files are still in those repositories,
   * the `CLAUDE.md` beside them SUPPRESSES the `AGENTS.md`, and the vendor's own
   * table still gives the case a row. Reported as a size, such a repo has
   * a ~14-byte instruction file — a confident wrong answer about a repository
   * that really loads tens of kilobytes. The report says "this file is a
   * redirect, here is what it points at" instead of printing a reassuring
   * number.
   *
   * BINARY, NEVER A THRESHOLD: after the frontmatter, the HTML comments and the
   * blank lines are removed, EVERY remaining line is an import token. "Mostly
   * imports" would be a number nobody can defend.
   */
  readonly redirects: readonly {
    readonly path: string;
    readonly to: readonly string[];
  }[];
}

/** An empty chain — the answer for a harness with no instruction surface. */
export const EMPTY_CHAIN: InstructionChain = {
  loaded: [],
  unloaded: [],
  imports: [],
  patterns: [],
  redirects: [],
};

/**
 * The SHAPE of an instruction candidate — the domain's bound, stated the same
 * way `SURFACE_SHAPES` states the surface one, and for the same reason: if an
 * adapter could add a root we would be back to "registering an adapter widens
 * the read in everyone's repository".
 *
 * These are CROSS-VENDOR shapes, not one harness's paths. `rules` is the name
 * Claude Code (`.claude/rules`), Cursor (`.cursor/rules`) and Windsurf
 * (`.windsurf/rules`) all use; the dot-directory is the variable, the shape name
 * is not. Nothing here spells a harness's own directory.
 *
 * ⚠️ WHAT THIS CANNOT SEE, stated rather than assumed: a nested
 * `packages/x/AGENTS.md` (neither vendor loads it at a root session — the chain
 * classifies one as on-demand if it is handed one, and never goes looking);
 * `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and every other home-directory
 * file (reading `~` for a grade is wrong on its face); and a repo-configured
 * fallback instruction name that is not markdown, because the root entry below
 * is bounded to `.md` rather than to "every file in the repo root". That last
 * one under-reports, which is the wrong direction, and it is the price of not
 * reading a lockfile to grade a harness.
 */
export const INSTRUCTION_SHAPES: ReadonlyArray<{
  /** For messages and for the test that names each shape. */
  readonly what: string;
  /** Anchored, over repo-relative POSIX paths. */
  readonly re: RegExp;
}> = [
  { what: "root markdown", re: /^[^/]+\.md$/ },
  { what: "dot-directory markdown", re: /^\.[^/]+\/[^/]+\.md$/ },
  {
    what: "dot-directory rules tree",
    re: /^\.[^/]+\/rules\/(?:[^/]+\/)*[^/]+\.md$/,
  },
];

/**
 * The files that carry SETTINGS for one layout — the parse target and the
 * per-machine override beside it.
 *
 * 🔴 A SETTINGS SOURCE IS NOT AN INSTRUCTION, and keeping the two roles apart
 * is the whole point of this function having its own name. These files are
 * handed to `instructionChain` and are never weighed, never appear in `loaded`
 * and never get a `role`: they are not read TO the model, they decide WHICH
 * files are. Claude Code's `claudeMdExcludes` and Codex's
 * `project_doc_fallback_filenames` both live in one, which is why they are in
 * the bound at all.
 *
 * The `.local` sibling is DERIVED from `settingsPath` rather than listed,
 * because a second list is the defect this whole redesign removes. It is
 * advisory for the same reason `scope: "local"` is: it is gitignored by
 * convention, so the browser twin can never see it, and anything that DEPENDED
 * on it would make the two engines disagree. It can only narrow what loads.
 */
/**
 * `AGENTS.md` + `override` → `AGENTS.override.md`; `settings.json` + `local` →
 * `settings.local.json`. The ONE place the "sibling file" spelling lives.
 *
 * Both vendors name a per-machine file by inserting a word before the
 * extension, and they choose DIFFERENT words — Claude Code `local`, Codex
 * `override` — so the word is the argument and the spelling is not. A file with
 * no extension gets the word appended, which is the only reading that does not
 * invent a dot.
 */
export function siblingNamed(path: string, infix: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash && dot > slash + 1
    ? `${path.slice(0, dot)}.${infix}${path.slice(dot)}`
    : `${path}.${infix}`;
}

export function settingsSourcePaths(layout: PluginLayout): readonly string[] {
  return [layout.settingsPath, siblingNamed(layout.settingsPath, "local")];
}

/** Does this repo-relative path match one of the {@link INSTRUCTION_SHAPES}? */
export function isInstructionShaped(path: string): boolean {
  return INSTRUCTION_SHAPES.some((s) => s.re.test(path));
}

/**
 * The bounded candidate set: every path a harness may be ASKED about.
 *
 * Pure and storage-blind on purpose, exactly as `discoverSurfaces` is — the
 * disk walk (`src/surface-discovery-fs.ts`) and the browser file-map twin
 * (`src/scan-files.ts`) each enumerate from their own storage and call THIS for
 * the decision, so the pair cannot disagree about what is a candidate.
 */
export function instructionCandidatePaths(
  paths: readonly string[],
  layout: PluginLayout,
): readonly string[] {
  const named = new Set([
    layout.instructionFile,
    ...settingsSourcePaths(layout),
  ]);
  return paths.filter((p) => named.has(p) || isInstructionShaped(p));
}

/**
 * Is `token` a path this repo could hold, and safe to resolve against its root?
 *
 * Refuses an absolute path, a `~` home reference, and anything with a `..`
 * segment — an instruction file that points outside the repository is not a
 * fact about the repository, and following it would let a file decide what
 * vigiles opens on the machine running it.
 */
export function isRepoRootedImport(token: string): boolean {
  if (token === "" || token.startsWith("/") || token.startsWith("~")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(token) || token.includes("\\")) return false;
  return !token.split("/").includes("..");
}

/**
 * Where an `@import` token inside `from` actually points.
 *
 * 🔴 RELATIVE TO THE IMPORTING FILE, NOT TO THE REPOSITORY ROOT, and that is a
 * MEASUREMENT rather than a reading of the docs — Claude Code 2.1.278, fixture
 * `q3-relative` in `test/fixtures/instruction-chain-vendor/`. The case is built
 * so the answer cannot be "it found nothing": `.claude/CLAUDE.md` holds
 * `@notes.md` and BOTH candidates exist, each with its own codeword.
 *
 *   recited: SAIGA-8181 (`.claude/notes.md`)   not TAPIR-6262 (`notes.md`)
 *   hook:    .claude/notes.md  load_reason: include  parent: .claude/CLAUDE.md
 *
 * Resolving against the root instead reports that file unread and charges the
 * weight of a DIFFERENT file that happens to share its name — wrong in both
 * directions at once, and silent.
 *
 * ⚠️ A TOKEN WITH `..` STAYS REFUSED even though this resolution would make
 * some of them land inside the repository (`@../notes.md` from `.claude/`).
 * {@link isRepoRootedImport} rejects them before this is called, and lifting
 * that is a separate decision needing its own fixture: the refusal is what
 * stops an instruction file deciding what vigiles opens on the machine running
 * it, and "it happens to stay inside" is a property of one path, not a rule.
 */
export function resolveImportPath(from: string, token: string): string {
  const slash = from.lastIndexOf("/");
  const dir = slash === -1 ? "" : from.slice(0, slash + 1);
  // Normalise `./` away — `@./notes.md` and `@notes.md` are the same file, and
  // storing them as two keys would report one of them unread.
  const cleaned = token.replace(/^(\.\/)+/, "");
  return `${dir}${cleaned}`;
}

/**
 * Read the `@import` paths the loaded files NAME — ONE LEVEL, no recursion.
 * Returns a NEW map: the candidates handed in, plus whatever they named.
 *
 * 🔴 THIS READS OUTSIDE THE DOT-DIRECTORY BOUND, DELIBERATELY, AND THE REASON IS
 * WHO CHOSE THE PATH. The bound exists so that REGISTERING AN ADAPTER cannot
 * widen what vigiles reads in someone else's repository. An `@import` token is a
 * concrete path written by the REPOSITORY OWNER in their own instruction file;
 * the adapter only finds it, and `adapter-properties.test.ts` asserts exactly
 * that — every reported import literally occurs in the file that reports it.
 *
 * 🔴 ONE LEVEL IS A MEASUREMENT, NOT A SHORTCUT — DO NOT "IMPROVE" IT INTO A
 * RECURSIVE PASS. Across a corpus of 198 real `CLAUDE.md` files scraped from
 * public repositories (July sample; the grep finds `@name.md` shapes only),
 * exactly SIX files carried an import at all — 3%:
 *
 *     4  @AGENTS.md
 *     1  @docs/architecture.md
 *     1  @.maister/docs/INDEX.md
 *
 * Every one is a single concrete path at depth 1. Nothing in that corpus needs
 * recursion, a depth budget or an exclude pass, and a recursive walk driven by
 * strings found in files is the exact defect zernie/vigiles#262 is about.
 *
 * 🔴 AND THE SAME IS NOW MEASURED FOR `AGENTS.md`, WHICH USED TO BE THE HOLE IN
 * THIS BOUND. The corpus above is `CLAUDE.md` BY CONSTRUCTION, so it said
 * nothing about the family Claude Code reads natively since v2.1.277 — and a
 * one-level bound justified by a corpus that could not contain the file is not
 * justified, it is extrapolated. Measured over the same sample, by the same
 * method, carrying the same two caveats (July sample of public repositories;
 * the grep finds `@name.md` shapes only): 214 real `AGENTS.md` files, THREE
 * carry an import at all — 1.4%:
 *
 *     1  @tasks/BASED.md
 *     1  @ai-rules/rule-loading.md
 *     1  @AGENTS.local.md
 *
 * Every one is a single concrete path at depth 1 — the same SHAPE and the same
 * RARITY as the six on the `CLAUDE.md` side (3%). So one level is measured on
 * both families rather than assumed to carry over from one.
 *
 * ⏳ THE THIRD OF THOSE THREE IS NOT AN ORDINARY IMPORT, and it is an OPEN
 * QUESTION rather than a decided one: `AGENTS.local.md` is a name Claude Code
 * lists under "Not read", so an explicit `@` token names a file the loader may
 * never open. Both readings and the observation that settles them are at
 * `isNeverRead` in `adapters/claude-code/instruction-chain.ts` — one harness's
 * list belongs in one harness's adapter, not in the domain.
 *
 * ⚠️ AND THE VENDOR PUTS A NUMBER ON THE THING THIS BOUND APPROXIMATES, which
 * the measurement above does not repeal: "Imported files can recursively import
 * other files, with a maximum depth of FOUR HOPS" (same page, read 2026-09-21).
 * So one level is a bound on what this reads, chosen because neither corpus has
 * a second hop — not a claim that a second hop cannot exist. A repository that
 * uses them is under-reported by the nested size, and the honest form of that
 * is the sentence below rather than a depth counter nothing exercises.
 *
 * 🔴 AND THE SIX ARE WHERE THE NUMBER IS MOST WRONG WITHOUT THIS PASS. Four of
 * them are `@AGENTS.md` — the workaround for Claude Code not yet reading
 * `AGENTS.md` natively (anthropics/claude-code#34235; reversed in v2.1.277, see
 * `adapters/claude-code/dialect.ts`). Skipping imports would still miss that
 * file's whole size in exactly those repositories, because the vendor's rule is
 * that a `CLAUDE.md` SUPPRESSES `AGENTS.md` — so the import is the only way in,
 * and dropping it is an under-report, which reads as "you are fine".
 *
 * ⚠️ WHAT ONE LEVEL COSTS, stated rather than implied: a transitive import (an
 * imported file that imports again) is a real Claude Code feature, and its
 * nested size is NOT counted. NEITHER corpus — 198 `CLAUDE.md`, 214
 * `AGENTS.md`, 412 files, nine imports between them — holds one; if a real case
 * shows up, those measurements are the thing to redo, not this loop.
 */
export function resolveImports(
  layout: PluginLayout,
  files: Readonly<Record<string, string>>,
  read: (path: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...files };
  for (const { path } of layout.instructionChain(files).imports) {
    if (out[path] !== undefined || !isRepoRootedImport(path)) continue;
    const text = read(path);
    if (text !== undefined) out[path] = text;
  }
  return out;
}
