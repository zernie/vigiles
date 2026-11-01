import type { CategoryScore } from "../schema";
import { categoryScoreLabel } from "../schema";
import { band, TEXT, type Band } from "../lib/band";
import { cn } from "../lib/utils";
import { Ring } from "./Ring";

/** The scorer's stable suffix on a finding that costs no points. */
const ADVISORY_SUFFIX = "(advisory)";

/** A single revealed finding, rendered as plain prose. The scorer's stable
 *  "(advisory)" suffix is stripped for display and signalled separately. We do NOT
 *  try to reverse-map the prose back to an explainer slug — a finding carries no
 *  detector in the wire shape, and pattern-matching sentences to guess one is
 *  fragile; the explainer links live on the fix cards, which carry a real detector. */
export function FindingText({
  text,
  advisory,
}: {
  text: string;
  advisory: boolean;
}) {
  const clean = text.endsWith(ADVISORY_SUFFIX)
    ? text.slice(0, -ADVISORY_SUFFIX.length).trimEnd()
    : text;
  return (
    <span>
      <span>{clean}</span>
      {advisory && <span className="text-na-ink"> · advisory, not graded</span>}
    </span>
  );
}

/** A category's findings, graded ones (they cost points) first. */
export function orderedFindings(
  c: CategoryScore,
): { text: string; advisory: boolean }[] {
  const all = c.findings.map((f) => ({
    text: f,
    advisory: Boolean(c.advisory) || f.endsWith(ADVISORY_SUFFIX),
  }));
  return [...all.filter((f) => !f.advisory), ...all.filter((f) => f.advisory)];
}

function bandOf(c: CategoryScore): Band {
  return c.advisory ? "na" : band(c.score);
}

/** What sits under a ring's name: "clean", or how many findings it carries. */
function caption(c: CategoryScore): string {
  const n = c.findings.length;
  if (n === 0) return "clean";
  return `${n} finding${n === 1 ? "" : "s"}`;
}

function CategoryRing({ c }: { c: CategoryScore }) {
  const label = categoryScoreLabel(c);
  const numeric = c.score !== null;
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center text-center">
      <Ring
        score={c.score}
        advisory={c.advisory}
        label={`${c.key}: ${label}${c.advisory ? ", advisory, not graded" : ""}`}
      >
        <span
          className={cn(
            "font-display font-semibold leading-none tabular-nums",
            numeric ? "text-[26px] tracking-tight" : "max-w-[8ch] text-sm",
            TEXT[bandOf(c)],
          )}
        >
          {label}
        </span>
      </Ring>
      <span className="mt-2.5 font-display text-base font-semibold leading-tight">
        {c.key}
      </span>
      <span className="mt-0.5 text-sm leading-snug text-foreground-soft">
        {caption(c)}
      </span>
    </li>
  );
}

/**
 * The category strip: one solid ring per graded category, then the advisory
 * ones dashed and set apart under their own caption, because they never move
 * the grade.
 */
export function CategoryRings({
  categories,
}: {
  categories: readonly CategoryScore[];
}) {
  const graded = categories.filter((c) => !c.advisory);
  const advisory = categories.filter((c) => c.advisory);
  return (
    <div className="flex flex-col gap-7 sm:flex-row sm:gap-0">
      <ul
        aria-label="Graded categories"
        className="grid grid-cols-2 gap-x-2.5 gap-y-7 sm:flex sm:flex-[2] sm:gap-3"
      >
        {graded.map((c) => (
          <CategoryRing key={c.key} c={c} />
        ))}
      </ul>
      {advisory.length > 0 && (
        <div className="border-t border-border pt-5 sm:ml-3 sm:flex-1 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
          <p className="mb-4 text-center text-sm text-muted-foreground">
            Advisory · not graded
          </p>
          <ul
            aria-label="Advisory categories"
            className="grid grid-cols-2 gap-x-2.5 gap-y-7 sm:flex sm:gap-3"
          >
            {advisory.map((c) => (
              <CategoryRing key={c.key} c={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The words behind the rings: every category's findings, in full, at reading
 * size. `exclude` drops findings shown elsewhere (the Safety findings listed
 * under "Do these first"), so no sentence is printed twice.
 */
export function FlaggedList({
  categories,
  brokenReferences,
  exclude,
}: {
  categories: readonly CategoryScore[];
  brokenReferences?: readonly string[];
  exclude: ReadonlySet<string>;
}) {
  const rows = categories
    .map((c) => ({
      c,
      findings: orderedFindings(c).filter((f) => !exclude.has(f.text)),
    }))
    .filter((r) => r.findings.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="mt-12">
      <h3 className="mb-2 font-display text-xl font-semibold">
        What was flagged
      </h3>
      <dl>
        {rows.map(({ c, findings }) => (
          <div
            key={c.key}
            className="grid gap-x-8 gap-y-1 border-t border-border py-4 sm:grid-cols-[10rem_1fr]"
          >
            <dt
              className={cn(
                "font-display text-base font-semibold",
                TEXT[bandOf(c)],
              )}
            >
              {c.key}
            </dt>
            <dd className="min-w-0">
              <ul className="space-y-1.5 text-base leading-relaxed">
                {findings.map((f) => (
                  <li key={f.text}>
                    <FindingText text={f.text} advisory={f.advisory} />
                  </li>
                ))}
              </ul>
              {c.key === "Truthfulness" &&
                brokenReferences &&
                brokenReferences.length > 0 && (
                  <ul className="mt-1.5 space-y-1 font-mono text-sm text-foreground-soft">
                    {brokenReferences.map((r) => (
                      <li key={r} className="break-all">
                        ↳ {r}{" "}
                        <span className="text-muted-foreground">— missing</span>
                      </li>
                    ))}
                  </ul>
                )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
