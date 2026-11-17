/**
 * Bare `vigiles test --changed`: which base a run compares against, decided
 * from facts the host gathered (the CI provider, the event, its payload, the
 * default branch). The rule it holds: NOTHING RESOLVABLE MEANS EVERYTHING RUNS,
 * said out loud — a guessed base that narrows silently is the failure.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { decideBase, prBaseFromEvent } from "./changed-base.js";

describe("decideBase — on GitHub Actions", () => {
  test("a pull_request diffs against the base sha from the event payload, fetched if missing", () => {
    const d = decideBase({
      ci: {
        provider: "github",
        event: "pull_request",
        prBase: "abc123",
        baseRef: "main",
      },
      defaultBranch: undefined,
    });
    assert.equal(d.kind, "diff");
    assert.equal(d.kind === "diff" && d.ref, "abc123");
    assert.equal(d.kind === "diff" && d.fetch, "abc123");
    assert.match(d.why, /pull_request.*abc123/);
  });

  test("with no sha in the payload, GITHUB_BASE_REF names the branch to fetch", () => {
    const d = decideBase({
      ci: {
        provider: "github",
        event: "pull_request",
        prBase: undefined,
        baseRef: "main",
      },
      defaultBranch: undefined,
    });
    assert.deepEqual(d.kind === "diff" && { ref: d.ref, fetch: d.fetch }, {
      ref: "origin/main",
      fetch: "+refs/heads/main:refs/remotes/origin/main",
    });
  });

  test("a push runs everything and says why", () => {
    const d = decideBase({
      ci: {
        provider: "github",
        event: "push",
        prBase: undefined,
        baseRef: undefined,
      },
      defaultBranch: "origin/main",
    });
    assert.equal(d.kind, "all");
    assert.match(d.why, /push.*not a pull request/);
  });

  test("a pull_request with no base at all runs everything", () => {
    const d = decideBase({
      ci: {
        provider: "github",
        event: "pull_request",
        prBase: undefined,
        baseRef: undefined,
      },
      defaultBranch: "origin/main",
    });
    assert.equal(d.kind, "all");
  });
});

describe("decideBase — elsewhere", () => {
  test("locally: the merge-base with the default branch, named", () => {
    const d = decideBase({
      ci: { provider: "none" },
      defaultBranch: "origin/HEAD",
    });
    assert.deepEqual(d.kind === "diff" && { ref: d.ref, fetch: d.fetch }, {
      ref: "origin/HEAD",
      fetch: undefined,
    });
    assert.match(d.why, /origin\/HEAD/);
  });

  test("locally with no default branch: everything runs, loudly", () => {
    const d = decideBase({
      ci: { provider: "none" },
      defaultBranch: undefined,
    });
    assert.equal(d.kind, "all");
    assert.match(d.why, /no default branch/);
  });

  test("another CI: no known pull-request base, so everything runs", () => {
    const d = decideBase({
      ci: { provider: "other" },
      defaultBranch: "origin/main",
    });
    assert.equal(d.kind, "all");
  });
});

describe("prBaseFromEvent", () => {
  test("reads pull_request.base.sha, and nothing from another shape", () => {
    assert.equal(
      prBaseFromEvent({ pull_request: { base: { sha: "abc123" } } }),
      "abc123",
    );
    assert.equal(prBaseFromEvent({ ref: "refs/heads/main" }), undefined);
    assert.equal(prBaseFromEvent("not json"), undefined);
  });
});
