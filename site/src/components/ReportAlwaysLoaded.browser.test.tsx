/**
 * The HTML report's always-loaded section renders `contextCost.alwaysLoaded`:
 * every part with its share and its size in the report's unit, a part that is
 * not counted as the reason it is not (never as 0 or 0%), and nothing at all
 * for an older report that carries no `contextCost`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Report, SAMPLE, type AuditReport } from "@vigiles/report-view";

type Loaded = NonNullable<AuditReport["contextCost"]>["alwaysLoaded"];

const withLoaded = (alwaysLoaded: Loaded): AuditReport => ({
  ...SAMPLE,
  contextCost: { alwaysLoaded },
});

const section = (): HTMLElement => {
  const h = screen.getByRole("heading", { name: "Always-loaded context" });
  const band = h.closest("section");
  if (!(band instanceof HTMLElement)) throw new Error("no section band");
  return band;
};

/** The row of one part: its share figure, name, and size or reason. */
const row = (label: string): string => {
  const li = Array.from(section().querySelectorAll("li")).find((el) =>
    el.textContent?.includes(label),
  );
  if (!li) throw new Error(`no row for ${label}`);
  return li.textContent ?? "";
};

afterEach(cleanup);

describe("always-loaded context in the report", () => {
  it("shows the total and each counted part with its share", () => {
    render(<Report data={SAMPLE} />);
    const text = section().textContent ?? "";
    expect(text).toContain("33,912chars the harness reads");
    expect(row("Instructions")).toContain(
      "73%Instructions24,665 chars · CLAUDE.md",
    );
    expect(row("Output style")).toContain("12%Output style4,216 chars");
    expect(row("Skill listing")).toContain(
      "15%Skill listing5,031 chars2 files",
    );
    expect(within(section()).getByRole("img").getAttribute("aria-label")).toBe(
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
    expect(text).toContain("900bytes the harness reads");
    expect(row("Instructions")).toContain(
      "100%Instructions900 bytes · AGENTS.md",
    );
    expect(row("Output style")).toContain(
      "Output stylenot supported by this harness",
    );
    expect(row("Skill listing")).toContain(
      "Skill listingnot modelled by vigiles",
    );
    expect(text).not.toMatch(/\b0 bytes/);
    expect(text).not.toMatch(/\b0%/);
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
    expect(row("Output style")).toContain(
      'Output style"Explanatory" selected — no repository file declares it',
    );
    expect(row("Skill listing")).toContain("Skill listingno skills listed");
  });

  it("wraps a long single-file path inside a phone-width page", () => {
    // A part with exactly one file prints its path inline beside the size; a
    // long unbroken path must wrap there, as it does in the file list, instead
    // of widening the page past the screen.
    const box = document.createElement("div");
    box.style.width = "360px";
    document.body.appendChild(box);
    const path = `.claude/output-styles/${"a-very-long-output-style-name-".repeat(4)}.md`;
    render(
      <Report
        data={withLoaded({
          unit: "chars",
          total: 900,
          parts: [
            {
              part: "instructions",
              kind: "counted",
              total: 900,
              files: [{ path, size: 900 }],
            },
            { part: "output-style", kind: "none" },
            { part: "skill-listing", kind: "none" },
          ],
        })}
      />,
      { container: box },
    );
    const shown = within(section()).getByText(path);
    expect(shown.getBoundingClientRect().right).toBeLessThanOrEqual(
      box.getBoundingClientRect().right,
    );
    box.remove();
  });

  it("an older report without contextCost renders no section", () => {
    const { contextCost: _drop, ...older } = SAMPLE;
    render(<Report data={older} />);
    expect(screen.queryByText("Always-loaded context")).toBeNull();
  });
});
