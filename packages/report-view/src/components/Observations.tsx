import { XCircle } from "lucide-react";
import type { LedgerSummary } from "../schema";
import { TEXT } from "../lib/band";
import { cn } from "../lib/utils";

/**
 * The flight recorder — what the harness actually DID in real sessions, read off
 * the local `.vigiles/runs.jsonl` ledger. Presentational (data-in-props) so the
 * future hosted dashboard reuses it over the same AuditReport contract.
 *
 * A denial's label is usually a hook command line or an absolute path with no
 * spaces, so it is allowed to break anywhere: one unbreakable path used to widen
 * the whole document past a phone's viewport.
 */
export function Observations({ data }: { data: LedgerSummary }) {
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[52px] font-semibold leading-none tracking-tight tabular-nums">
          {data.total.toLocaleString("en-US")}
        </span>
        <span className="font-display text-lg text-foreground-soft">
          record{data.total === 1 ? "" : "s"} recorded
        </span>
      </p>
      {data.counts.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[15px] text-foreground-soft">
          {data.counts.map((c) => (
            <li key={c.kind}>
              <span className="font-semibold tabular-nums text-foreground">
                {c.count.toLocaleString("en-US")}
              </span>{" "}
              {c.kind}
            </li>
          ))}
        </ul>
      )}
      {data.recentDenials.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-2 font-display text-lg font-semibold">
            Recent denials{" "}
            <span className="font-normal text-muted-foreground">
              ({data.denials})
            </span>
          </h3>
          <ul>
            {data.recentDenials.map((d, i) => (
              <li
                key={i}
                className="grid grid-cols-[1.25rem_1fr] gap-x-2 border-t border-border py-3"
              >
                <XCircle
                  size={16}
                  aria-hidden
                  className={cn("mt-0.5", TEXT.bad)}
                />
                <div className="min-w-0">
                  <code className="block font-mono text-sm text-foreground [overflow-wrap:anywhere]">
                    {d.label}
                  </code>
                  <p className="mt-0.5 text-[15px] text-foreground-soft">
                    {d.reason}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
