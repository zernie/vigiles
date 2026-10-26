/**
 * A document's own rule about its own commands, made checkable.
 *
 * ## The shape this closes
 *
 * A skill or runbook routinely states a rule in prose and then ships commands
 * that must obey it — "always pass `curl -g`, or bracketed params glob and the
 * request fails SILENTLY"; "every `psql` needs `--single-transaction`". The rule
 * and its violation live **in the same file**, three paragraphs apart, and
 * nothing compares them. It is a rule nobody checks, turned on the author's own
 * document, and it is the smallest possible instance of one.
 *
 * vigiles cannot INFER such a rule — no tool reads "always use -g" and derives
 * which flag is mandatory. What was missing is not cleverness but a cheap way to
 * DECLARE it. Measured 2026-08-11 on a real skill: expressing one rule took ~95
 * lines of hand-rolled markdown parsing (pull fenced blocks, separate a command
 * from prose that talks about a command, parse flags, build the message) around
 * ~5 lines of actual rule. At that price nobody writes the check, and the file
 * keeps its rule as prose — which is exactly the failure the project exists to
 * name.
 *
 * With this the whole test is the rule:
 *
 * ```ts
 * assertChecks(commandsIn(read("SKILL.md"), /curl/), [
 *   mustInclude("-g", "bracketed params glob and the request fails SILENTLY"),
 *   mustInclude("--cacert", "this environment's proxy needs the CA bundle"),
 * ]);
 * ```
 *
 * ## Why fenced blocks only
 *
 * The prose that STATES the rule ("always use `curl -g`") contains the command
 * name too. Reading it as a command would make every well-documented rule report
 * itself as a violation — a checker that fires on clean input is muted within a
 * day. So extraction is limited to fenced code blocks, where a line is a command
 * because of where it sits, not because of what it looks like.
 *
 * ## Prior art, and the honest split (surveyed 2026-08-11)
 *
 * The field divides into four quadrants and this sits in the empty one:
 *
 *   extraction              pull blocks out of markdown        codedown, code_extractor
 *   extraction + linter     pull shell, run shellcheck on it   markdown-shellcheck (awk)
 *   execution               RUN the blocks (literate/doctest)  mdsh, Rust doctests, mdbook test
 *   matchers                expect.extend / chai               vitest, jest, jest-dom
 *
 * The nearest neighbour is `markdown-shellcheck`, and the difference is the
 * whole point: it applies a UNIVERSAL correctness checker (quoting, globbing,
 * `$?`) that knows nothing about this document. This applies the rule THIS
 * DOCUMENT STATES ABOUT ITSELF — "in this file every curl carries --cacert" —
 * which no general linter can know and no doctest can express, because the
 * commands here are never run.
 *
 * ⚠️ The EXTRACTION half is not novel and is not claimed to be: `codedown` and
 * `markdown-shellcheck` both do it. It is reimplemented at ~30 dependency-free
 * lines because vendoring an awk script or an npm package for that is worse than
 * owning it. Cheap composition worth stealing from `markdown-shellcheck`: this
 * returns structured commands, so handing them to a real shellcheck when one is
 * installed is a few lines and buys a whole class of checks nobody here should
 * be writing.
 *
 * Pure: takes text, returns data. No filesystem, no shell, nothing is executed.
 */
import type { Check, CheckResult } from "./check.js";
import { fencedCodeBlocks } from "./core/markdown.js";

/** One command line found in a document. */
export interface DocCommand {
  /** The line, trimmed. */
  readonly text: string;
  /** 1-based line number in the document, for the failure message. */
  readonly line: number;
}

/**
 * Fenced code blocks, with the line number each starts on.
 *
 * 🔴 A CLOSING FENCE IS NOT "ANY LINE STARTING WITH ```", and this used to be a
 * toggle on exactly that. CommonMark closes a fence only on the same CHARACTER at
 * the same-or-greater LENGTH, so a four-backtick block wrapping an ordinary ```
 * example — the standard way to show a fence inside a document — was cut in half
 * at the inner delimiter, and the PROSE after it became the next "block". This
 * check then missed the commands in the tail of the real block and judged
 * paragraphs that are not commands at all: both halves of the mistake this module
 * exists to prevent ("a line is a command because of WHERE IT SITS"), with the
 * position decided wrongly. `~~~` fences were not recognized at all.
 *
 * Delegated to {@link fencedCodeBlocks}, the repo's ONE markdown-structure helper
 * (markdown-it / CommonMark) — the same rule the project already applies to Bash,
 * YAML, TOML and code: structure gets a parser. Hand-rolling it a second time is
 * how the first one got this wrong.
 */
function fencedBlocks(md: string): { body: string; start: number }[] {
  // Normalized before parsing so a CRLF document's `\r` does not ride along on
  // the last word of every command, which the old line split handled explicitly.
  return fencedCodeBlocks(md.replace(/\r\n/g, "\n"));
}

/**
 * Command lines in `md`'s fenced blocks that match `matching`.
 *
 * Comment lines (`#`) are skipped: a commented-out example is not a command the
 * reader is told to run, and flagging it teaches people to delete their examples.
 *
 * 🔴 THE FILTER IS RE-BUILT WITHOUT `g`/`y`, BECAUSE `RegExp.test` IS STATEFUL.
 * On a global or sticky regex `test()` advances `lastIndex`, so testing a run of
 * matching lines with the SAME object alternates hit/miss. Measured 2026-08-11
 * on four `curl` lines: `/curl/` finds all four, `/curl/g` finds the 1st and the
 * 3rd, `/curl/y` the same. Silent, and the wrong way round — half the document
 * quietly leaves the set that `mustInclude`/`mustNotInclude` then judge, so the
 * rule passes over commands it never saw. `/curl/g` is what a caller writes
 * without thinking, and it must not mean something different.
 *
 * A fresh regex rather than resetting `lastIndex`: the caller's object is theirs
 * and may be reused elsewhere, and there is no state left to reset wrongly. `y`
 * goes too — sticky ANCHORS the match at `lastIndex`, so `/curl/y` against
 * `sudo curl …` would find nothing, which is not what "matching" means here.
 */
export function commandsIn(md: string, matching: RegExp): DocCommand[] {
  const search = new RegExp(
    matching.source,
    matching.flags.replaceAll("g", "").replaceAll("y", ""),
  );
  const out: DocCommand[] = [];
  for (const block of fencedBlocks(md))
    for (const [i, raw] of block.body.split("\n").entries()) {
      const text = (raw ?? "").trim();
      if (text === "" || text.startsWith("#")) continue;
      if (!search.test(text)) continue;
      out.push({ text, line: block.start + i });
    }
  return out;
}

/**
 * Every matched command must contain `fragment`.
 *
 * `why` is REQUIRED, and it is the point: the failure message has to carry the
 * consequence, because a bare "missing -g" tells the reader to add a flag
 * without telling them what breaks — and a rule whose reason is lost is the next
 * thing someone deletes as noise. It is usually one clause from the prose the
 * check is enforcing, which keeps the two in the same file and in sync.
 *
 * 🔴 AN EMPTY COMMAND SET PASSES VACUOUSLY, AND THAT IS REPORTED. If the filter
 * matched nothing, the rule held over zero commands — which is true and
 * worthless, and reads identically to a rule that held over twenty. So the check
 * FAILS on an empty set: at that point either the extraction broke or the
 * document stopped shipping the commands the rule is about, and both are things
 * the author wants to hear.
 */
export function mustInclude(
  fragment: string,
  why: string,
): Check<readonly DocCommand[]> {
  return {
    kind: "mustInclude",
    eval(commands: readonly DocCommand[]): CheckResult {
      if (commands.length === 0)
        return {
          pass: false,
          score: 0,
          message:
            `no commands matched, so "${fragment}" was checked against nothing — ` +
            `a rule that holds over zero commands reads exactly like one that holds. ` +
            `Either the filter no longer matches this document, or the commands it ` +
            `is about are gone.`,
        };
      const offenders = commands.filter((c) => !c.text.includes(fragment));
      if (offenders.length === 0)
        return {
          pass: true,
          score: 1,
          message: `all ${String(commands.length)} command(s) include "${fragment}"`,
        };
      const shown = offenders
        .slice(0, 3)
        .map((o) => `  line ${String(o.line)}: ${o.text.slice(0, 90)}`)
        .join("\n");
      const more =
        offenders.length > 3
          ? `\n  … (+${String(offenders.length - 3)} more)`
          : "";
      return {
        pass: false,
        score: 0,
        message: `${String(offenders.length)} of ${String(commands.length)} command(s) omit "${fragment}" — ${why}\n${shown}${more}`,
      };
    },
    toJSON() {
      return { kind: "mustInclude", fragment, why };
    },
  };
}

/**
 * Every matched command must NOT contain `fragment` — the ban, for the rules
 * stated the other way round ("never `--force`", "no `-k`/`--insecure`").
 *
 * Same vacuity rule as {@link mustInclude}, and for a sharper reason: a ban that
 * matched nothing is the single easiest check to leave green forever.
 */
export function mustNotInclude(
  fragment: string,
  why: string,
): Check<readonly DocCommand[]> {
  return {
    kind: "mustNotInclude",
    eval(commands: readonly DocCommand[]): CheckResult {
      if (commands.length === 0)
        return {
          pass: false,
          score: 0,
          message:
            `no commands matched, so the ban on "${fragment}" was checked against ` +
            `nothing. A ban over zero commands is the easiest check to leave green forever.`,
        };
      const offenders = commands.filter((c) => c.text.includes(fragment));
      if (offenders.length === 0)
        return {
          pass: true,
          score: 1,
          message: `none of ${String(commands.length)} command(s) use "${fragment}"`,
        };
      const shown = offenders
        .slice(0, 3)
        .map((o) => `  line ${String(o.line)}: ${o.text.slice(0, 90)}`)
        .join("\n");
      return {
        pass: false,
        score: 0,
        message: `${String(offenders.length)} command(s) use "${fragment}" — ${why}\n${shown}`,
      };
    },
    toJSON() {
      return { kind: "mustNotInclude", fragment, why };
    },
  };
}
