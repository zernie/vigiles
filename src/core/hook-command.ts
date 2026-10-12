/**
 * What a static reader may say about a hook command line, and nothing more
 * (#361). Exactly three answers:
 *
 *   - `compiled` — a line vigiles WROTE: the hook runtime
 *     (`node <runner> hook-runtime <kind> …`, `npx vigiles hook-runtime <kind> …`)
 *     or the start-of-session check. It is read by the template that emits it,
 *     so the files it runs are known exactly.
 *   - `script` — a hand-written line that STARTS by running a literal path
 *     (`./hooks/x.sh`, `bash ${ROOT}/hooks/x.sh`). That one file can be checked.
 *   - `opaque` — everything else. No word is guessed to be the script.
 *
 * The line is parsed as shell ({@link leadingCommand}); the reader never splits
 * the string itself. Whether a hook WORKS is not a static question in any of the
 * three cases: it is answered by running it (`runHook`, `vigiles test`).
 *
 * Harness-agnostic: the root variables come from the caller's layout. A path
 * names a root in its braced spelling, whichever spelling the line used.
 */
import {
  leadingCommand,
  type ShellWord,
  type WordPiece,
} from "./bash-effects.js";

/** Where `compile` writes the start-of-session check. Committed, next to the hook sources. */
export const HOOK_CHECK_REF = ".vigiles/hook-check.sh";

/** The CLI verb every compiled hook line starts the runtime with. */
export const HOOK_RUNTIME_VERB = "hook-runtime";

/** The runtime kind that runs a compiled hook program; its one operand is the program. */
export const RUN_PROGRAM_KIND = "run-program";

/** The verdict. */
export type HookCommandShape =
  | { readonly kind: "compiled"; readonly files: readonly string[] }
  | { readonly kind: "script"; readonly file: string }
  | { readonly kind: "opaque" };

/**
 * The command line `compile` writes to run a hook program: the runtime started
 * by `runnerRef`, the program at `programRef`. {@link hookCommandShape} inverts it.
 */
export function runProgramCommand(
  runnerRef: string,
  programRef: string,
): string {
  return `${runnerRef} ${HOOK_RUNTIME_VERB} ${RUN_PROGRAM_KIND} ${programRef}`;
}

/** Programs a hand-written hook may name as `<interpreter> <literal path>`. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "node",
  "bun",
  "python",
  "python3",
  "ruby",
  "perl",
]);

const OPAQUE: HookCommandShape = { kind: "opaque" };

/**
 * Classify one hook command. `rootTokens` are the harness's root variables in
 * their braced spelling (`${CLAUDE_PROJECT_DIR}`).
 */
export function hookCommandShape(
  command: string,
  rootTokens: readonly string[],
): HookCommandShape {
  const line = readLine(command, rootTokens);
  if (line === null) return OPAQUE;
  const compiled = line.endsAsWritten
    ? compiledFiles(line.words, rootTokens)
    : null;
  if (compiled !== null && compiled !== MALFORMED)
    return { kind: "compiled", files: compiled };
  const script = leadingScript(line.words);
  return script === null ? OPAQUE : { kind: "script", file: script };
}

/**
 * Whether `command` is our `hook-runtime run-program` template with the wrong
 * operands — no program, or more than one. Such a line is not one vigiles
 * wrote as it stands, so it is not `compiled`; it is not hand-written either,
 * and the cure is to recompile, not to write a hook.
 */
export function malformedRunProgram(
  command: string,
  rootTokens: readonly string[],
): boolean {
  const line = readLine(command, rootTokens);
  return line !== null && compiledFiles(line.words, rootTokens) === MALFORMED;
}

/** A line's leading words as text, and whether it ends as `compile` writes it. */
function readLine(
  command: string,
  rootTokens: readonly string[],
): {
  readonly words: readonly (string | null)[];
  readonly endsAsWritten: boolean;
} | null {
  const line = leadingCommand(command);
  if (line === null) return null;
  const roots = new Set(rootTokens.map(tokenName));
  return {
    words: line.words.map((w) => wordText(w, roots)),
    endsAsWritten:
      line.rest === "alone" ||
      (line.rest === "or-else" && isRoleExit(line.orElse, roots)),
  };
}

/** Our run-program template, with operands it never writes. */
const MALFORMED = "malformed";

/** What reading a line by the compiled template gives. */
type TemplateRead = readonly string[] | typeof MALFORMED | null;

/** The literal path a hand-written line starts by running, or null. */
function leadingScript(words: readonly (string | null)[]): string | null {
  const [head = null, operand = null] = words;
  if (head === null) return null;
  if (isLiteralPath(head)) return head;
  return INTERPRETERS.has(head) && operand !== null && isLiteralPath(operand)
    ? operand
    : null;
}

/**
 * The files a compiled line runs, or null when the words are not one of the
 * lines vigiles writes:
 *
 *   node <runner> hook-runtime <kind> [<program>]              → runner, program
 *   npx [--no-install] vigiles hook-runtime <kind> [<program>] → program
 *   sh <root>/.vigiles/hook-check.sh                           → the check script
 */
function compiledFiles(
  words: readonly (string | null)[],
  rootTokens: readonly string[],
): TemplateRead {
  const known = words.filter((w): w is string => w !== null);
  if (known.length !== words.length) return null;
  const [head, ...rest] = known;
  switch (head) {
    case "sh":
      return rest.length === 1 && isHookCheckRef(rest[0], rootTokens)
        ? rest
        : null;
    case "node":
      return nodeRuntimeFiles(rest);
    case "npx":
      return npxRuntimeFiles(rest);
    default:
      return null;
  }
}

/** `<runner> hook-runtime …` after `node` → the runner and the program. */
function nodeRuntimeFiles(words: readonly string[]): TemplateRead {
  const [runner, ...runtime] = words;
  if (runner === undefined || !isLiteralPath(runner)) return null;
  const program = runtimeOperand(runtime);
  return program === null || program === MALFORMED
    ? program
    : [runner, ...program];
}

/** `[--no-install] vigiles hook-runtime …` after `npx` → the program. */
function npxRuntimeFiles(words: readonly string[]): TemplateRead {
  const [pkg, ...runtime] =
    words[0] === "--no-install" ? words.slice(1) : words;
  return pkg === "vigiles" ? runtimeOperand(runtime) : null;
}

/**
 * `hook-runtime <kind> [<program>]` → the program it names ([] for a kind that
 * runs none); null when the words are not a runtime invocation; MALFORMED for
 * `run-program` with anything but one program file.
 */
function runtimeOperand(words: readonly string[]): TemplateRead {
  const [verb, kind, ...operands] = words;
  if (verb !== HOOK_RUNTIME_VERB || kind === undefined) return null;
  if (kind !== RUN_PROGRAM_KIND) return [];
  const [program, ...extra] = operands;
  if (program === undefined || extra.length > 0 || !isFileWord(program))
    return MALFORMED;
  return [program];
}

/** `exit <n>` — the fallback `withRoleExit` gives a compiled line. */
function isRoleExit(
  words: readonly ShellWord[],
  roots: ReadonlySet<string>,
): boolean {
  const [verb, code, ...extra] = words.map((w) => wordText(w, roots));
  return (
    verb === "exit" &&
    extra.length === 0 &&
    typeof code === "string" &&
    /^\d+$/.test(code)
  );
}

function isHookCheckRef(
  ref: string | undefined,
  rootTokens: readonly string[],
): boolean {
  return (
    ref === HOOK_CHECK_REF ||
    rootTokens.some((t) => ref === `${t}/${HOOK_CHECK_REF}`)
  );
}

/** `${NAME}` → `NAME`. */
function tokenName(token: string): string {
  return token.replace(/^\$\{(.+)\}$/, "$1");
}

/**
 * A word as the text it stands for, roots in their braced spelling; null when
 * the shell would compute any part of it (another variable, a glob, `~`).
 */
function wordText(word: ShellWord, roots: ReadonlySet<string>): string | null {
  if (word === null) return null;
  const pieces = word.map((p) => pieceText(p, roots));
  return pieces.every((p): p is string => p !== null) ? pieces.join("") : null;
}

/** Characters an unquoted shell word expands (globs, braces, a leading `~`). */
const EXPANDED_UNQUOTED = /[*?[\]{}~]/;

function pieceText(
  piece: WordPiece,
  roots: ReadonlySet<string>,
): string | null {
  if (piece.kind === "param")
    return roots.has(piece.name) ? `\${${piece.name}}` : null;
  return !piece.quoted && EXPANDED_UNQUOTED.test(piece.text)
    ? null
    : piece.text;
}

/**
 * A path the shell runs as written: it has a slash (so no `PATH` lookup), and
 * is a {@link isFileWord}.
 */
function isLiteralPath(text: string): boolean {
  return text.includes("/") && isFileWord(text);
}

/**
 * A word naming one file of the repository as written: relative, or anchored
 * at a root variable that is its whole first segment; not a flag, and no
 * other variable. An absolute path names a file on one machine, not in the repo.
 */
function isFileWord(text: string): boolean {
  if (text === "" || text.startsWith("-") || text.startsWith("/")) return false;
  if (!text.startsWith("${")) return !text.includes("${");
  const rest = text.slice(text.indexOf("}") + 1);
  return rest.startsWith("/") && !rest.includes("${");
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
export function bareToken(token: string): string {
  const unquoted = token.replace(/^["']/, "").replace(/["']$/, "");
  return unquoted.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[/\\]/, "");
}
