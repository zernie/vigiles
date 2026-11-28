/**
 * vigiles — Inline rule mode for gradual adoption.
 *
 * Parses `<!-- vigiles:enforce <linter>/<rule> "<why>" -->` HTML comments
 * out of any markdown file, so a project can adopt vigiles one rule at a
 * time without committing to a .spec.ts compile step. Every inline rule
 * goes through the same `checkLinterRule` verification as rules declared
 * in a .spec.ts — typos get closest-match suggestions, disabled rules are
 * flagged, etc.
 *
 * Three reference marks are comments read here — `enforce`, `file`, `cmd`.
 * The full set, including the span marks and opt-outs other modules read, is
 * `VIGILES_MARKS` below. There is no inline `guidance`: if you're editing the
 * markdown, the prose around the comment already is the guidance.
 *
 * A file is in "inline mode" iff it contains at least one vigiles:enforce
 * comment. Spec mode (`.md.spec.ts` sibling) takes precedence if both
 * exist; the spec compiler emits a fresh file that may overwrite the
 * inline markup, so users should pick one per file.
 */

export interface InlineRule {
  /** Linter rule reference, e.g. "eslint/no-console". */
  linterRule: string;
  /** Why this rule is enforced (human-readable, shown in agent context). */
  why: string;
  /** 1-based line number of the comment in the source file. */
  line: number;
}

/** A `<!-- vigiles:file <path> -->` reference (verified to exist). */
export interface InlineFileRef {
  /** Project-relative path to verify exists. */
  path: string;
  /** 1-based line number of the comment in the source file. */
  line: number;
}

/** A `<!-- vigiles:cmd "<command>" -->` reference (npm scripts verified). */
export interface InlineCmdRef {
  /** Command to verify (npm scripts checked against package.json). */
  command: string;
  /** 1-based line number of the comment in the source file. */
  line: number;
}

export interface InlineParseResult {
  rules: InlineRule[];
  files: InlineFileRef[];
  commands: InlineCmdRef[];
  /** Lines that look like vigiles: markers but failed to parse. */
  errors: { line: number; message: string; raw: string }[];
}

/**
 * Match `<!-- vigiles:enforce <linter>/<rule> "<why>" -->`. The linter
 * reference allows the same characters as the TS-side `SAFE_RULE_NAME_RE`
 * plus `@` for scoped plugin names (e.g. `@typescript-eslint/...`).
 * The `why` is a simple quoted string — if someone wants newlines or
 * embedded quotes, they can move to spec mode.
 */
const ENFORCE_RE =
  /<!--\s*vigiles:enforce\s+([@A-Za-z0-9_/:.-]+)\s+"([^"\n]*)"\s*-->/;

/**
 * Match `<!-- vigiles:file <path> -->`. The path is a single whitespace-free
 * token (project-relative); spaces in paths are vanishingly rare and would be
 * ambiguous against the closing `-->`.
 */
const FILE_RE = /<!--\s*vigiles:file\s+(\S+)\s*-->/;

/**
 * Strip a single surrounding pair of matching quotes from a captured token.
 * The documented `vigiles:file` syntax is an unquoted path, but users
 * reasonably quote it for symmetry with `vigiles:cmd "..."` — without this,
 * the quotes become part of the path, so it never resolves and the error
 * reads `File not found: ""path""`. Normalize at the parse boundary.
 */
function unquote(token: string): string {
  return /^"[^]*"$|^'[^]*'$/.test(token) ? token.slice(1, -1) : token;
}

/**
 * Match `<!-- vigiles:cmd "<command>" -->`. The command is quoted because
 * commands contain spaces (e.g. `npm run build`).
 */
const CMD_RE = /<!--\s*vigiles:cmd\s+"([^"\n]*)"\s*-->/;

/** How a reader writes one vigiles mark, or that a compiler writes it. */
export type MarkSpec =
  | {
      /** A person (or an agent) writes it into the markdown by hand. */
      readonly writer: "author";
      /** An HTML comment, or the text of an inline code span. */
      readonly form: "comment" | "span";
      /** What the mark is for: a reference `lint` verifies, or an opt-out. */
      readonly role: "reference" | "opt-out";
      /** The exact syntax, as the docs print it (a span without its backticks). */
      readonly syntax: string;
    }
  | {
      /** `vigiles compile` writes it into a generated file; nobody types it. */
      readonly writer: "compiler";
    };

/**
 * Every `vigiles:` mark a user's markdown can carry — the ONE list. The parser below derives its
 * error messages and the marks it leaves to other subsystems from it, and the
 * docs test (`inline.test.ts`) requires each author mark to have a docs section
 * that prints `syntax` and an example the real parser reads back as that mark.
 * A mark missing here is one nobody can find; a mark here without a handler is
 * one that verifies nothing.
 */
export const VIGILES_MARKS = {
  enforce: {
    writer: "author",
    form: "comment",
    role: "reference",
    syntax: '<!-- vigiles:enforce <linter>/<rule> "<why>" -->',
  },
  file: {
    writer: "author",
    form: "comment",
    role: "reference",
    syntax: "<!-- vigiles:file <path> -->",
  },
  cmd: {
    writer: "author",
    form: "comment",
    role: "reference",
    syntax: '<!-- vigiles:cmd "<command>" -->',
  },
  // Read from code spans by `src/core/refs.ts` and `src/core/mcp.ts`.
  symbol: {
    writer: "author",
    form: "span",
    role: "reference",
    syntax: "vigiles:symbol <file>#<name>",
  },
  mcp: {
    writer: "author",
    form: "span",
    role: "reference",
    syntax: "vigiles:mcp <server>#<tool>",
  },
  // Read by the doc-reference check (`src/core/doc-refs.ts`).
  ignore: {
    writer: "author",
    form: "comment",
    role: "opt-out",
    syntax: "<!-- vigiles:ignore -->",
  },
  "ignore-file": {
    writer: "author",
    form: "comment",
    role: "opt-out",
    syntax: "<!-- vigiles:ignore-file -->",
  },
  // Read by the coverage rules (`src/coverage-evidence.ts`): a skill, subagent
  // or output style that carries it is reported as exempt, not untested.
  "ignore-test": {
    writer: "author",
    form: "comment",
    role: "opt-out",
    syntax: "<!-- vigiles:ignore-test -->",
  },
  // Skill step gates (`src/adapters/claude-code/skill-runtime.ts`).
  gate: { writer: "compiler" },
  result: { writer: "compiler" },
  // `src/core/compile.ts`: an `effect()` region, and a declared purity floor
  // (`<!-- vigiles:purity:<level> -->`, read by the runtime purity gate).
  effect: { writer: "compiler" },
  purity: { writer: "compiler" },
} as const satisfies Record<string, MarkSpec>;

/** The name of one vigiles mark. */
export type MarkKind = keyof typeof VIGILES_MARKS;

function isMarkKind(kind: string): kind is MarkKind {
  return Object.hasOwn(VIGILES_MARKS, kind);
}

/** The marks a person writes, in the order the docs list them. */
export const AUTHOR_MARKS: readonly MarkKind[] = Object.keys(VIGILES_MARKS)
  .filter(isMarkKind)
  .filter((kind) => VIGILES_MARKS[kind].writer === "author");

/**
 * Detects any `<!-- vigiles:<kind> -->` comment (valid or not) so we can
 * surface errors for typos and reserved-but-unrecognized kinds. Uses a
 * non-greedy match for the tail so a `-` inside the kind doesn't short-
 * circuit the pattern.
 */
const MARKER_RE = /<!--\s*vigiles:([A-Za-z_-]+)[^]*?-->/;

/**
 * The error for a `<!-- vigiles:<kind> ... -->` comment that none of the three
 * reference patterns matched, or `null` when the comment belongs to another
 * subsystem (an opt-out, a compiler-written gate).
 */
function markerError(kind: string): string | null {
  if (!isMarkKind(kind)) {
    const supported = AUTHOR_MARKS.map((k) => `\`vigiles:${k}\``).join(", ");
    return `Unknown vigiles marker "${kind}". The marks are: ${supported}.`;
  }
  const spec: MarkSpec = VIGILES_MARKS[kind];
  if (spec.writer === "compiler" || spec.role === "opt-out") return null;
  if (spec.form === "span") {
    return `vigiles:${kind} goes in a code span, not a comment — expected \`${spec.syntax}\` between backticks`;
  }
  return `Malformed vigiles:${kind} — expected \`${spec.syntax}\``;
}

/**
 * Parse inline vigiles rules out of a markdown file's contents.
 * Does not touch the filesystem and does not verify the rules against
 * any linter — callers can feed the returned rules into
 * `checkLinterRule` themselves.
 *
 * Lines inside fenced code blocks (``` ... ``` or ~~~ ... ~~~) are
 * skipped so illustrative examples in docs don't get treated as live
 * rules.
 */
export function parseInlineRules(content: string): InlineParseResult {
  const rules: InlineRule[] = [];
  const files: InlineFileRef[] = [];
  const commands: InlineCmdRef[] = [];
  const errors: InlineParseResult["errors"] = [];

  const lines = content.split("\n");
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks. CommonMark allows ``` or ~~~ fences
    // with 3+ characters; the closing fence must use the same char and
    // have length >= the opening fence's length. Info-string tokens
    // after the opener are allowed.
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      const ch = marker[0] as "`" | "~";
      const len = marker.length;
      if (fenceChar === null) {
        fenceChar = ch;
        fenceLen = len;
        continue;
      } else if (ch === fenceChar && len >= fenceLen) {
        // Closing fence — trailing info-string is not allowed per
        // CommonMark; only treat it as a close if the rest of the
        // line is whitespace.
        if (fenceMatch[3].trim() === "") {
          fenceChar = null;
          fenceLen = 0;
          continue;
        }
      }
    }
    if (fenceChar !== null) {
      // Inside a code block — ignore any vigiles markers on this line.
      continue;
    }

    // Strip inline code spans (backtick-wrapped text) so illustrative
    // markers in prose like `<!-- vigiles:enforce ... -->` don't get
    // parsed. CommonMark opens with N backticks and closes with exactly
    // N, so the backreference handles matching-length spans.
    const scannable = line.replace(/(`+)[\s\S]*?\1/g, (m) =>
      " ".repeat(m.length),
    );

    const enforceMatch = ENFORCE_RE.exec(scannable);
    if (enforceMatch) {
      rules.push({
        linterRule: enforceMatch[1],
        why: enforceMatch[2],
        line: i + 1,
      });
      continue;
    }

    const fileMatch = FILE_RE.exec(scannable);
    if (fileMatch) {
      files.push({ path: unquote(fileMatch[1]), line: i + 1 });
      continue;
    }

    const cmdMatch = CMD_RE.exec(scannable);
    if (cmdMatch) {
      commands.push({ command: cmdMatch[1], line: i + 1 });
      continue;
    }
    // Skip the compiled-file hash header (`<!-- vigiles:sha256:... -->`)
    // entirely — it's not a rule marker and should not be reported.
    if (/<!--\s*vigiles:sha\d+:/.test(scannable)) continue;

    const markerMatch = MARKER_RE.exec(scannable);
    if (markerMatch) {
      // Looks like a vigiles marker but didn't parse — surface it so users
      // catch typos like "vigile:enforce" or an unquoted why/command.
      const message = markerError(markerMatch[1]);
      if (message !== null) {
        errors.push({ line: i + 1, message, raw: line.trim() });
      }
    }
  }

  return { rules, files, commands, errors };
}

/**
 * True if the content contains at least one parseable vigiles inline marker —
 * an `enforce` rule, a `file` reference, or a `cmd` reference (ignoring fenced
 * code blocks and malformed markers). A utility for detecting whether a file is
 * inline-managed (Level-0 mode). Deliberately delegates to `parseInlineRules` so
 * a loose prefix regex can't report a malformed marker that produces no real
 * reference.
 *
 * NB `require-instructions-spec` is NARROW — it is satisfied only by a `.spec.ts`,
 * not by inline markers — so this no longer feeds that rule.
 */
export function hasInlineRules(content: string): boolean {
  const r = parseInlineRules(content);
  return r.rules.length + r.files.length + r.commands.length > 0;
}
