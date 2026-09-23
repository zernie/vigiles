/**
 * `.vigiles/coverage.json` — the record of which surfaces a RUN actually
 * exercised, and the only tier of coverage evidence that is about execution
 * rather than about a file name.
 *
 * ## What was broken, and how to reproduce it
 *
 * Coverage answered "is this surface tested?" from colocation: a file named
 * after the surface, sitting beside it. `touch .claude/skills/foo/foo.eval.mjs`
 * — an EMPTY file — drops the untested count by one. Measured on a real repo,
 * `.claude/skills/paper-pipeline/` held six `*.eval.mjs` of which exactly one
 * was about that skill, and the orchestrator scored as covered with no test of
 * its own (`vigiles/s54.md`, defects №10 and №17).
 *
 * Nobody else answers this question by name. `go test -cover`, coverage.py, nyc
 * and tarpaulin all answer from EXECUTION and use the name only to find the file
 * to run. We cannot run a skill without a model, so the name survives as a
 * fallback — but the order of answers is now execution → name → nothing, and the
 * report says which one it used.
 *
 * ## Three properties this file is responsible for
 *
 * 1. **Resolution, not guessing.** A run reports a `SurfaceProbe` — a script path
 *    or a namespaced skill id — which is a REFERENCE, not a verdict. Here it is
 *    matched against surfaces actually discovered in the repo. An unresolvable
 *    probe is DROPPED. Nothing is invented, so a probe can never create coverage
 *    for a surface that does not exist.
 *
 * 2. **Staleness is stated, never silent.** Each run stamps the surface's content
 *    hash AT RUN TIME. A surface edited since is "measured, but not this text" —
 *    the same disease as a PIPELINE-STATUS tick against a document that was
 *    rewritten afterwards. A stale record grants NO coverage; it falls back to
 *    colocation like any other surface, and gets a line in the report saying so.
 *    A record names TWO files, and both must still be there — see
 *    {@link indexRuns}.
 *
 * 3. **Absent artifact = today's behaviour, exactly.** A fresh clone, a repo that
 *    never ran `vigiles test`, and anyone else's project have no file here, and
 *    must not get one extra nudge because of this feature.
 *
 * Node-only (it reads and writes a file). The browser twin has no filesystem and
 * therefore structurally no run records — see `test-coverage-files.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

import type { ProbeOrigin, SurfaceProbe } from "./check-count.js";
import { isColocatedTest } from "./coverage-evidence.js";
import {
  COVERAGE_ARTIFACT_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "./local-files.js";
import type { Surface, SurfaceKind } from "./test-coverage.js";

/** Bumped when the record shape changes in a non-additive way. */
export const COVERAGE_ARTIFACT_VERSION = 1;

/** The artifact filename under `.vigiles/` — defined on the one local-files list. */
export { COVERAGE_ARTIFACT_FILE };

/**
 * Which runner produced a record. Mirrors the discovery split in
 * `test-coverage.ts`: `vigiles test` runs `*.harness.*` (free, every push),
 * `vigiles eval` runs `*.eval.*` (paid, scheduled). Kept per record so a run
 * cannot credit the tier it did not belong to — an executed harness must not
 * silence "nothing ever measured whether this fires".
 */
export type CoverageTierName = "harness" | "eval";

/**
 * How a RECORD came to name its surface.
 *
 * The three {@link ProbeOrigin} values are what the run REPORTED about itself
 * from inside its own process — a command line it executed, a transcript it got
 * back. `colocated` is the fourth and is different in kind: nothing inside the
 * test said it. The RUNNER observed that the script it just executed is the
 * surface's colocated test, by the same {@link isColocatedTest} rule that is
 * already willing to credit that file for merely existing.
 *
 * 🔴 THE SPLIT IS THE POINT, AND IT IS WHY THIS IS NOT ON {@link ProbeOrigin}.
 * `ProbeOrigin` is the wire vocabulary: `parseCheckReport` reads it out of a
 * scratch file the CHILD writes. Putting `colocated` there would let a harness
 * hand-write `{"how":"colocated","ref":"…"}` and mint execution coverage for a
 * surface by declaring it — which is `vigiles:covers` returning through the back
 * door, the tier this file's header records being deleted for exactly that. Kept
 * off `ProbeOrigin`, a script cannot spell it at all: `toProbe` has no branch
 * that produces it, so the only producer in the program is {@link recordsFrom}.
 */
export type RunAttribution = ProbeOrigin | "colocated";

/**
 * Every {@link RunAttribution}, as data — the artifact's validator reads it, so
 * the accepted set and the type cannot drift apart into a record shape the
 * program can produce and the reader silently discards. The `satisfies` is the
 * lock: drop a member and this stops compiling.
 */
const ATTRIBUTIONS = new Set<string>([
  "command",
  "fired",
  "dispatched",
  "colocated",
] satisfies RunAttribution[]);

function isAttribution(value: unknown): value is RunAttribution {
  return typeof value === "string" && ATTRIBUTIONS.has(value);
}

/** One surface, exercised by one script, at one moment, against one version. */
export interface CoverageRun {
  readonly kind: SurfaceKind;
  /** Repo-relative path of the surface file. */
  readonly path: string;
  readonly name: string;
  readonly tier: CoverageTierName;
  /** How the run named it — see {@link RunAttribution}. */
  readonly how: RunAttribution;
  /** The script file that did the exercising. */
  readonly by: string;
  /** ISO-8601 timestamp of the run. */
  readonly at: string;
  /** Content hash of the surface file AS IT WAS when the run happened. */
  readonly sha: string;
}

export interface CoverageArtifact {
  readonly v: number;
  readonly generated: string;
  /** Short commit the run was made at, when the repo is a git checkout. */
  readonly commit?: string;
  readonly runs: readonly CoverageRun[];
}

/** Content hash of a surface file — the staleness key. */
export function surfaceSha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** POSIX-ify a path so a Windows-recorded ref matches a repo-relative surface. */
function norm(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * ONE spelling for one script file — the identity a coverage record is keyed by.
 *
 * 🔴 SEPARATORS WERE NOT THE ONLY WAY TO SPELL THE SAME FILE, and keying on the
 * raw string reopened the defect the retraction set exists to close. Measured
 * 2026-08-12 on the two-hook fixture in `cli-coverage-record.test.ts`:
 *
 *   vigiles test                    → record `by: t.harness.mjs`
 *   (empty the harness)
 *   vigiles test ./t.harness.mjs    → `hooks/a.sh` STILL "MEASURED BY A RUN"
 *
 * because `./t.harness.mjs` and `t.harness.mjs` are different keys. Nothing
 * expires it either: freshness is keyed to the SURFACE's text, which emptying
 * the test does not touch, so that record stays green forever. The same spelling
 * split also DOUBLES records — running once by `./t.harness.mjs` and once by the
 * default glob left two entries for one script, measured on the same fixture.
 *
 * `discoverScripts` is where the spellings come from: it passes an argument that
 * names an existing file through VERBATIM (`./x`, an absolute path, `a/../x`)
 * and only globs otherwise, which yields the bare relative form. So both are
 * ordinary, both are what a person types, and neither is wrong.
 *
 * `root` is needed only to bring an ABSOLUTE spelling back to repo-relative; a
 * caller that cannot say where the repo is gets separator + `./` + `..`
 * collapsing, which is what it could do before, and no worse.
 */
export function canonicalScript(file: string, root?: string): string {
  // `relative` from a FIXED root is injective, so two different files can never
  // collapse onto one key: an absolute and a relative spelling meet only when
  // they name the same location under that root, which is exactly when they
  // should. (A guard keeping escaping paths absolute was written here first and
  // removed — mutating it away changed no test, because it could not: it was the
  // dead-fragment class this same change is removing elsewhere.)
  const p =
    root !== undefined && isAbsolute(file)
      ? norm(relative(root, file))
      : norm(file);
  const normalized = posix.normalize(p);
  return normalized === "./" ? "." : normalized.replace(/^\.\//, "");
}

/**
 * The surfaces a probe refers to, or `[]`.
 *
 * 🔴 CONSERVATIVE BY KIND. A `command` probe is matched only against HOOKS: a
 * command runs a program, and the only surface kind that IS a program is a hook.
 * A skill's bundled helper script being executed is a test of that script, not
 * of the skill — the exact substitution ("a test NEAR it" for "a test OF it")
 * that colocation-by-directory was making. Today the check is belt-and-braces
 * (skills and agents are `.md`, and a command ref always ends in a script
 * extension, so the paths cannot collide); it is asserted anyway, because a
 * guard nothing tests is one that quietly stops holding when discovery changes.
 *
 * A `fired` probe matches by NAME, after dropping a `plugin:` namespace, because
 * that is the only identity the transcript carries.
 *
 * 🔴 AN AMBIGUOUS PROBE RESOLVES TO NOTHING. When two surfaces share a name — a
 * skill shipped at `skills/foo/` and overridden at `.claude/skills/foo/` — the
 * transcript says `plugin:foo` and cannot say which file ran. Returning BOTH
 * used to look conservative and is the opposite: exactly one of them ran, so the
 * shadowed copy is handed execution coverage it never earned, and the record
 * asserts a fact that is false. Dropping loses a real record for the copy that
 * did run; recording both INVENTS one. The same rule the rest of this tier
 * already follows — an unresolvable ref is never guessed into a match — so the
 * only consistent answer is to drop.
 *
 * A `command` probe is resolved by a LADDER, most precise first: an exact path,
 * then the ref as a ROOTED path (a harness legitimately points at
 * `${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh`, or at an absolute path inside the
 * repo), then the ref as a SHALLOWER one (a harness ran with a `cwd` inside the
 * repo, so it named `guard.sh`). A lower rung is consulted only when the one
 * above it is empty, because the rungs overlap: with both `hooks/pre.sh` and
 * `.claude/hooks/pre.sh` discovered, the ref `.claude/hooks/pre.sh` is an EXACT
 * match for one and a rooted match for the other — flat filtering made a named
 * file ambiguous.
 *
 * 🔴 THE MIDDLE RUNG USED TO ACCEPT ANY REF WHOSE TAIL MATCHED, so an absolute
 * path in SOMEBODY ELSE'S tree credited a local file. Measured 2026-08-12 against
 * a single surface `hooks/pre.sh`:
 *
 * ```
 * /workspace/vigiles/hooks/pre.sh        => ["hooks/pre.sh"]   (genuinely ours)
 * /tmp/fixture/hooks/pre.sh              => ["hooks/pre.sh"]   FALSE GRANT
 * /home/other/repo/hooks/pre.sh          => ["hooks/pre.sh"]   FALSE GRANT
 * /nix/store/abc123-plugin/hooks/pre.sh  => ["hooks/pre.sh"]   FALSE GRANT
 * ```
 *
 * Keeping the full qualified path did not fix it — the bottom rung's repair was
 * about a ref that carried NO directories, and any external path that happens to
 * end in the complete repo-relative tail still miscredits. It is the same defect
 * the bottom rung had, one level up: a SUFFIX taken for an identity.
 *
 * A path is only ours if it is anchored at our root, so the rung now demands an
 * anchor and the caller supplies one ({@link ResolveOptions.root}). Two anchors
 * exist and no third is invented:
 *
 *  - the repository root itself, for an absolute ref — it must lie beneath it,
 *    and the remainder is then a repo-relative path compared EXACTLY;
 *  - an unexpanded PROJECT-root variable ({@link ROOT_VARS}), which is how a
 *    settings-file hook reaches this tier (`commandRefs` leaves the name as
 *    written when nothing in `env` expands it).
 *
 * Anything else — an absolute ref outside the root, an absolute ref with NO root
 * supplied, a relative ref carrying extra leading directories (`../other/…`,
 * `vendor/plugin/…`) — resolves to nothing. Absent a root the rung abstains
 * wholesale rather than falling back to the tail match, which is what a caller
 * that cannot name its own root honestly knows.
 *
 * 🔴 THE BOTTOM RUNG USED TO MATCH BY BARE NAME, and that is the third appearance
 * in this PR of a NAME accepted as an IDENTITY — after the coverage metric's
 * "mention" tier (deleted; it produced 9 of 10 covered surfaces, ≥3 falsely) and
 * the foreign-runner gate's identifier search (replaced by a call site). It threw
 * the ref's directories away, so executing `/tmp/guard.sh` in a passing harness
 * credited the repo's sole `hooks/guard.sh` — a file that never ran.
 *
 * It is now a TAIL ALIGNMENT in the other direction rather than a qualified
 * name: every segment the ref carries must lie on the surface's path. That
 * distinguishes it from the two deletions, and the distinction is the whole
 * argument for keeping a third rung at all — those matched on a PROJECTION of
 * the evidence (a name pulled out of a file, an identifier pulled out of a
 * module), discarding what the rest of it said. Here nothing is discarded: a ref
 * with no directories contradicts no directory, and a ref with directories must
 * agree with them. `/tmp/guard.sh` now resolves to NOTHING, because no repo
 * surface path can end in `//tmp/guard.sh`.
 *
 * The new rung is a strict SUBSET of the old one (tail alignment implies equal
 * basenames), so this can only ever remove grants, never add one.
 *
 * ⚠️ MEASURED ON THIS REPO'S OWN CORPUS, and the honest answer is that the corpus
 * does not vote. `vigiles test` over all 13 example harnesses yields THREE
 * `command` probes, all of which fell to the bottom rung and all of which
 * resolved to NOTHING:
 *
 * ```
 * basename → miss   examples/harness/protect-main.hook.mjs
 * basename → miss   examples/harness/warn-on-failure.hook.mjs
 * basename → miss   /workspace/vigiles/test/dogfood/oh-my-claudecode@…/scripts/run.cjs
 * exact  : 0 calls
 * suffix : 0 calls
 * ```
 *
 * A second real corpus (a 43-harness consumer repo) produced ZERO command probes
 * at all. So no rung has granted coverage on any corpus available here, and the
 * bottom rung cannot be justified by what it has resolved — only by what it
 * would resolve for a harness using the `{ cwd }` idiom this very file's sibling
 * (`leafArgvSource`) recommends. The third line above is the live near-miss that
 * settles the direction: a VENDORED third-party script would have credited a hook
 * of this repo named `run.cjs`, had one existed.
 */
export function resolveProbe(
  probe: SurfaceProbe,
  surfaces: readonly Surface[],
  opts: ResolveOptions = {},
): Surface[] {
  if (probe.how === "command") {
    const ref = norm(probe.ref).replace(/^\.\//, "");
    const hooks = surfaces.filter((s) => s.kind === "hook");
    const exact = hooks.filter((s) => norm(s.path) === ref);
    if (exact.length > 0) return only(exact);
    // The ref is ROOTED: it carries an anchor that means THIS repository, and
    // what follows the anchor is a repo-relative path (see above).
    const rooted = repoRelative(ref, opts.root);
    if (rooted !== null)
      return only(hooks.filter((s) => norm(s.path) === rooted));
    // The ref is SHALLOWER: the harness ran with a `cwd` inside the repo, so it
    // named a tail of the surface path (`guard.sh`, `hooks/guard.sh`).
    return only(hooks.filter((s) => norm(s.path).endsWith(`/${ref}`)));
  }
  // 🔴 WITHIN THE KIND THE EVIDENCE NAMES. A `fired` probe comes from a `Skill`
  // tool call, so it identifies a SKILL; a `dispatched` probe comes from a
  // `subagent_type`, so it identifies an AGENT. The lookup used to search every
  // kind, which is the cross-kind form of "a name is not an identity".
  //
  // The agent origin is its OWN, not a widening of `fired` — a widening is how
  // the cross-kind leak existed in the first place.
  const kind = probe.how === "dispatched" ? "agent" : "skill";
  const name = localName(probe.ref, opts.selfNamespaces ?? []);
  if (name === null) return [];
  return only(surfaces.filter((s) => s.kind === kind && s.name === name));
}

/**
 * Shell variable names whose value IS the audited project's root, so a ref
 * spelled `$NAME/rest` names `rest` inside this repository.
 *
 * ⚠️ PLUGIN-ROOT TOKENS ARE DELIBERATELY ABSENT — `CLAUDE_PLUGIN_ROOT`,
 * `PLUGIN_ROOT` and friends name whichever plugin is running, and the
 * whole-harness tier CO-INSTALLS competitors on purpose (`installSet`, so the
 * skill under test competes for selection). A competitor's
 * `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh` would then be credited to a hook of ours
 * with the same repo-relative path. The project root has no such ambiguity: it
 * is the thing being audited, by definition.
 */
const ROOT_VARS = new Set(["CLAUDE_PROJECT_DIR", "CLAUDE_PROJECT"]);

/** A ref anchored at a root: `/abs/root/...`, `$VAR/...`, `${VAR}/...`. */
const ROOT_VAR_RE = /^\$\{?(\w+)\}?\//;
/** POSIX `/x` and Windows `C:/x` — `norm` has already collapsed separators. */
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:\/)/;

/**
 * The repo-relative path a ROOTED ref names, or `null` when the ref is not
 * anchored at this repository — including when it is absolute and no root was
 * supplied to say whether it is ours.
 */
function repoRelative(ref: string, root: string | undefined): string | null {
  const v = ROOT_VAR_RE.exec(ref);
  if (v !== null)
    return ROOT_VARS.has(v[1] ?? "") ? ref.slice(v[0].length) : null;
  if (!ABSOLUTE_RE.test(ref) || root === undefined) return null;
  const base = norm(root).replace(/\/+$/, "");
  return ref.startsWith(`${base}/`) ? ref.slice(base.length + 1) : null;
}

/** What {@link resolveProbe} needs beyond the probe and the surfaces. */
export interface ResolveOptions {
  /**
   * Plugin namespaces that mean THIS repo (`plugin:skill` / `plugin:agent`).
   * Absent → every qualified ref drops; see {@link localName}.
   */
  readonly selfNamespaces?: readonly string[];
  /**
   * The repository root, so an ABSOLUTE ref can be told from somebody else's
   * absolute ref. Absent → every absolute ref drops, which is what a caller that
   * cannot name its own root honestly knows.
   */
  readonly root?: string;
}

/**
 * The surface name a namespaced activation refers to IN THIS REPO, or `null`
 * when it refers to somebody else's.
 *
 * 🔴 THE NAMESPACE USED TO BE STRIPPED AND THROWN AWAY — the third distinct axis
 * of "a name is not an identity", after within-kind (a bare basename) and
 * cross-kind (a hook label reaching a skill). A run that fires
 * `other-plugin:foo` says which plugin's `foo` ran, and we deleted the half that
 * said it: an audited repo with its own unique `foo` was recorded as having
 * EXECUTED it because a completely different plugin's skill activated. The
 * whole-harness tier makes that ordinary rather than exotic — `installSet` exists
 * to co-install competitors so the skill under test competes for selection, and a
 * competitor firing is the normal outcome of a low trigger rate.
 *
 * A qualified ref carries MORE identity than the lookup used, so the fix is the
 * same as the other two: stop discarding it. The namespace must be one that means
 * THIS repo; anything else resolves to nothing.
 *
 * ⚠️ AN UNQUALIFIED REF STILL RESOLVES BY NAME. It carries no namespace to
 * contradict — the same reasoning that kept the shallow rung on the command
 * ladder — and it is what a non-plugin harness reports.
 *
 * ⚠️ AND AN EMPTY `selfNamespaces` DROPS EVERY QUALIFIED REF. That is the honest
 * default for a caller that cannot say which plugin it is, and it costs coverage
 * rather than inventing it; `resolveRecords` supplies the real list.
 */
function localName(
  ref: string,
  selfNamespaces: readonly string[],
): string | null {
  const colon = ref.lastIndexOf(":");
  if (colon < 0) return ref;
  return selfNamespaces.includes(ref.slice(0, colon))
    ? ref.slice(colon + 1)
    : null;
}

/** The match, when there is exactly one — an ambiguous probe identifies nothing. */
function only(matches: readonly Surface[]): Surface[] {
  return matches.length === 1 ? [...matches] : [];
}

/** Everything one script run contributes, already resolved to real surfaces. */
export interface ScriptRunRecord {
  /** The script file that ran. */
  readonly file: string;
  readonly probes: readonly SurfaceProbe[];
  /**
   * How many checks the run REPORTED, or `undefined` when it reported nothing.
   *
   * The distinction is load-bearing and is not this file's invention — see
   * `statusFor` in run-scripts.ts. `undefined` means the script never imported
   * vigiles and therefore *could not* report; that silence is the legacy branch
   * and is never a verdict. A positive number is the script saying, through the
   * library, that it made an observation. Only the second is evidence, which is
   * why {@link recordsFrom} attributes colocation on `> 0` rather than on
   * "it exited 0".
   */
  readonly checks?: number;
}

/**
 * The runs worth recording, out of a whole `vigiles test` / `vigiles eval`.
 *
 * 🔴 ONLY A PASS WRITES. A record here says "this surface was exercised and it
 * behaved", so every other status is disqualified for its own reason, and the
 * filter is an ALLOW-list because the reasons do not generalise:
 *
 *  - `fail` — it exercised the surface, but established nothing about it.
 *    Recording it would let a RED test paint a surface covered.
 *  - `vacuous` — it exited clean having asserted nothing at all.
 *  - `skip` — 🔴 THE ONE THAT WAS LEAKING. A skip is not "nothing happened
 *    first": a script may drive a hook, THEN discover a missing capability and
 *    call `skip()` (say, `claude` is absent). The probes it already recorded are
 *    still attached to the result, and the old deny-list (`status !== "fail"`)
 *    let them through — so a run whose own exit code says "I did not finish"
 *    wrote or refreshed execution-tier coverage. `runHook` is precisely the tier
 *    that runs before the skip decision, so this was reachable, not theoretical.
 *
 * ⚠️ THIS IS NOT THE SAME RULE AS {@link executedScripts}, AND THE ASYMMETRY IS
 * DELIBERATE. Writing and RETRACTING ask different questions:
 *
 * | status | writes a record? | retracts its old records? |
 * |---|---|---|
 * | `pass` | yes | yes |
 * | `fail` | no | yes — it ran and proved nothing |
 * | `vacuous` | no | yes — same |
 * | `skip` | no | **no** — it did not run |
 *
 * A skip must not retract, because the deterministic tier skips when `claude` is
 * missing and deleting yesterday's measurement because today's machine lacks a
 * CLI would destroy a real result. A skip must not write, because it did not
 * finish. Both follow from "a skip is not an execution"; only the direction of
 * the conclusion differs.
 *
 * ## 🔴 A RUN WITH NO PROBES IS NO LONGER DISCARDED
 *
 * The second clause used to be `surfaces.length > 0`: a passing run that named no
 * surface contributed nothing. That threw away the ordinary case. MEASURED on a
 * 52-surface consumer repo, 23 of its 27 covered surfaces were carried by a
 * colocated `*.harness.mjs` that `vigiles test` RUNS on every push — and every one
 * of them reported `colocated` evidence, *"this says the file EXISTS, not that it
 * ran"*, because a harness asserting through `node:assert` reports a CHECK COUNT
 * and no probe. The run happened, the runner watched it happen, and the metric
 * described it as a directory listing.
 *
 * So a passing run that reported at least one CHECK is kept even with no probes:
 * {@link recordsFrom} can attribute it by where the script sits. `checks` travels
 * with it because "exited 0" is not the bar — see {@link ScriptRunRecord.checks}.
 */
export function runsFromResults(
  results: readonly {
    readonly file: string;
    readonly status: string;
    readonly checks?: number;
    readonly surfaces?: readonly SurfaceProbe[];
  }[],
): ScriptRunRecord[] {
  return results
    .filter(
      (r) =>
        r.status === "pass" &&
        ((r.surfaces?.length ?? 0) > 0 || (r.checks ?? 0) > 0),
    )
    .map((r) => ({
      file: r.file,
      probes: r.surfaces ?? [],
      ...(r.checks === undefined ? {} : { checks: r.checks }),
    }));
}

/**
 * The surface a RUN's own script is the colocated test of, or `null`.
 *
 * This is the fourth attribution ({@link RunAttribution}), and the only one the
 * script does not report about itself. The runner knows two facts the script
 * cannot: which file it just executed, and which surfaces this repo has. Put
 * together by {@link isColocatedTest} — the SAME predicate that already grants
 * `colocated` evidence for that file merely existing — they say which surface the
 * run was about.
 *
 * ## The bar is a REPORTED CHECK, not exit zero
 *
 * 🔴 WITHOUT THAT, THIS WOULD BE THE ORIGINAL DEFECT WEARING THE STRONGER LABEL.
 * Measured 2026-08-17 on a two-skill fixture: `touch
 * .claude/skills/argument-arc/argument-arc.harness.mjs` — a ZERO-BYTE file —
 * drops the untested count by one, and `vigiles test` then RUNS it and prints
 * `✓ … passed`. An empty script exits 0. Attributing on "it ran and exited 0"
 * would promote that file from `colocated` ("the file EXISTS, not that it ran")
 * to "MEASURED BY A RUN", which is strictly worse than the hole being closed:
 * the same emptiness, now wearing execution's name.
 *
 * A zero-byte file cannot report a check — it never imports vigiles — so its
 * `checks` is `undefined` and it earns nothing here, falling back to colocation
 * exactly as before. This is `statusFor`'s distinction reused, not a new one:
 * silence is the legacy branch, `0` is `vacuous` (never a `pass`, so it never
 * reaches this function), and a positive count is the script saying through the
 * library that it observed something.
 *
 * ⚠️ WHAT THIS STILL CANNOT SEE, stated rather than implied: a harness that
 * asserts entirely on its own and never imports vigiles reports nothing, so it is
 * indistinguishable here from the empty file. It keeps its colocated credit and
 * gains no execution credit. That is deliberate and it is `check-count.ts`'s
 * standing decision — force-loading the counter into every child was considered
 * and rejected there, because it would report `0` for a blameless hand-rolled
 * harness. The cost is a missed upgrade; the alternative was a false one.
 *
 * 🔴 AMBIGUITY RESOLVES TO NOTHING, the same rule {@link only} applies to probes.
 * Two surfaces in one directory can both claim a script when one name prefixes
 * the other (`foo` and `foo.bar` both match `foo.bar.harness.mjs`, since
 * colocation asks only that the basename START with `<name>.`). Exactly one of
 * them is what the test is about, and nothing here can say which — so crediting
 * both would INVENT a record, which is the failure the rest of this file spends
 * its length refusing.
 */
function colocatedSurface(
  run: ScriptRunRecord,
  surfaces: readonly Surface[],
  alreadyProbed: ReadonlySet<string>,
): Surface | null {
  if ((run.checks ?? 0) <= 0) return null;
  const matches = surfaces.filter(
    (s) =>
      s.path !== run.file &&
      !alreadyProbed.has(s.path) &&
      isColocatedTest(s, run.file),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Turn resolved probes into records. `readSurface` supplies the current content
 * of a surface file (so the hash is stamped from what was on disk during the
 * run); a surface it cannot read is skipped — an unhashable record could never
 * be checked for staleness and would therefore be permanent, unfalsifiable
 * coverage.
 *
 * Two sources of attribution, in one pass: the probes a run reported, and — for a
 * run that reported a check — the surface its own script is colocated with
 * ({@link colocatedSurface}). The dedupe key already carries `how`, so a run that
 * BOTH probed a surface and sits beside it records once per attribution and the
 * report can still say which kinds of evidence exist.
 */
export function recordsFrom(
  opts: ResolveOptions & {
    readonly runs: readonly ScriptRunRecord[];
    readonly surfaces: readonly Surface[];
    readonly tier: CoverageTierName;
    readonly at: string;
    readonly readSurface: (path: string) => string | null;
  },
): CoverageRun[] {
  const out: CoverageRun[] = [];
  const seen = new Set<string>();
  const pairs: {
    run: ScriptRunRecord;
    probe: { how: RunAttribution };
    surface: Surface;
  }[] = [];
  for (const run of opts.runs) {
    const probed = new Set<string>();
    for (const probe of run.probes)
      for (const surface of resolveProbe(probe, opts.surfaces, opts)) {
        pairs.push({ run, probe, surface });
        probed.add(surface.path);
      }
    // 🔴 COLOCATION IS THE FALLBACK ATTRIBUTION, NOT AN ADDITIONAL ONE, and
    // skipping what this run already named is what keeps it from DOWNGRADING the
    // record. MEASURED 2026-08-17 on a 52-surface repo the first time this tier
    // ran: `.claude/hooks/paper-lint.mjs` went from `command` — the harness
    // literally executed that path — to `colocated`, and three `fired` skill
    // activations went the same way. The cause is one key: `mergeRuns` dedupes on
    // (surface, tier, script) and does NOT include `how`, so a second attribution
    // of the same pair does not sit beside the first, it REPLACES it — and with
    // both records stamped the same `at`, `held.at <= run.at` hands the win to
    // whichever was pushed last.
    //
    // The ordering is the same one this file already applies one level up: a
    // direct observation of the surface being exercised outranks an inference
    // from where a file sits. Emitting both and teaching the merge to keep the
    // stronger was the alternative; it costs a wider key, a second record per
    // pair, and a ranking function — to store a fact that adds nothing, since
    // both resolve to the same `executed` evidence.
    const beside = colocatedSurface(run, opts.surfaces, probed);
    if (beside)
      pairs.push({ run, probe: { how: "colocated" }, surface: beside });
  }
  for (const { run, probe, surface } of pairs) {
    const key = `${surface.path}\u0000${run.file}\u0000${probe.how}`;
    if (seen.has(key)) continue;
    const content = opts.readSurface(surface.path);
    if (content === null) continue;
    seen.add(key);
    out.push({
      kind: surface.kind,
      path: surface.path,
      name: surface.name,
      tier: opts.tier,
      how: probe.how,
      by: run.file,
      at: opts.at,
      sha: surfaceSha(content),
    });
  }
  return out;
}

/**
 * The scripts a run actually executed, and the tier it executed them in.
 * See {@link executedScripts} for what "executed" means, and {@link mergeRuns}
 * for why the merge needs to be told.
 */
export interface ExecutedScripts {
  /** Script files, exactly as `by` records them (`ScriptRunResult.file`). */
  readonly scripts: readonly string[];
  readonly tier: CoverageTierName;
  /**
   * Repo root, so an ABSOLUTE spelling (`vigiles test /abs/x.harness.mjs`)
   * retracts the record a repo-relative run wrote. Optional: without it the
   * canonicalisation still collapses separators, `./` and `..`, which is all a
   * caller that does not know the root can honestly do.
   */
  readonly root?: string;
}

/**
 * The scripts a run EXECUTED — the retraction set for {@link mergeRuns}.
 *
 * A skip is the one status that is not an execution: the deterministic tier
 * skips when `claude` is absent, and dropping a record because the machine of
 * the day lacks a CLI would delete a real measurement taken on the machine that
 * had it. Every other status ran the file. `fail` and `vacuous` are deliberately
 * in: a script that ran and proved nothing must not keep yesterday's green
 * record alive, which is the same "activity taken for the property" that
 * {@link runsFromResults} refuses to write in the first place.
 *
 * Deny-list here, ALLOW-list there, on purpose — see the table on
 * {@link runsFromResults} for why the two rules are not each other's negation.
 */
export function executedScripts(
  results: readonly { readonly file: string; readonly status: string }[],
): string[] {
  return results.filter((r) => r.status !== "skip").map((r) => r.file);
}

/**
 * Merge new records over old, keeping the newest per (surface, tier, script).
 *
 * Merging rather than replacing is what makes the two cadences composable: the
 * deterministic tier runs on every push and the paid tier runs on a schedule, so
 * a `vigiles test` today must not erase what `vigiles eval` measured last week.
 * Scoping the key by SCRIPT means running one file by name doesn't drop the
 * records of the files that were not run.
 *
 * 🔴 `executed` RETRACTS, AND WITHOUT IT COVERAGE NEVER EXPIRES. Merging alone
 * can only overwrite keys that appear in `next`, so a script edited to stop
 * touching a surface — or to assert nothing at all — leaves its old record in
 * place, and that record stays FRESH as long as the surface file itself is not
 * edited (staleness is keyed to the surface's text, not to the test's). Measured
 * 2026-08-11 on a two-hook fixture: a harness pointed from `hooks/a.sh` to
 * `hooks/b.sh` and re-run produced records for BOTH, and `lint` reported
 * "2 MEASURED BY A RUN" — execution-tier coverage for a hook nothing executes,
 * with no expiry and no way to notice. So the records of the scripts that ran
 * are dropped BEFORE the new ones are added: what a run says about its own
 * script replaces everything that run's script said before, including silence.
 *
 * The retraction is scoped to (script, tier) — the merge key minus the surface —
 * so it can only ever retract what that script previously claimed. Omitting
 * `executed` keeps the old merge-only behaviour, which is what a caller that
 * does not know which scripts ran must get.
 *
 * 🔴 BOTH KEYS GO THROUGH {@link canonicalScript}. One script has many
 * legitimate spellings (`x.mjs`, `./x.mjs`, an absolute path — `discoverScripts`
 * passes an existing file's argument through VERBATIM), and keying on the raw
 * string made one run's records unretractable by the next. The MERGE key is
 * canonicalised too, not only the retraction set: the second symptom was a merge
 * -key split — one script accumulating two records, one per spelling — and
 * fixing only the retraction would have left it standing.
 */
export function mergeRuns(
  previous: readonly CoverageRun[],
  next: readonly CoverageRun[],
  executed?: ExecutedScripts,
): CoverageRun[] {
  const script = (p: string): string => canonicalScript(p, executed?.root);
  const retracted = new Set<string>();
  if (executed)
    for (const file of executed.scripts)
      retracted.add(`${executed.tier}\u0000${script(file)}`);
  const kept = previous.filter(
    (r) => !retracted.has(`${r.tier}\u0000${script(r.by)}`),
  );
  const byKey = new Map<string, CoverageRun>();
  for (const run of [...kept, ...next]) {
    const key = `${run.path}\u0000${run.tier}\u0000${script(run.by)}`;
    const held = byKey.get(key);
    if (!held || held.at <= run.at) byKey.set(key, run);
  }
  return [...byKey.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.by.localeCompare(b.by),
  );
}

/** Read the artifact, or `undefined` when there is none / it is not one. */
export function readCoverageArtifact(
  root: string,
): CoverageArtifact | undefined {
  const file = resolve(root, VIGILES_DIR, COVERAGE_ARTIFACT_FILE);
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // A torn or hand-edited artifact is not a verdict about anyone's tests.
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Partial<CoverageArtifact>;
  if (obj.v !== COVERAGE_ARTIFACT_VERSION) return undefined;
  if (!Array.isArray(obj.runs)) return undefined;
  const runs = obj.runs.filter(isCoverageRun);
  return {
    v: COVERAGE_ARTIFACT_VERSION,
    generated: typeof obj.generated === "string" ? obj.generated : "",
    ...(typeof obj.commit === "string" ? { commit: obj.commit } : {}),
    runs,
  };
}

function isCoverageRun(value: unknown): value is CoverageRun {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    (r.kind === "skill" || r.kind === "agent" || r.kind === "hook") &&
    typeof r.path === "string" &&
    typeof r.name === "string" &&
    (r.tier === "harness" || r.tier === "eval") &&
    isAttribution(r.how) &&
    typeof r.by === "string" &&
    typeof r.at === "string" &&
    typeof r.sha === "string"
  );
}

/** Write the artifact. Best-effort: recording must never fail a green run. */
export function writeCoverageArtifact(
  root: string,
  artifact: CoverageArtifact,
): void {
  try {
    const dir = resolve(root, VIGILES_DIR);
    mkdirSync(dir, { recursive: true });
    ensureLocalFilesIgnored(dir);
    writeFileSync(
      resolve(dir, COVERAGE_ARTIFACT_FILE),
      JSON.stringify(artifact, null, 2) + "\n",
    );
  } catch {
    /* best-effort — a scratch-dir failure is not a test failure */
  }
}

/** A run record judged against the surface's CURRENT text. */
export interface ExecutedRecord {
  readonly run: CoverageRun;
  /** The surface's content is unchanged since the run measured it. */
  readonly fresh: boolean;
}

/**
 * Index the artifact by surface path, judging each record fresh or stale against
 * the surface as it is NOW.
 *
 * A record names TWO files — the surface it is about (`path`) and the script that
 * did the exercising (`by`) — and **it is counted only while BOTH are still
 * present.** `currentSha` returns `null` for a surface that is gone; `scriptExists`
 * answers the same question for the script. Either missing ⇒ the record is
 * dropped, not counted and not reported as stale.
 *
 * 🔴 THE SURFACE HALF WAS PINNED AND THE EXECUTING HALF WAS NOT, so the guarantee
 * was half-built. Delete or rename a passing harness and its record stays FRESH
 * forever: freshness is keyed to the SURFACE's text, which removing the test does
 * not touch. Worse, that credit is PERMANENT — retraction is scoped to the scripts
 * a run executed, and a file that no longer exists can never appear in
 * `discoverScripts` output again, so no future `vigiles test` can ever withdraw
 * it. Execution-tier coverage for a surface with nothing left to execute it, with
 * no expiry and no way to falsify it.
 *
 * ## The guarantee chosen, and the one deliberately not chosen
 *
 * **Chosen: PRESENCE of both files, judged at read time.** It is the exact
 * symmetric twin of the rule already here for the surface, and it closes the
 * half retraction structurally cannot reach — the deleted and the renamed script.
 * It only ever REMOVES credit (the surface falls back to colocation, which needs
 * the same file to exist anyway), and it is non-destructive: nothing here rewrites
 * the artifact, so a sparse or partial checkout stops counting a record without
 * destroying it, and restoring the file restores the credit.
 *
 * **Not chosen: hashing the script's CONTENT into the record.** It would catch one
 * more case — a script still present but emptied — and that case already has a
 * mechanism: RETRACTION. A gutted harness re-run reports `vacuous`, `vacuous` is
 * in the retraction set on purpose, and every record that script wrote is dropped.
 * So content-hashing buys the same outcome one run later, and charges for it in
 * false alarms: one script legitimately covers MANY surfaces (a single
 * `hooks.harness.mjs` exercising thirty hooks is this author's own repo), so a
 * reformat — or an added assertion, i.e. the harness getting STRONGER — would
 * invalidate all thirty records at once. A hash cannot tell "strengthened" from
 * "gutted", and thirty simultaneous "measured, but not this version" lines are
 * the shape a reader mutes. The surface hash does not have this problem because
 * it is one-to-one.
 *
 * ⚠️ WHAT PRESENCE DELIBERATELY DOES NOT CATCH: a script that still exists and no
 * longer exercises the surface — emptied, or repointed at something else. That is
 * retraction's job, it is transient (one run of the tier that wrote it closes it),
 * and it is already tested end-to-end in `cli-coverage-record.test.ts`.
 *
 * ⚠️ AND THIS IS NOT THE `skip` ASYMMETRY, WHICH STANDS UNCHANGED. A skip must not
 * RETRACT — that would delete a real measurement from the artifact because today's
 * machine lacks `claude` (see the table on {@link runsFromResults}). This rule
 * deletes nothing: it is a read-time judgement about a checkout, made fresh on
 * every scan. The two rules coexist; neither is the other simplified.
 */
export function indexRuns(
  artifact: CoverageArtifact | undefined,
  currentSha: (path: string) => string | null,
  scriptExists: (by: string) => boolean,
): Map<string, ExecutedRecord[]> {
  const index = new Map<string, ExecutedRecord[]>();
  if (!artifact) return index;
  const shaCache = new Map<string, string | null>();
  const byCache = new Map<string, boolean>();
  for (const run of artifact.runs) {
    if (!shaCache.has(run.path)) shaCache.set(run.path, currentSha(run.path));
    const now = shaCache.get(run.path) ?? null;
    if (now === null) continue;
    if (!byCache.has(run.by)) byCache.set(run.by, scriptExists(run.by));
    if (byCache.get(run.by) !== true) continue;
    const list = index.get(run.path) ?? [];
    list.push({ run, fresh: now === run.sha });
    index.set(run.path, list);
  }
  return index;
}
