/**
 * The tables behind `bash-dirs.ts`: each program's own "run in directory"
 * option, the wrappers read through their option grammar, and git's global
 * options. CLOSED — a program, option or spelling not listed here is not read,
 * and the leaf is unknown.
 *
 * Every row is checked against Fig's completion specs (`@withfig/autocomplete`,
 * a devDependency only — never loaded at hook runtime) by
 * `bash-dirs-table.test.ts`: Fig must know the option for that program and
 * subcommand with the same arity, or the row carries a reviewed exception.
 */

/** One program's own "run in directory" option. */
export interface DirRow {
  readonly program: string;
  /** The subcommands the row is for (`docker exec`), else the whole program. */
  readonly sub?: readonly string[];
  /** Spellings that take the directory as the NEXT word (and `--long=dir`). */
  readonly separate: readonly string[];
  /** Spellings that take it only attached by `=` (`terraform -chdir=dir`). */
  readonly equals: readonly string[];
  /** Repeats apply in order, each relative to the last (`make -C a -C b`). */
  readonly cumulative: boolean;
  /**
   * The option is read only before the program's first operand, and only the
   * options in `flags`/`valued` may precede it; an occurrence after the first
   * operand belongs to someone else (`bun run x.ts --cwd y`) and is unknown.
   */
  readonly beforeOperand: boolean;
  readonly flags?: readonly string[];
  readonly valued?: readonly string[];
  /**
   * The directory is inside a container: only an absolute value is read, and
   * without the option the leaf is unknown (it runs in the image's workdir).
   */
  readonly container?: boolean;
  /** Why Fig's spec disagrees with this row, when it does — reviewed by hand. */
  readonly figException?: string;
}

/** The program table, by program then subcommand. */
export const DIR_TABLE: readonly DirRow[] = [
  {
    program: "make",
    separate: ["-C", "--directory"],
    equals: [],
    cumulative: true,
    beforeOperand: false,
  },
  {
    program: "npm",
    separate: ["--prefix"],
    equals: [],
    cumulative: false,
    beforeOperand: false,
  },
  {
    program: "docker",
    sub: ["exec", "run"],
    separate: ["-w", "--workdir"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    flags: [
      "-i",
      "-t",
      "-it",
      "-ti",
      "-d",
      "--interactive",
      "--tty",
      "--detach",
      "--rm",
    ],
    valued: ["-e", "--env", "-u", "--user", "--env-file"],
    container: true,
  },
  {
    program: "terraform",
    separate: [],
    equals: ["-chdir"],
    cumulative: false,
    beforeOperand: true,
  },
  {
    program: "cargo",
    separate: ["-C"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    valued: ["-Z"],
  },
  {
    program: "bun",
    separate: ["--cwd"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
  },
  {
    program: "just",
    separate: ["--working-directory", "-d"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    valued: ["--justfile", "-f"],
  },
];

/** A wrapper's option grammar: what it reads before the program it runs. */
export interface WrapperSpec {
  /** Options without a value. */
  readonly flags: readonly string[];
  /** Options with a value (separate, or `--long=v`) that do not move it. */
  readonly valued: readonly string[];
  /** Options whose value is the directory the program runs in. */
  readonly chdir: readonly string[];
  /** Operands before the program (`timeout DURATION cmd`). */
  readonly operands?: number;
  /** `NAME=value` operands before the program (`env`). */
  readonly assigns?: boolean;
}

/** The wrappers, each read only with options from its own row. */
export const WRAPPERS: Readonly<Record<string, WrapperSpec | undefined>> = {
  env: {
    flags: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
    valued: ["-u", "--unset"],
    chdir: ["-C", "--chdir"],
    assigns: true,
  },
  sudo: {
    flags: [
      "-E",
      "-H",
      "-n",
      "-S",
      "-k",
      "-K",
      "-A",
      "-b",
      "-P",
      "--preserve-env",
      "--set-home",
      "--non-interactive",
      "--stdin",
      "--reset-timestamp",
      "--askpass",
      "--background",
      "--preserve-groups",
    ],
    valued: [
      "-u",
      "--user",
      "-g",
      "--group",
      "-U",
      "--other-user",
      "-C",
      "--close-from",
      "-T",
      "--command-timeout",
      "-p",
      "--prompt",
      "-h",
      "--host",
      "-r",
      "--role",
      "-t",
      "--type",
    ],
    chdir: ["-D", "--chdir"],
  },
  nice: { flags: [], valued: ["-n", "--adjustment"], chdir: [] },
  timeout: {
    flags: ["--preserve-status", "--foreground", "-v", "--verbose"],
    valued: ["-s", "--signal", "-k", "--kill-after"],
    chdir: [],
    operands: 1,
  },
  command: { flags: ["-p"], valued: [], chdir: [] },
  xargs: {
    flags: [
      "-0",
      "--null",
      "-r",
      "--no-run-if-empty",
      "-t",
      "--verbose",
      "-x",
      "--exit",
      "-p",
      "--interactive",
      "-o",
      "--open-tty",
    ],
    valued: [
      "-n",
      "--max-args",
      "-L",
      "--max-lines",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
      "-d",
      "--delimiter",
      "-a",
      "--arg-file",
      "-E",
      "-I",
    ],
    chdir: [],
  },
};

/** git's options before its subcommand. */
export const GIT_GLOBAL = {
  /** `-C <dir>`: cumulative, applied in order. */
  chdir: ["-C"],
  /** Point git at another repository or work tree: the leaf is unknown. */
  refuse: ["--git-dir", "--work-tree"],
  valued: [
    "-c",
    "--namespace",
    "--config-env",
    "--exec-path",
    "--super-prefix",
    "--attr-source",
    "--list-cmds",
  ],
  flags: [
    "-p",
    "--paginate",
    "-P",
    "--no-pager",
    "--bare",
    "--no-replace-objects",
    "--no-lazy-fetch",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-optional-locks",
    "--no-advice",
    "-v",
    "--version",
    "-h",
    "--help",
    "--html-path",
    "--man-path",
    "--info-path",
  ],
};
