import { describe, expect, it } from "vitest";

import { exempted, limitFor, nextCeilings } from "./lint-ceilings.mjs";

describe("nextCeilings", () => {
  const current = { "src/adapter-conformance.ts": { complexity: 24 } };

  it("lowers a ceiling to what is measured now", () => {
    const measured = { "src/adapter-conformance.ts": { complexity: 20 } };
    expect(nextCeilings(current, measured, { init: false })).toEqual({
      "src/adapter-conformance.ts": { complexity: 20 },
    });
  });

  it("never raises one: growth past the ceiling is ESLint's error to report", () => {
    const measured = { "src/adapter-conformance.ts": { complexity: 31 } };
    expect(nextCeilings(current, measured, { init: false })).toEqual(current);
  });

  it("drops a file once its functions are under the shared limit", () => {
    const measured = { "src/adapter-conformance.ts": { complexity: 10 } };
    expect(nextCeilings(current, measured, { init: false })).toEqual({});
  });

  it("adds no new file outside --init, so a new file cannot buy itself a ceiling", () => {
    const measured = {
      "src/adapter-conformance.ts": { complexity: 24 },
      "src/new-file.ts": { complexity: 40 },
    };
    expect(nextCeilings(current, measured, { init: false })).toEqual(current);
  });

  it("with --init, records every file over a limit and nothing under it", () => {
    const measured = {
      "src/scan.ts": { "max-params": 6, complexity: 9 },
      "src/action-gate.ts": { complexity: 7 },
    };
    expect(nextCeilings({}, measured, { init: true })).toEqual({
      "src/scan.ts": { "max-params": 6 },
    });
  });

  it("holds tests to sixty lines a function, not thirty", () => {
    const measured = {
      "src/scan.test.ts": { "max-lines-per-function": 55 },
      "src/scan.ts": { "max-lines-per-function": 55 },
    };
    expect(nextCeilings({}, measured, { init: true })).toEqual({
      "src/scan.ts": { "max-lines-per-function": 55 },
    });
    expect(limitFor("src/scan.test.ts", "max-lines-per-function")).toBe(60);
  });
});

describe("exempted", () => {
  it("a disable-next-line comment covers the next line only", () => {
    const directives = [
      { type: "disable-next-line", value: "max-params", line: 6 },
    ];
    expect(exempted(directives, "max-params", 7)).toBe(true);
    expect(exempted(directives, "max-params", 8)).toBe(false);
  });

  it("a block disable covers everything until its enable", () => {
    // src/posix-path.ts: a verbatim port of Node's path.js, exempt on purpose.
    const directives = [
      { type: "disable", value: "complexity, max-depth", line: 22 },
      { type: "enable", value: "complexity, max-depth", line: 400 },
    ];
    expect(exempted(directives, "max-depth", 120)).toBe(true);
    expect(exempted(directives, "max-depth", 401)).toBe(false);
  });

  it("names the rule exactly: another rule's exemption does not count", () => {
    const directives = [{ type: "disable-line", value: "complexity", line: 9 }];
    expect(exempted(directives, "sonarjs/cognitive-complexity", 9)).toBe(false);
  });

  it("a bare eslint-disable covers every rule", () => {
    const directives = [{ type: "disable", value: "", line: 1 }];
    expect(exempted(directives, "max-nested-callbacks", 50)).toBe(true);
  });
});
