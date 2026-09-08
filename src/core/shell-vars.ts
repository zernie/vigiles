/**
 * Which environment variables a shell command actually DEPENDS ON — the
 * parser-backed answer to "would this command run the same program here?".
 *
 * 🔴 WHY A PARSER AND NOT A REGEX, measured. The caller
 * (`experimental_verifyPluginGuards`) refuses to run a hook whose command names
 * a variable nothing has set, because running it would measure a different
 * program than the harness runs. Deciding that with `/\$\{?NAME\}?/` gets two
 * ordinary shapes wrong, in the direction that costs a measurement:
 *
 * | command                          | the shell            | a raw regex   |
 * | -------------------------------- | -------------------- | ------------- |
 * | `GUARD=hooks/g.sh; "$GUARD"`     | sets it, then expands| "unset GUARD" |
 * | `echo '$NOT_A_VAR'`              | no expansion at all  | "unset …"     |
 *
 * Both are self-contained commands reported as unresolvable, so a real guard
 * goes unmeasured for a reason that is not true of it. This is the
 * `parse-structured-input-with-a-real-parser` rule applied to the same shell
 * grammar `core/bash-effects.ts` already parses: an ASSIGNMENT and a SINGLE-
 * QUOTED literal are nodes, so once the command is an AST the two mistakes above
 * are not expressible.
 *
 * 🔴 AND THE PARSER REMOVED TWO WAYS TO BE WRONG WHILE ADDING A THIRD, in the
 * worse direction. Subtracting every assigned name GLOBALLY excused a read the
 * assignment never reached, so the sweep ran a differently-configured program
 * and gave it a score. Measured against `/bin/sh` with the name exported first:
 *
 * ```
 * export X=ambient;   echo "$X"; X=1           → ambient   (read comes FIRST)
 * export FOO=ambient; FOO=1 sh -c "echo $FOO"  → ambient   (prefix assign does
 *                                                           not reach its own
 *                                                           command's words)
 * (G=inner); printf '[%s]' "$G"                → []        (subshell-scoped)
 * G=dominates; printf '[%s]' "$G"              → dominates (this one persists)
 * ```
 *
 * So the rule is DOMINANCE, not membership, and CONTROL FLOW, not source order:
 * an assignment excuses a read only when it is an unconditional top-level
 * statement (see {@link persistingAssigns}) AND sits before that read. A prefix,
 * subshell, function-body, backgrounded, conditional or pipelined assignment
 * excuses nothing at all. Where dominance is not provable, the read stands.
 *
 * It does NOT reach into `bash-effects.ts` for the parse: that module's `sh`
 * handle and node types are private to it, and its types model EFFECTS
 * (redirections, wrapper heads, flag tables) rather than expansions. The shared
 * thing is the dependency, not the code — both `require("mvdan-sh")`.
 *
 * CONSERVATIVE, ON PURPOSE, IN ONE DIRECTION. Over-reporting a dependency costs
 * a hook its measurement (the caller says so and names the variable);
 * under-reporting one lets a differently-configured program be measured and
 * scored. So where the parser cannot decide, this reports MORE:
 *
 * - a parse failure falls back to the regex scan and says `parsed: false`;
 * - `${FOO:-default}` and `${FOO:?msg}` count as reads even though the first
 *   always resolves — reading the expansion operator is a further step, and its
 *   only effect would be to measure more hooks;
 * - a `for f in …` loop variable is a read (nothing binds it in the AST the way
 *   an `Assign` does).
 *
 * `$1` / `$@` / `$?` are never reads: they are positional and special
 * parameters, not environment the caller could set.
 */

// mvdan-sh is a CJS package (GopherJS build) with no bundled TypeScript types —
// the same require() `core/bash-effects.ts` uses, for the same parser.
const _sh = require("mvdan-sh") as unknown;
const sh = _sh as {
  syntax: {
    NewParser: () => { Parse: (src: string, name: string) => ShNode };
    Walk: (node: ShNode, fn: (node: ShNode) => boolean) => void;
    NodeType: (node: ShNode) => string;
  };
};

/** Only the fields this module reads; not an exhaustive mvdan-sh node. */
interface ShNode {
  /** `*Assign`: the variable name, a `*Lit` whose `.Value` is the name. */
  Name?: { Value?: string };
  /** `*ParamExp`: the parameter, a `*Lit` whose `.Value` is the name. */
  Param?: { Value?: string };
  /** `*CallExpr`: the command's words, and its leading `NAME=value` prefixes. */
  Args?: unknown[];
  Assigns?: ShNode[];
  /** `*File`: the script's top-level statement list. */
  Stmts?: ShNode[];
  /** `*Stmt`: the command it runs, and whether `&` detached it. */
  Cmd?: ShNode;
  Background?: boolean;
  /** `*DeclClause`: which declaring keyword it is (`export`, `local`, …). */
  Variant?: { Value?: string };
  /** Every node carries its source position; `Offset()` is the byte index. */
  Pos: () => { Offset: () => number };
  /** …and the offset just past its last byte, which is where it takes effect. */
  End: () => { Offset: () => number };
}

/** A `$NAME` / `${NAME}` reference — not `$(…)`, `$1` or `$@`. */
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/** An environment-variable name: what a caller could put in `env`. */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a command reads from its environment. */
export interface ShellVarReads {
  /** Names it expands and does not itself assign, first-seen order. */
  readonly reads: readonly string[];
  /**
   * Whether the shell parser accepted the command. `false` means `reads` came
   * from the regex fallback and may name a variable the command sets itself.
   */
  readonly parsed: boolean;
}

/** The fallback for a command the shell parser rejects: every `$NAME` in it. */
function scanRefs(command: string): string[] {
  const names = new Set<string>();
  for (const [, name] of command.matchAll(VAR_REF)) names.add(name);
  return [...names];
}

/**
 * The environment variables `command` expands and does not set for itself.
 *
 * @param command - the shell command, exactly as the hook registers it.
 */
/** A node's byte offset in the source, or `null` when the binding withholds it. */
function offsetOf(node: ShNode): number | null {
  try {
    return node.Pos().Offset();
  } catch {
    return null;
  }
}

/**
 * Where an assignment's effect BEGINS — one byte past its last, not at its first.
 *
 * 🔴 THE WHOLE OF THE SELF-REFERENTIAL BUG. The shell expands an assignment's
 * RHS and only THEN binds the name, so `MODE="$MODE"` reads the environment and
 * a read inside an initializer can never be dominated by the assignment
 * containing it. Keyed on the assignment's START, it was: the walk is preorder,
 * so the `Assign` node was recorded before its own `ParamExp` was visited, the
 * assignment's offset was the smaller one, and the genuine ambient read
 * disappeared. `MODE="$MODE"; [ "$MODE" = strict ] && exit 2` therefore reported
 * NO dependency — so under confinement the sweep cleared `MODE` without saying
 * so and scored whichever branch the empty value took.
 *
 * Keyed on the END, the containment falls out of the arithmetic rather than
 * needing a special case: a read inside the initializer has a smaller offset
 * than the assignment's end, so it stands; a read after the statement has a
 * larger one, so it is excused. Both directions are pinned in the tests.
 */
function endOfOrNull(node: ShNode): number | null {
  try {
    return node.End().Offset();
  } catch {
    return null;
  }
}

/**
 * Declaring keywords whose assignment persists into the rest of the SCRIPT.
 *
 * `local` is deliberately absent: it is meaningful only inside a function, and
 * a function body is precisely the scope this walker never treats as reached.
 */
const PERSISTING_DECLARATIONS: ReadonlySet<string> = new Set([
  "export",
  "readonly",
  "declare",
  "typeset",
]);

/**
 * Offsets of the assignments that excuse a later read — and it is an ALLOWLIST,
 * which is the whole of the fix. Two shapes are recognized, both TOP-LEVEL
 * statements of the script and neither detached with `&`: a bare `NAME=value`,
 * and a {@link PERSISTING_DECLARATIONS} keyword (`export NAME=value`), which the
 * parser models as a different node for the same persisting statement.
 *
 * 🔴 SOURCE ORDER IS NOT CONTROL FLOW, and reading it as such was a third way to
 * measure a differently-configured program. The earlier version marked the
 * assignments it could prove do not PERSIST (subshell, function body, command
 * prefix) and excused every other one that merely appeared earlier in the text —
 * so an assignment the shell may never execute silently excused the read it
 * sits before. Measured against `/bin/sh` with the name exported first:
 *
 * ```
 * MODE=safe; [ "$MODE" = safe ]                 → runs, and excuses the read
 * false && MODE=safe; [ "$MODE" = safe ]        → the AMBIENT value is read
 * if false; then MODE=safe; fi; [ "$MODE" = x ] → the AMBIENT value is read
 * MODE=safe & [ "$MODE" = safe ]                → detached: never reaches it
 * true | MODE=safe; [ "$MODE" = safe ]          → pipeline subshell, discarded
 * ```
 *
 * Four of those five excused the read under the old rule while the real shell
 * went on reading the environment. Under confinement the sweep clears that
 * environment, so it would have run the `MODE`-unset arm of a guard and scored
 * whatever that arm happens to do.
 *
 * An allowlist rather than a longer denylist because the denylist can only ever
 * be as complete as the grammar we remembered: `Subshell` and `FuncDecl` were on
 * it, `BinaryCmd`, `IfClause`, `WhileClause`, `ForClause`, `CaseClause`, `Block`
 * and a backgrounded `Stmt` were not, and the next construct would not be
 * either. Inverting it makes the unlisted case default to "excuses nothing",
 * which is the direction this module already errs in (see the header): an
 * assignment we cannot place costs a measurement, never a false score.
 *
 * The cost is named rather than hidden: `{ MODE=safe; }; echo "$MODE"` does run
 * unconditionally in this shell and is no longer excused. A brace group at the
 * top of a hook command is rare, and reporting `MODE` as a dependency there ends
 * in `unresolved` with the name printed — the safe error.
 */
function persistingAssigns(file: ShNode): Map<number, number> {
  // start offset → the offset its binding takes effect at (see endOfOrNull).
  const unconditional = new Map<number, number>();
  const take = (node: ShNode): void => {
    const at = offsetOf(node);
    const effective = endOfOrNull(node);
    // A binding whose extent the parser withheld cannot be shown to dominate
    // anything, so it is not recorded and every read of the name stands.
    if (at !== null && effective !== null) unconditional.set(at, effective);
  };
  for (const stmt of file.Stmts ?? []) {
    // `&` detaches into a subshell, so the assignment never reaches this one.
    if (stmt.Background === true) continue;
    const cmd = stmt.Cmd;
    if (!cmd) continue;
    const kind = sh.syntax.NodeType(cmd);
    // `export NAME=value` is a DeclClause, not a CallExpr — a separate node for
    // the same persisting, unconditional statement. Its `Args` ARE the `Assign`
    // nodes, so walking it reaches exactly them.
    if (kind === "DeclClause") {
      if (!PERSISTING_DECLARATIONS.has(cmd.Variant?.Value ?? "")) continue;
      sh.syntax.Walk(cmd, (node) => {
        if (node && sh.syntax.NodeType(node) === "Assign") take(node);
        return true;
      });
      continue;
    }
    if (kind !== "CallExpr") continue;
    // A `CallExpr` with WORDS carries prefix assignments (`FOO=1 cmd`), which do
    // not outlive their own command; one with no words IS the assignment
    // statement (`FOO=1`), which persists into the rest of the script.
    if ((cmd.Args?.length ?? 0) > 0) continue;
    for (const assign of cmd.Assigns ?? []) take(assign);
  }
  return unconditional;
}

export function shellVarReads(command: string): ShellVarReads {
  let file: ShNode;
  try {
    file = sh.syntax.NewParser().Parse(command, "hook.sh");
  } catch {
    return { reads: scanRefs(command), parsed: false };
  }
  const unconditional = persistingAssigns(file);
  const assignedAt = new Map<string, number>();
  const reads: string[] = [];
  const seen = new Set<string>();
  sh.syntax.Walk(file, (node) => {
    if (!node) return true;
    const kind = sh.syntax.NodeType(node);
    const at = offsetOf(node);
    if (kind === "Assign") {
      const name = node.Name?.Value;
      // The FIRST unconditional assignment is the only one that can dominate
      // a read; a later one cannot reach backwards. What is stored is where the
      // binding TAKES EFFECT (the assignment's end), not where it is written —
      // see {@link endOfOrNull}.
      const effective = at === null ? undefined : unconditional.get(at);
      if (name !== undefined && name !== "" && effective !== undefined)
        if (!assignedAt.has(name)) assignedAt.set(name, effective);
    } else if (kind === "ParamExp") {
      const name = node.Param?.Value;
      if (name !== undefined && VAR_NAME.test(name) && !seen.has(name)) {
        // 🔴 DOMINANCE, NOT MEMBERSHIP, AND CONTROL FLOW, NOT SOURCE ORDER.
        // Subtracting every assigned name globally excused `echo "$GUARD";
        // GUARD=hooks/g.sh` — where the expansion runs FIRST and really does
        // read the environment. Counting an earlier OFFSET as dominance excused
        // `false && MODE=safe; [ "$MODE" = safe ]`, which the shell also reads
        // from the environment. Both let a differently-configured program be
        // measured and scored, so an assignment excuses a read only when
        // {@link persistingAssigns} proved it runs, and runs first — where
        // "first" means it has FINISHED, because `MODE="$MODE"` expands its RHS
        // before it binds the name (see {@link endOfOrNull}).
        const assigned = assignedAt.get(name);
        // `at === null` means the binding withheld the position: excuse nothing.
        if (assigned === undefined || at === null || assigned > at) {
          seen.add(name);
          reads.push(name);
        }
      }
    }
    return true;
  });
  return { reads, parsed: true };
}
