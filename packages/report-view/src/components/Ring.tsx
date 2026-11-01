import type { ReactNode } from "react";
import { band, STROKE, TEXT, type Band } from "../lib/band";
import { cn } from "../lib/utils";

/**
 * A circular score gauge — the Lighthouse ring — as inline SVG. The arc is the
 * band's FILL colour; anything written in the middle uses the band's INK, so the
 * number passes contrast where the arc colour would not.
 *
 * Two styles, and the difference carries meaning:
 * - solid: a graded category (or the overall grade), whose number moves the grade;
 * - dashed: an advisory category, shown with its real number but never graded.
 *   It is drawn in the neutral band whatever the score, so it never reads as a
 *   failing ring dragging the grade.
 *
 * `children` replaces the default centre (the score as text). The gauge is one
 * image to a screen reader: pass `label`, and the centre is hidden from it.
 */
export function Ring({
  score,
  size = 88,
  stroke = 8,
  advisory = false,
  tone,
  label,
  children,
  className,
}: {
  score: number | null;
  size?: number;
  stroke?: number;
  /** Advisory categories don't gate the grade — dashed and neutral, never red. */
  advisory?: boolean;
  /** Override the band (the overall gauge passes the grade's band). */
  tone?: Band;
  /** Accessible name for the whole gauge, e.g. "Safety 80 of 100". */
  label?: string;
  children?: ReactNode;
  className?: string;
}) {
  const b: Band = advisory ? "na" : (tone ?? band(score));
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  const r = 50 - stroke / 2 - 1;
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <svg
        viewBox="0 0 100 100"
        className="block size-full -rotate-90"
        aria-hidden
      >
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth={advisory ? stroke / 2 : stroke}
          className="stroke-track"
        />
        {pct > 0 && (
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            strokeWidth={advisory ? stroke / 2 : stroke}
            strokeLinecap={advisory ? "butt" : "round"}
            pathLength={100}
            strokeDasharray={advisory ? dashedArc(pct) : `${pct} 100`}
            className={STROKE[b]}
          />
        )}
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center text-center"
        aria-hidden={label ? true : undefined}
      >
        {children ?? (
          <span
            className={cn(
              "font-display font-semibold leading-none tracking-tight tabular-nums",
              TEXT[b],
            )}
            style={{ fontSize: Math.round(size * 0.3) }}
          >
            {score === null ? "n/a" : score}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The dash pattern of a dashed arc covering `pct` of the circle: 2-on 3-off
 * dashes up to `pct`, then one gap for the rest. `pathLength` is 100, so the
 * units are percent of the circumference.
 */
function dashedArc(pct: number): string {
  const dashes = Math.floor(pct / 5);
  const parts: string[] = [];
  for (let i = 0; i < dashes; i++) parts.push("2", "3");
  return parts.length > 0 ? `${parts.join(" ")} 0 100` : "0 100";
}
