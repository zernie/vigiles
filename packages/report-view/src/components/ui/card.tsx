import * as React from "react";
import { cn } from "../../lib/utils";

// A plain bordered box (no shadow). The standalone report uses bands instead;
// this is for the site demo and for small boxes inside a band.
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-foreground",
        className,
      )}
      {...props}
    />
  );
}
