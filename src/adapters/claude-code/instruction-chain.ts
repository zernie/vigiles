/**
 * Claude Code's instruction chain — what a repo-root session loads without
 * being asked, in the order it is concatenated, and why each remaining
 * instruction-shaped file does not load.
 *
 * Every rule below is quoted from the vendor page
 * (`https://code.claude.com/docs/en/memory`, fetched 2026-09-21 and recorded
 * verbatim in zernie/vigiles#262) rather than paraphrased, because two of them
 * reverse what `alwaysLoaded` did:
 *
 * > All discovered files are **concatenated into context rather than overriding
 * > each other**. … Within each directory, `CLAUDE.local.md` is **appended
 * > after** `CLAUDE.md`, so your personal notes are the last thing Claude reads
 * > at that level.
 *
 * > Claude also discovers `CLAUDE.md` and `CLAUDE.local.md` files in
 * > subdirectories under your current working directory. Instead of loading
 * > them at launch, they are **included when Claude reads files in those
 * > subdirectories**.
 *
 * > If you work in a large monorepo where other teams' CLAUDE.md files get
 * > picked up, use `claudeMdExcludes` to skip them.
 *
 * So: local files load and are LAST; subdirectory files do NOT load at launch;
 * and the repository's own settings can remove a file from the chain. The glob
 * list this replaced got the first right by accident (it counted
 * `CLAUDE.local.md` into a published GRADE — see the scope rule), and had no
 * expression at all for the other two.
 *
 * ── AND `AGENTS.md`, WHICH REVERSES WHAT THIS ADAPTER USED TO CLAIM ─────────
 * Same page, same fetch (2026-09-21). Until v2.1.277 Claude Code read only
 * `CLAUDE.md`; it now reads `AGENTS.md` natively, and the switch between the
 * two families is a PRESENCE test, not a merge:
 *
 * > Claude Code can read `AGENTS.md` as your project instructions, so a
 * > repository already set up for other coding agents works without adding a
 * > `CLAUDE.md`, an import, or a setting.
 *
 * > By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in
 * > your working directory or above it. Here's which of your files count for
 * > that check:
 * > * **Count, so Claude reads them instead of `AGENTS.md`**: a `CLAUDE.md`,
 * >   `.claude/CLAUDE.md`, or `CLAUDE.local.md` in your working directory or
 * >   any directory above it
 * > * **Don't count, and keep loading alongside `AGENTS.md`**: your
 * >   `~/.claude/CLAUDE.md`, your organization's managed `CLAUDE.md`, and
 * >   `.claude/rules/` files
 *
 * > When none count, here's what Claude reads and how you can tell:
 * > * **At session start**: every `AGENTS.md` and `.claude/AGENTS.md` in your
 * >   working directory and the directories above it.
 * > * **As Claude works in subdirectories**: a subdirectory's `AGENTS.md`, when
 * >   Claude opens a file there with the Read tool and that subdirectory has
 * >   none of the three `CLAUDE.md` files of its own
 * > * **Inside each `AGENTS.md`**: `@path` imports are expanded,
 * >   `claudeMdExcludes` patterns apply, and subagents that skip project
 * >   instructions skip these files too
 * > * **Not read**: `AGENTS.local.md`, `AGENTS.override.md`, or anything under
 * >   a `.agents/` directory
 *
 * > Because `CLAUDE.local.md` counts, adding one to keep your own uncommitted
 * > instructions in a project that relies on `AGENTS.md` stops Claude from
 * > reading `AGENTS.md` for you.
 *
 * 🔴 THE LAST PARAGRAPH IS THE ONE THAT COSTS A NUMBER, not the first. A
 * GITIGNORED FILE CHANGES THE MEMBERSHIP OF THE LOAD, NOT ITS SIZE. Every other
 * per-machine effect in this module is additive — `CLAUDE.local.md` appends its
 * own bytes, so `effectiveTotal = committedTotal + locals` and the two numbers
 * only ever move apart upward. Here the local file SUBTRACTS a committed file:
 * a teammate on the same commit loads `AGENTS.md` and this working copy loads
 * nothing of it. The chain says so with {@link NotLoadedReason} `superseded`,
 * whose `byScope` is what lets `weighInstructions` keep BOTH totals right; a
 * design that only recorded "did not load" would have silently dropped a
 * committed file out of the committed total.
 *
 * ── THREE LIMITS, DECLARED RATHER THAN DISCOVERED LATER ─────────────────────
 *
 * ⚠️ 1. WHICH OF THE THREE MODES A SESSION RUNS IN IS NOT IN THE REPOSITORY.
 * The vendor's setting selects `claude-md-or-agents-md` (the default, and the
 * only one modelled here), `claude-md-and-agents-md` (both families load, so
 * nothing is superseded) or `managed-only`. It lives under the built-in
 * `agents-md` plugin's ID in `pluginConfigs`, and the page is explicit about
 * where that is read from:
 *
 * > Add it under the built-in `agents-md` plugin's ID in `pluginConfigs`, in
 * > `~/.claude/settings.json`, a `--settings` file, or managed settings.
 * > **Claude Code ignores it in project and local settings files.**
 *
 * A repository scan therefore CANNOT know the mode, and no file in the repo
 * says which: the same commit loads a different instruction set for two
 * different people. This is not a gap a better parse closes — the fact is not
 * in the scanned tree. It is stated at {@link supersederOf}, the line that
 * assumes the default, so a reader meets it where the assumption is made.
 *
 * ⚠️ 2. THE SUPPORT IS VERSION-GATED AND ABSENT IN SOME SESSIONS.
 *
 * > Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later. In
 * > some sessions, such as those on Amazon Bedrock or with telemetry disabled,
 * > Claude can't read `AGENTS.md`, so import it from a `CLAUDE.md` there
 * > instead.
 *
 * It ships as a built-in PLUGIN, so the same session also loses it under
 * `disableAllHooks` / `allowManagedHooksOnly`, with that plugin disabled, and
 * in the first session after an upgrade. The chain models a modern session with
 * the feature available; on an older or restricted one it OVER-reports
 * `AGENTS.md`, which is the safe direction (an under-report reads as "you are
 * fine").
 *
 * ⚠️ 3. A SUBDIRECTORY `AGENTS.md` IS ON DEMAND, and gets the treatment a
 * `paths:`-scoped rule gets, for the same reason — see {@link takeSubdirectories}.
 */
/**
 * 🔴 `minimatch` IS REQUIRED LAZILY, FOR THE REASON `core/markdown.ts` AND
 * `core/settings-codec.ts` RECORD: this module hangs off `claudeCodeLayout`,
 * and the layout is on the HOOK path, so a top-level import puts a glob parser
 * into the graph of every hook decision. Measured by
 * `src/hook-runtime-graph.test.ts` — 37 modules became 92 with this and the
 * markdown parser loaded eagerly, and that test names both so the regression
 * cannot return unnamed.
 */
type MinimatchCtor = typeof import("minimatch").Minimatch;
const Minimatch = (): MinimatchCtor =>
  (require("minimatch") as typeof import("minimatch")).Minimatch;

import type {
  InstructionChain,
  InstructionScope,
  LoadedInstruction,
  NamedImport,
  UnloadedInstruction,
} from "../../core/instruction-chain.js";
import {
  isRepoRootedImport,
  siblingNamed,
} from "../../core/instruction-chain.js";
import {
  frontmatterBody,
  readFrontmatter,
} from "../../core/frontmatter-read.js";
import { proseLines } from "../../core/markdown.js";

/**
 * The settings key that removes files from the chain, and the frontmatter key
 * that makes a rule load ON DEMAND instead of at launch. Both are Claude Code's
 * own words; they live here and nowhere in the core, which is the boundary the
 * `no-harness-names` lint polices.
 */
const EXCLUDES_KEY = "claudeMdExcludes";
const PATH_SCOPE_KEY = "paths";

/**
 * The cross-tool instruction filename Claude Code now reads natively — "Claude
 * Code can read `AGENTS.md` as your project instructions".
 *
 * 🔴 IT IS A LITERAL HERE, AND DELIBERATELY NOT A FIELD ON `PluginLayout`.
 * `layout.instructionFile` answers "which file does this harness WRITE and
 * own"; the answer is still `CLAUDE.md` — that is what `vigiles init` compiles
 * into and what `detect` scores on. `AGENTS.md` is a file this harness READS
 * and another harness owns, which is a different question, and putting it in
 * the layout would make `layoutClaims` say Claude Code claims `AGENTS.md` —
 * i.e. two registered adapters claiming the same path, which is the collision
 * `claims` exists to prevent. So it lives beside {@link EXCLUDES_KEY} and
 * {@link PATH_SCOPE_KEY}: Claude Code's own words, in Claude Code's adapter,
 * and nowhere in the core.
 */
const AGENTS_FILE = "AGENTS.md";

/** The directory the vendor names in its "Not read" list. */
const AGENTS_DIR = ".agents";

/**
 * Cross-tool instruction files Claude Code NEVER reads, at any depth. Vendor:
 *
 * > **Not read**: `AGENTS.local.md`, `AGENTS.override.md`, or anything under a
 * > `.agents/` directory.
 *
 * 🔴 A NAMED PREDICATE BECAUSE THE DEFAULT IS WRONG FOR THIS FAMILY, and it is
 * wrong QUIETLY. {@link takeSubdirectories} recognises an instruction file by
 * its LEAF NAME, so `.agents/AGENTS.md` — which the domain's bound really does
 * enumerate, it is dot-directory markdown — would come out classified
 * "on-demand". The number is the same either way (an on-demand file weighs
 * nothing), so no total would move and nothing would go red; only the printed
 * REASON would be a confident wrong answer about a file the harness will never
 * open. That is the class this whole module exists to remove.
 *
 * The two sibling names are DERIVED through the one `siblingNamed` spelling
 * rather than written out, for the reason {@link localSiblingOf} is derived: a
 * second literal is a second thing to keep in step.
 *
 * ⚠️ WHAT THIS DOES NOT DO, stated rather than discovered later: a file it
 * refuses is named by NOTHING — it appears in neither `loaded` nor `unloaded`.
 * `NotLoadedReason` has no member for "this harness never reads this name", and
 * inventing one for a single vendor sentence would put a branch into every
 * consumer of the union for a file that weighs nothing. Silence here is the
 * same answer the bound already gives every non-instruction file.
 */
function isNeverRead(path: string): boolean {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return (
    path.startsWith(`${AGENTS_DIR}/`) ||
    leaf === siblingNamed(AGENTS_FILE, "local") ||
    leaf === siblingNamed(AGENTS_FILE, "override")
  );
}

/**
 * `@path/to/file.md` — how Claude Code names another file from inside an
 * instruction file.
 *
 * 🔴 THIS IS A MODEL OF A LOADER, NOT A PARSE OF A FORMAT, and a reader who
 * misses that will "fix" it in the wrong direction. `@path` is not in CommonMark
 * or in any other specification, so there is no authority to parse against:
 * markdown-it hands back `@AGENTS.md` as ordinary TEXT, correctly, because to
 * markdown it is ordinary text. What we assume, stated so it can be argued with:
 * a leading `@` followed by a path, written in PROSE (never inside a code fence
 * or a code span), naming a markdown file. Anything beyond that — how the real
 * loader treats a path relative to the importing file, a `~` reference, a
 * recursive import — is inferred from the vendor documentation and from a
 * 198-file corpus of public `CLAUDE.md`s, and a divergence from the real loader
 * is discoverable only by OBSERVING it, never by reading a grammar.
 *
 * The narrowness is measured rather than cautious. A loose `@` pattern over that
 * corpus matches Python decorators, Blade templates, npm scopes and CSS at-rules
 * — all of them inside fenced code blocks, which {@link proseLines} removes
 * before this pattern ever runs. Requiring a `.md` tail on top keeps
 * `email me @ foo` and a prose `@dataclass` out. A token this refuses is simply
 * not reported, which under-reports by that file's size; a token it wrongly
 * accepted would make vigiles open a path the repo did not mean to name, and
 * only one of those two is a safety question.
 */
const IMPORT_TOKEN = /(?:^|\s)(@[A-Za-z0-9_.][^\s]*\.md)\b/g;

/** A prose line that is NOTHING BUT one import token — the redirect shape. */
const ONLY_IMPORT = /^@[A-Za-z0-9_.][^\s]*\.md$/;

/**
 * The author's own prose, with the frontmatter, the code and the comments gone.
 *
 * Both halves come from the modules that own them — `frontmatterBody` from the
 * frontmatter reader, {@link proseLines} from the ONE markdown-structure helper
 * — rather than from a line-splitting loop here. The helper's own header records
 * why: the hand-rolled fence toggle it replaced had been copy-pasted into five
 * detectors and is wrong on nested and unbalanced fences, which is exactly the
 * `@dataclass`-inside-a-code-block case this has to get right.
 *
 * Indentation, CRLF, trailing whitespace, trailing blank lines and a UTF-8 BOM
 * are all handled THERE, measured; `instruction-chain.test.ts` names each of
 * those spellings as its own case anyway, because they are the ratchet that
 * proves this path still goes through the parser after the next edit.
 */
function contentLines(text: string): readonly string[] {
  return proseLines(frontmatterBody(text));
}

/** Every `@import` token in one file, deduplicated, in first-seen order. */
function importTokens(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of contentLines(text)) {
    for (const m of line.matchAll(IMPORT_TOKEN)) {
      const token = m[1];
      if (token !== undefined && !out.includes(token)) out.push(token);
    }
  }
  return out;
}

/**
 * Is this file NOTHING BUT imports — a redirect rather than instructions?
 *
 * Binary, never a threshold: every prose line is a bare import token, and there
 * is at least one. "Mostly imports" would be a number nobody can defend, and an
 * empty file is empty rather than a redirect.
 */
function isPureRedirect(text: string): boolean {
  const lines = contentLines(text);
  return lines.length > 0 && lines.every((line) => ONLY_IMPORT.test(line));
}

/**
 * The `claudeMdExcludes` patterns this chain can APPLY, compiled.
 *
 * ⚠️ THE VENDOR MATCHES THESE AGAINST ABSOLUTE PATHS and the chain is handed
 * repo-relative keys, so a pattern anchored at the filesystem root cannot be
 * applied here at all. Rather than guess a root, only the `**\/`-prefixed form
 * is applied — that leading segment matches zero or more directories, so such a
 * pattern means the same thing against an absolute path and against a
 * repo-relative one, which is exactly the subset that needs no root. Every other
 * pattern is left UNAPPLIED, which counts a file that would not have loaded.
 * That over-reports, and over-reporting is the safe direction: an under-report
 * reads as "you are fine", which is the failure this feature exists to prevent.
 *
 * Matching is `minimatch`, the parser the rest of this repo's exclusion policy
 * already uses (`src/exclude.ts`) — a glob is a LANGUAGE, and hand-rolling a
 * second interpreter for it is precisely the defect being removed here.
 */
function compileExcludes(
  settings: readonly string[],
): readonly InstanceType<MinimatchCtor>[] {
  if (settings.length === 0) return [];
  const ctor = Minimatch();
  return settings
    .filter((p) => p.startsWith("**/"))
    .map((p) => new ctor(p, { dot: true }));
}

/** `claudeMdExcludes` from one settings file's text, or `[]` if it says nothing. */
function excludesIn(
  text: string | undefined,
  parse: (t: string) => Record<string, unknown>,
): readonly string[] {
  if (text === undefined) return [];
  let value: Record<string, unknown>;
  try {
    value = parse(text);
  } catch {
    // A settings file mid-merge or mid-edit must not decide which instructions
    // load. Reporting "nothing is excluded" over-reports, the safe direction.
    return [];
  }
  const raw = value[EXCLUDES_KEY];
  return Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string")
    : [];
}

/** Does this rule file declare a `paths:` scope — i.e. load only on demand? */
function isPathScoped(text: string): boolean {
  const { data } = readFrontmatter(text);
  return data !== null && Object.hasOwn(data, PATH_SCOPE_KEY);
}

/** Inputs the layout supplies so this module names no path of its own. */
export interface ClaudeCodeChainInput {
  /** `CLAUDE.md`. */
  readonly instructionFile: string;
  /** `.claude`. */
  readonly userSurfaceRoot: string;
  /** The settings files, in precedence order (repo, then the local sibling). */
  readonly settingsPaths: readonly string[];
  /** The layout's own codec — this module does not know the encoding. */
  readonly parseSettings: (text: string) => Record<string, unknown>;
  /** {@link RULE_FILE_LEAF_RE}, compiled against the rules dir. */
  readonly ruleRe: RegExp;
}

/**
 * `CLAUDE.md` → `CLAUDE.local.md`: the per-machine sibling, DERIVED so the two
 * names cannot drift apart the way a second constant would.
 */
export function localSiblingOf(instructionFile: string): string {
  return siblingNamed(instructionFile, "local");
}

/** The mutable halves of a chain under construction, shared by the passes. */
interface Building {
  readonly files: Readonly<Record<string, string>>;
  readonly loaded: LoadedInstruction[];
  readonly unloaded: UnloadedInstruction[];
  readonly imports: NamedImport[];
  readonly isExcluded: (path: string) => boolean;
}

/** Into `loaded`, or into `unloaded` with the settings reason; absent → nothing. */
function take(
  b: Building,
  path: string,
  entry: Omit<LoadedInstruction, "path">,
): void {
  if (b.files[path] === undefined) return;
  if (b.isExcluded(path)) {
    b.unloaded.push({
      path,
      ...entry,
      reason: { kind: "excluded-by-settings", key: EXCLUDES_KEY },
    });
    return;
  }
  b.loaded.push({ path, ...entry });
}

/**
 * Every file under the rules dir: loaded, unless it declares a `paths:` scope.
 *
 * 🔴 THE CLAUDE CODE OVER-REPORT, FIXED HERE. A `paths:`-scoped rule is included
 * when Claude reads a matching file, not at launch, so counting it as
 * always-loaded inflated the one number this whole feature reports. Sorted by
 * path for determinism; the vendor states that the files are concatenated, not
 * in which order the project-scope ones arrive.
 */
function takeRules(b: Building, ruleRe: RegExp): void {
  for (const path of Object.keys(b.files).sort()) {
    if (!ruleRe.test(path)) continue;
    const text = b.files[path];
    if (text === undefined) continue;
    if (isPathScoped(text)) {
      b.unloaded.push({
        path,
        role: "rule",
        scope: "repo",
        reason: { kind: "on-demand", when: "path-scoped" },
      });
      continue;
    }
    take(b, path, { role: "rule", scope: "repo" });
  }
}

/**
 * A subdirectory's own instruction file, IF the caller handed one over.
 *
 * The domain's bound never enumerates one ({@link INSTRUCTION_SHAPES}), so this
 * is reached only by a caller holding a wider map — and then the honest answer
 * is "included when Claude reads files in those subdirectories", not "always".
 *
 * 🔴 `AGENTS.md` GETS THE SAME TREATMENT AS A `paths:`-SCOPED RULE, and the
 * vendor puts the two in the same list for the same reason — neither is read at
 * launch: "As Claude works in subdirectories: a subdirectory's `AGENTS.md`,
 * when Claude opens a file there with the Read tool". Counting one would inflate
 * the single number this feature exists to report, which is the over-report
 * `alwaysLoaded` shipped.
 *
 * ⚠️ WHAT IS NOT MODELLED, and it is a CONDITION rather than a file: the vendor
 * adds "and that subdirectory has none of the three `CLAUDE.md` files of its
 * own", so a nested `AGENTS.md` beside a nested `CLAUDE.md` is never read at
 * all rather than read on demand. Both answers keep it out of the weight, so
 * the number is the same either way; the REASON printed would differ. Deciding
 * it would mean running the supersede test per directory over a map the bound
 * never enumerates, so it is declared instead of guessed.
 *
 * `reserved` holds the paths this chain owns at the root level. Without it, a
 * `.claude/AGENTS.md` that the supersede pass has not yet classified would be
 * read as a SUBDIRECTORY file, because it has a slash and the right basename —
 * and the dot-directory is not a subdirectory of the project in the vendor's
 * sense. It is empty-set-safe: every root candidate is already in `named` on
 * the paths that reach this today.
 */
function takeSubdirectories(
  b: Building,
  leafNames: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): void {
  const named = new Set([...b.loaded, ...b.unloaded].map((e) => e.path));
  for (const path of Object.keys(b.files).sort()) {
    if (named.has(path) || reserved.has(path) || !path.includes("/")) continue;
    if (isNeverRead(path)) continue;
    if (!leafNames.has(path.slice(path.lastIndexOf("/") + 1))) continue;
    b.unloaded.push({
      path,
      role: "root",
      scope: "repo",
      reason: { kind: "on-demand", when: "subdirectory" },
    });
  }
}

/** One of the three files whose presence turns `AGENTS.md` off, and its scope. */
interface Superseder {
  readonly path: string;
  readonly scope: InstructionScope;
}

/**
 * Which file, if any, stops this repository's `AGENTS.md` being read — vendor:
 * "a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` in your working
 * directory or any directory above it".
 *
 * 🔴 PRESENCE, NOT LOADING, and the two come apart in one case the vendor does
 * not address. A `CLAUDE.md` the repo's own `claudeMdExcludes` removes from the
 * chain is still a `CLAUDE.md` in the working directory, so this reads the MAP
 * rather than `b.loaded`. The vendor text is a statement about files that
 * EXIST; treating an excluded one as absent would be a paraphrase of it, and we
 * do not paraphrase a vendor rule to reach a nicer answer.
 *
 * ⚠️ SO THIS IS AN OPEN QUESTION, NOT A SETTLED ONE: in a repo that excludes its
 * own `CLAUDE.md` and ships an `AGENTS.md`, we say the `AGENTS.md` is
 * superseded, and the real loader may well read it. That direction UNDER-reports
 * — the wrong direction by this module's own policy — and it is taken anyway
 * because the alternative is inventing a rule the vendor has not written. It is
 * closed by OBSERVING a session with both files, not by re-reading the page.
 *
 * 🔴 A COMMITTED SUPERSEDER WINS OVER THE PER-MACHINE ONE, and the order of
 * this array is the whole of that rule. Both can be present; picking the local
 * file then would put `AGENTS.md` into `committedTotal`, claiming a teammate
 * loads it — but that teammate has the `CLAUDE.md`, so they do not. The
 * per-machine file is therefore last, and only answers when nothing committed
 * did.
 *
 * ⚠️ THIS ASSUMES THE DEFAULT MODE, AND THE REPOSITORY CANNOT CONFIRM IT. The
 * vendor's `claude-md-or-agents-md` (default) is what supersedes at all;
 * `claude-md-and-agents-md` loads both families and supersedes nothing, and
 * `managed-only` loads neither. The setting is read only from user-level, a
 * `--settings` file or managed settings — "Claude Code ignores it in project
 * and local settings files" — so a repo scan cannot see it, and the same
 * commit therefore loads a different instruction set for two different people
 * with no file in the tree saying which. Nothing in this function can close
 * that; it is the module header's limit 1, restated at the line that assumes.
 *
 * ⚠️ AND THE THREE NON-COUNTING FILES ARE ABSENT BY CONSTRUCTION, not by an
 * omission: `~/.claude/CLAUDE.md` and a managed `CLAUDE.md` are outside a
 * repository audit entirely (reading `~` for a grade is wrong on its face), and
 * `.claude/rules/` files "keep loading alongside `AGENTS.md`" — they are taken
 * by {@link takeRules} in both modes and are not consulted here. Stated because
 * a reader who adds the rules dir to this array would turn `AGENTS.md` off in
 * every repository that has one.
 */
function supersederOf(
  files: Readonly<Record<string, string>>,
  input: ClaudeCodeChainInput,
): Superseder | undefined {
  const candidates: readonly Superseder[] = [
    { path: input.instructionFile, scope: "repo" },
    {
      path: `${input.userSurfaceRoot}/${input.instructionFile}`,
      scope: "repo",
    },
    { path: localSiblingOf(input.instructionFile), scope: "local" },
  ];
  return candidates.find((c) => files[c.path] !== undefined);
}

/** One loaded file's `@import` tokens: reported, and TAKEN when already present. */
function takeImportsOf(b: Building, entry: LoadedInstruction): void {
  const text = b.files[entry.path];
  if (text === undefined) return;
  const known = new Set([...b.loaded, ...b.unloaded].map((e) => e.path));
  for (const token of importTokens(text)) {
    // The token as WRITTEN carries the `@`; the path is what it resolves to.
    const path = token.slice(1);
    if (!isRepoRootedImport(path)) continue;
    if (!b.imports.some((n) => n.path === path && n.from === entry.path)) {
      b.imports.push({ path, token, from: entry.path });
    }
    if (b.files[path] === undefined || known.has(path)) continue;
    // The importer's scope is INHERITED: a committed file pulled in only by
    // `CLAUDE.local.md` does not load for a teammate, so it must not be in the
    // committed total either. And `via` travels with it, so the report can say
    // WHY a file nobody expected is in the count.
    take(b, path, {
      role: "import",
      scope: entry.scope,
      via: { from: entry.path, token },
    });
  }
}

export function claudeCodeInstructionChain(
  files: Readonly<Record<string, string>>,
  input: ClaudeCodeChainInput,
): InstructionChain {
  const excluded = compileExcludes(
    input.settingsPaths.flatMap((p) =>
      excludesIn(files[p], input.parseSettings),
    ),
  );
  const b: Building = {
    files,
    loaded: [],
    unloaded: [],
    imports: [],
    isExcluded: (path) => excluded.some((m) => m.match(path)),
  };

  // ORDER. The one ordering fact the vendor states is that the local file is
  // LAST — "the last thing Claude reads at that level" — so it is taken after
  // the rules rather than beside the root file it is named for.
  take(b, input.instructionFile, { role: "root", scope: "repo" });
  take(b, `${input.userSurfaceRoot}/${input.instructionFile}`, {
    role: "root",
    scope: "repo",
  });

  // THE CROSS-FAMILY SWITCH. "At session start: every `AGENTS.md` and
  // `.claude/AGENTS.md` in your working directory" — but only "when you have no
  // CLAUDE.md in your working directory or above it". Both spellings, in the
  // same root-then-dot-directory order as the two takes above; the vendor states
  // no order BETWEEN them, and it cannot matter to a sum.
  const superseder = supersederOf(files, input);
  const crossToolPaths = [
    AGENTS_FILE,
    `${input.userSurfaceRoot}/${AGENTS_FILE}`,
  ];
  if (superseder === undefined) {
    for (const path of crossToolPaths) {
      take(b, path, { role: "root", scope: "repo" });
    }
  }

  takeRules(b, input.ruleRe);
  take(b, localSiblingOf(input.instructionFile), {
    role: "root-local",
    scope: "local",
  });
  takeSubdirectories(
    b,
    new Set([input.instructionFile, AGENTS_FILE]),
    new Set(crossToolPaths),
  );

  // THE IMPORTS PASS, ONE LEVEL. It reads a SNAPSHOT of what is loaded so far,
  // so a file pulled in by an import is not itself scanned for imports — see
  // `resolveImports` in the core for the corpus measurement behind that, and for
  // what it costs. Every path reported literally occurs in the file that names
  // it, which is the property that keeps this from being a widening the ADAPTER
  // chose rather than one the repo owner wrote.
  //
  // 🔴 IT RUNS BEFORE THE SUPERSEDE VERDICT, AND THAT ORDER IS A VENDOR ROW
  // RATHER THAN A CONVENIENCE. The third row of the vendor's own table reads:
  // "A `CLAUDE.md` that already imports `AGENTS.md`" → "Your `CLAUDE.md`, with
  // `AGENTS.md` included through the import". So the idiom four of the six real
  // imports in the measured corpus use — a `CLAUDE.md` holding `@AGENTS.md` —
  // still LOADS that file, and marking it superseded first would have deleted
  // the whole redirect finding. Both passes see `known`, so whichever gets there
  // first owns the entry; this one is meant to.
  //
  // It also settles the two vendor sentences about what happens INSIDE an
  // `AGENTS.md` at no extra cost, because both passes are role-blind: "`@path`
  // imports are expanded" is this loop over any loaded entry, and
  // "`claudeMdExcludes` patterns apply" is `take` above. Asserted rather than
  // assumed — `instruction-chain.test.ts` runs each against an `AGENTS.md` that
  // got in as a ROOT file, since a role-keyed version of either would pass every
  // `CLAUDE.md` case and fail exactly those two.
  for (const entry of [...b.loaded]) takeImportsOf(b, entry);

  // THE VERDICT, LAST: anything cross-tool that the passes above did not claim
  // is present, unread, and the reason is a file rather than a setting. `scope`
  // stays `"repo"` — this IS a committed file — and `byScope` carries whether
  // the thing that silenced it is committed too, which is what decides whether a
  // teammate loads it. See `weighInstructions`.
  if (superseder !== undefined) {
    const named = new Set([...b.loaded, ...b.unloaded].map((e) => e.path));
    for (const path of crossToolPaths) {
      if (b.files[path] === undefined || named.has(path)) continue;
      b.unloaded.push({
        path,
        role: "root",
        scope: "repo",
        reason: {
          kind: "superseded",
          by: superseder.path,
          byScope: superseder.scope,
        },
      });
    }
  }

  return {
    loaded: b.loaded,
    unloaded: b.unloaded,
    imports: b.imports,
    patterns: [],
    // A loaded file that is NOTHING BUT imports is a redirect, not instructions
    // — reported as a shape so the report can say so instead of printing the
    // reassuring size of a fourteen-byte pointer.
    redirects: b.loaded.flatMap((entry) => {
      const text = files[entry.path];
      if (text === undefined || !isPureRedirect(text)) return [];
      const to = b.imports
        .filter((i) => i.from === entry.path)
        .map((i) => i.path);
      return to.length === 0 ? [] : [{ path: entry.path, to }];
    }),
  };
}
