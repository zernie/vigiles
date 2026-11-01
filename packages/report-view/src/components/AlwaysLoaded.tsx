import { ChevronRight, Layers } from "lucide-react";
import type { AlwaysLoadedPart, AlwaysLoadedReport } from "../schema";
import { Card } from "./ui/card";
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
 * The bar uses neutral ink shades, not the band colours: a band means
 * good/warn/bad, and the share of one part is not a verdict.
 */

const LABEL: Record<AlwaysLoadedPart["part"], string> = {
  instructions: "Instructions",
  "output-style": "Output style",
  "skill-listing": "Skill listing",
};

/** One literal class per part so Tailwind's JIT emits them. */
const SHADE: Record<AlwaysLoadedPart["part"], string> = {
  instructions: "bg-foreground/80",
  "output-style": "bg-foreground/45",
  "skill-listing": "bg-foreground/20",
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
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            aria-hidden
            className={cn(
              "inline-block h-2.5 w-2.5 shrink-0 rounded-sm",
              counted ? SHADE[p.part] : "border border-border",
            )}
          />
          {LABEL[p.part]}
        </span>
        {counted ? (
          <span className="text-right font-mono text-sm tabular-nums">
            <span className="font-bold">{fmt(p.total)}</span>{" "}
            <span className="text-xs text-muted-foreground">
              {unit}
              {total > 0 && ` · ${Math.round((p.total / total) * 100)}%`}
            </span>
          </span>
        ) : (
          <span className="text-right text-xs text-na">{reason(p)}</span>
        )}
      </div>
      {counted && p.files.length > 0 && (
        <details className="group mt-1 pl-[1.125rem]">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground/80 hover:text-foreground">
            <ChevronRight
              size={11}
              className="transition-transform group-open:rotate-90"
            />
            {p.files.length} file{p.files.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5 border-l border-border/50 pl-3">
            {p.files.map((f) => (
              <li
                key={f.path}
                className="flex justify-between gap-3 font-mono text-[11px] text-muted-foreground"
              >
                <span className="min-w-0 break-all">{f.path}</span>
                <span className="shrink-0 tabular-nums">{fmt(f.size)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function AlwaysLoaded({ data }: { data: AlwaysLoadedReport }) {
  const counted = data.parts.filter(
    (p): p is Extract<AlwaysLoadedPart, { kind: "counted" }> =>
      p.kind === "counted" && p.total > 0,
  );
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Layers
          size={16}
          className="shrink-0 self-center text-muted-foreground"
          aria-hidden
        />
        <span className="text-3xl font-bold tabular-nums">
          {fmt(data.total)}
        </span>
        <span className="text-sm text-muted-foreground">
          {data.unit} loaded before the first message
        </span>
      </div>
      {data.total > 0 && counted.length > 0 && (
        <div
          className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full bg-border"
          role="img"
          aria-label={counted
            .map((p) => `${LABEL[p.part]} ${fmt(p.total)} ${data.unit}`)
            .join(", ")}
        >
          {counted.map((p) => (
            <div
              key={p.part}
              className={cn("h-full", SHADE[p.part])}
              style={{ width: `${(p.total / data.total) * 100}%` }}
            />
          ))}
        </div>
      )}
      <ul className="mt-2 divide-y divide-border/40">
        {data.parts.map((p) => (
          <PartRow key={p.part} p={p} unit={data.unit} total={data.total} />
        ))}
      </ul>
    </Card>
  );
}
