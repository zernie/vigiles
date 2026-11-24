/**
 * The checks over what a hook or script run DID beyond its decision: did its
 * text reach the model, where did it try to connect. They were throwing
 * assertions (`assertDelivered`, `assertEgressOnly`); as checks they evaluate
 * inside `assertChecks`, `toPass` and a scored `measure`, like every other
 * assertion about a run. Reached as `check.delivered()`,
 * `check.egress({ only: […] })` (src/check.ts). What a run WROTE is `check.writes`,
 * in src/check.ts, because it reads an agent run too.
 *
 * Each reads a field the run result already carries (`delivery`, `egress`),
 * so the target type names only that field: a `runHook` result and a
 * `runScript` result both fit where they carry it.
 */
import type { CheckResult, Check } from "./check.js";
import type { HookRunResult, EgressAttempt } from "./run-hook.js";

const ok = (message: string): CheckResult => ({
  pass: true,
  score: 1,
  message,
});
const no = (message: string): CheckResult => ({
  pass: false,
  score: 0,
  message,
});

/** A run result that carries a delivery verdict (a `runHook` result). */
type HasDelivery = Pick<
  HookRunResult,
  "delivery" | "exitCode" | "ran" | "conditionReason"
>;

/**
 * The hook's text REACHED THE MODEL — the check a nudge test needs, because
 * "the hook printed it" is not "the model received it". Passes only on the
 * `delivered` verdict; each other one fails with its own cause, since the five
 * are different facts and a red test must name the right one:
 * - `undelivered` — text went to a stream this event does not deliver (stderr at
 *   exit 0 on `PostToolUse`, measured). Names the stream, the bytes, the cure.
 * - `silent` — nothing addressed to the model, or the hook never ran.
 * - `blocked` — a veto, which is not a nudge; check that with `check.hook(event, { blocked: true })`.
 * - `unknown` — the event has no row in the harness's capability table, so
 *   delivery cannot be judged. FAILS rather than passes (`no-silent-skips`).
 */
export function delivered(): Check<HasDelivery> {
  return {
    kind: "delivered",
    eval: (r) => deliveryVerdict(r),
    toJSON: () => ({ kind: "delivered" }),
  };
}

function deliveryVerdict(r: HasDelivery): CheckResult {
  const d = r.delivery;
  switch (d.kind) {
    case "delivered":
      return ok(`the hook's output reached the model (${d.via.join(", ")})`);
    case "undelivered":
      return no(
        `expected the hook's output to reach the model, but none did (exit ${String(r.exitCode)}):\n` +
          d.stranded
            .map((s) => `  - ${String(s.bytes)} bytes on ${s.stream}: ${s.why}`)
            .join("\n"),
      );
    case "silent":
      return no(
        r.ran
          ? `expected the hook's output to reach the model, but it printed nothing addressed to the model (exit ${String(r.exitCode)})`
          : `expected the hook's output to reach the model, but the hook never ran: ${r.conditionReason}`,
      );
    case "blocked":
      return no(
        `expected a delivered nudge, but the hook BLOCKED the action (exit ${String(r.exitCode)}) — a block is not a nudge; check it with check.hook(event, { blocked: true })`,
      );
    case "unknown":
      return no(
        `delivery cannot be judged: ${d.why}. Pass the adapter's capability table as runHook's \`capabilities\` option.`,
      );
  }
}

/** Anything carrying recorded egress attempts (a `recordEgress` run). */
interface HasEgress {
  readonly egress: readonly EgressAttempt[];
}

const hostPort = (e: EgressAttempt): string => `${e.host}:${String(e.port)}`;

const serializePattern = (p: string | RegExp): string =>
  typeof p === "string" ? p : String(p);

/**
 * The options of `check.egress`: `only` the hosts every attempt must go to, or
 * `none: true` for no egress at all (the same as `only: []`).
 *
 * @public
 */
export type EgressOptions =
  | { readonly only: ReadonlyArray<string | RegExp> }
  | { readonly none: true };

/**
 * `check.egress`: what the run reached over the network. With `only`, every
 * egress attempt went to an allowed host — a host (exact string or RegExp) or a
 * `host:port`; with `none: true` (or `only: []`), there was no egress at all.
 * The failure names every offender — exfil / unexpected-registry detection.
 * The constraint is an option, as in `check.writes({ only, none })`.
 */
export function egress(opts: EgressOptions): Check<HasEgress> {
  const allowed = "only" in opts ? opts.only : [];
  const allows = (e: EgressAttempt): boolean =>
    allowed.some((a) =>
      typeof a === "string"
        ? a === e.host || a === hostPort(e)
        : a.test(e.host) || a.test(hostPort(e)),
    );
  return {
    kind: "egress",
    eval: (r) => {
      const bad = r.egress.filter((e) => !allows(e));
      if (bad.length === 0) {
        return ok(
          allowed.length === 0
            ? "no egress attempted"
            : "every egress attempt was allowlisted",
        );
      }
      return no(
        `egress to non-allowlisted host(s): ${bad.map(hostPort).join(", ")}`,
      );
    },
    toJSON: () => ({
      kind: "egress",
      only: allowed.map(serializePattern),
    }),
  };
}
