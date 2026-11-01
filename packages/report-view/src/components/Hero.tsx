import type { Verdict } from "../schema";
import { band, TEXT, type Band } from "../lib/band";
import { pointsToNext, verdictHeadline } from "../lib/verdict";
import { cn } from "../lib/utils";
import { Ring } from "./Ring";

/** The hero's ground: a faint wash of the grade's band. Literal classes for the JIT. */
const WASH: Record<Band, string> = {
  good: "bg-good/10",
  warn: "bg-warn/10",
  bad: "bg-bad/10",
  na: "bg-na/10",
};

/**
 * The standalone report's first screen: the grade as a large gauge (letter
 * inside, score under it), the verdict sentence as the headline, and how far
 * the next grade is. The gauge leads because the grade is the answer; the
 * sentence explains it.
 */
export function Hero({
  verdict,
  overall,
  name,
  harness,
}: {
  verdict: Verdict;
  overall: number | null;
  name: string;
  harness: string;
}) {
  const b = band(overall);
  const next = pointsToNext(verdict);
  const scoreText = overall === null ? "no score" : `${overall} of 100`;
  return (
    <section
      aria-labelledby="report-verdict"
      className={cn("px-5 pb-10 pt-7 sm:px-10 sm:pb-16 sm:pt-8", WASH[b])}
    >
      <div className="mx-auto max-w-[66rem]">
        <p className="mb-7 flex flex-wrap gap-x-3.5 gap-y-1 text-sm text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">vigiles audit</span>{" "}
            · {name} · {harness}
          </span>
          <span>deterministic · no model · nothing leaves your machine</span>
        </p>
        <div className="grid justify-items-start gap-6 sm:grid-cols-[220px_1fr] sm:items-center sm:gap-12">
          <Ring
            score={overall}
            tone={b}
            stroke={7}
            label={`Grade ${verdict.grade}, ${scoreText}`}
            className="size-[176px]! sm:size-[220px]!"
            size={220}
          >
            <span className="font-display text-[76px] font-bold leading-[0.9] tracking-[-0.04em] text-foreground sm:text-[96px]">
              {verdict.grade}
            </span>
            <span className="mt-1.5 font-display text-[17px] font-medium tabular-nums text-foreground-soft">
              {overall === null ? "—" : `${overall} / 100`}
            </span>
          </Ring>
          <div>
            <h1
              id="report-verdict"
              className="mb-3 max-w-[30ch] font-display text-[26px] font-semibold leading-[1.22] tracking-tight [text-wrap:balance] sm:text-4xl"
            >
              {verdictHeadline(verdict)}
            </h1>
            {next && (
              <p
                className={cn(
                  "font-display text-[17px] font-semibold",
                  TEXT[b],
                )}
              >
                {next}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
