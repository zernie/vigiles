/**
 * The TEST + EVAL section — the half of the product that `audit` does not sell.
 *
 * WHY IT EXISTS. The landing led with `audit` (a graded read) and then named the
 * other three verbs as one line each in VerbMap. A visitor came away thinking vigiles
 * is a linter. The founder's brief, 2026-09-09: "audit is a starting point and then
 * people going through the website should think wow this stuff like testing and evals
 * really solves my problem." So this section does not re-describe the verbs — VerbMap
 * already does, and duplicating it is the echo the landing-site skill forbids. It
 * shows the two questions a config checker cannot answer, as code you can run.
 *
 * EVERY SNIPPET IS REAL AND COMMITTED — trimmed from examples/harness/*, which CI
 * runs. An invented snippet on a page selling verification would be self-refuting.
 */

const FREE = `import { runHook } from "vigiles";
import { assertHookBlocked } from "vigiles";

// Your safety hook is a process: an event on stdin, exit 2 to block.
const blocked = runHook(guard, {
  event: "PreToolUse",
  tool: "Bash",
  input: { command: "git commit --no-verify -m wip" },
});

assertHookBlocked(blocked); // fails CI if the guard stopped blocking`;

const PAID = `import { defineEval, skillResolved } from "vigiles/eval";

// Does obra/superpowers' TDD skill actually fire on TDD-shaped work?
export default defineEval({
  measureTriggerRate: {
    pluginDir,
    stubSkillBodies: true,        // measure SELECTION, don't run the skill
    prompts: [
      "Add an isEven(n) function to utils.js — write it test-first.",
      "Fix the off-by-one in paginate(); add a regression test first.",
      /* …8 more */
    ],
    fired: (t) => skillResolved(t, "superpowers:test-driven-development"),
  },
});`;

function Panel({
  eyebrow,
  cost,
  title,
  blurb,
  code,
}: {
  eyebrow: string;
  cost: string;
  title: string;
  blurb: string;
  code: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card/30 p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          {eyebrow}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{cost}</span>
      </div>
      <h3 className="mt-3 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {blurb}
      </p>
      <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background p-4 font-mono text-xs leading-relaxed text-muted-foreground">
        {code}
      </pre>
    </div>
  );
}

export function Measure() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Your config is valid. Does the agent actually do the thing?
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Whether a guard really blocks, and whether a skill really fires,
            cannot be read off the file — the first needs the hook run, the
            second needs a model to choose. Both are tests you write once and
            keep.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <Panel
            eyebrow="Test"
            cost="no model · free in CI"
            title="Does the guard actually block?"
            blurb="A hook is a process. Pipe it the event and assert on the exit code — no
              agent binary, no API key, milliseconds. The tier that catches a guard
              that silently stopped blocking."
            code={FREE}
          />
          <Panel
            eyebrow="Eval"
            cost="real model · your Claude subscription"
            title="Does the skill actually fire?"
            blurb="Run varied prompts past a real model and count. You get recall and
              precision for a description — the number no static check can produce,
              billed to the subscription you already pay for, not a metered key."
            code={PAID}
          />
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-muted-foreground">
          Both snippets are trimmed from{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">
            examples/harness/
          </code>
          , which this repository runs in CI.
        </p>
      </div>
    </section>
  );
}
