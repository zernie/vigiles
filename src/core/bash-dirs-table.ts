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
  /** Spellings that point the program elsewhere (another repository): the leaf is unknown. */
  readonly refuse?: readonly string[];
  /** Why Fig's spec disagrees with this row, when it does — reviewed by hand. */
  readonly figException?: string;
}

/**
 * The program table. A row with `sub` is for those subcommands and is found
 * before the program's own row, so it comes first. Seeded from the owner's
 * list, then checked against carapace-bin's completers (every `.Chdir(` in a
 * root or subcommand file) — the rows that came from there say so.
 */
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
    // npm's config shorthand table may map `-C` to `--prefix`; unread, so unknown.
    refuse: ["-C"],
    cumulative: false,
    beforeOperand: false,
    figException:
      "Fig's npm spec lists no npm config flags; --prefix is npm's `prefix` config, settable on any command (npm help config).",
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
    // carapace-bin: tofu_completer (the terraform fork keeps `-chdir=`).
    program: "tofu",
    separate: [],
    equals: ["-chdir"],
    cumulative: false,
    beforeOperand: true,
    figException:
      "Fig has no tofu spec; carapace-bin's tofu completer has `-chdir`.",
  },
  {
    // carapace-bin: cargo-watch_completer, `-C`/`--workdir`.
    program: "cargo",
    sub: ["watch"],
    separate: ["-C", "--workdir"],
    equals: [],
    cumulative: false,
    beforeOperand: false,
    figException:
      "Fig's cargo spec has no `watch` subcommand (a plugin); carapace-bin's cargo-watch completer has -C/--workdir.",
  },
  {
    program: "cargo",
    separate: ["-C"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    valued: ["-Z"],
    figException:
      "cargo -C is nightly-only (with -Z unstable-options); Fig's cargo spec predates it, carapace-bin's cargo completer has it.",
  },
  {
    // carapace-bin: bun_completer pm.go, `bun pm --cwd`.
    program: "bun",
    sub: ["pm"],
    separate: ["--cwd"],
    equals: [],
    cumulative: false,
    beforeOperand: false,
    figException:
      "Fig's bun spec has --cwd on i/add/rm only, not on pm; carapace-bin has it on pm.",
  },
  {
    program: "bun",
    separate: ["--cwd"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    figException:
      "Fig's bun spec has --cwd on install/add/remove, not on bun itself; bun's root --help and carapace-bin's root completer have it.",
  },
  {
    program: "just",
    separate: ["--working-directory", "-d"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    valued: ["--justfile", "-f"],
  },
  {
    // carapace-bin: go_completer (build flags, env, fmt, tool, test): `-C` must be the first flag.
    program: "go",
    sub: [
      "build",
      "run",
      "test",
      "install",
      "list",
      "vet",
      "env",
      "fmt",
      "tool",
      "generate",
      "clean",
      "get",
    ],
    separate: ["-C"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    figException:
      "Fig's go spec predates go 1.20's `-C dir` (must be the first flag); carapace-bin's go completer has it.",
  },
  {
    // carapace-bin: hg_completer, the global `--cwd`; `-R`/`--repository` points at another repository.
    program: "hg",
    separate: ["--cwd"],
    equals: [],
    refuse: ["-R", "--repository"],
    cumulative: false,
    beforeOperand: false,
    figException:
      "Fig has no hg spec; carapace-bin's hg completer has the global --cwd.",
  },
  {
    // carapace-bin: tig_completer, `-C <path>`.
    program: "tig",
    separate: ["-C"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    figException: "Fig has no tig spec; carapace-bin's tig completer has -C.",
  },
  {
    // carapace-bin: turbo_completer, the persistent `--cwd`.
    program: "turbo",
    separate: ["--cwd"],
    equals: [],
    cumulative: false,
    beforeOperand: false,
    figException:
      "Fig's turbo spec predates the persistent --cwd; carapace-bin's turbo completer has it.",
  },
  {
    // carapace-bin: terramate_completer, `-C`/`--chdir`.
    program: "terramate",
    separate: ["-C", "--chdir"],
    equals: [],
    cumulative: false,
    beforeOperand: true,
    figException:
      "Fig has no terramate spec; carapace-bin's terramate completer has -C/--chdir.",
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
  /** Why Fig's spec lacks the `chdir` options, when it does — reviewed by hand. */
  readonly figException?: string;
}

/** The wrappers, each read only with options from its own row. */
export const WRAPPERS: Readonly<Record<string, WrapperSpec | undefined>> = {
  env: {
    flags: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
    valued: ["-u", "--unset"],
    chdir: ["-C", "--chdir"],
    assigns: true,
    figException:
      "Fig's env spec predates coreutils 8.28's -C/--chdir; carapace-bin's env completer has --chdir/-C.",
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
    figException:
      "Fig's sudo spec predates sudo 1.9.3's -D/--chdir (sudo(8)); carapace-bin has no sudo .Chdir.",
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
