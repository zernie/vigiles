import { describe, expect, it } from "vitest";

import {
  growthReasons,
  suppressionGrowth,
  touchedFiles,
} from "./suppressions-shrink.mjs";

const base = {
  "src/a.ts": { complexity: { count: 3 }, "max-params": { count: 1 } },
  "src/b.ts": { "max-lines": { count: 1 } },
};

describe("suppressionGrowth", () => {
  it("is empty when every count stayed or fell", () => {
    const head = {
      "src/a.ts": { complexity: { count: 2 }, "max-params": { count: 1 } },
    };
    expect(suppressionGrowth(base, head)).toEqual([]);
  });

  it("reports a count that rose, with both sides", () => {
    const head = { ...base, "src/a.ts": { complexity: { count: 4 } } };
    expect(suppressionGrowth(base, head)).toEqual([
      { file: "src/a.ts", rule: "complexity", before: 3, after: 4 },
    ]);
  });

  it("counts a file or rule new at head from zero", () => {
    const head = {
      ...base,
      "src/b.ts": { "max-lines": { count: 1 }, "max-depth": { count: 2 } },
      "src/moved.ts": { complexity: { count: 1 } },
    };
    expect(suppressionGrowth(base, head)).toEqual([
      { file: "src/b.ts", rule: "max-depth", before: 0, after: 2 },
      { file: "src/moved.ts", rule: "complexity", before: 0, after: 1 },
    ]);
  });
});

describe("touchedFiles", () => {
  it("totals each touched file that has suppressions, and skips the rest", () => {
    const head = { "src/a.ts": { complexity: { count: 1 } } };
    const touched = ["src/a.ts", "src/b.ts", "src/clean.ts"];
    expect(touchedFiles(base, head, touched)).toEqual([
      { file: "src/a.ts", before: 4, after: 1 },
      { file: "src/b.ts", before: 1, after: 0 },
    ]);
  });
});

describe("growthReasons", () => {
  it("keeps the non-empty trailer values, trimmed", () => {
    const log = "new rule: max-statements\n\n  \n  file moved  \n";
    expect(growthReasons(log)).toEqual([
      "new rule: max-statements",
      "file moved",
    ]);
  });

  it("is empty when no commit carries the trailer", () => {
    expect(growthReasons("\n\n")).toEqual([]);
  });
});
