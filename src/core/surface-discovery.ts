/**
 * Surface DISCOVERY — WHERE a repo's loadable surfaces are, answered by SHAPE
 * over a BOUNDED set of roots, BEFORE anything asks which harness this repo is.
 *
 * 🔴 WHY THIS MODULE EXISTS — THE ORDER OF THE TWO QUESTIONS WAS BACKWARDS.
 * The tool asked "which ONE harness is this?" first and then trusted the winning
 * {@link PluginLayout} to name the directories. `PluginLayout` does two jobs at
 * once — it is the DIALECT (what the harness understands) and the SEARCH PATH
 * (where to look) — so a repo whose skills sit somewhere no shipped layout names
 * was not merely unread, it was graded anyway. Measured by an outside adopter
 * (#240, vigiles 27.2.0): 37 skills, 24 over-budget descriptions and 14 missing
 * bundled resources under `.ai/` produced
 *
 *     Detected harness: codex
 *     Harness health: A (100/100)
 *     ✓ no structural issues found
 *
 * while the same binary pointed straight at `<repo>/.ai` graded it F (0/100).
 * Same repo, same commit, same version — the grade decided by one positional
 * argument, and the one nobody would question was the wrong one.
 *
 * ── THE DEPENDENCY DIRECTION THIS BUYS ──────────────────────────────────────
 * Discovery is the DOMAIN's job and an adapter cannot widen it. A harness
 * adapter answers only the pure question `claims(path)` — "is this path mine?" —
 * so it can LABEL what was already found and nothing else. The property:
 * **registering a new adapter cannot make vigiles read more in anyone's
 * repository.** The rejected alternative (each adapter declares roots, the audit
 * walks the union) inverts that: adding a Cursor adapter would start reading
 * `.cursor/rules` in every user's repo, and a surface no adapter declared would
 * stay invisible — the blindness preserved. See `research/audit-harness-dx.md`
 * §9 for the four options and why this one.
 *
 * And the corollary that makes it a product statement rather than a refactor: a
 * surface NOBODY claims is a FINDING, not silence. That is this tool's own thesis
 * applied to itself — a passing signal standing in for work nobody did.
 *
 * ── THE BOUND, AND WHY IT IS NOT A PORT ─────────────────────────────────────
 * Walking the whole repo is not an option and the reporter of #240 said why
 * before we did: an unbounded `**\/SKILL.md` in that repo finds 53 VENDORED
 * third-party plugin skills beside the 37 real ones and grades them as one
 * machine. So discovery looks in the repo root, plus each of its DEPTH-1
 * DOT-DIRECTORIES ({@link isDiscoveryRoot}). The reason that set is the right shape —
 * every harness convention puts its tree in a top-level dot-directory
 * (`.claude`, `.codex`, `.agents`, `.cursor`, `.gemini`, `.opencode`,
 * `.windsurf`, and #240's `.ai`), and an ordinary source tree does not. Cost is
 * one `readdir` of the repo root plus one per dot-directory, then descent ONLY
 * into a directory named by {@link SURFACE_SHAPES} — never into `src/`,
 * `packages/` or anything else.
 *
 * It is a DOMAIN CONSTANT, not a port method, and that is load-bearing: if an
 * adapter could add a root we would be back to the inverted dependency above.
 *
 * ⚠️ KNOWN LIMITATION, NAMED RATHER THAN FAKED — the Codex WALK-UP is still not
 * expressed. The vendor scans `.agents/skills` in EVERY directory from the cwd up
 * to the repository root; this bound covers `<root>/.agents/skills` only, so a
 * subdirectory's own `.agents/skills` stays invisible. Reaching it means walking
 * arbitrary directories, which is exactly what the paragraph above refuses. For
 * the normal case — `vigiles audit` at the repo root — the root IS the whole
 * walk-up chain, so the gap is a monorepo subpackage, not the common shape.
 *
 * Pure, IO-free and Node-free ON PURPOSE, exactly as `surface-scopes.ts` is: the
 * disk loader (`src/scan.ts` via `src/surface-discovery-fs.ts`) and the browser
 * file-map twin (`src/scan-files.ts`) each enumerate paths from their own storage
 * and call THIS for the decision, so the pair this repo has repeatedly been
 * bitten by fixing on one side only cannot disagree about what a surface is.
 */
import {
  AGENT_FILE_LEAF_RE,
  materializePrefix,
  surfaceDirs,
  type PluginLayout,
  type SurfaceKind,
} from "./layout.js";

/** A surface kind discovery can recognize from a path alone. */
export type DiscoveredKind = "skill" | "agent" | "command";

/**
 * The SHAPE of each surface kind: the directory name that holds it, and the
 * path tail that makes a file inside it loadable.
 *
 * These are the CROSS-VENDOR names, not one harness's: Codex's skills live at
 * `.agents/skills`, Claude Code's at `skills` or `.claude/skills` — the same
 * `skills` segment under a different root, which is why the root is the variable
 * and the shape name is not. The tails quote the classifier the scan already
 * uses (`makeClassifier`, scan-core.ts): a skill is `<name>/SKILL.md`, an agent
 * is read RECURSIVELY per {@link AGENT_FILE_LEAF_RE} (do not hard-code a depth
 * here — that header says why), a command is any `.md` below the dir.
 *
 * Codex's `prompts` is deliberately absent: it is claimed by `codexLayout` and
 * read by the loader, and giving a non-dot word like `prompts` shape status at
 * the repo root would match ordinary prompt-engineering directories that are not
 * a harness surface at all.
 */
export const SURFACE_SHAPES: ReadonlyArray<{
  readonly dir: string;
  readonly kind: DiscoveredKind;
  readonly tail: string;
}> = [
  { dir: "skills", kind: "skill", tail: "[^/]+/SKILL\\.md" },
  { dir: "agents", kind: "agent", tail: AGENT_FILE_LEAF_RE },
  { dir: "commands", kind: "command", tail: ".+\\.md" },
];

/** One surface found by shape, and the bounded root it was found under. */
export interface DiscoveredSurface {
  readonly kind: DiscoveredKind;
  /** Repo-relative POSIX path of the loadable file. */
  readonly path: string;
  /** The discovery root it sits under — `""` for the repo root. */
  readonly root: string;
  /** The surface directory, repo-relative (`.ai/skills`, `skills`, …). */
  readonly dir: string;
}

/**
 * Is this repo-root-relative DIRECTORY NAME one of the bounded discovery roots?
 *
 * The repo root itself is always one (`""`). Everything else must be a
 * DOT-directory — see the module header for why that is the whole bound. The
 * caller supplies the names (a `readdir` on disk, the key set in the browser),
 * so this function stays IO-free.
 */
export function isDiscoveryRoot(name: string): boolean {
  return name === "" || (name.startsWith(".") && name !== "." && name !== "..");
}

/**
 * `<root>/<shape.dir>/<tail>` for every shape — the one place the anchor lives.
 *
 * Anchored at the START: the shape dir sits DIRECTLY under a discovery root,
 * never at arbitrary depth. That is what stops a React app's `src/hooks/…`-class
 * false positive and a monorepo's `packages/x/skills/…` from being graded as
 * this repo's harness. Built once — these carry no `g` flag, so `exec` keeps no
 * state between calls.
 */
const SHAPE_MATCHERS: ReadonlyArray<{
  readonly kind: DiscoveredKind;
  readonly dir: string;
  readonly re: RegExp;
}> = SURFACE_SHAPES.map((s) => ({
  kind: s.kind,
  dir: s.dir,
  re: new RegExp(`^(?:([^/]+)/)?${s.dir}/${s.tail}$`),
}));

/**
 * Every surface a set of repo-relative paths holds, by SHAPE — harness-blind.
 *
 * `paths` must already be bounded by the caller's walk; this re-checks the root
 * rule anyway so the browser twin (which hands over the whole fetched key set)
 * gets the same answer as the disk walk.
 */
export function discoverSurfaces(
  paths: readonly string[],
): readonly DiscoveredSurface[] {
  const out: DiscoveredSurface[] = [];
  for (const path of paths) {
    for (const m of SHAPE_MATCHERS) {
      const hit = m.re.exec(path);
      if (hit === null) continue;
      const root = hit[1] ?? "";
      if (!isDiscoveryRoot(root)) continue;
      out.push({
        kind: m.kind,
        path,
        root,
        dir: root === "" ? m.dir : `${root}/${m.dir}`,
      });
      break; // one path is one surface; first shape wins, as the classifier does
    }
  }
  return out;
}

/** Trim a trailing `/`, and treat `"."`/`""` as "no location at all". */
function located(dir: string | undefined): string | null {
  if (dir === undefined) return null;
  const d = dir.replace(/\/+$/, "");
  return d === "" || d === "." ? null : d;
}

/**
 * Every repo-relative location a layout READS — the raw material for
 * {@link layoutClaims}.
 *
 * Derived from the layout rather than listed per adapter, so a layout that moves
 * (as `codexLayout` just did, `.codex/skills` → `.agents/skills`) moves its claim
 * with it and the two cannot drift.
 *
 * ⚠️ The materialize prefix goes through {@link located} because `codexLayout`
 * has none (`""`) and a directory prefix of `""` is meaningless. It is DEFENCE IN DEPTH,
 * not the load-bearing guard, and the difference was MEASURED rather than
 * assumed: removing this filter alone leaves `layoutClaims(codexLayout,
 * "src/index.ts")` at `false`, because the boundary form `path.startsWith(`${d}/`)`
 * in {@link layoutClaims} already refuses a `""` prefix (no repo-relative path
 * starts with `/`). Both have to go before Codex claims the whole repository —
 * which is the combined mutation `surface-discovery.test.ts` pins, precisely
 * because removing either one on its own is survivable and would otherwise read
 * as "this line is protecting us".
 */
export function layoutLocations(layout: PluginLayout): {
  readonly dirs: readonly string[];
  readonly files: readonly string[];
} {
  const user = located(layout.userSurfaceRoot);
  const dirs = new Set<string>();
  const add = (d: string | null): void => {
    if (d !== null) dirs.add(d);
  };
  add(located(materializePrefix(layout)));
  add(user);
  for (const s of surfaceDirs(layout)) {
    add(located(s));
    if (user !== null) add(located(`${user}/${s}`));
  }
  const rules = located(layout.rulesDir);
  if (rules !== null) {
    add(rules);
    if (user !== null) add(`${user}/${rules}`);
  }
  for (const p of [
    layout.manifestPath,
    layout.settingsPath,
    layout.hooksConventionPath,
  ]) {
    // `hooksConventionPath` is optional now — a harness whose hooks are code
    // modules has none. Absent contributes no dir and no file, which is what
    // the old `""` sentinel was filtered into below anyway.
    if (p === undefined) continue;
    const at = p.lastIndexOf("/");
    if (at > 0) add(p.slice(0, at));
  }
  return {
    dirs: [...dirs],
    files: [
      layout.instructionFile,
      layout.mcpConfigFile,
      layout.manifestPath,
      layout.settingsPath,
      layout.hooksConventionPath,
    ].filter((f): f is string => f !== undefined && f !== ""),
  };
}

/**
 * Does this layout's harness READ this repo-relative path — "is it mine?"
 *
 * The ONE answer behind every adapter's `claims`, so an adapter cannot express a
 * claim its own layout contradicts. Pure: a string question about a string, with
 * no filesystem and no knowledge of what else exists.
 */
export function layoutClaims(layout: PluginLayout, path: string): boolean {
  const { dirs, files } = layoutLocations(layout);
  if (files.includes(path)) return true;
  return dirs.some((d) => path === d || path.startsWith(`${d}/`));
}

/**
 * Does a repo owner's DECLARED root cause this path to be read, under the
 * layout of the harness it was declared UNDER?
 *
 * 🔴 IT CLAIMS EXACTLY WHAT IT MAKES READABLE, AND NOT ONE PATH MORE. The set is
 * `<root>/<surfaceDir>/…` for that harness's own `surfaceDirs` — which is
 * verbatim the set `materializeSurfaces` reads for a declared scope. Derived
 * from the same field rather than listed twice, so the two cannot drift.
 *
 * The consequence is the point: a declaration silences the finding only where it
 * actually reaches. Declaring `.ai` under `"codex"` does not silence a
 * `.ai/skills/` tree, because Codex's skill dir is `.agents/skills` and
 * `.ai/skills` is still read by nobody. Under the flat `surfaceRoots` key that
 * was where the story ended — the tool stayed quiet about a declaration that
 * changed nothing. Now the harness is part of the declaration, so the same fact
 * is an ERROR the owner can act on ({@link unresolvedDeclaredRoots}).
 *
 * ⚠️ A declaration is the REPO OWNER's, never an adapter's. Nothing here lets a
 * harness widen what vigiles reads in someone else's repository — the property
 * the module header exists to protect. See `research/audit-harness-dx.md` §9.
 */
export function declaredRootClaims(
  layout: PluginLayout,
  roots: readonly string[],
  path: string,
): boolean {
  return declaredRootDirs(layout, roots).some(
    (dir) => path === dir || path.startsWith(`${dir}/`),
  );
}

/**
 * The repo-relative dirs a declaration REACHES: `<root>/<surfaceDir>` for every
 * declared root crossed with this layout's own surface dirs.
 *
 * ONE derivation, read two ways — {@link declaredRootClaims} asks whether a
 * found path is in the set, {@link unresolvedDeclaredRoots} asks whether any
 * member of the set exists on disk. Two spellings of "where does this
 * declaration reach" is how a declaration could be claimed by one and refused by
 * the other.
 */
export function declaredRootDirs(
  layout: PluginLayout,
  roots: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const r of roots)
    for (const surface of surfaceDirs(layout)) {
      const dir = located(`${r}/${surface}`);
      if (dir !== null && !out.includes(dir)) out.push(dir);
    }
  return out;
}

/** One declared harness as this module needs it: a name and its layout + roots. */
export interface DeclaredRootScope {
  /** The harness KEY the root was declared under. */
  readonly harness: string;
  readonly layout: PluginLayout;
  readonly roots: readonly string[];
}

/**
 * Declared roots that reach NO directory on disk — the one silent state the
 * nested shape would otherwise keep (#240).
 *
 * 🔴 WHY THIS IS AN ERROR AND NOT A WARNING. A root under a harness whose layout
 * keeps that surface somewhere else is not a near-miss, it is a statement that
 * cannot be true: `{"codex": {"roots": [".ai"]}}` over a `.ai/skills/` tree makes
 * vigiles look at `.ai/.agents/skills/` and `.ai/prompts/`, finds neither, reads
 * nothing, and changes not one line of the report. The owner wrote a line
 * believing their skills were now graded. Silence there is the tool agreeing.
 *
 * ⚠️ IT CHECKS THE DIRECTORY, NOT ITS CONTENTS, and the difference is
 * deliberate: an EMPTY `.ai/skills/` is a real, correctly-declared home that
 * happens to hold nothing today, and failing a build over an empty directory
 * would be a gate on repo state rather than on the declaration. What is refused
 * is a declaration that names no directory at all.
 *
 * `dirExists` is injected (repo-relative path in, boolean out) so the rule is
 * pure, node-free and testable without a filesystem — the same contract every
 * other decision in this module keeps.
 */
export function unresolvedDeclaredRoots(
  scopes: readonly DeclaredRootScope[],
  dirExists: (repoRelativeDir: string) => boolean,
): readonly string[] {
  const out: string[] = [];
  for (const scope of scopes) {
    for (const root of scope.roots) {
      const looked = declaredRootDirs(scope.layout, [root]);
      if (looked.some((d) => dirExists(d))) continue;
      out.push(
        `.vigilesrc.json: harnesses["${scope.harness}"].roots names "${root}", ` +
          `but ${scope.harness} reads no surface there — nothing would be graded and ` +
          `nothing would be said.\n` +
          `  Looked for: ${looked.length === 0 ? "(this harness declares no surface dirs)" : looked.map((d) => `${d}/`).join(", ")}\n` +
          `  Either create one of those, or declare "${root}" under the harness whose ` +
          `layout does read it.`,
      );
    }
  }
  return out;
}

/**
 * The discovered surfaces NO registered harness claims — the finding.
 *
 * `claimers` is every registered adapter's `claims`, so "unclaimed" means "no
 * harness vigiles knows about reads this", not "the detected harness does not".
 * That distinction is the whole point of discovering before detecting: a repo
 * carrying both `.claude/skills` and `.agents/skills` has each half claimed by a
 * different adapter and neither is a finding, while #240's `.ai/skills` is
 * claimed by nobody and becomes one.
 */
export function unclaimedSurfaces(
  surfaces: readonly DiscoveredSurface[],
  claimers: ReadonlyArray<(path: string) => boolean>,
): readonly DiscoveredSurface[] {
  return surfaces.filter((s) => !claimers.some((c) => c(s.path)));
}

/**
 * The unclaimed surfaces, grouped into ONE finding per directory.
 *
 * A finding per FILE would put 37 lines in #240's report for one mistake; the
 * actionable unit is the directory nobody reads, so that is the unit counted and
 * the unit graded.
 */
export function unclaimedDirs(
  unclaimed: readonly DiscoveredSurface[],
): ReadonlyArray<{
  readonly dir: string;
  readonly root: string;
  readonly kind: DiscoveredKind;
  readonly count: number;
}> {
  const by = new Map<
    string,
    { root: string; kind: DiscoveredKind; count: number }
  >();
  for (const s of unclaimed) {
    const prev = by.get(s.dir);
    if (prev === undefined)
      by.set(s.dir, { root: s.root, kind: s.kind, count: 1 });
    else prev.count += 1;
  }
  return [...by.entries()]
    .map(([dir, v]) => ({ dir, root: v.root, kind: v.kind, count: v.count }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** One directory of surfaces that no registered harness reads. */
export interface UnclaimedSurfaceFinding {
  /** The unread surface directory, repo-relative (`.ai/skills`). */
  readonly dir: string;
  readonly kind: DiscoveredKind;
  /** How many loadable files it holds. */
  readonly count: number;
  /** The report line, worded ONCE so the disk scan and the browser twin agree. */
  readonly message: string;
}

/** Plural-aware surface noun — `1 skill` / `37 skills`. */
function plural(kind: DiscoveredKind, n: number): string {
  return `${String(n)} ${kind}${n === 1 ? "" : "s"}`;
}

/**
 * Where the given layouts DO keep the surface of one kind — the "move it here
 * instead" half of the finding message.
 *
 * 🔴 DERIVED, NOT SPELLED OUT, and the repo's own `core-not-adapter` rule is
 * what forced it: the first draft of the message listed "`.claude/skills/`,
 * `skills/`, `.agents/skills/`" as a literal and the linter rejected it as a
 * Claude Code constant hard-coded in harness-agnostic code. It was right beyond
 * the letter of the rule — a hand-written list of homes is exactly the thing
 * that stops being true when a layout moves (as `codexLayout` did the same day,
 * `.codex/skills` → `.agents/skills`), and the finding would then tell the
 * reader to move their skills somewhere no harness reads.
 */
function knownHomes(
  layouts: readonly PluginLayout[],
  kind: DiscoveredKind,
): readonly string[] {
  // `DiscoveredKind` and `SurfaceKind` are the same three words; the cast is the
  // one place they are related, and it is here rather than in the port because a
  // discovered kind is a fact about a PATH the domain found, not about a layout.
  const dirOf = (l: PluginLayout): string | undefined =>
    l.surfaces[kind as SurfaceKind];
  const homes = new Set<string>();
  for (const l of layouts) {
    const dir = located(dirOf(l));
    if (dir === null) continue;
    homes.add(dir);
    const user = located(l.userSurfaceRoot);
    if (user !== null) homes.add(`${user}/${dir}`);
  }
  return [...homes].sort();
}

/**
 * The whole discovery verdict in one call: paths in, findings out.
 *
 * The ENTRY POINT both producers use (`src/scan.ts` over a bounded disk walk,
 * `src/scan-files.ts` over the fetched key set), so the wording, the grouping
 * and the claim rule cannot differ between the CLI and the in-browser audit.
 *
 * It takes LAYOUTS rather than bare predicates because the answer needs both
 * halves of the same fact: who claims a path, and where those claimants
 * actually keep that kind of surface. Taking them apart is how the message and
 * the claim rule would come to disagree.
 *
 * `declared` is the repo owner's opt-in: one entry per harness declared in
 * `.vigilesrc.json#harnesses`, each carrying the roots declared under it and the
 * LAYOUT those roots are read with. It joins the claimers rather than filtering
 * the findings afterwards, so "no harness reads this" and "this is read" stay
 * ONE question with one answer. Omitted by the browser twin, which has no
 * config — see {@link declaredRootClaims} for what it does and does not silence.
 *
 * ⚠️ `exclude` needs no mention here and that is structural, not an oversight:
 * an excluded path never reaches `paths` (the walk drops it), so it can be
 * neither a finding nor a graded surface however it was declared.
 */
export function unclaimedSurfaceFindings(
  paths: readonly string[],
  layouts: readonly PluginLayout[],
  declared?: readonly DeclaredRootScope[],
): readonly UnclaimedSurfaceFinding[] {
  const claimers = layouts.map((l) => (path: string) => layoutClaims(l, path));
  // ONE claimer per DECLARED HARNESS, not one for "the declaration". Under the
  // flat shape there was a single (detected layout, global roots) pair, so a repo
  // serving one tree to two harnesses could silence the finding for at most one
  // of them; each declaration now carries the layout it was made under.
  for (const scope of declared ?? [])
    if (scope.roots.length > 0)
      claimers.push((path) =>
        declaredRootClaims(scope.layout, scope.roots, path),
      );
  return unclaimedDirs(
    unclaimedSurfaces(discoverSurfaces(paths), claimers),
  ).map((d) => ({
    ...d,
    message:
      `${d.dir}/ holds ${plural(d.kind, d.count)} that no harness vigiles knows about reads, ` +
      `so none of it is in this grade. Three ways out: keep it where it is and say so in ` +
      // A worked EXAMPLE config in a diagnostic, and real debt: it names a
      // harness the repo being audited may not even target, while `layouts` is
      // already in scope here and knows which one it does.
      // eslint-disable-next-line local/no-harness-names -- example config text
      `.vigilesrc.json (\`{"harnesses":{"claude-code":{"roots":["${d.root === "" ? "." : d.root}"]}}}\` ` +
      `— see docs/configuration.md), audit it on its own ` +
      `(\`vigiles audit ${d.root === "" ? "." : d.root}\`), or move it somewhere a harness ` +
      `loads from (${knownHomes(layouts, d.kind)
        .map((h) => `\`${h}/\``)
        .join(", ")}).`,
  }));
}
