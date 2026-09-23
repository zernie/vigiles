/**
 * `scripts/check.mjs` accounts for every job in EVERY workflow — covered, or
 * declared as NOT covered with the command that does run it (or why there is none).
 *
 * EVERY WORKFLOW, NOT ci.yml (2026-09-23). The Alpine cell moved to platform.yml;
 * a test reading one file would have stopped seeing it without a sound.
 *
 * WHY THIS EXISTS. check.mjs was written so nobody would run a remembered
 * subset of CI (its own header: three PRs went red from a five-command list).
 * It then covered ONE of the workflow's jobs while reading, from its name and
 * its `18/18 passed`, like all of them — and on 2026-09-03 that cost a cycle:
 * a green `check` was taken for a green CI and the push broke the `test` job.
 *
 * A list of what-we-do-not-cover is the same hand-maintained list check.mjs
 * exists to abolish, one level up, so it is not trusted either: a NEW job in
 * ci.yml fails HERE until someone either covers it or names it, rather than
 * becoming a seventh thing that runs only in CI.
 *
 * Both files are read as TEXT. Importing check.mjs would RUN it — the module
 * body is the check run — which is the same "an import is a run" trap the KB
 * records for eval files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const checkSource = readFileSync(join(root, "scripts/check.mjs"), "utf8");

interface Workflow {
  readonly on?: { readonly pull_request?: { readonly types?: string[] } };
  readonly jobs?: Record<string, unknown>;
}

// Parsed with a YAML parser, not scanned by line — `on:` and `jobs:` are structure.
const WF_DIR = join(root, ".github", "workflows");
const workflows: Record<string, Workflow> = Object.fromEntries(
  readdirSync(WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, load(readFileSync(join(WF_DIR, f), "utf8")) as Workflow]),
);

/** Every job name, across every workflow file. */
function allJobs(wfs: Record<string, Workflow>): string[] {
  return Object.values(wfs).flatMap((wf) => Object.keys(wf.jobs ?? {}));
}

/** The `pull_request.types` a workflow listens to (empty when absent). */
function prTypes(wf: Workflow | undefined): string[] {
  return wf?.on?.pull_request?.types ?? [];
}

/**
 * The trigger invariants of the platform scheme, as one pure function so a mutation can be run
 * against a modified copy of the parsed workflows. Returns the violated invariants.
 */
function triggerViolations(wfs: Record<string, Workflow>): string[] {
  const out: string[] = [];
  if (
    JSON.stringify(prTypes(wfs["platform.yml"])) !==
    JSON.stringify(["opened", "ready_for_review"])
  )
    out.push("platform.yml must run on exactly [opened, ready_for_review]");
  for (const [f, wf] of Object.entries(wfs))
    if (prTypes(wf).includes("labeled"))
      out.push(`${f} listens to \`labeled\``);
  if (!prTypes(wfs["ci.yml"]).includes("ready_for_review"))
    out.push("ci.yml must listen to ready_for_review");
  return out;
}

/** The `job:` fields of CI_JOBS_NOT_COVERED, read from the source text. */
function declaredNotCovered(src: string): string[] {
  const block = /export const CI_JOBS_NOT_COVERED = \[([\s\S]*?)\n\];/.exec(
    src,
  );
  if (!block)
    throw new Error("check.mjs no longer declares CI_JOBS_NOT_COVERED");
  return [...block[1].matchAll(/\bjob:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("check.mjs accounts for every CI job", () => {
  const jobs = allJobs(workflows);
  const notCovered = declaredNotCovered(checkSource);

  it("finds the jobs and the declaration (neither parse silently empty)", () => {
    expect(jobs.length).toBeGreaterThan(1);
    expect(notCovered.length).toBeGreaterThan(0);
    expect(jobs).toContain("check"); // the one job check.mjs DOES run
    expect(Object.keys(workflows)).toEqual(
      expect.arrayContaining(["ci.yml", "platform.yml"]),
    );
    expect(jobs).toContain("alpine"); // platform.yml's job — the name the ruleset requires
  });

  it("every job in every workflow is either `check` or declared not-covered", () => {
    const accounted = new Set(["check", ...notCovered]);
    expect(jobs.filter((j) => !accounted.has(j))).toEqual([]);
  });

  it("declares no job that no workflow has", () => {
    expect(notCovered.filter((j) => !jobs.includes(j))).toEqual([]);
  });

  it("every not-covered entry carries a cmd field and a reason", () => {
    // Split on OBJECT boundaries, not lines: prettier wraps each entry across
    // several lines, and a line-based scan silently checked nothing.
    const block = /export const CI_JOBS_NOT_COVERED = \[([\s\S]*?)\n\];/.exec(
      checkSource,
    )![1];
    const entries = block.split("},").filter((e) => e.includes("job:"));
    expect(entries).toHaveLength(notCovered.length);
    for (const entry of entries) {
      expect(entry, `entry needs a reason: ${entry}`).toMatch(/why:\s*"[^"]+"/);
      expect(entry, `entry needs a cmd field: ${entry}`).toMatch(/cmd:\s*"/);
    }
  });

  it("prints the gap — a green run cannot read as a green CI", () => {
    expect(checkSource).toMatch(/NOT covered here/);
  });
});

// 🔴 THE PLATFORM TRIGGER: once per PR, never per push (see platform.yml's header). With
// `synchronize` the job runs on every push; with a label it re-fires on every push AND a foreign
// label can satisfy the required check by skipping; without `ready_for_review` in ci.yml, marking
// a draft ready runs nothing.
describe("platform trigger invariants", () => {
  it("hold on the real workflows", () => {
    expect(triggerViolations(workflows)).toEqual([]);
  });

  // Both halves of each invariant: the check must FAIL on the shape it forbids.
  it("fail when platform.yml also listens to synchronize", () => {
    const bad = structuredClone(workflows);
    bad["platform.yml"].on!.pull_request!.types!.push("synchronize");
    expect(triggerViolations(bad)).toContain(
      "platform.yml must run on exactly [opened, ready_for_review]",
    );
  });

  it("fail when any workflow listens to labeled", () => {
    const bad = structuredClone(workflows);
    bad["ci.yml"].on!.pull_request!.types!.push("labeled");
    expect(triggerViolations(bad)).toContain("ci.yml listens to `labeled`");
  });

  it("fail when ci.yml stops listening to ready_for_review", () => {
    const bad = structuredClone(workflows);
    const t = bad["ci.yml"].on!.pull_request!.types!;
    t.splice(t.indexOf("ready_for_review"), 1);
    expect(triggerViolations(bad)).toContain(
      "ci.yml must listen to ready_for_review",
    );
  });
});
