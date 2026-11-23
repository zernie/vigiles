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
/** HOW a program carries the command it runs — one row of {@link RUNNERS}. */
export type Runner =
  /** Resolved in place by `stripWrappers` (`env`, `sudo`, …). */
  | { readonly mode: "wrapper" }
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
  /** The arguments joined by spaces are a shell string (`eval A B C`). */
  | {
      readonly mode: "joined-args";
      readonly opaque: OpaqueString;
    }
  | { readonly mode: "script-file" };

export type RunnerMode = Runner["mode"];

/** One program on the path from the agent's command down to a site. */
export interface Carrier {
  readonly head: string;
  readonly mode: RunnerMode;
  /** The option or operator that handed the command on (`-c`, `<<<`, `-exec`), or "". */
  readonly by: string;
}

/** What a row hands back for one command: a string to parse, an argv slice, or a reason. */
export type Carry =
  | {
      readonly kind: "string";
      readonly text: string;
      readonly holes: boolean;
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

const tail = (valueOpts: Options, positionals = 0): Runner => ({
  mode: "argv-tail",
  valueOpts,
  positionals,
});
const EVAL = "eval";
const SCRIPT_FILE = "script-file" as const;

/** The table, keyed by the head's basename. */
export const RUNNERS: ReadonlyMap<string, Runner> = new Map([
  ...rows(["env", "command", "nice", "timeout", "sudo", "xargs", "nohup"], {
    mode: "wrapper",
  }),
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
  ...rows([EVAL], { mode: "joined-args", opaque: "dynamic-eval" }),
  ...rows(["source", "."], { mode: SCRIPT_FILE }),
]);

/** The program's head and its words (index 0 is the head). */
export interface RunnerCall {
  readonly head: string;
  readonly words: readonly TemplateWord[];
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

/** A string the carrier hands to a shell: read it, or say why it cannot be read. */
function stringCarry(
  w: Readonly<TemplateWord>,
  by: Carrier,
  opaque: OpaqueString = DYNAMIC,
): Carry {
  if (w.undecodable) return unseen({ kind: "parse-error" }, by);
  if (w.opaque) return unseen({ kind: opaque }, by);
  return {
    kind: "string",
    text: w.template,
    holes: w.holes > 0,
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
  const [first] = operands;
  if (scan.c)
    return first ? [stringCarry(first, carrier(c, "shell", "-c"))] : [];
  if (first && !scan.s)
    return [
      unseen({ kind: SCRIPT_FILE, path: textOf(first) }, carrier(c, "shell")),
    ];
  // Heredoc and here-string bodies are read in a later step (#460); until then
  // a shell fed on stdin is unseen, never silent.
  return [unseen({ kind: "stdin-fed-shell" }, carrier(c, "shell", "|"))];
}

function joinedArgs(r: Row<"joined-args">, c: RunnerCall): readonly Carry[] {
  const parts = c.words.slice(c.words[1]?.template === "--" ? 2 : 1);
  if (parts.length === 0) return [];
  const joinedWord: TemplateWord = {
    template: parts.map((w) => w.template).join(" "),
    holes: parts.reduce((n, w) => n + w.holes, 0),
    opaque: parts.every((w) => w.opaque),
    undecodable: parts.some((w) => w.undecodable),
  };
  return [stringCarry(joinedWord, carrier(c, r.mode), r.opaque)];
}

function scriptFile(r: Row<"script-file">, c: RunnerCall): readonly Carry[] {
  const path = c.words[1];
  return path
    ? [unseen({ kind: SCRIPT_FILE, path: textOf(path) }, carrier(c, r.mode))]
    : [];
}

/** What one row hands on for one command. */
function readable(r: Runner, c: RunnerCall): readonly Carry[] {
  switch (r.mode) {
    case "wrapper":
      return []; // `stripWrappers` already resolved it in place
    case "argv-tail":
      return argvTail(r, c);
    case "argv-segment":
      return argvSegments(r, c);
    case "shell":
      return shell(c);
    case "joined-args":
      return joinedArgs(r, c);
    case SCRIPT_FILE:
      return scriptFile(r, c);
  }
}

/** What `call.head`'s row hands on: strings to parse, argv slices, or reasons. */
export function carriesOf(call: RunnerCall): readonly Carry[] {
  const r = RUNNERS.get(call.head);
  return r ? readable(r, call) : [];
}
