/**
 * Fetch a public GitHub repo's HARNESS files into the repo-relative file map the
 * browser audit engine (`scanFiles`) consumes — entirely client-side, so nothing
 * leaves the visitor's browser but the GitHub requests themselves.
 *
 * Budget (keeps the anonymous 60-req/hr/IP limit rare): TWO api.github.com calls
 * per run — (1) the repo endpoint for `default_branch` (+ the clean 404/403
 * detection point), (2) one RECURSIVE Trees call — then the file CONTENTS come
 * from raw.githubusercontent.com, which is NOT rate-limited. The Trees response
 * carries each blob's `size`, so oversized files are skipped WITHOUT a fetch, and
 * only harness-shaped paths are read at all → ~2–10 requests total.
 *
 * The keys of the returned map are repo-relative POSIX paths — exactly what
 * `scanFiles` expects (the shape `src/scan-files.test.ts`'s `readDirToMap` builds).
 *
 * ── KNOWN LIMITATION (intentional — do NOT "fix" piecemeal) ──────────────────
 * This is a BOUNDED, SELECTIVE fetch, NOT the CLI's whole-repo read. To respect
 * GitHub's anonymous 60-req/hr/IP limit, only harness-shaped paths + the files they
 * reference are fetched (never the entire tree). So for an arbitrary repo the fetched
 * map CAN differ from what `vigiles audit` reads on disk.
 *
 * The design rule that makes this SAFE — and the INVARIANT any change here must keep
 * — is: NEVER GRADE PARTIAL DATA. Every incomplete path bails to an honest terminal
 * state instead of publishing a wrong grade:
 *   • a truncated GitHub tree, OR > MAX_FILES harness surfaces, OR required
 *     referenced files that exceed the fetch budget → `too-large` (points at the CLI).
 *   • any REQUIRED file (a harness surface, a referenced hook/script/config, a
 *     bundled resource — all feed GRADED findings) that fails to fetch → the
 *     retryable `error` state (not cached).
 *   • ADVISORY-only data (coverage test files — the `untested` count is excluded
 *     from the overall grade) is best-effort: its absence never errors and never
 *     changes the letter grade.
 *
 * Fetched to MATCH the CLI: harness surfaces (skills/agents/commands/hooks + CLAUDE.md
 * / .mcp.json), token + relative hook-script refs, manifest-declared hook configs
 * (chained via a bounded fixpoint), SKILL.md bundled resources, and coverage tests
 * outside the harness dirs. Documented NON-GOALS (not bugs): Codex-only repos
 * (AGENTS.md/.codex — the demo is Claude-Code-scoped → lands in no-harness → CLI),
 * `.vigilesrc.json` `sharedDirs` (rare), and Windows disk paths (unsupported OS).
 *
 * A review bot will keep surfacing ever-more-obscure "file X outside the harness
 * dirs isn't fetched" cases. Unless a case produces a WRONG GRADE (not just an
 * advisory discrepancy) AND isn't already covered by the too-large/error bail-outs
 * above, it is the ACCEPTED COST of the rate-limit-safe approximation, not a new bug.
 * Full rationale + the edge-case ledger: research/browser-demo-fetch-limits.md.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { executableSourceDirs } from "@engine/core/layout";
import { claudeCodeLayout } from "@engine/adapters/claude-code/layout";
import { claudeCodeDialect } from "@engine/adapters/claude-code/dialect";

import { normalizeSlug } from "@/lib/deeplink";

/** repo-relative POSIX path → file content — the `scanFiles` input shape. */
export type RepoFiles = Record<string, string>;

/** The terminal outcome of a fetch — a discriminated union the UI switches on. */
export type FetchOutcome =
  | {
      kind: "ok";
      files: RepoFiles;
      /** Total blob count in the repo tree (the "repo tree — N files" line). */
      treeCount: number;
      /** How many harness files were read (the loading counter's denominator). */
      harnessCount: number;
    }
  | { kind: "no-harness"; treeCount: number }
  | { kind: "marketplace" }
  | { kind: "not-found" }
  | { kind: "rate-limit" }
  | { kind: "too-large" }
  | { kind: "error"; message: string };

/** Honest loading progress — each event maps 1:1 to a real awaited request. */
export type FetchProgress =
  | { phase: "tree"; treeCount: number; harnessCount: number }
  | { phase: "file"; done: number; of: number };

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Mirror the engine's per-file cap — files over this are skipped (never fetched). */
const MAX_FILE_BYTES = 256 * 1024;
/** A sane ceiling on harness files read per run (a monorepo could match many). */
const MAX_FILES = 300;
/** How many raw content fetches run at once. */
const CONCURRENCY = 6;

// The browser demo grades CLAUDE CODE harnesses only (the engine's Codex audit is
// full-parity, but the demo doesn't wire the Codex layout/dialect yet — a follow-up).
// So we fetch only Claude-Code surfaces; a Codex-only repo (AGENTS.md / .codex) lands
// in the honest no-harness state that points at the CLI, not a report scanned with the
// wrong layout. Do NOT re-add AGENTS.md/.codex here without wiring the Codex adapter
// into runAudit — fetching a surface the scan then ignores is what produced the bug.
/**
 * Top-level files that ARE a harness surface on their own — DERIVED from the
 * Claude Code layout, not listed.
 *
 * 🔴 IT USED TO BE THE HAND-WRITTEN SET `["CLAUDE.md", ".mcp.json", "SKILL.md"]`,
 * the same shape `HARNESS_DIRS` below had already stopped being: a second place
 * naming files a layout already names, free to fall behind it. Two of the three
 * come straight off the layout now, so a harness that renames its instruction
 * file or its MCP config moves what the demo fetches with it.
 *
 * `SKILL.md` stays a literal because it is NOT a layout field: it is the
 * single-skill plugin shape (`loadPluginFromFiles`' "single-skill" case), where
 * the repo root IS the skill directory. Deriving it from `SURFACE_SHAPES` would
 * mean deriving a ROOT file from a DIRECTORY shape, which is a different fact.
 *
 * ⚠️ The per-machine sibling (`CLAUDE.local.md`) is deliberately absent, and its
 * absence is the same decision as `scope: "local"` in the engine: it is
 * gitignored by convention, so a GitHub tree can never carry it. Adding it here
 * would fetch a file that is never there and imply the demo could see one.
 *
 * 🔴 `instructionTargets` IS SPREAD HERE, AND IT IS WHAT KEEPS THE TWO ENGINES
 * AGREEING. Since v2.1.277 Claude Code reads `AGENTS.md` natively, so the CLI's
 * chain loads one — and a twin that fetched only `layout.instructionFile` would
 * hand the chain a map with no `AGENTS.md` in it and print a weight of zero for
 * a repository that really loads the file. Not a wrong DIGIT: a missing file,
 * on the browser side only, which is the CLI/browser disagreement the `scope`
 * rule exists to prevent. Spread rather than listed, so the dialect stays the
 * one place the filename lives.
 *
 * ⚠️ FETCHING IT IS NOT DETECTING ON IT. `isHarnessMarker` below still does not
 * accept a bare `AGENTS.md` as proof of a Claude Code harness, exactly as
 * `claudeCodeAdapter.detect` does not — that file is Codex's to own and this
 * harness only READS it. A repo holding nothing but an `AGENTS.md` still lands
 * in the no-harness state.
 */
const HARNESS_ROOT_FILES = new Set([
  ...claudeCodeDialect.instructionTargets,
  claudeCodeLayout.mcpConfigFile,
  "SKILL.md",
]);
/**
 * Any path segment equal to one of these is a harness directory — DERIVED from
 * the Claude Code layout, not listed.
 *
 * 🔴 IT USED TO BE A HAND-WRITTEN SET, and the engine had just finished
 * removing the same shape from the port itself: a second place naming the
 * directories a layout already names, free to fall behind it. It listed
 * `skills`, `agents`, `commands`, `hooks`, `.claude`, `.claude-plugin`; the
 * expression below produces exactly those six from `claudeCodeLayout`, and a
 * layout that moves a surface now moves what the demo fetches with it.
 *
 * The demo grades CLAUDE CODE harnesses only — see the note above — so this
 * derives from that ONE layout on purpose, rather than from the registry.
 */
const HARNESS_DIRS = new Set(
  [
    ...executableSourceDirs(claudeCodeLayout),
    claudeCodeLayout.userSurfaceRoot,
    claudeCodeLayout.manifestPath,
  ]
    .filter((d): d is string => d !== undefined)
    // First segment only: `isHarnessPath` compares the first segment of a path,
    // and a layout may name a nested dir (`.agents/skills`) or a file
    // (`.claude-plugin/plugin.json`).
    .map((d) => (d.includes("/") ? d.slice(0, d.indexOf("/")) : d)),
);

/**
 * A tree blob that's a harness surface: a top-level harness file, or a path whose
 * FIRST segment is a harness dir (a root `skills/`/`hooks/` or a `.claude`/
 * `.claude-plugin` root). Deliberately NOT "any segment" — a normal repo's nested
 * `src/hooks/useThing.ts` or `packages/x/skills/` must not be mistaken for a Claude
 * harness (which would grade an empty machine instead of showing the no-harness
 * state). Referenced scripts outside these dirs are picked up by the 2nd fetch pass.
 */
export function isHarnessPath(path: string): boolean {
  if (!path.includes("/")) return HARNESS_ROOT_FILES.has(path);
  return HARNESS_DIRS.has(path.slice(0, path.indexOf("/")));
}

// A test / eval file the coverage check (findUntestedSurfaces) reads to decide a
// surface is tested. These often live OUTSIDE the harness dirs (a top-level
// `tests/`/`__tests__/`, or a colocated `*.eval.mjs`/`*.test.ts`), so they must be
// fetched for the Tested category to match the CLI's whole-repo read. NOT a harness
// marker — a repo of only tests is still no-harness.
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|harness|eval)\.[cm]?[jt]sx?$/;
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/**
 * A path that PROVES the repo is a Claude Code harness — not merely a repo that
 * happens to contain a dir named `hooks`/`skills`/… (a git-hooks `hooks/`, a React
 * app's `src/hooks/`). The harness GATE requires at least one, so an ordinary repo
 * lands in the no-harness state instead of a bogus grade. Markers: `CLAUDE.md`, an
 * `.mcp.json`, anything under `.claude/`/`.claude-plugin/`, the hook convention file
 * `hooks/hooks.json`, or a REAL top-level surface FILE (`skills/<x>/SKILL.md`,
 * `agents/<x>.md`, `commands/<x>.md`). A bare top-level `hooks/` of scripts with no
 * declaration is NOT a harness — the loader only treats hooks as loadable when
 * declared via a manifest / settings / `hooks/hooks.json`.
 */
export function isHarnessMarker(path: string): boolean {
  if (path === "CLAUDE.md" || path === ".mcp.json" || path === "SKILL.md")
    return true;
  if (path.startsWith(".claude/") || path.startsWith(".claude-plugin/"))
    return true;
  if (path === "hooks/hooks.json") return true;
  return (
    /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
    /^agents\/[^/]+\.md$/.test(path) ||
    /^commands\/.+\.md$/.test(path)
  );
}

/**
 * A hook-config file a plugin manifest points its `hooks` field at (e.g.
 * `.claude-plugin/plugin.json` with `"hooks": "config/hooks.json"`). That file can
 * live OUTSIDE the harness dirs, so the harness-path filter drops it and the scan's
 * `readHooksJsonFile` then finds nothing → every hook silently dropped. Return the
 * referenced repo-relative path so the 2nd fetch pass pulls it.
 */
function manifestHookConfig(files: RepoFiles): string | null {
  for (const p of [".claude-plugin/plugin.json", "plugin.json"]) {
    const text = files[p];
    if (text === undefined) continue;
    try {
      const m = JSON.parse(text) as { hooks?: unknown };
      if (typeof m.hooks === "string") return m.hooks.replace(/^\.\//, "");
    } catch {
      // A malformed manifest is the scan's concern, not this fetch helper's.
    }
  }
  return null;
}

/**
 * Repo-relative paths a harness file references but that the harness-path filter
 * drops — hook scripts living OUTSIDE the harness dirs. The CLI reads the whole repo,
 * so to stay byte-identical the browser fetches any referenced path present in the
 * tree (else the scan reports a real hook script as missing + a graded penalty).
 * Two forms: (1) plugin-root / project-dir tokens (`${CLAUDE_PLUGIN_ROOT}/scripts/
 * guard.sh`, braced or unbraced); (2) a RELATIVE dir-qualified script path (`scripts/
 * guard.sh`, `./bin/x.sh`) — the form `scanHooks` resolves against the plugin root.
 * Over-matching is harmless: only tree-present paths are fetched (a real file the scan
 * simply ignores if unreferenced), bounded by the size + count caps.
 */
const ROOT_REF =
  /\$\{?(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?\/([A-Za-z0-9._/-]+)/g;
const REL_SCRIPT =
  /(?:^|[\s"'`(=:,])(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb))(?=$|[\s"'`),;])/gm;
// A SKILL.md's BUNDLED RESOURCES (the scan's `skillResourceIssues` verifies these):
// a `scripts/`/`references/`/`assets/`-prefixed path with any extension, or a
// markdown link to a relative file. The harness filter fetches the SKILL.md but
// drops non-script resources at the REPO ROOT (a root single-skill repo's
// `references/api.md`), so the scan would falsely flag them missing; fetch the
// tree-present ones. (Nested-skill resources under `skills/**` are already fetched.)
const BUNDLE_RES =
  /(?:^|[\s"'`(=:,])(?:\.\/)?((?:scripts|references|assets)\/[\w./-]+\.[A-Za-z0-9]+)/gm;
const MD_LINK_REL =
  /\[[^\]]*\]\((?!\w+:\/\/|\/|#|mailto:)(?:\.\/)?([\w./-]+\.[A-Za-z0-9]+)(?:[?#][^)]*)?\)/g;

const isSkillFile = (path: string): boolean =>
  path === "SKILL.md" || path.endsWith("/SKILL.md");

export function collectReferencedPaths(files: RepoFiles): Set<string> {
  const out = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    // Hook-script refs are graded from ANY file (a hook command lives in a
    // manifest / settings / hook config), so scan them everywhere.
    for (const m of content.matchAll(ROOT_REF)) out.add(m[1]);
    for (const m of content.matchAll(REL_SCRIPT)) out.add(m[1]);
    // Bundled-resource refs are graded ONLY from a SKILL.md body
    // (skillResourceIssues), so collect them there alone — else a CLAUDE.md's
    // ordinary `[doc](docs/x.md)` links would be treated as REQUIRED files and
    // could wrongly bail the whole repo to too-large/error (a repo the CLI grades).
    if (isSkillFile(path)) {
      for (const m of content.matchAll(BUNDLE_RES)) out.add(m[1]);
      for (const m of content.matchAll(MD_LINK_REL)) out.add(m[1]);
    }
  }
  return out;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** Classify a non-OK GitHub API response into a terminal outcome (or null = ok-ish). */
function classifyError(res: Response): FetchOutcome | null {
  if (res.status === 404) return { kind: "not-found" };
  if (res.status === 403 || res.status === 429) {
    // The anonymous rate limit: 403/429 with the remaining counter at 0.
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      return { kind: "rate-limit" };
    }
    return { kind: "rate-limit" };
  }
  return null;
}

/** Fetch a repo's harness file map, reporting honest per-request progress. */
export async function fetchRepo(
  rawSlug: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  const slug = normalizeSlug(rawSlug);
  if (slug === null) return { kind: "error", message: "unparseable repo" };
  const [owner, repo] = slug.split("/");

  try {
    // (1) Repo endpoint → default branch (and the earliest 404/403 signal).
    const metaRes = await fetch(`${API}/repos/${owner}/${repo}`, { signal });
    if (!metaRes.ok) {
      const err = classifyError(metaRes);
      if (err) return err;
      return { kind: "error", message: `GitHub responded ${metaRes.status}` };
    }
    const meta = (await metaRes.json()) as { default_branch?: string };
    const branch = meta.default_branch ?? "main";

    // (2) One recursive Trees call → every blob path + size.
    const treeRes = await fetch(
      `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
        branch,
      )}?recursive=1`,
      { signal },
    );
    if (!treeRes.ok) {
      const err = classifyError(treeRes);
      if (err) return err;
      return { kind: "error", message: `GitHub responded ${treeRes.status}` };
    }
    const tree = (await treeRes.json()) as {
      tree?: TreeEntry[];
      truncated?: boolean;
    };
    // GitHub truncates the recursive tree for very large repos (>100k entries or
    // >7MB), so the harness files we need may be outside the returned slice — we'd
    // misreport no-harness or grade a partial harness. Bail honestly to the CLI.
    if (tree.truncated === true) return { kind: "too-large" };
    const blobs = (tree.tree ?? []).filter((e) => e.type === "blob");
    const treeCount = blobs.length;

    // A plugin MARKETPLACE (`.claude-plugin/marketplace.json`) is a COLLECTION of
    // plugins, not one gradeable harness — the CLI expands + ranks its members via
    // `inspectMarketplace`, a path the browser demo doesn't run. Grading it as a
    // single plugin would render a bogus zero-surface F. So route a marketplace-only
    // repo to its own honest state. A repo that ALSO ships `plugin.json` is a single
    // plugin self-publishing a 1-member marketplace → grade it normally (plugin.json
    // wins, the branch falls through).
    const blobPaths = new Set(blobs.map((b) => b.path));
    if (
      blobPaths.has(".claude-plugin/marketplace.json") &&
      !blobPaths.has(".claude-plugin/plugin.json")
    ) {
      return { kind: "marketplace" };
    }

    const harnessAll = blobs
      .filter((e) => isHarnessPath(e.path))
      .filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES);

    // The harness GATE: matching harness-SHAPED paths isn't enough — require a
    // definitive marker (isHarnessMarker), so a repo whose only match is a
    // git-hooks `hooks/` or a nested source dir lands in no-harness, not a grade.
    // Checked on the FULL set so a marker BEYOND the file cap isn't sliced away
    // first (which would falsely report no-harness for a big plugin).
    if (!harnessAll.some((e) => isHarnessMarker(e.path))) {
      return { kind: "no-harness", treeCount };
    }
    // More harness surfaces than the browser can read fully → don't grade a
    // PARTIAL harness (dropped skills/agents/hooks would misreport the inventory
    // and grade); bail honestly to the CLI, same as a truncated tree.
    if (harnessAll.length > MAX_FILES) return { kind: "too-large" };
    const harness = harnessAll;
    onProgress?.({ phase: "tree", treeCount, harnessCount: harness.length });

    // (3) Content from raw.githubusercontent.com (NOT rate-limited), pooled.
    const files: RepoFiles = {};
    const sizeOf = new Map(blobs.map((b) => [b.path, b.size ?? 0]));
    let done = 0;
    let total = harness.length;
    let failed = 0;
    // `countFailure` distinguishes a REQUIRED fetch (a harness surface or a
    // referenced hook/config/resource — a failure means a partial GRADE, so it
    // errors) from an ADVISORY one (a coverage test file — its absence only changes
    // the excluded-from-grade `untested` count, so a failure is tolerated).
    const fetchBlob = async (
      entry: TreeEntry,
      countFailure = true,
    ): Promise<void> => {
      const url = `${RAW}/${owner}/${repo}/${encodeURIComponent(
        branch,
      )}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
      try {
        const res = await fetch(url, { signal });
        if (res.ok) files[entry.path] = await res.text();
        else if (countFailure) failed += 1;
      } catch (e) {
        // An abort is intentional; any other error is a real fetch failure.
        if (
          countFailure &&
          !(e instanceof DOMException && e.name === "AbortError")
        )
          failed += 1;
      }
      done += 1;
      onProgress?.({ phase: "file", done, of: total });
    };
    const drain = async (
      entries: TreeEntry[],
      countFailure = true,
    ): Promise<void> => {
      const queue = [...entries];
      const worker = async (): Promise<void> => {
        for (;;) {
          const entry = queue.shift();
          if (entry === undefined) return;
          await fetchBlob(entry, countFailure);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker),
      );
    };

    await drain(harness);
    // A harness SURFACE that failed to fetch (a transient 500 / CORS drop on
    // SKILL.md, .claude/settings.json, an agent…) would leave the grade computed
    // over a PARTIAL harness. Return the retryable error state instead of grading
    // incomplete data.
    if (failed > 0) {
      return { kind: "error", message: "some files couldn't be fetched" };
    }

    // Second pass (bounded FIXPOINT): fetch what the harness files REFERENCE but the
    // path filter drops — hook scripts via the plugin-root token / relative paths,
    // a manifest-declared hook-config file (`"hooks": "config/hooks.json"`), and a
    // SKILL.md's bundled resources (`references/*`, `assets/*`). Re-scan after each
    // round so a newly-fetched config's OWN script refs resolve too (manifest →
    // config/hooks.json → scripts/guard.sh). Bounded to tree-present paths, the size
    // + file caps, and a small round limit — byte-identical with the CLI's whole-repo
    // read for realistic chains without unbounded fetching.
    const inTree = new Set(blobs.map((b) => b.path));
    for (let round = 0; round < 3; round += 1) {
      const referenced = collectReferencedPaths(files);
      const manifestHooks = manifestHookConfig(files);
      if (manifestHooks !== null) referenced.add(manifestHooks);
      const eligible = [...referenced]
        .filter((p) => inTree.has(p) && !(p in files))
        .filter((p) => (sizeOf.get(p) ?? 0) <= MAX_FILE_BYTES);
      if (eligible.length === 0) break;
      const budget = MAX_FILES - Object.keys(files).length;
      // These referenced files feed GRADED findings (a missing hook / script /
      // bundled resource is penalized), so if they don't fit the budget, grading
      // would be over a PARTIAL repo — bail to too-large rather than slice off
      // required files (mirrors the first-pass harness cap).
      if (eligible.length > budget) return { kind: "too-large" };
      const extra = eligible.map(
        (path) => ({ path, type: "blob" }) as TreeEntry,
      );
      total += extra.length;
      await drain(extra);
    }
    // These second-pass files are all REQUIRED (a dropped hook config drops every
    // hook; a missing script / bundled resource is a graded finding), so the same
    // partial-data rule applies here as to the first pass.
    if (failed > 0) {
      return { kind: "error", message: "some files couldn't be fetched" };
    }

    // Coverage (ADVISORY, best-effort): the untested-surface check reads test files
    // that can live OUTSIDE the harness dirs (`tests/foo.test.ts`, a top-level eval),
    // which the harness filter drops — so without them the browser shows a false
    // `untested` advisory the CLI (whole-repo read) wouldn't. Fetch tree-present
    // test-shaped files, budget-bounded; a failure does NOT error (untested is
    // excluded from the overall grade, so a missing test is cosmetic, not a wrong
    // grade — that's why `countFailure` is false here).
    const covBudget = MAX_FILES - Object.keys(files).length;
    if (covBudget > 0) {
      const tests = blobs
        .filter((e) => isTestPath(e.path) && !(e.path in files))
        .filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES)
        .slice(0, covBudget);
      if (tests.length > 0) {
        total += tests.length;
        await drain(tests, false);
      }
    }

    return { kind: "ok", files, treeCount, harnessCount: harness.length };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { kind: "error", message: "aborted" };
    }
    return {
      kind: "error",
      message: e instanceof Error ? e.message : "network error",
    };
  }
}
