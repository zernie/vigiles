/**
 * The HTML report's always-loaded section renders `contextCost.alwaysLoaded`:
 * every part with its size in the report's unit, a part that is not counted as
 * the reason it is not (never as 0), and nothing at all for an older report
 * that carries no `contextCost`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Report, SAMPLE, type AuditReport } from "@vigiles/report-view";

type Loaded = NonNullable<AuditReport["contextCost"]>["alwaysLoaded"];

const withLoaded = (alwaysLoaded: Loaded): AuditReport => ({
  ...SAMPLE,
  contextCost: { alwaysLoaded },
});

const section = (): HTMLElement => {
  const h = screen.getByRole("heading", { name: "Always-loaded context" });
  const card = h.nextElementSibling?.nextElementSibling;
  if (!(card instanceof HTMLElement)) throw new Error("no section card");
  return card;
};

afterEach(cleanup);

describe("always-loaded context in the report", () => {
  it("shows the total and each counted part with its share", () => {
    render(<Report data={SAMPLE} />);
    const text = section().textContent ?? "";
    expect(text).toContain("33,912chars loaded before the first message");
    expect(text).toContain("Instructions24,665 chars · 73%");
    expect(text).toContain("Output style4,216 chars · 12%");
    expect(text).toContain("Skill listing5,031 chars · 15%");
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Instructions 24,665 chars, Output style 4,216 chars, Skill listing 5,031 chars",
    );
  });

  it("names why a part is not counted, in the harness unit, and never prints 0", () => {
    render(
      <Report
        data={withLoaded({
          unit: "bytes",
          total: 900,
          parts: [
            {
              part: "instructions",
              kind: "counted",
              total: 900,
              files: [{ path: "AGENTS.md", size: 900 }],
            },
            { part: "output-style", kind: "not-supported" },
            { part: "skill-listing", kind: "not-modelled" },
          ],
        })}
      />,
    );
    const text = section().textContent ?? "";
    expect(text).toContain("900bytes loaded before the first message");
    expect(text).toContain("Output stylenot supported by this harness");
    expect(text).toContain("Skill listingnot modelled by vigiles");
    expect(text).not.toMatch(/\b0 bytes/);
  });

  it("separates nothing selected from a selected style with no file", () => {
    render(
      <Report
        data={withLoaded({
          unit: "chars",
          total: 67,
          parts: [
            { part: "instructions", kind: "counted", total: 67, files: [] },
            { part: "output-style", kind: "unresolved", name: "Explanatory" },
            { part: "skill-listing", kind: "none" },
          ],
        })}
      />,
    );
    const text = section().textContent ?? "";
    expect(text).toContain(
      'Output style"Explanatory" selected — no repository file declares it',
    );
    expect(text).toContain("Skill listingno skills listed");
  });

  it("an older report without contextCost renders no section", () => {
    const { contextCost: _drop, ...older } = SAMPLE;
    render(<Report data={older} />);
    expect(screen.queryByText("Always-loaded context")).toBeNull();
  });
});
