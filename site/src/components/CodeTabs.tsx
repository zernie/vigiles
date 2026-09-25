import { useState } from "react";
import { CodeBlock } from "@/components/CodeBlock";

/**
 * A tiny hand-rolled tab switcher for showing several REAL compiled files
 * side by side without stacking them (which the page's own "ONE artifact"
 * rule forbids) or picking just one and hiding the others (which under-sells
 * `vigiles compile` — it compiles skills, agents AND instruction files the
 * same way, and a reader should be able to see all three).
 *
 * Hand-rolled on purpose, not @radix-ui/react-tabs: this repo has zero Radix
 * dependencies today, and three static panels need nothing a plain
 * `useState` + `role="tablist"` doesn't already give for free. Keeps the
 * accessibility contract (`role`, `aria-selected`, `aria-controls`) without
 * the dependency.
 */
export interface CodeTab {
  readonly label: string;
  readonly code: string;
  readonly language?: string;
}

export function CodeTabs({
  tabs,
  className = "",
}: {
  tabs: readonly CodeTab[];
  className?: string;
}) {
  const [active, setActive] = useState(0);
  const current = tabs[active];
  if (!current) return null;
  return (
    <div className={className}>
      <div role="tablist" className="flex gap-1 border-b border-border/60">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            type="button"
            aria-selected={i === active}
            aria-controls={`code-tab-panel-${i}`}
            onClick={() => setActive(i)}
            className={`-mb-px rounded-t-md border border-b-0 px-3 py-2 font-mono text-xs transition-colors ${
              i === active
                ? "border-border/60 bg-card/30 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`code-tab-panel-${active}`}>
        <CodeBlock
          code={current.code}
          language={current.language ?? "yaml"}
          className="mt-0 rounded-tl-none"
        />
      </div>
    </div>
  );
}
