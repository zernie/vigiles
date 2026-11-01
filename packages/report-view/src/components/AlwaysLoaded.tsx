import { ChevronRight } from "lucide-react";
import type { AlwaysLoadedPart, AlwaysLoadedReport } from "../schema";
import { cn } from "../lib/utils";

/**
 * The always-loaded context — what the harness loads at session start before
 * any decision (instructions · selected output style · skill listing), in the
 * harness's own unit. Presentational: it reads only the `contextCost.alwaysLoaded`
 * slice of the AuditReport contract.
 *
 * Only a `counted` part has a size. Every other kind is a REASON there is none,
 * and it renders as that reason, never as `0` — "nothing selected" and "vigiles
 * cannot see it" are different facts from "weighs nothing".
 *
 * The bar uses the theme's three series colours (`--part-1..3`), not the band
 * colours: a band means good/warn/bad, and the share of one part is not a
 * verdict. Each part keeps its colour whatever its size, and every row names
 * its part, so colour is never the only key. The share figures are large text
 * (52px and up), where the series colours pass the 3:1 large-text contrast.
 */

const LABEL: Record<AlwaysLoadedPart["part"], string> = {
  instructions: "Instructions",
  "output-style": "Output style",
  "skill-listing": "Skill listing",
};

/** One literal class per part so Tailwind's JIT emits them. */
const SHADE: Record<AlwaysLoadedPart["part"], string> = {
  instructions: "bg-part-1",
  "output-style": "bg-part-2",
  "skill-listing": "bg-part-3",
};

/** Fixed locale: the same JSON renders the same digits on every machine. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Why an uncounted part has no size — the wording the reader acts on. */
function reason(p: Exclude<AlwaysLoadedPart, { kind: "counted" }>): string {
  switch (p.kind) {
    case "none":
      return p.part === "output-style" ? "none selected" : "no skills listed";
    case "not-supported":
      return "not supported by this harness";
    case "not-modelled":
      return "not modelled by vigiles";
    case "unresolved":
      return `"${p.name}" selected — no repository file declares it`;
  }
}

/** Literal text classes for the share figure, one per part, so the JIT emits them. */
const INK: Record<AlwaysLoadedPart["part"], string> = {
  instructions: "text-part-1",
  "output-style": "text-part-2",
  "skill-listing": "text-part-3",
};

/** A part's share of the total, rounded; a non-empty part never reads "0%". */
function share(part: number, total: number): string {
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 0.5) return "<1%";
  return `${Math.round(pct)}%`;
}

/** The files behind a counted part: the one file named, or a fold listing them. */
function Files({
  files,
}: {
  files: Extract<AlwaysLoadedPart, { kind: "counted" }>["files"];
}) {
  if (files.length <= 1) return null;
  return (
    <details className="group mt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[15px] text-foreground-soft hover:text-foreground">
        <ChevronRight
          size={15}
          aria-hidden
          className="transition-transform group-open:rotate-90"
        />
        {files.length} files
      </summary>
      <ul className="mt-1.5 space-y-1 border-l border-border pl-3">
        {files.map((f) => (
          <li
            key={f.path}
            className="flex justify-between gap-3 font-mono text-sm text-foreground-soft"
          >
            <span className="min-w-0 break-all">{f.path}</span>
            <span className="shrink-0 tabular-nums">{fmt(f.size)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One part: its share as a large figure in the part's series colour, then its
 * name and size. A part with no size shows the reason instead, and no figure.
 */
function PartRow({
  p,
  unit,
  total,
}: {
  p: AlwaysLoadedPart;
  unit: AlwaysLoadedReport["unit"];
  total: number;
}) {
  const counted = p.kind === "counted";
  const only = counted && p.files.length === 1 ? p.files[0] : undefined;
  return (
    <li className="grid grid-cols-[6.5rem_1fr] items-end gap-x-3 sm:grid-cols-[8.5rem_1fr]">
      <span
        className={cn(
          "font-display text-[52px] font-semibold leading-none tracking-tight tabular-nums sm:text-6xl",
          counted ? INK[p.part] : "text-muted-foreground",
        )}
        aria-hidden={!counted || total === 0}
      >
        {counted && total > 0 ? share(p.total, total) : "—"}
      </span>
      <div className="min-w-0 pb-1">
        <span className="block font-display text-[17px] font-semibold leading-snug">
          {LABEL[p.part]}
        </span>
        {counted ? (
          <span className="block text-[15px] text-foreground-soft">
            <span className="tabular-nums">{fmt(p.total)}</span> {unit}
            {only && (
              <>
                {" · "}
                <span className="break-all">{only.path}</span>
              </>
            )}
          </span>
        ) : (
          <span className="block text-[15px] text-foreground-soft">
            {reason(p)}
          </span>
        )}
        {counted && <Files files={p.files} />}
      </div>
    </li>
  );
}

export function AlwaysLoaded({ data }: { data: AlwaysLoadedReport }) {
  const counted = data.parts.filter(
    (p): p is Extract<AlwaysLoadedPart, { kind: "counted" }> =>
      p.kind === "counted" && p.total > 0,
  );
  return (
    <div className="grid gap-8 sm:grid-cols-2 sm:items-start sm:gap-14">
      <div>
        <p className="font-display text-[76px] font-semibold leading-[0.95] tracking-[-0.045em] tabular-nums sm:text-[112px]">
          {fmt(data.total)}
        </p>
        <p className="mt-2 max-w-[52ch] text-[17px] leading-relaxed text-foreground-soft">
          {data.unit} the harness reads at the start of every session, before
          any decision: your instruction files, the selected output style and
          the skill listing. Every request pays for them again.
        </p>
      </div>
      <div>
        {data.total > 0 && counted.length > 0 && (
          <div
            className="mb-7 flex h-[22px] gap-[3px]"
            role="img"
            aria-label={counted
              .map((p) => `${LABEL[p.part]} ${fmt(p.total)} ${data.unit}`)
              .join(", ")}
          >
            {counted.map((p) => (
              <div
                key={p.part}
                className={cn("h-full rounded-sm", SHADE[p.part])}
                style={{ width: `${(p.total / data.total) * 100}%` }}
              />
            ))}
          </div>
        )}
        <ul className="grid gap-5">
          {data.parts.map((p) => (
            <PartRow key={p.part} p={p} unit={data.unit} total={data.total} />
          ))}
        </ul>
      </div>
    </div>
  );
}
