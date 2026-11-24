/**
 * vigiles — Skill testing: deterministic tests for a skill's action sequence.
 *
 * PARKED (2026-08-16) — this drives the generator form, so it is parked with it;
 * see the header of `src/core/compile-generator.ts`. `runSkill` is reachable
 * from no package subpath. `scriptModel` is NOT parked: it is public from
 * `vigiles/harness/claude-code` and serves the harness testing API independently.
 *
 * A thin wrapper over the generator driver (`driveSkill`) for use inside an
 * ordinary `node:test` / Vitest `test()` — no custom runner, no DSL. You script
 * the *model* (the non-deterministic part) and assert the deterministic spine:
 * which gates ran, in what order, which branch was taken, whether the result
 * gate blocked. The model's prose quality is never asserted — that's the
 * probabilistic boundary; everything else is deterministic and checkable.
 */

import {
  driveSkill,
  type SkillProgram,
  type GeneratorSkill,
} from "./adapters/claude-code/skill-driver.js";
import type { Gate } from "./core/spec.js";

function gateLabel(g: Gate): string {
  if (g._ref === "cmd") return g.command;
  if (g._ref === "role") return `project:${g.role}`;
  return g.path;
}

export type ModelFn = (prose: string) => string;

/**
 * Script the mocked model. Pass:
 *  - an array — answers consumed in order across all acts; or
 *  - a map keyed by a case-insensitive substring of the act's prose, where each
 *    value is a single answer, or an array consumed in order *per key* (so a
 *    loop's prompt can return different answers on successive iterations).
 * Unmatched prose yields "".
 */
export function scriptModel(
  spec:
    | readonly string[]
    | Readonly<Record<string, string | readonly string[]>>,
): ModelFn {
  if (Array.isArray(spec)) {
    const answers: readonly string[] = spec;
    let i = 0;
    return () => answers[Math.min(i++, answers.length - 1)] ?? "";
  }
  const map = spec as Record<string, string | readonly string[]>;
  const idx: Record<string, number> = {};
  return (prose) => {
    const p = prose.toLowerCase();
    for (const k of Object.keys(map)) {
      if (!p.includes(k.toLowerCase())) continue;
      const v = map[k];
      if (typeof v === "string") return v;
      const i = idx[k] ?? 0;
      idx[k] = i + 1;
      return v[Math.min(i, v.length - 1)] ?? "";
    }
    return "";
  };
}

export interface SkillRunResult {
  /** Every gate passed and the skill reached its end. */
  readonly ok: boolean;
  /** Trace index of the gate that blocked, or null when all passed. */
  readonly blockedAt: number | null;
  /** Prose steps the model executed, with the scripted answer fed back in. */
  readonly acts: readonly { prose: string; answer: string }[];
  /** Gates that ran, in order, with their label and outcome. */
  readonly gates: readonly { label: string; terminal: boolean; ok: boolean }[];
}

/**
 * Drive a skill to completion (or first failed gate) with a scripted model and
 * return a friendly summary to assert on with plain `assert`.
 */
export function runSkill(
  skill: SkillProgram | GeneratorSkill,
  opts: { cwd?: string; model?: ModelFn } = {},
): SkillRunResult {
  const program = typeof skill === "function" ? skill : skill.program;
  const report = driveSkill(
    program,
    opts.cwd ?? process.cwd(),
    opts.model ?? (() => ""),
  );
  const acts: { prose: string; answer: string }[] = [];
  const gates: { label: string; terminal: boolean; ok: boolean }[] = [];
  for (const t of report.trace) {
    if (t.effect.kind === "act") {
      acts.push({ prose: t.effect.prose, answer: t.answer ?? "" });
    } else {
      gates.push({
        label: gateLabel(t.effect.gate),
        terminal: t.effect.kind === "result",
        ok: t.outcome?.ok ?? false,
      });
    }
  }
  return { ok: report.ok, blockedAt: report.blockedAt, acts, gates };
}
