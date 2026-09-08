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

// mvdan-sh is a CJS package (GopherJS build) with no bundled TypeScript types.
// The project compiles to CommonJS (Node16, no "type":"module"), so plain
// require() works and is the idiomatic pattern here (see linters.ts).
const _sh = require("mvdan-sh") as unknown;
const sh = _sh as {
  syntax: {
    NewParser: () => { Parse: (src: string, name: string) => MvdanNode };
    Walk: (node: MvdanNode, fn: (node: MvdanNode) => boolean) => void;
    NodeType: (node: MvdanNode) => string;
  };
};

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
  if (sh.syntax.NodeType(part) === "Lit") return part.Value ?? null;
  return null;
}

/** Like getLiteral but also unwraps a single-Lit DblQuoted word. */
function getLiteralDeep(word: MvdanWord | undefined): string | null {
  if (!word?.Parts || word.Parts.length !== 1) return null;
  const p = word.Parts[0];
  if (!p) return null;
  const t = sh.syntax.NodeType(p);
  if (t === "Lit") return p.Value ?? null;
  if (t === "DblQuoted") {
    const inner = p as MvdanWord;
    if (!inner.Parts || inner.Parts.length !== 1) return null;
    const ip = inner.Parts[0];
    if (!ip || sh.syntax.NodeType(ip) !== "Lit") return null;
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
  const t = sh.syntax.NodeType(cmd);

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
  sh.syntax.Walk(root, (node) => {
    if (found) return false;
    if (sh.syntax.NodeType(node) === "ProcSubst") {
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
    file = sh.syntax.NewParser().Parse(command, "cmd.sh");
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
    file = sh.syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    return [];
  }
  const out: string[][] = [];
  sh.syntax.Walk(file, (node) => {
    if (sh.syntax.NodeType(node) === "CallExpr" && node.Args) {
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
   * (`-rf`→`r`,`f`) and each flag is recorded in BOTH short and long form via the
   * alias table, so a caller can test `--force`/`-f` or `--no-verify`/`-n`
   * uniformly. Long values are split on `=` (`--index-url=x`→`index-url`).
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
}

/**
 * Known short↔long flag aliases. Deliberately small and operation-relevant:
 * a caller always gates on the head (e.g. only treats `index-url` as supply-chain
 * when the head is `pip`), so recording both forms unconditionally is safe.
 */
/** @internal — read by `bash-equivalents.ts` to generate shell-equivalent variants. */
export const SHORT_TO_LONG: Readonly<Record<string, string>> = {
  f: "force",
  n: "no-verify",
  r: "recursive",
  i: "index-url",
};
/** @internal — read by `bash-equivalents.ts` to generate shell-equivalent variants. */
export const LONG_TO_SHORT: Readonly<Record<string, string>> = {
  force: "f",
  "no-verify": "n",
  recursive: "r",
  "index-url": "i",
};

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
    const t = sh.syntax.NodeType(p);
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

/** Build the canonical flag set for a leaf's args (short-cluster + alias expansion). */
function buildFlags(args: readonly string[]): Set<string> {
  const flags = new Set<string>();
  const add = (name: string): void => {
    if (!name) return;
    flags.add(name);
    if (name.length === 1 && SHORT_TO_LONG[name])
      flags.add(SHORT_TO_LONG[name]);
    const short = LONG_TO_SHORT[name];
    if (short) flags.add(short);
  };
  for (const a of args) {
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
function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** Split a `NAME=value` word into its name and value. */
function splitAssignmentWord(word: string): [string, string] {
  const eq = word.indexOf("=");
  return [word.slice(0, eq), word.slice(eq + 1)];
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
  let file: MvdanNode;
  try {
    file = sh.syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    return [];
  }
  const out: NormalizedLeaf[] = [];
  sh.syntax.Walk(file, (node) => {
    if (sh.syntax.NodeType(node) !== "Stmt" || !node.Cmd) return true;
    const leaf = normalizeCallExpr(node.Cmd, node.Redirs ?? []);
    if (leaf) out.push(leaf);
    return true;
  });
  return out;
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
    const t = sh.syntax.NodeType(p);
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
    file = sh.syntax.NewParser().Parse(command, "cmd.sh");
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
    switch (sh.syntax.NodeType(node)) {
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
  sh.syntax.Walk(node, (n) => {
    if (found) return false;
    // A function BODY is not executed where it is written, so a `return`/`exit`
    // inside one says nothing about control here.
    if (sh.syntax.NodeType(n) === "FuncDecl") return false;
    if (sh.syntax.NodeType(n) === "CallExpr" && terminates(n)) found = true;
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
): NormalizedLeaf | null {
  if (sh.syntax.NodeType(node) !== "CallExpr" || !node.Args?.length)
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
  const rawArgs = node.Args.slice(1)
    .map((w) => {
      const raw = normalizeParts(w.Parts);
      if (raw === null || !raw.startsWith("-")) return raw;
      return normalizeParts(w.Parts, false, true) ?? raw;
    })
    .filter((w): w is string => w !== null);

  // Resolve through any command-wrapper (`env`/`command`/`sudo`/`timeout`/…) so
  // the leaf reflects the REAL operation, not the wrapper head.
  const stripped = stripWrappers([rawHead, ...rawArgs]);
  const head = normalizeHead(stripped.argv[0] ?? rawHead);
  const args = stripped.argv.slice(1);

  // Command-level assignments: mvdan leading `CallExpr.Assigns` plus any
  // `NAME=value` words an `env` wrapper consumed on the way to the real command.
  const assigns = collectAssigns(node);
  for (const [k, v] of stripped.envAssigns) assigns.set(k, v);

  const flags = buildFlags(args);
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
  };
}

// ===========================================================================
// FILE-OPERAND extraction (the reference question, not the effect question)
// ===========================================================================

/**
 * Interpreters, and the flags after which the NEXT word is a PROGRAM rather
 * than a path. `node -e "<js>"`, `python -c "<py>"`, `perl -E "<pl>"`.
 *
 * Keyed by the head's basename, so `/usr/local/bin/node` and `node` behave the
 * same.
 */
const INLINE_PROGRAM_FLAGS = new Map<string, readonly string[]>([
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["nodejs", ["-e", "--eval", "-p", "--print"]],
  ["bun", ["-e", "--eval", "-p", "--print"]],
  ["deno", ["-e", "--eval", "-p", "--print"]],
  ["python", ["-c"]],
  ["python2", ["-c"]],
  ["python3", ["-c"]],
  ["ruby", ["-e"]],
  ["perl", ["-e", "-E"]],
  ["php", ["-r"]],
]);

/**
 * Shells, whose `-c` argument is a nested SHELL program. Not program text to be
 * discarded — program text to be PARSED, so `bash -c 'exec "$ROOT/hooks/x.sh"'`
 * still yields its script.
 */
const SHELL_HEADS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "busybox",
]);

/** Guard against a pathological `sh -c 'sh -c "sh -c …"'` nest. */
const MAX_SHELL_NESTING = 3;

/**
 * Every word of every simple command in `command` that could name a FILE, with
 * inline PROGRAM TEXT removed — the primitive behind "does this hook's script
 * exist?".
 *
 * 🔴 WHY A FOURTH EXTRACTOR, stated against the three that already exist,
 * because "there is already one that returns words" is exactly the reasoning
 * that produced the bug this replaces.
 *
 *  - `leafCommands` drops every word it cannot reduce to a LITERAL, so
 *    `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh` — the standard spelling of a hook path —
 *    disappears entirely. Unusable for a file question.
 *  - `leafCommandsNormalized` basenames the head, so `./hooks/x.sh` becomes
 *    `x.sh` and no resolver can find it.
 *  - `leafArgvSource` keeps the spelling but answers a DIFFERENT question:
 *    "which leaves unconditionally RUN". It drops the right-hand side of `&&`
 *    by design, so `cd "$ROOT" && node hooks/x.mjs` yields no script. For
 *    coverage attribution that abstention is correct; for "must this file
 *    exist?" it is a miss, because a conditionally-run script still has to be
 *    on disk.
 *
 * So this walks EVERY simple command, keeps every word at source level, and
 * subtracts only the words that are provably not paths.
 *
 * 🔴 WHAT IT SUBTRACTS, and the defect that motivated it. The hook scanner used
 * to run a regex over the raw command STRING. Against the standard portable
 * plugin idiom —
 *
 *     node -e "(async()=>{…await import(…join(root,'hooks','always-on.mjs'))…})()"
 *
 * — it grabbed a character run ending at `.mjs` and reported the hook's script
 * as `import(require(node:url).pathToFileURL(require(node:path).join(root,hooks,always-on.mjs`,
 * MISSING. `hooks/always-on.mjs` was 1,766 bytes on disk. Nine such findings
 * across the 32-repo corpus, contributing to two `F/0` grades. Inside a shell
 * parse the argument of `-e` is not a word the shell will ever resolve to a
 * file, so it is not returned.
 *
 * ⚠️ HOW MUCH OF THAT THE FLAG TABLE ACTUALLY DID, measured rather than
 * assumed: none of it, on that corpus. Mutating the `-e`/`-c` subtraction OFF
 * and re-auditing all three affected repos still yields ZERO false hook-script
 * findings, because both real payloads are single words that either contain
 * whitespace or do not end in a script extension, and the caller anchors its
 * match to a whole word. The table is kept because it is the difference
 * between a function whose contract ("words that could name a file") is true
 * and one whose contract is merely true-so-far: without it a JavaScript
 * program is handed to every caller as a candidate filename, and the next
 * caller inherits the bug. Recorded here so nobody reads a corpus number back
 * onto the wrong mechanism.
 *
 * Words beginning with `-` are dropped as flags: a flag is not a path, and the
 * one caller anchors its match to a whole word anyway.
 *
 * Returns `null` — not `[]` — when the text does not parse as shell, so a
 * caller can tell "no file operands" from "no analysis", and cannot silently
 * treat the second as the first.
 */
export function commandWords(command: string): string[] | null {
  return commandWordsAt(command, 0);
}

function commandWordsAt(command: string, depth: number): string[] | null {
  let file: MvdanNode;
  try {
    file = sh.syntax.NewParser().Parse(command, "cmd.sh");
  } catch {
    return null;
  }
  const out: string[] = [];
  sh.syntax.Walk(file, (node) => {
    if (sh.syntax.NodeType(node) === "CallExpr" && node.Args?.length)
      fileOperandsOf(node.Args, depth, out);
    return true;
  });
  return out;
}

/**
 * The file-operand words of ONE simple command, appended to `out`.
 *
 * Wrappers are resolved through with the same table `leafArgvSource` uses (it
 * keys on the BASENAME head, and wrappers only ever drop words off the FRONT,
 * so a count maps the result back onto the original spellings — not a second
 * copy of the rule). Flags never name a file, so they are dropped; the word
 * AFTER an inline-program flag is dropped with them, and the word after a
 * shell's `-c` is parsed as shell instead.
 */
function fileOperandsOf(
  args: readonly MvdanWord[],
  depth: number,
  out: string[],
): void {
  const raw = args.map((w) => sourceParts(w.Parts) ?? "");
  const probe = [normalizeHead(raw[0] ?? ""), ...raw.slice(1)];
  const argv = raw.slice(probe.length - stripWrappers(probe).argv.length);
  const head = normalizeHead(argv[0] ?? "");
  const programFlags = INLINE_PROGRAM_FLAGS.get(head);
  const nestsShell = SHELL_HEADS.has(head) && depth < MAX_SHELL_NESTING;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    if (w === "") continue;
    if (!w.startsWith("-")) {
      out.push(w);
      continue;
    }
    if (nestsShell && w === "-c") {
      out.push(...(commandWordsAt(argv[++i] ?? "", depth + 1) ?? []));
    } else if (programFlags?.includes(w)) {
      i++; // the program text — not a word any shell resolves to a file
    }
  }
}
