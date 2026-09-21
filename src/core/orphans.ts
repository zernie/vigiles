/**
 * Orphan-docs detection: the inverse of stale-reference validation.
 *
 * Stale-ref detection catches specs that point at files which no longer
 * exist. Orphan detection catches files which exist but no spec or README
 * points at — docs that quietly rot in `docs/` and `research/` because
 * nothing tells the agent they're still load-bearing.
 *
 * The detector operates purely on the filesystem: it enumerates markdown
 * files under configured doc roots and scans every `.md` in the repo for
 * references (markdown links and backtick paths). Works against source
 * README plus compiled CLAUDE.md — no spec loading required.
 */

import { readFileSync } from "node:fs";
import { resolve, posix } from "node:path";
import { globSync } from "glob";

import type { PluginLayout } from "./layout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanReport {
  /** Include globs that were scanned. */
  readonly include: readonly string[];
  /** Total docs discovered under those globs. */
  readonly totalDocs: number;
  /** Docs referenced from at least one other `.md` file. */
  readonly referencedDocs: readonly string[];
  /** Docs that exist but no other `.md` references them. */
  readonly orphans: readonly string[];
}

export interface FindOrphansOptions {
  /** Repository root. Defaults to `process.cwd()`. */
  readonly basePath?: string;
  /**
   * Glob patterns of `.md` files to scan. Defaults to `["docs/**\/*.md"]`
   * (`docs/` is the near-universal convention; a vigiles-specific dir like
   * `research/` is opted into explicitly). Set to `[]` to disable scanning,
   * or to your project's doc globs (e.g. `["wiki/**\/*.md"]`) to override.
   */
  readonly include?: readonly string[];
  /** Glob patterns to exclude within the include scope (orphan CANDIDACY only). */
  readonly exclude?: readonly string[];
  /**
   * The repo-wide `.vigilesrc.json#exclude` (the ExcludeSet string face,
   * src/exclude.ts). Applied to BOTH walks — candidates AND the reference scan —
   * so an excluded corpus can neither be an orphan nor keep one alive (#192).
   * The CLI always passes it; a direct library caller may omit it.
   */
  readonly repoExclude?: readonly string[];
  /**
   * Harnesses whose surface files (instruction file, `SKILL.md`, subagents,
   * commands) are load-bearing by location and thus never orphan CANDIDATES
   * (still counted as referencers). Injected by the CLI from the registered
   * adapters so core stays harness-agnostic; a direct caller passes its own.
   * Omitted ⇒ only the universal `SKILL.md` convention is exempt.
   */
  readonly layouts?: readonly PluginLayout[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_INCLUDE = ["docs/**/*.md"] as const;

const DEFAULT_IGNORE = [
  "node_modules/**",
  "dist/**",
  ".vigiles/**",
  ".git/**",
] as const;

/**
 * A doc carrying this marker opts out of orphan detection — the inline escape
 * hatch, mirroring `vigiles-disable require-instructions-spec` and `vigiles:ignore-test`.
 * Use it for an intentionally-unreferenced doc (a changelog, a top-level index)
 * that nothing else links to but is not rot.
 */
const DISABLE_RE = /<!--\s*vigiles-disable\s+orphan-docs\s*-->/;

/** The one universal cross-harness skill-entry filename (CC + Codex). */
const SKILL_FILE = "SKILL.md";

/**
 * Files the HARNESS loads directly — its instruction file
 * (`layout.instructionFile`, e.g. `CLAUDE.md` / `AGENTS.md`), a skill
 * (`SKILL.md`), a subagent (`<surfaces.agent>/*.md`), or a slash command
 * (`<surfaces.command>/*.md`) — are load-bearing by their NAME/LOCATION, not because
 * another `.md` links to them. They are categorically NOT docs, so they are
 * never orphans even when `orphans.include` broadens to the whole repo.
 *
 * The surface names come from the INJECTED layouts, so core stays
 * harness-agnostic — no Claude Code literal here; the CLI passes every
 * registered adapter's layout, and `SKILL.md` is the one universal convention.
 * (They are still scanned as REFERENCERS, so a real doc that only a `CLAUDE.md`
 * links to is still credited — this exemption only removes them from the
 * orphan-CANDIDATE set.)
 */
function isHarnessLoadedFile(
  path: string,
  layouts: readonly PluginLayout[],
): boolean {
  const norm = normalizePath(path);
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  if (base === SKILL_FILE) return true;
  for (const layout of layouts) {
    if (base === layout.instructionFile) return true;
    // Subagent / slash-command surfaces live at a REAL surface root — the repo
    // root or the user-surface root (e.g. `.claude/`) — NOT any nested dir that
    // merely shares the name. A doc under `docs/prompts/` is documentation, not
    // Codex's `prompts` command surface. (This listed the user-surface root and
    // the materialize root separately; they are one field now, so the set it
    // built is unchanged and can no longer hold two different values.)
    const roots = [
      "",
      ...[layout.userSurfaceRoot]
        .filter((r): r is string => !!r)
        .map((r) => `${r}/`),
    ];
    for (const dir of [layout.surfaces.agent, layout.surfaces.command]) {
      if (dir && roots.some((r) => norm.startsWith(`${r}${dir}/`))) {
        return true;
      }
    }
  }
  return false;
}

// Match markdown links ](path.md) or ](path.md#anchor)
const LINK_RE = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;

// Match backtick code spans wrapping a path ending in .md
const BACKTICK_RE = /`([^`\s]+\.md)`/g;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** True when a doc opts out of orphan detection via the inline disable marker. */
function isOrphanExempt(absPath: string): boolean {
  try {
    return DISABLE_RE.test(readFileSync(absPath, "utf-8"));
  } catch {
    return false; // unreadable — treat like any other doc
  }
}

/** Discover docs under `include`, dropping any that carry the inline opt-out. */
function collectDocs(
  basePath: string,
  include: readonly string[],
  ignore: readonly string[],
  layouts: readonly PluginLayout[],
): Set<string> {
  const docs = new Set<string>();
  for (const pattern of include) {
    for (const p of globSync(pattern, { cwd: basePath, ignore: [...ignore] })) {
      if (isHarnessLoadedFile(p, layouts)) continue; // harness files are never orphans
      if (isOrphanExempt(resolve(basePath, p))) continue;
      docs.add(normalizePath(p));
    }
  }
  return docs;
}

function extractRefs(content: string): string[] {
  const refs: string[] = [];
  for (const m of content.matchAll(LINK_RE)) refs.push(normalizePath(m[1]));
  for (const m of content.matchAll(BACKTICK_RE)) refs.push(normalizePath(m[1]));
  return refs;
}

/**
 * Repo-root-relative targets a reference could mean, from a given source file.
 * Markdown links are conventionally **file-relative** (a `[x](foo.md)` in
 * `research/README.md` points at `research/foo.md`, and `../docs/x.md` walks up),
 * but docs also write **root-relative** paths (`research/foo.md` from anywhere).
 * We credit both so a real link is never miscounted as an orphan.
 */
function refTargets(sourcePath: string, ref: string): string[] {
  const targets = new Set<string>([ref]); // root-relative reading
  const dir = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  // file-relative reading: resolve against the source's directory.
  const resolved = normalizePath(posix.normalize(dir ? `${dir}/${ref}` : ref));
  targets.add(resolved);
  return [...targets];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find docs under `include` globs that no other markdown file references.
 *
 * A doc is considered referenced when some OTHER `.md` file in the repo
 * links to it via `[text](path.md)` or mentions it in a backtick span like
 * `` `docs/foo.md` ``. Self-references don't count — an orphan that only
 * links to itself is still an orphan.
 *
 * `include` and `exclude` are tsconfig-style glob arrays. Default include
 * is `["docs/**\/*.md"]` (the common convention); override per-project via
 * `.vigilesrc.json` → `orphans.include` (whose presence also opts the repo
 * into the scan — see the CLI gate in `vigiles lint`).
 */
export function findOrphanDocs(options: FindOrphansOptions = {}): OrphanReport {
  const basePath = options.basePath ?? process.cwd();
  const include = options.include ?? DEFAULT_INCLUDE;
  const userExclude = options.exclude ?? [];
  // Two exclusions with two jobs (#192). `repoExclude` is the repo-wide
  // `.vigilesrc.json#exclude` — a vendored corpus is neither an orphan
  // CANDIDATE nor a SOURCE of references (a link from inside it must not keep a
  // doc alive). The rule's own `exclude` only narrows candidacy: a doc kept out
  // of the orphan list can still reference others. Union, never override.
  const repoExclude = options.repoExclude ?? [];
  const ignore = [...DEFAULT_IGNORE, ...repoExclude, ...userExclude];
  const layouts = options.layouts ?? [];

  const allDocs = collectDocs(basePath, include, ignore, layouts);

  const allMarkdown = globSync("**/*.md", {
    cwd: basePath,
    ignore: [...DEFAULT_IGNORE, ...repoExclude],
  });
  const referencedBy = new Map<string, Set<string>>();

  for (const mdPath of allMarkdown) {
    const source = normalizePath(mdPath);
    let content: string;
    try {
      content = readFileSync(resolve(basePath, mdPath), "utf-8");
    } catch {
      continue;
    }
    for (const rawRef of extractRefs(content)) {
      for (const target of refTargets(source, rawRef)) {
        if (target === source) continue;
        let sources = referencedBy.get(target);
        if (!sources) {
          sources = new Set();
          referencedBy.set(target, sources);
        }
        sources.add(source);
      }
    }
  }

  const orphans: string[] = [];
  const referencedDocs: string[] = [];
  for (const doc of [...allDocs].sort()) {
    if (referencedBy.has(doc)) referencedDocs.push(doc);
    else orphans.push(doc);
  }

  return {
    include: [...include],
    totalDocs: allDocs.size,
    referencedDocs,
    orphans,
  };
}

/** Format an orphan report as human-readable text. */
export function formatOrphanReport(report: OrphanReport): string {
  if (report.orphans.length === 0) {
    return `✓ no orphan docs (${String(report.totalDocs)} scanned across ${report.include.join(", ") || "no include patterns"})`;
  }
  const lines = [
    `✗ ${String(report.orphans.length)} orphan doc(s) — referenced by no other .md:`,
  ];
  for (const o of report.orphans) lines.push(`    ${o}`);
  lines.push(
    "  Fix: link each from another .md (README, a spec's Key Files, or a doc).",
    "  To silence: add `<!-- vigiles-disable orphan-docs -->` to the doc, or",
    "  exclude it via .vigilesrc.json → `orphans.exclude` (or narrow `orphans.include`).",
  );
  return lines.join("\n");
}
