/**
 * Worked example: the refs-hook A/B as a `runEval` (the library form of
 * bench/run-refs.sh / benchmark #4 in research/benchmarks-runtime-gates.md).
 *
 * Question: does forcing the agent to mark its code references actually make
 * them verifiable? Two arms — no hook vs the refs-hook — on a "document these
 * functions in a SKILL.md" task. The payoff metric `caught`: after the run we
 * rename a documented function in the code and ask whether `vigiles lint`
 * flags the now-broken reference.
 *
 *   npx vigiles eval bench/evals/refs-hook.eval.mjs            # 3 trials/arm (default)
 *   npx vigiles eval --trials=6 bench/evals/refs-hook.eval.mjs
 *
 * Needs the `claude` CLI + model auth, and a built dist/ (`npm run build`).
 */
import { resolve } from "node:path";
import { defineEval } from "../../dist/test.js";

const CLI = resolve("dist/cli.js");

export default defineEval({
  runEval: {
    name: "refs-hook: forcing marks → verifiable references?",
    env: { kind: "ephemeral" },
    fixture: {
      "package.json": JSON.stringify({
        name: "shop",
        private: true,
        type: "module",
      }),
      "src/billing.ts":
        "export function chargeCard(token, cents) { return { token, cents }; }\n" +
        "export const MAX_CHARGE_CENTS = 1_000_000;\n",
      "src/cart.ts":
        "export function validateCart(cart) { return cart.items.length > 0; }\n" +
        "export function cartTotalCents(cart) { return cart.items.length; }\n",
    },
    arms: {
      vanilla: {},
      gated: {
        settings: {
          hooks: {
            PostToolUse: [
              {
                matcher: "Edit|Write",
                hooks: [{ type: "command", command: `node ${CLI} refs-hook` }],
              },
            ],
          },
        },
      },
    },
    task:
      "Write a file SKILL.md documenting how to charge a customer's cart, " +
      "referencing the functions and constants from src/billing.ts and src/cart.ts " +
      "(validateCart, cartTotalCents, chargeCard, MAX_CHARGE_CENTS) by name. " +
      "Keep it short. Then stop.",
    measure: (ctx) => {
      const count = (s) => Number(ctx.sh(`grep -c '${s}' SKILL.md`) || 0);
      const marks = count("vigiles:symbol");
      const ignores = count("vigiles:ignore");
      // Payoff: rename chargeCard in the code, does audit catch the broken ref?
      ctx.sh("sed -i 's/chargeCard/captureCard/g' src/billing.ts");
      const audit = ctx.sh(`node ${CLI} lint SKILL.md`);
      const caught = /"chargeCard" is not defined/.test(audit);
      ctx.sh("sed -i 's/captureCard/chargeCard/g' src/billing.ts");
      return { marks, ignores, caught };
    },
    trials: 3,
    model: "haiku",
  },
});
