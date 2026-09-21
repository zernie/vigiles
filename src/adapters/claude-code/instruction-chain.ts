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
 */
function takeSubdirectories(b: Building, instructionFile: string): void {
  const named = new Set([...b.loaded, ...b.unloaded].map((e) => e.path));
  for (const path of Object.keys(b.files).sort()) {
    if (named.has(path) || !path.includes("/")) continue;
    if (path.slice(path.lastIndexOf("/") + 1) !== instructionFile) continue;
    b.unloaded.push({
      path,
      role: "root",
      scope: "repo",
      reason: { kind: "on-demand", when: "subdirectory" },
    });
  }
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
  takeRules(b, input.ruleRe);
  take(b, localSiblingOf(input.instructionFile), {
    role: "root-local",
    scope: "local",
  });
  takeSubdirectories(b, input.instructionFile);

  // THE IMPORTS PASS, ONE LEVEL. It reads a SNAPSHOT of what is loaded so far,
  // so a file pulled in by an import is not itself scanned for imports — see
  // `resolveImports` in the core for the corpus measurement behind that, and for
  // what it costs. Every path reported literally occurs in the file that names
  // it, which is the property that keeps this from being a widening the ADAPTER
  // chose rather than one the repo owner wrote.
  for (const entry of [...b.loaded]) takeImportsOf(b, entry);

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
