/**
 * When the CLI colours: the two conventions other CLIs honour, in their order,
 * and that colour adds escapes without changing the text.
 */
import { describe, it, expect } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { colourEnabled, terminalPaint } from "./term-colour.js";

describe("colourEnabled", () => {
  it.each([
    // [isTTY, env, expected]
    [true, {}, true],
    [false, {}, false],
    [true, { TERM: "dumb" }, false],
    [true, { NO_COLOR: "1" }, false],
    [true, { NO_COLOR: "" }, true],
    [false, { FORCE_COLOR: "1" }, true],
    [true, { FORCE_COLOR: "0" }, false],
    [false, { NO_COLOR: "1", FORCE_COLOR: "1" }, false],
  ] as const)("isTTY=%s env=%j → %s", (isTTY, env, expected) => {
    expect(colourEnabled(isTTY, env)).toBe(expected);
  });
});

describe("terminalPaint", () => {
  it("with colour off, returns the text untouched", () => {
    expect(terminalPaint(false, {})("bad", "x")).toBe("x");
  });

  it("with colour on, adds escapes and nothing else", () => {
    const painted = terminalPaint(false, { FORCE_COLOR: "1" })("bad", "x");
    expect(painted).not.toBe("x");
    expect(stripVTControlCharacters(painted)).toBe("x");
  });
});
