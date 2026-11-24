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
 *  3. A program with plain argv runs in the chain's directory, moved by its
 *     own row of {@link DIR_TABLE} or by a wrapper read through its option
 *     table. A `..` in a table value is unknown (the program resolves it
 *     physically, the model only lexically).
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
  DIR_TABLE,
  WRAPPERS,
  GIT_GLOBAL,
  type DirRow,
  type WrapperSpec,
} from "./bash-dirs-table.js";

/** Why a leaf's directory is not known. */
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
  /** An option outside its table, a `..` in a table value, a repository override. */
  | "unread-option";

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

/** Where the chain is after `cd <args>`, from `at`. */
function cdTo(args: readonly Node[], at: LeafDir): LeafDir {
  const word = args.length === 1 && args[0] ? plainWord(args[0]) : null;
  if (word === null) return unknown("unread-cd");
  if (word.startsWith("/")) return known(joinDir("/", word));
  if (!word.startsWith("./") && !word.startsWith("../"))
    return unknown("unread-cd");
  return at.kind === "dir" ? known(joinDir(at.dir, word)) : at;
}

/** A value read off a table option, applied to the directory so far. */
function moveTo(at: LeafDir, value: string): LeafDir {
  if (at.kind === "unknown") return at;
  return hasDotDot(value) ? UNREAD_OPTION : known(joinDir(at.dir, value));
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

/** What a wrapper read off its argv: the program after it, and where it runs. */
type Unwrapped =
  | {
      readonly kind: "ok";
      readonly at: LeafDir;
      readonly rest: readonly string[];
      readonly env: readonly string[];
    }
  | { readonly kind: "unread" };

const UNREAD: Unwrapped = { kind: "unread" };

interface WrapState {
  readonly i: number;
  readonly at: LeafDir;
  readonly operands: number;
  readonly env: readonly string[];
}

/** One option of a wrapper, by its row: where the scan goes next, or `null`. */
function wrapperOption(
  spec: WrapperSpec,
  argv: readonly string[],
  s: WrapState,
): WrapState | null {
  if (spec.flags.includes(argv[s.i] ?? "")) return { ...s, i: s.i + 1 };
  const chdir = valueOf(argv, s.i, spec.chdir);
  if (chdir === "missing") return null;
  if (chdir !== null)
    return { ...s, i: chdir.next, at: moveTo(s.at, chdir.value) };
  const val = valueOf(argv, s.i, spec.valued);
  return val === null || val === "missing" ? null : { ...s, i: val.next };
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Scan a wrapper's words from `s` to the program it runs. */
function wrapScan(
  spec: WrapperSpec,
  argv: readonly string[],
  s: WrapState,
): Unwrapped {
  const arg = argv[s.i];
  const done = (from: number): Unwrapped => ({
    kind: "ok",
    at: s.at,
    rest: argv.slice(from),
    env: s.env,
  });
  if (arg === undefined) return done(s.i);
  if (arg === "--") return done(s.i + 1);
  if (arg.startsWith("-") && arg !== "-") {
    const next = wrapperOption(spec, argv, s);
    return next === null ? UNREAD : wrapScan(spec, argv, next);
  }
  if (spec.assigns === true && ASSIGN.test(arg))
    return wrapScan(spec, argv, {
      ...s,
      i: s.i + 1,
      env: [...s.env, arg.slice(0, arg.indexOf("="))],
    });
  return s.operands > 0
    ? wrapScan(spec, argv, { ...s, i: s.i + 1, operands: s.operands - 1 })
    : done(s.i);
}

/** git's global options, read from `i` up to its subcommand by {@link GIT_GLOBAL}. */
function readGit(argv: readonly string[], i: number, at: LeafDir): LeafDir {
  const arg = argv[i] ?? "";
  if (!arg.startsWith("-")) return at;
  if (GIT_GLOBAL.refuse.some((r) => arg === r || arg.startsWith(`${r}=`)))
    return UNREAD_OPTION;
  if (GIT_GLOBAL.flags.includes(arg)) return readGit(argv, i + 1, at);
  const val = valueOf(argv, i, [...GIT_GLOBAL.chdir, ...GIT_GLOBAL.valued]);
  if (val === null || val === "missing") return UNREAD_OPTION;
  if (/^core\.worktree(?:=|$)/i.test(val.value)) return UNREAD_OPTION;
  return readGit(argv, val.next, arg === "-C" ? moveTo(at, val.value) : at);
}

/** Does `arg` spell `flag` a way the row does not read (cluster, attached, abbreviated)? */
function otherSpelling(arg: string, flag: string): boolean {
  if (arg === flag || arg.startsWith(`${flag}=`)) return false;
  if (/^-[A-Za-z]$/.test(flag))
    return (
      /^-[A-Za-z0-9]/.test(arg) &&
      !arg.startsWith("--") &&
      arg.slice(1).includes(flag.slice(1))
    );
  const name = arg.split("=")[0] ?? arg;
  return (
    arg.startsWith("--") &&
    name.length >= 3 &&
    name !== flag &&
    flag.startsWith(name)
  );
}

/** An occurrence of the row's option at `i`: its value and the next index. */
function rowOption(
  row: DirRow,
  args: readonly string[],
  i: number,
): Valued | "missing" | null {
  const sep = valueOf(args, i, row.separate);
  if (sep !== null) return sep;
  const arg = args[i] ?? "";
  const eq = row.equals.find((f) => arg.startsWith(`${f}=`));
  return eq === undefined
    ? null
    : { value: arg.slice(eq.length + 1), next: i + 1 };
}

/** Is `arg` an option the row lists as allowed before its option? */
function listedBefore(row: DirRow, arg: string): "value" | "ok" | "unread" {
  if ((row.valued ?? []).includes(arg)) return "value";
  const listed =
    (row.flags ?? []).includes(arg) ||
    (row.valued ?? []).some((v) => arg.startsWith(`${v}=`));
  return listed ? "ok" : "unread";
}

/** What a word other than the row's option does to the scan. */
function otherWord(
  row: DirRow,
  arg: string,
  operand: boolean,
): "operand" | "value" | "ok" | "unread" {
  if ([...row.separate, ...row.equals].some((f) => otherSpelling(arg, f)))
    return "unread";
  if (arg === "--") return "operand";
  if (operand || !row.beforeOperand) return "ok";
  return arg.startsWith("-") ? listedBefore(row, arg) : "operand";
}

interface RowState {
  readonly i: number;
  readonly at: LeafDir;
  readonly seen: number;
  readonly operand: boolean;
}

/** The directory a row's option names, applied to where the leaf is so far. */
function applyRow(row: DirRow, at: LeafDir, value: string): LeafDir {
  if (row.container !== true) return moveTo(at, value);
  return value.startsWith("/") && !hasDotDot(value)
    ? known(joinDir("/", value))
    : UNREAD_OPTION;
}

/** The row's option met at `s.i`: read it, or refuse a second or late one. */
function readRowOption(
  row: DirRow,
  args: readonly string[],
  s: RowState,
  opt: Valued | "missing",
): LeafDir {
  const again = s.seen > 0 && !row.cumulative;
  if (opt === "missing" || s.operand || again) return UNREAD_OPTION;
  const at = applyRow(row, s.at, opt.value);
  return readRow(row, args, { ...s, i: opt.next, at, seen: s.seen + 1 });
}

/** The leaf's directory under one row of {@link DIR_TABLE}, scanning from `s`. */
function readRow(row: DirRow, args: readonly string[], s: RowState): LeafDir {
  if (s.i >= args.length)
    return row.container === true && s.seen === 0 ? UNREAD_OPTION : s.at;
  const opt = rowOption(row, args, s.i);
  if (opt !== null) return readRowOption(row, args, s, opt);
  const w = otherWord(row, args[s.i] ?? "", s.operand);
  if (w === "unread") return UNREAD_OPTION;
  const step = w === "value" ? 2 : 1;
  return readRow(row, args, {
    ...s,
    i: s.i + step,
    operand: s.operand || w === "operand",
  });
}

/** The row for a program call and the words after its program (and subcommand). */
function rowFor(
  argv: readonly string[],
): { readonly row: DirRow; readonly args: readonly string[] } | null {
  const head = basename(argv[0] ?? "");
  const row = DIR_TABLE.find(
    (r) =>
      r.program === head &&
      (r.sub === undefined || r.sub.includes(argv[1] ?? "")),
  );
  if (row === undefined) return null;
  return { row, args: argv.slice(row.sub === undefined ? 1 : 2) };
}

/** Wrappers a reader elsewhere strips that the directory table does not read. */
const UNREAD_WRAPPERS = new Set(["nohup"]);

/** Strip every wrapper off `argv` through its row; `UNREAD` on an option outside it. */
function unwrap(
  argv: readonly string[],
  at: LeafDir,
  env: readonly string[],
): Unwrapped {
  const spec = WRAPPERS[basename(argv[0] ?? "")];
  if (spec === undefined || argv.length < 2)
    return { kind: "ok", at, rest: argv, env };
  const r = wrapScan(spec, argv, {
    i: 1,
    at,
    operands: spec.operands ?? 0,
    env,
  });
  if (r.kind === "unread") return r;
  return r.rest.length === 0
    ? { kind: "ok", at, rest: argv, env }
    : unwrap(r.rest, r.at, r.env);
}

type CallRead =
  | {
      readonly kind: "leaf";
      readonly argv: readonly string[];
      readonly at: LeafDir;
    }
  | Out;

/** A plain call's program and directory: its wrappers, then its own row. */
function readProgram(words: readonly string[], at: LeafDir): CallRead {
  const u = unwrap(words, at, []);
  if (u.kind === "unread") return { kind: "leaf", argv: [], at: UNREAD_OPTION };
  const head = basename(u.rest[0] ?? "");
  if (OUTSIDE_PROGRAMS.has(head)) return OUT;
  if (u.env.some((n) => n.startsWith("GIT_")) || UNREAD_WRAPPERS.has(head))
    return { kind: "leaf", argv: [], at: UNREAD_OPTION };
  if (head === "git")
    return { kind: "leaf", argv: u.rest, at: readGit(u.rest, 1, u.at) };
  const r = rowFor(u.rest);
  const dir = r
    ? readRow(r.row, r.args, { i: 0, at: u.at, seen: 0, operand: false })
    : u.at;
  return { kind: "leaf", argv: u.rest, at: dir };
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
