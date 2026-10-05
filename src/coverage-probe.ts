/**
 * DERIVING which surface a run went by — the attribution half of the
 * `CHECK_COUNT` channel (see `check-count.ts`).
 *
 * ## What was broken
 *
 * "Is this skill tested?" was answered by a file name. Colocation says a file
 * named `foo.eval.mjs` sits in `foo/`; it says nothing about whether that file
 * ran, and an EMPTY one counts. Reproduce it in ten seconds: `touch
 * .claude/skills/foo/foo.eval.mjs` and watch the untested count drop by one.
 *
 * Every mature coverage tool answers from EXECUTION — `go test -cover`,
 * coverage.py, nyc, tarpaulin — and uses the name only to find the file to run.
 * We cannot run a skill without a model, so the name stays as a fallback; but
 * when a run DID happen, its own record must outrank the fallback.
 *
 * ## Why the machinery derives it instead of the author declaring it
 *
 * A `surface:` field on a spec would be the retired `vigiles:covers` marker with
 * extra steps: a claim about a test, written by whoever wrote the test, checked
 * by nobody. Every tier already knows what it was pointed at, so the attribution
 * is read back out of the run itself:
 *
 * | tier | what it goes by |
 * |---|---|
 * | `runScript` / `runHook` | the COMMAND LINE — it names a program file |
 * | `runHarnessTest` / eval / trigger-rate | the TRANSCRIPT — what actually fired |
 *
 * 🔴 THE TRANSCRIPT, NOT THE INSTALL SET, and this is the load-bearing choice.
 * A trigger-rate run installs many skills so the one under test competes for
 * selection; crediting all of them would credit a skill for LOSING. What fired
 * is one skill, and that is the one the run measured.
 *
 * Both halves are pure and exported so they are testable without a process: the
 * recording wrappers are one line each on top.
 *
 * ## Why this file PARSES at all — asked properly 2026-08-12, after five rounds
 *
 * This module has produced findings in five separate review rounds, every one the
 * same shape: it infers what executed by parsing an arbitrary command string, and
 * a string's grammar is unbounded. The obvious question is whether the EXECUTOR
 * could just report the path instead. Measured, not assumed:
 *
 *  - **The subprocess tier structurally cannot.** `runHook`/`runScript` take a
 *    COMMAND STRING and hand it to `spawnSync(cmd, { shell: true })`. vigiles
 *    never resolves a path — `sh -c` does — so there is nothing to report back.
 *    And the corpus confirms there is often no path to report at all: this repo's
 *    own examples pass inline program TEXT
 *    (`CMD=$(cat | jq -r …); case "$CMD" in …`, `node -e '<source>'`), where no
 *    file is named by anyone. That API contract is the feature — it is how you
 *    test a hook you did not write, verbatim as its plugin ships it.
 *
 *  - **The in-process tier CAN — and since 2026-08-13 it DOES.** ⚠️ This bullet
 *    used to read *"`harness-assert.ts` / `load-hook.ts` contain ZERO
 *    `recordSurfaceProbe` calls — the tier where attribution needs no parsing at
 *    all is the tier that attributes nothing"*, and that is no longer true:
 *    `runCountedHookProgram` in harness-assert.ts records a `command` probe for a
 *    hook it is about to evaluate, when `loadHook` knew the file. Verified by
 *    count, not by memory — `harness-assert.ts` has the call, `load-hook.ts`
 *    still does not, and deliberately so (loading a hook is not running it; see
 *    that function's note). Left corrected rather than deleted because a header
 *    that advertises a gap somebody already closed sends the next reader to build
 *    a second recorder.
 *
 *    It did not retire this parser, as predicted: it ADDS a source, and
 *    `runHook(command)` is still public.
 *
 * So parsing stays, and the lesson taken instead is about DIRECTION. The scan was
 * a deny-list — skip what we recognise, attribute what is left — so every gap in
 * every table produced a FALSE GRANT: a claim that a surface was tested when
 * nothing ran it. Where the grammar cannot be closed, the rule is now inverted:
 * attribute only what is positively recognised, and abstain otherwise
 * ({@link classifyCluster}, {@link runProgramRef}). A missed probe costs one
 * coverage line; a false grant costs the one thing this whole tier exists to
 * protect.
 */
import { recordSurfaceProbe, type SurfaceProbe } from "./check-count.js";
import { leafArgvSource } from "./core/bash-effects.js";

/**
 * A whole word that spells a program file. Same extension set as the hook-script
 * scanner in `test-coverage.ts` (which reads settings.json the same way) — kept
 * as its own copy because this module must not pull in the disk detector.
 *
 * ANCHORED, unlike that scanner's: this one is asked about a word the parser
 * already isolated, so a substring match would be a second guess on top of a
 * decided question. `sh -c 'bash hooks/x.sh'` therefore attributes NOTHING — the
 * inner script is inside a string the shell grammar does not open, and reaching
 * into it is the very substring habit that produced the bug below.
 */
const SCRIPT_RE = /^[\w./${}@:\\-]+\.(?:sh|mjs|cjs|js|mts|cts|ts|py|rb)$/;

/**
 * Which option grammar a head speaks. Not decoration: the same spelling means
 * different things in different families (see {@link OPTION_GRAMMAR}), so the
 * family has to be decided before any option word can be read.
 */
type InterpreterFamily = "shell" | "node" | "python" | "ruby" | "perl";

/**
 * Heads that EXECUTE a script named in their operands, each mapped to the option
 * grammar it speaks. Everything else — `cat`, `cp`, `grep`, `shasum` — takes the
 * same word as DATA and never reaches this table.
 */
const INTERPRETER_FAMILY: Readonly<Record<string, InterpreterFamily>> = {
  bash: "shell",
  sh: "shell",
  dash: "shell",
  zsh: "shell",
  ksh: "shell",
  node: "node",
  nodejs: "node",
  deno: "node",
  bun: "node",
  tsx: "node",
  "ts-node": "node",
  python: "python",
  python3: "python",
  ruby: "ruby",
  perl: "perl",
};

/** One family's option grammar. */
interface OptionGrammar {
  /**
   * Options that CONSUME THE NEXT WORD, so that word is an option value and not
   * the entry script.
   */
  readonly withValue: ReadonlySet<string>;
  /**
   * Options after which THERE IS NO SCRIPT OPERAND at all: the program is given
   * as source text or as a module name, or the file is parsed and never run.
   */
  readonly withoutScript: ReadonlySet<string>;
}

/**
 * The option grammar, PER INTERPRETER FAMILY.
 *
 * 🔴 "THE FIRST NON-FLAG OPERAND" IS NOT THE SCRIPT WHEN AN OPTION ATE IT, and
 * the version before the tables assumed it was. `node --loader tsx
 * hooks/pre-edit.ts` selected `tsx`, which fails {@link SCRIPT_RE}, so the hook
 * that DID run was recorded as nothing at all; `node --require setup.js app.js`
 * selected the PRELOAD and stopped, so `app.js` — the file whose execution the
 * coverage claim is about — never appeared. Both are silent: a passing test
 * simply earns no execution coverage, which reads exactly like a test that
 * exercised nothing.
 *
 * 🔴 AND ONE SHARED TABLE COULD NOT EXPRESS THEM, which the first version of it
 * claimed it could ("where these tools' spellings overlap they agree"). They do
 * not. Measured 2026-08-12 with the real binaries:
 *
 *   python3 -I /tmp/probe.py   → runs the script, exit 0   (`-I` = isolated mode,
 *                                                           consumes NOTHING)
 *   ruby -I /tmp -e '…'        → runs, exit 0              (`-I` = load path,
 *                                                           consumes a DIRECTORY)
 *
 * With `-I` in one shared value table, `python3 -I hooks/x.py` fed the hook path
 * to `-I`, found no operand left, and attributed nothing — the same silent loss
 * the table was written to stop, reintroduced by the table itself. `-E` is the
 * second disagreement in the same direction: python's ignores the environment and
 * consumes nothing, ruby's sets an encoding and consumes a value, and perl's
 * carries the PROGRAM (so there is no script operand at all).
 *
 * `--opt=value` needs no entry anywhere — it is one word starting with `-`,
 * already skipped as a flag. Only the space-separated spelling reaches a table.
 *
 * Ambiguity is still bounded in the SAFE direction: mis-skipping a word can only
 * move the selection off the script and onto nothing (silence), because the first
 * operand that still fails {@link SCRIPT_RE} ends the search.
 *
 * Deliberately NOT here: `ruby -S prog`. Its operand is a program looked up on
 * PATH, so consuming it would let the NEXT operand — `rake`'s own argument, i.e.
 * data — be selected as the executed script. That is the round-before's defect
 * (activity taken for the property) and the one direction these tables must not
 * open. Left out, `ruby -S rake x.rb` selects `rake`, fails `SCRIPT_RE`, and
 * attributes nothing.
 *
 * `-m` (python) runs a MODULE, so `python -m pytest hooks/x.py` runs pytest and
 * the hook is pytest's ARGUMENT; `-c`/`--check` (node) and `-c` (ruby, perl)
 * PARSE the file and never run it. Both land in `withoutScript`, so a command
 * line that only syntax-checks a hook no longer claims to have executed it.
 *
 * ⚠️ `-p`/`-n` are the disagreement the split RESOLVES rather than documents. In
 * node `-p` prints an evaluated expression and there is no script operand; in
 * ruby and perl it wraps the script in a read-print loop and the operand IS
 * executed. The shared table had to pick one and picked node's, so `ruby -p x.rb`
 * attributed nothing. Now each family answers for itself.
 */
const OPTION_GRAMMAR: Readonly<Record<InterpreterFamily, OptionGrammar>> = {
  // 🔴 HOW THIS ONE WAS DECIDED COMPLETE, because a table that quietly misses an
  // entry is what the round before this had to fix twice. `bash --help` (5.2.21)
  // prints the whole invocation grammar in four lines, and every value-taker in
  // it is here:
  //
  //     -ilrsD or -c command or -O shopt_option      (invocation only)
  //     -abefhkmnptuvxBCEHPT or -o option
  //     GNU long options: --debug --debugger --dump-po-strings --dump-strings
  //       --help --init-file --login --noediting --noprofile --norc --posix
  //       --pretty-print --rcfile --restricted --verbose --version
  //
  // Value-takers: `-c` (the program itself), `-O`/`+O` (a shopt name), `-o`/`+o`
  // (a set-option name), `--rcfile`/`--init-file` (a path). Everything else in
  // those lines is a standalone flag the generic `-` skip already handles. `-O`
  // was the miss: `bash -O extglob hooks/pre-edit.sh` selected `extglob`, which
  // fails SCRIPT_RE, so the hook that DID run was attributed to nothing.
  //
  // The other shells are a SUBSET on this axis — dash/ksh/zsh have `-c` and
  // `-o`/`+o` and no `-O` — so bash's grammar covers the family. (zsh's
  // `--emulate <shell>` is the one known non-subset; left out rather than
  // guessed at, and a miss there costs silence, not a false grant.)
  //
  // ⚠️ The five in `withoutScript` beyond `-c` PARSE the operand and never run
  // it — verified against bash 5.2.21, none of them printed the script's output.
  // Same rule as node's `--check`, and the direction that matters: without them a
  // command line that only syntax-checks a hook would claim to have executed it.
  //
  // ⚠️ KNOWN LIMIT, stated rather than papered over: matching is on WHOLE WORDS,
  // so a bundled short form (`bash -en x.sh`) falls through to the generic flag
  // skip and `x.sh` is attributed. That is a false grant, and it is pre-existing
  // for every family here — not introduced by this entry.
  shell: {
    withValue: new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]),
    withoutScript: new Set([
      "-c",
      "--command",
      "-n",
      "-D",
      "--dump-strings",
      "--dump-po-strings",
      "--pretty-print",
    ]),
  },
  node: {
    withValue: new Set([
      "-r",
      "--require",
      "--loader",
      "--experimental-loader",
      "--import",
      "-C",
      "--conditions",
      "--env-file",
      "--input-type",
      "--watch-path",
      "--title",
      "--test-name-pattern",
      "--test-reporter",
      "--test-shard",
      "--report-dir",
      "--report-filename",
    ]),
    withoutScript: new Set(["-e", "--eval", "-p", "--print", "-c", "--check"]),
  },
  python: {
    // `-I` (isolated), `-E` (ignore env), `-B`, `-s`, `-S`, `-u`, `-v`, `-O` all
    // consume NOTHING; they are ordinary flags and the generic `-` skip handles
    // them. Listing them as value-takers is what ate the hook path.
    withValue: new Set(["-W", "-X", "-Q", "--check-hash-based-pycs"]),
    withoutScript: new Set(["-c", "-m"]),
  },
  ruby: {
    withValue: new Set([
      "-I",
      "-E",
      "-F",
      "-C",
      "-r",
      "--require",
      "--encoding",
      "--enable",
      "--disable",
    ]),
    withoutScript: new Set(["-e", "-c"]),
  },
  perl: {
    // perl's `-E` is `-e` with features on: it carries the PROGRAM, so there is
    // no script operand — the opposite conclusion from ruby's `-E`.
    withValue: new Set(["-I"]),
    withoutScript: new Set(["-e", "-E", "-c"]),
  },
};

/**
 * Heads whose file operand sits behind a `run` SUBCOMMAND, so the verb — not the
 * script — is the first non-flag word.
 *
 * 🔴 `bun run hooks/pre-edit.ts` selected `run`, which fails {@link SCRIPT_RE},
 * so a hook that DID execute attributed nothing. Bun and Deno are package-manager
 * -shaped CLIs sharing the node family's OPTION grammar while having a verb
 * grammar node does not.
 *
 * HOW THIS LIST WAS DECIDED: every head in {@link INTERPRETER_FAMILY} was checked
 * for a subcommand form. The five shells, `python`/`python3`, `ruby`, `perl`,
 * `tsx` and `ts-node` have none. `node` has none either — its `--run` is a FLAG
 * and runs a package.json script, not a file, so it correctly attributes nothing.
 * That leaves `bun` and `deno`, and only these two are here.
 *
 * ⚠️ ONLY `run`, deliberately. Both CLIs carry more verbs (`deno test`,
 * `deno serve`, `deno bench`, `bun test`, `bun build`, `deno check`,
 * `deno cache`), and modelling them faithfully means deciding per verb whether
 * the operand is EXECUTED — `deno check` and `deno cache` read a file without
 * running it, so crediting them would be a false grant. Unmodelled, every one of
 * those verbs fails `SCRIPT_RE` and attributes NOTHING: the cost is silence, and
 * silence is the direction this module errs in. A miss here loses a warning; a
 * guess could mint coverage for a file nobody ran.
 */
const RUN_SUBCOMMAND_HEADS: ReadonlySet<string> = new Set(["bun", "deno"]);

/**
 * The entry script an interpreter's argv names, or `undefined` when this command
 * line executes no file operand. `argv` is the WHOLE leaf, head included.
 *
 * Still "the first non-flag operand", only now the option grammar OF THIS HEAD'S
 * FAMILY is read first, so an option's VALUE cannot be mistaken for it and a
 * neighbouring language's spelling cannot eat it. Everything after the entry
 * stays data (`node lint.mjs hooks/x.sh` attributes `lint.mjs` alone), which is
 * the property the round before this one bought.
 */
function entryScript(
  argv: readonly string[],
  family: InterpreterFamily,
): string | undefined {
  const grammar = OPTION_GRAMMAR[family];
  // A single leading `run` verb, for the two heads that have one. Consumed
  // before the operand scan, and only in first position: `bun x.mjs run` still
  // attributes `x.mjs`, because there `run` is the script's own argument.
  const start =
    RUN_SUBCOMMAND_HEADS.has(headName(argv[0] ?? "")) && argv[1] === "run"
      ? 2
      : 1;
  for (let i = start; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (grammar.withoutScript.has(word)) return undefined;
    if (grammar.withValue.has(word)) {
      i++; // its value is not the script
      continue;
    }
    const verdict = clusterVerdict(word, family);
    if (verdict === "none") return undefined;
    if (verdict === "value") {
      i++; // the cluster's last letter took the next word
      continue;
    }
    if (word.startsWith("-")) continue;
    return word;
  }
  return undefined;
}

/**
 * The letters of a BUNDLED short-option token (`-en` → `"en"`), or `undefined`
 * when the word is not one: a long `--option`, a single `-e`, a bare `-`, or an
 * operand. Single letters are excluded because they are already answered by the
 * per-family whole-word tables above; this is only about the bundle.
 */
function shortCluster(word: string): string | undefined {
  if (!word.startsWith("-") || word.startsWith("--")) return undefined;
  const letters = word.slice(1);
  return letters.length >= 2 && /^[A-Za-z]+$/.test(letters)
    ? letters
    : undefined;
}

/**
 * What `word` does to attribution when it is a bundled cluster — `"skip"` when it
 * is not one at all, so the caller's flow stays flat.
 */
function clusterVerdict(
  word: string,
  family: InterpreterFamily,
): "run" | "value" | "none" | "skip" {
  const letters = shortCluster(word);
  return letters === undefined ? "skip" : classifyCluster(letters, family);
}

/**
 * Every letter a bundled shell cluster may carry, from `bash --help` (5.2.21) —
 * the SAME four lines the option tables above were derived from, so the universe
 * is closed and re-derivable:
 *
 *     -ilrsD or -c command or -O shopt_option      (invocation only)
 *     -abefhkmnptuvxBCEHPT or -o option
 *
 * `n`, `D` and `c` leave NO executed file operand; `o` and `O` take a value; the
 * rest consume nothing and execute normally.
 *
 * 🔴 `c` BELONGS WITH `n` AND `D`, NOT WITH THE VALUE-TAKERS, even though it is
 * the one that actually runs something. It was listed as a value-taker, which is
 * true of the word right after it and false of everything past that: under `-c`
 * the shell runs the STRING, and the operands that follow become `$0`, `$1` …
 * Skipping only the string therefore walked on and selected the next operand as
 * the entry script. Measured 2026-08-12 against bash 5.2.21, with a hook whose
 * only job is to leave a marker file:
 *
 *     $ bash -ce 'exit 0' hooks/pre.sh   →  exit=0, NO MARKER — never executed
 *     $ bash -e hooks/pre.sh             →  exit=0, marker present  (control)
 *     $ bash -ce 'echo "0=$0 1=$1"' A B  →  0=A 1=B  — operands are $0, $1
 *
 * and `commandRefs("bash -ce 'exit 0' hooks/pre.sh")` returned `["hooks/pre.sh"]`
 * — a false GRANT, execution coverage for a hook that did not run. Position in
 * the cluster is irrelevant (`-ce`, `-ec`, `-xc` all behave the same), so any
 * cluster CONTAINING `c` yields the no-script verdict.
 */
const SHELL_CLUSTER = {
  noScript: "nDc",
  value: "oO",
  safe: "ilrsabefhkmptuvxBCEHPT",
} as const;

/**
 * What a bundled cluster does to attribution.
 *
 * 🔴 THE DIRECTION IS INVERTED HERE, AND THAT IS THE POINT. Everywhere else this
 * function SKIPS what it recognises and attributes whatever is left — a
 * deny-list, where a gap means an unrecognised word is taken for the executed
 * script. That is how `bash -en hooks/pre.sh` recorded coverage for a hook bash
 * only syntax-checked: `-en` is not a whole word in any table, so the generic
 * `-` skip walked past it and the path became the "entry". A FALSE GRANT — a
 * claim that something was tested when nothing ran it.
 *
 * A cluster is therefore attributed only when EVERY letter is accounted for.
 * Unknown letter ⇒ `"none"` ⇒ no attribution, because an unknown option might
 * suppress execution (`n`), and guessing costs a false claim while abstaining
 * costs one coverage line. That asymmetry is the whole argument.
 *
 * ⚠️ ONLY SHELLS ARE MODELLED. bash publishes its complete invocation letter set
 * in four lines of `--help`; node, python, ruby and perl do not, and inventing
 * one from memory is what this module keeps being punished for. So a bundle
 * under any other family is `"none"` — `python3 -EsI x.py` now attributes
 * nothing where it used to attribute `x.py`. That is a deliberate loss of one
 * warning in exchange for closing a class of false grant, and it is the only
 * direction this module is allowed to err in.
 */
function classifyCluster(
  letters: string,
  family: InterpreterFamily,
): "run" | "value" | "none" {
  if (family !== "shell") return "none";
  let takesValue = false;
  for (const ch of letters) {
    if (SHELL_CLUSTER.noScript.includes(ch)) return "none";
    if (SHELL_CLUSTER.value.includes(ch)) takesValue = true;
    else if (!SHELL_CLUSTER.safe.includes(ch)) return "none"; // unknown ⇒ abstain
  }
  return takesValue ? "value" : "run";
}

/**
 * Our own runtime's invocation (`<vigiles> hook-runtime run-program <hook>`): the
 * word after it is a program vigiles is about to execute. Listed because it is
 * OUR contract, not a guess about someone's CLI — `hook-install` emits exactly
 * this line, and it is how every compiled hook in this repo is exercised.
 */
const RUNTIME_VERB = "hook-runtime";
const RUN_PROGRAM_VERB = "run-program";

/** `vigiles`, `./node_modules/.bin/vigiles`, `vigiles@15.0.2` — however spelled. */
function isVigilesProgram(token: string): boolean {
  const base = headName(token);
  const at = base.indexOf("@", 1);
  return (at === -1 ? base : base.slice(0, at)) === "vigiles";
}

/**
 * The hook path OUR OWN runtime was pointed at, or `undefined`.
 *
 * 🔴 THE VERB USED TO BE SEARCHED ANYWHERE IN THE ARGV, which made it a free
 * -floating keyword rather than a command shape: `echo run-program hooks/pre.sh`
 * recorded execution coverage for a hook that `echo` merely printed. Same
 * substitution the rest of this module exists to remove — a WORD taken for the
 * position it usually occupies — reached through the one runner we own.
 *
 * So the shape is required, positively: `hook-runtime` immediately followed by
 * `run-program`, and the token BEFORE `hook-runtime` must be the program that is
 * actually running — either `vigiles` itself (`npx vigiles hook-runtime …`,
 * `vigiles hook-runtime …`) or the entry script this command line already
 * resolved (`node dist/cli.js hook-runtime …`). Anything else is a command that
 * merely contains our words.
 */
function runProgramRef(
  argv: readonly string[],
  entry: string | undefined,
): string | undefined {
  const i = argv.indexOf(RUNTIME_VERB);
  if (i < 1 || argv[i + 1] !== RUN_PROGRAM_VERB) return undefined;
  const owner = argv[i - 1] ?? "";
  // The `entry` arm needs no position check: `entry` is by construction the
  // program this leaf runs (the head when it is a script, else the one the
  // interpreter's grammar names), so `owner === entry` IS the position.
  const ours =
    (isVigilesProgram(owner) && isExecutablePosition(argv, i - 1)) ||
    (owner === entry && entry !== undefined);
  if (!ours) return undefined;
  const file = argv[i + 2] ?? "";
  return SCRIPT_RE.test(file) ? file : undefined;
}

/**
 * The one launcher spelling that puts a program in the executable position
 * without being the head itself.
 *
 * 🔴 THE OWNER USED TO BE ACCEPTED ANYWHERE, one token over from the verb this
 * function already fixed: `echo vigiles hook-runtime run-program hooks/pre.sh`
 * has `vigiles` as `argv[i - 1]`, so the hook `echo` merely PRINTED got an
 * execution record. A word in the argv is not the program being run — the same
 * substitution, reached through the owner instead of the verb.
 *
 * ⚠️ THIS IS A LAUNCHER TABLE, AND ONE WAS DELETED FROM THIS REPO ON PURPOSE
 * (`RUNNER_PREFIXES`, when the hook-recovery escape went). It is safe here and
 * was a liability there because the two tables decide different things. There it
 * decided whether to EXECUTE an attacker-chosen string, so a wrong or missing
 * entry granted arbitrary execution. Here it decides whether to CREDIT a coverage
 * line for a command the harness author wrote about their own hook: a missing
 * entry costs one coverage line, and there is no adversary picking spellings,
 * because the only thing to win is over-crediting yourself.
 *
 * It is also one token, chosen by MEASUREMENT rather than by imagination. Every
 * spelling of this invocation across the docs, examples, README, src and two
 * repos' `.claude/` dirs:
 *
 *   13×  npx vigiles hook-runtime …                          → launcher, index 1
 *   11×  vigiles hook-runtime …                              → head, index 0
 *   10×  "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime …
 *    9×  node /abs/dist/cli.js hook-runtime …                → the `entry` arm
 *    1×  ./node_modules/.bin/vigiles hook-runtime …          → head, index 0
 *
 * DELIBERATELY MISSED, run rather than asserted — no corpus contains them, and
 * each costs one coverage line:
 *
 *   commandRefs("pnpm dlx vigiles hook-runtime run-program hooks/a.sh") → []
 *   commandRefs("bunx vigiles hook-runtime run-program hooks/a.sh")     → []
 */
const LAUNCHERS = new Set(["npx"]);

/** Is `at` a position from which a program actually runs? */
function isExecutablePosition(argv: readonly string[], at: number): boolean {
  if (at === 0) return true;
  return at === 1 && LAUNCHERS.has(headName(argv[0] ?? ""));
}

/** The basename of a head, so `/bin/bash` and `bash` classify alike. */
function headName(word: string): string {
  const unescaped = word.startsWith("\\") ? word.slice(1) : word;
  const slash = unescaped.lastIndexOf("/");
  return slash >= 0 ? unescaped.slice(slash + 1) : unescaped;
}

/**
 * The program file this leaf's INTERPRETER head executes, or `undefined`.
 *
 * A head that is an interpreter brings its own option grammar with it — `-I`
 * consumes a path for ruby and nothing for python — so the family is resolved
 * first and the entry script is the first operand THAT grammar has not already
 * claimed ({@link entryScript}). Everything after it is the script's own argv,
 * where a path is data again (`node lint.mjs hooks/x.sh`).
 */
function interpretedScript(argv: readonly string[]): string | undefined {
  const family = INTERPRETER_FAMILY[headName(argv[0] ?? "")];
  if (family === undefined) return undefined;
  const script = entryScript(argv, family);
  return script !== undefined && SCRIPT_RE.test(script) ? script : undefined;
}

/**
 * The program files a command line EXECUTES.
 *
 * 🔴 THE WORD IS NOT THE POSITION, and this used to be a scan for script-looking
 * TOKENS anywhere in the command (and anywhere in the env). Which means a
 * passing harness that runs `cat hooks/pre-edit.sh`, `cp hooks/pre-edit.sh …` or
 * `grep -n foo hooks/pre-edit.sh` minted an execution-tier coverage record for a
 * hook that never ran — the same substitution this whole tier exists to remove,
 * activity taken for the property, only now manufactured by the attribution half
 * instead of the recording half. So the command is PARSED (`leafArgvSource`,
 * mvdan-sh) and only these positions count:
 *
 *  - the leaf HEAD, when it is itself a script (`./hooks/x.sh`, `/abs/x.mjs`);
 *  - the first non-flag operand of an {@link INTERPRETERS} head (`bash x.sh`);
 *  - the word after our own {@link RUN_PROGRAM_VERB}.
 *
 * AST-backed, so a leaf nested behind `&&`, a pipeline or a subshell is still
 * found and `cd /repo && bash hooks/x.sh` attributes the hook — which the old
 * token scan also did, but for the wrong reason.
 *
 * The env is still consulted, because the documented `runHook` idiom passes the
 * path through one: `runHook('"$GUARD"', event, { env: { GUARD: guardPath } })`.
 * It is now an EXPANSION, not a scan: `$GUARD` is substituted into the word that
 * references it and then classified by position, so an env entry the command
 * never mentions (a fixture path, a temp dir) attributes nothing.
 *
 * Deliberately not resolved to absolute paths here: the process's cwd is the
 * test's, not the repo's, and inventing a root would manufacture a match. The
 * runner resolves refs against real discovered surfaces or drops them.
 */
export function commandRefs(
  command: string,
  env?: Record<string, string>,
): string[] {
  // Expansion of a variable INTO a word — a string-value substitution, after the
  // grammar has already decided where the word boundaries are. Names not in
  // `env` are left as written, because `$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh`
  // still resolves by suffix against a real surface.
  const expand = (word: string): string =>
    env === undefined
      ? word
      : word.replace(
          /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
          (whole, braced?: string, bare?: string) =>
            env[braced ?? bare ?? ""] ?? whole,
        );
  const out = new Set<string>();
  for (const leaf of leafArgvSource(command)) {
    const argv = leaf.map(expand);
    const head = argv[0] ?? "";
    // The program this leaf runs: the head when it IS a script, else whatever the
    // interpreter's own grammar names. Held, because our runtime's invocation is
    // recognised RELATIVE to it (`node dist/cli.js hook-runtime run-program …`).
    let entry: string | undefined;
    if (SCRIPT_RE.test(head)) entry = head;
    else entry = interpretedScript(argv);
    if (entry !== undefined) out.add(entry);
    const hook = runProgramRef(argv, entry);
    if (hook !== undefined) out.add(hook);
  }
  return [...out];
}

/**
 * The files our OWN runtime invocations in a command line need on disk: the
 * hook each `hook-runtime run-program` is pointed at, and the runtime entry
 * script when it is launched by path (`node "$DIR/node_modules/vigiles/dist/cli.js"
 * hook-runtime run-program …`).
 *
 * Narrower than {@link commandRefs} on purpose — that one lists every program a
 * command executes, this one only what a COMPILED HOOK's wiring depends on, which
 * is what the SessionStart check names. `bash scripts/build.sh` is a program the
 * command runs and not a compiled hook; a check that reported it missing in a
 * fresh clone would be crying wolf about something `npm install` does not fix.
 *
 * Same shape test as `commandRefs`: the verb must sit in the position of the
 * program that is running, so `echo vigiles hook-runtime run-program x.mjs`
 * names nothing.
 */
export function runProgramFiles(command: string): string[] {
  const out = new Set<string>();
  for (const argv of leafArgvSource(command)) {
    const head = argv[0] ?? "";
    const entry = SCRIPT_RE.test(head) ? head : interpretedScript(argv);
    const hook = runProgramRef(argv, entry);
    if (hook === undefined) continue;
    if (entry !== undefined) out.add(entry);
    out.add(hook);
  }
  return [...out];
}

/**
 * The tools that DISPATCH a subagent. Both spellings, because the live CLI names
 * it `Agent` and older docs name it `Task` — the same pair `parseSubagents`
 * documents from real `claude` output.
 */
const DISPATCH_TOOLS = new Set(["Task", "Agent"]);

/** The transcript shape this module reads — structural, so it imports no tier. */
export interface ProbeableTrace {
  readonly toolCalls: readonly {
    readonly name: string;
    readonly input?: unknown;
    readonly isError?: boolean;
  }[];
  readonly hooks?: readonly { readonly name: string }[];
}

/**
 * The surfaces a run's transcript shows ACTIVATING — resolved `Skill` calls and
 * reporting hooks.
 *
 * An errored `Skill` call is excluded, matching `skillResolved`/`whichSkillsFired`:
 * the tool was reached and the skill was not. Counting it would make "the skill
 * is broken" indistinguishable from "the skill ran".
 */
export function traceRefs(trace: ProbeableTrace): SurfaceProbe[] {
  const out: SurfaceProbe[] = [];
  const seen = new Set<string>();
  const push = (how: SurfaceProbe["how"], ref: string): void => {
    const trimmed = ref.trim();
    const key = `${how}\u0000${trimmed}`;
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    out.push({ how, ref: trimmed });
  };
  for (const call of trace.toolCalls) {
    if (call.isError === true) continue;
    const input = call.input as
      | { skill?: unknown; subagent_type?: unknown }
      | undefined;
    if (call.name === "Skill" && typeof input?.skill === "string") {
      push("fired", input.skill);
      continue;
    }
    // 🔴 AN AGENT COULD NEVER EARN AN EXECUTION RECORD, and this was predicted
    // in the round that made `fired` skills-only: nothing probed agents, so
    // `untested-subagent` reported a genuinely exercised agent as untested. A
    // FALSE NEGATIVE, so this round ADDS attribution — and the bar has to be the
    // strict one, or it becomes the false grants the other rungs were about.
    //
    // The evidence is a DISPATCH: a `tool_use` whose input carries a
    // `subagent_type`. Keyed on the INPUT FIELD, not the tool name, because the
    // dispatch tool is named `Agent` on the live CLI and `Task` in older docs —
    // `parseSubagents` in harness-test.ts already keys on the field for exactly
    // that reason, confirmed against real `claude` output, and this reuses that
    // established fact rather than inventing a second rule.
    //
    // 🔴 …AND THE TOOL NAME, which the first version left out. It keyed on the
    // FIELD ALONE, reasoning that the tool name is unreliable (`Agent` live,
    // `Task` in older docs) — sound about why the NAME is insufficient, and no
    // argument that the FIELD is sufficient. "X alone is unreliable, so use Y
    // alone" is a substitution. Any successful tool with an ordinary string
    // input happening to be called `subagent_type` — an MCP tool, say — then
    // granted execution coverage to a local agent of that name, with no dispatch
    // anywhere in the run. The answer is the CONJUNCTION.
    //
    // What it does NOT accept: a call merely NAMED `Task`/`Agent` with no
    // `subagent_type` (nothing was dispatched), a `subagent_type` on any OTHER
    // tool (nothing was dispatched either), and an errored dispatch (the tool
    // was reached and the agent was not — the same rule the `Skill` arm above
    // has always had).
    if (
      DISPATCH_TOOLS.has(call.name) &&
      typeof input?.subagent_type === "string"
    )
      push("dispatched", input.subagent_type);
  }
  // 🔴 HOOK FIRES ARE NOT RECORDED, and the comment that used to sit here was
  // wrong about why they were: *"Claude Code reports an `Event:Matcher` LABEL
  // (`PreToolUse:Edit`), which resolves to no surface and is dropped by the
  // runner — recording it costs nothing."* The first half is right and the second
  // is false. `resolveProbe` stripped the prefix and searched EVERY surface kind,
  // so the label credited a same-named skill or agent.
  //
  // MEASURED 2026-08-12 — every `fired` probe produced by `vigiles test` on this
  // repo AND on a 43-harness consumer repo, with no model spent. All fourteen are
  // hook labels; not one is a skill activation:
  //
  //   8×  SessionStart:startup     →  strips to `startup`
  //   2×  PostToolUse:Write        →  strips to `Write`
  //   2×  PreToolUse:Write         →  strips to `Write`
  //   2×  UserPromptSubmit         →  no colon, so the WHOLE label is the name
  //
  // Neither corpus owns a surface by those names, so nothing was miscredited
  // today. Add ONE skill named `startup` to this repo — a name nobody would think
  // twice about — and the counterfactual, run against the real corpus:
  //
  //   SessionStart:startup → ["skill skills/startup/SKILL.md"]
  //
  // eight times per `vigiles test`.
  //
  // A label cannot identify a hook FILE either, so this is not fixed by resolving
  // within the kind. `hook_name` is `Event:Matcher` — an event and a tool-name
  // pattern — while a hook surface is a script path. A repo with `hooks/Stop.sh`
  // plus `hooks/cleanup.sh` both registered for `Stop` would have the `Stop`
  // label match exactly one of them, and there is no reason it is the one that
  // ran. The evidence is about an EVENT; the surfaces are FILES.
  //
  // The one thing this stream could carry that WOULD be evidence is a script
  // path, and there is no harness that reports one: the sole producer is
  // `parseHooks` reading Claude Code's `hook_response`, and Codex/OpenCode return
  // `hooks: []`. If one ever does, the ref belongs on the `command` origin, which
  // already resolves paths within hooks.
  //
  // `ProbeableTrace.hooks` stays on the shape, unread, ON PURPOSE: it is what
  // lets the negative be tested (`traceRefs` handed real labels and returning
  // []). Deleting the field would delete the lock that keeps the loop from
  // coming back.
  return out;
}

/** Record what a command line named. One line, so every tier can afford it. */
export function probeCommand(
  command: string,
  env?: Record<string, string>,
): void {
  for (const ref of commandRefs(command, env)) {
    recordSurfaceProbe("command", ref);
  }
}

/** Record what a run's transcript shows firing. */
export function probeTrace(trace: ProbeableTrace): void {
  for (const probe of traceRefs(trace)) {
    recordSurfaceProbe(probe.how, probe.ref);
  }
}
