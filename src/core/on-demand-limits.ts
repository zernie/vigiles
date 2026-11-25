/**
 * Is a file the harness loads ON DEMAND over the harness's own per-file cut?
 *
 * WHAT "ON DEMAND" MEANS HERE. The adapter's instruction chain already tags
 * every file that loads after launch — a folder's own instruction file (loaded
 * the first time a file in that folder is read) and a path-scoped rule (loaded
 * when a matching file is read) — with `NotLoadedReason` `on-demand`. Such a
 * file stays in context until compaction once it loads, so it is not cheap,
 * and since Claude Code 2.1.309 it is CUT past a per-file limit: the model gets
 * the start and a note to Read the rest. Measured on 2.1.332 with a 1M-window
 * model: 170,059 characters in, 150,061 delivered, ending in "Only the start
 * of this file is shown".
 *
 * WHY EVERY `on-demand` ENTRY, BY CONSTRUCTION. Before this, the chain could
 * classify a file as on-demand and nothing weighed it — the state that let a
 * 153 KB folder file go unreported. {@link onDemandEntries} reads the reason
 * through an exhaustive switch, so a new on-demand kind added to the core type
 * does not compile until this detector says what it does with it.
 *
 * WHY NO BASELINE. Over the cut, the rules after it do not reach the model.
 * Recording that size would accept lost rules, so the finding carries no
 * measurement and the baseline store passes it through as a finding.
 *
 * WHICH LIMIT. The harness publishes one cut per model window; the adapter
 * supplies the cut of the window its DEFAULT models run, so a file over it is
 * cut for every user who did not choose otherwise. A smaller window cuts
 * earlier; a repository that runs one lowers the limit in `.vigilesrc.json`,
 * as an ESLint size rule takes its threshold as an option: one rule, one
 * severity, the threshold configured. Absent on the dialect ⇒ not modelled,
 * said as such.
 *
 * Pure.
 */
import type {
  InstructionChain,
  NotLoadedReason,
  UnloadedInstruction,
} from "./instruction-chain.js";
import { sortBy } from "remeda";

import { sizeIn } from "./harness-unit.js";

/** The harness's per-file cut for files it loads after launch. */
export interface OnDemandFileLimit {
  readonly unit: "chars" | "bytes";
  /** The cut on the window the harness's default models run. */
  readonly limit: number;
  /** Where a repository tells the harness never to load a file: setting and file. */
  readonly excludeSetting: { readonly key: string; readonly file: string };
  /** The vendor artifact or measurement this was read from. */
  readonly capturedFrom: string;
}

/** When an on-demand file loads, as the chain says it. */
export type OnDemandTrigger = Extract<
  NotLoadedReason,
  { readonly kind: "on-demand" }
>["when"];

/** One file that loads on demand, with its size in the harness's unit. */
export interface OnDemandFile {
  readonly path: string;
  readonly size: number;
  readonly when: OnDemandTrigger;
}

/** What the check found: not modelled for this harness, or every file and the ones over. */
export type OnDemandCheck =
  | { readonly kind: "not-modelled" }
  | {
      readonly kind: "checked";
      readonly unit: "chars" | "bytes";
      readonly limit: number;
      readonly rule: OnDemandFileLimit;
      readonly files: readonly OnDemandFile[];
      readonly over: readonly OnDemandFile[];
    };

/** The trigger of an unloaded entry when it loads on demand, else `undefined`. */
function triggerOf(reason: NotLoadedReason): OnDemandTrigger | undefined {
  switch (reason.kind) {
    case "on-demand":
      return reason.when;
    case "replaced":
    case "excluded-by-settings":
    case "superseded":
      return undefined;
  }
}

/** Every committed entry the chain says loads on demand. */
export function onDemandEntries(
  chain: InstructionChain,
): readonly (UnloadedInstruction & { readonly when: OnDemandTrigger })[] {
  return chain.unloaded.flatMap((e) => {
    const when = triggerOf(e.reason);
    return when === undefined || e.scope !== "repo" ? [] : [{ ...e, when }];
  });
}

/** What {@link checkOnDemandFiles} weighs. */
export interface OnDemandSubject {
  /** The adapter's committed chain over the launch files plus every folder file. */
  readonly chain: InstructionChain;
  /** The text of each of those files, by path. */
  readonly files: Readonly<Record<string, string>>;
  /** The harness's cut; absent ⇒ not modelled. */
  readonly rule: OnDemandFileLimit | undefined;
  /** Replaces the harness's floor (`.vigilesrc.json`). */
  readonly limit: number | undefined;
}

/** Each on-demand file's size, heaviest first, ties by path. */
function weigh(
  chain: InstructionChain,
  files: Readonly<Record<string, string>>,
  unit: OnDemandFileLimit["unit"],
): readonly OnDemandFile[] {
  return sortBy(
    onDemandEntries(chain).flatMap((e) =>
      Object.entries(files)
        .filter(([path]) => path === e.path)
        .map(([path, text]) => ({
          path,
          size: sizeIn(text, unit),
          when: e.when,
        })),
    ),
    [(f) => f.size, "desc"],
    [(f) => f.path, "asc"],
  );
}

/** Check each on-demand file against the cut. */
export function checkOnDemandFiles(s: OnDemandSubject): OnDemandCheck {
  const { rule } = s;
  if (!rule) return { kind: "not-modelled" };
  const limit = s.limit ?? rule.limit;
  const weighed = weigh(s.chain, s.files, rule.unit);
  return {
    kind: "checked",
    unit: rule.unit,
    limit,
    rule,
    files: weighed,
    over: weighed.filter((f) => f.size > limit),
  };
}

const n = (x: number): string => x.toLocaleString("en-US");

/** One over-limit file, as a finding line: the file, its size, the cut, the loss. */
export function formatOnDemandOver(
  f: OnDemandFile,
  check: Extract<OnDemandCheck, { kind: "checked" }>,
): string {
  return `${f.path} is ${n(f.size)} ${check.unit}, over the per-file cut of ${n(check.limit)}: the model gets only the start`;
}
