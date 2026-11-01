import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * One full-width section of the standalone report. Sections are told apart by
 * alternating ground (`alt`), not by boxes: no border, no shadow, no card
 * inside a card. The content sits in one centred column.
 */
export function Band({
  id,
  title,
  eyebrow,
  alt = false,
  className,
  children,
}: {
  /** Heading id, so the section is labelled by its heading. */
  id: string;
  title: ReactNode;
  /** A short line above the heading (context, a count). */
  eyebrow?: ReactNode;
  alt?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "px-5 py-10 sm:px-10 sm:py-16",
        alt && "bg-band",
        className,
      )}
    >
      <div className="mx-auto max-w-[66rem]">
        {eyebrow && (
          <p className="mb-1.5 font-display text-[15px] font-medium leading-snug text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h2
          id={id}
          className="mb-6 flex flex-wrap items-center gap-3 font-display text-[28px] font-semibold leading-tight tracking-tight"
        >
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}
