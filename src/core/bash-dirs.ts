/**
 * Which directory each leaf of a Bash command line runs in — on a small CLOSED
 * grammar, the model behind `e.command.dirs()`.
 *
 * 🔴 CLOSED, NOT INTERPRETED. The previous model tried to interpret most of
 * bash (a directory state machine, steering assignments, functions, wrapper and
 * git option grammars) and review found a bypass in four rounds running. This
 * one reads only what it lists and calls everything else unknown, the design
 * shared by Codex's tree-sitter node allowlist, dcg's `resolve_effective_cwd`
 * and CoLiS (which rejects about a quarter of real scripts on purpose):
 *
 *  1. A line is a chain of SIMPLE commands joined by `&&`, `;`, `||` (a plain
 *     `a | b` counts as one link, every part in the same directory). The
 *     directory carries only across `&&`: after `;` or `||` every later leaf is
 *     unknown, because a failed `cd` leaves the old directory.
 *  2. `cd <word>` is read only when the word is plain text and absolute or
 *     starts with `./` or `../` — forms CDPATH never applies to. Any other
 *     `cd` makes the later leaves unknown.
 *  3. A program call is read word by word, CLOSED: every word is one the
 *     table lists, or the leaf is unknown. Only git is read — its global
 *     options by {@link GIT_GLOBALS} (`-C` cumulative, a `..` in its value
 *     unknown, since git resolves it physically and the model lexically), then
 *     a subcommand from {@link GIT_SUBCOMMANDS} — and only `env` around it
 *     (any assignment makes the git leaf unknown). Every other program and
 *     every other wrapper is unknown (`unread-program`).
 *  4. Every `cd`/`pushd`/`popd` word in the RAW line — inside quotes, nested
 *     shells, heredocs, comments — must be one the grammar consumed, or the
 *     whole line is unknown (dcg's reconcile).
 *  5. Any other construct anywhere makes the whole line unknown.
 *
 * Directories are returned as the text says them: absolute, or relative to the
 * directory the line starts in (`.`), normalized lexically like bash's logical
 * `cd`. Placing them under the event's `cwd` is the caller's job.
 */
import { shellSyntax, type ShellSyntaxNode } from "./bash-effects.js";
import {
  ENV,
  GIT_GLOBALS,
  GIT_CHDIR_REPEAT,
  GIT_SUBCOMMANDS,
  type Repeat,
} from "./bash-dirs-table.js";

/**
 * Why a leaf's directory is not known.
 *
 * @public
 */
export type UnresolvedDir =
  /** A construct outside the grammar somewhere in the line (rule 5). */
  | "outside-grammar"
  /** A `cd`/`pushd`/`popd` word the grammar did not consume (rule 4). */
  | "uncounted-cd"
  /** A `cd` the grammar does not read: a bare name, `-`, no operand, an option. */
  | "unread-cd"
  /** After a `;` or `||`: an earlier `cd` may have failed. */
  | "after-break"
  /** A word of the leaf is not plain text (quotes, `$`, glob, `~`, …). */
  | "unplain-word"
  /** A git or env word outside its table, a `..` in a `-C` value, an env assignment. */
  | "unread-option"
  /** A program other than git, or a git subcommand outside the list: its argv is not read. */
  | "unread-program";

/** Where one leaf runs. */
export type LeafDir =
  | { readonly kind: "dir"; readonly dir: string }
  | { readonly kind: "unknown"; readonly reason: UnresolvedDir };

/** One program call of a line the grammar reads. */
export interface DirLeaf {
  /** The leaf as written: its source text. */
  readonly text: string;
  /** The program's argv after the wrappers read off it; empty when unknown. */
  readonly argv: readonly string[];
  readonly at: LeafDir;
}

/** What the grammar makes of a line. */
export type LineDirs =
  | { readonly kind: "leaves"; readonly leaves: readonly DirLeaf[] }
  | {
      readonly kind: "unknown";
      readonly reason: "outside-grammar" | "uncounted-cd";
    };

// ---------------------------------------------------------------------------
// The syntax tree, as far as the grammar reads it
// ---------------------------------------------------------------------------

type Node = ShellSyntaxNode;

const AND = 10;
const OR = 11;
const PIPE = 12;

/** Text that means only itself to bash: no quote, `\`, `$`, glob, brace, `~`. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Expansions that run code — outside the grammar wherever they sit. */
const CODE_NODES = new Set(["CmdSubst", "ProcSubst", "ArithmExp"]);

/** Programs whose mere presence puts the line outside the grammar. */
const OUTSIDE_PROGRAMS = new Set([
  "eval",
  "source",
  ".",
  "exec",
  "trap",
  "pushd",
  "popd",
  "builtin",
  "enable",
  "set",
  "shopt",
  "alias",
  "unalias",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
]);

/** A word's literal text when it is plain, else `null`. */
function plainWord(word: Node): string | null {
  const parts = word.Parts ?? [];
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only === undefined || shellSyntax.nodeType(only) !== "Lit") return null;
  const v = only.Value ?? "";
  return PLAIN.test(v) ? v : null;
}

/** Does any part of this word run code (`$(…)`, `<(…)`, `$((…))`)? */
function runsCode(word: Node): boolean {
  let found = false; // eslint-disable-line functional/no-let -- set by the walk callback
  shellSyntax.walk(word, (n) => {
    if (CODE_NODES.has(shellSyntax.nodeType(n))) found = true;
    return !found;
  });
  return found;
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `p` joined onto `base` and normalized lexically, as bash's logical `cd`
 * does: `.` drops, `..` pops (and stays at `/`, or leads a relative path).
 */
export function joinDir(base: string, p: string): string {
  const abs = p.startsWith("/") || (base.startsWith("/") && !p.startsWith("/"));
  const segs = (p.startsWith("/") ? p : `${base}/${p}`).split("/");
  const out = segs.reduce<readonly string[]>((acc, s) => {
    if (s === "" || s === ".") return acc;
    if (s !== "..") return [...acc, s];
    if (acc.length > 0 && acc[acc.length - 1] !== "..") return acc.slice(0, -1);
    return abs ? acc : [...acc, ".."];
  }, []);
  if (abs) return `/${out.join("/")}`;
  return out.length === 0 ? "." : out.join("/");
}

const hasDotDot = (p: string): boolean => p.split("/").includes("..");

// ---------------------------------------------------------------------------
// Rule 1: statements and chains
// ---------------------------------------------------------------------------

type Sep = "start" | "&&" | "||" | ";";
interface Link {
  readonly sep: Sep;
  readonly calls: readonly Node[];
}
const OUT = "outside" as const;
type Out = typeof OUT;

/** A statement the grammar allows: no `!`, `&`, coprocess or redirection. */
function plainStmt(stmt: Node | undefined): Node | Out {
  if (stmt?.Cmd === undefined) return OUT;
  const ok =
    stmt.Negated !== true &&
    stmt.Background !== true &&
    stmt.Coprocess !== true &&
    (stmt.Redirs ?? []).length === 0;
  return ok ? stmt.Cmd : OUT;
}

/** Both sides of a binary command, each a plain statement. */
function sides(cmd: Node): readonly [Node, Node] | Out {
  const x = plainStmt(cmd.X);
  const y = plainStmt(cmd.Y);
  return x === OUT || y === OUT ? OUT : [x, y];
}

/** The calls of a plain pipeline (a lone call is a pipeline of one). */
function pipeline(cmd: Node): readonly Node[] | Out {
  const type = shellSyntax.nodeType(cmd);
  if (type === "CallExpr") return [cmd];
  if (type !== "BinaryCmd" || cmd.Op !== PIPE) return OUT;
  const xy = sides(cmd);
  if (xy === OUT) return OUT;
  const left = pipeline(xy[0]);
  const right = pipeline(xy[1]);
  return left === OUT || right === OUT ? OUT : [...left, ...right];
}

/** One statement's links in source order, `&&`/`||` flattened. */
function links(cmd: Node, sep: Sep): readonly Link[] | Out {
  const isList =
    shellSyntax.nodeType(cmd) === "BinaryCmd" &&
    (cmd.Op === AND || cmd.Op === OR);
  if (!isList) {
    const calls = pipeline(cmd);
    return calls === OUT ? OUT : [{ sep, calls }];
  }
  const xy = sides(cmd);
  if (xy === OUT) return OUT;
  const left = links(xy[0], sep);
  const right = links(xy[1], cmd.Op === AND ? "&&" : "||");
  return left === OUT || right === OUT ? OUT : [...left, ...right];
}

/** Every link of the line, or {@link OUT} for a construct outside the grammar. */
function lineLinks(file: Node): readonly Link[] | Out {
  const per = (file.Stmts ?? []).map((stmt, i) => {
    const cmd = plainStmt(stmt);
    const sep: Sep = i === 0 ? "start" : ";";
    return cmd === OUT ? OUT : links(cmd, sep);
  });
  return per.some((ls) => ls === OUT)
    ? OUT
    : per.flatMap((ls) => (ls === OUT ? [] : ls));
}

// ---------------------------------------------------------------------------
// Rules 2 and 3: a cd, a program
// ---------------------------------------------------------------------------

const unknown = (reason: UnresolvedDir): LeafDir => ({
  kind: "unknown",
  reason,
});
const known = (dir: string): LeafDir => ({ kind: "dir", dir });
const UNREAD_OPTION = unknown("unread-option");
const UNREAD_PROGRAM = unknown("unread-program");

/** Where the chain is after `cd <args>`, from `at`. */
function cdTo(args: readonly Node[], at: LeafDir): LeafDir {
  const word = args.length === 1 && args[0] ? plainWord(args[0]) : null;
  if (word === null) return unknown("unread-cd");
  if (word.startsWith("/")) return known(joinDir("/", word));
  if (!word.startsWith("./") && !word.startsWith("../"))
    return unknown("unread-cd");
  return at.kind === "dir" ? known(joinDir(at.dir, word)) : at;
}

/** A `-C` value, applied to the directory so far. */
function moveTo(at: LeafDir, value: string): LeafDir {
  if (at.kind === "unknown") return at;
  return hasDotDot(value) ? UNREAD_OPTION : known(joinDir(at.dir, value));
}

/**
 * A directory option met for the `seen`-th time (from 0), by its declared
 * repeat: the first moves from `at`; a later one moves from `at`
 * (`cumulative`) or from `base`, where the program started (`last-wins`).
 */
function repeated(
  repeat: Repeat,
  seen: number,
  dirs: { readonly at: LeafDir; readonly base: LeafDir },
  move: (from: LeafDir) => LeafDir,
): LeafDir {
  if (seen === 0) return move(dirs.at);
  switch (repeat) {
    case "cumulative":
      return move(dirs.at);
    case "last-wins":
      return dirs.at.kind === "unknown" ? dirs.at : move(dirs.base);
  }
}

/** An option's value, and the index of the word after it. */
interface Valued {
  readonly value: string;
  readonly next: number;
}

/** The value of the option at `i` when it is one of `names`: separate, or `--long=v`. */
function valueOf(
  argv: readonly string[],
  i: number,
  names: readonly string[],
): Valued | "missing" | null {
  const arg = argv[i] ?? "";
  if (names.includes(arg)) {
    const v = argv[i + 1];
    return v === undefined ? "missing" : { value: v, next: i + 2 };
  }
  const eq = arg.indexOf("=");
  return eq > 2 && arg.startsWith("--") && names.includes(arg.slice(0, eq))
    ? { value: arg.slice(eq + 1), next: i + 1 }
    : null;
}

/** What `env` read off its argv: the program after it, and where it runs. */
type Unwrapped =
  | {
      readonly kind: "ok";
      readonly at: LeafDir;
      readonly rest: readonly string[];
      /** Did it set a variable? Any one may steer git (`GIT_DIR`, `HOME`, `PATH`). */
      readonly assigns: boolean;
    }
  | { readonly kind: "unread" };

const UNREAD: Unwrapped = { kind: "unread" };

interface EnvState {
  readonly i: number;
  readonly at: LeafDir;
  /** Where env started, and how many `-C` options it has read. */
  readonly base: LeafDir;
  readonly seen: number;
}

/** One option of env, by its row: where the scan goes next, or `null`. */
function envOption(argv: readonly string[], s: EnvState): EnvState | null {
  if (ENV.flags.includes(argv[s.i] ?? "")) return { ...s, i: s.i + 1 };
  const chdir = valueOf(argv, s.i, ENV.chdir);
  if (chdir === "missing") return null;
  if (chdir !== null) {
    const at = repeated(ENV.repeat, s.seen, s, (from) =>
      moveTo(from, chdir.value),
    );
    return { ...s, i: chdir.next, at, seen: s.seen + 1 };
  }
  const val = valueOf(argv, s.i, ENV.valued);
  return val === null || val === "missing" ? null : { ...s, i: val.next };
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** env's operands from `i`: an optional lone `-`, the assignments, then the program. */
function envOperands(
  argv: readonly string[],
  i: number,
  at: LeafDir,
): Unwrapped {
  const from = argv[i] === "-" ? i + 1 : i;
  const program = argv.findIndex((a, k) => k >= from && !ASSIGN.test(a));
  const end = program === -1 ? argv.length : program;
  return { kind: "ok", at, rest: argv.slice(end), assigns: end > from };
}

/** env's options from `s`, up to its first operand. */
function envScan(argv: readonly string[], s: EnvState): Unwrapped {
  const arg = argv[s.i];
  if (arg === "--") return envOperands(argv, s.i + 1, s.at);
  if (arg === undefined || !arg.startsWith("-") || arg === "-")
    return envOperands(argv, s.i, s.at);
  const next = envOption(argv, s);
  return next === null ? UNREAD : envScan(argv, next);
}

/** Strip every `env` off `argv` through its row; `UNREAD` on a word outside it. */
function unwrap(
  argv: readonly string[],
  at: LeafDir,
  assigns: boolean,
): Unwrapped {
  if (basename(argv[0] ?? "") !== "env" || argv.length < 2)
    return { kind: "ok", at, rest: argv, assigns };
  const r = envScan(argv, { i: 1, at, base: at, seen: 0 });
  if (r.kind === "unread") return r;
  return r.rest.length === 0
    ? { kind: "ok", at, rest: argv, assigns: assigns || r.assigns }
    : unwrap(r.rest, r.at, assigns || r.assigns);
}

interface GitState {
  readonly i: number;
  readonly at: LeafDir;
  readonly base: LeafDir;
  readonly seen: number;
}

/**
 * git's argv from `s.i`: each global option by its row of
 * {@link GIT_GLOBALS}, then the subcommand, which must be one of
 * {@link GIT_SUBCOMMANDS}. Any other word, and any option whose row says
 * `unknown`, makes the leaf unknown.
 */
function readGit(argv: readonly string[], s: GitState): LeafDir {
  const arg = argv[s.i];
  if (arg === undefined) return s.at;
  if (!arg.startsWith("-"))
    return GIT_SUBCOMMANDS.includes(arg) ? s.at : UNREAD_PROGRAM;
  const row = GIT_GLOBALS.find((g) => g.names.includes(arg));
  if (row === undefined || row.effect === "unknown") return UNREAD_OPTION;
  if (row.effect === "none") return readGit(argv, { ...s, i: s.i + 1 });
  const value = argv[s.i + 1];
  if (value === undefined) return UNREAD_OPTION;
  const at = repeated(GIT_CHDIR_REPEAT, s.seen, s, (from) =>
    moveTo(from, value),
  );
  return readGit(argv, { ...s, i: s.i + 2, at, seen: s.seen + 1 });
}

type CallRead =
  | {
      readonly kind: "leaf";
      readonly argv: readonly string[];
      readonly at: LeafDir;
    }
  | Out;

/** A plain call's program and directory: `env`, then git's argv; any other program is unknown. */
function readProgram(words: readonly string[], at: LeafDir): CallRead {
  const u = unwrap(words, at, false);
  if (u.kind === "unread") return { kind: "leaf", argv: [], at: UNREAD_OPTION };
  const head = basename(u.rest[0] ?? "");
  if (OUTSIDE_PROGRAMS.has(head)) return OUT;
  if (head !== "git") return { kind: "leaf", argv: u.rest, at: UNREAD_PROGRAM };
  if (u.assigns) return { kind: "leaf", argv: u.rest, at: UNREAD_OPTION };
  const from = { at: u.at, base: u.at, seen: 0 };
  return { kind: "leaf", argv: u.rest, at: readGit(u.rest, { ...from, i: 1 }) };
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

/** The source text of a node, by byte offset (mvdan counts UTF-8 bytes). */
function sourceOf(raw: string, node: Node): string {
  const from = node.Pos?.().Offset() ?? 0;
  const bytes = Buffer.from(raw, "utf8");
  const to = node.End?.().Offset() ?? bytes.length;
  return bytes.subarray(from, to).toString("utf8");
}

/** Every `cd`, `pushd` and `popd` word in the raw text, quoted or not. */
const CD_WORD = /(?<![A-Za-z0-9_-])(?:cd|pushd|popd)(?![A-Za-z0-9_-])/g;

interface Walk {
  readonly leaves: readonly DirLeaf[];
  readonly at: LeafDir;
  readonly broken: boolean;
  readonly cds: number;
}

/** A call with an unplain word: unknown, and a possible `cd` when its program is unread. */
function unplainCall(w: Walk, text: string, head: string | null): Walk {
  const leaf: DirLeaf = { text, argv: [], at: unknown("unplain-word") };
  const mayCd = head === null || head === "command";
  return {
    ...w,
    leaves: [...w.leaves, leaf],
    at: mayCd ? unknown("unplain-word") : w.at,
  };
}

/** A `cd` call: it moves the chain unless the chain is already broken. */
function cdCall(w: Walk, call: Node, piped: boolean): Walk | Out {
  if (piped) return OUT;
  const at = w.broken ? w.at : cdTo((call.Args ?? []).slice(1), w.at);
  return { ...w, cds: w.cds + 1, at };
}

/** A call the grammar may read at all: no assignment, no code in a word. */
function readable(call: Node): boolean {
  const args = call.Args ?? [];
  return (
    (call.Assigns ?? []).length === 0 && args.length > 0 && !args.some(runsCode)
  );
}

/** One call of a link: a `cd` moves the chain, anything else is a leaf. */
function readCall(
  w: Walk,
  call: Node,
  raw: string,
  piped: boolean,
): Walk | Out {
  if (!readable(call)) return OUT;
  const words = (call.Args ?? []).map(plainWord);
  const head = words[0] ?? null;
  if (head === "cd") return cdCall(w, call, piped);
  if (head !== null && OUTSIDE_PROGRAMS.has(basename(head))) return OUT;
  const text = sourceOf(raw, call);
  const plain = words.flatMap((x) => (x === null ? [] : [x]));
  if (plain.length < words.length) return unplainCall(w, text, head);
  const r = readProgram(plain, w.broken ? unknown("after-break") : w.at);
  if (r === OUT) return OUT;
  return { ...w, leaves: [...w.leaves, { text, argv: r.argv, at: r.at }] };
}

/** Every link, in order: a `;` or `||` breaks the chain for good. */
function walkLinks(all: readonly Link[], raw: string): Walk | Out {
  const begin: Walk | Out = {
    leaves: [],
    at: known("."),
    broken: false,
    cds: 0,
  };
  return all.reduce<Walk | Out>((w, link) => {
    if (w === OUT) return OUT;
    const broken = w.broken || link.sep === ";" || link.sep === "||";
    const piped = link.calls.length > 1;
    return link.calls.reduce<Walk | Out>(
      (acc, call) => (acc === OUT ? OUT : readCall(acc, call, raw, piped)),
      { ...w, broken },
    );
  }, begin);
}

/**
 * What the closed grammar makes of a command line: each program call and where
 * it runs, or why the whole line is unknown. See the module header.
 */
export function lineDirs(command: string): LineDirs {
  const file = shellSyntax.parse(command);
  const all = file === null ? OUT : lineLinks(file);
  const w = all === OUT ? OUT : walkLinks(all, command);
  if (w === OUT) return { kind: "unknown", reason: "outside-grammar" };
  const words = command.match(CD_WORD)?.length ?? 0;
  return words > w.cds
    ? { kind: "unknown", reason: "uncounted-cd" }
    : { kind: "leaves", leaves: w.leaves };
}
