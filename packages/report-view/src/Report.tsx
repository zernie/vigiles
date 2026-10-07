import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Wrench,
  GitCompareArrows,
  ChevronRight,
  Copy,
  Check,
  ShieldAlert,
  Lock,
} from "lucide-react";
import type {
  AuditReport,
  CategoryScore,
  Recommendation,
  Verdict,
} from "./schema";
import { categoryScoreLabel } from "./schema";
import { Card } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Adoptability } from "./components/Adoptability";
import { Adopt } from "./components/Adopt";
import { RuleInventory } from "./components/RuleInventory";
import { Observations } from "./components/Observations";
import { band, type Band, TEXT, BG, BORDER, BORDER_L } from "./lib/band";
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

/** A single revealed finding, rendered as plain prose. The scorer's stable
 *  "(advisory)" suffix is stripped for display and signalled separately. We do NOT
 *  try to reverse-map the prose back to an explainer slug — a finding carries no
 *  detector in the wire shape, and pattern-matching sentences to guess one is
 *  fragile; the explainer links live on the fix cards, which carry a real detector. */
function FindingText({ text, advisory }: { text: string; advisory: boolean }) {
  const clean = text.replace(/\s*\(advisory\)\s*$/, "");
  return (
    <span>
      <span>{clean}</span>
      {advisory && <span className="text-na"> · advisory, not graded</span>}
    </span>
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
    <Card className="flex items-center gap-2 p-4 text-sm text-good">
      <CheckCircle2 size={16} /> No deterministic fixes — the structure is
      clean.
    </Card>
  ) : (
    <Card className="p-4 text-sm text-muted-foreground">
      No deterministic auto-fixes — review the flagged findings above.
    </Card>
  );
}

/** Impact band for a fix: bigger score gain ⇒ hotter. Never green (green =
 * passing only), so a fix card never masquerades as a clean signal. */
function impactBand(points: number): Band {
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
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium hover:border-foreground"
    >
      {copied ? (
        <Check size={13} className={TEXT.good} />
      ) : (
        <Copy size={13} className="text-muted-foreground" />
      )}
      <span className={cn(copied && TEXT.good)}>
        {copied ? "copied!" : "copy agent prompt"}
      </span>
    </button>
  );
}

/** One ranked fix. `points` is the real re-score gain (`+N pts`); the left border
 * + the badge encode impact, not confidence, so the eye lands on the big wins. */
function FixCard({ r, points }: { r: Recommendation; points: number }) {
  const Icon = r.action === "fix" ? Wrench : GitCompareArrows;
  const accent = impactBand(points);
  return (
    <div
      className={cn(
        "rounded-xl border border-l-4 border-border/40 bg-card/30 p-5",
        BORDER_L[accent],
      )}
    >
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
        <span className="text-sm leading-relaxed text-good">→ {r.fix}</span>
        <CopyFix r={r} />
      </div>
    </div>
  );
}

/** A safety review item — no auto-fix (a lethal-trifecta exfil path is a design
 * call, not a typo), so it's shown as a review card, never a ranked +N-pts fix. */
function SafetyCard({ finding }: { finding: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-l-4 border-border/40 bg-card/30 p-5",
        BORDER_L.bad,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>
          <ShieldAlert size={12} className="mr-1" />
          safety
        </Badge>
        <span className="leading-relaxed text-muted-foreground">
          {finding}{" "}
          <CheckLink
            slug="lethal-trifecta"
            className="text-muted-foreground hover:text-foreground"
          >
            what&apos;s this?
          </CheckLink>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          your call — no deterministic fix
        </span>
      </div>
    </div>
  );
}

/** A compact category cell — a thin band bar + score, so the six read as one
 * scannable strip rather than six heavy rings competing with the verdict. */
function CategoryCell({ c }: { c: CategoryScore }) {
  const b: Band = c.advisory ? "na" : band(c.score);
  const pct = c.score === null ? 0 : Math.max(0, Math.min(100, c.score));
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold">{c.key}</span>
        {/* An UNASKED question gets its own label — never the advisory em-dash
            (which reads "measured, just not graded") and never a 0. */}
        <span
          className={cn(
            c.notMeasured ? "text-[11px] font-semibold" : "text-sm font-bold",
            TEXT[b],
          )}
        >
          {c.notMeasured
            ? "not measured"
            : c.advisory
              ? "—"
              : c.score === null
                ? "n/a"
                : c.score}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full", BG[b])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="h-8 overflow-hidden text-[11px] leading-tight text-muted-foreground">
        {c.notMeasured ? (
          <span className="line-clamp-2 text-na">
            {c.findings[c.findings.length - 1] ?? "never measured"}
          </span>
        ) : c.advisory ? (
          <span className="text-na">advisory — not graded</span>
        ) : c.findings.length > 0 ? (
          <span className="line-clamp-2">
            {c.findings[0]}
            {c.findings.length > 1 && (
              <span className="text-foreground">
                {" "}
                · +{c.findings.length - 1} more
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-good">
            <CheckCircle2 size={11} /> clean
          </span>
        )}
      </div>
    </Card>
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
  const b: Band = c.advisory ? "na" : band(c.score);
  const pct = c.score === null ? 0 : Math.max(0, Math.min(100, c.score));
  // A finding is advisory if the whole category is (untested surfaces) or the
  // scorer tagged that single string "(advisory)" (an inherits-all note in an
  // otherwise-100 category). Graded findings — the ones that moved the score — lead.
  const findings = c.findings.map((f) => ({
    text: f,
    advisory: Boolean(c.advisory) || f.endsWith("(advisory)"),
  }));
  const ordered = [
    ...findings.filter((f) => !f.advisory),
    ...findings.filter((f) => f.advisory),
  ];
  const [lead, ...rest] = ordered;
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
          <span className="inline-flex items-center gap-1 text-good">
            <CheckCircle2 size={12} /> clean
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
                  <li key={r} className="font-mono text-[11px] text-na">
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

/** The verdict-led hero: the grade + score as one badge, the re-scored verdict
 * sentence as the headline, the plugin name + harness, and the trust line. */
function VerdictHeader({
  verdict,
  overall,
  dir,
  harness,
  compact = false,
  subline,
}: {
  verdict: Verdict;
  overall: number | null;
  dir: string;
  harness: string;
  /** Summary variant: no Card border, smaller grade box, no separate trust line
   *  (the section subhead already says "deterministic, model-free"). */
  compact?: boolean;
  /** Extra identity context (e.g. the merged "ships" counts) appended to the name
   *  line — context belongs with identity, not as its own section band. */
  subline?: ReactNode;
}) {
  const b = band(overall);
  const box = compact
    ? "h-20 w-20 rounded-xl text-4xl"
    : "h-28 w-28 rounded-2xl text-5xl";
  const inner = (
    <>
      <div
        className={cn(
          "flex shrink-0 flex-col items-center justify-center border-2",
          box,
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
        <h1
          className={cn(
            "font-bold leading-snug tracking-tight",
            compact ? "text-lg sm:text-xl" : "text-xl sm:text-2xl",
          )}
        >
          {verdict.sentence}
        </h1>
        <div className="mt-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{basename(dir)}</span> ·{" "}
          {harness}
          {subline}
        </div>
        {!compact && (
          <div className="mt-1 text-xs text-muted-foreground">
            deterministic · no model · nothing leaves your machine
          </div>
        )}
      </div>
    </>
  );
  return compact ? (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
      {inner}
    </div>
  ) : (
    <Card className="flex flex-col gap-5 p-7 sm:flex-row sm:items-center">
      {inner}
    </Card>
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
   *  none of the standalone-only sections. `"full"` (default) is unchanged. */
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
    adoptability,
    adoptable,
    observations,
    rulesInventory,
    ruleRouting,
    brokenReferences,
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
          compact
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
    <div className="mx-auto max-w-5xl px-6 pb-16 pt-10">
      <VerdictHeader
        verdict={verdict}
        overall={overall}
        dir={meta.dir}
        harness={meta.harness}
      />

      <h2 className="mb-3 mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Categories
      </h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {score.categories.map((c) => (
          <CategoryCell key={c.key} c={c} />
        ))}
      </div>

      <h2 className="mb-3 mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {recommendations.length > 0 ? "Do these first" : "Fixes"}
      </h2>
      {rankedFixes.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {rankedFixes.map(({ r, points }, i) => (
            <FixCard key={i} r={r} points={points} />
          ))}
        </div>
      ) : (
        <FixesEmptyState clean={score.overall === 100} />
      )}

      {/* Safety findings have no auto-fix (the lethal-trifecta exfil path is a
          design call, not a typo) — so they never appear as a ranked +N-pts card.
          Surface them here as review items so the report's most severe finding
          isn't buried in 11px category-strip text. */}
      {(() => {
        const findings = safetyReviewFindings(score.categories);
        if (findings.length === 0) return null;
        return (
          <>
            <h2 className="mb-3 mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Review — no auto-fix
            </h2>
            <div className="flex flex-col gap-2.5">
              {findings.map((f, i) => (
                <SafetyCard key={i} finding={f} />
              ))}
            </div>
          </>
        );
      })()}

      {adoptability && (
        <>
          <h2 className="mb-3 mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Broken references
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Machine-verifiable references in your instruction file — files,
            scripts, symbols — checked against your actual repo and config.
            These don't resolve.
          </p>
          <Adoptability data={adoptability} />
        </>
      )}

      {observations && observations.total > 0 && (
        <>
          <h2 className="mb-3 mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Flight recorder
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            What your harness actually did in real sessions — read off the local
            <code className="mx-1 font-mono">.vigiles/runs.jsonl</code> ledger.
          </p>
          <Observations data={observations} />
        </>
      )}

      {/* The rule map — EXPERIMENTAL + demoted below the deterministic sections.
          Detection is a heuristic, precision-first filter (it misses some rules),
          so it sits low and is badged experimental so a reader doesn't read it as
          a settled finding like the reference/hook checks above. */}
      {((rulesInventory && rulesInventory.length > 0) ||
        (ruleRouting &&
          (ruleRouting.segmented > 0 ||
            (ruleRouting.possible?.length ?? 0) > 0 ||
            (ruleRouting.skipped?.length ?? 0) > 0))) && (
        <>
          <h2 className="mb-3 mt-9 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Your rules → enforced
            <Badge className="border-warn text-warn">experimental</Badge>
          </h2>
          {(rulesInventory?.length ?? 0) === 0 ? (
            // No documented rule resolved to an off-the-shelf linter rule — so
            // don't imply enforcement (the honest non-JS / no-linter case).
            // The routed rules below are still shown; references, structure &
            // safety are verified regardless of the linter.
            <p className="mb-3 text-xs text-muted-foreground">
              No supported linter resolved here. Rule cross-referencing covers
              ESLint, Ruff, Pylint, Clippy &amp; RuboCop — on other stacks your
              references, structure &amp; safety are still verified; enforcing a
              documented rule just needs one of those linters.
            </p>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground">
              Prose rules in your instruction file that map to an off-the-shelf
              lint rule — and whether it's actually enforced. Detection is a
              heuristic, precision-first preview: it won't catch every rule.
            </p>
          )}
          <RuleInventory data={rulesInventory ?? []} routing={ruleRouting} />
        </>
      )}

      {/* "What it ships" — demoted to a single meta line: it's context, not a
          finding, so it no longer competes with the verdict + fixes for the eye. */}
      <div className="mt-9 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-widest">Ships</span>
        <span>{inventory.skills} skills</span>
        <span>{inventory.agents} agents</span>
        <span>{inventory.hooks} hooks</span>
        <span>{inventory.commands} commands</span>
        {styleCount(inventory.outputStyles) > 0 && (
          <span>{styleCount(inventory.outputStyles)} output styles</span>
        )}
        <span>MCP {inventory.mcp ? "yes" : "no"}</span>
        {inventory.untested > 0 && (
          <span className={TEXT.warn}>{inventory.untested} untested</span>
        )}
      </div>

      {/* Optional, folded, last on purpose: spec-adoption is a hardening upsell,
          not a failure — surfacing "N surfaces not yet managed" high up reads as
          a nag to a first-time reader. Collapsed by default. */}
      {adoptable && adoptable.surfaces.length > 0 && (
        <details className="group mt-6">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">
            <ChevronRight
              size={13}
              className="transition-transform group-open:rotate-90"
            />
            Optional — turn {adoptable.surfaces.length} surface
            {adoptable.surfaces.length > 1 ? "s" : ""} into typed specs
          </summary>
          <p className="mb-3 mt-3 text-xs text-muted-foreground">
            Hardening, not a fix: make vigiles verify these surfaces' references
            — fully, or one at a time. Skip it until you want CI to gate them.
          </p>
          <Adopt data={adoptable} />
        </details>
      )}

      {showFooter && (
        <footer className="mt-12 text-center text-xs text-muted-foreground">
          Generated by vigiles — we run your harness, not just read it.
        </footer>
      )}
    </div>
  );
}
