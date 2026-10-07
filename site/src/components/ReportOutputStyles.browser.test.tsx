/**
 * The HTML report's inventory lists output styles. The engine counts them, so a
 * style-only harness is not empty; a view that dropped the field showed it
 * shipping nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Report, SAMPLE, type AuditReport } from "@vigiles/report-view";

const withStyles = (
  outputStyles: AuditReport["inventory"]["outputStyles"],
) => ({
  ...SAMPLE,
  inventory: { ...SAMPLE.inventory, outputStyles },
});

afterEach(cleanup);

describe("output styles in the report inventory", () => {
  it("the full report lists them", () => {
    render(<Report data={withStyles(2)} />);
    expect(screen.getByText("2 output styles")).toBeTruthy();
  });

  it("the summary lists them", () => {
    render(<Report variant="summary" data={withStyles(1)} />);
    // The summary prints each item as " · N thing".
    expect(screen.getByText(/· 1 output style$/)).toBeTruthy();
  });

  it("an older report without the field renders no style count", () => {
    render(<Report data={SAMPLE} />);
    expect(screen.queryByText(/output style/)).toBeNull();
  });
});
