/**
 * The baseline store, harness- and rule-agnostic: what it does to a rule's
 * findings after the rule produced them, how it records one rule without
 * touching another's entries, and what it refuses to read. The context-creep
 * rule's real runs are in each adapter's `always-loaded-lint.test.ts`; a
 * fixture rule here keeps the store's contract apart from that one user.
 */
import { describe, expect, it } from "vitest";

import {
  BASELINE_FILE,
  UPDATE_BASELINE_COMMAND,
  applyBaseline,
  hasEntries,
  parseBaselineStore,
  recordRun,
  serializeBaselineStore,
  toEntry,
  withEntries,
  type BaselineEntry,
  type Measurement,
  type RuleRun,
  type StoreOnDisk,
} from "./baseline-store.js";

const RULE = "fixture-ratchet";
const OTHER = "fixture-file-length";

const measured = (
  parts: Readonly<Record<string, number | null>>,
): Measurement => ({
  unit: "chars",
  measure: 1,
  parts: Object.fromEntries(
    Object.entries(parts).map(([k, v]) => [
      k,
      v === null ? { value: null } : { value: v, files: { [`${k}.md`]: v } },
    ]),
  ),
  value: Object.values(parts).reduce((a: number, b) => a + (b ?? 0), 0),
});

const over = (
  subject: string,
  m: Measurement,
): RuleRun["findings"][number] => ({
  subject,
  text: `${subject} is over`,
  measurement: m,
});

const runOf = (
  findings: RuleRun["findings"],
  subjects: readonly string[] = ["."],
): RuleRun => ({
  ruleId: RULE,
  findings,
  measured: subjects,
  remedy: "cut it",
});

const stored = (
  entries: Readonly<Record<string, BaselineEntry>>,
  others: Readonly<Record<string, BaselineEntry>> = {},
): StoreOnDisk => ({
  kind: "ok",
  store: {
    version: 1,
    rules: {
      [RULE]: { ...entries },
      ...(Object.keys(others).length > 0 ? { [OTHER]: { ...others } } : {}),
    },
  },
});

const entry = (parts: Readonly<Record<string, number>>): BaselineEntry =>
  toEntry(measured(parts), undefined);

describe("applying the store to a rule's findings", () => {
  it("no store at all: a finding with a measurement is a note naming the command", () => {
    const [line] = applyBaseline(runOf([over(".", measured({ a: 10 }))]), {
      kind: "absent",
    });
    expect(line?.status).toBe("note");
    expect(line?.text).toContain(UPDATE_BASELINE_COMMAND);
  });

  it("a store with only another rule's entries is still no baseline for this rule", () => {
    const store: StoreOnDisk = {
      kind: "ok",
      store: { version: 1, rules: { [OTHER]: { ".": entry({ a: 1 }) } } },
    };
    expect(
      applyBaseline(runOf([over(".", measured({ a: 10 }))]), store)[0]?.status,
    ).toBe("note");
  });

  it("a finding with no measurement is never accepted", () => {
    const lines = applyBaseline(
      runOf([{ subject: ".", text: "ceiling" }]),
      stored({ ".": entry({ a: 999 }) }),
    );
    expect(lines.map((l) => l.status)).toEqual(["finding", "note"]);
  });

  it("held, shrank and grew", () => {
    const store = stored({ ".": entry({ a: 10, b: 5 }) });
    const at = (a: number): string | undefined =>
      applyBaseline(runOf([over(".", measured({ a, b: 5 }))]), store)[0]
        ?.status;
    expect(at(10)).toBe("ok");
    expect(at(9)).toBe("finding");
    expect(at(11)).toBe("finding");
  });

  it("growth names the part and the file that moved, then the remedy", () => {
    const [line] = applyBaseline(
      runOf([over(".", measured({ a: 12, b: 5 }))]),
      stored({ ".": entry({ a: 10, b: 5 }) }),
    );
    expect(line?.text).toContain("Grew 15 → 17 chars (+2)");
    expect(line?.text).toContain("a.md (a) +2");
    expect(line?.text).toContain("a 12 (+2) · b 5");
    expect(line?.text).toContain("cut it");
  });

  it("a part this run cannot measure is carried at its stored size, not read as a cut", () => {
    const [line] = applyBaseline(
      runOf([over(".", measured({ a: 10, b: null }))]),
      stored({ ".": entry({ a: 10, b: 5 }) }),
    );
    expect(line?.status).toBe("ok");
  });
});

describe("entries the store cannot compare, or no longer needs", () => {
  it("an entry for the rule but not this subject is a finding", () => {
    const [line] = applyBaseline(
      runOf([over("pkg", measured({ a: 1 }))], [".", "pkg"]),
      stored({ ".": entry({ a: 1 }) }),
    );
    expect(line?.status).toBe("finding");
    expect(line?.text).toContain("no entry for this");
  });

  it("another unit or measure asks to re-record", () => {
    const base = entry({ a: 10 });
    const unit = applyBaseline(
      runOf([over(".", measured({ a: 10 }))]),
      stored({ ".": { ...base, unit: "bytes" } }),
    )[0];
    const measure = applyBaseline(
      runOf([over(".", measured({ a: 10 }))]),
      stored({ ".": { ...base, measure: 0 } }),
    )[0];
    expect(unit?.text).toContain("is in bytes, this harness counts chars");
    expect(measure?.text).toContain("measurement 0, this vigiles uses 1");
    expect([unit?.status, measure?.status]).toEqual(["finding", "finding"]);
  });

  it("a stored subject no finding asked for is a note: under the limit, or gone; one not looked at is silent", () => {
    const lines = applyBaseline(
      { ...runOf([], ["."]), gone: ["gone"] },
      stored({
        ".": entry({ a: 1 }),
        gone: entry({ a: 1 }),
        elsewhere: entry({ a: 1 }),
      }),
    );
    expect(lines.map((l) => [l.subject, l.status])).toEqual([
      [".", "note"],
      ["gone", "note"],
    ]);
    expect(lines[0]?.text).toContain("under the limit");
    expect(lines[1]?.text).toContain("nothing to measure any more");
  });

  it("an unreadable store is one finding, and every finding stays a finding", () => {
    const lines = applyBaseline(runOf([over(".", measured({ a: 1 }))]), {
      kind: "invalid",
      message: "not valid JSON",
    });
    expect(lines.map((l) => l.status)).toEqual(["finding", "finding"]);
    expect(lines[0]?.text).toContain(`${BASELINE_FILE} cannot be read`);
  });
});

describe("recording touches only the subjects the run measured", () => {
  it("an unmeasured subject's entry is kept byte-identical", () => {
    const other = entry({ a: 50 });
    const next = recordRun(
      stored({ ".": other, "plugins/alpha": entry({ a: 5 }) }),
      runOf([over("plugins/alpha", measured({ a: 7 }))], ["plugins/alpha"]),
    );
    expect(next?.rules[RULE]?.["."]).toEqual(other);
    expect(next?.rules[RULE]?.["plugins/alpha"]?.value).toBe(7);
  });

  it("a measured subject now under its limit is dropped, and the file stays for the rest", () => {
    const next = recordRun(
      stored({ ".": entry({ a: 50 }), "plugins/alpha": entry({ a: 5 }) }),
      runOf([], ["plugins/alpha"]),
    );
    expect(Object.keys(next?.rules[RULE] ?? {})).toEqual(["."]);
  });

  it("a subject the run found gone is dropped; one it never looked at is not", () => {
    const run: RuleRun = { ...runOf([], []), gone: ["old"] };
    const next = recordRun(
      stored({ ".": entry({ a: 1 }), old: entry({ a: 1 }) }),
      run,
    );
    expect(Object.keys(next?.rules[RULE] ?? {})).toEqual(["."]);
    expect(
      applyBaseline(
        run,
        stored({ ".": entry({ a: 1 }), old: entry({ a: 1 }) }),
      ).map((l) => l.subject),
    ).toEqual(["old"]);
  });
});

describe("recording", () => {
  it("writes exactly the findings that carry a measurement, keeping other rules", () => {
    const next = recordRun(
      stored({ old: entry({ a: 1 }) }, { "x.md": entry({ lines: 9 }) }),
      runOf(
        [
          over(".", measured({ a: 3, b: 0 })),
          { subject: ".", text: "ceiling" },
        ],
        [".", "old"],
      ),
    );
    expect(Object.keys(next?.rules[RULE] ?? {})).toEqual(["."]);
    expect(next?.rules[RULE]?.["."]?.parts).toEqual({
      a: { value: 3, files: { "a.md": 3 } },
    });
    expect(Object.keys(next?.rules[OTHER] ?? {})).toEqual(["x.md"]);
  });

  it("nothing over and nothing else stored: no file at all", () => {
    expect(recordRun(stored({ ".": entry({ a: 1 }) }), runOf([]))).toBe(
      undefined,
    );
    expect(withEntries({ kind: "absent" }, RULE, {})).toBe(undefined);
  });

  it("carries an unmeasured part from the old entry", () => {
    const next = recordRun(
      stored({ ".": entry({ a: 1, b: 7 }) }),
      runOf([over(".", measured({ a: 2, b: null }))]),
    );
    expect(next?.rules[RULE]?.["."]?.value).toBe(9);
  });

  it("round-trips through its own reader, byte-stable", () => {
    const next = recordRun(
      { kind: "absent" },
      runOf([over(".", measured({ a: 3 }))]),
    );
    if (next === undefined) throw new Error("expected a store");
    const text = serializeBaselineStore(next);
    const back = parseBaselineStore(text);
    expect(back.kind).toBe("ok");
    expect(back.kind === "ok" && serializeBaselineStore(back.store)).toBe(text);
    expect(hasEntries(back, RULE)).toBe(true);
    expect(hasEntries(back, OTHER)).toBe(false);
  });

  it("a single-number measurement records no parts", () => {
    expect(
      toEntry({ unit: "lines", measure: 1, value: 420 }, undefined),
    ).toEqual({
      direction: "shrink-only",
      unit: "lines",
      measure: 1,
      value: 420,
    });
  });
});

describe("what the reader refuses", () => {
  const valid = {
    version: 1,
    rules: { [RULE]: { ".": entry({ a: 2 }) } },
  };

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["another version", JSON.stringify({ ...valid, version: 2 }), "version"],
    [
      "a value that is not the sum of its parts",
      JSON.stringify({
        version: 1,
        rules: { [RULE]: { ".": { ...entry({ a: 2 }), value: 3 } } },
      }),
      "sum of `parts`",
    ],
    [
      "a direction it does not know",
      JSON.stringify({
        version: 1,
        rules: { [RULE]: { ".": { ...entry({ a: 2 }), direction: "grow" } } },
      }),
      "direction",
    ],
    ["an unknown key", JSON.stringify({ ...valid, extra: true }), "extra"],
  ])("%s", (_, text, message) => {
    const parsed = parseBaselineStore(text);
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.message).toContain(message);
  });
});
