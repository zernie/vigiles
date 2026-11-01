import { CheckCircle2, Link2Off } from "lucide-react";
import type { AdoptabilityResult, BrokenRef } from "../schema";
import { TEXT } from "../lib/band";
import { cn } from "../lib/utils";

const KIND_LABEL: Record<BrokenRef["kind"], string> = {
  enforce: "rule",
  file: "file",
  cmd: "cmd",
  dir: "dir",
};

function BrokenRefRow({ r }: { r: BrokenRef }) {
  return (
    <li className="grid grid-cols-[3.5rem_1fr] gap-x-3 border-t border-border py-3">
      <span className="font-display text-sm font-semibold text-muted-foreground">
        {KIND_LABEL[r.kind]}
      </span>
      <div className="min-w-0">
        <code className="break-all font-mono text-[15px] text-foreground">
          {r.ref}
        </code>
        <p className={cn("mt-0.5 text-[15px]", TEXT.bad)}>{r.issue}</p>
      </div>
    </li>
  );
}

export function Adoptability({ data }: { data: AdoptabilityResult }) {
  if (data.total === 0) {
    return (
      <p className="text-base text-muted-foreground">
        No machine-verifiable references found — add{" "}
        <code className="rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.9em]">
          enforce()
        </code>{" "}
        calls to a{" "}
        <code className="rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.9em]">
          .spec.ts
        </code>{" "}
        to unlock cross-referencing.
      </p>
    );
  }

  const allGood = data.broken === 0;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <p className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-display text-[52px] font-semibold leading-none tracking-tight tabular-nums",
              allGood ? TEXT.good : TEXT.bad,
            )}
          >
            {data.broken}
          </span>
          <span className="font-display text-lg text-foreground-soft">
            of {data.total} broken
          </span>
        </p>
        {allGood ? (
          <span
            className={cn("flex items-center gap-1.5 text-base", TEXT.good)}
          >
            <CheckCircle2 size={16} aria-hidden /> all {data.total} reference
            {data.total === 1 ? "" : "s"} resolve
          </span>
        ) : (
          <span className={cn("flex items-center gap-1.5 text-base", TEXT.bad)}>
            <Link2Off size={16} aria-hidden /> {data.broken} broken reference
            {data.broken === 1 ? "" : "s"} found
          </span>
        )}
      </div>

      {data.brokenRefs.length > 0 && (
        <ul className="mt-5">
          {data.brokenRefs.map((r, i) => (
            <BrokenRefRow key={i} r={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
