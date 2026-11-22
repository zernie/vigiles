/**
 * THE REFERENCE GRAPH — every place a file the harness reads names another
 * path, as a value with a location, resolved against the repository's exact
 * path list (`./repo-tree.ts`).
 *
 * WHY A GRAPH. Before it a reference was a string each detector pulled out of
 * raw text with its own grammar, and the place it came from was lost at the
 * first `Set<string>`: a finding had no file, no line and no rule (#442). Here
 * an edge exists only because a SOURCE produced it, so it has a place by
 * construction, and one function answers every consumer (`lint`, `audit`, the
 * browser engine) — one-detector-no-drift.
 *
 * WHAT IS A SOURCE. A closed set of roles: the instruction chain's files (the
 * adapter's `instructionChain` decides which, compiled files included), and the
 * bodies of subagents and commands. Not hook scripts, helper scripts, tests or
 * `docs/`: the harness does not read those as pointers, and reading them was
 * the false class #442 removed. SKILL.md bodies join in a later change.
 *
 * WHAT IS AN EDGE. Three kinds, each from a parser, never a regex over prose:
 * `import` (an `@path` the adapter's chain reports — the harness loads it),
 * `link` (a markdown link or image destination, `markdownRefs`) and `mention`
 * (a code span that is one path-shaped token, `markdownRefs`). A target that is
 * a URL, an anchor, absolute, `~`/`$`-rooted, percent-encoded or a glob or
 * placeholder makes no edge.
 *
 * WHAT A RESOLUTION SAYS. A tagged union, because "not found" has several
 * reasons and each reads differently: a wrong-case name (found on a Mac, broken
 * on Linux), a file that exists only somewhere else (a note, never scored), a
 * submodule (contents not in this tree), one machine's file (`.local.`, never a
 * fact about the commit) and a path leaving the scanned directory (silent).
 *
 * Pure: no node, no adapter fact.
 */
import { groupBy } from "remeda";

import { editDistance } from "./edit-distance.js";
import type { InstructionScope, NamedImport } from "./instruction-chain.js";
import { frontmatterBodyAt } from "./frontmatter-read.js";
import { markdownRefs } from "./markdown.js";
import type { RepoTree } from "./repo-tree.js";
import type { Finding } from "./rule.js";

/** What a source file is to the harness. */
export type SourceRole = "instruction" | "agent" | "command";

/** A file whose links and code-span mentions are read as references. */
export interface ReferenceSource {
  /** Relative to the scanned directory. */
  readonly path: string;
  readonly role: SourceRole;
  readonly text: string;
}

/** How a file names another: what the harness does with the reference. */
export type EdgeKind = "import" | "link" | "mention";

/** One reference: where it is, what it is, and the path as written. */
export interface Edge {
  /** The file holding the reference, relative to the scanned directory. */
  readonly from: string;
  /** 1-based line of the REAL file (frontmatter included in the count). */
  readonly line: number;
  readonly role: SourceRole;
  readonly kind: EdgeKind;
  /** The token exactly as the author wrote it (`@docs/a.md`, `docs/`). */
  readonly written: string;
  /** The path it names, `./`, `#fragment`, `?query` and `:line` dropped. */
  readonly path: string;
  /** Written with a trailing `/`: it names a directory. */
  readonly dir: boolean;
  /** `"local"` for an import that is one machine's (from the chain). */
  readonly scope: InstructionScope;
}

/** Which directory a path was resolved from. */
export type FrameName = "file-dir" | "repo-root";

/** How one edge resolved against the tree. */
export type Resolution =
  /** Exists where the harness looks. Not reported. */
  | {
      readonly status: "resolved";
      readonly at: string;
      readonly frame: FrameName;
    }
  /** Exists nowhere. A finding. */
  | { readonly status: "missing"; readonly didYouMean?: string }
  /** Exists under another case: found on a case-insensitive disk only. A finding. */
  | { readonly status: "case-mismatch"; readonly actual: string }
  /** Not where this source resolves it, but at these paths. A note. */
  | {
      readonly status: "elsewhere";
      readonly at: readonly string[];
      readonly frame: FrameName;
    }
  /** Inside a submodule, whose contents this tree does not hold. A note. */
  | { readonly status: "in-submodule"; readonly submodule: string }
  /** One machine's file (`@AGENTS.local.md`). Not reported. */
  | { readonly status: "machine-local" }
  /** Leaves the scanned directory (`../..`). Not reported. */
  | { readonly status: "outside-repo" };

/** The resolutions a report prints: findings and notes. */
export type ReportedResolution = Extract<
  Resolution,
  {
    readonly status: "missing" | "case-mismatch" | "elsewhere" | "in-submodule";
  }
>;

/** One edge with its resolution. */
export type ResolvedReference = Edge & { readonly resolution: Resolution };

/** The statuses that are findings: nothing the harness can read. */
const BROKEN: ReadonlySet<string> = new Set(["missing", "case-mismatch"]);

/** A reference that is a finding: it resolves to nothing the harness can read. */
export function isBrokenReference(r: ResolvedReference): boolean {
  return BROKEN.has(r.resolution.status);
}

/** A reference worth a note: it resolves, but not here, or not decidably. */
export function isNotedReference(r: ResolvedReference): boolean {
  return !BROKEN.has(r.resolution.status) && reported(r) !== undefined;
}

/**
 * The broken `import` edges — the graded half, shared by the rule that reports
 * them and the scorer that counts them, so the two cannot disagree.
 */
export function brokenImports(
  refs: readonly ResolvedReference[],
): readonly ResolvedReference[] {
  return refs.filter((r) => r.kind === "import" && isBrokenReference(r));
}

/** How a reported resolution reads, one clause. */
function described(res: ReportedResolution): string {
  switch (res.status) {
    case "missing":
      return res.didYouMean === undefined
        ? "missing"
        : `missing; did you mean \`${res.didYouMean}\`?`;
    case "case-mismatch":
      return `wrong case: the file is \`${res.actual}\`, so it resolves only on a case-insensitive disk`;
    case "elsewhere":
      return `not found from here; it exists at ${res.at.map((p) => `\`${p}\``).join(", ")}`;
    case "in-submodule":
      return `inside the submodule \`${res.submodule}\`, whose files this scan does not hold`;
  }
}

/** `r`'s resolution, when a report prints it. */
function reported(r: ResolvedReference): ReportedResolution | undefined {
  const res = r.resolution;
  return res.status === "resolved" ||
    res.status === "machine-local" ||
    res.status === "outside-repo"
    ? undefined
    : res;
}

/**
 * One reference as the finding (broken) or note (elsewhere, submodule) a rule
 * reports, at its file and line; `undefined` for one that is not reported.
 * `consequence` is the rule's own words for what a broken one costs.
 */
export function referenceFinding(
  r: ResolvedReference,
  consequence: string,
): Finding | undefined {
  const res = reported(r);
  if (res === undefined) return undefined;
  const broken = BROKEN.has(res.status);
  return {
    kind: broken ? "finding" : "note",
    path: r.from,
    line: r.line,
    subject: r.kind === "mention" ? `\`${r.written}\`` : r.written,
    message: broken
      ? `${described(res)} — ${consequence}`
      : `${described(res)}.`,
    reference: { kind: r.kind, target: r.written, resolution: res },
  };
}

/** Extensions that make a slash-less code span a file mention. */
const MENTION_EXTENSIONS: ReadonlySet<string> = new Set(
  "md mdx txt json jsonc yaml yml toml ts tsx js jsx mjs cjs py sh rb go rs".split(
    " ",
  ),
);

/** A code span that can be a path: one token of path characters. */
const PATH_TOKEN = /^[\p{L}\p{N}_.\-/+]+$/u;

/** `file.ts:12` / `file.ts:12:3` — a location suffix, not part of the path. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/**
 * The path a written target names, or `null` when it makes no edge: a URL or
 * other scheme, an anchor, an absolute, `~`- or `$`-rooted path, a
 * percent-encoded one, a glob or a placeholder.
 */
function targetPath(written: string): string | null {
  const t = written.trim();
  if (t === "" || /^[a-z][a-z0-9+.-]*:/i.test(t) || /^[#/~]/.test(t))
    return null;
  if (/[$*{}<>]|%[0-9A-Fa-f]{2}/.test(t)) return null;
  const path = t.replace(/[?#].*$/, "");
  return path === "" ? null : path;
}

/** A slash-less `.x.y` token is a suffix (`.spec.ts`, `.d.ts`), not a file. */
const SUFFIX_TOKEN = /^\.[^/]*\./;

/**
 * A code span's path, under the stricter mention shape, or `null`: it ends in
 * a common file extension, or in `/` (a directory). A slash path with neither
 * is a package subpath, a repo slug or a rule id far more often than a file
 * (`vigiles/hook`, `owner/repo`, `local/no-rule-ids` — measured on this
 * repository's own instruction file), so it makes no edge.
 */
function mentionPath(span: string): string | null {
  const token = span.trim().replace(LINE_SUFFIX, "");
  if (!PATH_TOKEN.test(token) || /^[@-]/.test(token)) return null;
  if (SUFFIX_TOKEN.test(token)) return null;
  const path = targetPath(token);
  if (path === null) return null;
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  const fileLike = ext !== undefined && MENTION_EXTENSIONS.has(ext);
  return path.endsWith("/") || fileLike ? path : null;
}

/** The link and mention edges of one source. */
function sourceEdges(source: ReferenceSource): readonly Edge[] {
  const { body, firstLine } = frontmatterBodyAt(source.text);
  return markdownRefs(body).flatMap((ref): readonly Edge[] => {
    const path =
      ref.kind === "link" ? targetPath(ref.value) : mentionPath(ref.value);
    if (path === null) return [];
    return [
      {
        from: source.path,
        line: ref.line + firstLine - 1,
        role: source.role,
        kind: ref.kind === "link" ? "link" : "mention",
        written: ref.value,
        path: path.replace(/^(?:\.\/)+/, "").replace(/\/$/, ""),
        dir: path.endsWith("/"),
        scope: "repo",
      },
    ];
  });
}

/**
 * The 1-based line an import token sits on: the adapter's, or — for an adapter
 * that does not report one — the first line of `from` holding the token.
 */
function importLine(imp: NamedImport, text: string | undefined): number {
  if (imp.line !== undefined) return imp.line;
  const at = (text ?? "").split("\n").findIndex((l) => l.includes(imp.token));
  return at === -1 ? 1 : at + 1;
}

/** One import the chain reported, as an edge. */
function importEdge(
  imp: NamedImport,
  files: Readonly<Record<string, string>>,
): Edge {
  const written = imp.token;
  return {
    from: imp.from,
    line: importLine(imp, files[imp.from]),
    role: "instruction",
    kind: "import",
    written,
    path: written.replace(/^@/, ""),
    dir: false,
    scope: imp.scope ?? "repo",
  };
}

/** `base` joined with `rel`, `.`/`..` collapsed; `null` when it leaves the root. */
function joinRel(base: string, rel: string): string | null {
  const segs = [...base.split("/"), ...rel.split("/")].filter(
    (seg) => seg !== "" && seg !== ".",
  );
  const out = segs.reduce<readonly string[] | null>((acc, seg) => {
    if (acc === null) return null;
    if (seg !== "..") return [...acc, seg];
    return acc.length === 0 ? null : acc.slice(0, -1);
  }, []);
  return out === null ? null : out.join("/");
}

/** The tree, indexed once per graph: directories, case-folded names, children. */
interface TreeIndex {
  readonly tree: RepoTree;
  readonly dirs: ReadonlySet<string>;
  readonly folded: ReadonlyMap<string, string>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly byBase: ReadonlyMap<string, readonly string[]>;
}

/** `a/b/c` → `["a", "a/b"]`: the directories a path sits in. */
function ancestors(path: string): readonly string[] {
  const segs = path.split("/");
  return segs.slice(1).map((_, i) => segs.slice(0, i + 1).join("/"));
}

/** The part of `path` after its last `/`. */
const leaf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The part of `path` before its last `/` (`""` at the root). */
const parentOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

function indexTree(tree: RepoTree): TreeIndex {
  const files = [...tree.paths];
  const dirs = new Set(files.flatMap(ancestors));
  const names = [...new Set([...files, ...dirs])].sort();
  // Reverse order, so the FIRST name in sort order wins a case-folded collision.
  const folded = new Map(
    names.map((_, i) => {
      const n = names[names.length - 1 - i] ?? "";
      return [n.toLowerCase(), n] as const;
    }),
  );
  return {
    tree,
    dirs,
    folded,
    children: new Map(
      Object.entries(groupBy(names, parentOf)).map(([k, v]) => [
        k,
        v.map(leaf),
      ]),
    ),
    byBase: new Map(Object.entries(groupBy(files, leaf))),
  };
}

/** Does `path` exist — as a directory if `dir`, as either otherwise? */
function exists(idx: TreeIndex, path: string, dir: boolean): boolean {
  return idx.dirs.has(path) || (!dir && idx.tree.paths.has(path));
}

/** The nearest sibling name of a missing `path` (edit distance ≤ 2), as a path. */
function nearest(idx: TreeIndex, path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const best = (idx.children.get(parent) ?? [])
    .map((c) => ({ c, d: editDistance(c, name) }))
    // At most 2 edits, and at most a third of the name: `dist` is not `test`.
    .filter((x) => x.d > 0 && x.d <= Math.min(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))[0];
  return best === undefined
    ? undefined
    : (joinRel(parent, best.c) ?? undefined);
}

/** Where an edge is looked for: the file's directory, and for a mention the root. */
function frames(edge: Edge): readonly (readonly [FrameName, string | null])[] {
  const slash = edge.from.lastIndexOf("/");
  const fileDir = slash === -1 ? "" : edge.from.slice(0, slash);
  const local = [["file-dir", joinRel(fileDir, edge.path)]] as const;
  return edge.kind === "mention" && fileDir !== ""
    ? [...local, ["repo-root", joinRel("", edge.path)]]
    : local;
}

/** Where else a missing edge's file exists — a note, not a finding. */
function elsewhere(idx: TreeIndex, edge: Edge): Resolution | undefined {
  if (edge.kind === "link") {
    const root = joinRel("", edge.path);
    return root !== null && exists(idx, root, edge.dir)
      ? { status: "elsewhere", at: [root], frame: "repo-root" }
      : undefined;
  }
  if (edge.kind !== "mention" || edge.dir) return undefined;
  const base = edge.path.slice(edge.path.lastIndexOf("/") + 1);
  const at = (idx.byBase.get(base) ?? []).slice(0, 3);
  return at.length === 0
    ? undefined
    : { status: "elsewhere", at, frame: "repo-root" };
}

/** Resolve one edge against the indexed tree. */
function resolve(idx: TreeIndex, edge: Edge): Resolution {
  if (edge.scope === "local") return { status: "machine-local" };
  const candidates = frames(edge).flatMap(([frame, p]) =>
    p === null ? [] : [{ frame, path: p }],
  );
  if (candidates.length === 0) return { status: "outside-repo" };
  const hit = candidates.find((c) => exists(idx, c.path, edge.dir));
  if (hit !== undefined)
    return { status: "resolved", at: hit.path, frame: hit.frame };
  const sub = [...idx.tree.submodules].find((s) =>
    candidates.some((c) => c.path === s || c.path.startsWith(`${s}/`)),
  );
  if (sub !== undefined) return { status: "in-submodule", submodule: sub };
  const actual = candidates
    .map((c) => idx.folded.get(c.path.toLowerCase()))
    .find((a) => a !== undefined);
  if (actual !== undefined) return { status: "case-mismatch", actual };
  const noted = elsewhere(idx, edge);
  if (noted !== undefined) return noted;
  const near = candidates
    .map((c) => nearest(idx, c.path))
    .find((n) => n !== undefined);
  return near === undefined
    ? { status: "missing" }
    : { status: "missing", didYouMean: edge.dir ? `${near}/` : near };
}

/** Code-point order, so two engines in two locales sort alike. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every reference of these sources and imports, resolved against `tree`, in
 * file-then-line order. `files` holds the text of each import's `from`, to
 * place an import an adapter reported without a line.
 */
export function referenceGraph(input: {
  readonly sources: readonly ReferenceSource[];
  readonly imports: readonly NamedImport[];
  readonly files: Readonly<Record<string, string>>;
  readonly tree: RepoTree;
}): readonly ResolvedReference[] {
  const idx = indexTree(input.tree);
  const edges = [
    ...input.imports.map((i) => importEdge(i, input.files)),
    ...input.sources.flatMap(sourceEdges),
  ];
  return edges
    .map((e) => ({ ...e, resolution: resolve(idx, e) }))
    .sort((a, b) => compareCodePoints(a.from, b.from) || a.line - b.line);
}
