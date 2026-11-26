/** Every refusal kind renders to one line naming its payload; the sample table is typed over every kind. */
import { describe, expect, it } from "vitest";
import {
  describeRegressionCaseRefusal,
  type RegressionCaseRefusal,
} from "./regression-case-refusal.js";

type Kind = RegressionCaseRefusal["kind"];

/** One sample per kind; each payload value is a marker the line must carry. */
const SAMPLES: {
  readonly [K in Kind]: readonly Extract<RegressionCaseRefusal, { kind: K }>[];
} = {
  "head-not-a-commit": [{ kind: "head-not-a-commit", head: "MARK-head" }],
  "commit-not-in-history": [{ kind: "commit-not-in-history" }],
  "merge-commit": [{ kind: "merge-commit", parents: 3 }],
  "commit-not-ancestor-of-head": [
    { kind: "commit-not-ancestor-of-head", head: "MARK-head" },
  ],
  "agent-binary-missing": [
    { kind: "agent-binary-missing", binary: "MARK-bin" },
  ],
  "no-test-in-fix": [{ kind: "no-test-in-fix" }],
  "fix-touches-only-tests": [{ kind: "fix-touches-only-tests" }],
  "oracle-missing-in-world": [
    { kind: "oracle-missing-in-world", paths: ["MARK-a", "MARK-b"] },
  ],
  "fix-outside-source": [{ kind: "fix-outside-source", paths: ["MARK-a"] }],
  "revert-touches-manifest": [
    { kind: "revert-touches-manifest", paths: ["MARK-a"] },
  ],
  "deps-unsupported": [
    { kind: "deps-unsupported", why: "no-node-modules" },
    { kind: "deps-unsupported", why: "no-lockfile" },
  ],
  "host-install-not-at-head": [
    { kind: "host-install-not-at-head", lockfile: "MARK-lock" },
  ],
  "deps-link-outside-world": [
    { kind: "deps-link-outside-world", links: ["MARK-link"] },
  ],
  "symptom-not-committed": [{ kind: "symptom-not-committed", path: "MARK-s" }],
  "symptom-uncommitted-changes": [
    { kind: "symptom-uncommitted-changes", path: "MARK-s" },
  ],
  "symptom-not-a-file": [{ kind: "symptom-not-a-file", path: "MARK-s" }],
  "symptom-path-escapes": [{ kind: "symptom-path-escapes", path: "MARK-s" }],
  outdated: [
    {
      kind: "outdated",
      why: "revert-conflict",
      files: [{ path: "MARK-f1" }, { path: "MARK-f2" }],
    },
    { kind: "outdated", why: "build-fails-after-revert", exitCode: 97 },
    { kind: "outdated", why: "oracle-passes-without-fix", paths: ["MARK-o"] },
  ],
  "oracle-flaky": [{ kind: "oracle-flaky", red: [true, false], gold: [true] }],
  "fix-not-reproducible-under-scoring": [
    { kind: "fix-not-reproducible-under-scoring", gold: [false, false] },
  ],
  "scoring-timed-out": [
    { kind: "scoring-timed-out", control: "gold-edit", ms: 4321 },
  ],
};

const all: readonly RegressionCaseRefusal[] = Object.values(SAMPLES).flat();

/** The values a line must name: every `MARK-` string and every number in the payload. */
function markers(v: unknown): readonly string[] {
  if (typeof v === "string") return v.startsWith("MARK-") ? [v] : [];
  if (typeof v === "number") return [String(v)];
  if (typeof v !== "object" || v === null) return [];
  return Object.values(v).flatMap(markers);
}

/** The payload values a refusal's line leaves out, as `<kind>: <value>`. */
function unnamed(r: RegressionCaseRefusal): readonly string[] {
  const line = describeRegressionCaseRefusal(r);
  return markers(r)
    .filter((m) => !line.includes(m))
    .map((m) => `${r.kind}: ${m}`);
}

describe("describeRegressionCaseRefusal", () => {
  it("renders every kind to one non-empty line", () => {
    const lines = all.map(describeRegressionCaseRefusal);
    // Guards: the "one line per refusal" contract (no newline, never empty).
    expect(lines.filter((l) => l.length === 0 || l.includes("\n"))).toEqual([]);
    // Guards: two different refusals never read the same.
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("names the payload of each refusal in its line", () => {
    const missing = all.flatMap(unnamed);
    // Guards: a line names what to change (the path, commit, lockfile, exit code, control).
    expect(missing).toEqual([]);
  });

  it("counts passing runs in the flaky and the gold lines", () => {
    // Guards: [true, false] is read as 1 of 2 runs passing, not as a raw list.
    expect(
      describeRegressionCaseRefusal({
        kind: "oracle-flaky",
        red: [true, false],
        gold: [true],
      }),
    ).toContain("1/2");
  });
});
