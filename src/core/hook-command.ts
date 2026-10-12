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
