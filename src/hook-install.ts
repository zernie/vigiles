/**
 * Hook installation — the bridge from a typed hook program to a wired harness,
 * folded into `vigiles compile` (there is no stray `compile-hook` verb; the
 * cohesive-cli-surface rule).
 *
 * The typed hook program is harness-NEUTRAL — it imports `vigiles/hook` and
 * compiles to whatever harness — so its SOURCE lives in the agnostic,
 * committed {@link HOOKS_DIR} (`.vigiles/hooks/`), never in a harness's own
 * `.claude/`. `compile` discovers each hook there — a hook is a `.hook.` file
 * and nothing else, decided by `source-kinds.ts` — compiles it, and MERGES the
 * result into the active harness's native config (`.claude/settings.json` JSON
 * / `config.toml` TOML) — so the harness is actually wired, not handed a
 * paste-this block. The merge is idempotent: an entry is keyed by the runtime
 * command's hook path, CANONICALIZED ({@link normalizeHookRef}) so it identifies
 * the FILE rather than the string the user typed — recompiling updates in place
 * and never duplicates, while a user's own hand-written hooks are preserved
 * untouched. One source dir also means basenames are unique, so the stamp can key
 * on the basename safely.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  baseName,
  classifySource,
  dirName,
  markedName,
  preMarkerName,
  type CompilableMarker,
  type SourceKind,
} from "./source-kinds.js";

/**
 * Lazy for the same reason as in `core/hook-program.ts` — and this module is
 * reached from the hook runtime through `hook-state-store.ts` (`normalizeHookRef`),
 * so a top-level import here put `@iarna/toml` back into the graph of every hook
 * decision even after that one was fixed. Measured 2026-09-08: 56 ms per spawn.
 */
const stringifyToml = (value: unknown): string =>
  (require("@iarna/toml") as typeof import("@iarna/toml")).stringify(
    value as never,
  );

/** The agnostic, committed home for hook SOURCE — one dir, cross-adapter. */
export const HOOKS_DIR = ".vigiles/hooks";

/** The committed home for registered context-provider SOURCE (v2). */
export const PROVIDERS_DIR = ".vigiles/providers";

/** What discovery found in one source directory, split by what `compile` owes each part. */
export interface Discovered {
  /** Files this directory's role compiles: `.hook.` files in `.vigiles/hooks/`, `.provider.` files in `.vigiles/providers/`. */
  readonly claimed: readonly string[];
  /**
   * Runnable files nothing claims here. `compile` REFUSES these out loud
   * ({@link unclaimedMessage}); dropping them would make a hook that lost its
   * marker vanish from the build without a word.
   */
  readonly unclaimed: readonly string[];
}

/** What a directory does with one kind of file. */
type Claim = "claim" | "refuse" | "leave";

/**
 * The ONE place a directory's role meets {@link SourceKind}. The `switch` is
 * exhaustive, so a kind added to the table in `source-kinds.ts` is a compile
 * error here until someone decides what hooks and providers do with it.
 *
 * `leave` is for files that are in these directories on purpose and are none of
 * `compile`'s business: tests, declarations, stamps, a README.
 */
function claimOf(role: CompilableMarker, found: SourceKind): Claim {
  switch (found.kind) {
    case "hook":
    case "provider":
      // A provider in the hooks directory is as unclaimed as a stray helper:
      // nothing here would ever load it, and saying so beats a silent miss.
      return found.kind === role ? "claim" : "refuse";
    case "unclaimed":
      return "refuse";
    case "vigiles-test":
    case "declaration":
    case "stamp":
    case "non-source":
      return "leave";
  }
}

/** List the files under `dir` (relative to cwd), split by what `role` does with each. */
function discoverSources(
  cwd: string,
  dir: string,
  role: CompilableMarker,
): Discovered {
  const abs = join(cwd, dir);
  if (!existsSync(abs)) return { claimed: [], unclaimed: [] };
  const verdicts = readdirSync(abs)
    .sort()
    .map((f) => ({
      path: join(dir, f),
      claim: claimOf(role, classifySource(f)),
    }));
  const pick = (want: Claim): string[] =>
    verdicts.filter((v) => v.claim === want).map((v) => v.path);
  return { claimed: pick("claim"), unclaimed: pick("refuse") };
}

/** Discover hook sources under {@link HOOKS_DIR}: `.hook.` files, and the runnable files that are nobody's. */
export function discoverHookFiles(cwd: string): Discovered {
  return discoverSources(cwd, HOOKS_DIR, "hook");
}

/** Discover registered-provider sources under {@link PROVIDERS_DIR}. */
export function discoverProviderFiles(cwd: string): Discovered {
  return discoverSources(cwd, PROVIDERS_DIR, "provider");
}

/** Why an explicit `compile` argument is an error rather than a hook, a refusal or a skip. */
export type InvalidArgReason = "missing" | "directory" | "not-a-source";

/** What `vigiles compile <files…>` makes of the paths it was handed. */
export interface HookArgs {
  readonly hooks: readonly string[];
  /** Runnable files nothing claims (or a marked file in the wrong directory): refused, with the fix. */
  readonly unclaimed: readonly string[];
  /** Named on purpose, not compilable (a test, a stamp…): said out loud, not an error. */
  readonly skipped: readonly {
    readonly path: string;
    readonly kind: SourceKind["kind"];
  }[];
  /** Not a file at all, or not a source: an error, the way it always was. */
  readonly invalid: readonly {
    readonly path: string;
    readonly reason: InvalidArgReason;
  }[];
}

/** What the file system says a path is. Injected so the rules below stay pure. */
export type PathProbe = (
  path: string,
) => "file" | "directory" | "missing" | "other";

const realProbe: PathProbe = (path) => {
  const st = statSync(resolve(process.cwd(), path), { throwIfNoEntry: false });
  if (st === undefined) return "missing";
  return st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
};

/** Is `path` directly inside `dir` (a repo-relative POSIX dir), either separator, any prefix? */
function insideDir(path: string, dir: string): boolean {
  const parent = dirName(path)
    .replace(/\\/g, "/")
    .replace(/\/$/, "")
    .replace(/^\.\//, "");
  return parent === dir || parent.endsWith(`/${dir}`);
}

/**
 * Sort explicit `compile` arguments by the same classifier discovery uses, so
 * `compile guard.mjs` and a bare `compile` give the same answer about it — for a
 * path ANYWHERE, not just under `.vigiles/hooks/`: `compile .claude/hooks/x.mjs`
 * or a plugin's `hooks/guard.mjs` is refused unless it carries `.hook.`.
 *
 * A path that is missing, a directory or not a regular file is an error (it used
 * to fail, and the first version of the marker rule turned it into a green run).
 * The one lenient case exists for a shell glob (`compile .vigiles/hooks/*`): a
 * test, declaration or stamp is reported as skipped, and so is a README or
 * `.gitkeep` — but only inside the two vigiles source directories, where a glob
 * would sweep one up. A `/etc/passwd` is not a README.
 */
export function partitionHookArgs(
  args: readonly string[],
  probe: PathProbe = realProbe,
): HookArgs {
  const hooks: string[] = [];
  const unclaimed: string[] = [];
  const skipped: { path: string; kind: SourceKind["kind"] }[] = [];
  const invalid: { path: string; reason: InvalidArgReason }[] = [];
  for (const path of args) {
    const what = probe(path);
    if (what === "missing" || what === "directory") {
      invalid.push({ path, reason: what });
      continue;
    }
    if (what === "other") {
      invalid.push({ path, reason: "not-a-source" });
      continue;
    }
    const found = classifySource(baseName(path));
    switch (found.kind) {
      case "hook":
        hooks.push(path);
        break;
      case "unclaimed":
        unclaimed.push(path);
        break;
      case "provider":
        // Valid, and compile validates providers whenever it compiles a hook —
        // except in the hooks directory, where nothing would ever load it.
        if (insideDir(path, HOOKS_DIR)) unclaimed.push(path);
        else skipped.push({ path, kind: found.kind });
        break;
      case "vigiles-test":
      case "declaration":
      case "stamp":
        skipped.push({ path, kind: found.kind });
        break;
      case "non-source":
        if (insideDir(path, HOOKS_DIR) || insideDir(path, PROVIDERS_DIR))
          skipped.push({ path, kind: found.kind });
        else invalid.push({ path, reason: "not-a-source" });
        break;
    }
  }
  return { hooks, unclaimed, skipped, invalid };
}

/** The line `compile` prints for an argument it cannot treat as a hook source at all. */
export function invalidArgMessage(
  path: string,
  reason: InvalidArgReason,
): string {
  switch (reason) {
    case "missing":
      return `${path} — no such file.`;
    case "directory":
      return `${path} — is a directory. Name hook files, or run \`vigiles compile\` with no arguments to discover them.`;
    case "not-a-source":
      return `${path} — not a hook source (a hook is a \`<name>.hook.<ext>\` file).`;
  }
}

/**
 * Discovery, shaped like {@link partitionHookArgs}'s answer, so `compile` handles
 * "no arguments" and "these paths" through one code path afterwards.
 */
export function discoveredHookArgs(cwd: string): HookArgs {
  const { claimed, unclaimed } = discoverHookFiles(cwd);
  return { hooks: claimed, unclaimed, skipped: [], invalid: [] };
}

/** POSIX single-quote one word: safe for any file name, a newline and `$(…)` included. */
const shq = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The ONE shell command that renames an unclaimed file to its marked name and
 * (for a hook) recompiles it. Every path is single-quoted: this is printed by a
 * tool and pasted by a person, and a repository can plant a file name that is a
 * command.
 *
 * 🔴 THE HOOK COMMAND COPIES FIRST AND DELETES LAST, and that order is the
 * point. Already-wired hooks keep running after an upgrade: the runtime loads
 * whatever path `settings.json` names, and never asks what a file is called. So
 * the break is the NEXT compile, and a plain `mv` + `compile` has one bad
 * moment — the old path is gone and the wiring still names it. For a gate
 * wired `|| exit 2` that is a hook that cannot load, which blocks every Bash
 * call (the repair is a file write, not a command). Compiling the renamed copy
 * while the old file still exists, and deleting the old one only after that
 * compile succeeded, has no such moment: if anything fails the old hook is
 * still on disk and still wired. `compile` replaces the old wiring itself
 * ({@link ownedRefs}), so nothing is left naming the deleted path.
 *
 * 🔴 `cp -n`, because the marked name may already exist: a plain `cp` replaced
 * an edited `guard.hook.mjs` with the stale `guard.mjs`, and the weaker hook
 * became the wired gate. {@link unclaimedMessage} checks first and prints no
 * command at all in that case; `-n` is for the file that appears in between.
 */
export function renameCommand(path: string, role: CompilableMarker): string {
  const target = markedName(path, role);
  switch (role) {
    case "hook":
      return (
        `cp -n -- ${shq(path)} ${shq(target)} && ` +
        `npx vigiles compile ${shq(target)} && ` +
        `rm -f -- ${shq(path)} ${shq(`${HOOKS_DIR}/${basename(path)}.json`)}`
      );
    case "provider":
      return `mv -n -- ${shq(path)} ${shq(target)}`;
  }
}

/**
 * {@link unclaimedMessage} with the one fact it cannot know, read off the disk:
 * whether the marked name is already there.
 */
export function unclaimedReport(
  path: string,
  role: CompilableMarker,
  cwd: string = process.cwd(),
): string {
  return unclaimedMessage(
    path,
    role,
    existsSync(resolve(cwd, markedName(path, role))),
  );
}

/**
 * The text `compile` prints for one file it will not compile, with the exact
 * command to fix it. `targetExists` is whether the marked name is already on
 * disk: then there is nothing safe to copy, and the message says to merge by
 * hand instead.
 */
export function unclaimedMessage(
  path: string,
  role: CompilableMarker,
  targetExists = false,
): string {
  const dir = dirName(path);
  const target = markedName(path, role);
  const found = classifySource(baseName(path)).kind;
  const head = `${path} — not compiled: a ${role} source must carry \`.${role}.\` before its extension (${baseName(target)}), and this name carries no marker vigiles knows.`;
  const misplaced =
    found === "provider" || found === "hook"
      ? `  It is marked as a ${found}, which belongs in ${found === "hook" ? HOOKS_DIR : PROVIDERS_DIR}/ — move it there.`
      : undefined;
  const notIt = `  If it is not a ${role}, move it out of ${dir || "this directory"} — a test belongs in a \`.harness.\` or \`.eval.\` file.`;
  if (misplaced !== undefined) return [head, misplaced].join("\n");
  if (targetExists)
    return [
      head,
      `  ${target} already exists beside it, so nothing is printed that could overwrite it. If ${path} is the ${role}, compare the two by hand, keep the content you want in ${target}, delete ${path}${role === "hook" ? ` and its stamp, and run \`npx vigiles compile ${target}\`` : ""}.`,
      notIt,
    ].join("\n");
  return [
    head,
    role === "hook"
      ? `  If it is a hook, rename it. Copy first and delete last, so a failure leaves the old hook in place and wired:`
      : `  If it is a provider, rename it (providers are found by directory, never wired by path):`,
    `    ${renameCommand(path, role)}`,
    notIt,
  ].join("\n");
}

interface CommandHook {
  readonly type: "command";
  readonly command: string;
}
interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly CommandHook[];
}
/** The CC-shaped structured block a compiled hook program carries. */
export type CompiledHooks = Record<string, readonly HookEntry[]>;

interface SettingsJson {
  hooks?: Readonly<Record<string, readonly HookEntry[]>>;
  [k: string]: unknown;
}

/**
 * The CANONICAL form of a hook-source reference — how the path is written into
 * the emitted runtime command AND how an existing entry is recognized as "this
 * hook", so the merge is keyed by the FILE, not by the string the user typed.
 *
 * Without this, `vigiles compile x.hook.ts` and `vigiles compile ./x.hook.ts`
 * wired the SAME file twice: the second run's `hookPath` (`./x.hook.ts`) wasn't a
 * substring of the first run's command (`… run-program x.hook.ts`), so nothing
 * was replaced and a second `{matcher, hooks:[…]}` block was appended. A few
 * iterations of an edit-compile loop left duplicate wirings that all fire.
 *
 * Canonical = POSIX separators, no `./` prefix, resolved against the cwd and made
 * relative when it lives under it (an absolute path outside the repo is kept
 * absolute — still stable, just not relative to anything).
 */
export function normalizeHookRef(
  hookPath: string,
  cwd = process.cwd(),
): string {
  const abs = resolve(cwd, hookPath);
  const rel = relative(cwd, abs);
  const chosen = rel === "" || rel.startsWith("..") ? abs : rel;
  return chosen.split(sep).join("/");
}

/**
 * The path token `compile` EMITS into the harness config — anchored at the project root
 * when the harness declares such a variable.
 *
 * 🔴 IT LIVES BESIDE {@link bareToken} ON PURPOSE. That function STRIPS exactly this prefix
 * and these quotes; this one ADDS them. They are one contract read from two ends, and while
 * the ends sat apart only one got fixed: 2026-08-21 taught the reader to understand the
 * anchored spelling, and the emitter went on writing the relative one for three more weeks.
 *
 * Why anchored at all, from the two measurements already in this file and in
 * `PluginLayout.projectRootTokens`: a hook command does not run with a stable cwd, so a
 * relative path "dies with exit 2 the moment the agent runs from a subdirectory". For a
 * PreToolUse gate that is not a lost nudge — a gate that cannot load must block, so the
 * repository seizes. Measured in a consumer repo 2026-09-10: recoverable by file writes
 * only, because every command was refused, including the one that repairs it.
 *
 * `bareToken(hookGateRef(ref, tokens)) === ref` is what keeps a recompile idempotent, and
 * it is asserted directly rather than left to inspection.
 */
/**
 * Where the hook runtime lives, spelled so the shell can find it WITHOUT `npx`.
 *
 * 🔴 MEASURED 2026-09-19, warm cache, five runs each:
 *
 *     node <local>/dist/cli.js hook-runtime run-program …   193 ms
 *     npx vigiles              hook-runtime run-program …  2545 ms
 *
 * Thirteen times, on every tool call, because `npx` re-resolves the package on
 * each invocation — local, then global, then the registry. That search is the
 * single largest cost in a hook's life; everything the runtime does inside adds
 * up to less than a fifth of it.
 *
 * A harness with no project-root token gets the relative spelling, which is all
 * it can be given — see {@link hookGateRef} for the same fallback.
 */
export function hookRuntimeRef(
  projectRootTokens: readonly string[] | undefined,
): string {
  const rel = "node_modules/vigiles/dist/cli.js";
  const token = projectRootTokens?.[0];
  return token === undefined ? `node ${rel}` : `node "${token}/${rel}"`;
}

export function hookGateRef(
  ref: string,
  projectRootTokens: readonly string[] | undefined,
): string {
  const token = projectRootTokens?.[0];
  return token === undefined ? ref : `"${token}/${ref}"`;
}

/**
 * The wiring references a hook file owns: its own, and — for `x.hook.ts` — the
 * one an older vigiles wrote when the file was still called `x.ts`.
 *
 * 🔴 WITHOUT THE SECOND, RENAMING A HOOK TO CARRY ITS MARKER LEAVES A DEAD ENTRY.
 * Wiring is keyed by path, so compiling `guard.hook.mjs` appended a new entry and
 * left the one for `guard.mjs` in `settings.json`, pointing at a file that is
 * about to be deleted. That entry cannot load; wired as a gate it blocks every
 * Bash call, the repair included (see {@link unclaimedMessage}). The marker rename
 * is the one rename vigiles itself asks of every consumer, so it is the one the
 * merge is told about: the renamed file takes over the old file's wiring.
 */
function ownedRefs(hookPath: string): readonly string[] {
  const ref = normalizeHookRef(hookPath);
  const before = preMarkerName(ref, "hook");
  return before === undefined ? [ref] : [ref, before];
}

/**
 * True when an entry's command routes through the runtime for `hookPath`
 * (or for the name it had before it carried its marker, see {@link ownedRefs}).
 *
 * Compares CANONICALIZED path tokens rather than testing for a raw substring:
 * `./x.hook.ts` and `x.hook.ts` are the same file (so the entry is replaced,
 * which also de-duplicates settings written by an older version), while
 * `x.hook.ts` and `my-x.hook.ts` are not (a substring test said they were).
 */
function managesHook(entry: HookEntry, hookPath: string): boolean {
  const refs = ownedRefs(hookPath);
  return entry.hooks.some((h) =>
    h.command.split(/\s+/).some((token) => {
      const bare = bareToken(token);
      return bare !== "" && refs.includes(normalizeHookRef(bare));
    }),
  );
}

/**
 * A command token reduced to the PATH it names, so two spellings of the same
 * hook file compare equal.
 *
 * 🔴 BOTH STRIPS ARE REGRESSIONS, MEASURED IN A CONSUMER REPO 2026-08-21, and
 * they compound: a settings.json wired the Claude-Code-recommended way carries
 * BOTH a quote and the project-dir variable, so `managesHook` saw
 * `"$CLAUDE_PROJECT_DIR/.claude/hooks/x.hook.ts"`, canonicalized it to
 * something under the cwd that resembles nothing, and reported "not managed by
 * this hook". Recompiling then APPENDED its own block beside the existing one.
 * Twelve hooks, twelve duplicates, and the duplicate is the WORSE of the two:
 * it spells the path relative to the cwd, so it dies with exit 2 the moment the
 * agent runs from a subdirectory — while the healthy copy beside it keeps
 * working, which is why this survived a full day unnoticed.
 *
 * - QUOTES. A path with a space MUST be quoted, so the quoted form is not an
 *   exotic spelling — it is the correct one. Comparing it raw could never match.
 * - `$CLAUDE_PROJECT_DIR`. It is defined as the project root, which is exactly
 *   what `normalizeHookRef` resolves relative paths against, so stripping the
 *   prefix makes the two spellings the same path by definition rather than by
 *   guess. `${CLAUDE_PROJECT_DIR}` is the same variable in brace syntax.
 *
 * Nothing else is stripped. A token this function does not recognise is left
 * alone and simply fails to match, which is the pre-existing behaviour: the
 * cost of a miss here is a duplicate block, and the cost of an over-match is
 * deleting a hook the user wrote themselves.
 */
function bareToken(token: string): string {
  const unquoted = token.replace(/^["']/, "").replace(/["']$/, "");
  return unquoted.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[/\\]/, "");
}

/**
 * Drop only the COMMANDS this hook file owns from one entry, keeping the rest.
 *
 * Returns the entry UNCHANGED (same reference) when it owns nothing here, a
 * narrowed copy when it owns some, and `null` when the entry is left empty and
 * should disappear.
 *
 * 🔴 THE GRANULARITY IS THE WHOLE POINT, and getting it wrong cost a consumer
 * repo half its hook wiring. Claude Code's shape is
 * `{matcher, hooks: [command, command, …]}` — SEVERAL commands share one
 * matcher block — so "is this entry mine?" is the wrong question: an entry can
 * be partly mine. The previous merge asked exactly that (`managesHook(e)` →
 * drop `e`), which is true when ANY command matches, and then deleted the
 * block wholesale.
 *
 * Measured 2026-09-15 on a real `.claude/settings.json`: its
 * `PostToolUse`/`Edit|Write|MultiEdit` entry held SIX commands — four vigiles
 * hooks and the user's own `kb-lint.mjs post` and `paper-lint.mjs post`.
 * Recompiling any ONE of the four took all six, so two hand-written checks
 * silently stopped running. Silently is the operative word: the file stayed
 * valid JSON, the remaining hooks kept firing, and nothing reported a loss —
 * the same failure mode this repo has already paid for three times (a step
 * that stops executing without saying so).
 *
 * The cost asymmetry that decides the rule: a MISS leaves a duplicate block
 * (visible, harmless, fixed by the next recompile), an OVER-MATCH deletes a
 * hook the user wrote (invisible, unrecoverable from the file itself). So the
 * filter is per-command, and an entry is removed only when we emptied it.
 */
function withoutHookCommands(
  entry: HookEntry,
  hookPath: string,
): HookEntry | null {
  if (!managesHook(entry, hookPath)) return entry;
  const kept = entry.hooks.filter(
    (h) => !managesHook({ matcher: entry.matcher, hooks: [h] }, hookPath),
  );
  if (kept.length === entry.hooks.length) return entry;
  return kept.length === 0 ? null : { ...entry, hooks: kept };
}

/**
 * Idempotently merge a compiled hook's block into an existing `settings.json`
 * object. Commands managed by THIS hook file (the runtime command references
 * `hookPath`) are replaced; every unrelated command — including the user's own
 * hand-written hooks SHARING A MATCHER BLOCK with ours — is preserved. See
 * {@link withoutHookCommands} for why the granularity is the command and not
 * the entry.
 */
export function mergeHooksJson(
  existing: SettingsJson,
  compiled: CompiledHooks,
  hookPath: string,
): SettingsJson {
  // No keyed assignment into a shallow copy, and the containers are `readonly`.
  // That copy would SHARE its arrays with the caller's object, so the purity of
  // the old loop rested on every future author reaching for `hooks[e] = [...]`
  // rather than `hooks[e].push(...)` — one is fine, the other silently mutates
  // the argument, and nothing told them apart. `readonly` makes the bad one a
  // tsc error instead of a convention (ts-essentials: irrepresentable beats
  // remembered).
  const before = existing.hooks ?? {};
  const rewritten = Object.fromEntries(
    Object.entries(compiled).map(([event, entries]) => [
      event,
      replaceInPlace(
        before[event] ?? [],
        (e) => withoutHookCommands(e, hookPath),
        entries,
      ),
    ]),
  );
  return { ...existing, hooks: { ...before, ...rewritten } };
}

/**
 * Put `fresh` where this hook's old entry stood, not at the end. Appending made
 * a recompile whose wiring changed read as a reshuffle: measured on a real
 * settings.json, one guard gained `|| exit 2` and the diff showed three entries
 * swapping places. `strip` returns the entry unchanged when it is not ours, a
 * narrowed entry when it shared a matcher with ours, or null when it was only
 * ours. A hook wired for the first time is still appended.
 */
function replaceInPlace<E>(
  list: readonly E[],
  strip: (e: E) => E | null,
  fresh: readonly E[],
): E[] {
  const at = list.findIndex((e) => strip(e) !== e);
  const slot = at === -1 ? list.length : at;
  return [
    ...list.flatMap((e, i) => {
      const kept = strip(e);
      const here = kept === null ? [] : [kept];
      return i === slot ? [...here, ...fresh] : here;
    }),
    ...(slot === list.length ? fresh : []),
  ];
}

interface TomlHookEntry {
  readonly matcher?: string;
  readonly command: string;
}
interface ConfigToml {
  hooks?: Readonly<Record<string, readonly TomlHookEntry[]>>;
  [k: string]: unknown;
}

/** Flatten a CC-shaped entry to Codex's flat `{matcher?, command}` form. */
function toTomlEntries(entries: readonly HookEntry[]): TomlHookEntry[] {
  return entries.flatMap((e) =>
    e.hooks.map((h) =>
      e.matcher === undefined
        ? { command: h.command }
        : { matcher: e.matcher, command: h.command },
    ),
  );
}

/** The TOML sibling of {@link mergeHooksJson} (Codex `[[hooks.<event>]]`). */
export function mergeHooksToml(
  existing: ConfigToml,
  compiled: CompiledHooks,
  hookPath: string,
): ConfigToml {
  // Same canonical-path keying as the JSON merge, and the same no-assignment
  // shape. No per-command narrowing is needed HERE, and that is a fact about the
  // format rather than an oversight: Codex's `[[hooks.<event>]]` carries ONE
  // command per entry (see `toTomlEntries`), so entry- and command-granularity
  // coincide. The CC shape nests several commands under one matcher, which is
  // where the loss happened.
  const before = existing.hooks ?? {};
  const rewritten = Object.fromEntries(
    Object.entries(compiled).map(([event, entries]) => [
      event,
      replaceInPlace(
        before[event] ?? [],
        (e) => managesHook({ hooks: [{ type: "command", command: e.command }] }, hookPath) ? null : e, // prettier-ignore
        toTomlEntries(entries),
      ),
    ]),
  );
  return { ...existing, hooks: { ...before, ...rewritten } };
}

/**
 * Serialize a merged config back to its on-disk text.
 *
 * ⚠️ DEPRECATED IN PLACE, not deleted, and the distinction matters: the
 * harness-driven path (`installHookFile` in `cli-main.ts`) goes through
 * `PluginLayout.settings.render` now, so no adapter's encoding is decided here
 * any more. The one remaining caller is `cli-main.ts`'s Codex-plugin wiring,
 * which writes `.codex/config.toml` for a harness it names ITSELF, at the
 * composition root — a caller that already knows the encoding, rather than one
 * branching on a layout field. Its `format` argument is therefore a literal at
 * the call site, not a value read off a port.
 */
export function serializeConfig(
  merged: Record<string, unknown>,
  format: "json" | "toml",
): string {
  return format === "toml"
    ? stringifyToml(merged).trimEnd() + "\n"
    : JSON.stringify(merged, null, 2) + "\n";
}
