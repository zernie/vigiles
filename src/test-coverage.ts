/**
 * Untested-surface detection: the third gap detector, alongside orphan-docs.
 *
 * Stale-ref detection catches specs pointing at files that vanished.
 * Orphan-docs catches docs nothing references. This catches harness *surfaces*
 * — skills, subagents, and hooks — that ship without a test or eval. A surface
 * with no test is a probabilistic-compliance gap hiding in the deterministic
 * layer: nothing measures whether it still does what it claims.
 *
 * TWO detectors decide "tested", in this order — **execution, then name, then
 * nothing** — and the report says which one answered:
 *
 *   1. EXECUTION — `.vigiles/coverage.json` records that a run exercised this
 *      surface, at this version of it (`coverage-artifact.ts`).
 *   2. COLOCATION — a `*.{harness,eval}.mjs` named after the surface, beside it
 *      (`skills/foo/foo.eval.mjs`, `hooks/pre-edit.harness.mjs`).
 *
 * Colocation was the only detector until 2026-08-11, and it answers a weaker
 * question than it appears to: it says a FILE EXISTS. `touch
 * .claude/skills/foo/foo.eval.mjs` — empty — drops the untested count by one.
 * No other coverage tool answers by name (`go test -cover`, coverage.py, nyc,
 * tarpaulin all answer from execution, using names only to FIND the file); we
 * kept the name because a skill cannot be run without a model, and a repo with
 * no runs recorded must behave exactly as it did before.
 *
 * A run recorded against an OLDER version of the surface grants nothing — it is
 * reported as `staleRuns` and the surface falls back to colocation. Silently
 * counting it is the PIPELINE-STATUS disease: a tick against a document that was
 * rewritten afterwards.
 *
 * There were three until 2026-08-11 (a `vigiles:covers` declaration, colocation,
 * and a content-reference "mention"). They were three NAMING CONVENTIONS, not
 * three strengths of evidence, and two of them could credit a surface no test
 * touched — measured on vigiles's own repo, `mention` supplied 9 of 10 covered
 * surfaces and at least three of those were false, including two hooks credited
 * by this detector's OWN test suite naming them as fixtures. See
 * `coverage-evidence.ts` for the full argument and the numbers.
 *
 * Colocation is kept because it cannot drift by construction: the test lives with
 * the surface, so deleting or renaming the surface takes its test along, and `ls`
 * answers "is this tested?" without running anything.
 *
 * Warning-by-default (a nudge, not a gate). EVERY skill, agent, and hook is held
 * to the requirement — invocation mode does NOT exempt anything (a command-only
 * skill still DOES something when invoked, and that behaviour is worth a test).
 * The only opt-out is explicit: a `vigiles:ignore-test` marker in the surface
 * file, which is reported as `exempt` so the skip is visible, never silent.
 *
 * TWO TIERS, discovered SEPARATELY — a harness and an eval are not the same thing
 * and collapsing them at discovery makes the difference unrecoverable downstream:
 *
 *   | | harness (`*.harness.*`) | eval (`*.eval.*`) |
 *   |---|---|---|
 *   | cost    | free                          | paid model calls    |
 *   | cadence | every push                    | scheduled           |
 *   | answers | "does this gate still catch what it claims?" | "does this skill FIRE at all?" |
 *
 * So a repo with complete deterministic coverage and no evals is a DIFFERENT
 * position from a repo with neither, and "add a test/eval" spans three orders of
 * magnitude in cost without saying which. {@link UntestedReport} therefore carries
 * a per-tier {@link CoverageTier} alongside the (unchanged) union fields.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { testFileExt } from "./core/test-file-ext.js";
import { assertNever } from "./core/assert-never.js";
import { canRunTypeScript, detectNodeCaps } from "./ts-runner-caps.js";
import { globSync } from "glob";
import {
  AGENT_FILE_LEAF_RE,
  agentSurfaceName,
  type PluginLayout,
} from "./core/layout.js";
import { claudeCodeLayout } from "./adapters/claude-code/layout.js";
import {
  countEvidence,
  declaredSurfaceName,
  evidenceFor,
  formatEvidence,
  hookScriptRefs,
  isColocatedTest,
  isEvalScript,
  prepareTest,
  type CoverageEvidence,
  type EvidenceCounts,
  type PreparedTest,
  discoveryGlob,
  matchesSurfaceGlob,
  strongerEvidence,
} from "./coverage-evidence.js";
import {
  canonicalScript,
  indexRuns,
  readCoverageArtifact,
  surfaceSha,
  type CoverageTierName,
  type ExecutedRecord,
} from "./coverage-artifact.js";

/**
 * The two on-disk locations a surface dir can occupy: the plugin-root form
 * (`skills/…`) and the materialized form (`.claude/skills/…`) — derived from the
 * layout so a non-Claude-Code harness (its own `materializeRoot` / surface dir)
 * is discovered without hard-coding `.claude`. An empty `dir` (a harness lacking
 * the surface, e.g. Codex subagents) yields no globs.
 */
function surfaceGlobs(
  dir: string,
  leaf: string,
  materializeRoot: string,
): string[] {
  if (!dir) return [];
  const matForm = materializeRoot ? `${materializeRoot}/${dir}` : dir;
  return [...new Set([`${dir}/${leaf}`, `${matForm}/${leaf}`])];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SurfaceKind = "skill" | "agent" | "hook";

export interface Surface {
  readonly kind: SurfaceKind;
  /** Repo-relative path to the surface file (SKILL.md / agent .md / hook script). */
  readonly path: string;
  /** Stable name: skill dir, agent basename, or hook script basename. */
  readonly name: string;
  /** Substrings a test may reference to "cover" this surface (path / namespace). */
  readonly tokens: readonly string[];
  /** Explicitly opted out of the test requirement via `vigiles:ignore-test`. */
  readonly ignored: boolean;
}

/**
 * WHY one surface counts as covered — the provenance of a single decision.
 * Reported so a repo can see what its coverage number actually rests on; a count
 * whose derivation is invisible is exactly the failure this detector had.
 */
export interface CoverageDecision {
  readonly surface: Surface;
  readonly evidence: CoverageEvidence;
  /** The test file the (strongest) evidence came from. */
  readonly by: string;
}

/** A surface measured by a run that no longer describes it. */
export interface StaleRun {
  /** Repo-relative path of the surface. */
  readonly path: string;
  /** The script whose run measured the older version. */
  readonly by: string;
  /** When that run happened (ISO-8601). */
  readonly at: string;
}

/** A test file whose NAME is why it does not count — see `retiredTestNames`. */
export interface RetiredTestName {
  /** Repo-relative path of the file that will not count. */
  readonly path: string;
  /** Repo-relative path of the untested surface it sits beside. */
  readonly surface: string;
}

/** One tier's split of the considered surfaces — covered by THAT tier, or not. */
export interface CoverageTier {
  readonly covered: readonly Surface[];
  readonly untested: readonly Surface[];
  /** One entry per `covered` surface, in the same order — how it was decided. */
  readonly decisions: readonly CoverageDecision[];
}

export interface UntestedReport {
  /** Total surfaces considered (after exemptions). */
  readonly total: number;
  /** Covered by EITHER tier — the union, unchanged (a test anywhere counts). */
  readonly covered: readonly Surface[];
  /** Covered by NEITHER tier — the union, unchanged. */
  readonly untested: readonly Surface[];
  /** Surfaces explicitly opted out via `vigiles:ignore-test`. */
  readonly exempt: number;
  /**
   * Test files still carrying the RETIRED `vigiles:covers` marker.
   *
   * 🔴 A MIGRATION THAT WOULD OTHERWISE BE SILENT. Up to 15.0.2 this tool's own
   * untested finding told the reader to "mark what it covers with
   * `vigiles:covers <surface>`". That tier is gone: coverage is decided by where
   * a test sits and what it is named. Someone who followed the instruction gets
   * no error on upgrade — the marker simply becomes a comment, their coverage
   * drops and the count of untested surfaces rises with nothing said about why.
   *
   * Reading these files does NOT feed coverage (nothing inside a test can change
   * it any more); it exists purely so the upgrade can explain itself. Optional
   * so a report produced before this field still parses.
   */
  readonly legacyCoversFiles?: readonly string[];
  /**
   * Files sitting beside an UNTESTED surface, named after it, and carrying a
   * suffix a default vitest/jest run collects — `<surface>.test.*`,
   * `<surface>.spec.*`.
   *
   * 🔴 THE OTHER HALF OF THE SAME 15.x MIGRATION, and it was the silent one.
   * `vigiles:covers` got a note; `*.test.*` leaving {@link DEFAULT_TEST_GLOBS}
   * did not, on the reasoning recorded there that "the migration is a rename,
   * and the untested finding prints the exact path". The path it prints is the
   * SURFACE's, plus a suggestion to add `<surface>.eval.mjs` — so an author
   * looking at `foo.test.mjs` lying right next to `foo/SKILL.md` is told to
   * write a test they already wrote, and nothing names the file or the reason.
   *
   * Scoped to surfaces that are otherwise UNCOVERED, which is exactly the
   * position where the count contradicts what the author can see. A stray
   * `*.test.*` beside a properly covered surface is somebody's ordinary unit
   * test and none of our business. Optional so an older report still parses.
   */
  readonly retiredTestNames?: readonly RetiredTestName[];
  /** Extension a generated test should use — see `core/test-file-ext.ts`.
   *  Optional so a report produced before this field still parses. */
  readonly testExt?: string;
  /**
   * How each covered surface was decided — the union tier's provenance, one
   * entry per `covered` element. A coverage count whose derivation is invisible
   * is what let a COMMENT confer coverage unnoticed; this is the visibility.
   */
  readonly decisions: readonly CoverageDecision[];
  /**
   * Surfaces whose ONLY run record predates their current text — "measured, but
   * not this version".
   *
   * They grant no coverage (they fall back to colocation like anything else),
   * because a measurement of a file that has since been rewritten is a
   * measurement of a different file. Reported rather than dropped, since the
   * silent version of this is the PIPELINE-STATUS failure mode: a green tick
   * against a document somebody edited afterwards. Optional so a report produced
   * before this field still parses.
   */
  readonly staleRuns?: readonly StaleRun[];
  /**
   * DETERMINISTIC coverage only — `*.harness.*`, plus any custom `include`.
   * Free, millisecond, every-push. Answers "does this gate still catch what it
   * claims?" (`*.test.*` has NOT counted since 15.x — see DEFAULT_TEST_GLOBS.)
   */
  readonly harness: CoverageTier;
  /**
   * REAL-MODEL coverage only — `*.eval.mjs`. Paid, minutes, scheduled. Answers
   * the one question the deterministic tier cannot: "does this skill FIRE at all?"
   */
  readonly evals: CoverageTier;
}

export interface TestCoverageOptions {
  /** Repository root. Defaults to `process.cwd()`. */
  readonly basePath?: string;
  /** Scan skills under `skills/` and `.claude/skills/`. Default true. */
  readonly skills?: boolean;
  /** Scan subagents under `agents/` and `.claude/agents/`. Default true. */
  readonly agents?: boolean;
  /** Scan hook scripts referenced from plugin.json / settings.json. Default true. */
  readonly hooks?: boolean;
  /** Globs of test files that count as coverage. */
  readonly include?: readonly string[];
  /**
   * Which extension a GENERATED test gets. Detection (a tsconfig.json, a
   * typescript dependency) decides by default; this field exists only to
   * disagree with it. Deliberately NOT written by `init`: a value recorded at
   * initialisation goes stale in silence when the project migrates, while
   * detection re-runs every time.
   *
   * From `.vigilesrc.json` it arrives as `rules["untested-skill"][1].testExtension`
   * (or the `-subagent` / `-hook` twin — the three share their options). The
   * previous wording here said only "from `.vigilesrc.json`", which read as a
   * promise the CLI did not keep: `TestCoverageConfig` had no such key and
   * `checkUntestedSurfaces` forwarded only `include`/`exclude`, so a configured
   * `mjs` was silently ignored on any TypeScript-shaped repo.
   */
  readonly testExtension?: string;
  /** Extra ignore globs (added to node_modules/dist/.git/.vigiles). */
  readonly exclude?: readonly string[];
  /**
   * Harness layout — where skills/agents live, the plugin-root token, the
   * manifest/settings paths. Defaults to Claude Code; a non-CC adapter passes its
   * own so the surface globs and hook-token expansion aren't hard-coded.
   */
  readonly layout?: PluginLayout;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Every extension Node executes directly. `.mts`/`.cts` are real (TS 4.7+) and
 * Node 22 strips their types with no toolchain — measured, not assumed. */
const RUNNABLE_EXTS = "{ts,mts,cts,js,mjs,cjs}";

/**
 * 🔴 `*.test.*` USED TO BE HERE, AND REMOVING IT IS THE POINT.
 *
 * Those six entries matched the default patterns of vitest and jest EXACTLY
 * (read out of the installed packages, not from memory):
 *
 *   vitest  **\/*.{test,spec}.?(c|m)[jt]s?(x)
 *   jest    **\/?(*.)+(spec|test).?([mc])[jt]s?(x)
 *           **\/__tests__\/**\/*.?([mc])[jt]s?(x)   ← everything in that dir
 *
 * vigiles never RAN those files, but it CREDITED them — so an author writing a
 * skill test reasonably named it `foo.test.mjs`, and then `npx vitest` ran it.
 * A skill test calls `runHarnessTest`/`measureTriggerRate`: it spawns a model and
 * SPENDS MONEY, silently, on every push. Measured: a spike put
 * `.claude/skills/foo/foo.test.mjs` in a bare project and plain `npx vitest run`
 * executed it — the "it lives under a dot-directory so nothing else will see it"
 * assumption is false.
 *
 * With those entries gone the guarantee becomes one sentence a reader can hold:
 * NOTHING VIGILES RECOGNISES IS MATCHED BY A DEFAULT VITEST OR JEST RUN.
 *
 * ⚠️ BREAKING: a repo whose hook is covered by an ordinary `pre-edit.test.ts`
 * loses that credit. The migration is a rename, and the untested finding prints
 * the exact path. Taken deliberately over the alternative — keeping the entries
 * for hooks/agents and dropping them for skills — because a rule with a per-kind
 * exception is what this file just spent a day removing.
 */
const DEFAULT_TEST_GLOBS = [
  `**/*.harness.${RUNNABLE_EXTS}`,
  `**/*.eval.${RUNNABLE_EXTS}`,
] as const;

const DEFAULT_IGNORE = [
  "node_modules/**",
  "dist/**",
  ".vigiles/**",
  ".git/**",
] as const;

const IGNORE_MARKER = "vigiles:ignore-test";

function read(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function discoverSkills(
  basePath: string,
  ignore: string[],
  layout: PluginLayout,
): Surface[] {
  const out: Surface[] = [];
  const found = globSync(
    surfaceGlobs(layout.skillDir, "*/SKILL.md", layout.materializeRoot),
    { cwd: basePath, ignore },
  );
  for (const path of found.sort()) {
    const name = basename(dirname(path));
    const content = read(join(basePath, path));
    out.push({
      kind: "skill",
      path,
      name,
      tokens: [`${layout.skillDir}/${name}`, `:${name}`],
      ignored: content.includes(IGNORE_MARKER),
    });
  }
  // Single-skill-directory target: a bare `SKILL.md` AT the base (the dir you
  // pointed lint/audit at). The globs above only match `<skillDir>/*/SKILL.md`
  // NESTED under the base, so without this the untested-skill check would silently
  // vanish for exactly the single-skill target that scoping now supports.
  const rootSkill = join(basePath, "SKILL.md");
  if (existsSync(rootSkill)) {
    // 🔴 The DECLARED name wins here, and only here. For a nested skill the
    // directory IS the identity (`skills/foo/SKILL.md` → `foo`), but the base of
    // a single-skill target is wherever the thing happens to be checked out —
    // a temp dir, `~/src/wip-2`, a CI workspace. Since colocation now requires
    // the test to be NAMED after the surface, taking the identity from the path
    // would ask the author to name their test after their checkout directory.
    const content = read(rootSkill);
    const name = declaredSurfaceName(content) ?? basename(basePath);
    out.push({
      kind: "skill",
      path: "SKILL.md",
      name,
      tokens: [`${layout.skillDir}/${name}`, `:${name}`],
      ignored: content.includes(IGNORE_MARKER),
    });
  }
  return out;
}

/**
 * The retired declaration marker, kept ONLY to explain its own removal.
 *
 * Written plainly. An earlier version split it (`` `vigiles:${"covers"}` ``) to keep
 * this source file from matching its own search — a precaution that was never
 * checked and is contradicted by the tree it lives in: the literal already appears
 * in five other files under `src/`, and the detector reads only files matching
 * `include` in the SCANNED repo, never vigiles' own sources.
 */
const LEGACY_COVERS = "vigiles:covers";

function discoverAgents(
  basePath: string,
  ignore: string[],
  layout: PluginLayout,
): Surface[] {
  const out: Surface[] = [];
  // The glob is a COARSE FETCH — deliberately wider than the rule — and
  // AGENT_FILE_LEAF_RE decides. Spelling the depth rule a second time in glob
  // dialect is exactly how these two discoverers drifted from the scan
  // classifier in the first place, so only one dialect is authoritative and the
  // other is allowed to over-match.
  const found = globSync(
    surfaceGlobs(layout.agentDir, "**/*.md", layout.materializeRoot),
    { cwd: basePath, ignore },
  );
  const prefixes = layout.materializeRoot
    ? [layout.agentDir, `${layout.materializeRoot}/${layout.agentDir}`]
    : [layout.agentDir];
  const isAgentFile = layout.agentDir
    ? new RegExp(
        `^(?:${[...new Set(prefixes)]
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})/${AGENT_FILE_LEAF_RE}$`,
      )
    : null;
  for (const path of found.sort()) {
    if (path.endsWith(".spec.ts")) continue;
    // Both the depth rule and the scoped name are written in POSIX (`/`), so
    // normalize ONCE and derive both from the same string. Normalizing for one
    // and not the other is how a Windows checkout would match the pattern and
    // then fail to find `agents/` when naming — silently falling back to a
    // basename, re-introducing the collision the scoped name exists to prevent.
    const rel = path.split(sep).join("/");
    if (isAgentFile && !isAgentFile.test(rel)) continue;
    const content = read(join(basePath, path));
    const name = agentSurfaceName(rel, layout.agentDir) ?? basename(rel, ".md");
    const dir = dirname(path);
    out.push({
      kind: "agent",
      path,
      name,
      tokens: [`${dir}/${name}`],
      ignored: content.includes(IGNORE_MARKER),
    });
  }
  return out;
}

/**
 * Hook-script paths referenced from a manifest's `hooks` block (file hooks only).
 *
 * The PARSING lives in `hookScriptRefs` (coverage-evidence.ts), shared with the
 * browser twin — see its header for why. This wrapper supplies only the two
 * disk-specific things: reading the manifest, and what "exists" means here.
 */
function hookScripts(
  basePath: string,
  manifest: string,
  layout: PluginLayout,
): string[] {
  const abs = join(basePath, manifest);
  if (!existsSync(abs)) return [];
  return hookScriptRefs(read(abs), layout, (rel) =>
    existsSync(join(basePath, rel)),
  );
}

function discoverHooks(basePath: string, layout: PluginLayout): Surface[] {
  const scripts = new Set<string>();
  // The harness's manifest + settings (and a `.local` settings sibling, a CC
  // convention that's harmless to probe elsewhere).
  const localSettings = layout.settingsPath.replace(/(\.[^./]+)$/, ".local$1");
  const manifests = [
    ...new Set([layout.manifestPath, layout.settingsPath, localSettings]),
  ];
  for (const m of manifests) {
    for (const s of hookScripts(basePath, m, layout)) scripts.add(s);
  }
  return [...scripts].sort().map((path) => ({
    kind: "hook" as const,
    path,
    name: basename(path).replace(/\.[^.]+$/, ""),
    tokens: [path],
    ignored: false,
  }));
}

function discoverTests(
  basePath: string,
  globs: readonly string[],
  ignore: string[],
): PreparedTest[] {
  // `dot: true` so a colocated test under a DOT directory is found — most
  // loose skills live in `.claude/skills/<name>/`, so the eval the warning
  // suggests (`.claude/skills/<name>/<name>.eval.mjs`) is itself dot-pathed.
  // Without this, a globstar (`**/*.eval.mjs`) silently skips it while the
  // skill (matched by the explicit-dot `.claude/skills/*/SKILL.md` pattern) is
  // still discovered — so the surface looks untested even after the user adds
  // exactly the suggested file. DEFAULT_IGNORE still drops .git/node_modules/etc.
  // `{surface}` is widened to `*` for DISCOVERY so one pass finds every
  // candidate; the narrowing back to a specific surface happens at match time
  // (matchesSurfaceGlob). Globbing once per surface would be quadratic in I/O.
  const found = globSync(globs.map(discoveryGlob), {
    cwd: basePath,
    ignore,
    dot: true,
  });
  // Prepared ONCE per file (comment-strip + declaration parse), not once per
  // (surface × file) pair — the matching below is quadratic by nature.
  return found.map((path) => prepareTest(path));
}

/**
 * Colocated: a test NAMED after the surface, SITTING BESIDE it. One rule, all
 * three kinds — a skill used to be exempt from both halves in turn.
 *
 * 🔴 THE NAME. Agents and hooks always required a name-prefixed basename; for a
 * skill the rule was "any file under the skill's directory". Those are different
 * claims — the second answers "is there a test NEAR this skill?", not "is there
 * a test FOR it" — and it is the substitution the removed `mention` tier made,
 * reached by a different route. Observed live: a repo's
 * `.claude/skills/paper-pipeline/` held six `*.eval.mjs`, exactly one about that
 * skill; the rest measured OTHER skills and sat there because the directory had
 * been the pipeline's home before tests moved next to their subjects. One was
 * literally `grade-paper-writing-ablation.eval.mjs`. The orchestrator scored as
 * covered and had no test of its own.
 *
 * 🔴 THE PLACE. A subdirectory (`skills/foo/tests/foo.harness.mjs`) is NOT
 * colocated, and dropping that allowance was measured rather than assumed. Across
 * two real repos exactly ONE nested test file exists, and it is
 * `verify-citations/scripts/verify-cites.test.mjs` — a unit test for a script the
 * skill BUNDLES, pinning that script's pure reducer. It is a good test of a
 * script and not a test of a skill, which is the whole distinction; the skill
 * carries its own two colocated files besides. So the allowance credited nothing
 * anyone wanted and cost the property that makes colocation worth having: `ls`
 * answers "is this tested?". With a subdirectory permitted, it takes `find`.
 *
 * That property is the entire argument for colocation over a parallel test tree
 * (`test/skills/foo_test.mjs`): the filesystem enforces the convention instead of
 * the reader having to trust it. Two permitted shapes is a choice at write time
 * and a lookup at read time, which is what convention-over-configuration exists
 * to remove.
 */
function isColocated(surface: Surface, testPath: string): boolean {
  return isColocatedTest(surface, testPath);
}

/**
 * The STRONGEST evidence any discovered test provides for this surface, or null.
 * Strongest — not first-found — so a surface that is both name-mentioned and
 * explicitly declared is reported as declared; otherwise the provenance summary
 * would depend on glob order.
 */
function coverageOf(
  surface: Surface,
  tests: readonly PreparedTest[],
  globs: readonly string[],
): CoverageDecision | null {
  let best: CoverageDecision | null = null;
  for (const t of tests) {
    if (t.path === surface.path) continue;
    const ev = evidenceFor(
      surface,
      t,
      isColocated(surface, t.path),
      matchesSurfaceGlob(surface, t.path, globs),
    );
    if (!ev) continue;
    // Rank, do not first-win: with a colocated harness AND a configured suite
    // the reported provenance must not depend on glob order.
    if (!best || strongerEvidence(ev, best.evidence))
      best = { surface, evidence: ev, by: t.path };
  }
  return best;
}

/**
 * Split the discovered tests into the two tiers — `*.eval.<runnable-ext>` is the
 * paid real-model tier, everything else (`*.harness.*` and any user-supplied
 * `include`) is the free deterministic tier. Decided by NAME, not by glob set,
 * so a custom `include` (a promptfoo suite, a home-grown loop) still lands in a
 * tier instead of silently disappearing from the split. The rule itself is
 * `isEvalScript` — shared with the browser twin, and see its header for the two
 * opposite ways this has been wrong.
 */
function partitionTests(tests: readonly PreparedTest[]): {
  harness: PreparedTest[];
  evals: PreparedTest[];
} {
  const harness: PreparedTest[] = [];
  const evals: PreparedTest[] = [];
  for (const t of tests)
    (isEvalScript(basename(t.path)) ? evals : harness).push(t);
  return { harness, evals };
}

/**
 * The FRESH run record for this surface in this tier, as a decision — or null.
 *
 * `tier` narrows to one runner (`vigiles test` vs `vigiles eval`) so an executed
 * harness cannot silence "nothing has ever measured whether this fires"; the
 * union pass passes `undefined` and takes either. Stale records are not
 * consulted here at all: they are reported separately, never counted.
 */
function executedOf(
  surface: Surface,
  index: ReadonlyMap<string, ExecutedRecord[]>,
  tier: CoverageTierName | undefined,
): CoverageDecision | null {
  for (const record of index.get(surface.path) ?? []) {
    if (!record.fresh) continue;
    if (tier !== undefined && record.run.tier !== tier) continue;
    return { surface, evidence: "executed", by: record.run.by };
  }
  return null;
}

/**
 * Split the considered surfaces by whether ONE tier covers them — a recorded run
 * first, a colocated test second. Execution outranks the name because the name
 * was only ever a stand-in for it.
 */
function tierOf(
  considered: readonly Surface[],
  tests: readonly PreparedTest[],
  index: ReadonlyMap<string, ExecutedRecord[]>,
  tier: CoverageTierName | undefined,
  globs: readonly string[],
): CoverageTier {
  const covered: Surface[] = [];
  const untested: Surface[] = [];
  const decisions: CoverageDecision[] = [];
  for (const s of considered) {
    const decision = executedOf(s, index, tier) ?? coverageOf(s, tests, globs);
    if (decision) {
      covered.push(s);
      decisions.push(decision);
    } else {
      untested.push(s);
    }
  }
  return { covered, untested, decisions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find harness surfaces (skills / agents / hooks) that no test or eval covers.
 * A surface is covered by a colocated `*.{harness,eval}.mjs` OR any discovered
 * test that references its path/namespace. EVERY skill, agent, and hook is held
 * to this — the only exemption is an explicit `vigiles:ignore-test` marker in the
 * surface file (counted as `exempt`).
 *
 * The `covered`/`untested` union fields are UNCHANGED (a test anywhere counts).
 * `harness` and `evals` carry the per-tier split so a caller can tell "has
 * deterministic coverage, no evals" from "has neither" — two positions the single
 * count made indistinguishable.
 */
export function findUntestedSurfaces(
  options: TestCoverageOptions = {},
): UntestedReport {
  const basePath = options.basePath ?? process.cwd();
  const layout = options.layout ?? claudeCodeLayout;
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];
  const globs = options.include ?? DEFAULT_TEST_GLOBS;

  const surfaces: Surface[] = [];
  if (options.skills !== false)
    surfaces.push(...discoverSkills(basePath, ignore, layout));
  if (options.agents !== false)
    surfaces.push(...discoverAgents(basePath, ignore, layout));
  if (options.hooks !== false)
    surfaces.push(...discoverHooks(basePath, layout));

  // Every skill/agent/hook is held to the requirement — only an explicit
  // `vigiles:ignore-test` marker exempts a surface (a visible, deliberate skip).
  const considered = surfaces.filter((s) => !s.ignored);
  const exempt = surfaces.length - considered.length;

  const tests = discoverTests(basePath, globs, ignore);
  const split = partitionTests(tests);
  // The run record, if there is one. NO artifact ⇒ an empty index ⇒ every
  // decision below falls through to colocation, byte-for-byte as before: a fresh
  // clone and someone else's repo must not get one extra nudge from this tier.
  const runIndex = indexRuns(
    readCoverageArtifact(basePath),
    (p) => {
      const abs = join(basePath, p);
      return existsSync(abs) ? surfaceSha(read(abs)) : null;
    },
    // The SCRIPT that did the exercising has to still be here too — a deleted or
    // renamed harness can never re-enter the retraction set, so without this its
    // record is permanent, unfalsifiable coverage. `canonicalScript` first: one
    // file has several legitimate spellings (`x.mjs`, `./x.mjs`, absolute), and
    // the artifact records whichever one was typed.
    (by) => existsSync(join(basePath, canonicalScript(by, basePath))),
  );
  const union = tierOf(considered, tests, runIndex, undefined, globs);

  return {
    total: considered.length,
    covered: union.covered,
    untested: union.untested,
    exempt,
    staleRuns: staleRunsFor(considered, runIndex),
    testExt: testFileExt({
      configured: options.testExtension,
      hasTsconfig: existsSync(join(basePath, "tsconfig.json")),
      packageJson: existsSync(join(basePath, "package.json"))
        ? read(join(basePath, "package.json"))
        : undefined,
      // Measured, not assumed: a `tsconfig.json` says the project IS TypeScript,
      // never that anything here can RUN a `.ts` script. Without this, a Node 20
      // repo with no local `tsx` was told to write `foo.harness.ts` and then
      // `vigiles test` refused to execute it.
      canRunTypeScript: canRunTypeScript(detectNodeCaps(basePath)),
    }),
    legacyCoversFiles: tests
      .map((t) => t.path)
      .filter((path) => read(join(basePath, path)).includes(LEGACY_COVERS)),
    retiredTestNames: retiredTestNamesFor(basePath, union.untested),
    decisions: union.decisions,
    harness: tierOf(considered, split.harness, runIndex, "harness", globs),
    evals: tierOf(considered, split.evals, runIndex, "eval", globs),
  };
}

/**
 * Surfaces with run records but no FRESH one — measured, then edited.
 *
 * Only reported when nothing fresh exists for the surface: a re-run refreshes
 * one record and leaves the old ones in the artifact, and complaining about
 * those would make the notice permanent and therefore ignorable.
 */
function staleRunsFor(
  considered: readonly Surface[],
  index: ReadonlyMap<string, ExecutedRecord[]>,
): StaleRun[] {
  const out: StaleRun[] = [];
  for (const s of considered) {
    const records = index.get(s.path) ?? [];
    if (records.length === 0 || records.some((r) => r.fresh)) continue;
    const newest = records.reduce((a, b) => (a.run.at >= b.run.at ? a : b));
    out.push({ path: s.path, by: newest.run.by, at: newest.run.at });
  }
  return out;
}

/** Suggested colocated test path for an untested surface (shown in the warning). */
export function suggestedTestPath(surface: Surface, ext = "mjs"): string {
  // A root skill lives at ".", so drop the "./" prefix — the suggested path then
  // matches what globSync actually discovers at the top level.
  const dir = dirname(surface.path);
  const prefix = dir === "." ? "" : `${dir}/`;
  if (surface.kind === "skill") {
    return `${prefix}${surface.name}.eval.${ext}`;
  }
  return `${prefix}${surface.name}.harness.${ext}`;
}

/** Tally the union tier's coverage decisions by how each was established. */
export function coverageEvidenceCounts(report: UntestedReport): EvidenceCounts {
  return countEvidence(report.decisions);
}

/**
 * The edit-time half of `untested-skill` — the nudge a PostToolUse hook delivers
 * when the agent has just edited a skill/agent surface.
 *
 * WHY it lives next to `findUntestedSurfaces` instead of being its own detector:
 * the rule was already stated correctly, but it only ran inside `vigiles lint`,
 * which a human has to remember to type. A rule that fires only when invoked by
 * hand is prose, not policy — so this reuses the SAME detector at the moment the
 * surface changes.
 *
 * It deliberately does NOT say "write a test". An agent already knows that; what
 * it did not know is **with what** — so the message's job is to hand off to the
 * `test-harness` skill, which carries the tier→API table. A nudge that restates
 * the obligation and withholds the vocabulary is the failure this replaces.
 *
 * Two distinguishable gaps, because they cost orders of magnitude apart:
 *   - no test at all        → start at the cheapest tier
 *   - a harness but no eval → you just changed the TRIGGER surface, and a
 *                             deterministic harness structurally cannot tell you
 *                             whether a description still fires
 *
 * Returns `null` when the edited file isn't a skill/agent surface, or when it is
 * covered on both tiers. Never throws — a nudge must not disrupt an edit.
 */
export function skillTestNudge(
  filePath: string,
  options: TestCoverageOptions = {},
): string | null {
  let report: UntestedReport;
  try {
    report = findUntestedSurfaces({ ...options, hooks: false });
  } catch {
    return null; // a broken scan must never surface as a broken edit
  }

  const norm = (p: string): string => p.replaceAll("\\", "/");
  const target = norm(filePath);
  const isTarget = (s: Surface): boolean =>
    norm(s.path) === target || target.endsWith(`/${norm(s.path)}`);

  const untested = report.untested.find(isTarget);
  if (untested)
    return (
      `vigiles: you edited ${untested.path}, and nothing measures whether it ` +
      `still does what it claims — no test or eval covers it.\n` +
      `Don't hand-roll a runner: the \`test-harness\` skill carries the ` +
      `tier→API table (runHook · runHarnessTest+scriptModel · ` +
      `measureTriggerRate · measure+judged · runEval) and picks the cheapest ` +
      `tier that can answer your question. Start there, then add e.g. ` +
      `${suggestedTestPath(untested, report.testExt)}.\n` +
      `This is a reminder, not a block.`
    );

  // Covered by SOMETHING, but never evaluated. WHAT the eval tier measures is a
  // property of the surface, not one sentence — see `evalTierQuestion`.
  const unevaluated = report.evals.untested.find(isTarget);
  const question = unevaluated ? evalTierQuestion(unevaluated.kind) : null;
  if (unevaluated && question)
    return (
      `vigiles: you edited ${unevaluated.path}. ${question}\n` +
      `This is a reminder, not a block.`
    );

  return null;
}

/**
 * What the PAID eval tier measures for a surface of this kind — or `null` when
 * it measures nothing for it.
 *
 * 🔴 THE REMEDY USED TO BE ONE SENTENCE, AND IT WAS THE SKILL'S. Every
 * never-evaluated surface was told its "description must FIRE" and pointed at
 * `measureTriggerRate`. An agent reaches that branch as readily as a skill —
 * `skillTestNudge` disables only hooks — and for an agent the sentence is false
 * twice over: firing is not the agent's eval-tier question, and
 * `measureTriggerRate` cannot address an agent at all.
 *
 * MEASURED 2026-08-12, no model spent, against this build:
 *
 * ```
 * packageSkillsDir("<repo>/agents")           → THREW: No <name>/SKILL.md skills
 *                                                found under <repo>/agents
 * measureTriggerRateWith({ pluginDir: <an     → rate = 0 | competitors = 0
 *   agents-only plugin> }, fakeRunner)
 * ```
 *
 * The loose-skills form throws; the plugin form returns a NUMBER for a surface
 * it never installed. That is the same failure the driver-argument note one
 * branch up already calls out — worse than an error, because it looks like a
 * measurement — and following the old wording produced it.
 *
 * ## Why this is keyed on `kind`, and what happens to a fourth one
 *
 * The real predicate is a CAPABILITY — "can the trigger tier install and observe
 * this surface?" — and today that is a total function of `kind`, because the
 * tier's installer is `<name>/SKILL.md`-shaped and its `fired` predicate is skill
 * SELECTION (`skillResolved`). So the capability is stated once per kind here,
 * rather than inferred from a name at the call site.
 *
 * The switch is exhaustive over {@link SurfaceKind} with `assertNever`: a fourth
 * kind does not silently inherit the skill's sentence, it fails to COMPILE until
 * someone writes what the eval tier measures for it. If the trigger tier ever
 * grows an agent installer, this table is the single place that changes.
 */
export function evalTierQuestion(kind: SurfaceKind): string | null {
  switch (kind) {
    case "skill":
      // An edit to a SKILL.md is usually an edit to the description — i.e. to
      // the trigger surface itself.
      //
      // 🔴 THE REMEDY NAMES THE DRIVER ARGUMENT, because a bare
      // `measureTriggerRate` is not this repo's measurement. The nudge is
      // layout-aware, so it reaches repos targeting a harness other than the
      // eval tier's default — and `measureTriggerRate(spec)` falls back to that
      // DEFAULT driver. Following the old wording there did not fail: it
      // measured a different harness's trigger rate and reported it as a number.
      return (
        `A deterministic test covers it, but nothing has ever measured whether ` +
        `its description actually FIRES — and a harness structurally cannot ` +
        `tell you that.\n` +
        `See the \`test-harness\` skill for which tier answers it ` +
        `(\`measureTriggerRate\`, plus \`irrelevantPrompts\` for the precision ` +
        `side). Pass your harness's driver — ` +
        `\`measureTriggerRate(spec, { evalDriver })\` — because a bare call runs ` +
        `the eval tier's DEFAULT harness, which may not be the one this repo ` +
        `targets.`
      );
    case "agent":
      // An agent is dispatched BY NAME through `Task` and carries a tool
      // contract, so the eval-tier question is not selection — it is whether a
      // REAL model honours the contract. The deterministic test that already
      // covers it drove a scripted model, which cannot answer that.
      //
      // ⚠️ It does NOT offer `{ evalDriver }` here, and that is checked rather
      // than assumed: `runEval`/`measure`/`measureArms` all hard-wire
      // `spawnAgent`, and `runEvalWith` is not exported from `vigiles/eval` —
      // `measureTriggerRate` is the only public call with that seam. Suggesting
      // an argument the function does not take is this finding's own defect.
      return (
        `A deterministic test covers it, but that test drove a SCRIPTED model. ` +
        `Nothing has measured whether a REAL model, handed this agent's prompt, ` +
        `stays inside its tool contract and returns the result it promises.\n` +
        `NOT \`measureTriggerRate\`: it installs \`<name>/SKILL.md\` skills and ` +
        `decides "fired" by skill SELECTION, so it cannot address an agent — ` +
        `pointed at an agents-only plugin it reports rate 0.0 over 0 ` +
        `competitors instead of failing (measured).\n` +
        `See the \`test-harness\` skill: run the real-model tier (\`runEval\` / ` +
        `\`measure\`) and keep the assertions your deterministic test already ` +
        `makes — \`subagent(name, [...])\` for the nested trace, \`notTool\` for ` +
        `the tool contract, \`assertAgentOk\` for the typed result. Those two ` +
        `calls drive Claude Code and take no \`evalDriver\`, so on another ` +
        `harness this tier has no public dispatch yet.`
      );
    case "hook":
      // Nothing. A hook is deterministic by construction: `runHook` answers
      // "does it block event X?" at the unit tier, free, for every event type —
      // there is no probabilistic question left for a paid tier to measure.
      // `skillTestNudge` never asks (it scans with `hooks: false`); this arm
      // exists so the switch is total, and so a caller that DOES ask gets
      // silence rather than the skill's sentence.
      return null;
    default:
      return assertNever(kind);
  }
}

/** Format an untested-surface report as human-readable text. */
/**
 * One line for a repo that followed the OLD advice, and nothing for everyone else.
 *
 * The upgrade removes a tier this tool told people to use. Without this the only
 * signal is a coverage count that went down, which reads as "I broke something"
 * rather than "the rule changed" — and the marker still sits in the file looking
 * load-bearing. Printed in BOTH branches (clean and dirty): a repo can lose
 * coverage and still be at zero untested, and it would then never hear about it.
 */
function legacyCoversNote(report: UntestedReport): string[] {
  const files = report.legacyCoversFiles ?? [];
  if (files.length === 0) return [];
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` (+${String(files.length - 3)} more)` : "";
  return [
    `  ${String(files.length)} test file(s) still carry the retired \`vigiles:covers\` ` +
      `marker (${shown}${more}). It has granted no coverage since 15.x — a test counts ` +
      `when it is NAMED after the surface and sits next to it. The marker is now an ` +
      `ordinary comment; delete it or rename the file.`,
  ];
}

/**
 * The "measured, but not this version" line — printed in BOTH branches, for the
 * same reason `legacyCoversNote` is: a repo can be at zero untested and still be
 * resting on a measurement of text that no longer exists, and it would then
 * never hear about it.
 */
function staleRunNote(report: UntestedReport): string[] {
  const stale = report.staleRuns ?? [];
  if (stale.length === 0) return [];
  const shown = stale
    .slice(0, 3)
    .map((s) => s.path)
    .join(", ");
  const more = stale.length > 3 ? ` (+${String(stale.length - 3)} more)` : "";
  return [
    `  ${String(stale.length)} surface(s) have a run record from BEFORE their current ` +
      `text (${shown}${more}) — measured, but not this version, so it grants no ` +
      `coverage. Re-run \`vigiles test\` / \`vigiles eval\` to refresh it.`,
  ];
}

/** Names a default vitest/jest run collects — the suffixes vigiles will not use. */
const FOREIGN_RUNNER_SUFFIX = /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs)$/;

/**
 * The would-be colocated tests that only their NAME disqualifies.
 *
 * Same two questions colocation asks — is it named after the surface, is it
 * sitting beside it — with the third answer inverted: the suffix is one a
 * default vitest/jest run collects, which is precisely why it left
 * {@link DEFAULT_TEST_GLOBS}. Reading the directory (rather than globbing the
 * repo again) keeps the cost at one `readdir` per untested surface and cannot
 * reach a file that is not beside one.
 */
function retiredTestNamesFor(
  basePath: string,
  untested: readonly Surface[],
): RetiredTestName[] {
  const out: RetiredTestName[] = [];
  for (const s of untested) {
    const dir = dirname(s.path);
    let entries: string[];
    try {
      entries = readdirSync(join(basePath, dir));
    } catch {
      continue; // a surface whose directory vanished mid-scan is not our finding
    }
    for (const entry of entries.sort()) {
      if (!entry.startsWith(`${s.name}.`)) continue;
      if (!FOREIGN_RUNNER_SUFFIX.test(entry)) continue;
      out.push({
        path: dir === "." ? entry : `${dir}/${entry}`,
        surface: s.path,
      });
    }
  }
  return out;
}

/**
 * One line for the author staring at a test they already wrote.
 *
 * The count says untested; the directory listing says `foo.test.mjs`. Without
 * this the two never meet: the finding prints the SURFACE path and suggests a
 * file to add, so the reader's most likely conclusion is that the tool cannot
 * see their test — which is true, and the reason is a suffix nobody mentioned.
 */
function retiredTestNameNote(report: UntestedReport): string[] {
  const found = report.retiredTestNames ?? [];
  if (found.length === 0) return [];
  const shown = found
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  const more = found.length > 3 ? ` (+${String(found.length - 3)} more)` : "";
  return [
    `  ${String(found.length)} file(s) sit beside an untested surface and are named ` +
      `after it, but carry a \`.test.\`/\`.spec.\` suffix (${shown}${more}) — the name a ` +
      `default vitest/jest run collects, which is why it stopped counting in 15.x. A ` +
      `harness test drives an agent, and under a foreign runner vigiles refuses to ` +
      `spawn one, so that run FAILS on it rather than testing anything. Rename to ` +
      `\`<surface>.harness.<ext>\` and it counts here without being swept up there.`,
  ];
}

/**
 * The QUALIFIERS on a coverage number — every caveat that says "this count is
 * not quite what it looks like", in one list, built once.
 *
 * 🔴 THIS EXISTS BECAUSE A CAVEAT COULD BE PRINTED BY ONE COMMAND AND NOT THE
 * OTHER, AND WAS. Both notes below were added to `formatUntestedReport` (the
 * `lint` renderer) and neither reached `audit`, which assembles its own fact
 * block from the same {@link UntestedReport}. Measured 2026-08-18 on a fixture
 * whose only harness carried the retired `vigiles:covers` marker: `lint` named
 * the file, `audit` printed `Untested surfaces: 0` and nothing else. The
 * migration note existed, was unit-tested, and was invisible to anyone whose
 * habit is `audit` — which is the whole point of a note that explains a silent
 * migration.
 *
 * Collecting them here is the subtraction: a caveat is no longer something a
 * renderer can choose to carry. Adding a third one reaches both callers or
 * neither, and "neither" is a compile error rather than a quiet omission.
 */
export function coverageCaveats(report: UntestedReport): readonly string[] {
  return [
    ...staleRunNote(report),
    ...legacyCoversNote(report),
    ...retiredTestNameNote(report),
  ];
}

export function formatUntestedReport(report: UntestedReport): string {
  // Every coverage number is printed WITH its provenance. "28 covered" and
  // "28 covered, all of it a name appearing in a file" are different facts, and
  // the detector used to be able to say only the first.
  const provenance = formatEvidence(coverageEvidenceCounts(report));
  if (report.untested.length === 0) {
    const tail = report.exempt > 0 ? ` (${String(report.exempt)} exempt)` : "";
    const legacy = coverageCaveats(report);
    const ok =
      `✓ all ${String(report.total)} surface(s) have a test or eval${tail}` +
      (provenance ? `\n  ${provenance}` : "") +
      (legacy.length ? `\n${legacy.join("\n")}` : "");
    // A clean UNION can still hide a whole unanswered question: every surface may
    // have a deterministic harness and NOTHING may ever have measured that a
    // skill fires. The gate is unchanged (still the union), but the ✓ must not
    // read as "firing verified" when nothing asked.
    const unevaluated = report.evals.untested.length;
    return unevaluated === 0
      ? ok
      : `${ok}\n  …but ${String(unevaluated)} of them have no \`*.eval.mjs\`, so ` +
          `nothing has measured whether they actually fire (a harness can't tell you that).`;
  }
  const lines = [
    `⚠ ${String(report.untested.length)} surface(s) with no test or eval:`,
  ];
  for (const s of report.untested) {
    lines.push(
      `    ${s.kind} ${s.path} — add e.g. ${suggestedTestPath(s, report.testExt)}`,
    );
  }
  // Name the two gaps SEPARATELY — they lead to different work at wildly
  // different cost. "add a test/eval" is one sentence for two prescriptions three
  // orders of magnitude apart; a reader can't tell whether it's ten minutes or a
  // model budget.
  lines.push(
    `  Two gaps, two costs: ${String(report.harness.untested.length)} with no ` +
      `deterministic harness (free, every push) · ` +
      `${String(report.evals.untested.length)} whose firing was never measured ` +
      `(needs a real model, run on a schedule).`,
  );
  // What the surfaces that DID pass are resting on.
  if (provenance) lines.push(`  ${provenance}`);
  lines.push(...coverageCaveats(report));
  // Already testing these another way (a promptfoo suite, a home-grown evals
  // file)? Two shapes are accepted, and the message names BOTH — it used to
  // name only `include`, which does not by itself make a centralized suite
  // count, so a reader who followed it exactly saw the number not move (#175.2).
  // See docs/rules/untested-skill.md.
  lines.push(
    `  Testing these another way (promptfoo / a home-grown eval loop)? Either ` +
      `put the file NEXT TO the surface and name it after it ` +
      `(\`<surface>/<surface>.eval.mjs\`), or — for a centralized layout — point ` +
      `\`include\` at it USING THE \`{surface}\` placeholder, e.g. ` +
      `\`"tests/{surface}/evals/promptfooconfig*.yaml"\`. A \`include\` entry ` +
      `WITHOUT \`{surface}\` widens what counts as a test file but never says ` +
      `which surface it covers, so it credits nothing on its own. ` +
      `See docs/rules/untested-skill.md.`,
  );
  return lines.join("\n");
}
