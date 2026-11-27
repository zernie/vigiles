/**
 * The verdict over a regression case's three controls: the world must fail
 * the oracle (red), the fix must pass it (gold), and the fix plus a test edit
 * must be caught as a test edit (gold + test edit). Each refusal is planted
 * once, and a healthy case qualifies.
 */
import { describe, expect, it } from "vitest";
import { controlVerdict, type ControlOutcomes } from "./case-controls.js";
import type { ScoringRun, TreeOutcome } from "./case-scoring.js";

const OK: ScoringRun = { kind: "exited", code: 0 };
const FAIL: ScoringRun = { kind: "exited", code: 1 };
const ORACLE = ["src/a.test.ts", "src/b.test.ts"];

const ran = (
  tests: readonly ScoringRun[],
  build: ScoringRun | undefined = OK,
): TreeOutcome => ({
  kind: "ran",
  build,
  tests,
  droppedEdits: 0,
  ignoredNewFiles: 0,
});
const RED = ran([FAIL]);
const GOLD = ran([OK, OK]);
const EDITED: TreeOutcome = {
  kind: "edited-tests",
  droppedEdits: 0,
  ignoredNewFiles: 0,
};

const outcomes = (o: Partial<ControlOutcomes>): ControlOutcomes => ({
  red: [RED, RED],
  gold: [GOLD, GOLD],
  goldEdit: [EDITED, EDITED],
  ...o,
});

describe("controlVerdict", () => {
  it("qualifies a case whose world fails and whose fix passes", () => {
    // Guards: silent on correct — a healthy case is never refused.
    expect(controlVerdict(outcomes({}), ORACLE)).toEqual({
      kind: "qualified",
      red: [false, false],
      gold: [true, true],
      goldEdit: [false, false],
    });
  });
});

describe("controlVerdict on the red control", () => {
  it("refuses a world whose build fails as outdated", () => {
    // Guards: a build broken by the revert is not a bug the agent can fix.
    expect(
      controlVerdict(outcomes({ red: [ran([], FAIL), RED] }), ORACLE),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "outdated",
        why: "build-fails-after-revert",
        exitCode: 1,
      },
    });
  });

  it("names exit 127 for a build that never started", () => {
    const notStarted = ran([], { kind: "not-started", detail: "ENOENT" });
    // Guards: a missing build tool reads as the shell's "not found" code.
    expect(
      controlVerdict(outcomes({ red: [notStarted, notStarted] }), ORACLE),
    ).toMatchObject({ refusal: { exitCode: 127 } });
  });

  it("names exit 128 for a build killed by a signal", () => {
    const killed = ran([], { kind: "signalled", signal: "SIGKILL" });
    // Guards: a crashed build still refuses, with the shell's signal code.
    expect(
      controlVerdict(outcomes({ red: [killed, killed] }), ORACLE),
    ).toMatchObject({ refusal: { exitCode: 128 } });
  });

  it("refuses a world that already passes the oracle", () => {
    // Guards: an oracle that passes without the fix can only score solved for free.
    expect(controlVerdict(outcomes({ red: [GOLD, GOLD] }), ORACLE)).toEqual({
      kind: "refused",
      refusal: {
        kind: "outdated",
        why: "oracle-passes-without-fix",
        paths: ORACLE,
      },
    });
  });

  it("refuses a red control that disagrees with itself as flaky", () => {
    // Guards: a flaky oracle turns noise into a solve rate.
    expect(controlVerdict(outcomes({ red: [RED, GOLD] }), ORACLE)).toEqual({
      kind: "refused",
      refusal: { kind: "oracle-flaky", red: [false, true], gold: [true, true] },
    });
  });
});

describe("controlVerdict on the gold control", () => {
  it("refuses a gold control that disagrees with itself as flaky", () => {
    // Guards: the same, on the fix's side.
    expect(
      controlVerdict(outcomes({ gold: [GOLD, RED] }), ORACLE),
    ).toMatchObject({ refusal: { kind: "oracle-flaky" } });
  });

  it("refuses a fix that fails its own oracle under scoring", () => {
    // Guards: if the fix cannot pass, no agent can, and every trial reads as a miss.
    expect(controlVerdict(outcomes({ gold: [RED, RED] }), ORACLE)).toEqual({
      kind: "refused",
      refusal: {
        kind: "fix-not-reproducible-under-scoring",
        gold: [false, false],
      },
    });
  });

  it("refuses a fix whose build fails under scoring", () => {
    // Guards: a gold build failure is the scoring env's fault, not a solve.
    expect(
      controlVerdict(
        outcomes({ gold: [ran([], FAIL), ran([], FAIL)] }),
        ORACLE,
      ),
    ).toMatchObject({
      refusal: { kind: "fix-not-reproducible-under-scoring" },
    });
  });
});

describe("controlVerdict on timeouts and faults", () => {
  it("refuses a control that hit the scoring timeout, naming it", () => {
    const late = ran([{ kind: "timed-out", ms: 600_000 }]);
    // Guards: a timeout is not a fail of the oracle; the user raises the limit.
    expect(controlVerdict(outcomes({ gold: [GOLD, late] }), ORACLE)).toEqual({
      kind: "refused",
      refusal: { kind: "scoring-timed-out", control: "gold", ms: 600_000 },
    });
  });

  it("names the build when the build is what timed out", () => {
    const late = ran([], { kind: "timed-out", ms: 5 });
    // Guards: the user is told which command to look at.
    expect(
      controlVerdict(outcomes({ red: [late, late] }), ORACLE),
    ).toMatchObject({ refusal: { control: "build", ms: 5 } });
  });

  it("reports a control left out for integrity as a fault, never a verdict", () => {
    // Guards: a vigiles-made tree that cannot be scored is a vigiles fault, not a case refusal.
    expect(
      controlVerdict(
        outcomes({ red: [{ kind: "integrity", why: "outside-link" }, RED] }),
        ORACLE,
      ),
    ).toEqual({
      kind: "fault",
      detail: "the red control was left out: outside-link",
    });
  });

  it("reports a gold run caught as a test edit as a fault", () => {
    // Guards: gold carries no test edit; catching one means the tree was built wrong.
    expect(controlVerdict(outcomes({ gold: [GOLD, EDITED] }), ORACLE)).toEqual({
      kind: "fault",
      detail: "the gold control was left out: a test edit",
    });
  });

  it("reports a test edit that was not caught as a fault", () => {
    // Guards: if the test-edit rule did not fire on a planted edit, no score is safe.
    expect(
      controlVerdict(outcomes({ goldEdit: [EDITED, GOLD] }), ORACLE),
    ).toEqual({
      kind: "fault",
      detail: "the gold + test edit control was not caught as a test edit",
    });
  });
});
