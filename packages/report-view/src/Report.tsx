import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Wrench,
  GitCompareArrows,
  ChevronRight,
  Copy,
  Check,
  ShieldAlert,
  Lock,
  Info,
} from "lucide-react";
import type {
  AuditReport,
  CategoryScore,
  Recommendation,
  UngradedGroup,
  Verdict,
} from "./schema";
import { categoryScoreLabel } from "./schema";
import { Badge } from "./components/ui/badge";
import { Band } from "./components/Band";
import { Hero } from "./components/Hero";
import {
  CategoryRings,
  FindingText,
  FlaggedList,
  orderedFindings,
} from "./components/Categories";
import { Adoptability } from "./components/Adoptability";
import { Adopt } from "./components/Adopt";
import { RuleInventory } from "./components/RuleInventory";
import { Observations } from "./components/Observations";
import { AlwaysLoaded } from "./components/AlwaysLoaded";
import { band, type Band as Tone, TEXT, BG, BORDER } from "./lib/band";
import { verdictHeadline } from "./lib/verdict";
import { cn } from "./lib/utils";

/** The one canonical paste-into-agent prompt — reused by the demo's hint line, edge
 *  states, the locked tease, and the site CTA (one artifact, many surfaces). Short
 *  enough to read before pasting, explicitly READ-ONLY, harness-neutral (works pasted
 *  into Claude Code OR Codex). */
export const AUDIT_PROMPT =
  "Run `npx vigiles audit` in this repo and walk me through the report: " +
  "the overall grade, each category, and the top fixes in order of impact. " +
  "It's a read-only audit — don't change any files.";

/** The prompt the LOCKED trigger-rate tease copies — distinct from AUDIT_PROMPT
 *  because that one is a read-only audit and would NOT produce the recall/precision
 *  numbers the tease promises. This one sets vigiles up and runs the model-gated
 *  trigger-rate measurement (measureTriggerRate, via the test-harness skill) on the
 *  user's own Claude subscription. */
export const TRIGGER_RATE_PROMPT =
  "Measure whether my skills actually fire (recall + precision). This is the " +
  "test/eval tier, not the read-only audit — so if vigiles isn't set up in this " +
  "repo yet, run `npx vigiles init` first (that installs the test-harness skill), " +
  "then use that skill to run measureTriggerRate. Report each skill's recall (does " +
  "it fire when it should?) and precision (does it stay quiet on unrelated " +
  "prompts?). It runs on my Claude subscription — no API key.";

/** The audit checks that have a dedicated explainer page at vigiles.sh/checks/<slug>/.
 *  Mirrors the slugs in site/src/checks/checks.ts — a finding whose detector is here
 *  links to its plain-language page. ABSOLUTE url so the link also works from the CLI's
 *  local HTML report (opened as a file://), not just the hosted site. */
const CHECK_PAGE_SLUGS: ReadonlySet<string> = new Set([
  "lethal-trifecta",
  "subagent-tool-contract",
  "mcp-tool-resolves",
  "hook-events",
  "hook-script-exists",
  "description-overlap",
  "skill-frontmatter",
  "subagent-frontmatter",
]);

function checkUrl(slug: string): string {
  return `https://vigiles.sh/checks/${slug}/`;
}

/** Render a check slug as a link to its explainer page when one exists, else plain. */
function CheckLink({
  slug,
  children,
  className,
}: {
  slug: string;
  children: ReactNode;
  className?: string;
}) {
  if (!CHECK_PAGE_SLUGS.has(slug))
    return <span className={className}>{children}</span>;
  return (
    <a
      href={checkUrl(slug)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "underline decoration-dotted underline-offset-2",
        className,
      )}
    >
      {children}
    </a>
  );
}

/** The last path segment — the audited dir reads as a plugin name, not a path. */
function basename(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || dir;
}

/**
 * The Safety findings to surface as red "Review — no auto-fix" cards — the HARD
 * lethal-trifecta findings only. Two kinds are deliberately excluded so a report
 * that isn't actually failing on safety never shows a red defect card:
 *   - a `null` score → the "no tool-bearing surface to assess" n/a note (an
 *     instructions-only repo), NOT a trifecta finding;
 *   - an `(advisory)`-suffixed finding → the inherits-all note, which the scorer
 *     appends WITHOUT reducing the score (a broad-by-default A/100 repo), so it must
 *     not read as a hard defect.
 * The scorer flattens hard + advisory findings into one string array (no per-finding
 * severity in the wire shape), so the stable `(advisory)` suffix is the only signal.
 * One home so the summary + full paths can't diverge.
 */
function safetyReviewFindings(
  categories: readonly CategoryScore[],
): readonly string[] {
  const safety = categories.find((c) => c.key === "Safety");
  if (!safety || safety.advisory || safety.score === null) return [];
  return safety.findings.filter((f) => !f.endsWith("(advisory)"));
}

/**
 * The fixes-section empty state (shown when there are no auto-fix recommendations).
 * A GREEN "structure is clean" all-clear is ONLY honest when the report is TRULY
 * clean — `overall === 100`, i.e. zero graded deductions. Many graded detectors are
 * intentionally NOT turned into recommendations (invalid model/color, disallowedTools
 * typo, MCP-config failure, skill-resource ref, a hard lethal-trifecta), so
 * "no recommendations" does NOT mean "clean": those findings lower the score and show
 * in the rings/verdict (and, for safety, the review cards below). In that case show
 * NEUTRAL "no auto-fix" wording instead of a green all-clear.
 */
function FixesEmptyState({ clean }: { clean: boolean }) {
  return clean ? (
    <p className={cn("flex items-center gap-2 text-base", TEXT.good)}>
      <CheckCircle2 size={18} aria-hidden /> No deterministic fixes — the
      structure is clean.
    </p>
  ) : (
    <p className="text-base text-muted-foreground">
      No deterministic auto-fixes — review the flagged findings above.
    </p>
  );
}

/** Impact band for a fix: bigger score gain ⇒ hotter. Never green (green =
 * passing only), so a fix card never masquerades as a clean signal. */
function impactBand(points: number): Tone {
  if (points >= 8) return "bad";
  if (points >= 3) return "warn";
  return "na";
}

/** Copy a paste-ready agent prompt that applies this fix in the real repo. */
function CopyFix({ r }: { r: Recommendation }) {
  const [copied, setCopied] = useState(false);
  const prompt = `In this repo, ${r.fix}. Context: ${r.rationale} (detector: ${r.detector}).`;
  const copy = (): void => {
    void navigator.clipboard?.writeText(prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={prompt}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:border-foreground"
    >
      {copied ? (
        <Check size={14} className={TEXT.good} aria-hidden />
      ) : (
        <Copy size={14} className="text-muted-foreground" aria-hidden />
      )}
      <span className={cn(copied && TEXT.good)}>
        {copied ? "copied!" : "copy agent prompt"}
      </span>
    </button>
  );
}

/** The fix line + its copy button + the detector's explainer link. */
function FixActions({ r }: { r: Recommendation }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <CopyFix r={r} />
      <CheckLink
        slug={r.detector}
        className="font-mono text-sm text-muted-foreground hover:text-foreground"
      >
        {r.detector}
      </CheckLink>
    </div>
  );
}

/** One ranked fix in the summary (site demo) list. `points` is the real re-score
 * gain (`+N pts`), coloured by impact. A plain bordered box, no side stripe. */
function FixCard({ r, points }: { r: Recommendation; points: number }) {
  const Icon = r.action === "fix" ? Wrench : GitCompareArrows;
  const accent = impactBand(points);
  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>
          <Icon size={12} className="mr-1" />
          {r.action}
        </Badge>
        <strong>{r.surface}</strong>
        {points > 0 && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-semibold",
              TEXT[accent],
            )}
          >
            +{points} pts
          </span>
        )}
        <CheckLink
          slug={r.detector}
          className="ml-auto hidden font-mono text-xs text-muted-foreground hover:text-foreground sm:inline"
        >
          {r.detector}
        </CheckLink>
      </div>
      <div className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        {r.rationale}
      </div>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2">
        <span className={cn("text-sm leading-relaxed", TEXT.good)}>
          → {r.fix}
        </span>
        <CopyFix r={r} />
      </div>
    </div>
  );
}

/** One numbered item of the standalone report's "Do these first" list. The
 * numeral and the key line take the item's band; the body is ink. */
function TodoItem({
  n,
  tone,
  keyLine,
  children,
}: {
  n: number;
  tone: Tone;
  keyLine: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[2.75rem_1fr] gap-x-3.5 border-t border-border py-7 first:border-t-0 first:pt-1 sm:grid-cols-[5rem_1fr]">
      <span
        aria-hidden
        className={cn(
          "font-display text-[56px] font-semibold leading-[0.85] tabular-nums sm:text-7xl",
          TEXT[tone],
        )}
      >
        {n}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "mb-1.5 flex flex-wrap gap-x-3 font-display text-[15px] font-semibold",
            TEXT[tone],
          )}
        >
          {keyLine}
        </p>
        {children}
      </div>
    </li>
  );
}

/**
 * "Do these first": the ranked fixes (biggest score gain first), then the Safety
 * findings that have no auto-fix — a lethal-trifecta exfil path is a design
 * call, not a typo, so it is never ranked as a +N-pts fix. Safety items take the
 * Safety category's own band, so the list and the ring agree.
 */
function TodoList({
  fixes,
  reviews,
  safetyTone,
}: {
  fixes: readonly { r: Recommendation; points: number }[];
  reviews: readonly string[];
  safetyTone: Tone;
}) {
  return (
    <ol>
      {fixes.map(({ r, points }, i) => (
        <TodoItem
          key={`fix-${i}`}
          n={i + 1}
          tone={impactBand(points)}
          keyLine={
            <>
              <span>
                {r.action} · {r.surface}
              </span>
              {points > 0 && <span>+{points} pts</span>}
            </>
          }
        >
          <p className="max-w-[64ch] text-[17px] leading-relaxed [text-wrap:pretty]">
            {r.rationale}
          </p>
          <p className="mt-2 max-w-[64ch] text-base leading-relaxed text-foreground-soft">
            → {r.fix}
          </p>
          <FixActions r={r} />
        </TodoItem>
      ))}
      {reviews.map((f, i) => (
        <TodoItem
          key={`review-${i}`}
          n={fixes.length + i + 1}
          tone={safetyTone}
          keyLine={<span>Safety</span>}
        >
          <p className="max-w-[64ch] text-[17px] leading-relaxed [text-wrap:pretty]">
            {f}
          </p>
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[15px] text-muted-foreground">
            <span>Your call — no deterministic fix</span>
            <CheckLink
              slug="lethal-trifecta"
              className="text-foreground decoration-solid"
            >
              What&apos;s this?
            </CheckLink>
          </p>
        </TodoItem>
      ))}
    </ol>
  );
}

/** An ungraded rule group: every rule of it the run turned on and what it
 * found, in a block of its own — muted, and headed by the group's own label
 * ("not graded"), so a reader does not hunt the rings for points these findings
 * cost: they cost none. */
function UngradedBlock({ group }: { group: UngradedGroup }) {
  return (
    <section className="mt-8" aria-label={group.label}>
      <p className="font-display text-[15px] font-semibold text-muted-foreground">
        {group.label}
      </p>
      {group.blurb && (
        <p className="mt-1 text-sm leading-snug text-muted-foreground">
          {group.blurb}
        </p>
      )}
      <ul className="mt-2 space-y-1.5">
        {group.rules.map((res) => (
          <li key={res.rule} className="text-sm leading-snug text-na-ink">
            <span className="break-all font-mono">{res.rule}</span>
            {res.findings.length === 0 ? (
              <span className="text-muted-foreground"> — nothing found</span>
            ) : (
              <ul className="mt-1 space-y-1 pl-3">
                {res.findings.map((f) => (
                  <li key={`${f.path}:${f.line ?? 0}:${f.message}`}>
                    {f.kind === "note" ? (
                      <Info
                        size={13}
                        className="mr-1 inline align-[-2px]"
                        aria-hidden
                      />
                    ) : (
                      <span aria-hidden className="mr-1">
                        ✗
                      </span>
                    )}
                    <span className="break-all font-mono">{f.subject}</span>{" "}
                    <span className="text-muted-foreground">
                      ({f.path}) — {f.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A category row (summary variant) — label, score, a thin band bar, AND the actual
 * finding text REVEALED beneath it (not a bare "· N" count that tells the reader
 * nothing). This is the fix for "92 but no errors visible": every category that
 * isn't a clean 100 shows WHY, in context, linked to its explainer. Graded findings
 * lead (they cost points); advisory ones follow, muted; the extras fold. */
function CategoryRow({
  c,
  refs,
}: {
  c: CategoryScore;
  refs?: readonly string[];
}) {
  const b: Tone = c.advisory ? "na" : band(c.score);
  const pct = c.score === null ? 0 : Math.max(0, Math.min(100, c.score));
  // A finding is advisory if the whole category is (untested surfaces) or the
  // scorer tagged that single string "(advisory)" (an inherits-all note in an
  // otherwise-100 category). Graded findings — the ones that moved the score — lead.
  const [lead, ...rest] = orderedFindings(c);
  const hardSafety = c.key === "Safety" && lead && !lead.advisory;
  // Advisory categories DO have a real score (e.g. Tested 94) — it just doesn't
  // move the grade. Show that number (muted, `na` tone) so the number and the bar
  // AGREE; the "advisory, not graded" tag in the finding line says it doesn't count.
  // (A "—" beside a 94%-filled bar reads as a rendering bug.)
  // `categoryScoreLabel` keeps THREE states apart: a number, `n/a` (nothing to
  // assess), and `not measured` (nobody asked). A 0 and an unasked question are
  // different facts and must not render the same string.
  const scoreLabel = categoryScoreLabel(c);
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{c.key}</span>
        <span className={cn("font-mono text-sm font-bold", TEXT[b])}>
          {scoreLabel}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full", BG[b])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-[13px] leading-snug text-muted-foreground">
        {!lead ? (
          <span className={cn("inline-flex items-center gap-1", TEXT.good)}>
            <CheckCircle2 size={12} aria-hidden /> clean
          </span>
        ) : (
          <>
            {hardSafety && (
              <ShieldAlert
                size={12}
                className={cn("mr-1 inline align-[-2px]", TEXT.bad)}
                aria-hidden
              />
            )}
            <FindingText text={lead.text} advisory={lead.advisory} />
            {/* The CONCRETE paths behind a "N broken reference(s)" count — so the
                report shows WHAT is broken, not just how many. */}
            {refs && refs.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {refs.map((r) => (
                  <li key={r} className="font-mono text-[11px] text-na-ink">
                    ↳ {r}{" "}
                    <span className="text-muted-foreground">— missing</span>
                  </li>
                ))}
              </ul>
            )}
            {rest.length > 0 && (
              <details className="group mt-1">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground/80 hover:text-foreground">
                  <ChevronRight
                    size={11}
                    className="transition-transform group-open:rotate-90"
                  />
                  + {rest.length} more
                </summary>
                <ul className="mt-1 space-y-1 border-l border-border/50 pl-3">
                  {rest.map((f, i) => (
                    <li key={i}>
                      <FindingText text={f.text} advisory={f.advisory} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The model-gated row — FOLDED IN as the sixth line under the deterministic five,
 * not a bolt-on card. The five categories are things a browser can measure; this is
 * the one thing it can't (does a skill actually FIRE?), so it sits in the same strip,
 * veiled, with an EXPLICIT "Copy prompt →" button that says exactly what it copies
 * and where to paste it. The recall/precision numbers are honest em-dash
 * placeholders (not a blur that reads as a render failure) — you fill them by
 * running it locally.
 *
 * A blurred pair of invented digits sat here instead until 2026-09-07, arguing in
 * its own comment that blur + a "preview" tag made them illustrative rather than
 * claimed. It did not: the view is SHARED with the CLI's HTML report, so a number
 * nobody measured was one variant away from a file a user shares as their own
 * result — and on the marketing page it rendered above that page's own copy
 * mocking "an unverified number in a README". If a stronger tease is ever wanted,
 * use a REAL measured number with its source, never a fabricated or blurred one. */
function LockedRow({ onUnlock }: { onUnlock?: () => void }) {
  const [copied, setCopied] = useState(false);
  const unlock = (): void => {
    onUnlock?.();
    void navigator.clipboard?.writeText(TRIGGER_RATE_PROMPT).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      },
      () => undefined,
    );
  };
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/20 p-4">
      {/* Stack on mobile (the button below the text) — side-by-side only at sm+,
          so a narrow screen never crushes the heading into a 1-word-per-line column. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Lock
              size={13}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            Do your skills actually fire?
          </div>
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
            Needs a real model, not a browser — recall (fires when it should) +
            precision (stays quiet otherwise).
          </p>
          {/* The two numbers this row exists to produce, shown EMPTY — an em-dash
              each, with "run to fill" beside them. There is nothing to blur and
              nothing to unlock: the shape of the answer is the whole tease, and the
              digits arrive only from a run on your own repo. A placeholder digit
              here would be a measurement nobody took, sitting one line under five
              categories that ARE measured, in a report about a repo the reader
              chose — and this row lives in the SHARED report view, one variant flip
              away from the HTML file the CLI writes and a user shares as their own
              result. Screen readers get the same sentence, not a different one. */}
          <div className="mt-2 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span aria-hidden>
              recall <span className="font-bold text-foreground">—</span> ·
              precision <span className="font-bold text-foreground">—</span>
            </span>
            <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase not-italic tracking-wide text-muted-foreground/80">
              run to fill
            </span>
            <span className="sr-only">
              Recall and precision are unmeasured here — run vigiles locally to
              measure your skills&apos; real numbers.
            </span>
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:shrink-0 sm:items-end">
          <button
            type="button"
            onClick={unlock}
            title={TRIGGER_RATE_PROMPT}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:border-foreground"
          >
            {copied ? (
              <>
                <Check
                  size={13}
                  aria-hidden
                  className={cn("shrink-0", TEXT.good)}
                />
                <span className={TEXT.good}>
                  Copied — paste into Claude Code
                </span>
              </>
            ) : (
              <>
                <Copy
                  size={13}
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
                Copy prompt →
              </>
            )}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Runs on your Claude subscription — no API key.
      </p>
    </div>
  );
}

/** The second "browser can't do this" row (beside LockedRow): the rule
 * cross-reference. The browser has no access to your linter config, so it can't
 * tell whether a rule your instructions name is actually enabled — that's a local
 * `vigiles audit`. Folded in here (a dashed teaser row) instead of a separate card
 * on the landing page, so the report itself carries the "run it locally for more". */
function CliRulesRow() {
  return (
    <div className="mt-2.5 rounded-xl border border-dashed border-border/70 bg-card/20 p-4">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Lock
          size={13}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        Your rules → enforced
        <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          CLI only
        </span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
        Locally, vigiles maps each prose rule to the linter rule that enforces
        it — and flags a rule you told the agent to follow that&apos;s silently
        off in your config.
      </p>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
        {`"always use ===" → eqeqeq is "off" in your ESLint config`}
      </pre>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground/70">
        Covers JS, Python, Rust, Ruby, JVM &amp; Go linters. On an unknown
        stack, references, structure &amp; safety are still verified.
      </p>
    </div>
  );
}

/** The summary (site demo) header: the grade + score as one badge, the
 * re-scored verdict sentence as the headline, the plugin name + harness. The
 * standalone report uses the gauge hero (components/Hero.tsx) instead. */
function VerdictHeader({
  verdict,
  overall,
  dir,
  harness,
  subline,
}: {
  verdict: Verdict;
  overall: number | null;
  dir: string;
  harness: string;
  /** Extra identity context (e.g. the merged "ships" counts) appended to the name
   *  line — context belongs with identity, not as its own section band. */
  subline?: ReactNode;
}) {
  const b = band(overall);
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
      <div
        className={cn(
          "flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-xl border-2 text-4xl",
          BORDER[b],
        )}
      >
        <span className={cn("font-black leading-none", TEXT[b])}>
          {verdict.grade}
        </span>
        <span className="mt-1 text-xs font-medium text-muted-foreground">
          {overall === null ? "—" : `${overall}/100`}
        </span>
      </div>
      <div className="min-w-0">
        <h1 className="text-lg font-bold leading-snug tracking-tight sm:text-xl">
          {verdictHeadline(verdict)}
        </h1>
        <div className="mt-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{basename(dir)}</span> ·{" "}
          {harness}
          {subline}
        </div>
      </div>
    </div>
  );
}

/** A "+ N more" fold for a list already showing its most important items. */
function MoreFold({ n, children }: { n: number; children: ReactNode }) {
  if (n <= 0) return null;
  return (
    <details className="group mt-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">
        <ChevronRight
          size={13}
          className="transition-transform group-open:rotate-90"
        />
        + {n} more
      </summary>
      <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>
    </details>
  );
}

const SECTION_H =
  "mb-4 mt-12 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70";

/** Styles to list; `"not-supported"` and an absent field both list none. */
function styleCount(n: AuditReport["inventory"]["outputStyles"]): number {
  return typeof n === "number" ? n : 0;
}

export function Report({
  data,
  showFooter = true,
  variant = "full",
  onUnlock,
}: {
  data: AuditReport;
  /** The "Generated by vigiles" footer. On by default (the standalone HTML report's
   *  only attribution); the in-page demo turns it off — the page already brands. */
  showFooter?: boolean;
  /** `"summary"` is the decluttered in-demo variant: compact header, borderless
   *  category strip (1-col mobile), top-3 fixes folded, the model-gated tease, and
   *  none of the standalone-only sections. `"full"` (default) is the standalone
   *  report: the gauge hero and full-width bands. */
  variant?: "full" | "summary";
  /** Summary only: click handler for the locked tease. Defaults to copying the
   *  canonical agent prompt; the demo overrides to add a toast. */
  onUnlock?: () => void;
}) {
  const {
    score,
    verdict,
    recommendations,
    inventory,
    meta,
    brokenReferences,
    ungraded,
  } = data;
  const overall = score.empty ? null : score.overall;

  useEffect(() => {
    // Only the STANDALONE report (the CLI's HTML file) owns the browser-tab title —
    // there, the grade-in-title is the whole point. The in-demo `summary` variant
    // must NOT hijack the site's own title: a fresh visitor sees a baked EXAMPLE
    // (e.g. madappgang B 82), and branding the tab with a stranger's grade reads as
    // "this is vigiles's own score". The demo sets its own title for real reports.
    if (variant !== "full") return;
    document.title =
      overall === null
        ? `vigiles — ${basename(meta.dir)}`
        : `vigiles — ${score.grade} (${overall}) · ${basename(meta.dir)}`;
  }, [variant, overall, score.grade, meta.dir]);

  // Points map, index-aligned to recommendations; rank fixes by real impact.
  const pointsFor = (i: number): number =>
    verdict.perRecommendation.find((p) => p.index === i)?.pointsIfFixed ?? 0;
  const rankedFixes = recommendations
    .map((r, i) => ({ r, points: pointsFor(i) }))
    .sort((a, b) => b.points - a.points);

  if (variant === "summary") {
    // NOTE: LockedRow is the SOLE clipboard copier (it writes TRIGGER_RATE_PROMPT).
    // Do NOT give onUnlock a default that also writes AUDIT_PROMPT — two independent
    // clipboard writes race, and if the audit write resolves last the locked
    // trigger-rate CTA pastes a prompt that won't measure recall/precision. onUnlock
    // is a pure side-channel hook (tracking); undefined = no-op.
    const count = (n: number, singular: string): string | 0 =>
      n && `${n} ${singular}${n === 1 ? "" : "s"}`;
    const ships = [
      count(inventory.skills, "skill"),
      count(inventory.agents, "agent"),
      count(inventory.hooks, "hook"),
      count(inventory.commands, "command"),
      count(styleCount(inventory.outputStyles), "output style"),
    ].filter(Boolean) as string[];
    const top = rankedFixes.slice(0, 3);
    const rest = rankedFixes.slice(3);
    return (
      <div>
        <VerdictHeader
          verdict={verdict}
          overall={overall}
          dir={meta.dir}
          harness={meta.harness}
          subline={
            <>
              {ships.map((s) => (
                <span key={s}> · {s}</span>
              ))}
              {inventory.untested > 0 && (
                <span className={TEXT.warn}>
                  {" "}
                  · {inventory.untested} untested
                </span>
              )}
            </>
          }
        />

        <h2 className={SECTION_H}>Categories — and what&apos;s flagged</h2>
        <div className="divide-y divide-border/40">
          {score.categories.map((c) => (
            <CategoryRow
              key={c.key}
              c={c}
              refs={c.key === "Truthfulness" ? brokenReferences : undefined}
            />
          ))}
        </div>
        {ungraded?.map((g) => (
          <UngradedBlock key={g.group} group={g} />
        ))}

        {/* The two things a browser can't do — folded into the SAME strip (dashed
            rows, captioned), not bolt-on cards floating below: the model-gated
            trigger-rate, and the linter cross-reference (needs your local config). */}
        <p className="mb-2.5 mt-6 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
          What the browser can&apos;t do here
        </p>
        <LockedRow onUnlock={onUnlock} />
        <CliRulesRow />

        {/* The fixes section shows ONLY when it has something to say: ranked fixes,
            or the green all-clear at a real 100. When there are graded findings but
            no auto-fix (they're already revealed in the categories above), an empty
            "review the findings above" section is dead weight — so it's omitted. */}
        {recommendations.length > 0 ? (
          <>
            <h2 className={SECTION_H}>Do these first</h2>
            <div className="flex flex-col gap-2.5">
              {top.map(({ r, points }, i) => (
                <FixCard key={i} r={r} points={points} />
              ))}
            </div>
            <MoreFold n={rest.length}>
              {rest.map(({ r, points }, i) => (
                <FixCard key={i} r={r} points={points} />
              ))}
            </MoreFold>
          </>
        ) : (
          score.overall === 100 && (
            <>
              <h2 className={SECTION_H}>Fixes</h2>
              <FixesEmptyState clean />
            </>
          )
        )}
      </div>
    );
  }

  return (
    <FullReport data={data} rankedFixes={rankedFixes} showFooter={showFooter} />
  );
}

type RankedFix = { r: Recommendation; points: number };

/** One section of the standalone report, rendered with its ground. */
type Section = { key: string; render: (alt: boolean) => ReactNode };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function categoriesSection(data: AuditReport, reviewed: ReadonlySet<string>) {
  const { score, brokenReferences, ungraded } = data;
  return (alt: boolean) => (
    <Band id="report-categories" title="Categories" alt={alt}>
      <CategoryRings categories={score.categories} />
      <FlaggedList
        categories={score.categories}
        brokenReferences={brokenReferences}
        exclude={reviewed}
      />
      {/* Apart from the rings: these findings are not in any category,
          because no category is graded on them. */}
      {ungraded?.map((g) => (
        <UngradedBlock key={g.group} group={g} />
      ))}
    </Band>
  );
}

function todoSection(
  data: AuditReport,
  fixes: readonly RankedFix[],
  reviews: readonly string[],
) {
  const safety = data.score.categories.find((c) => c.key === "Safety");
  const safetyTone = band(safety?.score ?? null);
  const empty = fixes.length === 0 && reviews.length === 0;
  const eyebrow = [
    fixes.length > 0 &&
      `${fixes.length} fix${fixes.length === 1 ? "" : "es"}, biggest gain first`,
    reviews.length > 0 && `${reviews.length} with no auto-fix`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (alt: boolean) => (
    <Band
      id="report-todo"
      title={empty ? "Fixes" : "Do these first"}
      eyebrow={eyebrow || undefined}
      alt={alt}
    >
      {empty ? (
        <FixesEmptyState clean={data.score.overall === 100} />
      ) : (
        <TodoList fixes={fixes} reviews={reviews} safetyTone={safetyTone} />
      )}
    </Band>
  );
}

function rulesSection(data: AuditReport): Section | null {
  const { rulesInventory, ruleRouting } = data;
  const routed =
    ruleRouting &&
    (ruleRouting.segmented > 0 ||
      (ruleRouting.possible?.length ?? 0) > 0 ||
      (ruleRouting.skipped?.length ?? 0) > 0);
  if ((rulesInventory?.length ?? 0) === 0 && !routed) return null;
  // EXPERIMENTAL + demoted below the deterministic sections. Detection is a
  // heuristic, precision-first filter (it misses some rules), so it sits low
  // and is badged experimental so a reader doesn't read it as a settled
  // finding like the reference/hook checks above.
  const none = (rulesInventory?.length ?? 0) === 0;
  return {
    key: "rules",
    render: (alt) => (
      <Band
        id="report-rules"
        alt={alt}
        title={
          <>
            Your rules → enforced
            <Badge className="border-warn text-warn-ink">experimental</Badge>
          </>
        }
      >
        <p className="mb-6 max-w-[64ch] text-base leading-relaxed text-foreground-soft">
          {none
            ? // No documented rule resolved to an off-the-shelf linter rule —
              // so don't imply enforcement (the honest non-JS / no-linter case).
              "No supported linter resolved here. Rule cross-referencing covers ESLint, Ruff, Pylint, Clippy & RuboCop — on other stacks your references, structure & safety are still verified; enforcing a documented rule just needs one of those linters."
            : "Prose rules in your instruction file that map to an off-the-shelf lint rule — and whether it's actually enforced. Detection is a heuristic, precision-first preview: it won't catch every rule."}
        </p>
        <RuleInventory data={rulesInventory ?? []} routing={ruleRouting} />
      </Band>
    ),
  };
}

/** The optional sections, in reading order; an absent one is skipped. */
function detailSections(data: AuditReport): Section[] {
  const { adoptability, contextCost, observations } = data;
  const out: (Section | null)[] = [
    adoptability
      ? {
          key: "refs",
          render: (alt) => (
            <Band id="report-refs" title="Broken references" alt={alt}>
              <p className="mb-6 max-w-[64ch] text-base leading-relaxed text-foreground-soft">
                Machine-verifiable references in your instruction file — files,
                scripts, symbols — checked against your actual repo and config.
                These don&apos;t resolve.
              </p>
              <Adoptability data={adoptability} />
            </Band>
          ),
        }
      : null,
    contextCost
      ? {
          key: "loaded",
          render: (alt) => (
            <Band id="report-loaded" title="Always-loaded context" alt={alt}>
              <AlwaysLoaded data={contextCost.alwaysLoaded} />
            </Band>
          ),
        }
      : null,
    observations && observations.total > 0
      ? {
          key: "ledger",
          render: (alt) => (
            <Band id="report-ledger" title="Flight recorder" alt={alt}>
              <p className="mb-6 max-w-[64ch] text-base leading-relaxed text-foreground-soft">
                What your harness actually did in real sessions — read off the
                local{" "}
                <code className="rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.9em]">
                  .vigiles/runs.jsonl
                </code>{" "}
                ledger.
              </p>
              <Observations data={observations} />
            </Band>
          ),
        }
      : null,
    rulesSection(data),
  ];
  return out.filter((x): x is Section => x !== null);
}

/** "What it ships" — context, not a finding, so it closes the report as one
 * line; the optional spec-adoption fold sits under it, collapsed. */
function ShipsSection({ data, alt }: { data: AuditReport; alt: boolean }) {
  const { inventory, adoptable } = data;
  const styles = styleCount(inventory.outputStyles);
  return (
    <section
      aria-label="What it ships"
      className={cn("px-5 py-10 sm:px-10", alt && "bg-band")}
    >
      <div className="mx-auto max-w-[66rem]">
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[15px] text-foreground-soft">
          <span className="font-display font-semibold text-foreground">
            Ships
          </span>
          <span>{inventory.skills} skills</span>
          <span>{inventory.agents} agents</span>
          <span>{inventory.hooks} hooks</span>
          <span>{inventory.commands} commands</span>
          {styles > 0 && <span>{styles} output styles</span>}
          <span>MCP {inventory.mcp ? "yes" : "no"}</span>
          {inventory.untested > 0 && (
            <span className={TEXT.warn}>{inventory.untested} untested</span>
          )}
        </p>
        {/* Optional, folded, last on purpose: spec-adoption is a hardening
            upsell, not a failure — surfacing "N surfaces not yet managed" high
            up reads as a nag to a first-time reader. Collapsed by default. */}
        {adoptable && adoptable.surfaces.length > 0 && (
          <details className="group mt-6">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 font-display text-[15px] font-semibold text-foreground-soft hover:text-foreground">
              <ChevronRight
                size={16}
                aria-hidden
                className="transition-transform group-open:rotate-90"
              />
              Optional — turn {plural(adoptable.surfaces.length, "surface")}{" "}
              into typed specs
            </summary>
            <p className="mb-4 mt-3 max-w-[64ch] text-base text-foreground-soft">
              Hardening, not a fix: make vigiles verify these surfaces&apos;
              references — fully, or one at a time. Skip it until you want CI to
              gate them.
            </p>
            <Adopt data={adoptable} />
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The standalone report (the CLI's HTML file): a gauge hero, then full-width
 * bands that alternate ground — categories, what to do first, and the detail
 * sections the data carries. No cards: a band is the only container.
 */
function FullReport({
  data,
  rankedFixes,
  showFooter,
}: {
  data: AuditReport;
  rankedFixes: readonly RankedFix[];
  showFooter: boolean;
}) {
  const { score, verdict, meta } = data;
  const reviews = safetyReviewFindings(score.categories);
  const reviewed: ReadonlySet<string> = new Set(reviews);
  const sections: Section[] = [
    { key: "categories", render: categoriesSection(data, reviewed) },
    { key: "todo", render: todoSection(data, rankedFixes, reviews) },
    ...detailSections(data),
  ];
  return (
    <>
      <main>
        <Hero
          verdict={verdict}
          overall={score.empty ? null : score.overall}
          name={basename(meta.dir)}
          harness={meta.harness}
        />
        {sections.map((sec, i) => (
          <Fragment key={sec.key}>{sec.render(i % 2 === 1)}</Fragment>
        ))}
        <ShipsSection data={data} alt={sections.length % 2 === 1} />
      </main>
      {showFooter && (
        <footer className="px-5 pb-10 pt-6 text-center text-sm text-muted-foreground">
          Generated by vigiles — we run your harness, not just read it.
        </footer>
      )}
    </>
  );
}
