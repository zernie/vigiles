/**
 * Refuse a spec field nobody declared, naming each one with a did-you-mean.
 * Generic over the key table the caller passes: the eval runners in
 * `src/eval.ts` hand in one table per spec type, checked before anything is
 * packaged or spent.
 */
import { editDistance } from "./edit-distance.js";

/**
 * The closest declared field to an unknown one, or undefined when nothing is
 * close — a wrong suggestion is worse than none (it invites "fixing" a field the
 * author never meant). Same tight threshold as the CLI's unknown-flag hint.
 */
function nearestField(
  unknown: string,
  known: readonly string[],
): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of known) {
    const d = editDistance(unknown.toLowerCase(), name.toLowerCase());
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(2, Math.floor(unknown.length / 4))
    ? best.name
    : undefined;
}

/** The hint after an unknown field: the caller's own pointer, else a did-you-mean. */
function hintFor(
  key: string,
  declared: readonly string[],
  pointers: Readonly<Record<string, string>>,
): string {
  const pointer = Object.hasOwn(pointers, key) ? pointers[key] : undefined;
  if (pointer !== undefined) return ` — ${pointer}`;
  const near = nearestField(key, declared);
  return near === undefined ? "" : ` — did you mean \`${near}\`?`;
}

/**
 * Throw when `spec` carries a field outside `known` — every unknown one named,
 * with a did-you-mean where a declared field is one typo away. `at` says which
 * runner and spec type the message is about (`arm` labels a nested arm);
 * `at.pointers` maps an unknown field whose job another field does to where
 * that job is. Runs before anything is packaged or spent.
 */
export function assertKnownKeys(
  spec: object,
  known: Record<string, true>,
  at: {
    readonly caller: string;
    readonly type: string;
    readonly arm?: string;
    readonly pointers?: Readonly<Record<string, string>>;
  },
): void {
  const declared = Object.keys(known);
  const where = at.arm === undefined ? "" : ` on arm "${at.arm}"`;
  const problems = Object.keys(spec)
    .filter((key) => !Object.hasOwn(known, key))
    .map(
      (key) =>
        `${at.caller}: unknown ${at.type} field "${key}"${where}${hintFor(key, declared, at.pointers ?? {})}`,
    );
  if (problems.length === 0) return;
  throw new Error(
    `${problems.join("\n")}\n  ${at.type} fields: ${declared.join(", ")}.\n` +
      "  An unknown field is refused rather than ignored: a dropped field would " +
      "make the run measure a setup you did not ask for.",
  );
}
