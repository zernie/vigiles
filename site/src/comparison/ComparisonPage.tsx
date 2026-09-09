import { ArrowLeft } from "lucide-react";
import { checkSlugsWithPages } from "../checks/checks";
import { ROWS, type ComparisonRow } from "./rows";
import snapshot from "@measured/validate-overlap.json";

/**
 * The `/comparison` page — what breaks in an agent harness, and which tool notices.
 *
 * EVERY COMPETITOR CELL IS RENDERED FROM `validate-overlap.json`, the snapshot written
 * by `node tools/measure-validate-overlap.mjs --json`. Nothing here is typed by hand,
 * because a hand-typed cell is how this repository accumulated four false claims about
 * another tool before 2026-09-09. A row with no measured case renders "not probed" and
 * never an ✗: absence of a run is not a defect in somebody else's product.
 *
 * Static Vite MPA entry, like the check pages — real HTML, own <title>/OG/canonical,
 * no router, no SSR. Links are `../`-relative (one level deep) to hold under `base: "./"`.
 */

interface Case {
  id: string;
  rule: string;
  what: string;
  flagged: boolean;
  per: Record<string, string[]>;
}
const CASES = new Map(
  (snapshot.cases as Case[]).map((c) => [c.id, c] as const),
);

/** Which shapes flagged it — the plugin-vs-repo-local distinction is load-bearing. */
function verdict(kase: Case | undefined): {
  label: string;
  tone: "caught" | "missed" | "unprobed";
} {
  if (!kase) return { label: "not probed", tone: "unprobed" };
  const hits = Object.entries(kase.per).filter(([, f]) => f.length > 0);
  if (hits.length === 0) return { label: "passes it", tone: "missed" };
  const everywhere = hits.length === Object.keys(kase.per).length;
  return {
    label: everywhere ? "caught" : "caught, packaged plugins only",
    tone: "caught",
  };
}

function Row({ row }: { row: ComparisonRow }) {
  const kase = row.probeCase ? CASES.get(row.probeCase) : undefined;
  const v = verdict(kase);
  return (
    <div className="border-t border-border/60 py-5 first:border-t-0">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
        <p className="text-base font-medium text-foreground">{row.what}</p>
        {row.zone === "config" && (
          <p
            className={`shrink-0 font-mono text-sm ${
              v.tone === "caught"
                ? "text-good"
                : v.tone === "missed"
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60"
            }`}
          >
            {v.label}
          </p>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {row.gloss}
      </p>
      {row.slug && checkSlugsWithPages.has(row.slug) && (
        <a
          className="mt-2 inline-block text-sm text-primary hover:underline"
          href={`../checks/${row.slug}/`}
        >
          How vigiles checks it →
        </a>
      )}
    </div>
  );
}

export function ComparisonPage() {
  const config = ROWS.filter((r) => r.zone === "config");
  const behaviour = ROWS.filter((r) => r.zone === "behaviour");
  const groups: [string, ComparisonRow[]][] = [];
  for (const r of config) {
    const name = r.group ?? "Other";
    const found = groups.find(([n]) => n === name);
    if (found) found[1].push(r);
    else groups.push([name, [r]]);
  }
  const caught = config.filter(
    (r) => verdict(CASES.get(r.probeCase ?? "")).tone === "caught",
  ).length;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <a
        href="../"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> vigiles
      </a>

      <h1 className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">
        What breaks in an agent harness — and what notices
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
        Config that parses perfectly and still does nothing: a tool the harness
        drops, a hook wired to an event that does not exist, a script nobody
        committed. Below is every failure we check for, and whether the
        validator you already have catches it.
      </p>

      <section id="config" className="mt-14 scroll-mt-8">
        <h2 className="text-xl font-semibold">
          Is your config actually wired?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Measured, not asserted. Each row was planted as a real defect in a
          throwaway plugin and run through{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
            {snapshot.tool}
          </code>{" "}
          {snapshot.version}, in both shapes a user has — a repo-local{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
            .claude/
          </code>{" "}
          harness and a packaged plugin, with and without{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
            --strict
          </code>
          . It flagged <strong>{caught}</strong> of {config.length}. Re-run it
          yourself:{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
            node tools/measure-validate-overlap.mjs
          </code>
          .
        </p>
        {/* ONE line, not a two-column header: at 390px the two-column version
            collapsed into a four-line stack ("VIGILES / CATCHES / EVERY / ROW"). */}
        <p className="mt-8 text-sm text-foreground">
          vigiles catches every row below. The verdict on each is{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">
            {snapshot.tool}
          </code>{" "}
          {snapshot.version}.
        </p>

        {/* COLLAPSED BY DEFAULT. Thirteen expanded rows read as a lint-rule dump on
            a marketing page; four groups, each carrying its own measured tally, read
            as an argument you can skim in seconds and open only where you care.
            Native <details> — no JS, works without hydration, keyboard-accessible. */}
        <div className="mt-6 space-y-3">
          {groups.map(([name, rows]) => {
            const hit = rows.filter(
              (r) => verdict(CASES.get(r.probeCase ?? "")).tone === "caught",
            ).length;
            return (
              <details
                key={name}
                className="group rounded-xl border border-border/60 bg-card/30 px-5"
              >
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 py-4">
                  <span className="text-base font-medium text-foreground">
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {rows.length} {rows.length === 1 ? "check" : "checks"} ·{" "}
                    {hit === 0 ? "none caught" : `${String(hit)} caught`}
                  </span>
                </summary>
                <div className="pb-2">
                  {rows.map((r) => (
                    <Row key={r.what} row={r} />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      <section id="behaviour" className="mt-16 scroll-mt-8">
        <h2 className="text-xl font-semibold">
          Does the agent actually behave?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          These have no column above, and that is the honest answer rather than
          a gap: a config validator is not attempting them. Whether a skill
          fires cannot be decided by reading the file at all — it depends on a
          model choosing, so it has to be measured by running one.
        </p>
        <div className="mt-6">
          {behaviour.map((r) => (
            <Row key={r.what} row={r} />
          ))}
        </div>
      </section>

      <section className="mt-16 rounded-xl border border-border/60 bg-card/40 p-6">
        <h2 className="text-base font-semibold">Grade your own harness</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          One command, nothing uploaded, nothing executed — a deterministic
          read.
        </p>
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background p-3 font-mono text-sm">
          npx vigiles audit
        </pre>
      </section>

      <p className="mt-10 text-xs leading-relaxed text-muted-foreground">
        Every measured cell on this page comes from{" "}
        <code className="font-mono">{snapshot.command}</code>, run against{" "}
        {snapshot.tool} {snapshot.version} on {snapshot.measuredAt}. A blank
        cell means we have not run that tool against that defect — not that it
        fails. Only tools this repository actually runs appear here.
      </p>
    </main>
  );
}
