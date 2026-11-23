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
  | { readonly kind: "too-deep" }
  | { readonly kind: "too-large" }
  | { readonly kind: "parse-error" };

type Options = readonly string[];
type OpaqueString = "dynamic-eval" | "dynamic-command-string";
const DYNAMIC = "dynamic-command-string" as const;
type Otherwise =
  | { readonly kind: "none" }
  | { readonly kind: "stdin" }
  | { readonly kind: "argv-tail"; readonly positionals: number };

/** HOW a program carries the command it runs — one row of {@link RUNNERS}. */
export type Runner =
  /** Resolved in place by `stripWrappers`; `env -S STR` splits STR into the command. */
  | { readonly mode: "wrapper"; readonly split: Options }
  /** The rest of argv after its options and N positionals is the command. */
  | {
      readonly mode: "argv-tail";
      readonly valueOpts: Options;
      readonly positionals: number;
    }
  /** `find -exec CMD… ;` — each segment is a command; `{}` is filled at run time. */
  | { readonly mode: "argv-segment"; readonly starts: Options }
  /** `-c STRING`, else a script operand, else stdin (heredoc, here-string, a pipe). */
  | { readonly mode: "shell" }
  /** `su -c STRING`; without the option, `otherwise` says what runs. */
  | {
      readonly mode: "string-option";
      readonly options: Options;
      readonly valueOpts: Options;
      readonly otherwise: Otherwise;
    }
  /** The arguments joined by spaces are a shell string (`eval`, `watch` → `sh -c`). */
  | {
      readonly mode: "joined-args";
      readonly valueOpts: Options | null;
      readonly until: Options;
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
  | { readonly kind: "file"; readonly path: string | null };

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

const rows = (
  heads: Options,
  runner: Runner,
): readonly (readonly [string, Runner])[] =>
  heads.map((h) => [h, runner] as const);

const wrapper = (split: Options): Runner => ({ mode: "wrapper", split });
const tail = (valueOpts: Options, positionals = 0): Runner => ({
  mode: "argv-tail",
  valueOpts,
  positionals,
});
const COMMAND: Options = ["-c", "--command"];
const EVAL = "eval";
const SCRIPT_FILE = "script-file" as const;
const STDIN: Otherwise = { kind: "stdin" };
const stringOption = (
  valueOpts: Options,
  otherwise: Otherwise,
  options = COMMAND,
): Runner => ({ mode: "string-option", options, valueOpts, otherwise });
const joined = (
  valueOpts: Options | null,
  until: Options,
  opaque: OpaqueString = DYNAMIC,
): Runner => ({ mode: "joined-args", valueOpts, until, opaque });
const foreignRow = (code: Options, cluster: Options = []): Runner => ({
  mode: "foreign-interpreter",
  code,
  cluster,
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
    ["command", "nice", "timeout", "sudo", "xargs", "nohup"],
    wrapper([]),
  ),
  ...rows(["env"], wrapper(["-S", "--split-string"])),
  ...rows(["exec"], tail(["-a"])),
  ...rows(["builtin", "setsid"], tail([])),
  ...rows(
    ["stdbuf"],
    tail(["-i", "-o", "-e", "--input", "--output", "--error"]),
  ),
  ...rows(["ionice"], tail(["-c", "--class", "-n", "--classdata", "-p", "-P"])),
  ...rows(["chrt"], tail(["-T", "-P", "-D"], 1)),
  ...rows(["taskset"], tail([], 1)),
  ...rows(["time"], tail(["-f", "--format", "-o", "--output"])),
  ...rows(["find"], {
    mode: "argv-segment",
    starts: ["-exec", "-execdir", "-ok", "-okdir"],
  }),
  ...rows(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash"], {
    mode: "shell",
  }),
  ...rows(
    ["su", "runuser"],
    stringOption(["-s", "--shell", "-g", "-G", "-u", "--user"], STDIN),
  ),
  ...rows(
    ["flock"],
    stringOption(["-w", "--wait", "--timeout", "-E"], {
      kind: "argv-tail",
      positionals: 1,
    }),
  ),
  ...rows(
    ["script"],
    stringOption(["-E", "--echo", "-I", "-O", "-B", "-T", "-m"], STDIN),
  ),
  ...rows(
    ["npx"],
    stringOption(["-p", "--package"], { kind: "none" }, ["-c", "--call"]),
  ),
  ...rows([EVAL], joined(null, [], "dynamic-eval")),
  ...rows(["watch"], joined(["-n", "--interval", "-q", "--equexit"], [])),
  ...rows(
    ["parallel"],
    joined(
      ["-j", "--jobs", "-n", "--max-args"],
      [":::", "::::", ":::+", "::::+"],
    ),
  ),
  ...rows(["source", "."], { mode: SCRIPT_FILE }),
  ...rows(["python", "python3"], foreignRow([], ["c"])),
  ...rows(["node", "bun"], foreignRow(["--eval", "--print", EVAL], ["e", "p"])),
  ...rows(["perl", "ruby", "lua"], foreignRow([], ["e", "E"])),
  ...rows(["php"], foreignRow([], ["r"])),
  ...rows(["deno"], foreignRow([EVAL])),
  ...rows(["osascript"], foreignRow(["-e"])),
  ...rows(
    ["pwsh", "powershell"],
    foreignRow(["-c", "-Command", "-EncodedCommand", "-e"]),
  ),
  ...rows(["fish"], foreignRow(["--command"], ["c"])),
  ...rows(["ssh", "nsenter", "chroot"], elsewhere(null)),
  ...rows(["docker", "podman", "kubectl", "lxc"], elsewhere("exec")),
]);

/** The program's head, its words (index 0 is the head) and its stdin. */
export interface RunnerCall {
  readonly head: string;
  readonly words: readonly TemplateWord[];
  readonly stdin: StdinFeed;
}

type Row<M extends RunnerMode> = Extract<Runner, { mode: M }>;

const isOption = (t: string): boolean => t.length > 1 && t.startsWith("-");
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

interface OperandScan {
  readonly at: number | null;
  readonly skip: boolean;
  readonly left: number;
}

/** Index of the first operand after the options and `positionals` positionals. */
function operandStart(
  words: readonly TemplateWord[],
  valueOpts: Options,
  positionals: number,
): number | null {
  return words.reduce<OperandScan>(
    (s, w, i) => {
      if (i === 0 || s.at !== null) return s;
      if (s.skip) return { ...s, skip: false };
      if (w.template === "--") return { ...s, at: i + 1 };
      if (isOption(w.template))
        return { ...s, skip: valueOpts.includes(w.template) };
      if (s.left > 0) return { ...s, left: s.left - 1 };
      return { ...s, at: i };
    },
    { at: null, skip: false, left: positionals },
  ).at;
}

const argvCarry = (
  from: number,
  to: number,
  by: Carrier,
  fill: string | null = null,
): readonly Carry[] =>
  from < to ? [{ kind: "argv", from, to, fill, carrier: by }] : [];

function argvTail(r: Row<"argv-tail">, c: RunnerCall): readonly Carry[] {
  const at = operandStart(c.words, r.valueOpts, r.positionals);
  return at === null ? [] : argvCarry(at, c.words.length, carrier(c, r.mode));
}

const ends = (t: string): boolean => t === ";" || t === "+";

function argvSegments(r: Row<"argv-segment">, c: RunnerCall): readonly Carry[] {
  return c.words.flatMap((w, i) => {
    if (!r.starts.includes(w.template)) return [];
    const end = c.words.findIndex((x, j) => j > i && ends(x.template));
    return end < 0
      ? []
      : argvCarry(i + 1, end, carrier(c, r.mode, w.template), "{}");
  });
}

interface ShellScan {
  readonly at: number | null;
  readonly skip: number;
  readonly c: boolean;
  readonly s: boolean;
  readonly dynamic: boolean;
}

const count = (t: string, ch: string): number => t.split(ch).length - 1;

/** One word of a shell's options: bash and POSIX allow options before and after `-c`. */
function shellOption(s: ShellScan, t: string, i: number): ShellScan {
  if (t === "--" || t === "-") return { ...s, at: i + 1 };
  if (t.startsWith("--"))
    return { ...s, skip: t === "--rcfile" || t === "--init-file" ? 1 : 0 };
  if (t.length < 2 || (t[0] !== "-" && t[0] !== "+")) return { ...s, at: i };
  return shellCluster(s, t);
}

/** `-lc`, `-eo pipefail`, `+x`: which flags it sets and how many values it takes. */
function shellCluster(s: ShellScan, t: string): ShellScan {
  const on = t.startsWith("-");
  return {
    ...s,
    c: s.c || (on && t.includes("c")),
    s: s.s || (on && t.includes("s")),
    skip: count(t, "o") + count(t, "O"),
  };
}

function scanShell(words: readonly TemplateWord[]): ShellScan {
  return words.reduce<ShellScan>(
    (s, w, i) => {
      if (i === 0 || s.at !== null || s.dynamic) return s;
      if (s.skip > 0) return { ...s, skip: s.skip - 1 };
      // An expansion where an option may stand could BE `-c`: the string is unknowable.
      const option = w.holes > 0 && w.template.startsWith(HOLE);
      return option ? { ...s, dynamic: true } : shellOption(s, w.template, i);
    },
    { at: null, skip: 0, c: false, s: false, dynamic: false },
  );
}

function shell(c: RunnerCall): readonly Carry[] {
  const scan = scanShell(c.words);
  if (scan.dynamic) return [unseen({ kind: DYNAMIC }, carrier(c, "shell"))];
  const operands = c.words.slice(scan.at ?? c.words.length);
  const [first, ...rest] = operands;
  if (scan.c)
    return first ? [stringCarry(first, rest, carrier(c, "shell", "-c"))] : [];
  if (first && !scan.s)
    return [
      unseen({ kind: SCRIPT_FILE, path: textOf(first) }, carrier(c, "shell")),
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
    case "body": {
      const args = [c.words[0], ...operands].filter((w) => w !== undefined);
      return stringCarry(c.stdin.word, args, carrier(c, "shell", c.stdin.by));
    }
  }
}

interface OptionScan {
  readonly found: TemplateWord | null;
  readonly take: boolean;
  readonly skip: boolean;
  readonly left: number;
  readonly at: number | null;
}

/** `-c STR`, `-qc STR`, `-cSTR`, `--command=STR` — or null when `w` is none of them. */
function commandOption(
  r: Row<"string-option">,
  w: Readonly<TemplateWord>,
): Readonly<Partial<OptionScan>> | null {
  const t = w.template;
  if (r.options.includes(t)) return { take: true };
  const long = r.options.find(
    (o) => o.startsWith("--") && t.startsWith(`${o}=`),
  );
  if (long) return { found: sliceWord(w, long.length + 1) };
  if (!t.startsWith("-") || t.startsWith("--")) return null;
  const letters = r.options
    .filter((o) => o.length === 2)
    .map((o) => o.slice(1));
  const at = Math.min(
    ...letters.map((l) => t.indexOf(l, 1)).filter((i) => i > 0),
  );
  if (!Number.isFinite(at)) return null;
  return at === t.length - 1 ? { take: true } : { found: sliceWord(w, at + 1) };
}

function optionStep(
  r: Row<"string-option">,
  s: OptionScan,
  w: Readonly<TemplateWord>,
  i: number,
): OptionScan {
  if (s.take) return { ...s, take: false, found: w };
  if (s.skip) return { ...s, skip: false };
  const cmd = w.holes > 0 ? null : commandOption(r, w);
  if (cmd) return { ...s, ...cmd };
  if (w.holes === 0 && isOption(w.template))
    return { ...s, skip: r.valueOpts.includes(w.template) };
  if (r.otherwise.kind === "stdin") return s;
  return s.left > 0 ? { ...s, left: s.left - 1 } : { ...s, at: i };
}

function stringOptionCarry(
  r: Row<"string-option">,
  c: RunnerCall,
): readonly Carry[] {
  const left = r.otherwise.kind === "argv-tail" ? r.otherwise.positionals : 0;
  const scan = c.words.reduce<OptionScan>(
    (s, w, i) =>
      i === 0 || s.found || s.at !== null ? s : optionStep(r, s, w, i),
    { found: null, take: false, skip: false, left, at: null },
  );
  const by = carrier(c, r.mode, r.options[0]);
  if (scan.found) return [stringCarry(scan.found, [], by)];
  switch (r.otherwise.kind) {
    case "none":
      return [];
    case "stdin":
      return [unseen({ kind: "stdin-fed-shell" }, by)];
    case "argv-tail":
      return scan.at === null
        ? []
        : argvCarry(scan.at, c.words.length, carrier(c, r.mode));
  }
}

function joinedArgs(r: Row<"joined-args">, c: RunnerCall): readonly Carry[] {
  const skipDashes = c.words[1]?.template === "--" ? 2 : 1;
  const start =
    r.valueOpts === null
      ? skipDashes
      : (operandStart(c.words, r.valueOpts, 0) ?? c.words.length);
  const end = c.words.findIndex(
    (w, i) => i >= start && r.until.includes(w.template),
  );
  const parts = c.words.slice(start, end < 0 ? c.words.length : end);
  if (parts.length === 0) return [];
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

function wrapperSplit(r: Row<"wrapper">, c: RunnerCall): readonly Carry[] {
  const i = c.words.findIndex((w) => r.split.includes(w.template));
  const value = i > 0 ? c.words[i + 1] : undefined;
  return value
    ? [stringCarry(value, [], carrier(c, r.mode, c.words[i]?.template))]
    : [];
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
      return shell(c);
    case "string-option":
      return stringOptionCarry(r, c);
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
