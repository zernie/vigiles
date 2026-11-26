/**
 * Did a JS/TS file change between two commits ONLY in comments (vigiles#416)?
 * Pure: two texts in, a verdict out. Decided by the real parser, never the
 * bare scanner (which reads `/[//]b/` as a divide and a comment): both texts
 * parse, their leaf tokens match (kind, text, a line break before each, for
 * ASI), and every directive comment is the same and sits before the same
 * token. Any doubt reads as "not comment-only", which only refuses a case.
 */
import ts from "typescript";

/** The verdict for one file. */
export type CommentDrift =
  | { readonly kind: "comment-only" }
  | {
      readonly kind: "not-comment-only";
      /** `tokens`: the code differs; `directive`: a tool-read comment differs. */
      readonly why: "tokens" | "directive";
    }
  | { readonly kind: "language-not-supported" }
  | { readonly kind: "unparsable" };

/**
 * Comments a tool reads: a change in one changes what is checked, built or
 * run, so it is never "only a comment". A list, so a pragma spelled outside it
 * still reads as a plain comment.
 */
export const DIRECTIVE_MARKERS: readonly string[] = [
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-check",
  "/// <reference",
  "eslint-disable",
  "eslint-enable",
  "@jsx",
  "@vitest-environment",
  "@jest-environment",
  "istanbul ignore",
  "c8 ignore",
  "v8 ignore",
  "@vite-ignore",
  "webpackChunkName",
  "#__PURE__",
  "@__PURE__",
  // A shebang is trivia to the parser, but it decides how the file is run.
  "#!",
];

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** The script kind a path parses as; undefined if not read (`.d.ts` too: transpile cannot emit it). */
export function scriptKindOf(path: string): ts.ScriptKind | undefined {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const declaration = lower.slice(0, Math.max(dot, 0)).endsWith(".d");
  return dot < 0 || declaration ? undefined : SCRIPT_KINDS[lower.slice(dot)];
}

/** A parsed text: leaf tokens, the directives before each (aligned), the shebang. */
interface Reading {
  readonly tokens: readonly string[];
  readonly directives: readonly string[];
  readonly shebang: string;
}

/** Compare `before` and `after`, both the text of `path`. */
export function commentOnlyDrift(
  path: string,
  before: string,
  after: string,
): CommentDrift {
  const kind = scriptKindOf(path);
  if (kind === undefined) return { kind: "language-not-supported" };
  const a = read(path, before, kind);
  const b = read(path, after, kind);
  return a === undefined || b === undefined
    ? { kind: "unparsable" }
    : compare(a, b);
}

function compare(a: Reading, b: Reading): CommentDrift {
  if (!sameList(a.tokens, b.tokens))
    return { kind: "not-comment-only", why: "tokens" };
  // By position, not as a bag: a pragma moved to another token changes its target.
  return sameList(a.directives, b.directives) && a.shebang === b.shebang
    ? { kind: "comment-only" }
    : { kind: "not-comment-only", why: "directive" };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export function isDirective(comment: string): boolean {
  return DIRECTIVE_MARKERS.some((m) => comment.includes(m));
}

/** Parse `text`; undefined when it has a syntax error. */
function read(
  path: string,
  text: string,
  kind: ts.ScriptKind,
): Reading | undefined {
  if (hasSyntaxError(path, text, kind)) return undefined;
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const leaves = leafTokens(sf, sf);
  return {
    tokens: leaves.map((n, i) => tokenKey(sf, n, i === 0)),
    directives: leaves.map((n) =>
      JSON.stringify(
        commentsBefore(text, n.getFullStart()).filter(isDirective),
      ),
    ),
    shebang: ts.getShebang(text) ?? "",
  };
}

/**
 * Syntax errors, from the compiler's public single-file door: a transpile
 * reports exactly the parse diagnostics and no type error.
 */
function hasSyntaxError(
  path: string,
  text: string,
  kind: ts.ScriptKind,
): boolean {
  const jsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX;
  const out = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: jsx ? { jsx: ts.JsxEmit.Preserve } : {},
  });
  const diagnostics =
    /* v8 ignore next -- with reportDiagnostics the list is always set; `?? []` only types it */
    out.diagnostics ?? [];
  return diagnostics.length > 0;
}

/** Every leaf of the tree in source order; JSDoc is a comment, not a node. */
function leafTokens(
  node: ts.Node,
  sf: Readonly<ts.SourceFile>,
): readonly ts.Node[] {
  const children = node.getChildren(sf).filter((c) => !isJsDocNode(c));
  return children.length === 0
    ? [node]
    : children.flatMap((c) => leafTokens(c, sf));
}

function isJsDocNode(node: ts.Node): boolean {
  return (
    node.kind >= ts.SyntaxKind.FirstJSDocNode &&
    node.kind <= ts.SyntaxKind.LastJSDocNode
  );
}

/**
 * A token as compared: its kind, its text, and a line break before it. The
 * first token has nothing before it to end, so its line break is not read.
 */
function tokenKey(
  sf: Readonly<ts.SourceFile>,
  node: ts.Node,
  first: boolean,
): string {
  const trivia = sf.text.slice(node.getFullStart(), node.getStart(sf));
  const broken = !first && hasLineBreak(trivia) ? "\n" : "";
  return `${broken}${String(node.kind)}:${node.getText(sf)}`;
}

/** Any JavaScript line terminator (LF, CR, U+2028, U+2029), as the scanner reads one. */
function hasLineBreak(trivia: string): boolean {
  return Array.from({ length: trivia.length }, (_, i) =>
    trivia.charCodeAt(i),
  ).some(ts.isLineBreak);
}

/**
 * The comments in the trivia that starts at `pos`, the same-line ones
 * included. At the start of the file the leading ranges already hold them.
 */
function commentsBefore(text: string, pos: number): readonly string[] {
  const trailing =
    pos === 0 ? [] : (ts.getTrailingCommentRanges(text, pos) ?? []);
  const ranges = [
    ...trailing,
    ...(ts.getLeadingCommentRanges(text, pos) ?? []),
  ];
  return ranges.map((r) => text.slice(r.pos, r.end));
}
