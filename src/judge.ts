/**
 * vigiles — a thin LLM-as-judge for the eval tier.
 *
 * Some outcomes aren't a regex: "is this commit message clear?", "did the SKILL
 * produce a sensible plan?". `judge` grades an output against a rubric with a
 * model and returns a numeric score + pass/fail, for use *inside* an eval's
 * `measure` (which is synchronous — so this shells out via the `claude` CLI
 * synchronously, no extra deps):
 *
 *   measure: (ctx) => {
 *     const v = judge({ output: ctx.file("PLAN.md") ?? "", rubric:
 *       "1 if the plan lists concrete, ordered steps; else 0." });
 *     return { quality: v.score, ok: v.pass };
 *   }
 *
 * This is deliberately minimal — for datasets, tracing, and dashboards use a
 * dedicated eval platform (Braintrust, DeepEval). vigiles owns the harness A/B,
 * not the judging platform. Needs the `claude` CLI + model auth.
 */
import { spawnSync } from "node:child_process";
import { refuseUnderForeignRunner } from "./core/foreign-runner.js";
import { refuseOutsideRunner } from "./core/eval-load-phase.js";

export interface JudgeResult {
  /** Score in [0, 1] (clamped). 0 on any failure to obtain a verdict. */
  readonly score: number;
  /** score ≥ threshold (default 0.5). */
  readonly pass: boolean;
  /** The model's one-line rationale, or an error string. */
  readonly reason: string;
}

export interface JudgeOptions {
  /** The text to grade. */
  readonly output: string;
  /** The grading rubric — describe what earns a high vs low score. */
  readonly rubric: string;
  /** Model alias. Default "haiku" (cheap; judging is a simple call). */
  readonly model?: string;
  /** pass = score ≥ threshold. Default 0.5. */
  readonly threshold?: number;
  /** Per-call timeout ms. Default 60000. */
  readonly timeoutMs?: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Extract the first JSON object from a string (models often wrap it in prose). */
function firstJsonObject(s: string): unknown {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* v8 ignore start -- spawns the real claude CLI; parseJudgeOutput holds the logic */
/**
 * Grade `output` against `rubric` with a model. Synchronous (for `measure`).
 *
 * @public
 */
export function judge(opts: JudgeOptions): JudgeResult {
  // BEFORE the `try` below: it catches everything and returns `score: 0`, so a
  // refusal thrown inside would be downgraded to a silent failing grade.
  refuseUnderForeignRunner("grading with `claude`");
  refuseOutsideRunner("grading with `claude`");
  const threshold = opts.threshold ?? 0.5;
  const prompt =
    "You are a strict grader. Score the OUTPUT against the RUBRIC. " +
    'Respond with ONLY a JSON object: {"score": <number 0..1>, "reason": "<one line>"}.\n\n' +
    `RUBRIC:\n${opts.rubric}\n\nOUTPUT:\n${opts.output}`;

  let res;
  try {
    res = spawnSync(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        opts.model ?? "haiku",
        "--output-format",
        "json",
      ],
      { encoding: "utf-8", timeout: opts.timeoutMs ?? 60000 },
    );
  } catch (e) {
    return {
      score: 0,
      pass: false,
      reason: `judge spawn failed: ${String(e)}`,
    };
  }
  if (res.status !== 0) {
    return { score: 0, pass: false, reason: "judge: no model output" };
  }
  return parseJudgeOutput(res.stdout ?? "", threshold);
}
/* v8 ignore stop */

/**
 * Parse a verdict out of the grader's stdout — pure, so the parsing is testable
 * without a model. Handles `claude --output-format json` (text wrapped in a
 * `result` field), bare/prose-wrapped JSON, clamping, and the pass threshold.
 */
export function parseJudgeOutput(stdout: string, threshold = 0.5): JudgeResult {
  if (!stdout)
    return { score: 0, pass: false, reason: "judge: no model output" };

  // claude --output-format json wraps the model text in a `result` field.
  let text = stdout;
  const wrapper = firstJsonObject(stdout) as { result?: string } | null;
  if (wrapper && typeof wrapper.result === "string") text = wrapper.result;

  const verdict = firstJsonObject(text) as {
    score?: number;
    reason?: string;
  } | null;
  if (!verdict || typeof verdict.score !== "number") {
    return { score: 0, pass: false, reason: "judge: unparseable verdict" };
  }
  const score = clamp01(verdict.score);
  return { score, pass: score >= threshold, reason: verdict.reason ?? "" };
}
