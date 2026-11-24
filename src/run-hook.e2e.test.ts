/**
 * e2e tier — allowlisted REAL egress (`egress: { allow }`).
 *
 * These need a routable rootless sandbox (bwrap + slirp4netns/pasta + nft) AND
 * real outbound network. The import path no longer says so: the barrels split on
 * COST, not on capability, so `runHook` comes from the free root surface;
 * `egressRoutes` is internal (`./run-hook.js`). What routes this file to the expensive tier is its `.e2e.test.ts`
 * NAME, read by the vitest `e2e` project. Gated by `egressRoutes()` so they run for
 * real where egress actually routes and skip honestly where it can't (e.g. a
 * GitHub-hosted runner whose slirp4netns never attaches `tap0`) instead of
 * failing red — see research/egress-sandbox-tooling.md (pasta is the fix that
 * makes them run in CI too).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";

import { runHook, egressRoutes } from "./run-hook.js";

const egressOk = egressRoutes();

test.skipIf(!egressOk)(
  "egress allowlist: reaches an allowed host, drops everything else at the packet layer",
  () => {
    // A hook that hits BOTH an allowlisted host and a non-allowlisted one. The
    // allowlisted one is reached (and recorded); the other is dropped — and so is
    // a raw socket, proving the boundary is the packet layer, not a proxy env var.
    const cmd = [
      "curl -s -m 12 -o /dev/null https://example.com/ || true",
      "curl -s -m 6 -o /dev/null https://1.1.1.1/ || true",
      'timeout 5 bash -c "exec 3<>/dev/tcp/9.9.9.9/443" 2>/dev/null || true',
    ].join("; ");
    const r = runHook(
      cmd,
      { hook_event_name: "PreToolUse" },
      { egress: { allow: ["example.com"] }, timeoutMs: 30000 },
    );
    // the allowlisted host was actually reached, and is recorded as allowed
    const reached = r.egress.find((e) => e.host === "example.com");
    assert.ok(
      reached?.allowed && (reached.packets ?? 0) > 0,
      `expected example.com to be reached; got ${JSON.stringify(r.egress)}`,
    );
    // everything off the allowlist (1.1.1.1 + the raw 9.9.9.9 socket) was dropped
    assert.ok(
      (r.egressDropped?.packets ?? 0) > 0,
      `expected off-allowlist traffic to be dropped; got ${JSON.stringify(r.egressDropped)}`,
    );
  },
);

test.skipIf(!egressOk)(
  "dogfood: oh-my-claudecode's session-start reaches the npm registry and NOTHING else",
  () => {
    // The recordEgress dogfood proves OMC's SessionStart update-check phones the
    // npm registry; this proves the SAME thing through the allowlist path — the
    // fetch actually SUCCEEDS to registry.npmjs.org (allowed), and the drop
    // counter stays 0 (it reached nowhere off the allowlist).
    const root = join(process.cwd(), "test/dogfood/oh-my-claudecode@deee3a4");
    const ws = mkdtempSync(join(tmpdir(), "omc-ws-"));
    writeFileSync(join(ws, ".omc-workspace"), "");
    const state = mkdtempSync(join(tmpdir(), "omc-state-"));
    const r = runHook(
      `node "${root}/scripts/run.cjs" "${root}/scripts/session-start.mjs"`,
      { hook_event_name: "SessionStart", source: "startup" },
      {
        egress: { allow: ["registry.npmjs.org"] },
        cwd: ws,
        env: { CLAUDE_PLUGIN_ROOT: root, OMC_STATE_DIR: state },
        timeoutMs: 40000,
      },
    );
    assert.ok(
      r.egress.some((e) => e.host === "registry.npmjs.org" && e.allowed),
      `expected the update check to reach the npm registry; got ${JSON.stringify(r.egress)}`,
    );
    // The wall let ONLY the npm registry THROUGH. We assert what passed the
    // allowlist, not OMC's exact off-allowlist packet count: a stray packet to
    // some other host (e.g. a DNS/CDN attempt) varies by environment and is
    // DROPPED — that's the wall working, not a failure (the other e2e test proves
    // drops happen). So the dogfood claim is "OMC reaches npm and nothing else
    // gets through," which is exactly: the only allowed host is the npm registry.
    const allowedHosts = [
      ...new Set(r.egress.filter((e) => e.allowed).map((e) => e.host)),
    ];
    assert.deepEqual(
      allowedHosts,
      ["registry.npmjs.org"],
      `only the npm registry should pass the allowlist; got ${JSON.stringify(r.egress)}`,
    );
  },
);
