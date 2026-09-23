/**
 * Hook installation — the bridge from a typed hook program to a wired harness,
 * folded into `vigiles compile` (there is no stray `compile-hook` verb; the
 * cohesive-cli-surface rule).
 *
 * The typed hook program is harness-NEUTRAL — it imports `vigiles/hook` and
 * compiles to whatever harness — so its SOURCE lives in the agnostic,
 * committed {@link HOOKS_DIR} (`.vigiles/hooks/`), never in a harness's own
 * `.claude/`. `compile` discovers each hook there, compiles it, and MERGES the
 * result into the active harness's native config (`.claude/settings.json` JSON
 * / `config.toml` TOML) — so the harness is actually wired, not handed a
 * paste-this block. The merge is idempotent: an entry is keyed by the runtime
 * command's hook path, CANONICALIZED ({@link normalizeHookRef}) so it identifies
 * the FILE rather than the string the user typed — recompiling updates in place
 * and never duplicates, while a user's own hand-written hooks are preserved
 * untouched. One source dir also means basenames are unique, so the stamp can key
 * on the basename safely.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { DispatchKind } from "./core/hook-program.js";
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

/** A JS/TS hook source file (the `.json` stamp sidecar is never matched). */
const HOOK_SOURCE_RE = /\.(?:mjs|cjs|js|mts|cts|ts)$/;

/** List JS/TS source files under `dir` (relative to cwd), stamps excluded. */
function discoverSources(cwd: string, dir: string): string[] {
  const abs = join(cwd, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => HOOK_SOURCE_RE.test(f) && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => join(dir, f));
}

/** Discover hook source files under {@link HOOKS_DIR} (stamps excluded). */
export function discoverHookFiles(cwd: string): string[] {
  return discoverSources(cwd, HOOKS_DIR);
}

/** Discover registered-provider source files under {@link PROVIDERS_DIR}. */
export function discoverProviderFiles(cwd: string): string[] {
  return discoverSources(cwd, PROVIDERS_DIR);
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

/**
 * What the shell must do when the runtime above CANNOT START — a missing
 * `node_modules/vigiles`, an unreadable file, an interpreter that dies before a
 * single line of ours runs. No code of ours executes in that case, so the policy
 * has to be expressed in the emitted command or not at all.
 *
 * 🔴 THIS IS NOT A NEW POLICY. `runHookProgramCommand`'s load-failure branch has
 * decided it since 2026-08: *"an inject's purpose is to ADD context, not to
 * ENFORCE a decision … Gates (file, bash, prompt, stop) remain conservative and
 * fail closed."* That branch only reaches failures that happen AFTER the runtime
 * starts. This carries the same rule one layer out, to the failures that happen
 * before it.
 *
 * WHY THE SPLIT, RATHER THAN ONE ANSWER FOR EVERYTHING — the two failures are
 * not comparable:
 *
 *   A GATE THAT SILENTLY PASSES IS WORSE THAN NO GATE. Its whole value is the
 *   refusal, and a harness that reports protection it is not providing is the
 *   one state worse than admitting it has none. So a gate whose runtime is
 *   missing exits 2: loud, blocking, and the cause is on stderr.
 *
 *   A NUDGE THAT BLOCKS COSTS THE WHOLE REPOSITORY. Measured here 2026-08-10:
 *   merge-conflict markers in `package.json` stopped every hook loading, the
 *   Bash gate then refused `git merge --abort` — the one command that undoes the
 *   cause — and the session could not be repaired from inside. A reminder is
 *   never worth that, so a nudge exits 0 and says nothing it cannot say.
 *
 * The role is not a flag someone can flip: `Reaction` has no `deny` and an
 * inject returns context, so "nudge" is a fact about the TYPE the author chose.
 *
 * (Industry does not agree on one answer either — husky and lefthook skip,
 * pre-commit fails. Which is itself the argument for deciding by role instead
 * of picking one and imposing it on both.)
 */
export function hookRuntimeMissingExit(kind: DispatchKind): 0 | 2 {
  return kind === "inject" || kind === "react" ? 0 : 2;
}

export function hookGateRef(
  ref: string,
  projectRootTokens: readonly string[] | undefined,
): string {
  const token = projectRootTokens?.[0];
  return token === undefined ? ref : `"${token}/${ref}"`;
}

/**
 * True when an entry's command routes through the runtime for `hookPath`.
 *
 * Compares CANONICALIZED path tokens rather than testing for a raw substring:
 * `./x.hook.ts` and `x.hook.ts` are the same file (so the entry is replaced,
 * which also de-duplicates settings written by an older version), while
 * `x.hook.ts` and `my-x.hook.ts` are not (a substring test said they were).
 */
function managesHook(entry: HookEntry, hookPath: string): boolean {
  const ref = normalizeHookRef(hookPath);
  return entry.hooks.some((h) =>
    h.command.split(/\s+/).some((token) => {
      const bare = bareToken(token);
      return bare !== "" && normalizeHookRef(bare) === ref;
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
