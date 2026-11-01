/**
 * The standalone report's hero and category rings: the grade is a gauge with an
 * accessible name, the headline drops the engine's leading "<grade> — " (the
 * gauge already shows the letter), the distance to the next grade comes from the
 * verdict, and the advisory rings say they are not graded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Report, SAMPLE, type AuditReport } from "@vigiles/report-view";

const withVerdict = (sentence: string): AuditReport => ({
  ...SAMPLE,
  verdict: { ...SAMPLE.verdict, sentence },
});

afterEach(cleanup);

describe("the report hero", () => {
  it("names the gauge with the grade and score", () => {
    render(<Report data={SAMPLE} />);
    expect(
      screen.getByRole("img", { name: "Grade C, 77 of 100" }),
    ).toBeTruthy();
  });

  it("drops the leading grade from the headline, and only that", () => {
    render(<Report data={withVerdict("C — 2 units can run commands.")} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "2 units can run commands.",
    );
    cleanup();
    render(<Report data={withVerdict("Close to a B.")} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Close to a B.",
    );
  });

  it("states the points to the next grade from the verdict", () => {
    render(<Report data={SAMPLE} />);
    expect(screen.getByText("3 points to B")).toBeTruthy();
  });

  it("prints no next-grade line at an A", () => {
    render(
      <Report
        data={{
          ...SAMPLE,
          verdict: { ...SAMPLE.verdict, grade: "A", pointsToNextGrade: null },
        }}
      />,
    );
    expect(screen.queryByText(/points? to [A-F]$/)).toBeNull();
  });

  it("labels the advisory rings as not graded, and an unasked one as not measured", () => {
    render(<Report data={SAMPLE} />);
    expect(
      screen.getByRole("img", {
        name: "Tested: 88, advisory, not graded",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Evaluated: not measured, advisory, not graded",
      }),
    ).toBeTruthy();
  });

  it("prints a Safety finding once, under Do these first", () => {
    render(<Report data={SAMPLE} />);
    const safety = SAMPLE.score.categories.find((c) => c.key === "Safety");
    const finding = safety?.findings[0] ?? "";
    expect(screen.getAllByText(finding)).toHaveLength(1);
  });
});
