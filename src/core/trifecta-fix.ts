/**
 * The edit that closes a lethal-trifecta finding, as a TYPE, and the one line
 * a person reads, rendered from it.
 *
 * The detector (`./lethal-trifecta.ts`) decides WHICH edit fits a unit: remove
 * the shell, drop a pre-approval, extend a fence. That decision is the
 * behaviour, so it is data a test can assert (`fix.kind`), not a sentence a
 * test has to grep. {@link describeFix} is the only place that turns it into
 * words, under the `tidy-output` rule: one line, the problem then the edit,
 * with the reasons left to docs/rules/lethal-trifecta.md. Pure.
 *
 * The leg vocabulary lives here too, so this module depends on nothing but the
 * guard; the detector re-exports it under its old names.
 */
import { assertNever } from "./assert-never.js";

/** The three capability legs of the lethal trifecta. */
export type TrifectaLeg = "private" | "untrusted" | "exfil";

/** The tools classified into each leg (base names, de-duplicated). */
export interface TrifectaLegs {
  /** LEG A — tools that can read private data (secrets, files, repo). */
  readonly private: readonly string[];
  /** LEG B — tools that ingest untrusted / attacker-controllable content. */
  readonly untrusted: readonly string[];
  /** LEG C — tools that can exfiltrate data out of the trust boundary. */
  readonly exfil: readonly string[];
}

/**
 * - `declare-tools` — a subagent with no `tools:` line.
 * - `remove-shell` — an unrestricted shell grant supplies two legs on its own.
 * - `narrowed-still-counts` — a restricted shell grant that still counts: the
 *   author already narrowed, so the edit is not "narrow more".
 * - `remove-a-tool` — no shell leg: the named tools carry all three legs.
 * - `fix-yaml` — the block does not parse, so the field it holds is unread.
 * - `drop-pre-approval` — a skill's `allowed-tools:` pre-approves a leg tool.
 * - `add-fence` — a skill with no `disallowed-tools:` line.
 * - `extend-fence` — a skill whose `disallowed-tools:` closes no leg: empty,
 *   restricted entries (`ignored`), or a partial list.
 *
 * `leg` + `deny` name the open leg that takes the fewest further denies.
 */
export type TrifectaFix =
  | { readonly kind: "declare-tools" }
  | { readonly kind: "remove-shell"; readonly shell: string }
  | {
      readonly kind: "narrowed-still-counts";
      readonly grants: readonly string[];
      readonly shell: string;
    }
  | { readonly kind: "remove-a-tool" }
  | { readonly kind: "fix-yaml"; readonly field: "tools" | "disallowed-tools" }
  | { readonly kind: "drop-pre-approval"; readonly tools: readonly string[] }
  | {
      readonly kind: "add-fence";
      readonly leg: TrifectaLeg;
      readonly deny: readonly string[];
    }
  | {
      readonly kind: "extend-fence";
      readonly declared: readonly string[];
      readonly ignored: readonly string[];
      readonly leg: TrifectaLeg;
      readonly deny: readonly string[];
    };

const LEG_NAME: Readonly<Record<TrifectaLeg, string>> = {
  private: "private-data read",
  untrusted: "untrusted intake",
  exfil: "exfiltration",
};

/** Backticked names: `` `a`, `b` ``. */
const ticked = (names: readonly string[]): string =>
  `\`${names.join("`, `")}\``;

/** A leg's first supplier, and how many more: one line holds three legs. */
const few = (tools: readonly string[]): string =>
  tools.length > 1
    ? `${tools[0] ?? ""} +${String(tools.length - 1)}`
    : tools.join(", ");

/** What an explicit all-three contract holds, before its edit. */
const holds = (legs: TrifectaLegs): string =>
  `reads (${few(legs.private)}), takes untrusted (${few(legs.untrusted)}), ` +
  `sends out (${few(legs.exfil)})`;

/** Why an existing fence closes nothing. */
function fenceProblem(declared: readonly string[], ignored: readonly string[]) {
  if (declared.length === 0)
    return "`disallowed-tools:` is empty and denies nothing";
  if (ignored.length === 0)
    return `\`disallowed-tools: ${declared.join(", ")}\` closes no leg`;
  const rest =
    ignored.length === declared.length ? "" : ", and the rest closes no leg";
  return `${ticked(ignored)} denies nothing: a restricted deny is ignored${rest}`;
}

/** The finding's one line: the problem, then the edit. */
export function describeFix(fix: TrifectaFix, legs: TrifectaLegs): string {
  switch (fix.kind) {
    case "declare-tools":
      return "no `tools:` line, so every session tool is inherited → list the tools it needs in `tools:`, leaving out one leg";
    case "remove-shell":
      return `${holds(legs)} → remove ${fix.shell}, it both reads and sends out`;
    case "narrowed-still-counts":
      return `${holds(legs)} → ${ticked(fix.grants)} still counts: remove ${fix.shell} or drop a leg`;
    case "remove-a-tool":
      return `${holds(legs)} → remove one of those tools, usually the untrusted input`;
    case "fix-yaml":
      return fix.field === "tools"
        ? "frontmatter is not valid YAML, so `tools:` is unread and every tool is inherited → fix the YAML"
        : "frontmatter is not valid YAML, so no `disallowed-tools:` fence is read → fix the YAML, then fence";
    case "drop-pre-approval":
      return `\`allowed-tools:\` pre-approves ${ticked(fix.tools)}, a trifecta leg, and no \`disallowed-tools:\` fences it → drop the pre-approval`;
    case "add-fence":
      return `no \`disallowed-tools:\` line, so every session tool is inherited → add \`disallowed-tools: ${fix.deny.join(", ")}\` to close ${LEG_NAME[fix.leg]}`;
    case "extend-fence":
      return `${fenceProblem(fix.declared, fix.ignored)} → deny ${ticked(fix.deny)} to close ${LEG_NAME[fix.leg]}`;
    default:
      return assertNever(fix);
  }
}
