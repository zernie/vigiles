/**
 * rule-routing.ts — the deterministic (no-model) State-B routing PREVIEW.
 *
 * `rule-inventory.ts` answers a narrow question ("which prose lines name an
 * off-the-shelf lint rule, and is it enabled?"). This goes one honest step
 * further: it SEGMENTS the whole instruction file into atomic rules
 * ({@link segmentInstructions}) and routes each one into the class that a real
 * enforcement path would take — WITHOUT running a model:
 *
 *   reuse    → the rule text names an off-the-shelf lint rule ({@link INTENT_MAP})
 *              → mechanism: flip one config line. The "narrow list we compile
 *              very well" — everything else is honestly labelled, not force-fit.
 *   hook     → an ACTION rule a linter can't see (git push, rm -rf, "before you
 *              commit") → mechanism: a pre-commit / PreToolUse hook.
 *   meta     → an agent-instruction, not a code rule ("read X first", "tell the
 *              user", "you are …") → mechanism: stays prose. Split out of
 *              `unrouted` so it never reads as "compilable but hard" (it isn't).
 *   semantic → a judgment call ("readable", "single responsibility") no checker
 *              can honestly decide → mechanism: stays prose.
 *   unrouted → looks like a code rule but matched no off-the-shelf rule: HARD to
 *              codify → mechanism `synthesize`: the opt-in SYNTHESIS tier (a
 *              skill on your subscription) MIGHT write a custom checker, gated —
 *              but it is NOT guaranteed (the gate may abstain). This is the
 *              bucket audit must present clearly as "hard", never as done.
 *
 * NB "compile" is NOT used here — `vigiles compile` is the unrelated spec→markdown
 * verb. Synthesis is its own opt-in tier; the mechanism value is `synthesize`.
 *
 * HONESTY BY CONSTRUCTION: the deterministic tier NEVER claims a rule is
 * "synthesizable" — deciding that a custom rule can be written (and gating it)
 * is exactly the work the opt-in model tier does. `unrouted` means "hard — a
 * synthesis skill may try", never a promise; `meta`/`semantic` mean "not an
 * enforceable code rule at all" (a different, honest kind of no).
 *
 * Pure, deterministic, dependency-free. Reuses `rule-inventory`'s hardened
 * whole-token matcher + `INTENT_MAP`, and `segment`'s Tier-A segmenter.
 */
import {
  segmentInstructions,
  type SegmentedRule,
  type SkippedBullet,
} from "./segment.js";
import {
  INTENT_MAP,
  matchesWholeToken,
  type LinterName,
} from "./rule-inventory.js";
import type { RuleCatalog, AvailableRule } from "./core/rule-catalog.js";
import { NORM_SIGNAL } from "./rule-signals.js";
import { RULE_MARKER_SOURCE } from "./core/enforce-marker.js";

/** How a routed rule would be enforced (a MECHANISM ladder, not a 1-10 score). */
export type RuleCategory = "reuse" | "hook" | "meta" | "semantic" | "unrouted";
export type RuleMechanism = "config-line" | "hook" | "prose" | "synthesize";

/** The mechanism each category maps to — a fixed, honest ladder. */
const MECHANISM: Record<RuleCategory, RuleMechanism> = {
  reuse: "config-line",
  hook: "hook",
  meta: "prose",
  semantic: "prose",
  unrouted: "synthesize",
};

/**
 * The user-facing presentation of each routing category — its glyph + lane
 * label. The SINGLE SOURCE the terminal summary reads (and the HTML report
 * mirrors), so the category-name → lane-label mapping lives in one place.
 *
 * NB the type name `unrouted` is a WIRE value (it appears in the versioned
 * `AuditReport` JSON), which is why it isn't renamed to its lane label `custom`;
 * this table is where the human-facing name is resolved. The category meanings
 * are documented in the file header; the mapping is tabled in
 * `research/rule-enforcer-design.md` §4.
 */
export const LANE_META: Record<
  RuleCategory,
  { readonly glyph: string; readonly label: string }
> = {
  reuse: { glyph: "✓", label: "enforceable" },
  hook: { glyph: "⛓", label: "hook" },
  unrouted: { glyph: "⚙", label: "custom" },
  semantic: { glyph: "✎", label: "judgment" },
  meta: { glyph: "☰", label: "agent-note" },
};

/** One segmented, deterministically-routed rule with provenance. */
export interface RoutedRule {
  /** Normalized atomic rule text (from the segmenter). */
  readonly text: string;
  /** Verbatim source slice — for a UI highlight. */
  readonly quote: string;
  readonly file: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Segmenter confidence that this IS a rule (3/3 cues → high, 2/3 → medium). */
  readonly confidence: "high" | "medium";
  readonly category: RuleCategory;
  readonly mechanism: RuleMechanism;
  /** reuse only: the off-the-shelf rule that enforces it. */
  readonly rule?: string;
  /** reuse only: the linter that rule belongs to. */
  readonly linter?: LinterName;
  /** reuse via the DYNAMIC catalog only: whether the rule is currently enabled in
   * the repo's config (a disabled match is the "documented but OFF" nudge). */
  readonly enabled?: boolean;
  /** How this rule was found: `"marker"` = an explicit `**Enforced by:**` /
   * `**Guard:**` / `**Guidance only**` marker (definitive, zero-heuristic — a
   * compiled/marked doc); `"heuristic"` = the Tier-A segmenter. Absent ⇒ heuristic. */
  readonly source?: "marker" | "heuristic";
}

export interface RuleRouting {
  /** How many CONFIDENT atomic rules were routed (high or rescued). */
  readonly segmented: number;
  readonly counts: Record<RuleCategory, number>;
  /** The CONFIDENT tier — cleared the precision bar; these are the routed rules. */
  readonly rules: readonly RoutedRule[];
  /** The POSSIBLE tier — rule-ish bullets (medium confidence) that did NOT clear
   * the bar, still classified so a human can review + promote them. Detection is
   * precision-first, so this is where a declarative rule ("Every X must Y") that
   * the confident tier misses shows up. See `research/rule-enforcer-design.md` §2. */
  readonly possible: readonly RoutedRule[];
  /** Bullets the segmenter decided were NOT rules, each with a reason — so the
   * report is honest about what it set aside (§3). */
  readonly skipped: readonly SkippedBullet[];
}

export interface RouteOptions {
  /**
   * Minimum segmenter confidence to route. The segmenter emits `high` (3/3 cues
   * — an imperative rule) and `medium` (2/3). For the audit PREVIEW we default to
   * `high` only: precision over recall. A doc-heavy instruction file (e.g. a
   * keyFiles index of "`path` — description" bullets) trips the medium tier with
   * non-rules, which would bury the real rules and overstate "unrouted". Pass
   * `"medium"` to include both.
   */
  readonly minConfidence?: "high" | "medium";
  /**
   * The repo's DYNAMIC available-rule catalog (from `enumerateEslintCatalog`).
   * When provided (OWN-REPO / consented — it executes the linter), a bullet that
   * NAMES any of the repo's real rules routes to `reuse` with its enabled state —
   * not just the ~23 static `INTENT_MAP` aliases. Absent = foreign-safe default
   * (static map only, no execution).
   */
  readonly availableRules?: RuleCatalog;
}

// NORM_SIGNAL (a deontic modal ANYWHERE) keeps the POSSIBLE review tier to
// genuine rule-candidates the imperative gate missed ("every function MUST have
// a docstring") instead of arbitrary prose. It lives in ./rule-signals.ts
// alongside the segment gate's RULE_PREDICATE twin so the two can't drift.

/**
 * ACTION-rule cues — things a linter never sees (git, filesystem, shell,
 * process). A hook is the right gate, not a lint rule. Widened to the article's
 * measured surfaces (vcs / process / shell / redirect) — the narrow original
 * (git-push + rm-rf only) reported ~2% hooks where the 252-rule hand-sort found
 * **37%** (the largest bucket); it was missing push-to-branch, before-push,
 * after-edit, tool-substitution, amend/rebase-pushed, and dependency guards.
 * See `research/rule-enforcer-multilang-design.md` §5b (the hook lane).
 */
const HOOK_CUES: readonly RegExp[] = [
  // — branch / push guards (vcs) —
  /\bgit\s+push\b/i,
  // "push … to main/master/prod/origin" — tolerate backticks/adverbs between.
  /\bpush\w*\b[^.\n]{0,24}\b(main|master|prod|production|origin|development)\b/i,
  /\bforce[- ]?push/i,
  /\bpush\w*\b[^.\n]{0,16}\bbranch/i,
  // — protected paths (vcs) —
  /\b(don'?t|do not|never)\s+(edit|modify|touch|change)\b[^.\n]{0,30}\b(generated|vendored|lock(file)?|\.pb\.|proto-gen|_mock|snapshot)/i,
  /\bgenerated\s+files?\b/i,
  // — sequencing / tests-before / after-edit (process) —
  /\b(run|execute)\b[^.\n]{0,30}\b(tests?|lint|check|type-?check|format|prettier|ruff)\b[^.\n]{0,20}\bbefore\b/i,
  /\bbefore\s+(you\s+|each\s+|every\s+)?(commit|push|merg|committing|pushing)/i,
  /\brun\b[^.\n]{0,20}\btests?\b[^.\n]{0,14}\bbefore\b/i,
  /\b(format|lint|check|run)\b[^.\n]{0,30}\b(after|immediately after)\b[^.\n]{0,16}\b(writ|edit)/i,
  // — tool substitution / redirect —
  /\b(never|do not|don'?t)\s+run\b[^.\n]{0,30}\b(directly|instead)\b/i,
  /\b(never|do not|don'?t)\s+run\b[^.\n]{0,20}`?(eslint|prettier|npm|npx|cargo|yarn|pnpm|pip|black|ruff)\b/i,
  /\buse\b\s+`?[\w:.-]+`?\s+(instead of|not|over|rather than)\s+`?(npm|npx|cargo|yarn|pnpm|eslint|prettier)\b/i,
  // — regenerate-on-change guard (vigiles's own guard() path→cmd shape: "run X
  //   after/when Y changes") — the single biggest missed-hook pattern in the OSS
  //   dogfood. Both clause orders; the trigger MUST be a change-verb so a benign
  //   "run it when ready" doesn't match.
  /\b(re-?run|regenerate|re-?generate|rebuild|regen|run|update)\b[^.\n]{0,48}\b(after|when|whenever|once|if)\b[^.\n]{0,24}\b(chang|add(?:ing|ed)?|modif|updat|edit|new\b)/i,
  /\b(after|when|whenever|once)\b[^.\n]{0,24}\b(chang|add(?:ing|ed)?|modif|updat|edit)[^.\n]{0,48}\b(re-?run|regenerate|rebuild|regen|run|update)\b/i,
  // — commit content / history (vcs) —
  /\b(amend|squash|rebase)\b[^.\n]{0,40}\b(pushed|review|remote|shared)\b/i,
  /--no-verify/i,
  /\b(never|do not|don'?t)\s+commit\b/i,
  /\bsigned-off-by\b/i,
  /\bco-?author(?:s|ed|ing|ed-by)?\b/i,
  // commit/PR METADATA hygiene phrased without a push verb (attribution, PR
  // title, commit message, semantic/conventional commits) — a VCS-surface gate.
  /\b(generated with|attribution)\b[^.\n]{0,24}\b(claude|ai|footer|commit|pr)\b/i,
  /\b(ai|claude|assistant)\b[^.\n]{0,16}\battribution\b/i,
  /\b(semantic|conventional)\s+(commit|pr|pull request)/i,
  // NB: deliberately NO broad `(commit|pr) (title|message)` cue — it mislabels
  // style sentences ("use sentence case for PR titles", "keep commit messages
  // concise") as gates. The enforceable format/attribution rules are caught by
  // the semantic/conventional + attribution cues above; the rest stay prose.
  // — dependency / config guard —
  /\b(never|do not|don'?t)\b[^.\n]{0,20}\bupdate\b[^.\n]{0,20}\b(depend|package\.json|lock)/i,
  // — destructive / shell —
  /\brm\s+-rf\b/i,
  /\bcurl\b.*\|\s*(sh|bash)/i,
  /\bchmod\b/i,
  /\bdestructive\s+git\b/i,
];

/**
 * Judgment / no-checker cues — a rule no linter can honestly decide, so it stays
 * labeled prose. Ported from the compiler's classifier (the static markers only —
 * no ruleMap dependency, to keep this file model-free and dep-free).
 */
const SEMANTIC_CUES: readonly RegExp[] = [
  /\bself[- ]?documenting\b/i,
  /\bclear(er)?\s+(names?|code|over clever)/i,
  /\breadable\b/i,
  /\bkeep it simple\b/i,
  /\bover[- ]?engineer/i,
  /\bsingle responsibility\b/i,
  /\bcomposition over inheritance\b/i,
  /\bmeaningful\b/i,
  /\bidiomatic\b/i,
  /\bwhere (it )?makes sense\b/i,
  /\bappropriate(ly)?\b/i,
  /\bsolid\s+principles?\b/i,
  /\bbest practices?\b/i,
  /\bclean code\b/i,
];

/**
 * META cues — an instruction to the AGENT, not a norm about the CODE ("read X
 * first", "tell the user", "you are …", "when in doubt ask"). It is not a lint
 * rule and never will be, so it must NOT land in `unrouted` (which reads as
 * "compilable, just hard"). High-precision by design — specific phrasings a real
 * code rule would not use.
 */
const META_CUES: readonly RegExp[] = [
  // allow `.` in the gap — the referenced thing is often a filename (CLAUDE.md)
  /\bread\b[^\n]{0,30}\bfirst\b/i,
  /\bwhen in doubt\b/i,
  /\bif (you'?re |you are )?unsure\b/i,
  /\bask (the user|first|before)\b/i,
  /\btell (the user|me)\b/i,
  /\byou are\b[^.\n]{0,40}\b(assistant|agent|engineer|claude|model)\b/i,
  /\byour (job|task|role) is\b/i,
  /\b(do not|don'?t|never) (tell|mention|reveal|say)\b/i,
  /\bin (chat|your (reply|response|answer))\b/i,
  // H5 agent-ATTENTION norms (Fable's hook-lane taxonomy): re-read / re-run /
  // re-fetch "without code changes". NOTHING reliably gates these — blocking a
  // re-read breaks post-compaction recovery (false safety worse than an
  // under-blocking guard) — so they are agent-guidance (meta), never a gate. The
  // right instrument is MEASUREMENT (the flight recorder), not enforcement.
  /\bre-?read(?:ing)?\b/i,
  /\bre-?run(?:ning)?\b[^\n]{0,30}\b(?:test|command|suite)\b/i,
  /\bre-?fetch(?:ing)?\b/i,
  /\bwithout code changes\b/i,
];

/**
 * CONSTRUCT-PROHIBITION → a parameterized BUILT-IN rule. A whole class of
 * "no <language construct>" rules that LOOK custom ("never use classes", "no
 * default exports", "avoid enums") are actually enforceable by ESLint's built-in
 * `no-restricted-syntax` with the right AST selector — no synthesis needed. Each
 * pattern requires a PROHIBITION head next to the construct (precision-first: a
 * negative lookbehind rejects "avoid CSS classes"/"utility classes", the gap cap
 * rejects "first-class functions"/"a class of bugs"). Grounded in real OSS rules
 * (betterauth "NEVER use classes", "prefer named over default exports"). These
 * feed `reuse` — moving rules out of the "hard to codify" lane deterministically.
 */
interface PatternRule {
  readonly construct: string;
  readonly rule: string;
  readonly linter: LinterName;
  readonly pattern: RegExp;
  /** The one-line config that enforces it (a parameterized selector / message). */
  readonly configFix: string;
}
/** Every construct-prohibition maps to the same ESLint rule with a different
 * selector — one named constant so the shared id isn't repeated as a literal. */
const NO_RESTRICTED_SYNTAX = "no-restricted-syntax";
const PATTERN_RULE_MAP: readonly PatternRule[] = [
  {
    construct: "default exports",
    rule: NO_RESTRICTED_SYNTAX,
    linter: "eslint",
    pattern:
      /\b(?:no|never|avoid|don'?t\s+use|do\s+not\s+use|disallow|ban|forbid|prefer\s+named\s+(?:exports?\s+)?over)\b[^.\n]{0,24}\bdefault\s+exports?\b/i,
    configFix:
      '"no-restricted-syntax": ["error", { "selector": "ExportDefaultDeclaration", "message": "Use named exports." }]',
  },
  {
    construct: "enums",
    rule: NO_RESTRICTED_SYNTAX,
    linter: "eslint",
    pattern:
      /\b(?:no|never|avoid|don'?t\s+use|do\s+not\s+use|disallow|ban|forbid)\b[^.\n]{0,24}\benums?\b/i,
    configFix:
      '"no-restricted-syntax": ["error", { "selector": "TSEnumDeclaration", "message": "Use a union or const object instead of an enum." }]',
  },
  {
    construct: "for...in",
    rule: NO_RESTRICTED_SYNTAX,
    linter: "eslint",
    pattern:
      /\b(?:no|never|avoid|don'?t\s+use|do\s+not\s+use|disallow|ban|forbid)\b[^.\n]{0,16}\bfor[\s.]{0,3}in\b/i,
    configFix:
      '"no-restricted-syntax": ["error", { "selector": "ForInStatement", "message": "Use for...of or Object.keys()." }]',
  },
  {
    construct: "namespaces",
    rule: NO_RESTRICTED_SYNTAX,
    linter: "eslint",
    pattern:
      /\b(?:no|never|avoid|don'?t\s+use|do\s+not\s+use|disallow|ban|forbid)\b[^.\n]{0,24}\bnamespaces?\b/i,
    configFix:
      '"no-restricted-syntax": ["error", { "selector": "TSModuleDeclaration", "message": "Use ES modules instead of namespaces." }]',
  },
  {
    construct: "classes",
    rule: NO_RESTRICTED_SYNTAX,
    linter: "eslint",
    pattern:
      /\b(?:no|never|avoid|don'?t\s+use|do\s+not\s+use|disallow|ban|forbid)\b[^.\n]{0,12}\b(?<!css |style |styling |utility |tailwind |dom |react |component )(?:es6?\s+|javascript\s+)?class(?:es)?\b(?![\s-]*(?:name|attribute|selector|list))/i,
    configFix:
      '"no-restricted-syntax": ["error", { "selector": ":matches(ClassDeclaration, ClassExpression)", "message": "Prefer functions and closures over classes." }]',
  },
  // Pylint: REQUIRE docstrings → missing-function-docstring. A PRESENCE context is
  // required (a presence verb near "docstring", or "docstrings required/for each")
  // so a bare "docstring" mention does NOT over-fire: the dogfood caught langchain
  // routing docstring-CONTENT/STYLE rules ("docstring warnings", "backticks in
  // docstrings", "don't repeat the default in the docstring") to this presence
  // check — those are pydocstyle/ruff-D territory, not missing-docstring.
  {
    construct: "docstrings (presence)",
    rule: "missing-function-docstring",
    linter: "pylint",
    pattern:
      /\b(?:add|require|requires?|write|writing|include|need|needs?|use|using|provide|document|must\s+have)\b[^.\n]{0,24}\bdocstrings?\b|\bdocstrings?\b[^.\n]{0,24}\b(?:required|mandatory|for\s+(?:all|every|each|every|public)|on\s+(?:all|every|each))\b/i,
    configFix:
      "pylint enables missing-function-docstring (C0116) by default; keep it out of the disable list",
  },
];

interface Classification {
  readonly category: RuleCategory;
  readonly rule?: string;
  readonly linter?: LinterName;
  readonly enabled?: boolean;
}

/**
 * Backticked rule-id-shaped tokens a bullet names — `curly`, `curly: error` →
 * `curly`, `@typescript-eslint/consistent-type-imports`, `no-only-tests/no-only-tests`.
 * The leading id is taken (severity/args after a `:`/space are dropped), so the
 * token can be looked up against the dynamic catalog.
 */
const CODE_SPAN_RE = /`([^`]+)`/g;
function namedRuleTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    const id = m[1].trim().match(/^@?[a-z][\w-]*(?:\/[a-z][\w-]*)*/i);
    if (id) out.push(id[0]);
  }
  return out;
}

/**
 * Route one atomic rule. Order matters: an ACTION cue (git push) wins over a
 * rule-name mention ("never commit console.log" is a hook, not a lint rule); a
 * META agent-instruction is pulled out before reuse so it isn't mismatched to a
 * rule; the DYNAMIC catalog (if present) and the static `INTENT_MAP` both feed
 * `reuse`; reuse wins over a soft semantic cue.
 */
/** A dynamic-catalog lookup result: which linter the named rule belongs to, and
 * whether it's currently enabled. Carrying the linter (not just a bool) is what
 * lets a polyglot repo's map say `pylint:invalid-name` vs `eslint:no-console`. */
type CatalogHit = { enabled: boolean; linter: "eslint" | "pylint" };

/** Combine two hits that a doc-token resolves to (a cross-linter id collision).
 * enabled OR-s — a "**Enforced by:** X" claim is satisfied if ANY linter has X
 * on, so we never cry "documented but OFF" when one linter enforces it — and
 * provenance follows the enforcing linter. */
function combineHits(a: CatalogHit, b: CatalogHit): CatalogHit {
  if (a.enabled === b.enabled) return { enabled: a.enabled, linter: a.linter };
  return a.enabled ? a : b; // exactly one is on → it wins (enabled OR-s to true)
}

/** Build the doc-token → hit lookup from a (possibly polyglot) rule list. A rule
 * is matchable by its id AND, for Pylint, its numeric code. A bare id CAN collide
 * across linters (`no-else-return` is in both ESLint and Pylint) → combine
 * conservatively. A numeric code is unique to its linter, so it never collides
 * and KEEPS its own (linter, enabled) — a doc naming the Pylint code `R1705`
 * still surfaces "documented but OFF" even when the symbol is enabled in ESLint. */
function buildCatalogLookup(
  rules: readonly AvailableRule[],
): Map<string, CatalogHit> {
  const map = new Map<string, CatalogHit>();
  const put = (key: string, hit: CatalogHit): void => {
    const prev = map.get(key);
    map.set(key, prev ? combineHits(prev, hit) : hit);
  };
  for (const r of rules) {
    const hit: CatalogHit = { enabled: r.enabled, linter: r.linter };
    put(r.id, hit);
    if (r.code) put(r.code, hit);
  }
  return map;
}

function classify(
  text: string,
  catalog?: ReadonlyMap<string, CatalogHit>,
): Classification {
  if (HOOK_CUES.some((re) => re.test(text))) return { category: "hook" };
  if (META_CUES.some((re) => re.test(text))) return { category: "meta" };
  // Dynamic catalog: a bullet that NAMES one of the repo's real rules → reuse,
  // carrying its linter + whether it's currently enabled (a disabled hit = the
  // "documented but OFF" nudge). Own-repo only — catalog is present only when the
  // linter was enumerated with consent.
  if (catalog) {
    for (const tok of namedRuleTokens(text)) {
      const hit = catalog.get(tok);
      if (hit !== undefined)
        return {
          category: "reuse",
          rule: tok,
          enabled: hit.enabled,
          linter: hit.linter,
        };
    }
  }
  for (const m of INTENT_MAP) {
    if (m.keywords.some((kw) => matchesWholeToken(text, kw))) {
      return { category: "reuse", rule: m.rule, linter: m.linter };
    }
  }
  // Pattern → a built-in parameterized rule (eslint no-restricted-syntax
  // construct-prohibitions; pylint docstring-presence). These LOOK custom but
  // are reuse; each carries its own linter.
  for (const r of PATTERN_RULE_MAP) {
    if (r.pattern.test(text))
      return { category: "reuse", rule: r.rule, linter: r.linter };
  }
  if (SEMANTIC_CUES.some((re) => re.test(text)))
    return { category: "semantic" };
  return { category: "unrouted" };
}

// --- Structured-marker pre-pass (S0/S1) ------------------------------------

// Either compiled spelling (#351): a "Claimed (unverified)" reference is still a
// rule id the doc routes to its linter — it just was not verified at compile.
const ENFORCED_RE = new RegExp(`^${RULE_MARKER_SOURCE}`);
const GUARD_RE = /^\*\*Guard:\*\*/;
const GUIDANCE_RE = /^\*\*Guidance only\*\*/;
const MARK_HEADING = /^(#{2,6})\s+(.*)$/;
const RULE_ID_SHAPE = /^@?[a-z][a-z0-9._/-]*$/;
// Pylint's numeric alias (C0116, W9006) — the catalog advertises these as
// matchable, so a marker using one must parse as a rule id, not a prose claim.
const PYLINT_CODE_SHAPE = /^[A-Z]\d+$/;

/** Does this `**Enforced by:**` value parse as a lint-rule id (vs a prose claim
 * like "CI" or "the linter")? A hand-written marker is a CLAIM — only a rule-id
 * shape is treated as a real reuse rule. */
function looksLikeRuleId(s: string): boolean {
  const t = s.trim();
  return (t.length >= 3 && RULE_ID_SHAPE.test(t)) || PYLINT_CODE_SHAPE.test(t);
}

/**
 * Extract rules from EXPLICIT structured markers (`**Enforced by:** \`rule\``,
 * `**Guard:**`, `**Guidance only**`) — the S0/S1 tier. A compiled/marked doc
 * declares its own routing, so these are definitive (zero-heuristic) and are
 * CONSUMED before the heuristic segmenter runs (the returned `skip` line set) so
 * a marked rule is never double-counted. Each marker → ONE atom named by its
 * `##`/`###` heading; a `**Guidance only**` body is still routed through
 * `classify` (the promote-prose signal: a guidance whose body says "before
 * commit" surfaces as a would-be hook). Foreign hand-written `**Enforced by:**`
 * is a CLAIM — only a rule-id-shaped value becomes a reuse rule (gated + verified
 * against the catalog when present; never an inferred contradiction).
 */
/** A `**Guidance only**` body is prose UNLESS its text is really an action/agent
 * cue (promote-prose): route the whole body through classify and keep it prose
 * (`semantic`) unless classify sees a genuine hook/meta signal. */
function guidanceClassification(
  section: readonly string[],
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
): Classification {
  const c = classify(section.slice(1).join(" "), catalog);
  return c.category === "hook" || c.category === "meta"
    ? c
    : { category: "semantic" };
}

/** Scan a marked section's BODY for the FIRST structured marker and return its
 * classification, or null if the section declares none (or an `**Enforced by:**`
 * whose value is a prose claim, not a rule id). */
function markerFor(
  section: readonly string[],
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
): Classification | null {
  for (const raw of section.slice(1)) {
    const bl = raw.trim();
    const em = ENFORCED_RE.exec(bl);
    if (em) {
      if (!looksLikeRuleId(em[2])) return null; // a prose claim, not a rule id
      const rule = em[2].trim();
      const hit = catalog?.get(rule);
      return {
        category: "reuse",
        rule,
        ...(hit !== undefined
          ? { enabled: hit.enabled, linter: hit.linter }
          : {}),
      };
    }
    if (GUARD_RE.test(bl)) return { category: "hook" };
    if (GUIDANCE_RE.test(bl)) return guidanceClassification(section, catalog);
  }
  return null;
}

/** Where a marker rule sits in the source — its heading text + line span. */
interface MarkerLoc {
  readonly text: string;
  readonly quote: string;
  readonly file: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** Build a definitive (zero-heuristic) marker `RoutedRule` from a classification
 * and its source location. */
function markerRuleFrom(marked: Classification, loc: MarkerLoc): RoutedRule {
  return {
    text: loc.text,
    quote: loc.quote,
    file: loc.file,
    lineStart: loc.lineStart,
    lineEnd: loc.lineEnd,
    confidence: "high",
    category: marked.category,
    mechanism: MECHANISM[marked.category],
    source: "marker",
    ...(marked.rule ? { rule: marked.rule } : {}),
    ...(marked.linter ? { linter: marked.linter } : {}),
    ...(marked.enabled !== undefined ? { enabled: marked.enabled } : {}),
  };
}

function extractMarkedRules(
  text: string,
  file: string | undefined,
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
): { rules: RoutedRule[]; skip: Set<number> } {
  const lines = text.split("\n");
  const rules: RoutedRule[] = [];
  const skip = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const h = MARK_HEADING.exec(lines[i]);
    if (!h) continue;
    let j = i + 1;
    while (j < lines.length && !MARK_HEADING.test(lines[j])) j++;
    const marked = markerFor(lines.slice(i, j), catalog);
    if (!marked) continue;

    // Consume the section BODY lines (heading stays a non-candidate) so the
    // heuristic segmenter never re-emits this marked rule. (1-based.)
    for (let k = i + 1; k < j; k++) skip.add(k + 1);

    rules.push(
      markerRuleFrom(marked, {
        text: h[2].trim(),
        quote: lines[i],
        file,
        lineStart: i + 1,
        lineEnd: j,
      }),
    );
  }
  return { rules, skip };
}

// --- Rescue ladder + tiering ----------------------------------------------

/** A predicate that RESCUES a medium/rejected bullet to CONFIDENT because the
 * text provably maps to an off-the-shelf rule — independent of the medium
 * opt-in. */
type RescueSource = (
  text: string,
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
) => boolean;

/** The rescue sources, OR-ed (any one promotes a bullet to confident). They are
 * the higher-precision override of the segmenter's imperative-head cue, which
 * alone would drop these medium-scoring bullets. */
const RESCUE_SOURCES: readonly RescueSource[] = [
  // catalog — the text NAMES a rule the repo's live catalog actually has (ground
  // truth, own-repo): rescues "The core layer must not import X (`boundaries/…`)".
  (t, cat) =>
    cat !== undefined && namedRuleTokens(t).some((tok) => cat.has(tok)),
  // pattern — a construct-prohibition ("No default exports") → a real
  // `no-restricted-syntax` rule.
  (t) => PATTERN_RULE_MAP.some((r) => r.pattern.test(t)),
  // intent — an INTENT_MAP keyword match ("No bare except clauses"): a
  // code-shaped, high-precision reuse rule with no imperative verb.
  (t) =>
    INTENT_MAP.some((m) => m.keywords.some((kw) => matchesWholeToken(t, kw))),
];

/** A bullet is RESCUED — promoted to confident — if any rescue source maps it to
 * a real off-the-shelf rule (independent of the medium opt-in). */
function isRescued(
  text: string,
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
): boolean {
  return RESCUE_SOURCES.some((rescue) => rescue(text, catalog));
}

/** The shared shape of a real segment and a folded-back `no-signal` reject, so
 * both flow through one tiering pass. */
interface Candidate {
  readonly text: string;
  readonly exactQuote: string;
  readonly file: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly confidence: "high" | "medium";
}

const foldToCandidate = (s: SkippedBullet): Candidate => ({
  text: s.text,
  exactQuote: s.text,
  file: s.file,
  lineStart: s.lineStart,
  lineEnd: s.lineEnd,
  confidence: "medium",
});

const toNoSignalSkip = (s: Candidate): SkippedBullet => ({
  text: s.text,
  file: s.file,
  lineStart: s.lineStart,
  lineEnd: s.lineEnd,
  reason: "no-signal",
});

/**
 * Split segmenter output into the three routed tiers:
 *
 * - CONFIDENT — high, a medium opt-in, or a RESCUE (names/matches a real rule).
 * - POSSIBLE — a non-confident leftover carrying a norm modal (`NORM_SIGNAL`):
 *   a genuine recall-miss surfaced for review ("every function must have a
 *   docstring"), not routed as fact.
 * - SKIPPED — the rest (index/description/section rejects + no-signal leftovers).
 *
 * THE LOAD-BEARING ASYMMETRY: a gate-rejected `no-signal` bullet is folded back
 * as a candidate but promoted to confident ONLY by a RESCUE — NEVER by the
 * blanket medium opt-in, which must not resurrect what the gate explicitly
 * rejected. See `research/rule-enforcer-design.md` §2.
 */
function partitionCandidates(
  segments: readonly SegmentedRule[],
  rawSkipped: readonly SkippedBullet[],
  catalog: ReadonlyMap<string, CatalogHit> | undefined,
  minConfidence: "high" | "medium",
): { confident: Candidate[]; possible: Candidate[]; skipped: SkippedBullet[] } {
  const rescued = (t: string): boolean => isRescued(t, catalog);
  const isConfident = (s: Candidate): boolean =>
    minConfidence === "medium" || s.confidence === "high" || rescued(s.text);

  const folds = rawSkipped
    .filter((s) => s.reason === "no-signal")
    .map(foldToCandidate);
  const confident: Candidate[] = [
    ...segments.filter(isConfident),
    ...folds.filter((s) => rescued(s.text)),
  ];
  const leftover: Candidate[] = [
    ...segments.filter((s) => !isConfident(s)),
    ...folds.filter((s) => !rescued(s.text)),
  ];
  const possible = leftover.filter((s) => NORM_SIGNAL.test(s.text));
  const skipped: SkippedBullet[] = [
    ...rawSkipped.filter((s) => s.reason !== "no-signal"),
    ...leftover.filter((s) => !NORM_SIGNAL.test(s.text)).map(toNoSignalSkip),
  ];
  return { confident, possible, skipped };
}

/**
 * Segment the instruction file and route every atomic rule deterministically.
 * Pure: the caller passes the concatenated instruction text (and an optional
 * source path for provenance). Returns per-category counts + the routed rules.
 */
export function routeRules(
  instructionText: string,
  file?: string,
  options: RouteOptions = {},
): RuleRouting {
  const minConfidence = options.minConfidence ?? "high";
  const catalog = options.availableRules
    ? buildCatalogLookup(options.availableRules.rules)
    : undefined;
  const toRouted = (s: Candidate): RoutedRule => {
    const c = classify(s.text, catalog);
    return {
      text: s.text,
      quote: s.exactQuote,
      file: s.file,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      confidence: s.confidence,
      category: c.category,
      mechanism: MECHANISM[c.category],
      source: "heuristic",
      ...(c.rule ? { rule: c.rule } : {}),
      ...(c.linter ? { linter: c.linter } : {}),
      ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
    };
  };

  // S0/S1 pre-pass: explicit markers are definitive and are CONSUMED (their body
  // lines are skipped) so the heuristic segmenter can't double-count them. The
  // segmenter output then splits into confident / possible / skipped tiers.
  const marked = extractMarkedRules(instructionText, file, catalog);
  const { segments, skipped: rawSkipped } = segmentInstructions(
    instructionText,
    file,
    marked.skip,
  );
  const tiers = partitionCandidates(
    segments,
    rawSkipped,
    catalog,
    minConfidence,
  );

  // Marker rules first (definitive), then the confident heuristic residue.
  const rules: RoutedRule[] = [
    ...marked.rules,
    ...tiers.confident.map(toRouted),
  ];
  const counts: Record<RuleCategory, number> = {
    reuse: 0,
    hook: 0,
    meta: 0,
    semantic: 0,
    unrouted: 0,
  };
  for (const r of rules) counts[r.category]++;
  return {
    segmented: rules.length,
    counts,
    rules,
    possible: tiers.possible.map(toRouted),
    skipped: tiers.skipped,
  };
}

/**
 * Merge per-file routings into one. Each instruction source is routed SEPARATELY
 * (so every rule keeps its OWN file path + line numbers — concatenating first
 * would corrupt the provenance the preview promises), then folded here: rules
 * concatenated, counts + segmented summed. Pure. `[]` → an empty routing.
 */
export function mergeRoutings(routings: readonly RuleRouting[]): RuleRouting {
  const counts: Record<RuleCategory, number> = {
    reuse: 0,
    hook: 0,
    meta: 0,
    semantic: 0,
    unrouted: 0,
  };
  const rules: RoutedRule[] = [];
  const possible: RoutedRule[] = [];
  const skipped: SkippedBullet[] = [];
  let segmented = 0;
  for (const r of routings) {
    segmented += r.segmented;
    rules.push(...r.rules);
    possible.push(...r.possible);
    skipped.push(...r.skipped);
    for (const k of Object.keys(counts) as RuleCategory[])
      counts[k] += r.counts[k];
  }
  return { segmented, counts, rules, possible, skipped };
}
