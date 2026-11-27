import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy, RotateCw, Link2, Star, Lock } from "lucide-react";
import { Report, type AuditReport } from "@vigiles/report-view";
import { normalizeSlug } from "@/lib/deeplink";
import { fetchStars, formatStars } from "@/demo/searchRepos";
import { RepoCombobox } from "./RepoCombobox";
import { track } from "@/lib/track";
import {
  fetchRepo,
  type FetchProgress,
  type FetchOutcome,
} from "@/demo/fetchRepo";
import { runAudit } from "@/demo/runAudit";
import { readGrade, writeGrade, sweepGrades } from "@/demo/gradeCache";
import { cn } from "@/lib/utils";

// Real audit reports, computed by the actual `vigiles audit` on real published
// plugins and baked at build time — the INSTANT one-tap examples. They render
// through the SAME @vigiles/report-view component a live typed run does, so a
// featured report and a repo you type are indistinguishable in authority.
import davila7 from "@/demo/reports/davila7-templates.json";
import disler from "@/demo/reports/disler-hooks-mastery.json";
import madappgang from "@/demo/reports/madappgang-frontend.json";
import superpowers from "@/demo/reports/superpowers.json";

type Featured = {
  slug: string;
  label: string;
  report: AuditReport;
  /** The real fetchable `owner/repo` for the LIVE star count, when it differs from
   *  the display slug (a plugin nested in a repo, or a bare-name display). Omitted
   *  when the slug already IS the repo (superpowers, wshobson/agents). */
  repo?: string;
};

// A real low-to-high scale on repos people recognize (C → B → B → A as graded
// on 2026-11-27) — so the default shows vigiles CATCHING something (not a wall
// of A's that reads as "everything's fine"), and the A at the end proves the
// grade is earnable. davila7 (C) leads: a functional dir sits inside
// .claude-plugin/ where the harness can't load it, and three subagents have
// frontmatter that is not valid YAML, so their `tools:` is unread and every tool
// is inherited — "valid files, silently broken". The grades are whatever today's
// `vigiles audit --json` prints; never hand-edit a baked report.
const FEATURED: Featured[] = [
  {
    slug: "davila7/claude-code-templates",
    label: "davila7/claude-code-templates",
    report: davila7 as unknown as AuditReport,
  },
  {
    slug: "disler/claude-code-hooks-mastery",
    label: "disler/claude-code-hooks-mastery",
    report: disler as unknown as AuditReport,
  },
  {
    slug: "madappgang/frontend",
    label: "madappgang/frontend",
    report: madappgang as unknown as AuditReport,
    repo: "MadAppGang/claude-code",
  },
  {
    slug: "obra/superpowers",
    label: "obra/superpowers",
    report: superpowers as unknown as AuditReport,
  },
];

/** The `owner/repo` to fetch a featured chip's star count from. */
function starRepo(f: Featured): string {
  return f.repo ?? f.slug;
}

// Live star counts, fetched once per session and shared across remounts — the chip
// is a mini-leaderboard, so real popularity sits beside the real grade. Module-level
// so navigating away and back doesn't re-spend the anonymous API budget.
const starMemo = new Map<string, number>();

const AUDIT_CMD = "npx vigiles audit";

/** Progressive, honest loading detail — every field is set by a resolved promise. */
type LoadingState = {
  treeCount: number | null;
  files: { done: number; of: number } | null;
};

/** The one thing on screen. A discriminated union — the frame renders off `k`. */
type View =
  | { k: "featured"; i: number }
  | { k: "loading"; slug: string; detail: LoadingState }
  // `cachedAt` (present iff served from a cache) drives the "graded N ago · re-grade"
  // provenance strip — only the two persistable kinds carry it (see gradeCache).
  | { k: "report"; slug: string; audit: AuditReport; cachedAt?: number }
  | { k: "empty"; slug: string; cachedAt?: number }
  | { k: "marketplace"; slug: string }
  | { k: "notfound"; slug: string }
  | { k: "ratelimit"; slug: string }
  | { k: "too-large"; slug: string }
  | { k: "error"; slug: string };

/** A terminal (cacheable) view — everything a completed run can settle to. */
type TerminalView = Exclude<View, { k: "featured" } | { k: "loading" }>;

/** The `owner/repo` shown in the frame header for any view. */
function headerSlug(view: View): string {
  return view.k === "featured" ? FEATURED[view.i].slug : view.slug;
}

/** Grade → band color token (matches the report's bands: A passing, B–D warn, F bad). */
function gradeTone(grade: string): string {
  if (grade === "A") return "text-good";
  if (grade === "F") return "text-bad";
  return "text-warn";
}

// ---------------------------------------------------------------------------

/** The report a settled frame shows: the typed run's audit, or a baked chip's. */
function frameReport(view: View): AuditReport {
  return view.k === "report"
    ? view.audit
    : FEATURED[(view as { i: number }).i].report;
}

/** Every finding line the rings counted — the "Show everything" count. */
function findingCount(report: AuditReport): number {
  return report.score.categories.reduce((n, c) => n + c.findings.length, 0);
}

/** A quiet inline copy affordance for `npx vigiles audit` (edge-state frames). */
function InlineCommand() {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(AUDIT_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 align-middle font-mono text-xs text-foreground transition-colors hover:border-accent/50"
    >
      <span className="select-none text-muted-foreground">$</span>
      {AUDIT_CMD}
      {copied ? (
        <Check className="h-3.5 w-3.5 text-good" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

/** The honest step log — three lines, each backed by a real awaited request. */
function StepLog({ detail }: { detail: LoadingState }) {
  const { treeCount, files } = detail;
  const filesDone = files !== null && files.done >= files.of;
  return (
    <div className="p-6 font-mono text-sm leading-relaxed sm:p-8">
      <div className="text-good">
        {treeCount === null ? (
          <span className="text-muted-foreground">→ fetching repo tree…</span>
        ) : (
          `✓ repo tree — ${treeCount} files`
        )}
      </div>
      {files !== null && (
        <>
          <div className={filesDone ? "text-good" : "text-muted-foreground"}>
            {filesDone
              ? `✓ read ${files.of} harness file${files.of === 1 ? "" : "s"}`
              : `→ reading harness files (${files.done} of ${files.of})…`}
          </div>
          {files.of > 0 && (
            <div
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuenow={files.done}
              aria-valuemin={0}
              aria-valuemax={files.of}
            >
              <div
                className="h-full rounded-full bg-good transition-[width] duration-300 ease-out"
                style={{
                  width: `${Math.round((files.done / files.of) * 100)}%`,
                }}
              />
            </div>
          )}
        </>
      )}
      {filesDone && (
        <div className="text-muted-foreground">
          → running deterministic checks…
        </div>
      )}
    </div>
  );
}

/** One in-frame edge state — same frame + header, terminal-toned body, own CTA. */
function EdgeState({ view }: { view: TerminalView }) {
  const slug = <span className="font-mono text-foreground">{view.slug}</span>;
  let body: ReactNode = null;
  if (view.k === "empty") {
    body = (
      <>
        <p>
          <strong className="text-foreground">
            No Claude Code harness in {slug}.
          </strong>{" "}
          No CLAUDE.md or .claude/ — nothing for the browser demo to grade.
        </p>
        <p className="mt-3">
          The browser demo grades Claude Code. For Codex (AGENTS.md / .codex),
          or any harness that lives in a repo, grade it where it lives:{" "}
          <InlineCommand />
        </p>
        <p className="mt-3">
          Or tap a graded example above — like{" "}
          <span className="font-mono text-foreground">obra/superpowers</span> or{" "}
          <span className="font-mono text-foreground">oh-my-claudecode</span>.
        </p>
      </>
    );
  } else if (view.k === "marketplace") {
    body = (
      <>
        <p>
          <strong className="text-foreground">
            {slug} is a plugin marketplace
          </strong>{" "}
          — a collection of plugins, not a single harness. The browser demo
          grades one plugin at a time.
        </p>
        <p className="mt-3">
          The CLI expands a marketplace and ranks every member into a
          leaderboard: <InlineCommand />
        </p>
        <p className="mt-3">
          Or tap a graded example above — like{" "}
          <span className="font-mono text-foreground">obra/superpowers</span> or{" "}
          <span className="font-mono text-foreground">oh-my-claudecode</span>.
        </p>
      </>
    );
  } else if (view.k === "notfound") {
    body = (
      <p>
        <strong className="text-foreground">Couldn&apos;t read {slug}</strong> —
        not found, or private. The browser demo can only fetch public repos. The
        CLI has no such limit — it reads your working copy, and nothing leaves
        your machine: <InlineCommand />
      </p>
    );
  } else if (view.k === "ratelimit") {
    body = (
      <p>
        <strong className="text-foreground">
          GitHub&apos;s anonymous API limit hit
        </strong>{" "}
        (60 requests/hour per IP — not vigiles&apos;s limit). The featured
        reports above still work. Or skip the API entirely — the CLI reads your
        disk: <InlineCommand />
      </p>
    );
  } else if (view.k === "too-large") {
    body = (
      <p>
        <strong className="text-foreground">{slug} is too large</strong> for the
        browser demo to read fully — GitHub truncates the file tree for very big
        repos, so a grade here could miss files. The CLI reads your working copy
        directly, with no such limit: <InlineCommand />
      </p>
    );
  } else {
    body = (
      <p>
        <strong className="text-foreground">Couldn&apos;t reach GitHub</strong>{" "}
        for {slug}. Check your connection and try again — or run it locally,
        where nothing leaves your machine: <InlineCommand />
      </p>
    );
  }
  return (
    <div className="p-6 text-sm leading-relaxed text-muted-foreground sm:p-8">
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * `variant`:
 *  - "section" (default) — the standalone lower-page section, with its own heading +
 *    top border + card bg.
 *  - "hero" — dropped into the hero as the product shot: no heading (the hero tagline
 *    covers it) and no section chrome, just the live combobox + report. First paint is
 *    still instant because the default view is a baked featured grade (no network).
 */
export function DemoAudit({
  variant = "section",
}: {
  variant?: "section" | "hero";
} = {}) {
  const [view, setView] = useState<View>({ k: "featured", i: 0 });
  const [loadingVisible, setLoadingVisible] = useState(false);
  // Live star counts per featured slug (from the module memo, filled on mount).
  const [stars, setStars] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      FEATURED.filter((f) => starMemo.has(starRepo(f))).map((f) => [
        f.slug,
        starMemo.get(starRepo(f)) as number,
      ]),
    ),
  );

  // L1 — session cache: a repo audited once re-shows instantly (no re-fetch). Holds
  // all stable outcomes; `gradedAt` lets even a memory hit show honest age. The
  // persistent L2 (gradeCache, idb-keyval) sits under it for cross-reload/deep-link.
  const cache = useRef(
    new Map<string, { view: TerminalView; gradedAt: number }>(),
  );
  // Ignore stale async: only the latest run may commit.
  const runId = useRef(0);
  // The last frame with real content — kept on screen during the <200ms
  // loading-suppression window so a fast run never flashes a skeleton.
  const prevFrame = useRef<View>({ k: "featured", i: 0 });
  const abort = useRef<AbortController | null>(null);
  const suppressTimer = useRef<number | null>(null);

  const run = useCallback((slug: string, opts?: { force?: boolean }): void => {
    // Analytics carries the OUTCOME kind only — never the typed slug: the demo
    // promises nothing leaves the browser but GitHub requests, and a typed slug
    // would leak a private/sensitive repo name (which resolves to 404) to Plausible.
    track(opts?.force ? "demo_regrade" : "demo_typed_submit");
    const id = ++runId.current;
    abort.current?.abort();

    const showCached = (
      view: TerminalView,
      gradedAt: number,
      via: "memory" | "persistent",
    ): void => {
      const v = withCachedAt(view, gradedAt);
      prevFrame.current = v;
      setView(v);
      syncUrl(v);
      track(`demo_run_${runKind(view)}`, { cached: via });
    };

    // L1 (memory) — sync, instant. `force` skips both cache layers.
    if (!opts?.force) {
      const hit = cache.current.get(slug);
      if (hit) {
        showCached(hit.view, hit.gradedAt, "memory");
        return;
      }
    }

    const controller = new AbortController();
    abort.current = controller;
    setView({ k: "loading", slug, detail: { treeCount: null, files: null } });
    // Suppress the step log for ~200ms so a tiny/cached repo goes straight to
    // the report with no skeleton flash (an L2 read resolves well inside it).
    setLoadingVisible(false);
    if (suppressTimer.current) window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      if (runId.current === id) setLoadingVisible(true);
    }, 200);

    const onProgress = (p: FetchProgress): void => {
      if (runId.current !== id) return;
      setView((v) =>
        v.k === "loading"
          ? {
              ...v,
              detail:
                p.phase === "tree"
                  ? {
                      treeCount: p.treeCount,
                      files: { done: 0, of: p.harnessCount },
                    }
                  : { ...v.detail, files: { done: p.done, of: p.of } },
            }
          : v,
      );
    };

    const fetchAndGrade = (): void => {
      void fetchRepo(slug, onProgress, controller.signal).then((outcome) => {
        if (runId.current !== id) return;
        const settled = settleOutcome(outcome, slug);
        const gradedAt = Date.now();
        // Cache only STABLE outcomes in L1 — a transient error/rate-limit must be
        // able to retry on the next submit, so the frame's "try again" works.
        if (isCacheable(settled))
          cache.current.set(slug, { view: settled, gradedAt });
        // Persist only the expensive, shareable, stable report/empty to L2 — never
        // notfound (a private repo name on disk) or a flippable/transient state.
        if (settled.k === "report") {
          void writeGrade({ k: "report", slug, audit: settled.audit });
        } else if (settled.k === "empty") {
          void writeGrade({ k: "empty", slug });
        }
        prevFrame.current = settled;
        setView(settled);
        syncUrl(settled);
        track(`demo_run_${runKind(settled)}`);
      });
    };

    // L2 (persistent) — async, checked BEFORE the network. A hit renders with zero
    // GitHub requests. `force` bypasses it.
    if (opts?.force) {
      fetchAndGrade();
      return;
    }
    void readGrade(slug).then((hit) => {
      if (runId.current !== id) return; // a chip / newer submit superseded us
      if (hit) {
        cache.current.set(slug, { view: hit.view, gradedAt: hit.gradedAt }); // promote to L1
        if (suppressTimer.current) window.clearTimeout(suppressTimer.current);
        showCached(hit.view, hit.gradedAt, "persistent");
        return;
      }
      fetchAndGrade();
    });
  }, []);

  // Deep-link: on load with ?repo=owner/repo, auto-run it (L1→L2→network). Also
  // sweep expired / old-namespace persistent entries once per mount.
  useEffect(() => {
    void sweepGrades();
    const param = new URLSearchParams(window.location.search).get("repo");
    const slug = param ? normalizeSlug(param) : null;
    if (slug) run(slug);
    // run is stable (useCallback []) — mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live star counts for the featured chips — one cheap request per chip, once per
  // session (module memo), degraded-safe (a failure just leaves the chip star-less).
  useEffect(() => {
    const ac = new AbortController();
    for (const f of FEATURED) {
      const repo = starRepo(f);
      if (starMemo.has(repo)) continue;
      void fetchStars(repo, ac.signal).then((n) => {
        if (n === null || ac.signal.aborted) return;
        starMemo.set(repo, n);
        setStars((prev) => ({ ...prev, [f.slug]: n }));
      });
    }
    return () => ac.abort();
  }, []);

  const pickChip = (i: number): void => {
    // Instant baked report — no loading, leaves input text in place.
    ++runId.current;
    abort.current?.abort();
    setLoadingVisible(false);
    const v: View = { k: "featured", i };
    setView(v);
    prevFrame.current = v;
    track("demo_chip", { slug: FEATURED[i].slug });
  };

  // What to render in the frame: during the suppression window keep the prior
  // frame; otherwise render the current view.
  const frameView: View =
    view.k === "loading" && !loadingVisible ? prevFrame.current : view;
  const isEdge =
    frameView.k === "empty" ||
    frameView.k === "marketplace" ||
    frameView.k === "notfound" ||
    frameView.k === "ratelimit" ||
    frameView.k === "too-large" ||
    frameView.k === "error";
  // Share only a REAL fetched report — never a baked featured chip. A share link
  // can only carry a `?repo=` slug that RE-FETCHES on open, so it can't reproduce a
  // baked example (and some featured slugs aren't a fetchable owner/repo, e.g.
  // `oh-my-claudecode`, or are too large to grade in-browser). A typed/opened report
  // always came from a live fetch, so its share link reproduces faithfully.
  const canShare = frameView.k === "report";

  const inner = (
    <>
      {variant === "section" && (
        <h2 className="section-title text-center">
          Grade a public repo
          <br />
          in your browser.
        </h2>
      )}

      {/* ONE input line. The Public/Private tabs that sat here hid the private
          answer behind a click; the private answer is one sentence, so it is a
          line under the result now (see the end of this component). */}
      <RepoCombobox onSubmit={run} />

      {/* The featured repos as quiet text links with their real grade as a
          superscript: "here is how known setups score". Each keeps
          `aria-pressed` and an `aria-label="grade X"` on its letter, which the
          tests and screen readers read. */}
      <p className="mt-5 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>Or try</span>
        {FEATURED.map((f, i) => {
          const active = frameView.k === "featured" && frameView.i === i;
          const grade = f.report.score.grade;
          const starCount = stars[f.slug];
          return (
            <button
              key={f.slug}
              type="button"
              onClick={() => pickChip(i)}
              aria-pressed={active}
              className={cn(
                "font-mono underline-offset-4 transition-colors hover:text-foreground hover:underline",
                active && "text-foreground underline",
              )}
            >
              {f.label}
              {starCount !== undefined && (
                <span
                  className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground"
                  aria-label={`${String(starCount)} GitHub stars`}
                >
                  <Star className="h-3 w-3" aria-hidden />
                  {formatStars(starCount)}
                </span>
              )}
              <sup
                className={cn("ml-0.5 font-bold", gradeTone(grade))}
                aria-label={`grade ${grade}`}
              >
                {grade}
              </sup>
            </button>
          );
        })}
      </p>

      {/* The report frame — one component, every state renders inside it (no
            toast, no layout jump). */}
      <div className="reveal sheet mt-10 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 text-xs text-muted-foreground sm:px-10">
          {/* Identify the graded repo + its SOURCE (example chip vs your typed repo)
              — not the redundant `$ vigiles audit <slug>` command, which just repeats
              the highlighted chip / the input above. */}
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-foreground">
              {headerSlug(frameView)}
            </span>
            {frameView.k === "featured" ? (
              <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                example
              </span>
            ) : frameView.k === "report" ? (
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                your repo
              </span>
            ) : null}
          </span>
          {cachedAtOf(frameView) !== undefined && (
            <CachedBadge
              gradedAt={cachedAtOf(frameView) as number}
              onRegrade={() => run(headerSlug(frameView), { force: true })}
            />
          )}
        </div>
        {frameView.k === "loading" ? (
          <StepLog detail={frameView.detail} />
        ) : isEdge ? (
          <EdgeState view={frameView as TerminalView} />
        ) : (
          <div className="px-5 py-7 sm:px-10 sm:py-10">
            {/* The summary variant owns its own declutter (compact header,
                  borderless category strip, top-3 fixes, and the model-gated
                  locked tease that replaces the old AGradeNote + lock-row). */}
            <Report
              variant="summary"
              showFooter={false}
              data={frameReport(frameView)}
            />
            {/* Everything else the engine found, one tap away: the same
                AuditReport JSON in the full variant. */}
            <details className="group mt-8 border-t border-border pt-5">
              <summary className="cursor-pointer text-sm font-medium text-accent">
                Show everything
                <span className="text-muted-foreground">
                  {" "}
                  · {findingCount(frameReport(frameView))} findings ↓
                </span>
              </summary>
              <div className="mt-6">
                <Report
                  variant="full"
                  showFooter={false}
                  data={frameReport(frameView)}
                />
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Shareability is the growth loop — a graded result is a public link that
          auto-runs. Surface a one-tap share on any report/featured view. */}
      {canShare && <ShareRow slug={headerSlug(frameView)} />}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        <Lock className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        Private repo? Run{" "}
        <code className="font-mono text-foreground">
          npx vigiles audit
        </code>{" "}
        inside it. Nothing leaves your machine.
      </p>
    </>
  );

  // In the hero: no section chrome / heading — just the live demo as the product
  // shot, in a container the hero places on the fold.
  if (variant === "hero") {
    return (
      <div className="mx-auto w-full max-w-3xl scroll-mt-24 px-6" id="try">
        {inner}
      </div>
    );
  }

  return (
    <section id="try" className="band band-tint scroll-mt-20">
      <div className="mx-auto w-full max-w-3xl px-6">{inner}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------

/** A stable outcome worth caching — a transient failure must stay retryable. */
function isCacheable(v: TerminalView): boolean {
  return v.k !== "error" && v.k !== "ratelimit";
}

/** Map a fetch outcome to the terminal view it settles to (the live grade compute
 *  happens here for the ok case — the one real "running checks" step). */
function settleOutcome(outcome: FetchOutcome, slug: string): TerminalView {
  switch (outcome.kind) {
    case "ok":
      return { k: "report", slug, audit: runAudit(outcome.files, slug) };
    case "no-harness":
      return { k: "empty", slug };
    case "marketplace":
      return { k: "marketplace", slug };
    case "not-found":
      return { k: "notfound", slug };
    case "rate-limit":
      return { k: "ratelimit", slug };
    case "too-large":
      return { k: "too-large", slug };
    case "error":
      return { k: "error", slug };
  }
}

/** Stamp cache provenance on the two kinds that carry it; pass others through. */
function withCachedAt(v: TerminalView, gradedAt: number): TerminalView {
  return v.k === "report" || v.k === "empty" ? { ...v, cachedAt: gradedAt } : v;
}

/** The `cachedAt` on the frame's report/empty view, if any (drives the badge). */
function cachedAtOf(v: View): number | undefined {
  return v.k === "report" || v.k === "empty" ? v.cachedAt : undefined;
}

/** Coarse relative age — "just now" / "12 min ago" / "3 h ago" / "2 d ago". */
function relativeAge(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The header provenance strip on a cached hit — honest age + a one-click re-grade
 *  so a cached grade is never silently stale. */
function CachedBadge({
  gradedAt,
  onRegrade,
}: {
  gradedAt: number;
  onRegrade: () => void;
}) {
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <span className="hidden sm:inline">
        graded {relativeAge(gradedAt, Date.now())}
      </span>
      <span className="hidden sm:inline">·</span>
      <button
        type="button"
        onClick={onRegrade}
        className="inline-flex items-center gap-1 transition-colors hover:text-accent"
      >
        <RotateCw className="h-3 w-3" aria-hidden /> re-grade
      </button>
    </span>
  );
}

/** The viral loop — a graded result is a shareable PUBLIC link
 *  (vigiles.sh/?repo=owner/repo, which auto-runs on load). Make sharing a one-tap
 *  action: the native share sheet on mobile, copy-to-clipboard elsewhere. This is
 *  how a grade spreads — people share a repo's report, not a landing page. */
function ShareRow({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const share = (): void => {
    const url = `${window.location.origin}${window.location.pathname}?repo=${encodeURIComponent(
      slug,
    )}#try`;
    const done = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    const copy = (): void =>
      void navigator.clipboard?.writeText(url).then(done, () => undefined);
    const nav = navigator as Navigator & {
      share?: (d: { title?: string; url?: string }) => Promise<void>;
    };
    if (typeof nav.share === "function") {
      void nav.share({ title: `vigiles grade — ${slug}`, url }).then(
        () => undefined,
        copy, // share cancelled/failed → fall back to copy
      );
    } else {
      copy();
    }
  };
  return (
    <div className="mt-6 flex flex-col items-center gap-2.5 text-center">
      <p className="text-sm text-muted-foreground">
        Surprised by this grade?{" "}
        <span className="text-foreground">
          Send it to whoever owns the repo
        </span>{" "}
        — the link re-runs the audit live when they open it.
      </p>
      <button
        type="button"
        onClick={share}
        className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/5 px-5 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/70 hover:bg-accent/10"
      >
        {copied ? (
          <>
            <Check className="h-4 w-4 text-good" aria-hidden />
            <span className="text-good">Link copied — now share it</span>
          </>
        ) : (
          <>
            <Link2 className="h-4 w-4 text-accent" aria-hidden /> Share this
            grade
          </>
        )}
      </button>
    </div>
  );
}

/** The instrument suffix for a settled run. */
function runKind(
  v: TerminalView,
):
  | "ok"
  | "empty"
  | "marketplace"
  | "notfound"
  | "ratelimit"
  | "too-large"
  | "error" {
  switch (v.k) {
    case "report":
      return "ok";
    case "empty":
      return "empty";
    case "marketplace":
      return "marketplace";
    case "notfound":
      return "notfound";
    case "ratelimit":
      return "ratelimit";
    case "too-large":
      return "too-large";
    case "error":
      return "error";
  }
}

/** Reflect a successfully-read repo in the URL (?repo=) so the result is shareable. */
function syncUrl(v: TerminalView): void {
  if (v.k !== "report" && v.k !== "empty") return;
  const url = new URL(window.location.href);
  url.searchParams.set("repo", v.slug);
  window.history.replaceState(null, "", url.toString());
}
