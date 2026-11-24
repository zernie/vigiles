/**
 * A skill's own frontmatter, read back as CHECKS.
 *
 * A `SKILL.md` already declares its capability surface — `allowed-tools:` — and
 * nothing ever verified that a run stayed inside it. That is the product's own
 * thesis pointed at its own file format: the declaration is prose until
 * something mechanical reads it. This module does the reading; every check it
 * hands back is an existing one (`skill`, {@link onlyTools}), so there is no new
 * assertion machinery here — only the wiring from a declaration to the vocabulary.
 *
 * 🔴 WHAT THIS DOES AND DOES NOT PROVE (corrected 2026-08-11). `allowed-tools:` is
 * a PRE-APPROVAL, not a fence: Claude Code's docs say "It does not restrict which
 * tools are available: every tool remains callable", and two issues closed as
 * not-planned (anthropics/claude-code#18837, #37683) say the same from the field.
 * So a passing contract means the run STAYED INSIDE what the author declared — a
 * test of AUTHOR DISCIPLINE, and a real one. It is NOT evidence that the skill
 * COULD NOT have gone outside; nothing in `allowed-tools:` stops it. The field
 * measured to remove a tool from the pool is `disallowed-tools:`, and the check
 * that reads it is `lethal-trifecta` (see `src/core/lethal-trifecta.ts`).
 *
 * Deliberately NOT a third entry point: a `SkillContract` is a bag of ordinary
 * `Check<Trace>`s, so it composes into the deterministic tier (`runHarnessTest`)
 * and the eval tier (`measure` / `measureTriggerRate`) unchanged.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { Check } from "./check.js";
import { onlyTools, skill } from "./check.js";
import type { Trace } from "./harness-test.js";
import { readFrontmatter, frontmatterScalar } from "./core/frontmatter-read.js";
import { parseAgentToolList } from "./adapters/claude-code/agent-tools.js";

/** @public */
export interface SkillContractOptions {
  /**
   * The plugin namespace, so activation is asserted on the real `<plugin>:<skill>`
   * id. Resolved from the enclosing plugin manifest when omitted.
   */
  readonly plugin?: string;
}

/** @public */
export interface SkillContract {
  /** The skill's `name:` (falls back to its directory name). */
  readonly name: string;
  /** What `skill()` matches — `<plugin>:<name>`, or bare `name` if unresolvable. */
  readonly id: string;
  /** `allowed-tools:` exactly as declared. Empty when undeclared or malformed. */
  readonly declared: readonly string[];
  /** The skill activated at all. */
  readonly activation: Check<Trace>;
  /** The run stayed inside the declared surface. */
  readonly surface: readonly Check<Trace>[];
  /**
   * No `allowed-tools:` line — nothing was claimed, so there is no declared
   * surface a run can be held to. (Every skill inherits every tool the session
   * grants either way; `allowed-tools:` pre-approves, it does not fence.)
   */
  readonly undeclared: boolean;
  /** A frontmatter block exists but is not valid YAML, so nothing parsed. */
  readonly malformed: boolean;
}

/**
 * `Skill` is the harness's own activation mechanism, not a capability the skill
 * exercises: the call that LOADS the skill under test appears in the trace, and
 * no `allowed-tools:` line ever lists it. Counting it would make every contract
 * fail on every run — a false positive so uniform it would train people to
 * ignore the check.
 */
const ACTIVATION_TOOL = "Skill";

/** A check that always fails — used when there is no declaration to verify. */
function unverifiable(kind: string, message: string): Check<Trace> {
  return {
    kind,
    eval: () => ({ pass: false, score: 0, message }),
    toJSON: () => ({ kind }),
  };
}

/**
 * The one surface check, chosen by how much of the declaration is actually
 * readable. Both degenerate states FAIL rather than pass vacuously — see
 * {@link skillContract}.
 */
function buildSurface(d: {
  readonly path: string;
  readonly malformed: boolean;
  readonly undeclared: boolean;
  readonly declared: readonly string[];
  readonly id: string;
}): Check<Trace> {
  const { path, malformed, undeclared, declared, id } = d;
  if (malformed)
    return unverifiable(
      "surfaceUnverifiable",
      `${path}: frontmatter is not valid YAML, so its allowed-tools contract ` +
        `could not be read. A strict loader rejects the block and a regex ` +
        `salvage would be a guess — the skill therefore declares nothing ` +
        `enforceable. Fix the YAML and this check becomes real.`,
    );
  if (undeclared)
    return unverifiable(
      "surfaceUndeclared",
      `${path}: no \`allowed-tools:\` line, so there is no declared surface for a ` +
        `run to stay inside. Declare the tools it actually needs; until then "no ` +
        `violations" would only mean "nothing was claimed". (Declaring them is a ` +
        `statement of INTENT that this check then holds the run to — it does not ` +
        `fence the skill: \`allowed-tools:\` pre-approves, every tool stays ` +
        `callable. The fence is \`disallowed-tools:\`.)`,
    );
  return duringSkill(id, [...declared, ACTIVATION_TOOL]);
}

/**
 * {@link onlyTools}, scoped to the window in which THIS skill was active.
 *
 * 🔴 IT USED TO SPAN THE WHOLE TRACE, and a contract violation is an ACCUSATION
 * about someone's skill. A harness that reads a fixture before activating the
 * skill, or exercises two skills in one run, had the setup `Read` and the other
 * skill's `Bash` reported as this skill's violations — the harmful-advice
 * direction, in our own new API.
 *
 * ## The window, and why it is recoverable
 *
 * A `Skill` call with this id STARTS it. The next `Skill` call — of any id — ENDS
 * it: the harness has moved on to something else, and nothing after that point
 * can be attributed here. Trailing calls after the last activation are inside it,
 * because nothing says otherwise. A skill activated twice contributes both
 * windows.
 *
 * ⚠️ ONE CONFOUND IS NOT RECOVERABLE FROM `toolCalls` ALONE, so it is subtracted
 * rather than reasoned about: `parseToolCalls` collects EVERY `tool_use` block,
 * including the ones nested under a subagent dispatch, and `ToolCall` carries no
 * id or parent to tell them apart. A skill that dispatches a subagent would
 * therefore answer for that agent's tools — which the agent's OWN contract is
 * for. The nested calls are available separately (`trace.subagents[*].toolCalls`)
 * and are removed by value (name + input), which over-removes an identical call
 * the skill also made itself. That direction drops an accusation rather than
 * inventing one.
 *
 * ⚠️ NO ACTIVATION IN THE TRACE → FAIL, not a silent pass. The module refuses
 * vacuous passes everywhere else (a malformed or absent declaration fails), and
 * "no violations" from a run where the skill never ran would mean nothing.
 */
function duringSkill(id: string, allowed: readonly string[]): Check<Trace> {
  const inner = onlyTools(allowed);
  return {
    kind: "onlyTools",
    eval: (t) => {
      const calls = t.toolCalls;
      const isSkill = (c: Trace["toolCalls"][number]) => c.name === "Skill";
      const starts = calls
        .map((c, i) => ({ c, i }))
        .filter(
          ({ c }) =>
            isSkill(c) && (c.input as { skill?: string })?.skill === id,
        )
        .map(({ i }) => i);
      if (starts.length === 0)
        return {
          pass: false,
          score: 0,
          message:
            `onlyTools cannot run: skill "${id}" never activated in this trace, ` +
            `so there is no window to hold to its contract — "no violations" ` +
            `would only mean "the skill never ran". Assert activation first ` +
            `(the contract's \`activation\` check), or point the run at a task ` +
            `that triggers it.`,
        };
      const nested = new Set(
        (t.subagents ?? []).flatMap((s) =>
          s.toolCalls.map((c) => `${c.name}\u0000${JSON.stringify(c.input)}`),
        ),
      );
      const scoped: Trace["toolCalls"][number][] = [];
      for (const start of starts) {
        for (let i = start + 1; i < calls.length; i++) {
          const c = calls[i];
          if (c === undefined || isSkill(c)) break; // another activation ends it
          if (nested.has(`${c.name}\u0000${JSON.stringify(c.input)}`)) continue;
          scoped.push(c);
        }
      }
      // The activation itself is inside the window by definition, and keeping it
      // makes the "recorded no tool calls" arm of `onlyTools` unreachable here —
      // a skill that activated and did nothing else PASSES, which is correct: it
      // stayed inside its declared set.
      const activation = calls[starts[0]];
      return inner.eval({
        ...t,
        toolCalls: activation ? [activation, ...scoped] : scoped,
      });
    },
    toJSON: () => ({ kind: "onlyTools", allowed: [...allowed], during: id }),
  };
}

/** The plugin name from the manifest enclosing `<root>/skills/<name>/`. */
function resolvePlugin(skillDir: string): string | undefined {
  const root = resolve(skillDir, "..", "..");
  for (const rel of [join(".claude-plugin", "plugin.json"), "plugin.json"]) {
    try {
      const j = JSON.parse(readFileSync(join(root, rel), "utf-8")) as {
        name?: unknown;
      };
      if (typeof j.name === "string" && j.name) return j.name;
    } catch {
      /* not a plugin root, or unreadable — try the next candidate */
    }
  }
  return undefined;
}

/**
 * Read `<skillDir>/SKILL.md` and return its declaration as checks.
 *
 * Two states are FINDINGS rather than empty contracts, and both return a
 * `surface` that FAILS instead of passing vacuously:
 *
 * - **`undeclared`** — no `allowed-tools:` line, so nothing was claimed and there
 *   is no surface for a run to stay inside. Silently reporting "no violations"
 *   would present the widest possible capability surface as the cleanest one.
 * - **`malformed`** — a frontmatter block that is not valid YAML. A strict
 *   loader rejects it, so the declared list is unknown, not empty; a regex
 *   salvage of it would be a guess. A declaration that does not parse is not an
 *   enforcement. (Observed live: a single unquoted `: ` inside the description
 *   silently voided a skill's whole tool contract.)
 */
export function skillContract(
  skillDir: string,
  options: SkillContractOptions = {},
): SkillContract {
  const path = join(skillDir, "SKILL.md");
  const md = readFileSync(path, "utf-8");
  const fm = readFrontmatter(md);

  const name = frontmatterScalar(fm, "name") ?? basename(resolve(skillDir));
  const plugin = options.plugin ?? resolvePlugin(skillDir);
  const id = plugin ? `${plugin}:${name}` : name;

  const malformed = fm.malformed;
  const parsed = malformed ? null : parseAgentToolList(md, "allowed-tools");
  const undeclared = parsed === null;
  const declared = parsed ?? [];

  const surface: Check<Trace>[] = [
    buildSurface({ path, malformed, undeclared, declared, id }),
  ];

  return {
    name,
    id,
    declared,
    activation: skill(id),
    surface,
    undeclared,
    malformed,
  };
}
