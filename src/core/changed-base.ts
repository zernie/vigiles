/**
 * Bare `vigiles test --changed`: the base to compare against, decided from
 * facts the host gathered. Pure; the env, the event file and git are read in
 * `src/host/changed-files.io.ts`.
 *
 * The shape follows Turborepo's `--affected`: on GitHub Actions a pull request
 * diffs against its base, any other event runs everything, and a local run
 * diffs against the default branch. 🔴 WHEN NOTHING RESOLVES, EVERYTHING RUNS,
 * and the run says why. A guessed base can only narrow, and a narrow nobody
 * asked for is the silent skip this whole feature exists to avoid.
 */
import { z } from "zod";

/** Where the run is, as the host saw it. */
export type CiFacts =
  | {
      readonly provider: "github";
      /** `GITHUB_EVENT_NAME`. */
      readonly event: string | undefined;
      /** `pull_request.base.sha` from the event payload. */
      readonly prBase: string | undefined;
      /** `GITHUB_BASE_REF`: the base BRANCH of a pull request. */
      readonly baseRef: string | undefined;
    }
  | { readonly provider: "other" }
  | { readonly provider: "none" };

export interface BaseFacts {
  readonly ci: CiFacts;
  /** The first of origin/HEAD, origin/main, origin/master that exists locally. */
  readonly defaultBranch: string | undefined;
}

export type BaseDecision =
  | {
      readonly kind: "diff";
      readonly ref: string;
      /** What to `git fetch` from origin when `ref` is not in the clone. */
      readonly fetch: string | undefined;
      readonly why: string;
    }
  | { readonly kind: "all"; readonly why: string };

const PR_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "pull_request_target",
]);

/** The base to diff against, or why every file runs. */
export function decideBase(f: BaseFacts): BaseDecision {
  switch (f.ci.provider) {
    case "github":
      return githubBase(f.ci);
    case "other":
      return {
        kind: "all",
        why: "a CI run with no known pull-request base, so every file runs",
      };
    case "none":
      return f.defaultBranch === undefined
        ? {
            kind: "all",
            why: "no default branch found (origin/HEAD, origin/main, origin/master), so every file runs",
          }
        : {
            kind: "diff",
            ref: f.defaultBranch,
            fetch: undefined,
            why: `merge-base with ${f.defaultBranch}, the default branch`,
          };
  }
}

function githubBase(
  ci: Extract<CiFacts, { provider: "github" }>,
): BaseDecision {
  const event = ci.event ?? "unknown";
  if (!PR_EVENTS.has(event)) {
    return {
      kind: "all",
      why: `${event} event: not a pull request, so every file runs`,
    };
  }
  return prBase(event, ci.prBase, ci.baseRef);
}

/** A pull request's base: the payload's sha, else the base branch, else none. */
function prBase(
  event: string,
  sha: string | undefined,
  branch: string | undefined,
): BaseDecision {
  if (sha !== undefined) {
    const why = `${event} base ${sha} from the event payload`;
    return { kind: "diff", ref: sha, fetch: sha, why };
  }
  if (branch === undefined || branch === "") {
    return {
      kind: "all",
      why: `${event} event with no base in the payload or GITHUB_BASE_REF, so every file runs`,
    };
  }
  return {
    kind: "diff",
    ref: `origin/${branch}`,
    fetch: `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    why: `${event} base branch ${branch} (GITHUB_BASE_REF)`,
  };
}

const prEvent = z.object({
  pull_request: z.object({ base: z.object({ sha: z.string() }) }),
});

/** `pull_request.base.sha` of a parsed event payload, or undefined for any other shape. */
export function prBaseFromEvent(payload: unknown): string | undefined {
  const parsed = prEvent.safeParse(payload);
  return parsed.success ? parsed.data.pull_request.base.sha : undefined;
}
