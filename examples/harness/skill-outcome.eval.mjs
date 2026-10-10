/**
 * Canonical example — a skill-outcome *eval* (`runEval`).
 *
 * The eval tier is the empirical half of harness testing: it drives the *real*
 * model N trials per arm and measures whether a harness change actually moves
 * agent behaviour. Here the change is a skill's guidance, and the question is
 * the one you ask of any of the ~156 wshobson `SKILL.md`s — *does the skill
 * produce the right outcome?*
 *
 *   - arm `no_skill`  — no guidance present
 *   - arm `with_skill`— a SKILL.md the task tells the agent to read
 *
 * Metric `followed`: did the commit message the agent wrote use a Conventional
 * Commits prefix (the skill's rule)? Expect ~0 without the skill, higher with.
 *
 *   npx vigiles eval --trials=6 examples/harness/skill-outcome.eval.mjs
 *
 * Real model → real cost. Needs the `claude` CLI + model auth and a built
 * dist/. External users import `defineEval` + the free checks from `"vigiles"`;
 * an eval file declares its measurement and `vigiles eval` runs it.
 *
 * Note: this example delivers the arm difference by telling the agent to read a
 * working-dir SKILL.md — the simplest illustration for a prose-only skill. To
 * test a *real installed plugin* (so the model activates the skill by its
 * description, not because we told it to read a file), give the arm
 * `pluginDir: "/path/to/a/whole/plugin"` instead — that installs it natively via
 * `claude --plugin-dir`. See `src/harness-test.test.ts` and the coverage matrix.
 */
import { defineEval } from "../../dist/test.js";

const SKILL = `# commit-message

When you write a commit message, ALWAYS start the subject line with a
Conventional Commits type and colon: \`feat:\`, \`fix:\`, \`chore:\`, \`docs:\`,
\`refactor:\`, or \`test:\`. Example: \`feat: add logout button\`.
`;

export default defineEval({
  runEval: {
    name: "skill-outcome: does the commit-message skill change the output?",
    env: { kind: "ephemeral" }, // a throwaway HOME and a scrubbed environment
    fixture: {
      "package.json": JSON.stringify({ name: "app", private: true }),
    },
    arms: {
      no_skill: {},
      with_skill: { files: { "SKILL.md": SKILL } },
    },
    task:
      "Read SKILL.md if it exists and follow it. Write a one-line commit message " +
      "for a change that adds a logout button, into the file COMMIT_MSG. Then stop.",
    measure: (ctx) => {
      const msg = (ctx.file("COMMIT_MSG") ?? "").trim();
      const followed = /^(feat|fix|chore|docs|refactor|test)(\(|:)/.test(msg);
      return { followed };
    },
    trials: 3,
    model: "haiku",
  },
});
