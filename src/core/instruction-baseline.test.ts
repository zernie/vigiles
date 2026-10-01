/**
 * The instruction-weight RATCHET (vitest, unit tier, nothing spawned).
 *
 * The load-bearing case is the same evasion `instruction-weight.test.ts` is
 * built around, asked one level up: a regrowth that hides in a sibling file the
 * harness also loads must still read as growth against the baseline, and a
 * "cut" that only relocates text must not read as a shrink.
 */
import { describe, it, expect } from "vitest";
import {
  compareToBaseline,
  entryFor,
  formatVerdict,
  INSTRUCTION_WEIGHT_MEASURE,
  parseInstructionBaseline,
  recordEntries,
  serializeBaseline,
  type InstructionBaseline,
} from "./instruction-baseline.js";
import { weighInstructions } from "./instruction-weight.js";
import { claudeCodeLayout } from "../adapters/claude-code/layout.js";
import { claudeCodeDialect } from "../adapters/claude-code/dialect.js";
import { codexLayout } from "../adapters/codex/layout.js";
import { codexDialect } from "../adapters/codex/dialect.js";

const cc = claudeCodeDialect.instructionBudget;
const codex = codexDialect.instructionBudget;
if (!cc || !codex) throw new Error("fixture precondition: both budgets exist");

const weighCc = (files: Record<string, string>) =>
  weighInstructions(claudeCodeLayout.instructionChain(files), files, cc);

const BODY = "x".repeat(30_000);

describe("compareToBaseline — the verdicts", () => {
  const recorded = entryFor(weighCc({ "CLAUDE.md": BODY }));

  it("no baseline → unrecorded, carrying what WOULD be recorded", () => {
    const v = compareToBaseline(weighCc({ "CLAUDE.md": BODY }), undefined);
    expect(v.kind).toBe("unrecorded");
    if (v.kind === "unrecorded") expect(v.current.total).toBe(30_000);
  });

  it("equal weight → held", () => {
    const v = compareToBaseline(weighCc({ "CLAUDE.md": BODY }), recorded);
    expect(v).toEqual({ kind: "held", total: 30_000, unit: "chars" });
  });

  it("growth → grew, with the delta and the file that grew", () => {
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": `${BODY}${"y".repeat(1_225)}` }),
      recorded,
    );
    expect(v.kind).toBe("grew");
    if (v.kind !== "grew") return;
    expect(v.from).toBe(30_000);
    expect(v.to).toBe(31_225);
    expect(v.changes).toEqual([
      { path: "CLAUDE.md", from: 30_000, to: 31_225 },
    ]);
  });

  it("shrink → shrank (stale baseline), naming the file", () => {
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": BODY.slice(0, 20_000) }),
      recorded,
    );
    expect(v.kind).toBe("shrank");
    if (v.kind !== "shrank") return;
    expect(v.to - v.from).toBe(-10_000);
  });

  it("a different unit (the repo moved harness) → unit-changed, never a numeric verdict", () => {
    const codexWeight = weighInstructions(
      codexLayout.instructionChain({ "AGENTS.md": BODY }),
      { "AGENTS.md": BODY },
      codex,
    );
    const v = compareToBaseline(codexWeight, recorded);
    expect(v).toEqual({
      kind: "unit-changed",
      recorded: "chars",
      current: "bytes",
    });
  });
});

describe("the SUM is compared, not a file", () => {
  it("moving text from the root into an always-loaded rules file does NOT shrink", () => {
    // The original evasion. Per file, CLAUDE.md lost two thirds; the request
    // carries exactly as much as before.
    const moved = weighCc({
      "CLAUDE.md": BODY.slice(0, 10_000),
      ".claude/rules/engineering.md": BODY.slice(10_000),
    });
    const v = compareToBaseline(
      moved,
      entryFor(weighCc({ "CLAUDE.md": BODY })),
    );
    expect(v.kind).toBe("held");
  });

  it("regrowth hidden in a NEW rules file is growth, and the message names it", () => {
    const v = compareToBaseline(
      weighCc({
        "CLAUDE.md": BODY,
        ".claude/rules/new.md": "z".repeat(500),
      }),
      entryFor(weighCc({ "CLAUDE.md": BODY })),
    );
    expect(v.kind).toBe("grew");
    if (v.kind !== "grew") return;
    expect(v.changes).toEqual([
      { path: ".claude/rules/new.md", from: null, to: 500 },
    ]);
    expect(formatVerdict(v, ".")).toMatch(
      /\.claude\/rules\/new\.md \+500 \(new\)/,
    );
  });

  it("a file excluded by committed `claudeMdExcludes` does not count", () => {
    const base = entryFor(weighCc({ "CLAUDE.md": BODY }));
    const v = compareToBaseline(
      weighCc({
        "CLAUDE.md": BODY,
        ".claude/rules/vendor.md": "v".repeat(5_000),
        ".claude/settings.json": JSON.stringify({
          claudeMdExcludes: ["**/vendor.md"],
        }),
      }),
      base,
    );
    expect(v.kind).toBe("held");
  });

  it("a `paths:`-scoped rule (loaded on demand) does not count", () => {
    const base = entryFor(weighCc({ "CLAUDE.md": BODY }));
    const v = compareToBaseline(
      weighCc({
        "CLAUDE.md": BODY,
        ".claude/rules/ts.md": `---\npaths: ["src/**/*.ts"]\n---\n${"t".repeat(4_000)}`,
      }),
      base,
    );
    expect(v.kind).toBe("held");
  });

  it("a per-machine CLAUDE.local.md does not move the committed number", () => {
    const base = entryFor(weighCc({ "CLAUDE.md": BODY }));
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": BODY, "CLAUDE.local.md": "l".repeat(9_000) }),
      base,
    );
    expect(v.kind).toBe("held");
  });
});

describe("line endings do not move the number", () => {
  it("a CRLF checkout of the same text weighs what the LF one does", () => {
    const lf = Array.from(
      { length: 1_000 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const crlf = lf.replaceAll("\n", "\r\n");
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": crlf }),
      entryFor(weighCc({ "CLAUDE.md": lf })),
    );
    expect(v.kind).toBe("held");
  });
});

describe("a baseline recorded by a different measurement", () => {
  it("is its own verdict, never grew/shrank", () => {
    const recorded = {
      ...entryFor(weighCc({ "CLAUDE.md": BODY })),
      measure: INSTRUCTION_WEIGHT_MEASURE - 1,
    };
    const v = compareToBaseline(weighCc({ "CLAUDE.md": `${BODY}y` }), recorded);
    expect(v).toEqual({
      kind: "measure-changed",
      recorded: INSTRUCTION_WEIGHT_MEASURE - 1,
      current: INSTRUCTION_WEIGHT_MEASURE,
    });
    expect(formatVerdict(v, ".")).toContain("vigiles lint --update-baseline");
  });

  it("a recorded entry carries the current measurement", () => {
    expect(entryFor(weighCc({ "CLAUDE.md": BODY })).measure).toBe(
      INSTRUCTION_WEIGHT_MEASURE,
    );
  });
});

describe("the file format", () => {
  it("records only committed files, so two clones of one commit write the same file", () => {
    const e = entryFor(
      weighCc({ "CLAUDE.md": BODY, "CLAUDE.local.md": "l".repeat(9_000) }),
    );
    expect(e).toEqual({
      unit: "chars",
      measure: INSTRUCTION_WEIGHT_MEASURE,
      total: 30_000,
      files: { "CLAUDE.md": 30_000 },
    });
  });

  it("round-trips, with sorted keys and no timestamp (a diff shows only real movement)", () => {
    const b = recordEntries(undefined, [
      [
        ".",
        entryFor(weighCc({ "CLAUDE.md": BODY, ".claude/rules/a.md": "aa" })),
      ],
    ]);
    const text = serializeBaseline(b);
    expect(text).toBe(
      `${JSON.stringify(
        {
          version: 1,
          bundles: {
            ".": {
              unit: "chars",
              measure: INSTRUCTION_WEIGHT_MEASURE,
              total: 30_002,
              files: { ".claude/rules/a.md": 2, "CLAUDE.md": 30_000 },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const parsed = parseInstructionBaseline(text);
    expect(parsed).toEqual({ kind: "ok", baseline: b });
  });

  it("recording keeps the bundles this run did not measure", () => {
    const prev: InstructionBaseline = {
      version: 1,
      bundles: {
        "plugins/a": {
          unit: "chars",
          measure: 1,
          total: 1,
          files: { "CLAUDE.md": 1 },
        },
      },
    };
    const next = recordEntries(prev, [
      [".", { unit: "chars", measure: 1, total: 2, files: { "CLAUDE.md": 2 } }],
    ]);
    expect(Object.keys(next.bundles).sort()).toEqual([".", "plugins/a"]);
  });

  it("recording `null` removes a bundle that no longer has instructions", () => {
    const prev: InstructionBaseline = {
      version: 1,
      bundles: {
        ".": { unit: "chars", measure: 1, total: 1, files: { "CLAUDE.md": 1 } },
      },
    };
    expect(recordEntries(prev, [[".", null]]).bundles).toEqual({});
  });

  it("a total that disagrees with its files is rejected — the file is hand-editable", () => {
    const r = parseInstructionBaseline(
      JSON.stringify({
        version: 1,
        bundles: {
          ".": {
            unit: "chars",
            measure: 1,
            total: 5,
            files: { "CLAUDE.md": 4 },
          },
        },
      }),
    );
    expect(r.kind).toBe("invalid");
  });

  it("unknown keys, bad JSON and a future version are rejected, never read as empty", () => {
    expect(parseInstructionBaseline("{").kind).toBe("invalid");
    expect(
      parseInstructionBaseline(
        JSON.stringify({ version: 1, bundles: {}, x: 1 }),
      ).kind,
    ).toBe("invalid");
    expect(
      parseInstructionBaseline(JSON.stringify({ version: 2, bundles: {} }))
        .kind,
    ).toBe("invalid");
  });
});

describe("formatVerdict — what the reader sees", () => {
  const recorded = entryFor(weighCc({ "CLAUDE.md": BODY }));

  it("growth names the delta, every grown file, and the one command", () => {
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": `${BODY}${"y".repeat(1_225)}` }),
      recorded,
    );
    const msg = formatVerdict(v, ".");
    expect(msg).toContain("30,000 → 31,225 chars (+1,225)");
    expect(msg).toContain("CLAUDE.md +1,225");
    expect(msg).toContain("vigiles lint --update-baseline");
  });

  it("a shrink asks for the baseline to be lowered, and says why", () => {
    const v = compareToBaseline(
      weighCc({ "CLAUDE.md": BODY.slice(0, 20_000) }),
      recorded,
    );
    const msg = formatVerdict(v, ".");
    expect(msg).toContain("30,000 → 20,000 chars (-10,000)");
    expect(msg).toContain("vigiles lint --update-baseline");
  });

  it("a nested bundle is named in the message", () => {
    const v = compareToBaseline(weighCc({ "CLAUDE.md": `${BODY}y` }), recorded);
    expect(formatVerdict(v, "plugins/a")).toMatch(/^plugins\/a: /);
  });
});
