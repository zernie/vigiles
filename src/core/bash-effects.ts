/**
 * Deterministic, no-LLM Bash effect classifier.
 *
 * Classifies a Bash command string into a three-way verdict:
 *
 *   "read-only"      — proven: every leaf command head is in the read-only
 *                      catalog, no output redirection, no dynamic/residue node.
 *   "side-effecting" — at least one leaf is provably effecting (unknown head
 *                      outside the catalog, effecting flag, output redirection).
 *   "undecidable"    — a residue construct (eval, $VAR head, $(…) head, sh -c,
 *                      xargs, pipe-to-shell, ProcSubst, background &, Subshell)
 *                      makes the static verdict unsound; fail-closed.
 *
 * FAIL-CLOSED: "read-only" is returned ONLY when it can be proven. Anything
 * not proven read-only → "side-effecting" or "undecidable" (never "read-only").
 * The zero-false-read-only property is the invariant this module maintains.
 *
 * Parse errors → "undecidable" (can't analyze ⇒ not read-only).
 *
 * This is a STANDALONE pure module. It does NOT import any adapter or dialect.
 * Wiring into effectSurface / scan is a separate follow-up step.
 *
 * See `research/bash-effect-classification.md` for the full design rationale.
 */

import { posix } from "node:path";

// mvdan-sh is a CJS package (GopherJS build) with no bundled TypeScript types.
// The project compiles to CommonJS (Node16, no "type":"module"), so plain
// require() works and is the idiomatic pattern here (see linters.ts).
interface MvdanSyntax {
  syntax: {
    NewParser: () => { Parse: (src: string, name: string) => MvdanNode };
    Walk: (node: MvdanNode, fn: (node: MvdanNode) => boolean) => void;
    NodeType: (node: MvdanNode) => string;
  };
}

/**
 * The parser is loaded ON FIRST PARSE, not at module load — `sh()` memoizes it.
 *
 * WHY, measured 2026-09-08 (Node 22.22.2, `tools/measure-hook-startup.mjs`):
 * `require("mvdan-sh")` is a GopherJS build and costs ~100 ms on top of a 42 ms
 * bare Node start. This module sits in the import graph of `core/hook-program.ts`
 * (and `core/hook-providers.ts`), which the compiled-hook RUNTIME loads on EVERY
 * matching tool call. Only a BASH predicate ever parses: `decideProgram` returns
 * `allow()` before building a `parseShellCommand` when the tool is not Bash, so a file
 * gate, an inject, a react or a stop gate never reaches this file's functions at
 * all — and used to pay ~100 ms per tool call for a parser it never called.
 *
 * The deferral is CLEAN because the boundary is real, not a trick: every entry
 * point here starts by parsing, so there is no path that touches `sh()` without
 * needing the parser. A bash gate still pays, and that cost is the work it asked
 * for. Do NOT hoist this back to a top-level `require` — `src/hook-runtime-graph.test.ts`
 * asserts `mvdan-sh` is absent from a non-Bash decision's module graph.
 */
let _sh: MvdanSyntax | undefined;
const sh = (): MvdanSyntax =>
  (_sh ??= require("mvdan-sh") as unknown as MvdanSyntax);

// Minimal structural types for the mvdan-sh AST nodes we inspect.
// These are NOT exhaustive — only the fields we actually read are declared.
interface MvdanNode {
  // Stmt fields
  Background?: boolean;
  Redirs?: MvdanRedirect[];
  Cmd?: MvdanNode;
  Stmts?: MvdanNode[];
  // CallExpr fields
  Args?: MvdanWord[];
  /** Leading `NAME=value` env-assignments prefixing a simple command. */
  Assigns?: MvdanAssign[];
  // BinaryCmd fields
  Op?: number;
  X?: MvdanNode;
  Y?: MvdanNode;
  // Word fields
  Parts?: MvdanNode[];
  // Lit / Param fields
  Value?: string;
  // ParamExp fields
  Param?: MvdanNode;
  /** Any of these set means an operator beyond a bare `$X` / `${X}`. */
  Excl?: boolean;
  Length?: boolean;
  Width?: boolean;
  /** The subscript of `${a[…]}`: a word, `@` for every element. */
  Index?: MvdanNode;
  Slice?: unknown;
  Repl?: unknown;
  Names?: unknown;
  Exp?: unknown;
  // Stmt fields
  Negated?: boolean;
  // Compound commands, read by the directory model (`dirModel`).
  /** IfClause / WhileClause condition. */
  Cond?: MvdanNode[];
  /** IfClause body. */
  Then?: MvdanNode[];
  /** IfClause `elif`/`else`: another IfClause, with an empty `Cond` for `else`. */
  Else?: MvdanNode | null;
  /** WhileClause / ForClause body. */
  Do?: MvdanNode[];
  /** CaseClause items, each with `Stmts` and a terminator `Op`. */
  Items?: MvdanNode[];
  /** DeclClause (`export`, `declare`, …): its variant word and its assignments. */
  Variant?: MvdanNode;
  /** TimeClause: the timed statement. FuncDecl: the function's name. */
  Stmt?: MvdanNode;
  Name?: MvdanNode;
  /** FuncDecl body. */
  Body?: MvdanNode;
  /** ForClause `in …` words. CaseClause: the word matched. */
  Loop?: MvdanNode;
  Word?: MvdanWord;
  /** Byte offsets of the node in the parsed source: how a statement is keyed. */
  Pos?: () => { Offset: () => number };
  End?: () => { Offset: () => number };
  /** `$'…'` on a SglQuoted (ANSI-C), `$"…"` on a DblQuoted. */
  Dollar?: boolean;
}

interface MvdanRedirect extends MvdanNode {
  Op: number;
  /** The explicit source fd (`2> f` → a Lit "2"); absent when omitted. */
  N?: MvdanNode;
  /** The redirection target word (`> f` → the word `f`). */
  Word?: MvdanWord;
}

interface MvdanWord extends MvdanNode {
  Parts: MvdanNode[];
}

/** A leading `NAME=value` assignment on a CallExpr (mvdan `*syntax.Assign`). */
interface MvdanAssign {
  /** The variable name (a `*Lit`); its `.Value` is the name string. */
  Name?: MvdanNode;
  /** The RHS word; absent for a naked `NAME=` (empty value). */
  Value?: MvdanWord;
}

// ---------------------------------------------------------------------------
// Redirect operator codes from mvdan-sh (empirically confirmed via probe).
// Op values:
//   54 = >   (RdrOut)      55 = >>  (AppOut)    60 = >|  (RdrClob)
//   64 = &>  (RdrAll)      65 = &>> (AppAll)
//   56 = <   (RdrIn — NOT a write)   59 = >&  (DplOut — NOT a file write)
//   61 = <<  (Hdoc — input)          63 = <<< (HereStr — input)
// ---------------------------------------------------------------------------

const WRITE_REDIR_OPS = new Set([54, 55, 60, 64, 65]);

/**
 * Op code → the operator as WRITTEN, so a normalized leaf can REPORT the
 * redirection it carries instead of a bare number. Pinned by
 * `bash-effects-normalized.test.ts`, which re-derives every entry by parsing the
 * operator itself — an mvdan-sh upgrade that renumbers a token fails there
 * LOUDLY instead of silently misclassifying a write as a read.
 */
const REDIR_OP_NAMES: ReadonlyMap<number, string> = new Map([
  [54, ">"],
  [55, ">>"],
  [56, "<"],
  [57, "<>"],
  [58, "<&"],
  [59, ">&"],
  [60, ">|"],
  [61, "<<"],
  [62, "<<-"],
  [63, "<<<"],
  [64, "&>"],
  [65, "&>>"],
]);

// ---------------------------------------------------------------------------
// Shell-escape heads: commands that dispatch arbitrary code as an argument.
// We treat ALL of these as undecidable regardless of their flags.
// ---------------------------------------------------------------------------

const SHELL_ESCAPE_HEADS = new Set([
  "eval",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "source",
  ".",
  "xargs",
  "env",
  "command",
  "exec",
  "nohup",
  "sudo",
  "timeout",
  "time",
]);

// ---------------------------------------------------------------------------
// Read-only command catalog (~35 heads, CONSERVATIVE).
// Only commands that are CLEARLY read-only without effecting flags are listed.
// Unknown heads → "side-effecting" (fail-closed).
// ---------------------------------------------------------------------------

const READ_ONLY_HEADS = new Set([
  "cat",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "echo",
  "printf",
  "pwd",
  "whoami",
  "id",
  "hostname",
  "date",
  "dirname",
  "basename",
  "realpath",
  "readlink",
  "tree",
  "du",
  "df",
  "cut",
  "tr",
  "uniq",
  "nl",
  "od",
  "cksum",
  "md5sum",
  "sha256sum",
  "sha1sum",
  "which",
  "type",
  "test",
  "[",
  "true",
  "false",
  "sleep",
  "diff",
  "cmp",
  "strings",
  "xxd",
  "readelf",
  "nm",
  "ps",
  "pgrep",
]);

// ---------------------------------------------------------------------------
// Flag-sensitive command helpers.
// Each returns the verdict for a command with those static args, or null to
// fall through to the catalog lookup (only used by classifyCall).
// ---------------------------------------------------------------------------

/** Flags on `find` that make it effecting. */
const FIND_EFFECTING_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** Read-only `git` subcommands (first positional arg after `git`). */
const GIT_READ_ONLY_SUBCMDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "rev-parse",
  "describe",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "shortlog",
  "remote",
  "config",
  "stash",
  "grep",
  "format-patch",
]);

/** Classify `git <args>` — read-only only for safe subcommands. */
function classifyGit(staticArgs: readonly string[]): BashEffect {
  const subcmd = staticArgs[0];
  if (!subcmd || subcmd.startsWith("-")) return "side-effecting";
  if (!GIT_READ_ONLY_SUBCMDS.has(subcmd)) return "side-effecting";
  if (subcmd === "stash") {
    const action = staticArgs[1];
    if (!action || (action !== "list" && action !== "show")) {
      return "side-effecting";
    }
  }
  return "read-only";
}

/** Classify `find <args>` — side-effecting if any effecting flag present. */
function classifyFind(staticArgs: readonly string[]): BashEffect {
  for (const arg of staticArgs) {
    if (FIND_EFFECTING_FLAGS.has(arg)) return "side-effecting";
  }
  return "read-only";
}

/** Classify `sort <args>` — side-effecting with `-o`. */
function classifySort(staticArgs: readonly string[]): BashEffect {
  for (const arg of staticArgs) {
    if (arg === "-o" || (arg.startsWith("-o") && arg.length > 2)) {
      return "side-effecting";
    }
  }
  return "read-only";
}

/** Classify `sed <args>` — side-effecting with `-i` / `--in-place`. */
function classifySed(staticArgs: readonly string[]): BashEffect {
  for (const arg of staticArgs) {
    if (arg === "-i" || arg.startsWith("-i") || arg === "--in-place") {
      return "side-effecting";
    }
  }
  return "read-only";
}

// ---------------------------------------------------------------------------
// Helpers: literal extraction from a Word node.
// ---------------------------------------------------------------------------

/** Returns the static string value of a Word iff it is a single Lit part. */
function getLiteral(word: MvdanWord | undefined): string | null {
  if (!word?.Parts || word.Parts.length !== 1) return null;
  const part = word.Parts[0];
  if (!part) return null;
  if (sh().syntax.NodeType(part) === "Lit") return part.Value ?? null;
  return null;
}

/** Like getLiteral but also unwraps a single-Lit DblQuoted word. */
function getLiteralDeep(word: MvdanWord | undefined): string | null {
  if (!word?.Parts || word.Parts.length !== 1) return null;
  const p = word.Parts[0];
  if (!p) return null;
  const t = sh().syntax.NodeType(p);
  if (t === "Lit") return p.Value ?? null;
  if (t === "DblQuoted") {
    const inner = p as MvdanWord;
    if (!inner.Parts || inner.Parts.length !== 1) return null;
    const ip = inner.Parts[0];
    if (!ip || sh().syntax.NodeType(ip) !== "Lit") return null;
    return ip.Value ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal verdict type and combiner.
// ---------------------------------------------------------------------------

/** The three-way verdict. */
export type BashEffect = "read-only" | "side-effecting" | "undecidable";

/**
 * Combine two verdicts: undecidable > side-effecting > read-only.
 * A single undecidable dominates; otherwise a single side-effecting dominates.
 */
function combine(a: BashEffect, b: BashEffect): BashEffect {
  if (a === "undecidable" || b === "undecidable") return "undecidable";
  if (a === "side-effecting" || b === "side-effecting") return "side-effecting";
  return "read-only";
}

// ---------------------------------------------------------------------------
// Per-leaf classifier.
// ---------------------------------------------------------------------------

/** Collect static (literal) arg strings from a CallExpr's args, skipping i=0 (head). */
function staticCallArgs(args: MvdanWord[]): string[] {
  const result: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const lit = getLiteralDeep(args[i]);
    if (lit !== null) result.push(lit);
  }
  return result;
}

/** Resolve the head of a CallExpr to a static string, or null if dynamic. */
function resolveHead(args: MvdanWord[]): string | null {
  const headWord = args[0];
  if (!headWord) return null;
  return getLiteral(headWord);
}

/** Classify a flag-sensitive command once the head and static args are known. */
function classifyFlagSensitive(
  head: string,
  staticArgs: string[],
): BashEffect | null {
  switch (head) {
    case "git":
      return classifyGit(staticArgs);
    case "find":
      return classifyFind(staticArgs);
    case "sort":
      return classifySort(staticArgs);
    case "sed":
      return classifySed(staticArgs);
    case "tee":
      return "side-effecting";
    case "awk":
    case "gawk":
      return "side-effecting"; // awk programs can write internally
    default:
      return null; // fall through to catalog
  }
}

/** Classify a single CallExpr node (one simple command). */
function classifyCall(node: MvdanNode): BashEffect {
  const args = node.Args;
  if (!args || args.length === 0) return "side-effecting";

  const head = resolveHead(args);
  if (head === null) return "undecidable"; // dynamic head

  if (SHELL_ESCAPE_HEADS.has(head)) return "undecidable";

  const sArgs = staticCallArgs(args);
  const sensitive = classifyFlagSensitive(head, sArgs);
  if (sensitive !== null) return sensitive;

  return READ_ONLY_HEADS.has(head) ? "read-only" : "side-effecting";
}

// ---------------------------------------------------------------------------
// AST walker — classifies statements and commands.
// ---------------------------------------------------------------------------

/** Classify a Stmt node (handles redirections and background). */
function classifyStmt(stmt: MvdanNode): BashEffect {
  if (stmt.Background === true) return "undecidable";
  if (stmt.Redirs) {
    for (const r of stmt.Redirs) {
      if (WRITE_REDIR_OPS.has(r.Op)) return "side-effecting";
    }
  }
  const cmd = stmt.Cmd;
  if (!cmd) return "side-effecting";
  return classifyCmd(cmd);
}

/** Classify a Cmd node (the typed command inside a Stmt). */
function classifyCmd(cmd: MvdanNode): BashEffect {
  const t = sh().syntax.NodeType(cmd);

  switch (t) {
    case "CallExpr":
      return classifyCall(cmd);

    case "BinaryCmd":
      return classifyBinaryCmd(cmd);

    case "Subshell":
    case "Block":
      return classifyStmtList(cmd.Stmts);

    default:
      // IfClause, WhileClause, ForClause, CaseClause, FuncDecl, etc.
      return "side-effecting";
  }
}

/** Classify a BinaryCmd (pipe / && / ||). */
function classifyBinaryCmd(cmd: MvdanNode): BashEffect {
  const xVerdict = cmd.X ? classifyStmt(cmd.X) : "side-effecting";
  const yVerdict = cmd.Y ? classifyStmt(cmd.Y) : "side-effecting";
  // For a pipe where the right side is a shell-escape, that already returns
  // "undecidable" from classifyCall/classifyStmt — combine handles it.
  return combine(xVerdict, yVerdict);
}

/** Classify a list of Stmt nodes (Subshell/Block body or top-level File). */
function classifyStmtList(stmts: MvdanNode[] | undefined): BashEffect {
  if (!stmts || stmts.length === 0) return "read-only";
  let result: BashEffect = "read-only";
  for (const s of stmts) {
    result = combine(result, classifyStmt(s));
    if (result === "undecidable") return "undecidable";
  }
  return result;
}

// ---------------------------------------------------------------------------
// ProcSubst residue detector (pre-pass over the full AST).
// ---------------------------------------------------------------------------

/** Returns true if the AST contains a ProcSubst node anywhere. */
function hasProcSubst(root: MvdanNode): boolean {
  let found = false;
  sh().syntax.Walk(root, (node) => {
    if (found) return false;
    if (sh().syntax.NodeType(node) === "ProcSubst") {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a Bash command string by its effect. Sound by construction:
 * returns "read-only" ONLY when every leaf command is a catalogued read-only
 * head with no output redirection and no effecting flag; "undecidable" for the
 * dynamic residue (eval, $(...)-as-command, $VAR head, sh -c, xargs, pipe-into-shell);
 * "side-effecting" otherwise (the fail-closed default). NEVER returns "read-only"
 * for a command it cannot fully prove read-only.
 */
export function classifyBashCommand(command: string): BashEffect {
  let file: MvdanNode;
  try {
    file = sh().syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    // mvdan-sh throws a Go error object (not an Error instance) on parse failure.
    return "undecidable";
  }
  // Pre-pass: detect ProcSubst (process substitution) anywhere in the AST.
  if (hasProcSubst(file)) return "undecidable";
  return classifyStmtList(file.Stmts);
}

/**
 * True iff classifyBashCommand(command) === "read-only" — the safe predicate a
 * caller uses to decide "this Bash is provably an observation."
 */
export function isReadOnlyBash(command: string): boolean {
  return classifyBashCommand(command) === "read-only";
}

/**
 * Extract the static argv of every simple command (CallExpr) in `command`, each
 * as an array of literal words (dynamic / quoted-interpolated words are dropped).
 * AST-backed, so a leaf nested in a pipeline, `&&`/`;`/`|`, a subshell, or a
 * compound command is still found — the structural query a robust matcher needs
 * (a regex over the raw string misses `cd x && git push`). Parse failure → [].
 *
 * This is the matching primitive a typed hook's `command.runs("git push")` is
 * built on: it sees the real `git push` leaf however it's wrapped, which the
 * native `Bash(git:*)` glob (issue #30519) and a hand-written `grep` both miss.
 */
export function leafCommands(command: string): string[][] {
  let file: MvdanNode;
  try {
    file = sh().syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    return [];
  }
  const out: string[][] = [];
  sh().syntax.Walk(file, (node) => {
    if (sh().syntax.NodeType(node) === "CallExpr" && node.Args) {
      const argv = node.Args.map((w) => getLiteral(w)).filter(
        (s): s is string => s !== null,
      );
      if (argv.length > 0) out.push(argv);
    }
    return true;
  });
  return out;
}

// ===========================================================================
// OPERATION-NORMALIZED leaf extraction (additive — does NOT touch getLiteral,
// leafCommands, or the read-only classifier above).
//
// The plain `leafCommands` primitive extracts LITERAL words only (`getLiteral`),
// so a token-level matcher built on it is defeated by semantics-preserving
// obfuscations that a POSIX shell executes identically to the plain form:
//
//   quoted flags        git push '--force'        (SglQuoted / DblQuoted word)
//   absolute-path head  /bin/rm -rf /             (basename ≠ literal head)
//   backslash-escaped   \rm -rf /                 (leading backslash on head)
//   short-flag aliases  git commit -n             (-n ≡ --no-verify)
//   $HOME for ~         cat "$HOME/.ssh/id_rsa"    (ParamExp instead of ~)
//
// `leafCommandsNormalized` canonicalizes each of these to a single operation
// representation so a matcher can compare against the OPERATION, not the surface
// string. This is the ingredient that closes the mutation-evasion gap the
// Lit-only extractor leaves open (see research/ before/after measurement).
// ===========================================================================

/**
 * One redirection attached to a simple command (`cmd > f`, `cmd 2>> log`).
 *
 * The parser used to DROP these: `echo x > out.md` normalized to a leaf whose
 * every field (`head`/`argv`/`args`/`flags`/`assigns`) mentioned only `echo` and
 * `x`, so the file the command actually WROTE appeared nowhere. That made the
 * single most common write shape invisible to any matcher built on the leaf.
 */
export interface LeafRedirect {
  /** The operator as written: `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<<`, `>&`, … */
  readonly op: string;
  /**
   * The redirection target, quote-unwrapped and `$HOME`-canonicalized like every
   * other word. `null` when the target is dynamic (`> "$out"`, `> $(f)`) — present
   * but unresolvable, never silently dropped. For an fd-dup (`2>&1`) this is the
   * fd, not a path; for a heredoc it's the delimiter.
   */
  readonly target: string | null;
  /** The explicit source fd (`2> f` → 2), or `null` when omitted. */
  readonly fd: number | null;
  /**
   * True iff this redirection CREATES OR MODIFIES the file named by `target` —
   * `>`, `>>`, `>|`, `&>`, `&>>`. False for input (`<`, `<<`, `<<<`) and for fd
   * duplication (`2>&1`), whose "target" is an fd, not a path.
   */
  readonly writes: boolean;
}

/** A single simple command, normalized to its operation form. */
export interface NormalizedLeaf {
  /** Head normalized to its basename, backslash-stripped: `/bin/rm`→`rm`, `\rm`→`rm`. */
  readonly head: string;
  /** `[head, ...args]` — every word quote-unwrapped and $HOME/~-canonicalized. */
  readonly argv: readonly string[];
  /** The normalized args (argv without the head). */
  readonly args: readonly string[];
  /**
   * Canonical flag tokens present on this leaf. Short clusters are split
   * (`-rf`→`r`,`f`) and a flag is recorded in BOTH short and long form where
   * this command's manual makes them one flag ({@link FLAG_ALIASES}), so a
   * caller can test `--force`/`-f` on `git push` or `--no-verify`/`-n` on
   * `git commit` uniformly. A command with no row keeps exactly what was typed:
   * `git push -n` is not `--no-verify` (it is `--dry-run`). Long values are
   * split on `=` (`--index-url=x`→`index-url`).
   */
  readonly flags: ReadonlySet<string>;
  /** True iff ANY of `names` is present in {@link flags} (short or long). */
  hasFlag(...names: readonly string[]): boolean;
  /**
   * Command-level env-assignments that apply to THIS leaf, keyed by variable
   * name → static value (empty string for a naked `NAME=`). Populated from both
   * the mvdan leading `CallExpr.Assigns` (`PIP_INDEX_URL=… pip install …`) AND
   * the `NAME=value` words consumed by an `env` wrapper (`env NPM_CONFIG_REGISTRY=… npm i`).
   *
   * These carry supply-chain / behavior-altering configuration (`PIP_INDEX_URL`,
   * `NPM_CONFIG_REGISTRY`, …) that an argv-only extractor never sees because the
   * assignment is not an argv word. A dynamic RHS (command substitution, non-HOME
   * parameter) is recorded with value `null` — present but unresolved. */
  readonly assigns: ReadonlyMap<string, string | null>;
  /** True iff a command-level assignment for ANY of `names` is present (resolved or not). */
  hasAssign(...names: readonly string[]): boolean;
  /**
   * The redirections attached to this leaf, in source order — see
   * {@link LeafRedirect}. Empty for a command with no redirection.
   */
  readonly redirects: readonly LeafRedirect[];
  /**
   * The directory a chdir WRAPPER moved this leaf into before exec'ing it —
   * `env -C dir`, `env --chdir=dir`, `sudo -D dir` — or `null` when there was
   * none. Nested wrappers accumulate (`sudo -D a env -C b cmd` → `a/b`).
   *
   * The parser already READ this token in order to skip past it, then threw the
   * value away — so every relative operand of the wrapped command resolved
   * against the wrong directory for every consumer. Same shape as the
   * redirection targets the leaf used to drop: the parser knew, the leaf did
   * not carry it. `git -C` is deliberately NOT here — `git` is not a wrapper
   * (it does not exec the rest of its argv as a command).
   *
   * ⚠️ ONE LEAF'S OWN WRAPPER, NOT A CWD MODEL. A directory changed by a
   * PRECEDING statement (`cd x && …`, `pushd`, a subshell) is not reported:
   * connectors do not survive leaf extraction, and `cd x; cmd` writes into the
   * OLD directory when the `cd` fails — that is a model with failure semantics,
   * not a field. A dynamic value (`env -C "$DIR" …`) is not resolvable and the
   * whole leaf is already unnormalizable in that case.
   */
  readonly chdir: string | null;
  /**
   * Every directory this leaf may run in, relative to where its command line
   * starts — after a preceding `cd`/`pushd`/`popd` in the line, a subshell,
   * its own wrapper's {@link chdir} and `git -C` — or `unresolved` with the
   * reason when the text does not fix it. See {@link LeafDirs}.
   */
  readonly at: LeafDirs;
}

/**
 * Flag aliases per program and subcommand, long → short, each from that
 * command's manual: git-push(1) `-f, --force` (its `-n` is `--dry-run`),
 * git-commit(1) `-n, --[no-]verify`, git-clean(1) / git-checkout(1) /
 * git-branch(1) `-f, --force`, rm(1) `-f, --force` and `-r, --recursive`,
 * pip install `-i, --index-url`.
 *
 * 🔴 KEYED BY COMMAND, AND A COMMAND WITH NO ROW GETS NO EXPANSION (vigiles#501).
 * This was one table for every program, so `-n` was `--no-verify` everywhere:
 * `runs("git push --no-verify")` matched `git push -n` — a DRY RUN — and a guard
 * that blocks skipping hooks on push blocked every dry run. `kubectl delete -f`
 * read as `--force` (it is `--filename`), `sed -n` as `--no-verify`. A row added
 * here is a sentence of that command's manual, not a guess about what a letter
 * usually means.
 *
 * Also the battery's alias table, through {@link flagAliases}: the spelling
 * generator writes `-f`/`--force` variants only where this says they are one
 * flag, so the gate and the generator cannot disagree about it.
 */
const FLAG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    "git push": { force: "f" },
    "git commit": { "no-verify": "n" },
    "git clean": { force: "f" },
    "git checkout": { force: "f" },
    "git branch": { force: "f" },
    rm: { force: "f", recursive: "r" },
    "pip install": { "index-url": "i" },
  };

/**
 * git's own options that take the NEXT word as their value — git(1), the part
 * before `<command>`. Read so that `git -C . commit -n` finds `commit`, not `.`.
 */
const GIT_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

/**
 * Where a program's subcommand sits in its args: past git's own options for
 * `git`, the first argument for anything else. `-1` when there is none.
 */
function subcommandIndex(head: string, args: readonly string[]): number {
  if (head !== "git") return args.length > 0 ? 0 : -1;
  const from = (i: number): number => {
    const a = args[i];
    if (a === undefined) return -1;
    if (!a.startsWith("-")) return i;
    return from(GIT_VALUE_OPTS.has(a) ? i + 2 : i + 1);
  };
  return from(0);
}

/**
 * The alias table of a command: its program and subcommand's row, else its
 * program's, else none.
 *
 * @internal — read by `bash-equivalents.ts`.
 */
export function flagAliases(
  head: string,
  args: readonly string[],
): Readonly<Record<string, string>> {
  const sub = args[subcommandIndex(head, args)];
  return (
    (sub === undefined ? undefined : FLAG_ALIASES[`${head} ${sub}`]) ??
    FLAG_ALIASES[head] ??
    {}
  );
}

/**
 * Reconstruct a Word's static text, unwrapping single/double quotes and
 * canonicalizing `$HOME`/`${HOME}` to `~`. Returns null if the word contains a
 * truly dynamic segment (command substitution, arithmetic, a non-HOME parameter)
 * — such a word can't be soundly reduced to a literal operation token.
 */
function normalizeParts(
  parts: readonly MvdanNode[] | undefined,
  inDoubleQuotes = false,
  unescape = false,
): string | null {
  if (!parts) return null;
  let out = "";
  for (const p of parts) {
    const t = sh().syntax.NodeType(p);
    if (t === "Lit") {
      out += unescape
        ? unescapeLit(p.Value ?? "", inDoubleQuotes)
        : (p.Value ?? "");
    } else if (t === "SglQuoted") {
      out += p.Value ?? "";
    } else if (t === "DblQuoted") {
      const inner = normalizeParts((p as MvdanWord).Parts, true, unescape);
      if (inner === null) return null;
      out += inner;
    } else if (t === "ParamExp") {
      // Canonicalize the home directory; any other parameter is dynamic.
      if (p.Param?.Value === "HOME") out += "~";
      else return null;
    } else {
      return null; // CmdSubst / ArithmExp / ProcSubst / … → dynamic
    }
  }
  return out;
}

/**
 * Resolve the backslashes a shell removes before it runs a word. mvdan-sh keeps
 * them as written (`g\it` parses as `Lit("g\\it")`), yet `sh -c 'g\it --version'`
 * runs git: outside quotes a backslash makes the next character literal and is
 * itself dropped; inside double quotes it does so only before `$`, `` ` ``, `"`, `\\`
 * and a newline. Without this, `g\it push --force` normalized to head `g\it` — a
 * spelling the shell reads as the dangerous command and a `runs("git push")` guard
 * did not (found 2026-09-02 by a reader, not by the battery, which shares this
 * normalizer and so could not). Deliberately NOT expansion: `$VAR`, `eval`, `$(…)`
 * and friends still return null one level up.
 */
function unescapeLit(raw: string, inDoubleQuotes: boolean): string {
  if (!raw.includes("\\")) return raw;
  const joined = raw.replace(/\\\n/g, ""); // `\<newline>` is a continuation: both go
  return inDoubleQuotes
    ? joined.replace(/\\([$`"\\])/g, "$1")
    : joined.replace(/\\(.)/g, "$1");
}

/** Normalize a command head to its basename, stripping one leading backslash. */
function normalizeHead(raw: string): string {
  const unescaped = raw.startsWith("\\") ? raw.slice(1) : raw;
  const slash = unescaped.lastIndexOf("/");
  return slash >= 0 ? unescaped.slice(slash + 1) : unescaped;
}

/**
 * Build the canonical flag set for a leaf's args: short clusters split, and each
 * flag recorded in its other form only where THIS command's row says the two are
 * one flag ({@link FLAG_ALIASES}).
 */
function buildFlags(head: string, args: readonly string[]): Set<string> {
  const aliases = flagAliases(head, args);
  // git's own options (`-C dir`, `-c k=v`, `--no-pager`) are not its
  // subcommand's flags: `git -C . push -f` is a push with `-f`, not with `-C`.
  const sub = head === "git" ? subcommandIndex(head, args) : -1;
  const own = sub > 0 ? args.slice(sub) : args;
  const toLong = new Map(
    Object.entries(aliases).map(([long, short]) => [short, long]),
  );
  const flags = new Set<string>();
  const add = (name: string): void => {
    if (!name) return;
    flags.add(name);
    const other = name.length === 1 ? toLong.get(name) : aliases[name];
    if (other !== undefined) flags.add(other);
  };
  for (const a of own) {
    if (a.startsWith("--")) {
      add(a.slice(2).split("=")[0] ?? "");
    } else if (a.length > 1 && a[0] === "-") {
      for (const ch of a.slice(1)) {
        if (/[a-zA-Z]/.test(ch)) add(ch);
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Command-wrapper stripping.
//
// A wrapper is a command whose JOB is to run ANOTHER command: `env FOO=bar CMD`,
// `command CMD`, `sudo CMD`, `nice -n5 CMD`, `timeout 5 CMD`, `xargs CMD`,
// `nohup CMD`. Because the normalized leaf keys on the leaf HEAD, a wrapper head
// hides the real operation — `env GIT_SSH= git push --force` and `command rm -rf /`
// look like `env`/`command` leaves, so a head-keyed matcher never sees the
// `git push --force` / `rm -rf /` it must block. We resolve THROUGH the wrapper:
// skip the wrapper's own options (and their values) and any `NAME=value` words it
// consumes, then treat the next word as the real command head (recursing so
// `sudo timeout 5 rm -rf /` unwraps fully). A wrapper with no following command
// (bare `env`, `env -i`) is preserved as-is, so the env-dump predicate still fires.
// ---------------------------------------------------------------------------

/** @internal — read by `bash-equivalents.ts` to generate shell-equivalent variants. */
export const WRAPPER_HEADS = new Set([
  "env",
  "command",
  "nice",
  "timeout",
  "sudo",
  "xargs",
  "nohup",
]);

/**
 * Per-wrapper short/long options that consume a SEPARATE following token as their
 * value (so the value is not mistaken for the wrapped command). Attached forms
 * (`-n5`, `--kill-after=5`) are single tokens and need no entry.
 */
const WRAPPER_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  command: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  sudo: new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-h",
    "--host",
    "-r",
    "--role",
    "-t",
    "--type",
    "-U",
    "--other-user",
    "-R",
    "--chroot",
    "-D",
    "--chdir",
  ]),
  xargs: new Set([
    "-I",
    "-i",
    "--replace",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-d",
    "--delimiter",
    "-E",
    "-e",
    "--eof",
    "-s",
    "--max-chars",
    "-L",
    "-l",
    "--max-lines",
    "-a",
    "--arg-file",
  ]),
  nohup: new Set(),
};

/**
 * Per-wrapper options whose value is a DIRECTORY the wrapper chdirs into before
 * exec'ing the command. A subset of {@link WRAPPER_VALUE_OPTS}, and keyed by head
 * for a reason: `-C` is `--chdir` for `env` but `--close-from` (a file
 * descriptor) for `sudo`, whose chdir is `-D`. One shared set would read a
 * number as a directory.
 */
const WRAPPER_CHDIR_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-C", "--chdir"]),
  sudo: new Set(["-D", "--chdir"]),
};

/**
 * The directory carried by an option WORD, when that word is one of this
 * wrapper's chdir options — covering both spellings, since `--chdir=dir` is a
 * single token that never reaches the separate-value table.
 */
function chdirValue(
  word: string,
  next: string | undefined,
  chdirOpts: ReadonlySet<string>,
): string | undefined {
  if (chdirOpts.has(word)) return next; // `-C dir`, `--chdir dir`
  const eq = word.indexOf("=");
  return eq > 0 && chdirOpts.has(word.slice(0, eq))
    ? word.slice(eq + 1) // `--chdir=dir`
    : undefined;
}

/** Layer a wrapper's chdir onto the one an outer wrapper already applied. */
function nestChdir(
  outer: string | null,
  inner: string | undefined,
): string | null {
  if (inner === undefined || inner === "") return outer;
  if (outer === null || inner.startsWith("/") || /^[A-Za-z]:\//.test(inner))
    return inner;
  return `${outer.replace(/\/+$/, "")}/${inner}`;
}

/** Count of leading NON-option positionals a wrapper consumes before the command (timeout DURATION). */
const WRAPPER_SKIP_POSITIONALS: Readonly<Record<string, number>> = {
  timeout: 1,
};

/** True iff a normalized word is a `NAME=value` env-assignment (used by `env`). */
/** The slot of a word {@link normalizeParts} cannot reduce, until wrappers are resolved. */
const DYNAMIC_WORD = "\u0000";
const isKnown = (w: string): boolean => !w.includes(DYNAMIC_WORD);

/**
 * The placeholder for a word whose bytes depend on the run. An assignment with
 * a dynamic value (`TOKEN="$TOKEN"`) keeps its literal `NAME=`: `env`'s grammar
 * is `[NAME=VALUE]… [COMMAND [ARG]…]`, so the word is still an assignment the
 * wrapper table consumes, not an unknown command (Codex on #497).
 */
function dynamicSlot(word: Readonly<MvdanWord>): string {
  const first = word.Parts[0];
  const lit =
    first && sh().syntax.NodeType(first) === "Lit" ? (first.Value ?? "") : "";
  const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(lit);
  return name ? `${name[0]}${DYNAMIC_WORD}` : DYNAMIC_WORD;
}

/**
 * A simple command's words, each a placeholder where dynamic, resolved through
 * the wrapper table. `at` is how many words the table dropped off the front,
 * so `words[at]` is the program and `words.slice(at + 1)` its own arguments.
 */
function resolveWords(words: readonly Readonly<MvdanWord>[]): {
  readonly probe: readonly string[];
  readonly resolved: readonly string[];
  readonly at: number;
} {
  // A dynamic word stays in place so the wrapper table, which drops words
  // only off the FRONT, keeps the positions of the AST words.
  const probe = words.map((w, i) => {
    const t = normalizeParts(w.Parts, false, true) ?? dynamicSlot(w);
    return i === 0 ? normalizeHead(t) : t;
  });
  const resolved = stripWrappers(probe).argv;
  return { probe, resolved, at: probe.length - resolved.length };
}

function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** Split a `NAME=value` word into its name and value. */
function splitAssignmentWord(word: string): [string, string | null] {
  const eq = word.indexOf("=");
  const value = word.slice(eq + 1);
  return [word.slice(0, eq), isKnown(value) ? value : null];
}

/**
 * Resolve a wrapped command through one or more wrapper layers. Given a leaf's
 * full normalized argv (`[head, ...args]`), returns the effective argv of the
 * REAL command plus any `NAME=value` words an `env` wrapper consumed (so the
 * caller can fold them into the leaf's assignment map). If the head is not a
 * wrapper, or the wrapper has no following command, the argv is returned
 * unchanged with an empty assignment set.
 *
 * @internal — the SINGLE answer to "which word is the real command head". Read
 * by `bash-equivalents.ts` (to generate wrapper-prefixed spellings) and by
 * `core/command-files.ts` (to find the interpreter behind a wrapper, so
 * `env python3 guard` names its script). That second reader had its own idea of
 * what a wrapper was — namely none — so it reported no script at all for the
 * wrapped form, and a missing script that is never named is a hook that runs,
 * exits 2, and is scored as a block. One list, or the next wrapper is missed in
 * whichever copy nobody remembered.
 */
export function stripWrappers(argv: readonly string[]): {
  argv: readonly string[];
  envAssigns: Map<string, string | null>;
  chdir: string | null;
} {
  const envAssigns = new Map<string, string | null>();
  let chdir: string | null = null;
  let cur: readonly string[] = argv;
  for (let guard = 0; guard < 8; guard++) {
    const head = cur[0];
    if (head === undefined || !WRAPPER_HEADS.has(head)) break;
    const valueOpts = WRAPPER_VALUE_OPTS[head] ?? new Set<string>();
    const chdirOpts = WRAPPER_CHDIR_OPTS[head] ?? new Set<string>();
    let positionalsToSkip = WRAPPER_SKIP_POSITIONALS[head] ?? 0;
    let i = 1; // start after the wrapper head
    let ended = false;
    for (; i < cur.length; i++) {
      const a = cur[i];
      if (a === undefined) break;
      if (a === "--") {
        i++;
        ended = true;
        break;
      }
      if (a.length > 1 && a.startsWith("-")) {
        // The chdir value is CAPTURED before it is skipped. It was always read
        // here — reading it is how the loop knows to skip past it — and then
        // discarded, so every relative operand of the wrapped command resolved
        // against the wrong directory downstream.
        chdir = nestChdir(chdir, chdirValue(a, cur[i + 1], chdirOpts));
        if (valueOpts.has(a)) i++; // skip this option's separate value too
        continue;
      }
      if (head === "env" && isAssignmentWord(a)) {
        const [name, value] = splitAssignmentWord(a);
        envAssigns.set(name, value);
        continue;
      }
      if (positionalsToSkip > 0) {
        positionalsToSkip--;
        continue;
      }
      break; // cur[i] is the real command head
    }
    void ended;
    if (i >= cur.length) break; // wrapper with no following command → keep as-is
    const next = cur.slice(i);
    if (next.length === cur.length) break; // no progress → stop
    cur = next;
  }
  return { argv: cur, envAssigns, chdir };
}

// ===========================================================================
// WHERE A LEAF RUNS. A guard that blocks `git pull` in an untrusted repository
// let `cd /foreign && git pull` through: the leaf `git pull` carried no
// directory, so the guard judged it by the session's. `NormalizedLeaf.at` is
// every directory a leaf may run in, RELATIVE to where the command line starts
// (`.`), or `unresolved` with the reason when the text does not fix it.
//
// The model is an abstract interpretation over SETS of directories: each
// command yields the states after it SUCCEEDS and after it FAILS, and the
// connectors pick between them — `cd x && c` runs `c` only where `cd` worked,
// `cd x; c` runs it in either directory (ShellCheck SC2164: a failed `cd`
// leaves the script in the old one), `cd x || exit; c` only in `x`. A subshell,
// either side of a pipe, a `&` job and a command substitution start where the
// shell is and leave it there. `pushd`/`popd` carry a stack, `cd -` the
// previous directory. What the text does not fix is NEVER guessed: `cd "$X"`,
// a function or `source` that may move, `GIT_DIR`, more than
// {@link MAX_DIR_CANDIDATES} paths — the state becomes `unresolved` and stays
// so until a subshell ends.
//
// Paths join LEXICALLY, as bash's default `cd -L` does; `CDPATH` is not read
// (the gate never sees the tool's environment). Checked against real bash by a
// differential test: `src/hook-dirs-oracle.test.ts`.
// ===========================================================================

/** Why a leaf's directory is not known from the command text. */
export type UnresolvedDir =
  /** `cd "$X"`, `git -C "$D"`, `env -C "$D"`, `cd ~user`: the path is not literal. */
  | "dynamic-dir"
  /** `cd -` with no earlier `cd` in this line: the previous directory came from before it. */
  | "oldpwd"
  /** `popd`, a bare `pushd`, `pushd +1` on a stack this line did not build. */
  | "dir-stack"
  /** A loop whose body changes directory: the number of turns is a runtime fact. */
  | "conditional-dir-change"
  /** A function, `source`/`.`, a dynamic `eval` or program that may move the shell. */
  | "opaque-dir-change"
  /** `GIT_DIR`, `GIT_WORK_TREE`, `--git-dir`, `--work-tree`: git ignores its directory. */
  | "git-dir-override"
  /** More than eight possible directories for one leaf. */
  | "too-many-candidates"
  /** A `cd` this model does not read: two operands, an unknown option. */
  | "unsupported-cd-form";

/**
 * Where one leaf runs, relative to the directory its command line starts in:
 * `.`, `../o`, an absolute path, or `~`-rooted. `candidates` lists EVERY
 * directory it may run in (empty for a leaf that cannot be reached, after an
 * `exit`); `unresolved` says why the text does not fix it.
 */
export type LeafDirs =
  | { readonly kind: "candidates"; readonly dirs: readonly string[] }
  | { readonly kind: "unresolved"; readonly reason: UnresolvedDir };

/** One way the shell can stand at a point of the line. */
interface DirConfig {
  readonly dir: string;
  /** `pushd`'s stack, top first, as built in this line. */
  readonly stack: readonly string[];
  /** The directory before the last change, for `cd -`; `null` when it predates the line. */
  readonly old: string | null;
  /** An exported `GIT_DIR`/`GIT_WORK_TREE` is in force. */
  readonly gitDir: boolean;
}

type DirState =
  | { readonly kind: "known"; readonly configs: readonly DirConfig[] }
  | { readonly kind: "unresolved"; readonly reason: UnresolvedDir };

/** The states after a command succeeds and after it fails. */
interface DirOutcome {
  readonly ok: DirState;
  readonly fail: DirState;
}

/** The most directories one leaf is given before the model gives up. */
const MAX_DIR_CANDIDATES = 8;

/** Where a command line starts: `.`, no stack, no earlier directory. */
const START_DIR: DirState = {
  kind: "known",
  configs: [{ dir: ".", stack: [], old: null, gitDir: false }],
};

/** No way to get here (after `exit`). */
const NEVER: DirState = { kind: "known", configs: [] };

const lostAt = (reason: UnresolvedDir): DirState => ({
  kind: "unresolved",
  reason,
});

/** The reasons most of the model reaches for. */
const DYNAMIC: UnresolvedDir = "dynamic-dir";
const DYNAMIC_DIR: DirState = lostAt(DYNAMIC);
const OPAQUE_DIR: DirState = lostAt("opaque-dir-change");
const STACK_UNKNOWN: DirState = lostAt("dir-stack");

const same = (s: DirState): DirOutcome => ({ ok: s, fail: s });

/** Either state: the union of their configurations; unresolved wins. */
function joinStates(a: DirState, b: DirState): DirState {
  if (a.kind === "unresolved") return a;
  if (b.kind === "unresolved") return b;
  const byKey = new Map(
    [...a.configs, ...b.configs].map((c) => [JSON.stringify(c), c] as const),
  );
  return byKey.size > MAX_DIR_CANDIDATES
    ? lostAt("too-many-candidates")
    : { kind: "known", configs: [...byKey.values()] };
}

const joinOutcomes = (a: DirOutcome, b: DirOutcome): DirOutcome => ({
  ok: joinStates(a.ok, b.ok),
  fail: joinStates(a.fail, b.fail),
});

/** Run `step` from every configuration of `s` and join what it yields. */
function eachConfig(
  s: DirState,
  step: (c: DirConfig) => DirOutcome,
): DirOutcome {
  if (s.kind === "unresolved") return same(s);
  return s.configs.map(step).reduce(joinOutcomes, { ok: NEVER, fail: NEVER });
}

const knownOne = (c: DirConfig): DirState => ({ kind: "known", configs: [c] });

/**
 * `p` joined onto `base`, lexically, as `cd -L` does: `a` + `../b` is `b`. An
 * absolute or `~`-rooted `p` replaces `base`. `null` when the result climbs
 * out of `~` (`~/..`), which names a directory the gate cannot spell.
 */
export function joinDir(base: string, p: string): string | null {
  if (p === "") return base;
  const fresh = p.startsWith("/") || p === "~" || p.startsWith("~/");
  const raw = fresh ? p : `${base}/${p}`;
  const n = posix.normalize(raw);
  const out = n.length > 1 ? n.replace(/\/+$/, "") : n;
  return raw.startsWith("~") && !(out === "~" || out.startsWith("~/"))
    ? null
    : out;
}

/**
 * Move one configuration to `target` — an operand joined onto where it stands,
 * or (`placed`) a directory the model already holds, from the stack or `cd -`
 * — remembering where it came from.
 */
function moveTo(
  c: DirConfig,
  target: string,
  stack: readonly string[] = c.stack,
  placed = false,
): DirOutcome {
  const dir = placed ? target : joinDir(c.dir, target);
  if (dir === null) return same(DYNAMIC_DIR);
  return { ok: knownOne({ ...c, dir, stack, old: c.dir }), fail: knownOne(c) };
}

/** A `cd` operand as written, or why it is not read. */
type CdTarget =
  | { readonly kind: "to"; readonly path: string }
  | { readonly kind: "back" }
  | { readonly kind: "lost"; readonly reason: UnresolvedDir };

/** Read `cd [-L|-P|-e|-@]… [--] [dir]`. A word the parser cannot know is `null`. */
function cdTarget(args: readonly (string | null)[]): CdTarget {
  if (args.some((a) => a === null)) return { kind: "lost", reason: DYNAMIC };
  const words = args.flatMap((a) => (a === null ? [] : [a]));
  const end = words.findIndex((w) => !/^-[LPe@]+$/.test(w));
  const rest = end < 0 ? [] : words.slice(end);
  const operands = rest[0] === "--" ? rest.slice(1) : rest;
  const [op, extra] = operands;
  if (
    extra !== undefined ||
    (op !== undefined && op !== "-" && op.startsWith("-"))
  )
    return { kind: "lost", reason: "unsupported-cd-form" };
  if (op === undefined) return { kind: "to", path: "~" };
  if (op === "-") return { kind: "back" };
  return op.startsWith("~") && op !== "~" && !op.startsWith("~/")
    ? { kind: "lost", reason: DYNAMIC }
    : { kind: "to", path: op };
}

function cdOutcome(args: readonly (string | null)[], s: DirState): DirOutcome {
  const t = cdTarget(args);
  if (t.kind === "lost") return same(lostAt(t.reason));
  return eachConfig(s, (c) => {
    if (t.kind === "to") return moveTo(c, t.path);
    return c.old === null
      ? same(lostAt("oldpwd"))
      : moveTo(c, c.old, c.stack, true);
  });
}

function pushdOutcome(
  args: readonly (string | null)[],
  s: DirState,
): DirOutcome {
  const [op, extra] = args;
  if (op === null || extra !== undefined) return same(STACK_UNKNOWN);
  if (op !== undefined && /^[-+]/.test(op)) return same(STACK_UNKNOWN);
  return eachConfig(s, (c) => {
    if (op !== undefined) return moveTo(c, op, [c.dir, ...c.stack]);
    const [top, ...rest] = c.stack;
    return top === undefined
      ? same(STACK_UNKNOWN)
      : moveTo(c, top, [c.dir, ...rest], true);
  });
}

function popdOutcome(
  args: readonly (string | null)[],
  s: DirState,
): DirOutcome {
  if (args.length > 0) return same(STACK_UNKNOWN);
  return eachConfig(s, (c) => {
    const [top, ...rest] = c.stack;
    return top === undefined ? same(STACK_UNKNOWN) : moveTo(c, top, rest, true);
  });
}

/** Every configuration with `GIT_DIR` (or `GIT_WORK_TREE`) now exported. */
function withGitDir(s: DirState): DirState {
  return s.kind === "unresolved"
    ? s
    : {
        kind: "known",
        configs: s.configs.map((c) => ({ ...c, gitDir: true })),
      };
}

const GIT_DIR_VARS: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
]);

/** The source byte range of a statement: how the model keys what it saw. */
const stmtKey = (n: Readonly<MvdanNode>): string =>
  `${n.Pos?.().Offset() ?? -1}:${n.End?.().Offset() ?? -1}`;

/** The heads that move the shell when run as builtins. */
const DIR_BUILTINS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** Every function the line declares, by name, with its body. */
function declaredFunctions(
  file: Readonly<MvdanNode>,
): readonly (readonly [string, MvdanNode])[] {
  return statements(file).flatMap((st) => {
    const fn = st.Cmd;
    return fn &&
      sh().syntax.NodeType(fn) === "FuncDecl" &&
      fn.Name?.Value &&
      fn.Body
      ? [[fn.Name.Value, fn.Body] as const]
      : [];
  });
}

/** A directory no real path spells: a function that leaves it has moved the shell. */
const PROBE_DIR: DirState = {
  kind: "known",
  configs: [{ dir: "\u0000probe", stack: [], old: null, gitDir: false }],
};

/**
 * Names of functions declared in the line whose body may move the shell —
 * decided by the same interpreter, so anything it does not understand
 * (`command -p cd`, a `trap`, a dynamic program, a call to another such
 * function) counts as moving. Computed to a FIXED POINT: a chain of any
 * length is followed, and one past the bound is treated as moving.
 */
function dirMovingFunctions(file: Readonly<MvdanNode>): ReadonlySet<string> {
  const decls = declaredFunctions(file);
  const all = new Set(decls.map(([name]) => name));
  const moves = (
    body: Readonly<MvdanNode>,
    funcs: ReadonlySet<string>,
  ): boolean => {
    const o = stmtOutcome(body, PROBE_DIR, {
      record: ignoreRecord,
      funcs,
      declared: all,
    });
    return (
      JSON.stringify(joinStates(o.ok, o.fail)) !== JSON.stringify(PROBE_DIR)
    );
  };
  const step = (
    known: ReadonlySet<string>,
    round: number,
  ): ReadonlySet<string> => {
    if (round > decls.length) return all;
    const next = new Set(
      decls.filter(([, body]) => moves(body, known)).map(([n]) => n),
    );
    return next.size === known.size ? next : step(next, round + 1);
  };
  return step(new Set(), 0);
}

/**
 * The state at every statement of `file`, from `start`. A statement the walk
 * did not reach (none is expected) reads as `opaque-dir-change`.
 */
function dirModel(
  file: Readonly<MvdanNode>,
  start: DirState,
): (stmt: Readonly<MvdanNode>) => DirState {
  const seen = new Map<string, DirState>();
  const record = (st: Readonly<MvdanNode>, s: DirState): void => {
    const k = stmtKey(st);
    const before = seen.get(k);
    // eslint-disable-next-line functional/immutable-data -- the model's one accumulator: the state each statement was reached in, joined over every path
    seen.set(k, before ? joinStates(before, s) : s);
  };
  interpret(file.Stmts ?? [], start, {
    record,
    funcs: dirMovingFunctions(file),
    declared: new Set(declaredFunctions(file).map(([name]) => name)),
  });
  return (st) => seen.get(stmtKey(st)) ?? OPAQUE_DIR;
}

/** What the interpreter carries: where to note a state, which names move. */
interface DirCtx {
  readonly record: (st: Readonly<MvdanNode>, s: DirState) => void;
  /** Functions whose body may move the shell. */
  readonly funcs: ReadonlySet<string>;
  /** Every function the line declares: one may shadow a builtin the model reads. */
  readonly declared: ReadonlySet<string>;
}

/** A statement list, in order: each statement starts where the last ended. */
function interpret(
  stmts: readonly MvdanNode[],
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  const begin: DirOutcome = { ok: s, fail: NEVER };
  return stmts.reduce(
    (prev, st) => stmtOutcome(st, joinStates(prev.ok, prev.fail), ctx),
    begin,
  );
}

function stmtOutcome(
  st: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  ctx.record(st, s);
  (st.Redirs ?? []).forEach((r) => {
    scanSubshells(r, s, ctx);
  });
  if (!st.Cmd) return same(s);
  // `cmd &` runs in a background subshell: the shell stays where it was.
  if (st.Background) {
    cmdOutcome(st.Cmd, s, ctx);
    return same(s);
  }
  const o = cmdOutcome(st.Cmd, s, ctx);
  return st.Negated ? { ok: o.fail, fail: o.ok } : o;
}

/**
 * Statements nested in WORDS — `$(…)`, `<(…)` — run in a subshell from `s`,
 * in order within each substitution.
 */
function scanSubshells(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): void {
  sh().syntax.Walk(node, (n) => {
    const t = sh().syntax.NodeType(n);
    if (t === "CmdSubst" || t === "ProcSubst") {
      interpret(n.Stmts ?? [], s, ctx);
      return false;
    }
    if (t === "Stmt") {
      stmtOutcome(n, s, ctx);
      return false;
    }
    return true;
  });
}

/** `&&` (10), `||` (11), `|` (12), `|&` (13) — mvdan's `BinaryCmd.Op`. */
const AND_OP = 10;
const OR_OP = 11;

function binaryOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  if (!node.X || !node.Y) return same(s);
  if (node.Op !== AND_OP && node.Op !== OR_OP) {
    // A pipeline: each side is its own subshell.
    stmtOutcome(node.X, s, ctx);
    stmtOutcome(node.Y, s, ctx);
    return same(s);
  }
  const x = stmtOutcome(node.X, s, ctx);
  if (node.Op === AND_OP) {
    const y = stmtOutcome(node.Y, x.ok, ctx);
    return { ok: y.ok, fail: joinStates(x.fail, y.fail) };
  }
  const y = stmtOutcome(node.Y, x.fail, ctx);
  return { ok: joinStates(x.ok, y.ok), fail: y.fail };
}

function ifOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  const cond = node.Cond ?? [];
  // An `else` is an IfClause with no condition: its body always runs.
  const c = cond.length > 0 ? interpret(cond, s, ctx) : { ok: s, fail: NEVER };
  const then = interpret(node.Then ?? [], c.ok, ctx);
  if (node.Else) return joinOutcomes(then, ifOutcome(node.Else, c.fail, ctx));
  // No branch taken: the `if` exits 0 where the condition failed.
  return { ok: joinStates(then.ok, c.fail), fail: then.fail };
}

/**
 * A loop body runs any number of times. If one turn leaves the shell where
 * it found it, every turn does; otherwise the turns are a runtime fact.
 */
function loopOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  if (node.Loop) scanSubshells(node.Loop, s, ctx);
  const once = joinOutcomes(
    interpret(node.Cond ?? [], s, ctx),
    interpret(node.Do ?? [], s, ctx),
  );
  const after = joinStates(once.ok, once.fail);
  if (JSON.stringify(joinStates(s, after)) === JSON.stringify(s))
    return same(s);
  const lost = lostAt("conditional-dir-change");
  interpret(node.Cond ?? [], lost, ctx);
  interpret(node.Do ?? [], lost, ctx);
  return same(lost);
}

function caseOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  // `;&` and `;;&` run the next item too, from where this one ended: rare,
  // and not modelled, so a case using them stops being known.
  const items = node.Items ?? [];
  if (items.some((i) => i.Op !== undefined && i.Op !== CASE_BREAK_OP)) {
    const lost = lostAt("conditional-dir-change");
    items.forEach((i) => interpret(i.Stmts ?? [], lost, ctx));
    return same(lost);
  }
  return items
    .map((i) => interpret(i.Stmts ?? [], s, ctx))
    .reduce(joinOutcomes, { ok: s, fail: NEVER });
}

/** `;;` — mvdan's `CaseItem.Op` for an item that ends the `case`. */
const CASE_BREAK_OP = 30;

function declOutcome(node: Readonly<MvdanNode>, s: DirState): DirOutcome {
  // `export GIT_DIR=…`, `declare -x GIT_DIR`, even `local GIT_DIR`: read as
  // exported, the cautious side — a leaf that may not be git's own directory
  // asks rather than being placed.
  return same(
    afterAssigning(
      (node.Args ?? []).map((a) => a.Name?.Value ?? null),
      s,
    ),
  );
}

/**
 * Variables `cd` itself reads — `CDPATH` (where a relative operand is looked
 * up), `HOME` (a bare `cd`, `~`), `OLDPWD` (`cd -`), `PWD` (a logical `cd ..`).
 * The model does not follow a value assigned to one; it stops knowing.
 */
const CD_INPUT_VARS: ReadonlySet<string> = new Set([
  "CDPATH",
  "HOME",
  "OLDPWD",
  "PWD",
]);

/**
 * The state after the line assigns `names` (`X=1`, `export X=1`, `read X`):
 * unresolved after a variable `cd` reads or a name that is not literal,
 * `GIT_DIR` in force after a git directory variable.
 */
function afterAssigning(
  names: readonly (string | null)[],
  s: DirState,
): DirState {
  if (names.some((n) => n === null || CD_INPUT_VARS.has(n))) return OPAQUE_DIR;
  return names.some((n) => n !== null && GIT_DIR_VARS.has(n))
    ? withGitDir(s)
    : s;
}

/** A function body runs where it is called, which this point cannot know. */
function funcDeclOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  if (node.Body) stmtOutcome(node.Body, OPAQUE_DIR, ctx);
  return same(s);
}

/** Compound commands that never move the shell they run in. */
const STAYING: ReadonlySet<string> = new Set([
  "TestClause",
  "ArithmCmd",
  "LetClause",
  "CoprocClause",
]);

function cmdOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  switch (sh().syntax.NodeType(node)) {
    case "CallExpr":
      scanSubshells(node, s, ctx);
      return callOutcome(node, s, ctx);
    case "BinaryCmd":
      return binaryOutcome(node, s, ctx);
    case "Subshell":
      interpret(node.Stmts ?? [], s, ctx);
      return same(s);
    case "Block":
      return interpret(node.Stmts ?? [], s, ctx);
    case "IfClause":
      return ifOutcome(node, s, ctx);
    case "WhileClause":
    case "ForClause":
      return loopOutcome(node, s, ctx);
    case "CaseClause":
      if (node.Word) scanSubshells(node.Word, s, ctx);
      return caseOutcome(node, s, ctx);
    case "TimeClause":
      return node.Stmt ? stmtOutcome(node.Stmt, s, ctx) : same(s);
    case "FuncDecl":
      return funcDeclOutcome(node, s, ctx);
    case "DeclClause":
      scanSubshells(node, s, ctx);
      return declOutcome(node, s);
    default:
      // `[[ … ]]`, `(( … ))`, `let`, a coprocess do not move this shell; a
      // construct the model does not read is never assumed to stay put.
      scanSubshells(node, s, ctx);
      return same(STAYING.has(sh().syntax.NodeType(node)) ? s : OPAQUE_DIR);
  }
}

/**
 * A word as the shell will see it, for the directory model: `null` when it
 * depends on the run, including `$'…'` with an escape, whose bytes the
 * normalizer does not decode.
 */
function dirWord(w: Readonly<MvdanWord>): string | null {
  const ansi = (w.Parts ?? []).some(
    (p) => p.Dollar === true && (p.Value ?? "").includes("\\"),
  );
  return ansi ? null : normalizeParts(w.Parts, false, true);
}

/** What a simple command runs once `command` and `builtin` are looked through. */
type Invoked =
  | { readonly kind: "run"; readonly name: string; readonly at: number }
  /** `command -v x`: describes `x`, runs nothing. */
  | { readonly kind: "describe" }
  /** A dynamic word or an option the model does not read. */
  | { readonly kind: "lost" };

/**
 * Look through `command [-p] [--]` and `builtin [--]`, which run a builtin
 * in THIS shell: `command -p cd /x` and `builtin cd /x` move it like `cd /x`.
 * `sudo cd`, `env cd` run a program named cd in a child and move nothing.
 */
function invoked(words: readonly (string | null)[], at = 0): Invoked {
  const w = words[at];
  if (w === null || w === undefined) return { kind: "lost" };
  const name = normalizeHead(w);
  if (name !== "command" && name !== "builtin")
    return { kind: "run", name, at };
  const opts = name === "command" ? /^-[pvV]+$/ : /^$/;
  const next = (i: number): Invoked => {
    const o = words[i];
    if (o === undefined) return { kind: "describe" }; // a bare `command` runs nothing
    if (o === null) return { kind: "lost" };
    if (o === "--") return invoked(words, i + 1);
    if (!o.startsWith("-") || o === "-") return invoked(words, i);
    if (!opts.test(o)) return { kind: "lost" };
    return /[vV]/.test(o) ? { kind: "describe" } : next(i + 1);
  };
  return next(at + 1);
}

/** Builtins the model reads: a function of the same name shadows it. */
const MODELLED_BUILTINS: ReadonlySet<string> = new Set([
  ...DIR_BUILTINS,
  "command",
  "builtin",
  "eval",
  "source",
  ".",
  "exit",
  "exec",
  "trap",
  "shopt",
  "enable",
  "unset",
]);

/** A simple command: the three builtins move the shell; a few end or hide it. */
function callOutcome(
  node: Readonly<MvdanNode>,
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  const words = (node.Args ?? []).map(dirWord);
  const assigned = (node.Assigns ?? []).map((a) => a.Name?.Value ?? null);
  if (words.length === 0) return same(afterAssigning(assigned, s));
  const run = invoked(words);
  if (run.kind === "describe") return same(s);
  // A dynamic program (`$CD x`) may be a builtin that moves the shell; a
  // function named `cd` replaces the one the model reads.
  if (run.kind === "lost") return same(OPAQUE_DIR);
  const direct = run.at === 0;
  if (direct && ctx.declared.has(run.name) && MODELLED_BUILTINS.has(run.name))
    return same(OPAQUE_DIR);
  // `CDPATH=/x cd y`: the prefix steers this very `cd`.
  if (
    DIR_BUILTINS.has(run.name) &&
    assigned.some((n) => n === null || CD_INPUT_VARS.has(n ?? ""))
  )
    return same(OPAQUE_DIR);
  const argWords = (node.Args ?? []).slice(run.at + 1);
  return run.name === "eval"
    ? evalOutcome(argWords, s, ctx)
    : builtinOutcome(run.name, words.slice(run.at + 1), s, ctx);
}

/** Builtins that assign variables NAMED in their arguments. */
const ASSIGNING_BUILTINS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "read",
  "printf",
  "mapfile",
  "readarray",
  "getopts",
]);

/** The variable names an assigning builtin's arguments may name. */
const namedVars = (
  args: readonly (string | null)[],
): readonly (string | null)[] =>
  args
    .filter((a) => a === null || !a.startsWith("-"))
    .map((a) =>
      a === null ? null : (/^[A-Za-z_][A-Za-z0-9_]*/.exec(a)?.[0] ?? a),
    );

function builtinOutcome(
  name: string,
  args: readonly (string | null)[],
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  switch (name) {
    case "cd":
      return cdOutcome(args, s);
    case "pushd":
      return pushdOutcome(args, s);
    case "popd":
      return popdOutcome(args, s);
    case "exit":
      return same(NEVER);
    case "exec":
      return args.length > 0 ? same(NEVER) : same(s);
    // `enable -n cd` swaps the builtin for a program: not followed.
    case "source":
    case ".":
    case "enable":
      return same(OPAQUE_DIR);
    case "trap":
      return trapOutcome(args, s, ctx);
    case "shopt":
      // `cdable_vars` turns `cd name` into `cd $name`.
      return args.some((a) => a === null || a === "cdable_vars")
        ? same(OPAQUE_DIR)
        : same(s);
    case "unset":
      return args.some(
        (a) => a === null || (a !== "CDPATH" && CD_INPUT_VARS.has(a)),
      )
        ? same(OPAQUE_DIR)
        : same(s);
    default:
      if (ASSIGNING_BUILTINS.has(name))
        return same(afterAssigning(namedVars(args), s));
      return ctx.funcs.has(name) ? same(OPAQUE_DIR) : same(s);
  }
}

/**
 * `trap ACTION SIGNAL…` runs ACTION later in this shell — a `DEBUG` trap
 * before every command. An action that may move the shell (read by the same
 * interpreter) or is not literal makes the rest of the line unresolved.
 */
function trapOutcome(
  args: readonly (string | null)[],
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  const [action, ...signals] = args;
  if (action === undefined || signals.length === 0) return same(s);
  if (action === null) return same(OPAQUE_DIR);
  if (action.startsWith("-")) return same(s); // `trap -p`, `trap -l`, `trap - SIG`
  const file = parseOrNull(action);
  if (file === null) return same(OPAQUE_DIR);
  const o = interpret(file.Stmts ?? [], PROBE_DIR, {
    ...ctx,
    record: ignoreRecord,
  });
  return JSON.stringify(joinStates(o.ok, o.fail)) === JSON.stringify(PROBE_DIR)
    ? same(s)
    : same(OPAQUE_DIR);
}

/** A recorder that keeps nothing: for statements of another source text. */
function ignoreRecord(): void {
  // nothing to keep
}

/** `eval '<literal>'` runs in THIS shell: its `cd` moves the line. */
function evalOutcome(
  argWords: readonly Readonly<MvdanWord>[],
  s: DirState,
  ctx: DirCtx,
): DirOutcome {
  const texts = argWords.map(literalText);
  if (texts.some((t) => t === null) || texts[0]?.startsWith("-"))
    return same(OPAQUE_DIR);
  const file = parseOrNull(texts.join(" "));
  // The inner statements are another source text: keyed apart, so they are
  // interpreted for their effect on the line and not recorded here (readShell
  // re-reads them, from the same state, for their own leaves).
  return file
    ? interpret(file.Stmts ?? [], s, { ...ctx, record: ignoreRecord })
    : same(s);
}

/**
 * The directory a leaf runs in, from the state its statement was reached in:
 * its own wrapper's `env -C`/`sudo -D`, then each `git -C`, applied in turn.
 */
function leafDirsFrom(
  s: DirState,
  chdir: string | null,
  program: ProgramDirs,
): LeafDirs {
  if (s.kind === "unresolved") return s;
  if (program.kind === "lost")
    return { kind: "unresolved", reason: program.reason };
  if (program.gitDir && s.configs.some((c) => c.gitDir))
    return { kind: "unresolved", reason: "git-dir-override" };
  const steps = [...(chdir === null ? [] : [chdir]), ...program.dirs];
  if (steps.some((d) => !isKnown(d)))
    return { kind: "unresolved", reason: DYNAMIC };
  const placed = s.configs.map((c) =>
    steps.reduce<string | null>(
      (d, step) => (d === null ? null : joinDir(d, step)),
      c.dir,
    ),
  );
  if (placed.some((d) => d === null))
    return { kind: "unresolved", reason: DYNAMIC };
  return {
    kind: "candidates",
    dirs: [...new Set(placed.flatMap((d) => (d === null ? [] : [d])))],
  };
}

/**
 * Where a child shell (`bash -c '…'`) starts: where its leaf runs, with a
 * fresh directory stack and no previous directory of its own, and the
 * environment (an exported `GIT_DIR`) inherited.
 */
function childShellStart(
  at: LeafDirs | undefined,
  parent: DirState,
  launchGitDir: boolean,
): DirState {
  if (at === undefined) return parent;
  if (at.kind === "unresolved") return lostAt(at.reason);
  const gitDir =
    launchGitDir ||
    (parent.kind === "known" && parent.configs.some((c) => c.gitDir));
  return {
    kind: "known",
    configs: at.dirs.map((dir) => ({ dir, stack: [], old: null, gitDir })),
  };
}

/** What a program's own options say about its directory: today, `git -C`. */
type ProgramDirs =
  | {
      readonly kind: "dirs";
      readonly dirs: readonly string[];
      /** A git leaf: an exported `GIT_DIR` in the line overrides its directory. */
      readonly gitDir: boolean;
    }
  | { readonly kind: "lost"; readonly reason: UnresolvedDir };

const NO_PROGRAM_DIRS: ProgramDirs = { kind: "dirs", dirs: [], gitDir: false };

/**
 * `git -C <dir>` (each one relative to the last, git(1)), read off the
 * leaf's argv with its dynamic slots still in place; `--git-dir`,
 * `--work-tree` and a `GIT_DIR`/`GIT_WORK_TREE` assignment turn off the
 * directory search, so the leaf's directory is no longer its repository.
 */
function programDirs(
  argv: readonly string[],
  assigns: ReadonlyMap<string, string | null>,
): ProgramDirs {
  if (normalizeHead(argv[0] ?? "") !== "git") return NO_PROGRAM_DIRS;
  const args = argv.slice(1);
  const sub = subcommandIndex("git", args);
  const own = sub < 0 ? args : args.slice(0, sub);
  // `-c core.worktree=…` (git config keys ignore case) moves the work tree as
  // `--work-tree` does; a `-c` value the parser cannot read may be that key.
  const configs = own.flatMap((a, i) =>
    a === "-c" ? [own[i + 1] ?? DYNAMIC_WORD] : [],
  );
  const overrides =
    [...assigns.keys()].some((k) => GIT_DIR_VARS.has(k)) ||
    own.some((a) =>
      /^--(git-dir|work-tree)(=|$)|^--config-env=core\.worktree=/i.test(a),
    ) ||
    configs.some((v) => !isKnown(v) || /^core\.worktree=/i.test(v));
  if (overrides) return { kind: "lost", reason: "git-dir-override" };
  const dirs = own.flatMap((a, i) =>
    a === "-C" ? [own[i + 1] ?? DYNAMIC_WORD] : [],
  );
  return { kind: "dirs", dirs, gitDir: true };
}

/**
 * Extract every simple command as a {@link NormalizedLeaf} — the operation-level
 * twin of {@link leafCommands}. Same AST-backed structural coverage (a leaf nested
 * in a pipeline / `&&` / subshell is still found), but each word is quote-unwrapped
 * and $HOME-canonicalized, the head is reduced to its backslash-stripped basename,
 * and flags are expanded to short+long canonical forms. A matcher built on this
 * compares against the OPERATION rather than the surface tokens, so it is robust
 * to quoting, interpreter path, backslash escaping, flag aliasing, and $HOME/~.
 *
 * Each leaf also carries its REDIRECTIONS ({@link LeafRedirect}), which live on
 * the enclosing `Stmt` rather than the `CallExpr` — walking CallExprs alone
 * dropped them, hiding the file a command writes. Every CallExpr in the mvdan AST
 * IS a `Stmt.Cmd`, so iterating statements finds exactly the same leaves.
 *
 * Purely additive: reuses the same mvdan-sh parse, changes nothing above. Parse
 * failure → []. A leaf with a dynamic head is skipped (can't be normalized).
 */
export function leafCommandsNormalized(command: string): NormalizedLeaf[] {
  return shellEffects(command).flatMap((e) =>
    e.kind === "leaf" ? [e.leaf] : [],
  );
}

/** One thing a command does that a gate reads: a simple command, or a redirection. */
export type ShellEffect =
  | {
      readonly kind: "leaf";
      readonly leaf: NormalizedLeaf;
      /**
       * An argument word whose value bash splits into words the parser cannot
       * know: an unquoted `$F`, `${F}` or `$(…)`, or a quoted `"$@"` /
       * `"${a[@]}"`. The leaf's `args` omit it, so any of those words may be a
       * flag the leaf does not show. A quoted `"$F"` is one word, passed as
       * data, and does not count — see {@link splitsWords}.
       */
      readonly unknownWords: boolean;
    }
  | { readonly kind: "redirect"; readonly redirect: LeafRedirect };

/**
 * The simple commands AND every redirection of a command line, from one parse
 * (vigiles#470).
 *
 * Bash attaches a redirection to a STATEMENT, and a statement can be a group
 * (`{ …; } > f`), a subshell, a loop, an `if`, a function definition, a
 * declaration (`export X=1 > f`), a test (`[[ … ]] > f`) or nothing at all
 * (`> f`, which still creates the file). A leaf carries only the redirections of
 * its own statement, so reading writes off the leaves dropped every one of those
 * shapes. Here every statement's redirections are effects of their own, whatever
 * its command is — mvdan keeps each redirection on a `Stmt`, so no shape is
 * enumerated and a construct bash adds later is covered too. Order: statements
 * as the walk meets them, each one's leaf before its redirections. Parse
 * failure → `[]`.
 */
export function shellEffects(command: string): readonly ShellEffect[] {
  const file = parseOrNull(command);
  if (!file) return [];
  const where = dirModel(file, START_DIR);
  return statements(file).flatMap((st) => stmtEffects(st, where));
}

/** The command parsed, or `null` — mvdan-sh throws a Go error object on bad input. */
function parseOrNull(src: string): MvdanNode | null {
  try {
    return sh().syntax.NewParser().Parse(src, "cmd.sh");
  } catch {
    return null;
  }
}

/** Every statement of a parsed command, in walk order. */
function statements(file: Readonly<MvdanNode>): readonly MvdanNode[] {
  const out: MvdanNode[] = [];
  sh().syntax.Walk(file, (node) => {
    if (sh().syntax.NodeType(node) === "Stmt") out.push(node);
    return true;
  });
  return out;
}

/** One statement's effects: its simple command, then its redirections. */
function stmtEffects(
  stmt: Readonly<MvdanNode>,
  where: (st: Readonly<MvdanNode>) => DirState,
): readonly ShellEffect[] {
  const redirs = stmt.Redirs ?? [];
  const leaf = stmt.Cmd
    ? normalizeCallExpr(stmt.Cmd, redirs, where(stmt))
    : null;
  return [
    ...(leaf
      ? [
          {
            kind: "leaf",
            leaf,
            unknownWords: programArgs(stmt.Cmd?.Args ?? []).some(splitsWords),
          } as const,
        ]
      : []),
    ...normalizeRedirects(redirs).map(
      (redirect) => ({ kind: "redirect", redirect }) as const,
    ),
  ];
}

/**
 * Does bash turn this argument word into words the parser cannot know?
 *
 * Unquoted, a parameter expansion or a command substitution is split on
 * whitespace after it is expanded: `F=-f; git push $F` hands git `-f`, and
 * `F="-f origin"` hands it two words. Inside double quotes the value is ONE
 * word, and it is not split — `"$F"` is how a script passes a path, a message
 * or a branch as data, so it is not counted (else every `cp "$SRC" "$DST"`
 * would count). The exception is `"$@"` and `"${a[@]}"`, which expand to one
 * word per element even when quoted. `$HOME` is canonicalized to `~` by the
 * normalizer, and `$((…))` yields digits, so neither counts.
 */
function splitsWords(word: Readonly<MvdanWord>): boolean {
  return (word.Parts ?? []).some((p) => {
    const t = sh().syntax.NodeType(p);
    if (t === "CmdSubst") return true;
    if (t === "ParamExp") return p.Param?.Value !== "HOME";
    return t === "DblQuoted" && (p.Parts ?? []).some(expandsToMany);
  });
}

/**
 * The words the program itself receives, past any wrapper: `env A="$X" git
 * push` gives git `push`, and the wrapper's own words are not its arguments.
 * A leaf exists only for a CallExpr, whose `Args` are words.
 */
function programArgs(
  words: readonly Readonly<MvdanWord>[],
): readonly Readonly<MvdanWord>[] {
  return words.slice(resolveWords(words).at + 1);
}

/** `$@` or `${a[@]}`: one word per element, quoted or not. */
function expandsToMany(p: Readonly<MvdanNode>): boolean {
  if (sh().syntax.NodeType(p) !== "ParamExp") return false;
  const index = p.Index?.Parts ?? [];
  return (
    p.Param?.Value === "@" || (index.length === 1 && index[0]?.Value === "@")
  );
}

// ===========================================================================
// A COMMAND HANDED TO ANOTHER PROGRAM (vigiles#460). `bash -c "git push -f"`
// parses as ONE simple command, `bash`, whose third word is a string: to the
// grammar that string is data, and only the program `bash` makes it code. So a
// gate keyed on the leaf saw `bash` and allowed the push it was written to
// block (measured against real bash: 53 of the 61 pushing forms were allowed).
//
// Two answers, and deliberately nothing in between:
//
//  - READ. `<shell> -c '<literal>'` with nothing else on the shell, and
//    `eval '<literal>' …`. The string is parsed again by the same parser and
//    its effects join the command's, as if typed directly. Literal means the
//    parser knows every byte: no `$VAR`, no `$(…)`, no `$'…'`.
//  - HIDDEN. Every other way a program in {@link SHELL_HEADS} or
//    {@link RUNNER_HEADS} is handed a command — options on the shell, a
//    dynamic string, a shell reading stdin, `find -exec`, `su`, `env -S`,
//    `xargs` adding words from stdin, … — is reported with the program's name.
//    The gate runtime turns a gate's `allow` into an `ask` on it.
//
// Reading only the plain forms is the point: learning every option grammar of
// every runner is unbounded, and what is not read is asked about, never
// allowed in silence. A CLOSED world, said out loud: a program not in these two
// tables (a script file, `python -c`, `make`, `npx`, `ssh`) is not looked into.
// ===========================================================================

/** The shells whose `-c '<literal>'` is read. One grammar parses all of them. */
const SHELL_HEADS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "ash",
]);

/**
 * Programs that run a command handed to them in their argv — and are NOT in
 * {@link WRAPPER_HEADS}, whose tail is already resolved in place. `su` and
 * `runuser` start a shell even with no argument; the rest need one.
 */
const RUNNER_HEADS: ReadonlySet<string> = new Set([
  "exec",
  "builtin",
  "setsid",
  "stdbuf",
  "ionice",
  "chrt",
  "taskset",
  "flock",
  "script",
  "watch",
  "parallel",
  "su",
  "runuser",
  "sg",
  "chroot",
  "unshare",
  "nsenter",
  "doas",
  "pkexec",
]);

/** `find` actions that run a command. */
const FIND_EXEC: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);

/** How deep strings are re-parsed: real agent commands nest at most once. */
const MAX_NESTED_DEPTH = 4;
/** The largest nested string that is re-parsed, in UTF-16 units. */
const MAX_NESTED_LENGTH = 256 * 1024;

/** Why a handed-on command could not be read. */
export type HiddenReason =
  /** `bash -c "$CMD"`, `eval "$X"`, `bash -c $'…'`: the string is not literal. */
  | "dynamic-command-string"
  /** `$CMD`, `$G push -f`, `$(which git) push`: the program itself is not literal. */
  | "dynamic-program"
  /**
   * `git push $F`: the program the gate asked about gets words from an
   * unquoted expansion, which may be the flag it asked about. Reported by the
   * gate runtime, not by {@link readShell} — whether it matters depends on the
   * question (see the leaf's `unknownWords`).
   */
  | "dynamic-argument"
  /** A shell with options or arguments beyond a bare `-c '<literal>'`. */
  | "shell-options"
  /** A shell with no `-c` and no script: it runs whatever arrives on stdin. */
  | "stdin-fed-shell"
  /** A program that runs a command it is handed (`find -exec`, `su`, `env -S`, …). */
  | "runner"
  /** Nested deeper than {@link MAX_NESTED_DEPTH}. */
  | "too-deep"
  /** A nested string longer than {@link MAX_NESTED_LENGTH}. */
  | "too-large"
  /** A literal nested string the parser rejects. */
  | "parse-error"
  /**
   * A leaf the gate asked about runs in a directory the text does not fix
   * (`cd "$X" && git pull`). Reported by the gate runtime when a decision
   * called `dirs()`, not by {@link readShell}.
   */
  | "unknown-directory";

/** One place a command was handed on and could not be read. */
export interface HiddenCommand {
  /**
   * The program that was handed it: `bash`, `find`, `env`, …; for
   * `dynamic-program`, the word that stands for the program as written
   * (`$CMD`, `$DIR/git`, or `$(…)` for a command substitution).
   */
  readonly runner: string;
  readonly reason: HiddenReason;
}

/** What a command line does, read through the plain nested forms. */
export interface ShellReading {
  /** {@link shellEffects} of the line, then of every string read inside it. */
  readonly effects: readonly ShellEffect[];
  /** Every nested command string that was read, outermost first. */
  readonly inner: readonly string[];
  /** Every place a command was handed on and not read. */
  readonly hidden: readonly HiddenCommand[];
}

/** What one simple command hands on. */
type Carried =
  | { readonly kind: "none" }
  | { readonly kind: "read"; readonly runner: string; readonly text: string }
  | { readonly kind: "hidden"; readonly hidden: HiddenCommand };

const NONE: Carried = { kind: "none" };
const hiddenBy = (runner: string, reason: HiddenReason): Carried => ({
  kind: "hidden",
  hidden: { runner, reason },
});

/**
 * {@link shellEffects}, followed into the commands the line hands to a shell or
 * to `eval` in the plain form, and a {@link HiddenCommand} for every other
 * hand-off. A command line without a shell, `eval` or runner is parsed once.
 *
 * @internal — the reading behind the Bash gate's words (`runs`, `writesTo`, …)
 * and its ask-on-hidden rule.
 */
export function readShell(command: string): ShellReading {
  const file = parseOrNull(command);
  return file ? readFile(file, 0) : EMPTY_READING;
}

const EMPTY_READING: ShellReading = { effects: [], inner: [], hidden: [] };

function readFile(
  file: Readonly<MvdanNode>,
  depth: number,
  start: DirState = START_DIR,
): ShellReading {
  const stmts = statements(file);
  const where = dirModel(file, start);
  const nested = stmts.map((st) => followCarried(st, depth, where));
  return {
    effects: [
      ...stmts.flatMap((st) => stmtEffects(st, where)),
      ...nested.flatMap((r) => r.effects),
    ],
    inner: nested.flatMap((r) => r.inner),
    hidden: nested.flatMap((r) => r.hidden),
  };
}

/** Read one statement's hand-off: parse a literal string, or say why not. */
function followCarried(
  stmt: Readonly<MvdanNode>,
  depth: number,
  where: (st: Readonly<MvdanNode>) => DirState,
): ShellReading {
  const call = stmt.Cmd;
  const c =
    call && sh().syntax.NodeType(call) === "CallExpr" ? carriedBy(call) : NONE;
  if (c.kind === "none") return EMPTY_READING;
  if (c.kind === "hidden") return { ...EMPTY_READING, hidden: [c.hidden] };
  const hide = (reason: HiddenReason): ShellReading => ({
    ...EMPTY_READING,
    hidden: [{ runner: c.runner, reason }],
  });
  if (depth + 1 > MAX_NESTED_DEPTH) return hide("too-deep");
  if (c.text.length > MAX_NESTED_LENGTH) return hide("too-large");
  const file = parseOrNull(c.text);
  if (file === null) return hide("parse-error");
  // The inner command starts where the outer program was moved to
  // (`cd x && env -C y sh -c '…'`); a `cd` inside a shell stays inside it,
  // while `eval` runs in THIS shell, stack and previous directory included.
  const outer = call ? normalizeCallExpr(call, [], where(stmt)) : null;
  // `GIT_DIR=/x bash -c 'git pull'`: the launching command's own assignment
  // is in the inner command's environment too.
  const launchGitDir = outer?.hasAssign(...GIT_DIR_VARS) ?? false;
  const here = where(stmt);
  const evalStart = launchGitDir ? withGitDir(here) : here;
  const inner = readFile(
    file,
    depth + 1,
    c.runner === "eval"
      ? evalStart
      : childShellStart(outer?.at, here, launchGitDir),
  );
  const dir = outer?.chdir ?? null;
  return {
    effects: inner.effects.map((e) => underDirectory(e, dir)),
    inner: [c.text, ...inner.inner],
    hidden: inner.hidden,
  };
}

/** An effect of a nested command, placed under the directory its shell started in. */
function underDirectory(e: ShellEffect, dir: string | null): ShellEffect {
  if (dir === null) return e;
  if (e.kind === "leaf")
    return {
      ...e,
      leaf: { ...e.leaf, chdir: nestChdir(dir, e.leaf.chdir ?? undefined) },
    };
  const t = e.redirect.target;
  if (t === null || t.startsWith("~") || !e.redirect.writes) return e;
  return {
    kind: "redirect",
    redirect: { ...e.redirect, target: nestChdir(dir, t) },
  };
}

/**
 * What a simple command hands on, decided on its words after the wrapper table
 * resolved them — so `sudo sh -c '…'` reads like `sh -c '…'`. A dynamic program
 * (`$G push`, `sudo $CMD`) names no program at all, so it is hidden: whatever it
 * holds could be the command the gate was written to block.
 */
function carriedBy(call: Readonly<MvdanNode>): Carried {
  const words = call.Args ?? [];
  const { probe, resolved, at } = resolveWords(words);
  const wrapped = wrapperHides(probe, at);
  if (wrapped !== null) return hiddenBy(wrapped, "runner");
  if (resolved[0]?.includes(DYNAMIC_WORD))
    return hiddenBy(sourceParts(words[at]?.Parts) ?? "$(…)", "dynamic-program");
  const head = normalizeHead(resolved[0] ?? "");
  const args = resolved.slice(1);
  const argWords = words.slice(at + 1);
  if (SHELL_HEADS.has(head)) return shellCarries(head, args, argWords);
  if (head === "eval") return evalCarries(args, argWords);
  if (head === "find")
    return args.some((a) => FIND_EXEC.has(a))
      ? hiddenBy("find", "runner")
      : NONE;
  return RUNNER_HEADS.has(head) && (args.length > 0 || SHELL_STARTERS.has(head))
    ? hiddenBy(head, "runner")
    : NONE;
}

/**
 * Runners that start a shell reading stdin even with no argument. Measured on
 * util-linux: `printf 'echo X' | unshare` (and `nsenter`, `script`) prints X;
 * `setsid`, `chroot` and `flock` refuse to run without one.
 */
const SHELL_STARTERS: ReadonlySet<string> = new Set([
  "su",
  "runuser",
  "unshare",
  "nsenter",
  "script",
]);

/**
 * The wrappers that hand on MORE than the argv the wrapper table resolves:
 * `xargs` appends words it reads from stdin, `env -S STR` splits a string into
 * a command, `sudo -s`/`-i` runs one through a shell. `at` is how many words
 * the table dropped; when it dropped none the head is itself a wrapper with no
 * command after it, and its options are all its words.
 */
function wrapperHides(probe: readonly string[], at: number): string | null {
  const region = at > 0 ? probe.slice(0, at) : probe;
  const optionsAfter = (name: string): readonly string[] => {
    const i = region.indexOf(name);
    return i < 0 ? [] : region.slice(i + 1).filter((w) => w.startsWith("-"));
  };
  if (at > 0 && region.includes("xargs")) return "xargs";
  if (
    optionsAfter("env").some(
      (o) => /^-[^-]*S/.test(o) || o.startsWith("--split-string"),
    )
  )
    return "env";
  return optionsAfter("sudo").some(
    (o) => /^-[a-zA-Z]*[si]/.test(o) || o === "--shell" || o === "--login",
  )
    ? "sudo"
    : null;
}

/** `<shell> -c '<literal>'` is read; a script operand is out of scope; the rest hides. */
function shellCarries(
  shell: string,
  args: readonly string[],
  argWords: readonly Readonly<MvdanWord>[],
): Carried {
  if (args.length === 2 && args[0] === "-c") {
    const text = literalText(argWords[1]);
    return text === null
      ? hiddenBy(shell, "dynamic-command-string")
      : { kind: "read", runner: shell, text };
  }
  const first = args[0];
  // An argument the parser could not resolve (`"$FLAG"`) may be `-c`: hidden.
  if (first !== undefined && first.includes("\u0000"))
    return hiddenBy(shell, "dynamic-command-string");
  if (first !== undefined && !first.startsWith("-") && !first.startsWith("+"))
    return NONE; // `bash deploy.sh`: a literal script file, not looked into
  return hiddenBy(
    shell,
    args.some((a) => /^-[a-zA-Z]*c/.test(a))
      ? "shell-options"
      : "stdin-fed-shell",
  );
}

/** `eval A B …` runs its literal arguments joined by spaces. */
function evalCarries(
  args: readonly string[],
  argWords: readonly Readonly<MvdanWord>[],
): Carried {
  if (args.length === 0) return NONE;
  if (args[0]?.startsWith("-")) return hiddenBy("eval", "shell-options");
  const texts = argWords.map(literalText);
  return texts.every((t): t is string => t !== null)
    ? { kind: "read", runner: "eval", text: texts.join(" ") }
    : hiddenBy("eval", "dynamic-command-string");
}

/**
 * A word exactly as the program receives it, or `null` when any byte depends on
 * the run: an expansion, a substitution, `$'…'` or `$"…"`. Not
 * {@link normalizeParts}, which keeps path backslashes and turns `$HOME` into
 * `~` on purpose — a string re-parsed as CODE needs the bytes the inner shell
 * reads.
 */
function literalText(word: Readonly<MvdanWord> | undefined): string | null {
  const parts = (word?.Parts ?? []).map((p) => literalPart(p, false));
  return word && parts.every((t): t is string => t !== null)
    ? parts.join("")
    : null;
}

function literalPart(p: Readonly<MvdanNode>, inDq: boolean): string | null {
  switch (sh().syntax.NodeType(p)) {
    case "Lit":
      return unescapeLit(p.Value ?? "", inDq);
    case "SglQuoted":
      return p.Dollar ? null : (p.Value ?? "");
    case "DblQuoted": {
      const inner = (p.Parts ?? []).map((q) => literalPart(q, true));
      return !p.Dollar && inner.every((t): t is string => t !== null)
        ? inner.join("")
        : null;
    }
    default:
      return null;
  }
}

/**
 * Reconstruct a Word's SOURCE-level text: quotes unwrapped, parameter references
 * kept verbatim (`${CLAUDE_PROJECT_DIR}` → `$CLAUDE_PROJECT_DIR`). `null` when a
 * segment cannot be reconstructed at all (command substitution, arithmetic,
 * process substitution).
 *
 * The twin of {@link normalizeParts}, and deliberately NOT the same function.
 * `normalizeParts` answers "what OPERATION is this" and therefore collapses
 * `$HOME` to `~` and gives up on every other parameter; a caller that needs the
 * PATH a word names can use neither behaviour — `$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh`
 * has to survive as written, because a file resolver matches it by suffix.
 */
function sourceParts(parts: readonly MvdanNode[] | undefined): string | null {
  if (!parts) return null;
  let out = "";
  for (const p of parts) {
    const t = sh().syntax.NodeType(p);
    if (t === "Lit" || t === "SglQuoted") {
      out += p.Value ?? "";
    } else if (t === "DblQuoted") {
      const inner = sourceParts((p as MvdanWord).Parts);
      if (inner === null) return null;
      out += inner;
    } else if (t === "ParamExp") {
      const name = p.Param?.Value;
      if (!name) return null;
      out += `$${name}`;
    } else {
      return null; // CmdSubst / ArithmExp / ProcSubst / … → unreconstructable
    }
  }
  return out;
}

/**
 * Every simple command's argv, POSITIONALLY, each word reconstructed at source
 * level — the primitive a caller needs to tell an EXECUTED PROGRAM from a DATA
 * OPERAND.
 *
 * 🔴 WHY POSITION, AND WHY A THIRD EXTRACTOR. `leafCommands` DROPS the words it
 * cannot reduce to a literal, so `"$GUARD" --flag` yields `["--flag"]` — a
 * dynamic head silently promotes an argument into head position, which is worse
 * than useless to a positional reader. `leafCommandsNormalized` skips such a leaf
 * outright AND basenames the head, so `./hooks/x.sh` loses the path a file
 * resolver needs. This one keeps every word in its slot (an unreconstructable
 * word becomes `""`) and keeps the head's spelling.
 *
 * Wrappers are still resolved through (`env FOO=1 bash x.sh` → `bash x.sh`)
 * using the same wrapper table as the normalized extractor, not a second copy.
 *
 * 🔴 ONLY THE LEAVES THAT UNCONDITIONALLY RUN, and this used to be a blanket
 * `Walk` over every `CallExpr` in the tree. A syntactic leaf is not an executed
 * command: `false && bash hooks/pre.sh` and `true || bash hooks/pre.sh` never run
 * the hook, and `if false; then bash hooks/x.sh; fi` and a function BODY do not
 * run at all where they are written — yet all four were reported as executed
 * programs. For the one caller (coverage attribution) that is a FALSE GRANT: a
 * hook credited with a run that never happened. Same class as attributing a data
 * operand, one level up in the grammar.
 *
 * So the tree is DESCENDED, not walked, and only through positions whose children
 * always execute: a statement list, both sides of a PIPELINE, a subshell, a
 * block. `&&`/`||` contribute their LEFT side only — the right is conditional.
 * Every other construct (`if`, `while`, `until`, `for`, `case`, a function
 * declaration, `time`, …) is not entered at all: whether its body ran is a
 * runtime fact this parse cannot have, and abstaining costs one warning while
 * guessing costs a false claim that something was tested.
 *
 * ⚠️ THE MEASURED COST, stated rather than assumed: `cd /repo && bash hooks/x.sh`
 * now yields NOTHING, because the hook sits on the right of `&&`. That idiom has
 * a first-class replacement — `runHook(cmd, event, { cwd })` — which is how this
 * repo's own examples already write it.
 *
 * Parse failure → `[]`.
 */
export function leafArgvSource(command: string): string[][] {
  let file: MvdanNode;
  try {
    file = sh().syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    return [];
  }
  const out: string[][] = [];
  const emit = (node: MvdanNode): void => {
    if (!node.Args?.length) return;
    const argv = node.Args.map((w) => sourceParts(w.Parts) ?? "");
    // `command -v x` DESCRIBES x; it does not run it. Without this the wrapper
    // table unwrapped both words and the operand looked executed.
    if (inspectsOnly(argv)) return;
    // The wrapper table keys on the BASENAME head (`/usr/bin/env` is `env`), so
    // detection runs on a basenamed copy while the returned words stay verbatim.
    // Wrappers only ever drop words off the FRONT, so a count maps the result
    // back onto the original spellings.
    const probe = [normalizeHead(argv[0] ?? ""), ...argv.slice(1)];
    const dropped = probe.length - stripWrappers(probe).argv.length;
    out.push(argv.slice(dropped));
  };
  // Both return TRUE when control provably does not continue past this node in
  // the ENCLOSING shell — the list stops there.
  const stmts = (list: readonly MvdanNode[] | undefined): boolean => {
    for (const st of list ?? []) if (descend(st)) return true;
    return false;
  };
  const descend = (node: MvdanNode | undefined): boolean => {
    if (!node) return false;
    switch (sh().syntax.NodeType(node)) {
      case "Stmt":
        // `cmd &` runs in a background SUBSHELL, so a terminator inside it never
        // reaches this shell (measured: `exit 0 & ./x.sh` runs `./x.sh`).
        return descend(node.Cmd) && node.Background !== true;
      case "CallExpr":
        emit(node);
        return terminates(node);
      case "BinaryCmd":
        // `&&` (10) and `||` (11) short-circuit, so only X is certain; a
        // PIPELINE (`|` 12, `|&` 13) runs both sides.
        if (node.Op === PIPE_OP || node.Op === PIPE_ALL_OP) {
          descend(node.X);
          descend(node.Y);
          // Each side of a pipeline is its own subshell — `exit 0 | cat; ./x.sh`
          // runs `./x.sh` (measured).
          return false;
        }
        return descend(node.X);
      case "Subshell":
        stmts(node.Stmts);
        return false; // `( exit 0 ); ./x.sh` runs `./x.sh` (measured)
      case "Block":
        return stmts(node.Stmts); // `{ exit 0; }; ./x.sh` does NOT (measured)
      case "FuncDecl":
        // A declaration executes nothing, so it neither contributes leaves nor
        // terminates: `f() { exit 0; }; ./x.sh` runs `./x.sh` (measured).
        return false;
      default:
        // A conditional or deferred body — not entered, because whether it ran
        // is a runtime fact this parse cannot have. But whether control REACHES
        // the next statement is a separate question, and if the body can
        // terminate the shell the answer is unknown, so the list stops here.
        return mayTerminate(node);
    }
  };
  stmts(file.Stmts);
  return out;
}

/**
 * Does this simple command end the shell, so that nothing after it in the same
 * list runs? MEASURED against bash 5.2 and dash on 2026-08-12 — the numbers and
 * the disagreement below are why this is not read off a POSIX table:
 *
 * ```
 *                                     bash            dash
 * exit 0; ./x.sh                      x NOT run       x NOT run
 * return 0; ./x.sh                    x RAN (+error)  x NOT run
 * exec ./x.sh; echo AFTER             AFTER not run   AFTER not run
 * exec > /dev/null; ./x.sh            x RAN           x RAN
 * ```
 *
 *  - `exit` — unconditional, both shells.
 *  - `return` — the two shells DISAGREE at top level: bash prints "can only
 *    `return' from a function or sourced script" and carries on; dash stops.
 *    `leafArgvSource` never enters a `FuncDecl`, so every `return` it can see is
 *    one of those top-level ones. Where the shells disagree the rule is to
 *    abstain, and for a coverage probe abstaining means NOT crediting what
 *    follows — so it truncates. Under bash that under-credits by one line; the
 *    other choice would be a false grant under `/bin/sh`, which is the shell
 *    `spawnSync(..., { shell: true })` actually uses.
 *  - `exec` — only with a command. `exec > file` (redirections and nothing else)
 *    just rewires the current shell and execution continues; that is the neighbour
 *    this rule would most easily get wrong, and the measurement above is why it
 *    does not. The exec'd program itself is emitted as a leaf like any other.
 */
function terminates(call: MvdanNode): boolean {
  const head = call.Args?.[0] ? getLiteral(call.Args[0]) : null;
  if (head === "exit" || head === "return") return true;
  // `exec` with at least one more word. A word that is only an option
  // (`exec -c`) counts too: mistaking it for a terminator drops later leaves,
  // which is the silent direction.
  return head === "exec" && (call.Args?.length ?? 0) > 1;
}

/**
 * Could this un-entered construct end the shell? A conservative YES stops the
 * statement list, because `if [ -z "$X" ]; then exit 1; fi; bash hooks/x.sh` does
 * not necessarily reach the hook (measured: with the branch taken, `./x.sh` does
 * NOT run).
 *
 * Deliberately conservative in the direction of SILENCE: an `exit` that could
 * only ever run inside a nested subshell still stops the list, costing one
 * coverage line. The common guard shape is untouched — a conditional containing
 * no terminator answers `false`, so `if …; then echo warn; fi; bash hooks/x.sh`
 * still attributes the hook.
 */
function mayTerminate(node: MvdanNode): boolean {
  let found = false;
  sh().syntax.Walk(node, (n) => {
    if (found) return false;
    // A function BODY is not executed where it is written, so a `return`/`exit`
    // inside one says nothing about control here.
    if (sh().syntax.NodeType(n) === "FuncDecl") return false;
    if (sh().syntax.NodeType(n) === "CallExpr" && terminates(n)) found = true;
    return !found;
  });
  return found;
}

/**
 * Is this leaf an INSPECTION rather than an execution? Then it contributes no
 * executed program, however script-shaped its operand.
 *
 * Same family as the interpreter's parse-only flags (`bash -n`, `node --check`):
 * a word that turns "run this" into "tell me about this". Bash 5.2's own
 * `help command`: *"Execute a simple command or display information about
 * commands."*
 *
 * MEASURED, bash 5.2, with a marker file the script touches — `ran` is whether
 * the operand actually executed:
 *
 * ```
 *   command -v ./pre.sh     ran=no    prints ./pre.sh
 *   command -V ./pre.sh     ran=no    prints "./pre.sh is ./pre.sh"
 *   command -pv ./pre.sh    ran=no
 *   command -vp ./pre.sh    ran=no
 *   command -Vp ./pre.sh    ran=no
 *   command -p ./pre.sh     ran=YES   ← -p is a PATH choice, not an inspection
 *   command ./pre.sh        ran=YES
 * ```
 *
 * ⚠️ THE REST OF THE WRAPPER TABLE WAS ASKED THE SAME QUESTION, and `command` is
 * the only member with an inspect-only mode. Run against this build, the
 * neighbours the finding names attribute NOTHING ALREADY — not by a rule, but
 * because they are not wrappers at all, so their operand is never reached:
 *
 * ```
 *   commandRefs("type hooks/pre.sh")   → []      (ran=no)
 *   commandRefs("which hooks/pre.sh")  → []      (ran=no)
 *   commandRefs("hash hooks/pre.sh")   → []      (ran=no)
 * ```
 *
 * `sudo -v` (validate) and `sudo -l` (list) take no command operand, so there is
 * nothing to attribute; `xargs -t` PRINTS what it runs and then runs it, so it
 * is not an inspection. Deliberately left out: `env`, `nice`, `timeout`,
 * `nohup` — none has an inspect mode (`--help`/`--version` exit without an
 * operand, so they cannot misattribute one).
 *
 * ⚠️ SCOPED TO THE COVERAGE EXTRACTOR ON PURPOSE. `leafArgvSource` has exactly
 * one caller and it is attribution; the SAFETY extractor (`leafCommands`, a
 * blanket walk) is untouched, keeping the opposite default established when the
 * statement-list truncation landed.
 */
function inspectsOnly(argv: readonly string[]): boolean {
  if (normalizeHead(argv[0] ?? "") !== "command") return false;
  for (const w of argv.slice(1)) {
    if (!w.startsWith("-") || w === "-") return false; // reached the operand
    if (w === "--") return false;
    if (/^-[pvV]+$/.test(w) && /[vV]/.test(w)) return true;
  }
  return false;
}

/** `BinaryCmd.Op` for `|` and `|&` — the two that run BOTH sides. */
const PIPE_OP = 12;
const PIPE_ALL_OP = 13;

/** Normalize a Stmt's redirections into {@link LeafRedirect}s (source order). */
function normalizeRedirects(redirs: readonly MvdanRedirect[]): LeafRedirect[] {
  return redirs.map((r) => {
    const fd = Number(r.N?.Value);
    return {
      op: REDIR_OP_NAMES.get(r.Op) ?? String(r.Op),
      target: r.Word ? normalizeParts(r.Word.Parts) : null,
      fd: Number.isInteger(fd) ? fd : null,
      writes: WRITE_REDIR_OPS.has(r.Op),
    };
  });
}

/** Collect a CallExpr's leading `NAME=value` env-assignments into a name→value map. */
function collectAssigns(node: MvdanNode): Map<string, string | null> {
  const assigns = new Map<string, string | null>();
  for (const a of node.Assigns ?? []) {
    const name = a.Name?.Value;
    if (!name) continue;
    // A naked `NAME=` has no Value word → empty string; a dynamic RHS → null.
    const value = a.Value ? normalizeParts(a.Value.Parts) : "";
    assigns.set(name, value);
  }
  return assigns;
}

/**
 * Normalize a single CallExpr node (plus the redirections of the `Stmt` that
 * wraps it) to a {@link NormalizedLeaf}, or null if it isn't one / has a dynamic head.
 */
function normalizeCallExpr(
  node: MvdanNode,
  redirs: readonly MvdanRedirect[],
  where: DirState = START_DIR,
): NormalizedLeaf | null {
  if (sh().syntax.NodeType(node) !== "CallExpr" || !node.Args?.length)
    return null;
  const headRaw = normalizeParts(node.Args[0]?.Parts, false, true);
  if (headRaw === null) return null; // dynamic head → not normalizable
  const rawHead = normalizeHead(headRaw);
  // Backslash resolution answers "what OPERATION is this" — the head and its
  // FLAGS — and must not touch a PATH operand. The two need opposite answers for
  // the SAME bytes: `sh` reads `--fo\rce` as `--force` (so a `{force:true}` guard
  // that missed it was open), while `\\SERVER\SHARE\repo\SECRETS\x` is a real
  // Windows UNC path whose backslashes a denylist must keep, or the write it
  // names stops matching `secrets` and the guard allows it. A word starting `-`
  // is never a path, so the split is decidable per word rather than guessed.
  // A dynamic word keeps its slot as a NUL until the wrapper table has run:
  // dropped first, `sudo -u $U git push -f` read as `sudo -u git push -f`, the
  // option took `git` as its value, and the leaf became `push -f`.
  const rawArgs = node.Args.slice(1).map((w) => {
    const raw = normalizeParts(w.Parts);
    if (raw === null) return dynamicSlot(w);
    if (!raw.startsWith("-")) return raw;
    return normalizeParts(w.Parts, false, true) ?? raw;
  });

  // Resolve through any command-wrapper (`env`/`command`/`sudo`/`timeout`/…) so
  // the leaf reflects the REAL operation, not the wrapper head.
  // When the dynamic word lands where the program would be (`sudo $CMD`,
  // `env $X git push -f`) the slot cannot be resolved, and the leaf is read as
  // before, with the word dropped: the gate then answers about the words it
  // can see, and `readShell` reports the program as hidden.
  const placed = stripWrappers([rawHead, ...rawArgs]);
  const stripped = placed.argv[0]?.includes(DYNAMIC_WORD)
    ? stripWrappers([rawHead, ...rawArgs.filter(isKnown)])
    : placed;
  const head = normalizeHead(stripped.argv[0] ?? rawHead);
  const args = stripped.argv.slice(1).filter(isKnown);

  // Command-level assignments: mvdan leading `CallExpr.Assigns` plus any
  // `NAME=value` words an `env` wrapper consumed on the way to the real command.
  const assigns = collectAssigns(node);
  for (const [k, v] of stripped.envAssigns) assigns.set(k, v);

  const flags = buildFlags(head, args);
  return {
    head,
    argv: [head, ...args],
    args,
    flags,
    hasFlag: (...names) => names.some((n) => flags.has(n)),
    assigns,
    hasAssign: (...names) => names.some((n) => assigns.has(n)),
    redirects: normalizeRedirects(redirs),
    chdir: stripped.chdir,
    at: leafDirsFrom(
      where,
      stripped.chdir,
      programDirs(stripped.argv, assigns),
    ),
  };
}
