/**
 * RUNNERS — the closed table of programs that RUN a command they were handed,
 * and how each one carries it. Pure: no parser, no I/O. `execSites`
 * (`bash-effects.ts`) parses the strings a row hands back, with the same parser.
 *
 * Why a table: to the shell grammar, `bash -c "git push -f"` is three words and
 * the third is DATA. That `bash` runs it is a fact about the program, not the
 * grammar, so a walk over the AST stops at the leaf (vigiles#460). The wrappers
 * (`env`, `sudo`, …) were the first rows of this table and resolve in place.
 *
 * ⚠️ THE GUARANTEE IS THE TABLE'S, NOT THE WORLD'S. Every head here is either read
 * (its command becomes a site) or reported `unseen` with a reason. A program not
 * listed (`npx tool`, `make`, a git alias, `awk 'BEGIN{system(…)}'`) may run
 * anything; reporting each of those would make every command opaque.
 *
 * Each row also DECLARES the option grammar it reads (below): which
 * word is the command depends on it, so an undeclared form is unseen, not guessed.
 */

/** Stands in for each expansion of the OUTER shell when its string is re-parsed. */
export const HOLE = "$_";

/** One word as the receiving program gets it, outer expansions replaced by {@link HOLE}. */
export interface TemplateWord {
  readonly template: string;
  /** How many expansions of the outer shell (`$X`, `$(…)`, an unbound `$1`) it holds. */
  readonly holes: number;
  /** Nothing but expansions (`"$CMD"`): there is no text to read. */
  readonly opaque: boolean;
  /** Holds an escape the decoder does not know (`$'\q'`): the text is not trusted. */
  readonly undecodable: boolean;
}

/** One argv word: text the program receives, or a value known only at run time. */
export type ShellWord =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "dynamic" };

export const shellWord = (w: Readonly<TemplateWord>): ShellWord =>
  w.holes > 0 || w.undecodable
    ? { kind: "dynamic" }
    : { kind: "text", text: w.template };

/** Why the descent could not read a command it knows is run. */
export type UnseenReason =
  | { readonly kind: "dynamic-command-string" } // bash -c "$CMD"
  | { readonly kind: "hole-in-command-string" } // bash -c "git push $F": the hole is CODE
  | { readonly kind: "dynamic-eval" } // eval "$X"
  | { readonly kind: "stdin-fed-shell" } // curl … | sh
  | { readonly kind: "script-file"; readonly path: string | null }
  | { readonly kind: "foreign-interpreter"; readonly interpreter: string }
  | { readonly kind: "other-context"; readonly runner: string } // ssh, docker exec
  | { readonly kind: "dynamic-head" } // $G push
  /** An option, operand or form the runner's declared grammar does not cover. */
  | {
      readonly kind: "runner-options";
      readonly runner: string;
      readonly token: string;
    }
  | { readonly kind: "too-deep" }
  | { readonly kind: "too-large" }
  | { readonly kind: "parse-error" };

type Options = readonly string[];
type OpaqueString = "dynamic-eval" | "dynamic-command-string";
const DYNAMIC = "dynamic-command-string" as const;
type Otherwise =
  | { readonly kind: "none" }
  | { readonly kind: "stdin" }
  /** `flock FILE -c STR` or `flock FILE CMD…`: decided after the operands. */
  | { readonly kind: "after-operands" };

/** HOW a program carries the command it runs — one row of {@link RUNNERS}. */
export type Runner =
  /** Resolved in place (`env`, `sudo`, …); `env -S STR` splits STR into the command. */
  | {
      readonly mode: "wrapper";
      readonly grammar: Grammar;
      readonly split: Options;
      /** Options that make it run nothing (`command -v`, `sudo -l`). */
      readonly inspect: Options;
    }
  /** The rest of argv after the options and required operands is the command. */
  | {
      readonly mode: "argv-tail";
      readonly grammar: Grammar;
      readonly inspect: Options;
    }
  /** `find -exec CMD… ;` — each segment is a command; `{}` is filled at run time. */
  | {
      readonly mode: "argv-segment";
      readonly grammar: Grammar;
      readonly starts: Options;
    }
  /** `-c STRING`, else a script operand, else stdin (heredoc, here-string, a pipe). */
  | {
      readonly mode: "shell";
      readonly grammar: Grammar;
      readonly inspect: Options;
    }
  /** `su -c STRING`; without the option, `otherwise` says what runs. */
  | {
      readonly mode: "string-option";
      readonly grammar: Grammar;
      readonly command: Options;
      readonly otherwise: Otherwise;
    }
  /** The arguments joined by spaces are a shell string (`eval`, `watch` → `sh -c`). */
  | {
      readonly mode: "joined-args";
      readonly grammar: Grammar;
      readonly until: Options;
      /** Options that run the argv directly instead (`watch -x`). */
      readonly exec: Options;
      readonly opaque: OpaqueString;
    }
  | { readonly mode: "script-file" }
  /** Code in another language: marked, never parsed. */
  | {
      readonly mode: "foreign-interpreter";
      /** Words that hand it code (`--eval`, `-Command`, `eval`). */
      readonly code: Options;
      /** Short option letters that hand it code, alone or in a cluster (`-lne`). */
      readonly cluster: Options;
    }
  /** The command runs on another machine or in another root. */
  | { readonly mode: "other-context"; readonly subcommand: string | null };

export type RunnerMode = Runner["mode"];

/** One program on the path from the agent's command down to a site. */
export interface Carrier {
  readonly head: string;
  readonly mode: RunnerMode;
  /** The option or operator that handed the command on (`-c`, `<<<`, `-exec`), or "". */
  readonly by: string;
}

/** What the statement's stdin is, for a program that would read code from it. */
export type StdinFeed =
  | { readonly kind: "none" }
  | {
      readonly kind: "body";
      readonly by: "<<" | "<<<";
      readonly word: TemplateWord;
    }
  | { readonly kind: "file"; readonly path: string | null }
  /** `<&3`, `0<&-`, `0>f`: stdin was moved or closed — not followed. */
  | { readonly kind: "moved" };

/** What a row hands back for one command: a string to parse, an argv slice, or a reason. */
export type Carry =
  | {
      readonly kind: "string";
      readonly text: string;
      readonly holes: boolean;
      /** `$0 $1 …` of the string, when the carrier binds them (`bash -c S a0 a1`). */
      readonly args: readonly TemplateWord[];
      readonly carrier: Carrier;
    }
  | {
      readonly kind: "argv";
      readonly from: number;
      readonly to: number;
      readonly fill: string | null;
      readonly carrier: Carrier;
    }
  | {
      readonly kind: "unseen";
      readonly reason: UnseenReason;
      readonly carrier: Carrier;
    };

// ===========================================================================
// THE OPTION GRAMMAR a runner understands, declared per row of `RUNNERS`, and
// the ONE scanner that reads argv against it.
// ===========================================================================

/**
 * Why declared, not skipped: a runner's options decide which word is its
 * command. A scanner that skips whatever looks like an option, or knows only
 * some values, puts the wrong word at the head — `taskset -c -- 0 git push`
 * read `0` as the command, `watch -x` was joined into a shell string. So a
 * form the row does not declare is not guessed: the scan says `unknown`, and
 * the descent reports the site unseen (`runner-options`).
 *
 * GNU getopt rules, which every runner here follows: short options cluster
 * (`-qc`), a short value may be attached (`-n5`) or follow (`-n 5`), a long
 * value follows `=` or the next word, `--` ends the options. Without
 * `permute`, the first operand also ends them (getopt's `+`).
 */

/** What a runner accepts before its command. */
export interface Grammar {
  /** Options that take no value. Short ones (`-x`) may be clustered. */
  readonly flags: readonly string[];
  /** Options that take a value: `-u X`, `-uX`, `--user X`, `--user=X`. */
  readonly values: readonly string[];
  /** Options whose value is optional and only ever attached (`-i[R]`, `--preserve-env[=L]`). */
  readonly optional?: readonly string[];
  /** Required operands between the options and the command (`timeout DURATION`). */
  readonly operands?: number;
  /** `+x` turns an option off (shells). */
  readonly plus?: boolean;
  /** Operands do not end the options (`su me -c CMD`). */
  readonly permute?: boolean;
  /** `NAME=value` words before the command are environment (`env`). */
  readonly assigns?: boolean;
}

/** One argv word as the scanner needs it. */
export interface OptionWord {
  readonly text: string;
  /** An outer expansion stands where an option may: it could be any option. */
  readonly dynamic: boolean;
}

/** Where an option's value is. */
export type OptionValue =
  | { readonly kind: "flag" }
  | { readonly kind: "word"; readonly index: number }
  | {
      readonly kind: "attached";
      readonly index: number;
      readonly offset: number;
    };

export type OptionScan =
  | { readonly kind: "unknown"; readonly token: string }
  | {
      readonly kind: "parsed";
      /** Every option given, by its declared name (`+x` keeps its sign), in order. */
      readonly given: readonly (readonly [string, OptionValue])[];
      /** The operand words, in order: the required ones, and every one when permuting. */
      readonly operands: readonly number[];
      /** Where the command starts, or `null` when there is none. */
      readonly rest: number | null;
    };

interface State {
  readonly unknown: string | null;
  readonly ended: boolean;
  readonly pending: string | null;
  readonly given: readonly (readonly [string, OptionValue])[];
  readonly operands: readonly number[];
  readonly left: number;
  readonly rest: number | null;
}

const isAssignment = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);

/** `--name` / `--name=value`. */
function longOption(g: Grammar, s: State, t: string, i: number): State {
  const eq = t.indexOf("=");
  const name = eq < 0 ? t : t.slice(0, eq);
  const take = (v: OptionValue): State => ({
    ...s,
    given: [...s.given, [name, v]],
  });
  if (g.flags.includes(name) && eq < 0) return take({ kind: "flag" });
  if (g.optional?.includes(name))
    return take(
      eq < 0
        ? { kind: "flag" }
        : { kind: "attached", index: i, offset: eq + 1 },
    );
  if (!g.values.includes(name)) return { ...s, unknown: t };
  if (eq < 0) return { ...s, pending: name };
  return take({ kind: "attached", index: i, offset: eq + 1 });
}

/** One option word and where it is. */
interface Token {
  readonly text: string;
  readonly index: number;
}

/** `-abc`, `-n5`, `+x`: each letter a flag until one takes the rest as its value. */
function shortCluster(g: Grammar, s: State, t: Token, k = 1): State {
  const letter = t.text[k];
  if (letter === undefined) return s;
  const name = `${t.text[0] ?? "-"}${letter}`;
  const declared = `-${letter}`;
  const take = (v: OptionValue): State => ({
    ...s,
    given: [...s.given, [name, v]],
  });
  if (g.flags.includes(declared))
    return shortCluster(g, take({ kind: "flag" }), t, k + 1);
  const attached = k < t.text.length - 1;
  const rest: OptionValue = { kind: "attached", index: t.index, offset: k + 1 };
  if (g.optional?.includes(declared))
    return take(attached ? rest : { kind: "flag" });
  if (!g.values.includes(declared)) return { ...s, unknown: t.text };
  return attached ? take(rest) : { ...s, pending: name };
}

function optionWord(
  g: Grammar,
  s: State,
  w: OptionWord,
  i: number,
): State | null {
  const t = w.text;
  if (w.dynamic) return { ...s, unknown: t };
  if (t === "--") return { ...s, ended: true };
  if (t.startsWith("--")) return longOption(g, s, t, i);
  const signed = t.startsWith("-") || (g.plus === true && t.startsWith("+"));
  if (signed && t.length > 1) return shortCluster(g, s, { text: t, index: i });
  return g.assigns === true && isAssignment(t) ? s : null;
}

function operandWord(g: Grammar, s: State, i: number): State {
  if (s.left > 0)
    return {
      ...s,
      operands: [...s.operands, i],
      left: s.left - 1,
      ended: s.ended || !g.permute,
    };
  if (g.permute === true) return { ...s, operands: [...s.operands, i] };
  return { ...s, rest: i };
}

function step(g: Grammar, s: State, w: OptionWord, i: number): State {
  if (s.unknown !== null || s.rest !== null) return s;
  if (s.pending !== null)
    return {
      ...s,
      pending: null,
      given: [...s.given, [s.pending, { kind: "word", index: i }]],
    };
  const option = s.ended ? null : optionWord(g, s, w, i);
  return option ?? operandWord(g, s, i);
}

/**
 * Read `words[from…]` against `g`. `unknown` names the first token the grammar
 * does not declare (or an expansion where an option may stand). A command is
 * only reported once every required operand and pending value is present.
 */
export function scanOptions(
  g: Grammar,
  words: readonly OptionWord[],
  from: number,
): OptionScan {
  const start: State = {
    unknown: null,
    ended: false,
    pending: null,
    given: [],
    operands: [],
    left: g.operands ?? 0,
    rest: null,
  };
  const s = words.reduce(
    (acc: State, w, i) => (i < from ? acc : step(g, acc, w, i)),
    start,
  );
  if (s.unknown !== null) return { kind: "unknown", token: s.unknown };
  const complete = s.pending === null && s.left === 0;
  return {
    kind: "parsed",
    given: s.given,
    operands: s.operands,
    rest: complete ? s.rest : null,
  };
}

/** The value given for any of `names`, last one wins. */
export function optionValue(
  scan: Extract<OptionScan, { kind: "parsed" }>,
  names: readonly string[],
): OptionValue | null {
  return scan.given.filter(([n]) => names.includes(n)).at(-1)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The grammars. Each list is what the program's own manual page declares, as
// one space-separated string per kind; a form left out is unseen, so a missing
// option costs a question, never a miss.
// ---------------------------------------------------------------------------

/** `"-a --all"` → `["-a", "--all"]`. */
const list = (names: string): Options => (names === "" ? [] : names.split(" "));
const g = (flags: string, values = "", operands = 0): Grammar => ({
  flags: list(flags),
  values: list(values),
  operands,
});

/** POSIX `sh` (dash, ash, ksh, mksh; zsh beyond these is unseen). */
const POSIX_SH: Grammar = {
  ...g("-a -b -C -e -f -h -i -m -n -u -v -x -c -s -l -E -V", "-o"),
  plus: true,
};
const BASH: Grammar = {
  ...POSIX_SH,
  flags: [
    ...POSIX_SH.flags,
    ...list("-B -H -P -T -k -p -t -r -D --norc --noprofile --login --posix"),
    ...list("--restricted --verbose --noediting --debugger --dump-strings"),
    ...list("--dump-po-strings --pretty-print --help --version"),
  ],
  values: list("-o -O --rcfile --init-file"),
};
/** A shell that runs nothing: `-n` reads without executing; the rest print. */
const SHELL_INSPECT = list(
  "-n -D --dump-strings --dump-po-strings --pretty-print --help --version",
);
const SUDO: Grammar = {
  ...g(
    "-A --askpass -b --background -E -e --edit -H --set-home -i --login -K " +
      "--remove-timestamp -k --reset-timestamp -l --list -n --non-interactive " +
      "-P --preserve-groups -S --stdin -s --shell -V --version -v --validate " +
      "-B --bell -N --no-update",
    "-u --user -g --group -p --prompt -C --close-from -h --host -r --role -t " +
      "--type -U --other-user -R --chroot -D --chdir -T --command-timeout",
  ),
  optional: ["--preserve-env"],
};
const XARGS: Grammar = {
  ...g(
    "-0 --null -r --no-run-if-empty -t --verbose -p --interactive -x --exit " +
      "-o --open-tty --show-limits",
    "-a --arg-file -d --delimiter -I -n --max-args -L -P --max-procs -s " +
      "--max-chars --process-slot-var -E",
  ),
  optional: list("-i --replace -e --eof -l --max-lines"),
};
const SU_FLAGS = "-l --login -m -p --preserve-environment -f --fast -P --pty";
const SU_VALUES =
  "-c --command -s --shell -g --group -G --supp-group -w --whitelist-environment";
const COMMAND = list("-c --command");
const EVAL = "eval";
const SCRIPT_FILE = "script-file" as const;
const STDIN: Otherwise = { kind: "stdin" };

const rows = (
  heads: string,
  runner: Runner,
): readonly (readonly [string, Runner])[] =>
  list(heads).map((h) => [h, runner] as const);

const wrapper = (grammar: Grammar, inspect = "", split = ""): Runner => ({
  mode: "wrapper",
  grammar,
  split: list(split),
  inspect: list(inspect),
});
const tail = (grammar: Grammar, inspect = ""): Runner => ({
  mode: "argv-tail",
  grammar,
  inspect: list(inspect),
});
const stringRow = (
  grammar: Grammar,
  otherwise: Otherwise,
  command = COMMAND,
): Runner => ({ mode: "string-option", grammar, command, otherwise });
const joinedRow = (
  grammar: Grammar,
  until = "",
  exec = "",
  opaque: OpaqueString = DYNAMIC,
): Runner => ({
  mode: "joined-args",
  grammar,
  until: list(until),
  exec: list(exec),
  opaque,
});
const foreignRow = (code: string, cluster = ""): Runner => ({
  mode: "foreign-interpreter",
  code: list(code),
  cluster: list(cluster),
});
const elsewhere = (subcommand: string | null): Runner => ({
  mode: "other-context",
  subcommand,
});

/**
 * The table, keyed by the head's basename. `ssh` and `docker exec` stay
 * `other-context` until a descent that tracks the context exists.
 */
export const RUNNERS: ReadonlyMap<string, Runner> = new Map([
  ...rows(
    "env",
    wrapper(
      {
        ...g(
          "-i --ignore-environment -0 --null -v --debug",
          "-u --unset -C --chdir -S --split-string",
        ),
        assigns: true,
      },
      "",
      "-S --split-string",
    ),
  ),
  ...rows("command", wrapper(g("-p -v -V"), "-v -V")),
  ...rows("nice", wrapper(g("", "-n --adjustment"))),
  ...rows(
    "timeout",
    wrapper(
      g(
        "--preserve-status --foreground -v --verbose",
        "-s --signal -k --kill-after",
        1,
      ),
    ),
  ),
  ...rows(
    "sudo",
    wrapper(
      SUDO,
      "-e --edit -l --list -V --version -v --validate -K --remove-timestamp",
    ),
  ),
  ...rows("xargs", wrapper(XARGS, "--show-limits")),
  ...rows("nohup", wrapper(g(""))),
  ...rows("exec", tail(g("-c -l", "-a"))),
  ...rows("builtin", tail(g(""))),
  ...rows("setsid", tail(g("-c --ctty -f --fork -w --wait"))),
  ...rows("stdbuf", tail(g("", "-i -o -e --input --output --error"))),
  ...rows(
    "ionice",
    tail(
      g("-t --ignore", "-c --class -n --classdata -p --pid -P --pgid -u --uid"),
      "-p --pid -P --pgid -u --uid",
    ),
  ),
  ...rows(
    "chrt",
    tail(
      g(
        "-a --all-tasks -b --batch -d --deadline -f --fifo -i --idle -o --other " +
          "-r --rr -R --reset-on-fork -m --max -p --pid -v --verbose",
        "-T --sched-runtime -P --sched-period -D --sched-deadline",
        1,
      ),
      "-m --max -p --pid",
    ),
  ),
  ...rows(
    "taskset",
    tail(g("-a --all-tasks -c --cpu-list -p --pid", "", 1), "-p --pid"),
  ),
  ...rows(
    "time",
    tail(
      g(
        "-p --portability -v --verbose -a --append -q --quiet",
        "-f --format -o --output",
      ),
    ),
  ),
  ...rows("find", {
    mode: "argv-segment",
    grammar: { ...g("-H -L -P", "-D"), optional: ["-O"] },
    starts: list("-exec -execdir -ok -okdir"),
  }),
  ...rows("sh dash zsh ksh mksh ash", {
    mode: "shell",
    grammar: POSIX_SH,
    inspect: SHELL_INSPECT,
  }),
  ...rows("bash", { mode: "shell", grammar: BASH, inspect: SHELL_INSPECT }),
  ...rows("su", stringRow({ ...g(SU_FLAGS, SU_VALUES), permute: true }, STDIN)),
  ...rows(
    "runuser",
    stringRow(
      { ...g(SU_FLAGS, `${SU_VALUES} -u --user`), permute: true },
      STDIN,
    ),
  ),
  ...rows(
    "flock",
    stringRow(
      g(
        "-s --shared -x --exclusive -e -n --nonblock --nb -u --unlock -o --close -F --no-fork",
        "-w --wait --timeout -E --conflict-exit-code",
        1,
      ),
      { kind: "after-operands" },
    ),
  ),
  ...rows(
    "script",
    stringRow(
      {
        ...g(
          "-a --append -e --return -f --flush -q --quiet",
          "-c --command -E --echo -I --log-in -O --log-out -B --log-io -T " +
            "--log-timing -m --logging-format",
        ),
        optional: list("-t --timing"),
        permute: true,
      },
      STDIN,
    ),
  ),
  ...rows(
    "npx",
    stringRow(
      g("-y --yes --no -q --quiet", "-p --package -c --call"),
      { kind: "none" },
      list("-c --call"),
    ),
  ),
  ...rows(EVAL, joinedRow(g(""), "", "", "dynamic-eval")),
  ...rows(
    "watch",
    joinedRow(
      {
        ...g(
          "-b --beep -c --color -C --no-color -e --errexit -g --chgexit -p " +
            "--precise -r --no-rerun -t --no-title -w --no-wrap -x --exec",
          "-n --interval -q --equexit",
        ),
        optional: list("-d --differences"),
      },
      "",
      "-x --exec",
    ),
  ),
  ...rows(
    "parallel",
    joinedRow(
      g(
        "-k --keep-order --line-buffer -u --ungroup",
        "-j --jobs -n --max-args -N",
      ),
      "::: :::: :::+ ::::+",
    ),
  ),
  ...rows("source .", { mode: SCRIPT_FILE }),
  ...rows("python python3", foreignRow("", "c")),
  ...rows("node bun", foreignRow(`--eval --print ${EVAL}`, "e p")),
  ...rows("perl ruby lua", foreignRow("", "e E")),
  ...rows("php", foreignRow("", "r")),
  ...rows("deno", foreignRow(EVAL)),
  ...rows("osascript", foreignRow("-e")),
  ...rows("pwsh powershell", foreignRow("-c -Command -EncodedCommand -e")),
  ...rows("fish", foreignRow("--command", "c")),
  ...rows("ssh nsenter chroot", elsewhere(null)),
  ...rows("docker podman kubectl lxc", elsewhere("exec")),
]);

/** The program's head, its words (index 0 is the head) and its stdin. */
export interface RunnerCall {
  readonly head: string;
  readonly words: readonly TemplateWord[];
  readonly stdin: StdinFeed;
}

type Row<M extends RunnerMode> = Extract<Runner, { mode: M }>;
type Parsed = Extract<OptionScan, { kind: "parsed" }>;

const carrier = (c: RunnerCall, mode: RunnerMode, by = ""): Carrier => ({
  head: c.head,
  mode,
  by,
});
const unseen = (reason: UnseenReason, by: Carrier): Carry => ({
  kind: "unseen",
  reason,
  carrier: by,
});
const textOf = (w: Readonly<TemplateWord>): string | null => {
  const s = shellWord(w);
  return s.kind === "text" ? s.text : null;
};

/** The tail of a word after `n` literal characters (`--command=STR` → `STR`). */
function sliceWord(w: Readonly<TemplateWord>, n: number): TemplateWord {
  const template = w.template.slice(n);
  const opaque = w.holes > 0 && template.split(HOLE).join("") === "";
  return { ...w, template, opaque };
}

/** A string the carrier hands to a shell: read it, or say why it cannot be read. */
function stringCarry(
  w: Readonly<TemplateWord>,
  args: readonly TemplateWord[],
  by: Carrier,
  opaque: OpaqueString = DYNAMIC,
): Carry {
  if (w.undecodable) return unseen({ kind: "parse-error" }, by);
  if (w.opaque) return unseen({ kind: opaque }, by);
  return {
    kind: "string",
    text: w.template,
    holes: w.holes > 0,
    args,
    carrier: by,
  };
}

/** Read the call's own options against the row's grammar. */
const scan = (grammar: Grammar, c: RunnerCall, from = 1): OptionScan =>
  scanOptions(
    grammar,
    c.words.map((w) => ({
      text: w.template,
      dynamic: w.holes > 0 && w.template.startsWith(HOLE),
    })),
    from,
  );

/** The word an option's value is, or null for a flag. */
function valueOf(
  words: readonly TemplateWord[],
  v: OptionValue | null,
): TemplateWord | null {
  if (v === null || v.kind === "flag") return null;
  const w = words[v.index];
  if (!w) return null;
  return v.kind === "word" ? w : sliceWord(w, v.offset);
}

const given = (s: Parsed, names: Options): boolean =>
  optionValue(s, names) !== null;

/** The form the row does not declare: unseen, with the token — or the opaque reason for an expansion. */
function notDeclared(
  c: RunnerCall,
  mode: RunnerMode,
  token: string,
  opaque: UnseenReason["kind"] | null = null,
): Carry {
  const by = carrier(c, mode);
  if (opaque === DYNAMIC || opaque === "dynamic-eval")
    if (token.startsWith(HOLE)) return unseen({ kind: opaque }, by);
  return unseen({ kind: "runner-options", runner: c.head, token }, by);
}

const argvCarry = (
  from: number,
  to: number,
  by: Carrier,
  fill: string | null = null,
): readonly Carry[] =>
  from < to ? [{ kind: "argv", from, to, fill, carrier: by }] : [];

function argvTail(r: Row<"argv-tail">, c: RunnerCall): readonly Carry[] {
  const s = scan(r.grammar, c);
  if (s.kind === "unknown") return [notDeclared(c, r.mode, s.token)];
  if (given(s, r.inspect) || s.rest === null) return [];
  return argvCarry(s.rest, c.words.length, carrier(c, r.mode));
}

const ends = (t: string): boolean => t === ";" || t === "+";

/**
 * `find`'s own options come first; its EXPRESSION (`-name x`, `-exec …;`) is not
 * an option list, so only `--` forms and the leading options are checked there.
 */
function argvSegments(r: Row<"argv-segment">, c: RunnerCall): readonly Carry[] {
  const s = scan(r.grammar, c);
  if (s.kind === "unknown" && s.token.startsWith("--"))
    return [notDeclared(c, r.mode, s.token)];
  return c.words.flatMap((w, i) => {
    if (!r.starts.includes(w.template)) return [];
    const end = c.words.findIndex((x, j) => j > i && ends(x.template));
    return end < 0
      ? []
      : argvCarry(i + 1, end, carrier(c, r.mode, w.template), "{}");
  });
}

function shell(r: Row<"shell">, c: RunnerCall): readonly Carry[] {
  const s = scan(r.grammar, c);
  if (s.kind === "unknown") return [notDeclared(c, r.mode, s.token, DYNAMIC)];
  if (given(s, r.inspect)) return [];
  const operands = c.words.slice(s.rest ?? c.words.length);
  const [first, ...rest] = operands;
  if (given(s, ["-c"]))
    return first ? [stringCarry(first, rest, carrier(c, r.mode, "-c"))] : [];
  if (first && !given(s, ["-s"]))
    return [
      unseen({ kind: SCRIPT_FILE, path: textOf(first) }, carrier(c, r.mode)),
    ];
  return [shellStdin(c, operands)];
}

/** A shell with no `-c` and no script reads its commands from stdin. */
function shellStdin(c: RunnerCall, operands: readonly TemplateWord[]): Carry {
  switch (c.stdin.kind) {
    case "none":
      return unseen({ kind: "stdin-fed-shell" }, carrier(c, "shell", "|"));
    case "file":
      return unseen(
        { kind: SCRIPT_FILE, path: c.stdin.path },
        carrier(c, "shell", "<"),
      );
    case "moved":
      return unseen({ kind: "stdin-fed-shell" }, carrier(c, "shell", "<&"));
    case "body": {
      const args = [c.words[0], ...operands].filter((w) => w !== undefined);
      return stringCarry(c.stdin.word, args, carrier(c, "shell", c.stdin.by));
    }
  }
}

/** `flock FILE -c STR` or `flock FILE CMD…`, once the operands are read. */
function afterOperands(
  c: RunnerCall,
  mode: RunnerMode,
  rest: number | null,
): readonly Carry[] {
  const at = rest === null ? undefined : c.words[rest];
  if (rest === null || !at) return [];
  if (!COMMAND.includes(at.template))
    return argvCarry(rest, c.words.length, carrier(c, mode));
  const str = c.words[rest + 1];
  return str ? [stringCarry(str, [], carrier(c, mode, at.template))] : [];
}

function stringOption(
  r: Row<"string-option">,
  c: RunnerCall,
): readonly Carry[] {
  const s = scan(r.grammar, c);
  if (s.kind === "unknown") return [notDeclared(c, r.mode, s.token)];
  const str = valueOf(c.words, optionValue(s, r.command));
  const by = carrier(c, r.mode, r.command[0]);
  if (str) return [stringCarry(str, [], by)];
  switch (r.otherwise.kind) {
    case "none":
      return [];
    case "stdin":
      return [unseen({ kind: "stdin-fed-shell" }, by)];
    case "after-operands":
      return afterOperands(c, r.mode, s.rest);
  }
}

function joinedArgs(r: Row<"joined-args">, c: RunnerCall): readonly Carry[] {
  const s = scan(r.grammar, c);
  if (s.kind === "unknown") return [notDeclared(c, r.mode, s.token, r.opaque)];
  if (s.rest === null) return [];
  if (given(s, r.exec))
    return argvCarry(s.rest, c.words.length, carrier(c, r.mode, r.exec[0]));
  const end = c.words.findIndex(
    (w, i) => i >= (s.rest ?? 0) && r.until.includes(w.template),
  );
  const parts = c.words.slice(s.rest, end < 0 ? c.words.length : end);
  const joinedWord: TemplateWord = {
    template: parts.map((w) => w.template).join(" "),
    holes: parts.reduce((n, w) => n + w.holes, 0),
    opaque: parts.every((w) => w.opaque),
    undecodable: parts.some((w) => w.undecodable),
  };
  return [stringCarry(joinedWord, [], carrier(c, r.mode), r.opaque)];
}

/** Does this word hand the interpreter code? */
function handsCode(r: Row<"foreign-interpreter">, t: string): boolean {
  if (t === "-" || r.code.some((o) => t === o || t.startsWith(`${o}=`)))
    return true;
  const cluster = t.startsWith("-") && !t.startsWith("--");
  return cluster && r.cluster.some((l) => t.indexOf(l, 1) > 0);
}

function foreign(
  r: Row<"foreign-interpreter">,
  c: RunnerCall,
): readonly Carry[] {
  const code = c.words.slice(1).some((w) => handsCode(r, w.template));
  if (!code && c.stdin.kind !== "body") return [];
  return [
    unseen(
      { kind: "foreign-interpreter", interpreter: c.head },
      carrier(c, r.mode),
    ),
  ];
}

/** The head's basename, as the table keys it. */
const baseName = (w: Readonly<TemplateWord> | undefined): string =>
  w && w.holes === 0 ? (w.template.split("/").at(-1) ?? "") : "";

/** Where resolving a wrapper chain stopped, and why. */
export type WrapperWalk =
  | { readonly kind: "command"; readonly at: number }
  | { readonly kind: "unknown"; readonly at: number; readonly token: string };

/** One wrapper layer: where its command starts, or why the walk stops at it. */
function wrapperLayer(
  words: readonly TemplateWord[],
  at: number,
): WrapperWalk | number {
  const r = RUNNERS.get(baseName(words[at]));
  if (r?.mode !== "wrapper") return { kind: "command", at };
  const s = scan(
    r.grammar,
    { head: "", words, stdin: { kind: "none" } },
    at + 1,
  );
  if (s.kind === "unknown") return { kind: "unknown", at, token: s.token };
  // `env -S` hands its command over in a string; `command -v` runs nothing.
  if (given(s, [...r.split, ...r.inspect]) || s.rest === null)
    return { kind: "command", at };
  return s.rest;
}

/**
 * Resolve wrappers by their declared grammars: the index of the real command,
 * or the wrapper whose option form is not declared.
 */
export function walkWrappers(
  words: readonly TemplateWord[],
  at = 0,
): WrapperWalk {
  const walk = words.reduce<WrapperWalk | number>(
    (w) => (typeof w === "number" ? wrapperLayer(words, w) : w),
    at,
  );
  return typeof walk === "number" ? { kind: "command", at: walk } : walk;
}
/** One token of GNU `env -S`: blanks, quotes, the escapes it knows, plain text. */
const ENV_S_TOKEN =
  /\s+|'(?:[^'\\]|\\[\\'])*'|"(?:[^"\\$]|\\["\\_])*"|\\[\\"'_tnrfv#$]|[^\s'"\\$#]+/gy;
const ENV_S_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["t", "\t"],
  ["n", "\n"],
  ["r", "\r"],
  ["f", "\f"],
  ["v", "\v"],
]);

/** A token's text, or `null` for a boundary: blanks, and an unquoted `\_`. */
function envSToken(t: string): string | null {
  if (/^\s/.test(t) || t === "\\_") return null;
  if (t.startsWith("'")) return t.slice(1, -1).replace(/\\([\\'])/g, "$1");
  if (t.startsWith('"'))
    return t
      .slice(1, -1)
      .replace(/\\(.)/g, (_m, ch: string) => (ch === "_" ? " " : ch));
  if (t.startsWith("\\")) return ENV_S_ESCAPES.get(t[1] ?? "") ?? t.slice(1);
  return t;
}

/**
 * GNU `env -S STR` splits STR into ARGUMENTS — quotes and backslash escapes, no
 * `;`, `&&` or pipes; an unquoted `\_` separates, a quoted one is a space. `null`
 * for what this does not model (`${VAR}`, `#`, `\c`, an unclosed quote): the
 * caller reports it unseen rather than guessing.
 */
export function splitEnvString(raw: string): readonly string[] | null {
  const tokens = Array.from(raw.matchAll(ENV_S_TOKEN), (m) => m[0]);
  if (tokens.join("").length !== raw.length) return null;
  const end = tokens.reduce<{
    readonly words: readonly string[];
    readonly cur: string | null;
  }>(
    (s, t) => {
      const text = envSToken(t);
      if (text === null)
        return s.cur === null ? s : { words: [...s.words, s.cur], cur: null };
      return { ...s, cur: (s.cur ?? "") + text };
    },
    { words: [], cur: null },
  );
  return end.cur === null ? end.words : [...end.words, end.cur];
}

const quoteWord = (w: Readonly<TemplateWord>): string =>
  w.holes > 0 || w.undecodable
    ? HOLE
    : `'${w.template.replaceAll("'", `'\\''`)}'`;

const textWord = (template: string): TemplateWord => ({
  template,
  holes: 0,
  opaque: false,
  undecodable: false,
});

/**
 * `env [OPTS] -S STR ARGS…` runs `env [OPTS] SPLIT(STR) ARGS…`: rebuilt as
 * quoted words, so the inner parse sees arguments only and resolves `env` again.
 */
function wrapperSplit(r: Row<"wrapper">, c: RunnerCall): readonly Carry[] {
  const s = scan(r.grammar, c);
  const v = s.kind === "parsed" ? optionValue(s, r.split) : null;
  const value = valueOf(c.words, v);
  if (!v || v.kind === "flag" || !value) return [];
  const by = carrier(c, r.mode, "-S");
  if (value.holes > 0) return [unseen({ kind: DYNAMIC }, by)];
  const parts = splitEnvString(value.template);
  if (parts === null) return [unseen({ kind: "parse-error" }, by)];
  const before = c.words.slice(1, v.kind === "word" ? v.index - 1 : v.index);
  const after = c.words.slice(v.index + 1);
  const text = [
    c.head,
    ...before.map(quoteWord),
    ...parts.map((t) => quoteWord(textWord(t))),
    ...after.map(quoteWord),
  ];
  return [
    {
      kind: "string",
      text: text.join(" "),
      holes: false,
      args: [],
      carrier: by,
    },
  ];
}

function scriptFile(r: Row<"script-file">, c: RunnerCall): readonly Carry[] {
  const path = c.words[1];
  return path
    ? [unseen({ kind: SCRIPT_FILE, path: textOf(path) }, carrier(c, r.mode))]
    : [];
}

function otherContext(
  r: Row<"other-context">,
  c: RunnerCall,
): readonly Carry[] {
  const runs =
    r.subcommand === null
      ? c.words.length > 1
      : c.words.some((w) => w.template === r.subcommand);
  return runs
    ? [unseen({ kind: "other-context", runner: c.head }, carrier(c, r.mode))]
    : [];
}

/** The rows whose command is an argv slice or a string the descent reads. */
function readable(r: Runner, c: RunnerCall): readonly Carry[] | null {
  switch (r.mode) {
    case "wrapper":
      return wrapperSplit(r, c);
    case "argv-tail":
      return argvTail(r, c);
    case "argv-segment":
      return argvSegments(r, c);
    case "shell":
      return shell(r, c);
    case "string-option":
      return stringOption(r, c);
    case "joined-args":
      return joinedArgs(r, c);
    default:
      return null;
  }
}

/** The rows whose command the descent cannot read, only name. */
function opaque(r: Runner, c: RunnerCall): readonly Carry[] {
  switch (r.mode) {
    case SCRIPT_FILE:
      return scriptFile(r, c);
    case "foreign-interpreter":
      return foreign(r, c);
    case "other-context":
      return otherContext(r, c);
    default:
      return [];
  }
}

/** What `call.head`'s row hands on: strings to parse, argv slices, or reasons. */
export function carriesOf(call: RunnerCall): readonly Carry[] {
  const r = RUNNERS.get(call.head);
  return r ? (readable(r, call) ?? opaque(r, call)) : [];
}

const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

/** One escape or one run of plain text — the whole (regular) grammar of `$'…'`. */
const ANSI_C_TOKEN =
  /\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|c(.)|(.)|$)|[^\\]+/gs;

/** A numeric escape (`\101`, `\x41`, `\u0041`, `\U00000041`), or undefined. */
function numericEscape(
  oct: string | undefined,
  hex: string | undefined,
  wide: string | undefined,
): string | null | undefined {
  if (oct) return String.fromCharCode(parseInt(oct, 8) & 0xff);
  if (hex) return String.fromCharCode(parseInt(hex, 16));
  if (!wide) return undefined;
  const cp = parseInt(wide, 16);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
}

function ansiCToken(m: readonly (string | undefined)[]): string | null {
  const [all = "", oct, hex, u4, u8, ctl, one] = m;
  if (!all.startsWith("\\")) return all;
  const n = numericEscape(oct, hex, u4 ?? u8);
  if (n !== undefined) return n;
  if (ctl) return String.fromCharCode(ctl.charCodeAt(0) & 0x1f);
  return ANSI_C_ESCAPES.get(one ?? "") ?? null;
}

/**
 * The text bash hands a program for `$'raw'` — ANSI-C quoting, which mvdan-sh
 * keeps undecoded. `null` for an escape this does not know: no guess (bash keeps
 * those as written, and a guard should not bet on which bash).
 */
export function decodeAnsiC(raw: string): string | null {
  const parts = Array.from(raw.matchAll(ANSI_C_TOKEN), (m) => ansiCToken(m));
  return parts.every((p) => p !== null) ? parts.join("") : null;
}
