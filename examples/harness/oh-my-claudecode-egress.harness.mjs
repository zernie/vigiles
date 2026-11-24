/**
 * oh-my-claudecode walkthrough — sandbox: record + block network egress.
 *
 * Testing a third-party hook means running ITS code. `recordEgress` confines the
 * hook under bubblewrap (no egress, read-only host, cleared env) AND records
 * every `host:port` a proxy-honoring tool tries to reach — so you can assert what
 * a hook/skill phones home to (supply-chain / "what would its install hit?").
 *
 * Here we run OMC's REAL, vendored `keyword-detector` hook under `recordEgress`
 * and assert it reaches out to NOTHING — while still doing its job.
 *
 *   npx vigiles test examples/harness/oh-my-claudecode-egress.harness.mjs
 *   node examples/harness/oh-my-claudecode-egress.harness.mjs        # standalone
 *
 * Needs Linux + bubblewrap (and working user namespaces). Self-skips otherwise —
 * you can't record egress where you can't confine. External users import from the
 * package: `from "vigiles"`.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runHook } from "../../dist/run-hook.js";
import { sandboxAvailable } from "../../dist/sandbox.js";
import { assertEgressOnly, skip } from "../../dist/harness-assert.js";

// `skip()`, not `exit(0)`: this file used to report itself SKIPPED in prose and
// then exit clean, which the runner could only read as a pass — the same
// "verified nothing, looked green" shape the ∅ state exists to surface. It was
// caught by that state on the repo's own examples the day it landed.
if (!sandboxAvailable()) {
  skip("no working bubblewrap sandbox (can't confine → can't record egress)");
}

const ROOT = fileURLToPath(
  new URL("../../test/dogfood/oh-my-claudecode@deee3a4", import.meta.url),
);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

// 1. The real third-party hook, confined + recorded → it phones home to nothing.
check("oh-my-claudecode keyword-detector makes zero egress", () => {
  const r = runHook(
    `node "${ROOT}/scripts/run.cjs" "${ROOT}/scripts/keyword-detector.mjs"`,
    { hook_event_name: "UserPromptSubmit", prompt: "please ultrawork on this" },
    { recordEgress: true, env: { CLAUDE_PLUGIN_ROOT: ROOT }, timeoutMs: 30000 },
  );
  if (!/ULTRAWORK/.test(r.json?.hookSpecificOutput?.additionalContext ?? "")) {
    throw new Error("the hook should still inject its routing");
  }
  assertEgressOnly(r, []); // …and reach out to nothing
});

// 2. A REAL finding: OMC's session-start hook update-checks the npm registry on
// every session start. Record it (a Node fetch, via the proxy) and prove it
// phones the npm registry and NOTHING else — while the netns blocks it.
// (Capturing a Node fetch() needs NODE_USE_ENV_PROXY → Node 22+.)
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.log(
    "  – session-start update-check skipped (capturing fetch() needs Node 22+)",
  );
} else {
  check("session-start update-checks ONLY the npm registry", () => {
    const ws = mkdtempSync(join(tmpdir(), "omc-ws-")); // a workspace anchor
    writeFileSync(join(ws, ".omc-workspace"), "");
    const r = runHook(
      `node "${ROOT}/scripts/run.cjs" "${ROOT}/scripts/session-start.mjs"`,
      { hook_event_name: "SessionStart", source: "startup" },
      {
        recordEgress: true,
        cwd: ws,
        env: {
          CLAUDE_PLUGIN_ROOT: ROOT,
          OMC_STATE_DIR: mkdtempSync(join(tmpdir(), "omc-state-")),
        },
        timeoutMs: 30000,
      },
    );
    const hit = r.egress.find((e) => e.host === "registry.npmjs.org");
    if (!hit) {
      throw new Error(
        `expected the update check recorded; got ${JSON.stringify(r.egress)}`,
      );
    }
    assertEgressOnly(r, ["registry.npmjs.org"]);
    console.log(
      `      (recorded ${hit.host}:${hit.port} — its update check — and blocked it)`,
    );
  });
}

console.log(failed === 0 ? "\nok" : `\n${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
