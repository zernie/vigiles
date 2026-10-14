/**
 * vigiles — SKILL bundled-resource resolution (the cross-reference moat applied
 * to a SKILL.md body).
 *
 * A SKILL.md body is freeform markdown that routinely points the agent at LOCAL
 * BUNDLED files shipped beside it — `scripts/foo.sh`, `references/api.md`,
 * `[setup](./scripts/run.py)`, an inline `run \`scripts/setup.sh\``. When a
 * referenced file doesn't exist on disk under the skill directory, the agent
 * reads the instruction, gets nothing, and silently continues (a documented top
 * skill pain — one practitioner found 59 broken refs across 192 files). vigiles
 * already verifies file/script refs inside typed specs (core/refs.ts,
 * core/doc-refs.ts) and intra-plugin script refs in the loader
 * (plugin-loader.ts `danglingRefs`); this extends that to the SKILL.md body.
 *
 * HIGH-PRECISION / FP-SAFE, by the same don't-cry-wolf discipline the rest of
 * vigiles holds (see `danglingRefs`/`isPluginRooted`): we flag ONLY references
 * that are UNAMBIGUOUSLY a local bundled resource — a markdown link to a
 * relative path with a file extension, or an explicit `scripts/`/`references/`/
 * `assets/`-prefixed path (the Agent-Skills standard bundle dirs) with an
 * extension. Everything else is skipped: URLs, absolute paths, `${VAR}`/`$VAR`
 * tokens, `../` escapes, bare words with no extension or known prefix. Prefer
 * MISSING a real ref over emitting a false positive — a noisy resource check
 * would teach users to ignore it.
 *
 * BOTH candidate shapes carry the same prose gate (issue #110 — a markdown
 * link is a stronger signal than an inline-code mention, but it is NOT
 * immune from illustrative prose): a skill that TEACHES how to build skills
 * mentions bundle paths constantly as EXAMPLES of what a skill *could* ship
 * ("a `scripts/rotate.py` would be helpful to store", "**Examples**:
 * `references/finance.md`", or a markdown-link example demonstrating how to
 * write a path — e.g. one with a space in the filename). A reference (link OR
 * inline path) is treated as real ONLY when the line DIRECTS the agent to use
 * the file (read/run/see/…, or the line is a HEADING naming it — see
 * `MD_HEADING`) and carries no illustrative cue (example / e.g. / such as /
 * would be / template / →). See `inlinePathIsUsed`.
 *
 * CANDIDATES COME FROM THE PARSE, THE GATE READS THE PROSE. Every candidate is
 * a `MarkdownRef` from `core/markdown.ts` — a link's DESTINATION or a code span
 * that is not inside a link's text. The line is then consulted only to decide
 * whether the surrounding prose DIRECTS the agent at the file. Before that
 * split, a second regex scanned each line for backtick spans without knowing it
 * was standing inside a link, and reported the link's LABEL as a missing
 * resource while its destination resolved (measured on
 * `microsoft/power-platform-skills` and `rohitg00/pro-workflow`, 2026-08-17).
 *
 * ESCAPE HATCH: a SKILL.md carrying `<!-- vigiles-disable skill-resource-resolves -->`
 * anywhere in its body opts OUT of this check entirely (mirrors `orphans.ts`'s
 * `vigiles-disable orphan-docs`) — for a skill whose body is inherently full of
 * illustrative bundle-path examples (a skill-authoring tutorial) that still
 * trips the heuristic.
 *
 * Pure + node-free: the only IO is a REQUIRED, injected `existsSync` (the disk
 * caller passes `node:fs`; the browser engine a map-backed check), so the
 * detector is testable with a fake and statically imports no `node:` builtin —
 * it bundles clean in a browser (path ops come from the node-free `posix-path`).
 */
import { resolve } from "../posix-path.js";
import { markdownRefs } from "./markdown.js";
import type { MarkdownRef } from "./markdown.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a bundled-resource reference was found in the body. */
export type SkillResourceKind = "link" | "path";

/**
 * Why a bundled-resource reference is reported. A ref that resolves under the
 * skill dir (or through a declared shared dir) is not reported at all; one that
 * does not is reported for exactly one of these reasons:
 *
 * - `missing` — the file exists nowhere the detector can see. The agent reads
 *   the instruction and gets nothing, wherever the skill runs.
 * - `repo-root-only` — not beside the SKILL.md, but present at `repoRoot` (#382).
 *   The agent usually runs from the repository root, so a body that says
 *   "run `scripts/check.sh`" works while the skill runs inside its own repo and
 *   breaks once the skill is installed anywhere else (a plugin install, a copied
 *   skill). Not a miss, and not fine either — a separate fact.
 *
 * Two values rather than a boolean because each one drives a different
 * consequence downstream: only `missing` is scored or gated, and
 * `repo-root-only` is printed as a note. A consumer that reads only one of them
 * says which one in its type (`SkillResourceFinding<"missing">`).
 */
export type SkillResourceResolution = "missing" | "repo-root-only";

/** The reference itself, whatever its resolution. */
interface SkillResourceRef {
  /** The reference text exactly as written in the body (e.g. `scripts/run.sh`). */
  readonly ref: string;
  /**
   * The path normalized relative to the skill dir — and, for `repo-root-only`,
   * equally the path relative to the repo root, since both resolve the same
   * relative string.
   */
  readonly resolved: string;
  /** Whether the ref came from a markdown link `[..](..)` or an inline/path mention. */
  readonly kind: SkillResourceKind;
  /**
   * 1-based line of the reference in the SKILL.md FILE — not in the body string
   * the detector was handed. The caller strips frontmatter before calling, so a
   * body-relative number is short by exactly that block and points the author at
   * the wrong line (#206); `lineOffset` is what closes the gap.
   */
  readonly line: number;
}

/**
 * One file reference in a SKILL.md body that is not beside the SKILL.md.
 * `resolution` says why it was reported. For `.claude/skills/deploy/SKILL.md`:
 *
 * ```ts
 * // line 8 says "run `scripts/deploy.sh`"; only <repo>/scripts/deploy.sh exists
 * { ref: "scripts/deploy.sh", resolved: "scripts/deploy.sh", kind: "path",
 *   line: 8, resolution: "repo-root-only" }
 * // line 9 says "see `scripts/smoke.sh`"; that file exists nowhere
 * { ref: "scripts/smoke.sh", resolved: "scripts/smoke.sh", kind: "path",
 *   line: 9, resolution: "missing" }
 * ```
 *
 * `SkillResourceFinding` on its own is either case: check `resolution` to tell
 * them apart. `SkillResourceFinding<"missing">` is only the first kind, so a
 * list typed with it (the scored one) cannot be handed a note.
 */
export type SkillResourceFinding<
  R extends SkillResourceResolution = SkillResourceResolution,
> = R extends SkillResourceResolution
  ? SkillResourceRef & { readonly resolution: R }
  : never;

export interface SkillResourceOptions {
  /** REQUIRED, injected existence check (disk: node:fs existsSync). */
  readonly existsSync: (p: string) => boolean;
  /**
   * The repository root — the directory the agent usually runs from. A ref that
   * misses under the skill dir but exists here is reported as `repo-root-only`
   * instead of `missing`; a ref under a declared `sharedDirs` entry (below)
   * resolves here outright. Omitted → the detector sees only the skill dir and
   * every miss is `missing`.
   */
  readonly repoRoot?: string;
  /**
   * OPT-IN shared-resource dirs — top-level dir names a repo shares across skills
   * (`.vigilesrc.json` `sharedDirs`, e.g. `["scripts", "references"]`). Many skill
   * libraries keep ONE top-level `scripts/` tree instead of a copy beside every
   * SKILL.md, so a ref like `scripts/promptfoo/x.py` lives at the repo root. When
   * a ref's FIRST path segment is a declared shared dir, it may ALSO resolve
   * against `repoRoot`. Scoped to declared dirs on PURPOSE: a ref OUTSIDE a
   * shared dir is never RESOLVED by a same-named repo-root file — at most it is
   * reported as `repo-root-only`, visibly, never dropped (feedback P1-4).
   */
  readonly sharedDirs?: readonly string[];
  /**
   * How many lines the caller stripped off the FRONT of the file before handing
   * over `skillBody` — added to every finding's `line` so the coordinate names a
   * line of the real SKILL.md.
   *
   * 🔴 Not cosmetic, and not the caller's to patch afterwards. `markdownRefs`
   * counts from one over whatever string it gets, so a detector fed a
   * frontmatter-stripped body emits coordinates short by exactly that block —
   * measured on a 5-line frontmatter: the ref on file line 11 printed as 6
   * (#206). An author who opens the printed line finds something else and either
   * calls the finding false or edits the wrong line. Taking the offset as INPUT
   * keeps the number right where it is produced, instead of relying on every
   * consumer to remember; same shape as `doc-refs.ts`'s `firstLine + line`.
   * Defaults to 0 — a caller passing a whole file needs nothing.
   */
  readonly lineOffset?: number;
}

// ---------------------------------------------------------------------------
// Shapes we match vs deliberately skip (FP-safety)
// ---------------------------------------------------------------------------

// The Agent-Skills standard bundle subdirectories. A path PREFIXED by one of
// these is unambiguously a local bundled resource, even without a `./`.
const BUNDLE_DIRS = ["scripts", "references", "assets"] as const;
const BUNDLE_PREFIX = new RegExp(`^(?:${BUNDLE_DIRS.join("|")})/`);

// A path must carry a file extension to be a resource reference. A bare word or
// a directory name (`scripts/lib`) is undecidable prose — skipped.
const HAS_EXT = /\.[A-Za-z0-9]+$/;

/**
 * A reference target is a LOCAL BUNDLED RESOURCE worth resolving iff it is a
 * relative path with a file extension AND is not one of the skip shapes. This is
 * the single gate; both the link path and the inline-path path run through it.
 */
function localResourceTarget(rawTarget: string): string | null {
  // Strip a markdown link title / fragment / query if present, and trim.
  const target = rawTarget.trim();
  if (target.length === 0) return null;

  // SKIP: URLs (http://, https://, mailto:, any scheme://) — external.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^mailto:/i.test(target)) {
    return null;
  }
  // SKIP: a pure anchor / fragment-only link (`#section`).
  if (target.startsWith("#")) return null;
  // SKIP: absolute paths (`/etc/x`, Windows `C:\`) — not bundled-relative.
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return null;
  // SKIP: variable tokens (`${CLAUDE_PLUGIN_ROOT}/x`, `$VAR/x`) — uncheckable,
  // and almost always a plugin-root or runtime path, not a bundled file.
  if (target.includes("$")) return null;
  // SKIP: `~/`-rooted paths — the user's home / machine-global config, referenced
  // intentionally from OUTSIDE the repo (JIT routing like `Read ~/.claude/docs/x.md`).
  // Not a repo-bundled resource; unverifiable from the repo and never a "broken ref".
  if (target === "~" || target.startsWith("~/")) return null;
  // Drop a URL fragment / query suffix so `references/api.md#auth` AND
  // `references/schema.json?raw=1` resolve to the file. Done BEFORE the glob skip
  // below so a legitimate `?query` suffix on a real bundled ref isn't mistaken for
  // a glob `?` and wrongly skipped — the file must still be checked. (Only after
  // the scheme check above, so we never mangle a URL.)
  const path = target.replace(/[?#].*$/, "");
  if (path.length === 0) return null;

  // SKIP: percent-encoded paths (`%20`, `%2F`, …) — a LOCAL bundled file on disk is
  // never URL-encoded; a `%NN` sequence marks a URL or a documentation EXAMPLE about
  // encoding spaces/paths (`[a file](docs/My%20File.pdf)` demonstrating space handling),
  // not a real resource. Prefer missing a (vanishingly rare) literal `%`-named file over
  // the false positive of flagging a prose example as a broken ref (don't-cry-wolf).
  if (/%[0-9A-Fa-f]{2}/.test(path)) return null;

  // SKIP: globs and template placeholders — a ref carrying a glob metacharacter
  // (`*`) or a brace/angle-bracket placeholder (`{trivial,…}`, `<linter>`) is a
  // directory CONVENTION or an example, not a concrete file (`references/*.md`,
  // `references/linter-cards/{a,b}/<linter>.md`). Resolving it as a literal path and
  // reporting "missing" is a false positive (feedback P1-3). `?` is intentionally
  // NOT in this class — it's the query separator stripped above; a genuine `?`-glob
  // truncates to an extensionless path and is dropped by HAS_EXT below anyway.
  if (/[*{}<>]/.test(path)) return null;

  // SKIP: a `../` escape OUT of the skill dir — undecidable / not a bundled
  // resource (it points at a sibling skill or the repo). A leading `./` is fine.
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith("../") || normalized.includes("/../")) return null;

  // Must look like a file (have an extension), else it's a dir/prose mention.
  if (!HAS_EXT.test(normalized)) return null;

  return normalized;
}

/**
 * Whether an inline-code path token is high-confidence enough to flag on its
 * own (no surrounding `[..](..)` link syntax). We require a BUNDLE-DIR PREFIX
 * (`scripts/`, `references/`, `assets/`) so a generic `` `config.json` `` or a
 * `` `src/foo.ts` `` API mention in prose is never flagged — only the standard
 * bundle layout, which is unambiguously a shipped resource.
 */
function isInlineBundlePath(token: string): boolean {
  const t = token.trim();
  // A single token only — a span with spaces is a command/prose, not a path.
  if (/\s/.test(t)) return false;
  const normalized = t.replace(/^\.\//, "");
  return BUNDLE_PREFIX.test(normalized) && HAS_EXT.test(normalized);
}

// ---------------------------------------------------------------------------
// Prose gate (don't-cry-wolf on TEACHING / illustrative skills)
// ---------------------------------------------------------------------------
//
// A bundle-path reference — whether an inline-code mention (`` `scripts/foo.py` ``)
// or a markdown link (`[..](scripts/foo.py)`) — can be an ILLUSTRATIVE EXAMPLE
// rather than a real shipped resource. Skills that TEACH how to build skills
// (e.g. the official `skill-development` skill) are full of bundle paths used
// as EXAMPLES of what a skill *could* contain, not as references to a file the
// skill actually ships: "a `scripts/rotate_pdf.py` would be helpful to store",
// "**Examples**: `references/finance.md` …", "- **`references/patterns.md`** —
// Common patterns". A markdown link is not immune either — a skill documenting
// "how to escape a space in a bundled filename" routinely shows an EXAMPLE
// link (`[a report](assets/My-Escaped-Space.pdf)`) that is prose, not a real
// dead ref (issue #110). Flagging those as "bundled resource not found" cries
// wolf and graded a clean, correct skill an F.
//
// So a reference — link or inline path — is only treated as real when the
// surrounding prose DIRECTS the agent to ACT on the file (read/run/see/…) AND
// carries no illustrative/hypothetical cue. We bias HARD toward precision
// here: missing a real dead-ref is far better than a false positive on a
// teaching skill (the same don't-cry-wolf discipline as the loader's
// `danglingRefs`). A markdown link is still the HIGHER-confidence shape (it
// requires an explicit `[text](target)`, not just a bare backtick span), but
// the illustrative-cue skip applies to it too — see `inlinePathIsUsed`.

// Verbs that direct the agent to CONSUME an existing file. Deliberately EXCLUDES
// authoring verbs (store/create/add/move/write) — "a `scripts/x.py` would be
// helpful to STORE in the skill" is describing a resource to CREATE, exactly
// what a teaching skill illustrates, not a file the skill already ships.
const USE_DIRECTIVE =
  /\b(run|runs|execute|executes|read|reads|load|loads|open|opens|source|sources|import|imports|see|view|refer|follow|call|invoke|apply|consult|check)\b/i;

// Illustrative / hypothetical prose cues — a line carrying one is describing
// what a skill MIGHT contain (an example, a suggestion, a template), not
// pointing at a shipped file. Includes the `→`/`->` arrow used in "move detail
// → `references/x.md`" authoring lists.
const ILLUSTRATIVE_CUE =
  /\b(example|examples|e\.g\.?|i\.e\.?|such as|for instance|would be|helpful|useful|template|boilerplate)\b|→|->/i;

/**
 * An ATX markdown heading (`## …`, up to three leading spaces per CommonMark).
 *
 * 🔴 WHY A HEADING COUNTS AS A USE-DIRECTIVE. The verb gate below reads PROSE,
 * and a heading is not prose — it is the section's label. So the single most
 * common way a skill points at its own bundled script, naming it in the heading
 * of the section about running it, carried no verb and went unchecked:
 *
 *     ## 🏗 START WITH THE MECHANICAL LEG — `scripts/structure.mjs`
 *
 * Measured 2026-08-08 on a real skill whose `structure.mjs` sits at the skill
 * ROOT, not under `scripts/`: that line yielded NOTHING. Rewriting the same
 * heading to "Run the mechanical leg" — same file, same ref, same missing
 * target — correctly yielded the finding. The tool's answer depended on the
 * author's choice of verb, and it stayed silent for three days.
 *
 * The narrow fix, and deliberately not the wide one. The alternative — treat
 * ANY bundle-dir path with an extension as a reference, verb or not — reopens
 * exactly the false positives the gate exists for (a skill TEACHING how to
 * build skills mentions `scripts/rotate.py` constantly as prose). A heading
 * naming a bundle path is a structural claim about what this section is about,
 * not a sentence illustrating what a skill *could* ship, so it earns the same
 * standing as an explicit "run …". The illustrative-cue veto still applies —
 * `## Examples: \`references/finance.md\`` stays skipped — and the check is
 * `warn` severity with a `vigiles-disable` escape hatch, so a slightly wider
 * net is affordable where a blanket one is not.
 */
const MD_HEADING = /^\s{0,3}#{1,6}\s/;

/**
 * Whether the line describes a file the skill PRODUCES rather than one it ships.
 *
 * 🔴 WHY THIS IS SEPARATE FROM {@link ILLUSTRATIVE_CUE}. That one vetoes a
 * HYPOTHETICAL mention — "a `scripts/rotate.py` would be helpful". This one
 * vetoes a mention that is entirely real and entirely concrete, and still names
 * a file that cannot be a bundled resource, because the skill's own prose says
 * the file is written at runtime. Same veto, different reason, and collapsing
 * them into one list would make the next reader think a gitignored cache is a
 * kind of example.
 *
 * It is the read the module already takes elsewhere: {@link USE_DIRECTIVE}
 * deliberately EXCLUDES authoring verbs (store/create/add/move/write) because
 * "a file to CREATE" is not "a file the skill already ships". A cache written
 * by the skill's own script is that same case; the verb list simply never
 * covered the writing side.
 *
 * MEASURED 2026-08-20 on a real consumer skill (`verify-citations`), which read:
 *
 *     API responses are cached to `scripts/.cite-cache.json` (gitignored) so
 *     re-runs are cheap.
 *
 * That produced `bundled resource not found`. Isolated to one word with a
 * three-line fixture differing only in its tail: the same sentence ending
 * "so subsequent invocations are cheap" stayed silent, and the same sentence
 * with no tail stayed silent. The culprit is `re-runs` — JavaScript's `\b`
 * counts a hyphen as a word boundary, so `USE_DIRECTIVE`'s `runs` matches
 * INSIDE it, and a plural noun about repetition was read as an instruction to
 * run the file.
 *
 * Fixing the hyphen instead was rejected by that same measurement: "re-run
 * `scripts/x.sh` before submitting" is a genuine directive, so a rule about
 * hyphens would trade this false positive for a false negative. The honest
 * discriminator is not the hyphen, it is that the line says the file is made,
 * not read. `gitignored` is the strongest form — a file the author states is
 * outside the repository cannot be shipped inside it.
 */
const GENERATED_FILE_CUE =
  /\bgit-?ignored\b|\.gitignore\b|\bcached? to\b|\bcache file\b|\bwrit(?:ten|es) to\b|\b(?:generated|created) at runtime\b/i;

/**
 * Whether a bundle-path reference on this line reads as a REAL reference (the
 * agent is told to use the file) rather than an illustrative mention. Requires
 * a positive directive — a use verb, or the line being a heading (see
 * {@link MD_HEADING}) — and the absence of an illustrative cue, both evaluated
 * over the whole line for simplicity (a tight, precise rule over a clever one).
 * BOTH candidate shapes consult this (issue #110) — a markdown link's
 * `[text](target)` syntax is a stronger signal than a bare inline span, but
 * "For example, see [the schema](...)" is still an illustrative mention, not a
 * real dead ref.
 */
function inlinePathIsUsed(line: string): boolean {
  if (ILLUSTRATIVE_CUE.test(line) || GENERATED_FILE_CUE.test(line))
    return false;
  return USE_DIRECTIVE.test(line) || MD_HEADING.test(line);
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

interface Candidate {
  readonly ref: string;
  readonly resolved: string;
  readonly kind: SkillResourceKind;
  readonly line: number;
}

/**
 * Turn one structural markdown reference into a candidate, or `null`.
 *
 * `line` is the raw source line, used ONLY by the prose gate — the candidate
 * itself comes from {@link markdownRefs}, never from the characters. That split
 * is load-bearing: the gate reads prose because prose is what it judges, while
 * a REFERENCE is a thing the parser found.
 */
function candidateFor(ref: MarkdownRef, line: string): Candidate | null {
  if (ref.kind === "link") {
    // A markdown link is EXPLICIT follow-me syntax — the DESTINATION is the
    // reference — so it's real UNLESS the line is an illustrative example.
    // Suppress it ONLY on an illustrative cue; do NOT also require a use
    // directive, or a plain `Resources: [API](references/api.md)` (no verb)
    // goes unchecked (Codex review — that under-detection).
    if (ILLUSTRATIVE_CUE.test(line) || GENERATED_FILE_CUE.test(line))
      return null;
    const resolved = localResourceTarget(ref.value);
    if (resolved === null) return null;
    return { ref: ref.value.trim(), resolved, kind: "link", line: ref.line };
  }
  // A bare inline backtick path is noisier (often just a mention), so it needs
  // BOTH a use directive AND no cue, and only in the high-confidence
  // bundle-dir-prefixed form.
  if (!inlinePathIsUsed(line)) return null;
  const token = ref.value.trim();
  if (!isInlineBundlePath(token)) return null;
  const resolved = localResourceTarget(token);
  if (resolved === null) return null;
  return { ref: token, resolved, kind: "path", line: ref.line };
}

/**
 * A SKILL.md body carrying this marker opts OUT of skill-resource checking
 * entirely — the inline escape hatch (issue #110), mirroring `orphans.ts`'s
 * `vigiles-disable orphan-docs`. For a skill whose body is inherently full of
 * illustrative bundle-path examples (a skill-authoring tutorial) that still
 * trips the heuristic despite the prose gate above.
 */
const DISABLE_RE = /<!--\s*vigiles-disable\s+skill-resource-resolves\s*-->/;

/** Where a candidate's path was found — `found` is the one outcome not reported. */
type Lookup = "found" | SkillResourceResolution;

/**
 * Look a candidate up, in the order a reader of the skill would: beside the
 * SKILL.md, then the repo root through a DECLARED shared dir (resolved — the
 * repo said this tree is shared), then the repo root on its own (`repo-root-only`
 * — it works from here, but nothing declared it, so it is reported).
 */
function lookup(
  rel: string,
  skillDir: string,
  opts: SkillResourceOptions,
): Lookup {
  const exists = opts.existsSync;
  if (exists(resolve(skillDir, rel))) return "found";
  if (opts.repoRoot === undefined) return "missing";
  if (!exists(resolve(opts.repoRoot, rel))) return "missing";
  const sharedDirs = opts.sharedDirs ?? [];
  return sharedDirs.includes(rel.split("/")[0]) ? "found" : "repo-root-only";
}

/**
 * The bundled-resource references in a SKILL.md body that don't resolve under
 * `skillDir`, each tagged with its {@link SkillResourceResolution}. Pure + FP-safe
 * (see the module header). `skillDir` is the directory the SKILL.md itself lives
 * in (resources are bundled beside it).
 *
 * The shared detector behind both `vigiles lint` (the `skill-resource-resolves`
 * rule) and `vigiles audit` (the read-only report) — one detector, no drift.
 */
export function skillResourceIssues(
  skillBody: string,
  skillDir: string,
  opts: SkillResourceOptions,
): readonly SkillResourceFinding[] {
  if (DISABLE_RE.test(skillBody)) return [];
  const lineOffset = opts.lineOffset ?? 0;
  const lines = skillBody.split("\n");
  const reported = markdownRefs(skillBody).flatMap(
    (ref): readonly SkillResourceFinding[] => {
      const c = candidateFor(ref, lines[ref.line - 1] ?? "");
      if (c === null) return [];
      const resolution = lookup(c.resolved, skillDir, opts);
      return resolution === "found"
        ? []
        : [{ ...c, line: c.line + lineOffset, resolution }];
    },
  );
  // De-dupe the same file referenced several times in the body: the first
  // mention is the one reported.
  return reported.filter(
    (f, i) =>
      reported.findIndex(
        (g) => g.kind === f.kind && g.resolved === f.resolved,
      ) === i,
  );
}

/**
 * What a `repo-root-only` finding means and what to do about it — ONE sentence
 * shared by every surface that prints the note (`audit`'s text and HTML report,
 * `lint`'s line and its CI annotation), so they cannot drift apart.
 *
 * The cure depends on the path's shape: `sharedDirs` declares a top-level
 * DIRECTORY, so a ref under one (`scripts/check.sh`) can be declared shared,
 * while a bare file at the root (`guide.md`) has no directory to declare and the
 * only cure is to ship it beside the SKILL.md.
 */
export function repoRootOnlyAdvice(
  f: SkillResourceFinding<"repo-root-only">,
): string {
  const slash = f.resolved.indexOf("/");
  const cure =
    slash > 0
      ? `If repo-root resolution is intended, add "${f.resolved.slice(0, slash)}" to sharedDirs in .vigilesrc.json.`
      : "Ship it beside the SKILL.md if the skill is meant to be installed elsewhere.";
  return (
    "resolves only from the repo root, not from the skill directory — " +
    `it breaks once the skill is installed outside this repository. ${cure}`
  );
}
