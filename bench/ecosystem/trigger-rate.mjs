/**
 * Does the caveman skill, installed the REAL way (--plugin-dir), actually FIRE on
 * normal coding prompts? Its description triggers on "caveman mode" / "be brief" /
 * "less tokens" — phrases a normal coding session never says. So the in-the-wild
 * activation rate is the second, cleaner half of the debunk: install it, code
 * normally, and it stays dormant → 0% savings before any compression argument.
 *
 * Uses vigiles's own measureTriggerRate (real model, on the subscription). The
 * `fired` predicate matches any Skill tool call naming caveman (robust to the
 * plugin:skill id). Neutral prompts = real coding asks; the trigger-phrase set is
 * a control showing the skill CAN fire when actually invoked.
 *
 *   node bench/ecosystem/trigger-rate.mjs         # neutral coding (expect ~0)
 *   TRIGGER=1 node bench/ecosystem/trigger-rate.mjs   # explicit "be brief" control
 */
// A real model is spawned only inside a vigiles runner (vigiles#586), so this
// script runs its measurement through the programmatic door, which also prints
// the report and sets the exit code on a failure.
import { defineEval } from "../../dist/entries/index.js";
import { paid_runEval } from "../../dist/entries/eval.js";

const here = new URL("./skills/caveman-plugin", import.meta.url);
const pluginDir = decodeURIComponent(here.pathname);

const NEUTRAL = [
  "Write a JS function to slugify blog post titles.",
  "Add a debounce helper for a search box in utils.js.",
  "Fix the off-by-one bug in lastN() in buggy.js.",
  "What is the time complexity of this nested loop, and why?",
  "Write an isEmail(s) validator with a simple regex.",
  "Review cart.js and fix the money-rounding bug.",
  "Refactor the duplicated round2 helper into a shared module.",
];
const TRIGGER = [
  "Use caveman mode and write a slugify function.",
  "Be brief: add a debounce helper.",
  "Answer with less tokens — what's this loop's Big-O?",
  "Token efficiency mode on. Write an email regex.",
  "Talk like caveman and review this cart module.",
];

const prompts = process.env.TRIGGER ? TRIGGER : NEUTRAL;
const label = process.env.TRIGGER
  ? "explicit trigger phrases (control)"
  : "neutral coding (in the wild)";
const fired = (t) =>
  t.toolCalls.some(
    (c) => c.name === "Skill" && /caveman/i.test(JSON.stringify(c.input ?? {})),
  );

console.log(`\n=== caveman trigger-rate — ${label} ===`);
await paid_runEval(
  defineEval({
    measureTriggerRate: {
      name: `caveman-trigger-${process.env.TRIGGER ? "control" : "neutral"}`,
      pluginDir,
      prompts,
      fired,
      trials: Number(process.env.VIGILES_TRIALS || 3),
      model: process.env.VIGILES_MODEL || "sonnet",
    },
  }),
);
