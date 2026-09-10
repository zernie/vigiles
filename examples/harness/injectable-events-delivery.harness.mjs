/**
 * Does EVERY event this adapter declares injectable actually deliver?
 *
 * `claudeCodeHookProtocol.injectableEvents` (src/adapters/claude-code/hook-protocol.ts)
 * is a claim about SOMEBODY ELSE'S PRODUCT: these are the events on which Claude
 * Code honours `hookSpecificOutput.additionalContext`. Prose cannot keep that
 * claim true — the list is read by `noticeDelivery` (core/hook-program.ts), which
 * returns `{kind:"inject"}` for any event on it, so a wrong entry makes the
 * runtime emit a payload and BELIEVE it delivered. That is the repo's own
 * `fired ≠ landed` split, one level up from the one it names.
 *
 * MEASURED 2026-09-10 (zernie/vigiles#231): Claude Code stopped delivering
 * `PostToolUse` additionalContext between 2.1.227 (last good) and 2.1.228 (first
 * bad); it is still dropped on 2.1.267. CI is green only because it pins
 * VALIDATED_CC_VERSION = 2.1.187. The hook FIRES and the harness records its
 * stdout verbatim — Claude Code ingests the payload and drops it before building
 * the model request.
 *
 * THE PROPERTY IS DELIBERATELY NOT "PostToolUse IS BROKEN". Encoding today's
 * accident as the expectation would make this test go red the day Anthropic fixes
 * it, and green while a FOURTH event is added to the list unmeasured. The claim
 * is the invariant the list is supposed to express: every DECLARED event
 * delivers. So it passes on <= 2.1.227, fails on >= 2.1.228, passes again on a
 * fixed release, and fails loudly on an unmeasured addition (an event with no
 * entry in PROVOCATION cannot be provoked, and that is a hard failure, not a
 * skip).
 *
 * BOTH DIRECTIONS IN ONE RUN. The declared events are each other's control: they
 * are measured in the SAME session, through the SAME hook script, emitting the
 * SAME payload shape. A run where nothing landed proves only that the session was
 * broken, so "at least one declared event landed" is asserted BEFORE the claim.
 * The per-event marker ledger separates the two failure modes that look identical
 * from the outside: a hook that never fired (fixture's fault) from one that fired
 * and had its output dropped (the product's).
 *
 * SCOPE, stated because it is the honest limit: this drives `claude -p`
 * (headless), which is what `runHarnessTest` can reach. Interactive sessions are
 * unmeasured, so this does not say whether a real user's nudges still land.
 * It also says nothing about any other harness — a Codex adapter is held to its
 * OWN `injectableEvents`, which is the point of reading the port rather than a
 * literal.
 *
 *   node examples/harness/injectable-events-delivery.harness.mjs
 *
 * Same shape and same reason as src/subagent-delivery.test.ts and
 * src/hook-matcher-delivery.test.ts. Needs the `claude` CLI + a built dist/.
 */
import {
  runHarnessTest,
  scriptModel,
  claudeAvailable,
} from "../../dist/harness-test.js";
import { requestContains, skip } from "../../dist/harness-assert.js";
import { claudeCodeHookProtocol } from "../../dist/adapters/claude-code/hook-protocol.js";
import { onPathClaudeVersion } from "../../dist/dialect-drift.js";

// Loud skip, never a silent pass: the alarm only means something where the real
// binary is present.
if (!claudeAvailable()) {
  skip(
    "`claude` CLI not found — injectable-event delivery is a claim about the real binary",
  );
}

const version = onPathClaudeVersion() ?? "unknown";
const declared = claudeCodeHookProtocol.injectableEvents;

/**
 * How to make each declared event fire in THIS fixture. An event absent here
 * cannot be measured, and that is a FAILURE rather than a skip — otherwise
 * adding a fourth entry to `injectableEvents` would silently widen a claim that
 * nothing checks.
 */
const PROVOCATION = {
  SessionStart: {},
  UserPromptSubmit: {},
  // Tool events only fire for a matching tool; the model script below writes.
  PostToolUse: { matcher: "Edit|Write" },
};

const unprovokable = declared.filter((e) => !(e in PROVOCATION));
if (unprovokable.length > 0) {
  console.log(
    `  ✗ injectableEvents declares ${unprovokable.join(", ")}, which this test ` +
      `cannot provoke. Add an entry to PROVOCATION (and a way to trigger it) — a ` +
      `declared event that is never measured is exactly the gap this test exists to close.\n\n1 failed.`,
  );
  process.exit(1);
}

/** The marker a given event's hook injects, and greps for in the request. */
const markerFor = (event) => `VIGILES_INJECT_${event.toUpperCase()}`;

/**
 * One script serves every event — two copies could differ, and then a difference
 * in delivery would not be attributable to the event. It records that it RAN
 * (ground truth on disk) and then emits the injection payload.
 */
const HOOK_SCRIPT = `
const fs = require("node:fs");
const [, , ledger, event, marker] = process.argv;
fs.appendFileSync(ledger, event + "\\n");
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: marker + " delivered" },
  }) + "\\n",
);
process.exit(0);
`;

const hooks = {};
for (const event of declared) {
  const entry = {
    hooks: [
      {
        type: "command",
        command: `node {cwd}/inject.cjs {cwd}/fired.ndjson ${event} ${markerFor(event)}`,
      },
    ],
  };
  const { matcher } = PROVOCATION[event];
  if (matcher) entry.matcher = matcher;
  hooks[event] = [entry];
}

const r = await runHarnessTest({
  files: { "inject.cjs": HOOK_SCRIPT },
  settings: { hooks },
  model: scriptModel([
    // A neutral file on purpose: Claude Code has its own PostToolUse handling for
    // memory files (CLAUDE.md), and this measures OUR hook, not that path.
    { tool: "Write", input: { file_path: "notes.md", content: "hello\n" } },
    { text: "done" },
  ]),
  prompt: "Write one short note.",
  allowedTools: ["Write"],
  timeoutMs: 120_000,
  sandbox: false,
});

try {
  const fired = new Set(
    (r.file("fired.ndjson") ?? "").split("\n").filter(Boolean),
  );
  const landed = new Set(
    declared.filter((e) => requestContains(r, markerFor(e))),
  );

  for (const e of declared) {
    console.log(
      `  ${landed.has(e) ? "✓" : "✗"} ${e.padEnd(17)} fired=${String(fired.has(e)).padEnd(5)} landed=${String(landed.has(e))}`,
    );
  }

  // CONTROL FIRST, in three widening steps. Without these an empty result would
  // "prove" the claim while actually proving the session never ran.
  if (r.modelRequests.length === 0) {
    throw new Error(
      `no model requests were captured, so this run measured nothing ` +
        `(claude ${version}) — the fixture is broken, not the product`,
    );
  }

  const neverFired = declared.filter((e) => !fired.has(e));
  if (neverFired.length > 0) {
    throw new Error(
      `${neverFired.join(", ")} never fired at all under claude ${version}, so ` +
        `delivery could not be measured for ${neverFired.length === 1 ? "it" : "them"}. ` +
        `That is this fixture failing to provoke the event — fix PROVOCATION before ` +
        `reading anything into the delivery result`,
    );
  }

  if (landed.size === 0) {
    throw new Error(
      `NONE of the declared events delivered under claude ${version}. Every hook ` +
        `fired, so this is either a total injection regression or a broken fixture — ` +
        `with no in-run control that landed, this run cannot tell you which`,
    );
  }

  // THE CLAIM: the list is supposed to mean "these deliver". Anything declared
  // and not delivered makes `injectableEvents` false for this Claude Code.
  const dropped = declared.filter((e) => !landed.has(e));
  if (dropped.length > 0) {
    throw new Error(
      `claude ${version} ACCEPTED and DROPPED additionalContext on ${dropped.join(", ")} — ` +
        `the hook fired and emitted the payload, and it never reached the model, ` +
        `while ${[...landed].join(", ")} delivered in the SAME session. ` +
        `claudeCodeHookProtocol.injectableEvents still declares [${declared.join(", ")}], ` +
        `so that declaration is FALSE on this version (see zernie/vigiles#231). ` +
        `Fix the declaration or the pin — do not weaken this test`,
    );
  }

  console.log(
    `  ✓ every declared injectable event delivered under claude ${version}`,
  );
  console.log("\n1 passed.");
} catch (err) {
  console.log(`  ✗ ${err.message}\n\n1 failed.`);
  r.cleanup();
  process.exit(1);
}
r.cleanup();
