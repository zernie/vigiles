/**
 * The headline swaps Claude Code ⇄ Codex. Contract: the swap never reflows the
 * headline (one height throughout) and the harness name's slot EASES between the
 * two word widths, so " setup." glides instead of jumping when the centred line
 * re-centres. The old version swapped the word in one frame and the second line
 * visibly jumped on a phone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { Hero } from "./Hero";

afterEach(cleanup);

const frame = () => new Promise((r) => requestAnimationFrame(r));

describe("Hero — the harness-name swap", () => {
  it("eases the slot width and keeps the headline height through a full cycle at 390px", async () => {
    await page.viewport(390, 844);
    render(<Hero />);
    const h1 = screen.getByRole("heading", { level: 1 });
    const slot = screen.getByTestId("swap-word");
    const heights = new Set<number>();
    const words = new Set<string>();
    const widths: number[] = [];
    const deadline = performance.now() + 3600;
    while (performance.now() < deadline) {
      heights.add(Math.round(h1.getBoundingClientRect().height));
      words.add(slot.firstElementChild?.textContent ?? "");
      widths.push(slot.getBoundingClientRect().width);
      await frame();
    }
    // Guards: a swap actually happened (else the rest is vacuous).
    expect(words.size).toBeGreaterThan(1);
    // Guards: the headline never re-wrapped while the words swapped.
    expect([...heights]).toHaveLength(1);
    // Guards: the width moved in several small steps, not one jump.
    const range = Math.max(...widths) - Math.min(...widths);
    let step = 0;
    for (let k = 1; k < widths.length; k++)
      step = Math.max(step, Math.abs(widths[k] - widths[k - 1]));
    expect(range).toBeGreaterThan(20);
    expect(step).toBeLessThan(range * 0.6);
    expect(h1.scrollWidth).toBeLessThanOrEqual(h1.clientWidth);
  });
});
