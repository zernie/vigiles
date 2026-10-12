export const HOOK_CHECK_REF = ".vigiles/hook-check.sh";
export type HookCommandShape =
  | { readonly kind: "compiled"; readonly files: readonly string[] }
  | { readonly kind: "script"; readonly file: string }
  | { readonly kind: "opaque" };

/**
 * SPIKE (plugin-compiled-hooks): THE ONE TEMPLATE for the line `compile` writes
 * for a hook program, read from both ends. {@link runProgramCommand} emits it;
 * {@link parseRunProgramCommand} reads a line back ONLY if it has exactly this
 * shape. The classifier below calls the parser, so "is this our line?" is
 * answered by the same words that wrote it, not by looking for a keyword.
 *
 *     node <RUNTIME> hook-runtime run-program <PROGRAM> || exit <0|2>
 *
 * <RUNTIME> and <PROGRAM> are each one word: bare, or double-quoted with a
 * root token in front (`"${CLAUDE_PROJECT_DIR}/…"`, `"${CLAUDE_PLUGIN_ROOT}/…"`).
 * The `|| exit N` ending is appended by `withRoleExit` (core/hook-program.ts)
 * and is optional on read, because a hand-pasted older line may lack it.
 */
const RUN_PROGRAM_VERB = "hook-runtime run-program";

/** A root-anchored word, quoted the way `hookGateRef` / `hookRuntimeRef` quote it. */
export function anchoredWord(token: string | undefined, rel: string): string {
  return token === undefined ? rel : `"${token}/${rel}"`;
}

/** The emit half. `runtime` and `program` are already-spelled words (see {@link anchoredWord}). */
export function runProgramCommand(runtime: string, program: string): string {
  return `node ${runtime} ${RUN_PROGRAM_VERB} ${program}`;
}

/** One word: `"…"` with no inner quote, or a run without whitespace, quotes or shell operators. */
const WORD = String.raw`("[^"]*"|[^\s"'|&;<>()\x60]+)`;
const EXIT = String.raw`(?: \|\| exit [0-9]+)?`;
const LINE = new RegExp(`^node ${WORD} ${RUN_PROGRAM_VERB} ${WORD}${EXIT}$`);
const NPX_LINE = new RegExp(
  `^npx(?: --no-install)? vigiles hook-runtime (?:run-program ${WORD}|[a-z][a-z0-9-]*)${EXIT}$`,
);
const CHECK_LINE = new RegExp(`^sh ${WORD}${EXIT}$`);

/** `"${X}/a"`, `"$X/a"`, `${X}/a` → `${X}/a`: one spelling per anchored path. */
function unquote(word: string): string {
  const bare = word.replace(/^"/, "").replace(/"$/, "");
  return bare.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/, "$${$1}");
}

/** The read half: the two files a line of exactly this template runs, or `undefined`. */
export function parseRunProgramCommand(
  command: string,
): { runtime: string; program: string } | undefined {
  const m = LINE.exec(command.trim());
  if (m === null) return undefined;
  return { runtime: unquote(m[1]), program: unquote(m[2]) };
}

export function hookCommandShape(
  command: string,
  _rootTokens: readonly string[],
): HookCommandShape {
  const line = command.trim();
  const ours = parseRunProgramCommand(line);
  if (ours !== undefined)
    return { kind: "compiled", files: [ours.runtime, ours.program] };
  const npx = NPX_LINE.exec(line);
  if (npx !== null)
    return { kind: "compiled", files: npx[1] ? [unquote(npx[1])] : [] };
  const check = CHECK_LINE.exec(line);
  if (check !== null && unquote(check[1]).endsWith(`/${HOOK_CHECK_REF}`))
    return { kind: "compiled", files: [unquote(check[1])] };
  // SPIKE: the `script` branch (#361) is the other half of this classifier and
  // is out of scope here; everything that is not our template stays opaque.
  return { kind: "opaque" };
}
