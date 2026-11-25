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
export interface TrifectaFixFields {
  readonly "declare-tools": Record<never, never>;
  readonly "remove-shell": { readonly shell: string };
  readonly "narrowed-still-counts": {
    readonly grants: readonly string[];
    readonly shell: string;
  };
  readonly "remove-a-tool": Record<never, never>;
  readonly "fix-yaml": { readonly field: "tools" | "disallowed-tools" };
  readonly "drop-pre-approval": { readonly tools: readonly string[] };
  readonly "add-fence": {
    readonly leg: TrifectaLeg;
    readonly deny: readonly string[];
  };
  readonly "extend-fence": {
    readonly declared: readonly string[];
    readonly ignored: readonly string[];
    readonly leg: TrifectaLeg;
    readonly deny: readonly string[];
  };
}

/** One kind of fix, with the fields that kind carries. */
export type TrifectaFixOf<K extends keyof TrifectaFixFields> = {
  readonly kind: K;
} & TrifectaFixFields[K];

export type TrifectaFix = {
  readonly [K in keyof TrifectaFixFields]: TrifectaFixOf<K>;
}[keyof TrifectaFixFields];

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

/**
 * A finding in two parts a renderer can lay out apart: what is wrong, and the
 * one edit that fixes it. Joined, they are the finding's one line
 * ({@link fixLine}).
 */
export interface FixText {
  readonly problem: string;
  readonly edit: string;
}

const text = (problem: string, edit: string): FixText => ({ problem, edit });

/**
 * Each kind's words, keyed by kind: a kind without an entry, or an entry that
 * reads a field its kind does not carry, fails `tsc`.
 */
const DESCRIBE: {
  readonly [K in keyof TrifectaFixFields]: (
    fix: TrifectaFixOf<K>,
    legs: TrifectaLegs,
  ) => FixText;
} = {
  "declare-tools": () =>
    text(
      "no `tools:` line, so every session tool is inherited",
      "list the tools it needs in `tools:`, leaving out one leg",
    ),
  "remove-shell": (fix, legs) =>
    text(holds(legs), `remove ${fix.shell}, it both reads and sends out`),
  "narrowed-still-counts": (fix, legs) =>
    text(
      holds(legs),
      `${ticked(fix.grants)} still counts: remove ${fix.shell} or drop a leg`,
    ),
  "remove-a-tool": (_fix, legs) =>
    text(holds(legs), "remove one of those tools, usually the untrusted input"),
  "fix-yaml": (fix) =>
    fix.field === "tools"
      ? text(
          "frontmatter is not valid YAML, so `tools:` is unread and every tool is inherited",
          "fix the YAML",
        )
      : text(
          "frontmatter is not valid YAML, so no `disallowed-tools:` fence is read",
          "fix the YAML, then fence",
        ),
  "drop-pre-approval": (fix) =>
    text(
      `\`allowed-tools:\` pre-approves ${ticked(fix.tools)}, a trifecta leg`,
      "drop the pre-approval",
    ),
  "add-fence": (fix) =>
    text(
      "no `disallowed-tools:` line, so every session tool is inherited",
      `add \`disallowed-tools: ${fix.deny.join(", ")}\` to close ${LEG_NAME[fix.leg]}`,
    ),
  "extend-fence": (fix) =>
    text(
      fenceProblem(fix.declared, fix.ignored),
      `deny ${ticked(fix.deny)} to close ${LEG_NAME[fix.leg]}`,
    ),
};

/** The problem and the edit, from the detector's decision and this unit's legs. */
export function describeFix<K extends keyof TrifectaFixFields>(
  fix: TrifectaFixOf<K>,
  legs: TrifectaLegs,
): FixText {
  return DESCRIBE[fix.kind](fix, legs);
}

/** The finding as one line: `problem → edit`. */
export const fixLine = (t: FixText): string => `${t.problem} → ${t.edit}`;

/** What {@link sessionShare} reads of a finding. */
export interface SessionCandidate {
  readonly name: string;
  readonly cause: "session" | "fence" | "unit";
  readonly edit: string;
}

/** The units that only inherit the session, as ONE finding. */
export interface SessionShare {
  readonly names: readonly string[];
  readonly problem: string;
  readonly edit: string;
}

/**
 * The units whose legs all come from the session (`cause: "session"`), as one
 * finding for the whole repository instead of one per unit (#539). The risk is
 * the session's: in auto mode, Claude Code's default for interactive sessions,
 * a classifier rather than the person approves each call. The edit is the
 * units' shared edit when they agree, else the general one. `undefined` when no
 * unit only inherits. Pure.
 */
export function sessionShare(
  findings: readonly SessionCandidate[],
): SessionShare | undefined {
  const units = findings.filter((f) => f.cause === "session");
  const first = units.at(0);
  if (first === undefined) return undefined;
  const same = units.every((u) => u.edit === first.edit);
  return {
    names: units.map((u) => u.name),
    problem:
      `${String(units.length)} unit(s) inherit every session tool, which holds all three legs; ` +
      "in auto mode a classifier, not you, approves each call",
    edit: same
      ? `${first.edit} where it is not needed`
      : "fence the ones that do not need them: `disallowed-tools:` per skill, `tools:` per subagent",
  };
}
