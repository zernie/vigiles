/**
 * The hook command lines vigiles WRITES, and the one way they are recognised:
 * by IDENTITY with what `compile` would write (#361, #362).
 *
 * 🔴 VIGILES NEVER PARSES A HAND-WRITTEN HOOK COMMAND LINE. Two branches of
 * this repository tried: #359 taught `resolveScript` one more shell shape
 * (`$CLAUDE_PROJECT_DIR`), and #361's first version parsed the line as shell
 * and kept an interpreter list to find "the script". Each shape it learned
 * exposed the next one it did not (`env X=1 cmd`, `sh -c '…'`, `cd d && ./x`,
 * `bash -x x.sh`), and even a perfect parse answers only "does one path exist",
 * never "does the hook work". Both were removed (#362). The lines vigiles owns
 * need no parse: `compile` is their only writer, so a line is `compiled`
 * exactly when it equals the line the plan below says compile would write for
 * one of this repo's hook sources. Everything else is hand-written, and the
 * answer to a hand-written hook is to compile it. Whether any hook works is
 * answered by running it (`runHook`, `vigiles test`).
 *
 * Enforced by `no-restricted-imports` in eslint.config.mjs: this module and the
 * scan's hook readers may not import the shell parser.
 *
 * Pure and harness-agnostic: the root variables, the runtime and the hook
 * sources come from the caller.
 */
import { hookStampRef } from "./hook-paths.js";
import { withRoleExit, type DispatchKind } from "./hook-program.js";

/** Where `compile` writes the start-of-session check. Committed, next to the hook sources. */
export const HOOK_CHECK_REF = ".vigiles/hook-check.sh";

/** The CLI verb every compiled hook line starts the runtime with. */
export const HOOK_RUNTIME_VERB = "hook-runtime";

/** The runtime kind that runs a compiled hook program; its one operand is the program. */
export const RUN_PROGRAM_KIND = "run-program";

/**
 * The lines `init` wires for a harness with no plugin store (Codex): the
 * shipped nudges, started through npx. Data, so the plan below knows them as
 * vigiles's own without reading their text.
 */
export const INIT_NUDGE_COMMANDS = {
  evalLock: "npx --no-install vigiles hook-runtime eval-lock-nudge",
  refs: "npx --no-install vigiles hook-runtime refs",
} as const;

/**
 * The command line `compile` writes to run a hook program: the runtime started
 * by `runnerRef`, the program at `programRef`. {@link plannedHookLines} uses it, so a reader compares a wired line with the same string.
 */
export function runProgramCommand(
  runnerRef: string,
  programRef: string,
): string {
  return `${runnerRef} ${HOOK_RUNTIME_VERB} ${RUN_PROGRAM_KIND} ${programRef}`;
}

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
  runtime: HookRuntime = INSTALLED_HOOK_RUNTIME,
): string {
  const token = projectRootTokens?.[0];
  return token === undefined
    ? `node ${runtime.path}`
    : `node "${token}/${runtime.path}"`;
}

/**
 * Which file a project starts the hook runtime from, and the command that puts
 * that file on disk when it is missing.
 */
export interface HookRuntime {
  /** Project-relative path of the runtime's entry point. */
  readonly path: string;
  /** What the start-of-session notice tells the user to run when it is missing. */
  readonly cure: string;
}

/** A consumer's runtime: the vigiles it installed as a dependency. */
export const INSTALLED_HOOK_RUNTIME: HookRuntime = {
  path: "node_modules/vigiles/dist/cli.js",
  cure: "npm ci (or npm install)",
};

/**
 * The runtime a project with this `package.json` can actually start.
 *
 * 🔴 THE VIGILES REPOSITORY IS NOT ITS OWN DEPENDENCY. It compiles its own hooks,
 * and the installed path above does not exist in it: nothing puts a package into
 * its own `node_modules`. Measured 2026-10-11: both of the repository's compiled
 * nudges had died with MODULE_NOT_FOUND on every tool call since #260
 * (2026-09-21), and each one's `|| exit 0` turned the death into silence — a
 * reminder that cannot load is skipped by design (see `hookRuntimeMissingExit`).
 * So the package itself starts the bin it declares, which its build writes in
 * place; the cure the notice names is that build, because `npm ci` alone does
 * not produce `dist/`.
 *
 * Decided from the manifest's CONTENT (name + declared bin), never from where the
 * running CLI happens to sit: a linked or pnpm-store copy would otherwise emit a
 * path that is only true on the machine that ran `compile`.
 */
export function hookRuntimeFor(manifest: unknown): HookRuntime {
  if (fieldOf(manifest, "name") !== "vigiles") return INSTALLED_HOOK_RUNTIME;
  const bin = fieldOf(manifest, "bin");
  // npm's two spellings: `"bin": "x.js"` or `"bin": { "vigiles": "x.js" }`.
  const declared = typeof bin === "string" ? bin : fieldOf(bin, "vigiles");
  if (typeof declared !== "string" || declared === "")
    return INSTALLED_HOOK_RUNTIME;
  return {
    path: declared.replace(/^\.\//, ""),
    cure: "npm ci && npm run build",
  };
}

/** `value[key]` when `value` is an object, else `undefined` — no cast. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Object.entries(value).find(([k]) => k === key)?.[1];
  return found;
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
 * - the harness's PROJECT-ROOT variable (Claude Code's `$CLAUDE_PROJECT_DIR`),
 *   handed in by the caller from its layout. It is defined as the project
 *   root, which is exactly what a relative path resolves against, so stripping
 *   it makes the two spellings the same path by definition rather than by
 *   guess. `${NAME}` and `$NAME` are the same variable. Core names no harness
 *   variable itself.
 *
 * Nothing else is stripped. A token this function does not recognise is left
 * alone and simply fails to match, which is the pre-existing behaviour: the
 * cost of a miss here is a duplicate block, and the cost of an over-match is
 * deleting a hook the user wrote themselves.
 */
export function bareToken(
  token: string,
  rootTokens: readonly string[],
): string {
  const unquoted = token.replace(/^["']/, "").replace(/["']$/, "");
  const prefix = rootTokens
    .map((t) => t.replace(/^\$\{(.+)\}$/, "$1"))
    .flatMap((name) => [`\${${name}}`, `$${name}`])
    .flatMap((spelled) => [`${spelled}/`, `${spelled}\\`])
    .find((p) => unquoted.startsWith(p));
  return prefix === undefined ? unquoted : unquoted.slice(prefix.length);
}

/** The start-of-session check line `compile` wires beside the compiled hooks. */
export function sessionCheckCommand(
  projectRootTokens: readonly string[] | undefined,
): string {
  return `sh ${hookGateRef(HOOK_CHECK_REF, projectRootTokens)} || exit 0`;
}

/**
 * A hook source and what its last compile recorded about it. `role` comes from
 * the stamp sidecar; a source never compiled (or compiled by a vigiles that did
 * not record it) has none, and so has no planned line.
 */
export interface HookSourceRecord {
  /** Repo-relative path of the hook source (`.vigiles/hooks/x.hook.mjs`). */
  readonly ref: string;
  readonly role?: DispatchKind;
}

/** One line `compile` would write, and the files it needs on disk. */
export interface PlannedHookLine {
  readonly command: string;
  /** Root-anchored (`${TOKEN}/…`) or repo-relative paths. */
  readonly files: readonly string[];
}

/**
 * The lines `compile` and `init` would write in a repo, and the hook sources
 * whose wiring `compile` owns (its merge key) — what a reader compares a hook
 * line against.
 */
export interface HookLinePlan {
  readonly lines: readonly PlannedHookLine[];
  /** Repo-relative refs of every hook source, compiled or not. */
  readonly sources: readonly string[];
}

/**
 * The plan for a repo, from what its files say: each hook source's role from
 * its stamp sidecar, the runtime from `package.json`. `readText` is the
 * engine's file port (disk or a fetched file map); `undefined` = absent.
 */
export function hookLinePlan(
  sourceRefs: readonly string[],
  readText: (ref: string) => string | undefined,
  projectRootTokens: readonly string[] | undefined,
): HookLinePlan {
  const sources = sourceRefs.map((ref): HookSourceRecord => {
    const role = fieldOf(parseJson(readText(hookStampRef(ref))), "role");
    return isDispatchKind(role) ? { ref, role } : { ref };
  });
  return {
    lines: plannedHookLines({
      sources,
      runtime: hookRuntimeFor(parseJson(readText("package.json"))),
      projectRootTokens,
    }),
    sources: sourceRefs,
  };
}

/** JSON text → value; absent or malformed → undefined (the plan then has less). */
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** Every role a compiled hook can have — a record, so a new kind is a tsc error here. */
const DISPATCH_KINDS: Readonly<Record<DispatchKind, true>> = {
  "bash-gate": true,
  "file-gate": true,
  "prompt-gate": true,
  "stop-gate": true,
  inject: true,
  react: true,
};

function isDispatchKind(value: unknown): value is DispatchKind {
  return (
    typeof value === "string" &&
    Object.keys(DISPATCH_KINDS).some((k) => k === value)
  );
}

/** What the plan needs: the repo's hook sources, its runtime, the harness's root variables. */
export interface HookPlanInput {
  readonly sources: readonly HookSourceRecord[];
  readonly runtime: HookRuntime;
  readonly projectRootTokens: readonly string[] | undefined;
}

/**
 * Every hook line `compile` (and `init`) would write in this repo — the same
 * template functions the writers call, so the reader cannot drift from them.
 */
export function plannedHookLines(
  input: HookPlanInput,
): readonly PlannedHookLine[] {
  const { sources, projectRootTokens: tokens } = input;
  return [
    ...sources.flatMap((s) => compiledLine(s, input)),
    {
      command: sessionCheckCommand(tokens),
      files: [anchored(HOOK_CHECK_REF, tokens)],
    },
    ...Object.values(INIT_NUDGE_COMMANDS).map((command) => ({
      command,
      files: [],
    })),
  ];
}

/** The line `compile` writes for one recorded hook source; none without a role. */
function compiledLine(
  { ref, role }: HookSourceRecord,
  { runtime, projectRootTokens: tokens }: HookPlanInput,
): readonly PlannedHookLine[] {
  if (role === undefined) return [];
  const command = withRoleExit(
    runProgramCommand(
      hookRuntimeRef(tokens, runtime),
      hookGateRef(ref, tokens),
    ),
    role,
  );
  const files = [runtime.path, ref, hookStampRef(ref)].map((f) =>
    anchored(f, tokens),
  );
  return [{ command, files }];
}

/** `rel` anchored at the harness's project root, as the emitted line spells it. */
function anchored(
  rel: string,
  projectRootTokens: readonly string[] | undefined,
): string {
  const token = projectRootTokens?.[0];
  return token === undefined ? rel : `${token}/${rel}`;
}

/**
 * Whether a command names one of `refs` — `compile`'s MERGE KEY, the test it
 * uses to find the entries it owns when it rewrites a settings file. The
 * command is split on whitespace and each word reduced by {@link bareToken};
 * nothing is parsed as shell. `normalize` makes a word comparable to a ref
 * (the writer and the reader each know their own root).
 */
export function commandNamesRef(
  command: string,
  refs: readonly string[],
  normalize: (word: string) => string,
  rootTokens: readonly string[],
): boolean {
  return command.split(/\s+/).some((word) => {
    const bare = bareToken(word, rootTokens);
    return bare !== "" && refs.includes(normalize(bare));
  });
}
