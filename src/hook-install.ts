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
  hooks?: Record<string, HookEntry[]>;
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
 * Idempotently merge a compiled hook's block into an existing `settings.json`
 * object. Entries managed by THIS hook file (the runtime command references
 * `hookPath`) are replaced; every unrelated entry — including the user's own
 * hand-written hooks — is preserved.
 */
export function mergeHooksJson(
  existing: SettingsJson,
  compiled: CompiledHooks,
  hookPath: string,
): SettingsJson {
  const hooks: Record<string, HookEntry[]> = { ...(existing.hooks ?? {}) };
  for (const [event, entries] of Object.entries(compiled)) {
    const kept = (hooks[event] ?? []).filter((e) => !managesHook(e, hookPath));
    hooks[event] = [...kept, ...entries];
  }
  return { ...existing, hooks };
}

interface TomlHookEntry {
  matcher?: string;
  command: string;
}
interface ConfigToml {
  hooks?: Record<string, TomlHookEntry[]>;
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
  const hooks: Record<string, TomlHookEntry[]> = { ...(existing.hooks ?? {}) };
  for (const [event, entries] of Object.entries(compiled)) {
    // Same canonical-path keying as the JSON merge (one flat command per entry).
    const kept = (hooks[event] ?? []).filter(
      (e) => !managesHook({ hooks: [{ type: "command", command: e.command }] }, hookPath), // prettier-ignore
    );
    hooks[event] = [...kept, ...toTomlEntries(entries)];
  }
  return { ...existing, hooks };
}

/** Serialize a merged config back to its on-disk text (with trailing newline). */
export function serializeConfig(
  merged: Record<string, unknown>,
  format: "json" | "toml",
): string {
  return format === "toml"
    ? stringifyToml(merged).trimEnd() + "\n"
    : JSON.stringify(merged, null, 2) + "\n";
}
