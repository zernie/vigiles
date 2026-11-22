/**
 * HOW a surface was decided to be covered — the provenance of every coverage
 * decision.
 *
 * ## The defect this exists to close
 *
 * Coverage used to be: "does any discovered test file contain this surface's
 * path or namespace as a substring?" Measured on a real repo (37 skills, 14
 * hooks), appending ONE LINE to an existing harness —
 *
 * ```js
 * // probe: skills/argument-arc
 * ```
 *
 * — a COMMENT, not a test, moved the untested count 33 → 32. The metric was
 * trivially gameable, and the gaming was indistinguishable from real work.
 *
 * This is the exact substitution vigiles names in other people's repos —
 * *presence of a surface taken for presence of the property*, the way
 * `noExplicitAny` sitting in a config is taken for the rule being enforced. The
 * tool was committing it in its own scoring.
 *
 * ## One kind of evidence, and why the other two were removed (2026-08-11)
 *
 * There were three: `declared` (a `vigiles:covers` marker), `colocated`, and
 * `mention` (the surface's name appearing in a test's code). They were never
 * three STRENGTHS of evidence — they were three NAMING CONVENTIONS, all
 * answering "does this surface's name appear near a test?" and none answering
 * "did anything run against it?". Ranking them implied a precision that did not
 * exist. Measured on this repo before the change:
 *
 * - `mention` supplied 9 of 10 covered surfaces. Reading what credited what:
 *   three were real dedicated evals (a `<skill>.trigger.eval.mjs` each) that
 *   colocation could not see, and at least three were FALSE — `hooks/pre-edit.sh`
 *   and `hooks/post-edit.sh` were credited by `test-coverage.test.ts`, which is
 *   the coverage detector's OWN suite naming them as fixtures. The detector
 *   granted coverage to hooks because it tested itself against them. A tier that
 *   wrong is not a weak tier; it is a bug.
 *
 * - `declared` was explicit and greppable — and a list living APART from the
 *   thing it describes, so it must rot. Its first real use in a consumer repo
 *   declared a conformance LINT over 21 skills as coverage OF those 21 skills,
 *   moving that repo's untested count 31 → 16 while nothing new was tested. It
 *   also needed a guard assertion to stay honest: a mechanism watching the
 *   mechanism.
 *
 * Colocation is the one that cannot drift BY CONSTRUCTION. The test lives inside
 * the surface's own directory, so deleting the skill deletes its test, renaming
 * moves both, and `ls` answers "is this tested?" without running anything. The
 * filesystem enforces the convention; a reader does not have to trust it.
 *
 * The cost is stated rather than hidden: a genuinely good test that sits
 * somewhere else now counts for nothing until it is moved next to its surface.
 * That is the intended pressure — a per-surface test belongs with its surface.
 *
 * ## The hole above it — closed 2026-08-11 by a tier ABOVE, not beside
 *
 * The paragraph that used to stand here read: *"colocation says a FILE EXISTS,
 * not that it RAN. An empty `foo.eval.mjs` still counts."* That is now the
 * FALLBACK, not the answer.
 *
 * `executed` is evidence of a different kind from all four naming conventions:
 * it comes from a run that happened, recorded in `.vigiles/coverage.json` by the
 * runner and attributed by the tiers themselves (`coverage-probe.ts`). This is
 * how every mature coverage tool answers the question — `go test -cover`,
 * coverage.py, nyc, tarpaulin — with the name used only to FIND the file to run.
 * A skill cannot be run without a model, so the name survives underneath it.
 *
 * So the order of answers is **execution → name → nothing**, and the report is
 * required to say which one it used: "measured by a run" and "there is a file
 * with a matching name" are different facts, and printing one number for both is
 * the substitution this module exists to stop.
 *
 * ⚠️ The hole colocation still has is unchanged, and is now visible instead of
 * hidden: a surface answered by `colocated` may have an empty test file. What
 * changed is that a surface answered by `executed` demonstrably does not.
 *
 * Browser-safe and pure (no `node:*`): the disk detector (`test-coverage.ts`) and
 * its in-browser twin (`test-coverage-files.ts`) both route through here, so the
 * two cannot drift on the part that decides coverage. A browser has no
 * filesystem and therefore no run records, so `executed` is structurally
 * impossible there and its count is 0 — see `test-coverage-files.ts`.
 */
import { readFrontmatter, frontmatterScalar } from "./core/frontmatter-read.js";
import { minimatch } from "minimatch";
import { basename, dirname } from "./posix-path.js";

import { hookPrograms, type HookInventory } from "./scan-core.js";
import { filter, map, pipe } from "remeda";

/**
 * How a covered surface was decided to be covered.
 *
 * - `executed` — a recorded run exercised it, against THIS version of it.
 * - `colocated` — a test named after it sits beside it. Says the file exists.
 *
 * Two kinds, and unlike the three that were removed these are not two naming
 * conventions: one is about a process that ran, the other about a directory
 * listing. See the module header.
 */
export type CoverageEvidence = "executed" | "colocated" | "configured";

/**
 * Rank, strongest first — what "the STRONGEST evidence" is measured against.
 *
 * It exists because `coverageOf` promised strongest-not-first-found while
 * actually keeping the first match, which was harmless only while `colocated`
 * was the sole surviving tier: one tier cannot be out-ranked. Adding
 * `configured` made the promise load-bearing again — a surface with both a
 * colocated harness and a configured suite would otherwise be reported as
 * whichever the glob list happened to yield first, so the provenance summary
 * would depend on the ORDER of a config array. Colocation ranks higher because
 * it is the stronger statement: the filesystem enforces the binding rather than
 * a pattern asserting it.
 */
const EVIDENCE_RANK: Record<CoverageEvidence, number> = {
  executed: 0,
  colocated: 1,
  configured: 2,
};

/** Is `a` stronger evidence than `b`? */
export function strongerEvidence(
  a: CoverageEvidence,
  b: CoverageEvidence,
): boolean {
  return EVIDENCE_RANK[a] < EVIDENCE_RANK[b];
}

/** The minimum a surface must expose to be matched — structural, no import cycle. */
export interface CoverableSurface {
  /** Repo-relative path of the surface file (SKILL.md / agent .md / hook script). */
  readonly path: string;
  /** Stable name: skill dir, agent basename, or hook script basename. */
  readonly name: string;
  /** Substrings a test may reference to "cover" this surface (path / namespace). */
  readonly tokens: readonly string[];
}

/**
 * A discovered test file. Only its PATH matters now: colocation is decided by
 * placement, so the detector no longer reads a single test file's contents —
 * which also means a repo's coverage can no longer be changed by editing text
 * inside a test.
 */
export interface PreparedTest {
  readonly path: string;
}

/**
 * Is `testPath` the colocated test OF this surface — NAMED after it, SITTING
 * BESIDE it?
 *
 * 🔴 THIS USED TO BE WRITTEN TWICE, and the second copy said so in its own
 * comment: `test-coverage-files.ts` carried a function whose docstring was
 * *"Mirror of test-coverage.ts `isColocated`"*. A mirror is a promise that two
 * bodies stay equal, kept by whoever remembers — and this file already documents
 * three separate occasions where a change landed in one report builder and not
 * the other ({@link declaredSurfaceName}, the hook-surface reader {@link hookSurfaces} replaced). The rule now
 * has ONE body and three callers: the disk detector, the browser twin, and the
 * runner that turns an executed script into an execution record
 * (`coverage-artifact.ts`). There is nothing left to mirror wrong.
 *
 * That third caller is why this became shared rather than merely deduplicated.
 * Colocation and execution were answering the same question — *which surface is
 * this test about?* — with two different pieces of code, so a script vigiles had
 * just RUN could not be attributed by the very rule that was already willing to
 * credit it for existing.
 *
 * SEPARATORS ARE NORMALISED FIRST, then POSIX semantics apply. The disk detector
 * feeds paths from `globSync`, which yields `\` on Windows; the browser twin
 * feeds file-map keys, which are always `/`. Folding `\` to `/` makes one body
 * correct for both instead of asking each caller to bring its own path module —
 * which is exactly the seam the mirror lived in.
 *
 * ⚠️ THE COST, STATED: a POSIX file whose NAME literally contains a backslash is
 * now read as a directory boundary. That is not reachable for either input here —
 * a skill directory or a test filename with a `\` in it does not survive the glob
 * patterns that discover it in the first place.
 */
export function isColocatedTest(
  surface: Pick<CoverableSurface, "name" | "path">,
  testPath: string,
): boolean {
  const test = posixly(testPath);
  const home = posixly(surface.path);
  if (!basename(test).startsWith(`${surface.name}.`)) return false;
  // A root `SKILL.md` (single-skill-dir target) lives at ".", and discovery
  // returns top-level files without a "./" prefix — so `dirname` is "." on both
  // sides and the comparison holds without a special case.
  return dirname(test) === dirname(home);
}

function posixly(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Wrap a discovered path. Kept as a function so both twins share one shape. */
export function prepareTest(path: string): PreparedTest {
  return { path };
}

// Which runner owns a test file — the paid real-model one or the free one — is
// answered by the shared source-kind table (`source-kinds.ts`), which this
// browser-safe module can import because it imports nothing. See `isEvalScript`
// there for the two ways this question has been answered wrongly before.
export { isEvalScript } from "./source-kinds.js";

/**
 * The hook surfaces coverage holds to a test: the program of every compiled
 * or stale line in the inventory that is on disk, named by file like a style. Shared by
 * both twins, which differ only in what "on disk" means.
 *
 * 🔴 THIS REPLACED A REGEX OVER THE MANIFEST. Coverage used to search each
 * settings file's serialized `hooks` block for script-shaped strings, over its
 * own list of files: it guessed a script out of hand-written lines (the very
 * parsing the hook scan had removed), missed a plugin's hook-convention file
 * (#283), and read a TOML settings file as nothing. The inventory is what the
 * loader read, line by line, by identity. A hand-written line yields no
 * surface: vigiles does not read what it runs, so its coverage is not measured
 * (reported as a count, never as untested).
 */
export function hookSurfaces(
  inventory: HookInventory,
  exists: (rel: string) => boolean,
): readonly {
  readonly kind: "hook";
  readonly path: string;
  readonly name: string;
  readonly tokens: readonly string[];
  readonly ignored: boolean;
}[] {
  return pipe(
    hookPrograms(inventory),
    filter(exists),
    map((path) => ({
      kind: "hook" as const,
      path,
      name: basename(path).replace(/\.[^.]+$/, ""),
      tokens: [path],
      ignored: false,
    })),
  );
}

/** Hand-written hook lines: hooks whose coverage is not measured. */
export function unmeasuredHookLines(inventory: HookInventory): number {
  return inventory.filter((e) => e.line.kind === "hand-written").length;
}

/**
 * The line that says so, or none. Printed by `audit` (Tested) and `lint`
 * (untested surfaces) from the same count, so neither calls them untested.
 */
export function unmeasuredHooksNote(n: number): readonly string[] {
  return n === 0
    ? []
    : [
        `  ${String(n)} hand-written hook line(s): coverage not measured — vigiles does not read what they run`,
      ];
}

/**
 * The evidence one test file provides for one surface, or `null` for none.
 * `colocated` is passed in because placement is a path question the two twins
 * answer with their own (disk vs POSIX-string) path helpers.
 */
export function evidenceFor(
  _surface: CoverableSurface,
  _test: PreparedTest,
  colocated: boolean,
  configured = false,
): CoverageEvidence | null {
  if (colocated) return "colocated";
  return configured ? "configured" : null;
}

/**
 * The `{surface}` placeholder in a user's `include` — the ONE thing that makes
 * a centralized test layout expressible without weakening what coverage MEANS.
 *
 * The retired `declared` and `name-mentioned` tiers died because they could
 * credit a surface no test touched: a mention is a substring, and a substring
 * matched this file's own fixtures. `{surface}` cannot do that. The user writes
 * `tests/{surface}/evals/promptfooconfig*.yaml`, and the placeholder is replaced
 * with the surface's NAME before matching — so the binding between test and
 * surface is still the name, exactly as under colocation. Only the PLACE moves.
 *
 * What it costs, stated plainly because it is the argument colocation was chosen
 * on: `ls` beside the skill no longer answers "is this tested?" — you have to
 * know where the project keeps its tests. That is a real loss, and it is why
 * this is opt-in per repo rather than a second default. A project that has
 * already centralized its suites has paid that cost anyway.
 */
export const SURFACE_TOKEN = "{surface}";

/** Does this glob delegate its surface binding to the placeholder? */
export function hasSurfaceToken(glob: string): boolean {
  return glob.includes(SURFACE_TOKEN);
}

/**
 * The pattern to DISCOVER files with: the placeholder widened to `*` so one
 * glob pass finds every candidate. Narrowing back to the right surface happens
 * at match time — discovery must stay surface-agnostic or it would be one glob
 * pass per surface.
 */
export function discoveryGlob(glob: string): string {
  return glob.split(SURFACE_TOKEN).join("*");
}

/**
 * Does this test file sit at a `{surface}` path configured FOR THIS SURFACE?
 *
 * The placeholder is replaced with the surface's own name, so
 * `tests/{surface}/evals/*.yaml` credits `tests/mysql-designer/evals/x.yaml` to
 * `mysql-designer` and to nothing else. A glob WITHOUT the placeholder returns
 * false here on purpose: a plain custom glob widens what counts as a test file,
 * which it always did, but it says nothing about WHICH surface the file is for
 * — and inferring that from a substring is exactly the retired `name-mentioned`
 * tier that credited surfaces nothing had touched.
 *
 * `minimatch` (already a direct dependency, pure JS) so the browser twin can
 * share this instead of growing a second matcher that disagrees.
 */
export function matchesSurfaceGlob(
  surface: Pick<CoverableSurface, "name">,
  testPath: string,
  globs: readonly string[],
): boolean {
  const test = posixly(testPath);
  return globs.some((g) => {
    if (!hasSurfaceToken(g)) return false;
    return minimatch(test, g.split(SURFACE_TOKEN).join(surface.name), {
      dot: true,
    });
  });
}

/** Per-evidence tallies — the provenance summary the report prints. */
export interface EvidenceCounts {
  /** Decided by a recorded run against this version of the surface. */
  readonly executed: number;
  readonly colocated: number;
  /** Decided by a `{surface}` testGlob — the name still binds, the place moved. */
  readonly configured: number;
}

/** Tally a list of decisions by evidence kind. */
export function countEvidence(
  decisions: readonly { readonly evidence: CoverageEvidence }[],
): EvidenceCounts {
  let executed = 0;
  let colocated = 0;
  let configured = 0;
  for (const d of decisions) {
    if (d.evidence === "executed") executed += 1;
    else if (d.evidence === "configured") configured += 1;
    else colocated += 1;
  }
  return { executed, colocated, configured };
}

/**
 * One line naming how the coverage was established. Printed wherever a coverage
 * count is printed: a number with no provenance is the thing this module exists
 * to stop shipping.
 *
 * 🔴 THE TWO CLAUSES ARE WORDED DIFFERENTLY ON PURPOSE. "Measured by a run" and
 * "there is a file with a matching name" are not two strengths of the same
 * statement, and a reader who cannot tell them apart in the output has the same
 * number they had before this tier existed.
 */
export function formatEvidence(counts: EvidenceCounts): string {
  const parts: string[] = [];
  if (counts.executed > 0) {
    parts.push(
      `${String(counts.executed)} MEASURED BY A RUN — a recorded run exercised ` +
        `the surface and reported checks (.vigiles/coverage.json)`,
    );
  }
  if (counts.colocated > 0) {
    parts.push(
      `${String(counts.colocated)} colocated — a test NAMED after the surface, ` +
        `in the surface's own place. This says the file EXISTS, not that it ran`,
    );
  }
  if (counts.configured > 0) {
    parts.push(
      `${String(counts.configured)} configured — a test NAMED after the surface ` +
        `at a \`{surface}\` path you configured. Same name binding as colocation, ` +
        `different place; still only says the file EXISTS`,
    );
  }
  if (parts.length === 0) return "";
  return `How coverage was decided: ${parts.join("; ")}.`;
}

/**
 * A root `SKILL.md`'s DECLARED `name:`, or `null` — the identity of a
 * single-skill-at-root repo.
 *
 * 🔴 SHARED BECAUSE IT DRIFTED. This lived only in the disk detector
 * (`test-coverage.ts`), and the browser twin hard-coded the string `"SKILL"` in
 * its place. For a single-skill repo declaring `name: foo`, the disk engine
 * therefore counted a top-level `foo.harness.mjs` as colocated coverage and the
 * GitHub/file-map engine — the SAME audit, same files — called the skill untested
 * and lowered its Tested score. That is the third time in this PR that a change
 * landed in one report builder and not the other, so the field is no longer
 * mirrored: both twins call this one function, and there is nothing left to
 * mirror wrong.
 *
 * The name matters only at the ROOT. For a nested skill the DIRECTORY is the
 * identity (`skills/foo/SKILL.md` → `foo`); the base of a single-skill target is
 * wherever the thing happens to be checked out — a temp dir, `~/src/wip-2`, a CI
 * workspace — and since colocation requires the test to be NAMED after the
 * surface, taking the identity from the path would ask the author to name their
 * test after their checkout directory.
 *
 * Read through the SHARED lenient frontmatter reader rather than a private
 * `load()` + regex — a small behaviour change, stated rather than smuggled: a
 * root SKILL.md whose YAML is malformed but whose `name:` line is salvageable now
 * keys coverage on that name instead of on the checkout directory. That is the
 * name `scanSkills` already prints for the same file, so the report and the
 * coverage tier stop disagreeing about what the skill is called. A file with no
 * declaration at all still returns `null` and the caller's fallback applies
 * (`basename` of the audited dir on disk, the repo name in the browser).
 */
export function declaredSurfaceName(content: string): string | null {
  const name = frontmatterScalar(readFrontmatter(content), "name");
  return name !== undefined && name.trim() ? name.trim() : null;
}

/**
 * One output style as a coverage surface — shared by the disk detector and the
 * browser twin, so the two name and exempt a style the same way.
 *
 * Named by FILE (`status-block.md` → `status-block`), not by the name a
 * harness selects it by: the surface name is what a colocated test is spelled
 * after, and a declared name may hold spaces or colons no file name should.
 */
export function outputStyleSurface(
  path: string,
  content: string,
): {
  readonly kind: "output-style";
  readonly path: string;
  readonly name: string;
  readonly tokens: readonly string[];
  readonly ignored: boolean;
} {
  return {
    kind: "output-style",
    path,
    name: basename(path).replace(/\.[^.]+$/, ""),
    tokens: [path],
    ignored: content.includes("vigiles:ignore-test"),
  };
}

/**
 * How many output styles a scan found, or that the harness has none. Shared by
 * the disk and browser scan engines, so the inventory reads the one discovery
 * pass both already ran. Exempt styles (`vigiles:ignore-test`) are counted: the
 * marker waives the test, not the style, and a style-only repository with an
 * exempt style is not an empty machine.
 */
export function outputStyleCount(
  layouts: readonly { readonly outputStyles?: unknown }[],
  tier: {
    readonly covered: readonly { readonly kind: string }[];
    readonly untested: readonly { readonly kind: string }[];
  },
  exempt: readonly { readonly kind: string }[],
): number | "not-supported" {
  if (layouts.every((l) => l.outputStyles === undefined))
    return "not-supported";
  return [...tier.covered, ...tier.untested, ...exempt].filter(
    (s) => s.kind === "output-style",
  ).length;
}

/** The inventory counts both scan engines report the same way. */
export function inventoryCounts(
  files: Readonly<Record<string, string>>,
  isCommand: (path: string) => boolean,
  layouts: Parameters<typeof outputStyleCount>[0],
  coverage: {
    readonly harness: Parameters<typeof outputStyleCount>[1];
    readonly exemptSurfaces: Parameters<typeof outputStyleCount>[2];
  },
): {
  readonly commands: number;
  readonly outputStyles: number | "not-supported";
} {
  return {
    commands: Object.keys(files).filter(isCommand).length,
    outputStyles: outputStyleCount(
      layouts,
      coverage.harness,
      coverage.exemptSurfaces,
    ),
  };
}
