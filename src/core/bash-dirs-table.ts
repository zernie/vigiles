/**
 * The tables behind `bash-dirs.ts`: git's global options, the git
 * subcommands whose own options cannot move git, and the one wrapper read
 * around git (`env`). CLOSED — a word not listed here is not read, and the
 * leaf is unknown. No other program is read at all: its leaf is unknown.
 *
 * The options the table READS (git's flags and `-C`, env's `-C`) are checked
 * against Fig's completion specs (`@withfig/autocomplete`, a devDependency
 * only — never loaded at hook runtime) by `bash-dirs-table.test.ts`: Fig must
 * know the option with the same arity, or the row carries a reviewed
 * exception.
 */

/**
 * What a second occurrence of a "run in directory" option does:
 *  - `cumulative`: each is applied relative to the one before (`git -C a -C b`
 *    runs in `a/b`);
 *  - `last-wins`: only the last counts, relative to where the program started
 *    (`env -C /a -C . cmd` runs in `.`).
 */
export type Repeat = "cumulative" | "last-wins";

/** What a git global option does to where git runs. */
export type GitEffect =
  /** Nothing: git runs where it would without it. */
  | "none"
  /** `-C <path>`: git changes directory before anything else. */
  | "chdir"
  /** It points git elsewhere, steers it through config, or stops it: unknown. */
  | "unknown";

/** One row of git(1) "OPTIONS". */
export interface GitGlobal {
  readonly names: readonly string[];
  /** Words it takes: 0, or 1 (a separate word, or `--long=v` for a long name). */
  readonly arity: 0 | 1;
  readonly effect: GitEffect;
  /** Why Fig's spec disagrees with this row, when it does — reviewed by hand. */
  readonly figException?: string;
}

const FIG_PREDATES =
  "Fig's git spec does not list it; git(1) OPTIONS lists it as a flag without a value.";

/**
 * git(1) "OPTIONS" (git 2.43, plus `--no-lazy-fetch` 2.44, `--no-advice` 2.46
 * and the removed `--super-prefix`). git reads these one word at a time up to
 * its subcommand (git.c `handle_options`): no clusters, no attached `-C<path>`,
 * no abbreviations, and `--` is not one of them.
 */
export const GIT_GLOBALS: readonly GitGlobal[] = [
  { names: ["-C"], arity: 1, effect: "chdir" },
  { names: ["-p", "--paginate"], arity: 0, effect: "none" },
  { names: ["--no-pager"], arity: 0, effect: "none" },
  { names: ["-P"], arity: 0, effect: "none", figException: FIG_PREDATES },
  { names: ["--no-replace-objects"], arity: 0, effect: "none" },
  { names: ["--no-optional-locks"], arity: 0, effect: "none" },
  ...[
    "--no-lazy-fetch",
    "--no-advice",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
  ].map(
    (n): GitGlobal => ({
      names: [n],
      arity: 0,
      effect: "none",
      figException: FIG_PREDATES,
    }),
  ),
  // Another repository or work tree: the leaf runs against it, not here.
  { names: ["--git-dir"], arity: 1, effect: "unknown" },
  { names: ["--work-tree"], arity: 1, effect: "unknown" },
  { names: ["--namespace"], arity: 1, effect: "unknown" },
  { names: ["--super-prefix"], arity: 1, effect: "unknown" },
  // Sets GIT_DIR to the current directory, so repository discovery changes.
  { names: ["--bare"], arity: 0, effect: "unknown" },
  // Config for this call: `core.worktree`, an `include.path`, or an alias that
  // runs a shell command (`alias.pull=!cd /x && git pull`) can each move it.
  { names: ["-c"], arity: 1, effect: "unknown" },
  { names: ["--config-env"], arity: 1, effect: "unknown" },
  // Where git finds its subcommand programs: another program runs.
  { names: ["--exec-path"], arity: 0, effect: "unknown" },
  { names: ["--attr-source"], arity: 1, effect: "unknown" },
  // Stop option parsing and print, or turn the rest into another command.
  { names: ["-v", "--version"], arity: 0, effect: "unknown" },
  { names: ["-h", "--help"], arity: 0, effect: "unknown" },
  { names: ["--html-path"], arity: 0, effect: "unknown" },
  { names: ["--man-path"], arity: 0, effect: "unknown" },
  { names: ["--info-path"], arity: 0, effect: "unknown" },
  { names: ["--list-cmds"], arity: 1, effect: "unknown" },
];

/**
 * git(1): "When multiple -C options are given, each subsequent non-absolute
 * -C <path> is interpreted relative to the preceding -C <path>"; git 2.43 run.
 */
export const GIT_CHDIR_REPEAT: Repeat = "cumulative";

/**
 * The subcommands read, each checked option by option (`git <sub> -h`, git
 * 2.43) for one that makes git work in another directory, repository or work
 * tree: none has one, so the words after the subcommand stay unread. A
 * repository operand or `--repo` (`git push /other`) names where git sends or
 * fetches data, not where it runs. `-C` after the subcommand is a commit
 * (`commit -C <commit>`) or a context count (`grep -C 3`), never a directory.
 *
 * Every other word in the subcommand's place is unknown — a builtin that can
 * work elsewhere (`worktree`, `clone`, `init`, `submodule`, `config --file`,
 * `log`/`diff`/`show --output`, `archive`, `bundle`, `format-patch -o`), an
 * alias, or an external `git-<name>` program.
 */
export const GIT_SUBCOMMANDS: readonly string[] = [
  "add",
  "commit",
  "fetch",
  "grep",
  "pull",
  "push",
  "status",
];

/** A wrapper's option grammar: what it reads before the program it runs. */
export interface WrapperSpec {
  /** Options without a value. */
  readonly flags: readonly string[];
  /** Options with a value (separate, or `--long=v`) that do not move it. */
  readonly valued: readonly string[];
  /** Options whose value is the directory the program runs in. */
  readonly chdir: readonly string[];
  /** What a second `chdir` option does. */
  readonly repeat: Repeat;
  /** Why Fig's spec lacks the `chdir` options, when it does — reviewed by hand. */
  readonly figException?: string;
}

/**
 * GNU env (coreutils 9.4, env.c): options until the first word that is not
 * one (`+` in its getopt string), `--` ends them; then a lone `-` (same as
 * `-i`), then `NAME=VALUE` operands, then the program — so an assignment after
 * `--` is still an assignment. Any option not listed here (`-S`, the signal
 * options, a cluster, an attached value, an abbreviation) is unknown.
 */
export const ENV: WrapperSpec = {
  flags: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
  valued: ["-u", "--unset"],
  chdir: ["-C", "--chdir"],
  // env keeps the last -C and changes directory once, after parsing
  // (`newdir = optarg`); coreutils 9.4 run: `env -C /tmp -C . pwd` prints
  // the starting directory.
  repeat: "last-wins",
  figException:
    "Fig's env spec predates coreutils 8.28's -C/--chdir; carapace-bin's env completer has --chdir/-C.",
};

/**
 * bash 5.2's builtins (`compgen -b`; `bash-dirs.test.ts` fails if bash lists
 * one that is missing here). A builtin runs inside the shell, so most can
 * change what a later leaf does — its directory (`.`/`source` a file that
 * `cd`s, `pushd`), the program a name runs (`hash -p`, `alias`, `enable`),
 * or the variables git reads (`export`, `read`, `printf -v`, `declare`).
 */
export const BASH_BUILTINS: readonly string[] = [
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
];

/**
 * The builtins that cannot change the shell: no option of theirs sets a
 * variable, an option, an alias, a function, the hash table or the directory
 * (bash(1) SHELL BUILTIN COMMANDS; `bash-dirs.test.ts` runs each under bash
 * and compares that state before and after). `printf` is not here: `printf
 * -v NAME` assigns a variable.
 */
export const SAFE_BUILTINS: readonly string[] = [
  "true",
  ":",
  "echo",
  "test",
  "[",
];
