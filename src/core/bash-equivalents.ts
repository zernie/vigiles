/**
 * Shell-EQUIVALENT rewrites of a dangerous command — the generator behind the
 * metamorphic disaster battery.
 *
 * WHY THIS EXISTS. `DISASTER_CATALOG` is seven commands a human labelled
 * dangerous, written one way each. Measured 2026-09-02: the compiled guard behind
 * the published "2/7 → 7/7" headline blocked all seven seeds and only 8 of 30
 * shell-equivalent rewrites of them — `git push "--force" origin main` (a quoted
 * flag), `sudo git push --force`, `/usr/bin/git push --force`. The number was
 * true and it was measured on the only forms anyone had written down.
 *
 * WHY A GENERATOR AND NOT MORE HAND-WRITTEN ROWS. Adding rows by hand closes the
 * forms you thought of, which is the same bounded set that produced the gap. The
 * escape space is not enumerable by memory.
 *
 * WHY THIS NEEDS NO ORACLE — the part that makes it sound rather than clever.
 * Generating a NEW dangerous command would need a human to label it. This
 * generates only REWRITES of an already-labelled one, so:
 *
 *   dangerous  ← inherited from the seed a human labelled
 *   same thing ← decided by `leafCommandsNormalized`, our own normalizer
 *
 * Neither half is a new judgement. This is metamorphic testing (Chen et al.,
 * 1998): with no oracle for a fresh input, assert instead that a
 * semantics-preserving transform does not change the verdict.
 *
 * WHERE IT STOPS, and why the boundary is not a policy choice. The transform
 * families are exactly the ones the normalizer collapses. `eval`, `sh -c`, a
 * `$VAR` head, base64 — the one-level normalizer does not collapse those, so a
 * variant built from them CANNOT pass the self-check and is never emitted. For
 * the dynamic ones that is the correct boundary: a guard built on `runs()`
 * genuinely cannot see through `eval "$(echo … | base64 -d)"` (the gate asks on
 * it, vigiles#460), so emitting it would call a correct guard broken — the
 * crying-wolf failure that gets a check switched off. A LITERAL `sh -c '…'` or
 * `eval '…'` is read by the gate since #460, so it would be a fair variant; it
 * is not emitted only because this self-check compares one level.
 */
import {
  flagAliases,
  leafCommandsNormalized,
  readShell,
  WRAPPER_HEADS,
  type NormalizedLeaf,
} from "./bash-effects.js";

/** The operation a leaf performs, ignoring how it was spelled. */
function operationKey(leaf: NormalizedLeaf): string {
  return JSON.stringify([
    leaf.head,
    withoutHereDir(leaf).filter((a) => a !== "" && !a.startsWith("-")),
    [...leaf.flags].sort(),
  ]);
}

/**
 * A git leaf's args without a `-C .` — git's option to run in the directory it
 * is already in. `git -C ../o push` is another repository and keeps its
 * operand, so it is never the same operation.
 */
function withoutHereDir(leaf: NormalizedLeaf): readonly string[] {
  if (leaf.head !== "git") return leaf.args;
  const a = leaf.args;
  return a.filter(
    (w, i) =>
      !((w === "-C" && a[i + 1] === ".") || (a[i - 1] === "-C" && w === ".")),
  );
}

/**
 * The leaves a compiled gate reads in `command`, and what it could not read.
 *
 * The SAME reader the gate uses (`readShell`): it descends into a literal
 * `bash -c '…'`, `sh -c '…'` and `eval '…'` (#483), and reports a handed-on
 * command it cannot read — `bash -c "$X"` — as hidden. So "same operation" is
 * exactly as strong as the gate's own reading: neither weaker (a string the gate
 * cannot read never proves anything) nor stronger.
 */
function gateReading(command: string): {
  readonly leaves: readonly NormalizedLeaf[];
  readonly hidden: readonly string[];
} {
  const r = readShell(command);
  return {
    leaves: r.effects.flatMap((e) => (e.kind === "leaf" ? [e.leaf] : [])),
    hidden: r.hidden.map((h) => h.reason),
  };
}

/**
 * Does `variant` perform every operation `seed` performs?
 *
 * Not string equality and not set equality: a wrapper adds a leaf (`sudo` itself),
 * so the test is CONTAINMENT — every dangerous leaf of the seed still appears.
 * Judged on the leaves the gate reads after descending into `bash -c`, `sh -c`
 * and `eval`; a variant that hides a command the seed did not hide (a dynamic
 * `bash -c "$X"`) is never the same operation.
 */
export function sameOperation(seed: string, variant: string): boolean {
  const a = gateReading(seed);
  const b = gateReading(variant);
  if (a.leaves.length === 0 || b.leaves.length === 0) return false;
  if (!b.hidden.every((why) => a.hidden.includes(why))) return false;
  const keys = new Set(b.leaves.map(operationKey));
  return a.leaves.every((leaf) => keys.has(operationKey(leaf)));
}

/**
 * Does `other` perform ANY operation `seed` performs? Stricter than
 * {@link sameOperation}, which asks for all of them: a harmless look-alike
 * (`bash-lookalikes.ts`) must run none of its seed, so one shared leaf of a
 * compound seed is enough to disqualify it.
 */
export function sharesOperation(seed: string, other: string): boolean {
  const keys = new Set(gateReading(seed).leaves.map(operationKey));
  return gateReading(other).leaves.some((leaf) => keys.has(operationKey(leaf)));
}

/** Wrappers that pass a command through unchanged, one representative form each. */
const WRAPPER_PREFIXES: readonly string[] = [...WRAPPER_HEADS]
  .filter((w) => w !== "xargs" && w !== "nohup")
  .map((w) =>
    w === "timeout" ? "timeout 30" : w === "nice" ? "nice -n 5" : w,
  );

/** One rewrite family: a name (for the failure message) and how it rewrites. */
interface Family {
  readonly name: string;
  readonly rewrite: (cmd: string) => readonly string[];
}

const FAMILIES: readonly Family[] = [
  {
    name: "quoted flag",
    // `getLiteral` returns null for a quoted word and `leafCommands` filters
    // nulls, so this is the family that made a flag VANISH from argv.
    // Only a flag some command receives: inside `[[ … ]]` a quoted `-d` is a
    // string, not the operator.
    rewrite: (c) => {
      const argv = new Set(leafCommandsNormalized(c).flatMap((l) => l.argv));
      return [...c.matchAll(/(?<=\s)(--?[A-Za-z][\w-]*)(?=\s|$)/g)]
        .filter((m) => argv.has(m[0]))
        .flatMap((m) => [
          spliceToken(c, m.index, m[0], `"${m[0]}"`),
          spliceToken(c, m.index, m[0], `'${m[0]}'`),
        ]);
    },
  },
  {
    name: "flag alias",
    // Scoped by program and subcommand (`FLAG_ALIASES` in bash-effects): `-n`
    // is `--no-verify` to `git commit` and `--dry-run` to `git push`. The gate
    // folds flags through the SAME table (#501), so the self-check below cannot
    // catch a wrong row: the manual cited beside it is the evidence.
    rewrite: (c) => scopedAliases(c),
  },
  {
    name: "absolute or escaped head",
    rewrite: (c) => {
      const { head, rest } = splitHead(c);
      if (!rewritableHead(c)) return [];
      return [
        `/usr/bin/${head}${rest}`,
        `/bin/${head}${rest}`,
        `\\${head}${rest}`,
      ];
    },
  },
  {
    name: "wrapper prefix",
    rewrite: (c) =>
      rewritableHead(c)
        ? WRAPPER_PREFIXES.map((w) => `${w} ${c.trimStart()}`)
        : [],
  },
  // The four families below are the shell's OWN obfuscations — what promptfoo's
  // base64/leetspeak strategies are for a model, these are for `sh`: the shell
  // itself decodes them, so they pass the equivalence check, and a guard that
  // matches the source string (a grep, a substring) does not see them.
  {
    // `g""it`, `"git"`, `gi"t"` — a quote pair inside or around a word is removed
    // by the shell before the word runs; a substring guard sees the quotes.
    name: "quoted head",
    rewrite: (c) => {
      const { head, rest } = splitHead(c);
      if (!rewritableHead(c) || !/^[A-Za-z][\w.-]*$/.test(head)) return [];
      return [
        `${head.slice(0, 1)}""${head.slice(1)}${rest}`,
        `"${head}"${rest}`,
        `${head.slice(0, -1)}"${head.slice(-1)}"${rest}`,
      ];
    },
  },
  {
    // `$'git'` — ANSI-C quoting; with no escape inside it is the plain word.
    name: "ansi-c quoted head",
    rewrite: (c) => {
      const { head, rest } = splitHead(c);
      if (!rewritableHead(c) || !/^[A-Za-z][\w.-]*$/.test(head)) return [];
      return [`$'${head}'${rest}`];
    },
  },
  {
    // `g\it` — a backslash before an ordinary character is that character.
    // Distinct from the leading `\git` in "absolute or escaped head": that one
    // is the alias-bypass idiom people actually type; this one nobody types,
    // which is exactly why a hand-written matcher never lists it.
    name: "escaped character in head",
    rewrite: (c) => {
      const { head, rest } = splitHead(c);
      if (!rewritableHead(c) || !/^[A-Za-z]{2,}[\w.-]*$/.test(head)) return [];
      return [`${head.slice(0, 1)}\\${head.slice(1)}${rest}`];
    },
  },
  {
    // `git   push    --force` / `git<TAB>push<TAB>--force` — any run of blanks
    // between words is one separator to the shell; blanks inside quotes are kept.
    name: "whitespace between words",
    rewrite: (c) => [joinWords(c, "   "), joinWords(c, "\t")],
  },
  {
    // A leading `NAME=value` is an ENVIRONMENT ASSIGNMENT scoped to this one
    // command, not an argument to it: the shell strips the assignments and runs
    // what follows, so `FOO=1 git push --force` IS `git push --force`. Named by
    // an adopter (2026-08-28) as a form their own guard's tests did not cover.
    //
    // Our compiled guard already blocked it — `runs()` reads the parsed leaf, so
    // the assignments were never in its way. A guard that greps the command
    // STRING has no such luck, and that is who the battery exists for.
    name: "env assignment prefix",
    rewrite: (c) => {
      const cmd = c.trimStart();
      const { head } = splitHead(c);
      if (!rewritableHead(c) && !ASSIGNMENT.test(head)) return [];
      return [`FOO=1 ${cmd}`, `GIT_TERMINAL_PROMPT=0 LC_ALL=C ${cmd}`];
    },
  },
  {
    // `( git push --force )` — a subshell runs the same command in a child
    // shell. A guard anchored at the start of the string (`case "$cmd" in
    // "git push"*`) sees `(` first.
    name: "subshell",
    // A seed with a comment or a newline (a heredoc) closes on its own line,
    // or the `)` would land inside the comment or the heredoc body.
    rewrite: (c) => {
      const cmd = c.trim();
      return [/[#\n]/.test(cmd) ? `( ${cmd}\n)` : `( ${cmd} )`];
    },
  },
  {
    // `git -C . push --force` — git's own option to run in a directory, naming
    // the one it is already in. A guard anchored on `git push` sees `-C`
    // where it expects the subcommand. The self-check drops exactly `-C .`
    // ({@link withoutHereDir}); `-C ../o` — another repository — stays.
    name: "git -C .",
    rewrite: (c) => {
      const { head, rest } = splitHead(c);
      return head === "git" && rewritableHead(c) ? [`git -C .${rest}`] : [];
    },
  },
  {
    // `bash -c '…'`, `sh -c '…'`, `eval '…'` — the command handed on as one
    // string, which the shell runs as written. A text guard sees a quoted word;
    // the gate reads inside it (#483), and so does the self-check below.
    name: "nested shell",
    rewrite: (c) => {
      const word = literalWord(c.trim());
      return word === null
        ? []
        : [`bash -c ${word}`, `sh -c ${word}`, `eval ${word}`];
    },
  },
];

/** A command word a head rewrite may touch: no assignment, no `[[`, no path. */
const PLAIN_HEAD = /^[A-Za-z][\w.-]*$/;

/**
 * Whether a head rewrite may touch `cmd`'s first word: a plain command word
 * that IS the first command the parser reads — not `if`, `for`, `time`, `[[`
 * or an assignment, whose rewrite would be a different command or none.
 */
function rewritableHead(cmd: string): boolean {
  const { head } = splitHead(cmd);
  return PLAIN_HEAD.test(head) && leafCommandsNormalized(cmd)[0]?.head === head;
}

/** A leading `NAME=value` assignment word. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The alias table for a leaf — the gate's own ({@link flagAliases}). */
function aliasTable(leaf: NormalizedLeaf): Readonly<Record<string, string>> {
  return flagAliases(leaf.head, leaf.args);
}

/** `cmd` with the whole token `from` at `index` replaced by `to`. */
function spliceToken(
  cmd: string,
  index: number,
  from: string,
  to: string,
): string {
  return cmd.slice(0, index) + to + cmd.slice(index + from.length);
}

/**
 * The alias spellings of `cmd`: each flag swapped for its other form, as a
 * whole token, only when the token occurs ONCE (so the right one is changed)
 * and every leaf that carries it has that alias in its own table.
 */
function scopedAliases(cmd: string): readonly string[] {
  const leaves = leafCommandsNormalized(cmd);
  const pairs = leaves.flatMap((leaf) =>
    Object.entries(aliasTable(leaf)).flatMap(([long, short]) => [
      [`--${long}`, `-${short}`],
      [`-${short}`, `--${long}`],
    ]),
  );
  return pairs.flatMap(([from = "", to = ""]) => {
    const hits = tokenHits(cmd, from);
    const carriers = leaves.filter((l) => l.argv.includes(from));
    const scoped = carriers.every((l) =>
      Object.entries(aliasTable(l)).some(
        ([long, short]) => from === `--${long}` || from === `-${short}`,
      ),
    );
    const hit = hits[0];
    return hits.length === 1 && hit && carriers.length > 0 && scoped
      ? [spliceToken(cmd, hit.index, from, to)]
      : [];
  });
}

/** Where `token` stands alone, between shell word boundaries, in `cmd`. */
function tokenHits(cmd: string, token: string): readonly RegExpExecArray[] {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...cmd.matchAll(
      new RegExp(`(?<=^|[\\s;&|(])${escaped}(?=$|[\\s;&|)])`, "g"),
    ),
  ];
}

/**
 * `cmd` as ONE shell word that expands to exactly `cmd`: single quotes when it
 * has none, else double quotes when nothing inside would expand, else null.
 */
function literalWord(cmd: string): string | null {
  if (!cmd.includes("'")) return `'${cmd}'`;
  return /["$`\\]/.test(cmd) ? null : `"${cmd}"`;
}

/** The first word of a command and everything after it, leading blanks dropped. */
function splitHead(cmd: string): {
  readonly head: string;
  readonly rest: string;
} {
  const trimmed = cmd.trimStart();
  const head = trimmed.split(/\s+/)[0] ?? "";
  return { head, rest: trimmed.slice(head.length) };
}

/**
 * Replace every run of blanks OUTSIDE quotes with `sep`. Quote-aware by hand
 * because the point is to re-spell the SOURCE; a run inside `'skip hooks'` is
 * data and must survive as written.
 */
function joinWords(cmd: string, sep: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const src = cmd.trim();
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
    } else if (ch === " " || ch === "\t") {
      while (src[i] === " " || src[i] === "\t") i++;
      out += sep;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Every shell-equivalent rewrite of `seed` the families can produce.
 *
 * 🔴 A candidate that does NOT satisfy {@link sameOperation} THROWS rather than
 * being dropped. A silent drop would hide a generator bug behind a smaller
 * corpus — the battery would quietly shrink and still look like it ran.
 * A family that does not APPLY (no flag to quote) yields nothing, which is
 * different from producing something wrong.
 */
export function equivalentCommands(
  seed: string,
  opts: { readonly families?: readonly Family[] } = {},
): readonly string[] {
  const { proven, unproven, family } = equivalentSpellings(seed, opts);
  const first = unproven[0];
  if (first !== undefined)
    throw new Error(
      `bash-equivalents: family "${family[0] ?? ""}" produced a NON-equivalent ` +
        `rewrite of ${JSON.stringify(seed)}: ${JSON.stringify(first)}. ` +
        `A variant that changes the operation would blame a correct guard.`,
    );
  return proven;
}

/**
 * The same rewrites, LENIENT: a candidate the self-check cannot prove is
 * returned in `unproven` (with the family that made it) instead of throwing —
 * for a battery the CALLER wrote, where a seed we never saw must not make the
 * check throw before the guard runs. A seed the parser reads no command in
 * gets nothing at all: there is nothing to prove against.
 */
export function equivalentSpellings(
  seed: string,
  opts: { readonly families?: readonly Family[] } = {},
): Spellings {
  // Only the stock families are memoized: their output is a pure function of
  // the seed, and a caller's own families may be anything.
  if (opts.families !== undefined) return spellingsOf(seed, opts.families);
  const known = STOCK_SPELLINGS.get(seed);
  if (known !== undefined) return known;
  const made = freezeSpellings(spellingsOf(seed, FAMILIES));
  // eslint-disable-next-line functional/immutable-data -- the memo's one write per seed; an entry is frozen and never replaced
  STOCK_SPELLINGS.set(seed, made);
  return made;
}

/** The rewrites of a seed, sorted into proven and unproven; see {@link equivalentSpellings}. */
interface Spellings {
  readonly proven: readonly string[];
  readonly unproven: readonly string[];
  readonly family: readonly string[];
}

/**
 * The stock families' spellings, one entry per seed, for the life of the
 * process. Building them parses every candidate (~0.1 s per seed), and the
 * guard battery asks again for the same seeds on every run. Bounded by the
 * distinct seeds a process asks about; the stock catalog has seven. Entries are
 * frozen, so a caller cannot change what the next caller is served.
 */
const STOCK_SPELLINGS = new Map<string, Spellings>();

const freezeSpellings = (s: Spellings): Spellings =>
  Object.freeze({
    proven: Object.freeze([...s.proven]),
    unproven: Object.freeze([...s.unproven]),
    family: Object.freeze([...s.family]),
  });

function spellingsOf(seed: string, families: readonly Family[]): Spellings {
  if (gateReading(seed).leaves.length === 0)
    return { proven: [], unproven: [], family: [] };
  // First family to produce a candidate names it; the seed itself is not one.
  const made = families
    .flatMap((f) => f.rewrite(seed).map((c) => [c, f.name] as const))
    .filter(([c]) => c !== seed);
  const all = made.filter(([c], i) => made.findIndex(([d]) => d === c) === i);
  const bad = all.filter(([c]) => !sameOperation(seed, c));
  return {
    proven: all.filter(([c]) => sameOperation(seed, c)).map(([c]) => c),
    unproven: bad.map(([c]) => c),
    family: bad.map(([, f]) => f),
  };
}
