/**
 * What a command the Codex agent EXECUTED says, read with the shell parser the
 * compiled hooks use — the two facts the Codex adapter puts in a `Trace`:
 *
 * - the command itself, out of the `bash -lc "…"` wrapper Codex runs every
 *   command in ({@link codexShell}), so `ToolCall.shell` carries the same thing
 *   Claude Code's `Bash` tool does;
 * - which skills it READ ({@link skillsReadBy}), because a `SKILL.md` read is
 *   how a Codex skill activation shows (Codex has no skill-selection event).
 *
 * A separate module because the shell parser is fenced (`NO_SHELL_PARSER` in
 * `eslint.config.mjs`): it reads a command a harness RAN, never a hook line, and
 * is listed in `PARSES_SHELL` for that reason.
 */
import { leafCommandsNormalized, readShell } from "../../core/bash-effects.js";
import type { SkillFire, ToolCall } from "../../core/harness-driver.js";

/** The shells Codex wraps a command in. */
const WRAPPING_SHELLS = new Set(["bash", "sh", "zsh"]);

/** `-lc`, `-c`, `-cl`: the option cluster Codex's wrapper passes before the script. */
const isScriptFlag = (flag: string): boolean =>
  /^-[lc]+$/.test(flag) && flag.includes("c");

/**
 * The command the MODEL asked for, out of the wrapper Codex runs it in.
 *
 * Codex executes every command as `/bin/bash -lc "<script>"` (codex-cli
 * 0.139.0, the real captures in `eval.test.ts`). The wrapper is this harness's
 * transport, not the agent's action — Claude Code's `Bash` tool carries the bare
 * script — so the shell FACT is the script, and a harness-neutral reader such as
 * the compiled-hook parser sees the same command on both. (That parser
 * deliberately does not read through `-l`: a login shell sources profile files
 * first, which a GATE must not assume away. Unwrapping here decides nothing
 * about safety; it names the command.) Anything that is not exactly one such
 * wrapper — a pipeline, a redirect, other flags — is returned unchanged.
 */
export function codexShell(command: string): string {
  const leaves = leafCommandsNormalized(command);
  const only = leaves.length === 1 ? leaves[0] : undefined;
  if (
    only === undefined ||
    only.redirects.length > 0 ||
    !WRAPPING_SHELLS.has(only.head)
  )
    return command;
  const [flag, script, ...rest] = only.args;
  return flag !== undefined &&
    script !== undefined &&
    rest.length === 0 &&
    isScriptFlag(flag)
    ? script
    : command;
}

/**
 * The programs whose job is to PRINT a file. A `SKILL.md` handed to one of them
 * is the model reading the skill, which is how a Codex skill activation shows.
 * Anything else that names the file is not a read of it: `grep name
 * skills/*\/SKILL.md` searches, `ls` lists, `cat > …/SKILL.md` and `tee` write.
 */
const FILE_PRINTERS = new Set([
  "cat",
  "sed",
  "head",
  "tail",
  "nl",
  "less",
  "more",
  "bat",
]);

const SKILL_FILE = "/SKILL.md";

/** The skills one shell command READS, by directory name, from the parsed command. */
function skillsReadBy(command: string): readonly string[] {
  return readShell(command).effects.flatMap((e) => {
    if (e.kind !== "leaf" || !FILE_PRINTERS.has(e.leaf.head)) return [];
    // `sed -i` edits the file in place: authoring the skill, not reading it.
    if (e.leaf.head === "sed" && e.leaf.hasFlag("i", "in-place")) return [];
    return e.leaf.args.flatMap((arg) => {
      if (!arg.endsWith(SKILL_FILE)) return [];
      const dir = arg.slice(0, -SKILL_FILE.length);
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      return name === "" ? [] : [name];
    });
  });
}

/**
 * Every skill activation in a Codex run. Codex has no discrete skill-selection
 * event: when a skill triggers, the model READS its `…/<name>/SKILL.md` with a
 * `command_execution`. So an activation is a command, parsed by the shell parser
 * the compiled hooks use, in which a file-printing program reads a `SKILL.md` —
 * never a substring of the command line, which counted writing, grepping and
 * listing the file as firing the skill. Best-effort by nature: a skill already in
 * context is not re-read (see `CODEX_TRIGGER_RATE_EXPERIMENTAL` in `eval.ts`).
 */
export function codexSkillFires(
  calls: readonly ToolCall[],
): readonly SkillFire[] {
  // `name` IS the command for a command_execution, so a call recorded before
  // `shell` existed still reads; a function-style name parses to nothing.
  return calls.flatMap((c) =>
    skillsReadBy(c.shell ?? codexShell(c.name)).map((id) => ({
      id,
      isError: c.isError,
      resultText: c.resultText,
    })),
  );
}
