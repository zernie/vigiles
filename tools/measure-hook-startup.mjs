#!/usr/bin/env node
/**
 * MEASURE what a compiled hook costs to START — the ground truth behind issue
 * #216 and behind the lazy-load boundaries in `src/cli.ts`,
 * `src/core/hook-program.ts`, `src/hook-install.ts` and `src/core/bash-effects.ts`.
 *
 * A hook runs on EVERY matching tool call, so its startup cost is paid per tool
 * call, not per session. The competitors are a `grep` on stdin (~12 ms) and a
 * python script (~35 ms), so "hundreds of milliseconds" is not a rounding error
 * — it is the whole reason someone keeps the shell hook.
 *
 * Nothing here is argued. Each row spawns a real process N times and divides.
 * Two kinds of row:
 *
 *   LAYER  — `node -e 'require(<module>)'`, which prices ONE module's whole
 *            require graph against a bare `node -e ''` baseline. This is what
 *            says WHERE the time goes, and it is why the fix was a set of
 *            lazy boundaries rather than a guess.
 *   E2E    — a real `hook-runtime run-program` over a real hook file, piping a
 *            real event on stdin. This is the number a user actually feels.
 *
 * The E2E rows are split by hook ROLE on purpose: a file gate, an inject and a
 * stop gate never touch the shell parser, so they must not pay for it. A bash
 * gate does parse, and is expected to be the slowest row — that cost is real
 * work, not overhead.
 *
 * Run (from the repo root, after `npm run build`):
 *   node tools/measure-hook-startup.mjs
 *   node tools/measure-hook-startup.mjs --runs=40
 *
 * ⚠️ These numbers are MACHINE-SPECIFIC and drift with the Node version. Re-run
 * it; do not quote a stale figure. What is asserted deterministically — and so
 * cannot rot — is the MODULE GRAPH, in `src/hook-runtime-graph.test.ts`.
 *
 * Measured 2026-09-08, Node 22.22.2, this container, --runs=20 — BEFORE is the
 * tree at 04f2c2a, AFTER is the same tree with #216's lazy boundaries:
 *
 *   layer                                    before → after
 *   bare `node -e ''`                            42 →  41 ms
 *   require dist/core/hook-program.js           170 →  64 ms
 *   require dist/hook.js                        171 →  64 ms
 *   require dist/cli.js                         623 → 504 ms
 *   require @iarna/toml                          56 ms  (compile-time only)
 *   require mvdan-sh                            144 ms  (bash predicates only)
 *
 *   end-to-end run-program                    before → after
 *   bash gate (safe-bash-guard.mjs)             661 → 199 ms   (3.3x)
 *   file gate                                   628 →  80 ms   (7.9x)
 *   inject                                      610 →  83 ms   (7.3x)
 *
 * ⚠️ The `dist/cli.js` row does NOT measure a bare load in either tree: `cli.js`
 * is the bin, so requiring it RUNS it, and with no argv it prints usage. It is
 * kept because it is the number issue #216 quoted, and because the barrel being
 * roughly as heavy as before is the POINT — nothing was made faster, the hook
 * simply stopped loading it. (The 623 → 504 drop is the two now-lazy
 * `@iarna/toml` edges, which the barrel also went through.)
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
/** The built `vigiles/hook` entry, imported by absolute path so a fixture in
 *  a tmpdir resolves it without an install. */
const HOOK_ENTRY = join(ROOT, "dist", "hook.js");
const RUNS = Number(
  (process.argv.find((a) => a.startsWith("--runs=")) ?? "").split("=")[1] || 20,
);

/** Median wall-clock of N spawns, in ms — median, because one GC pause skews a mean. */
function timeSpawn(argv, { stdin = undefined } = {}) {
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, argv, {
      cwd: ROOT,
      input: stdin,
      stdio: ["pipe", "ignore", "ignore"],
    });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const EVENT = {
  bash: JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
  }),
  file: JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "notes/x.md" },
  }),
  prompt: JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
  }),
};

/**
 * Author the non-bash hooks here rather than vendoring fixtures: the point of
 * the row is the ROLE (which import graph the runtime walks), and a hook written
 * inline cannot drift away from the role it claims to measure.
 */
const HOOKS = {
  "file gate": {
    event: EVENT.file,
    source: `import { experimental_defineFileGate, tools, allow } from __HOOK__;
export default experimental_defineFileGate({
  on: "PreToolUse",
  match: tools("Write", "Edit"),
  decide: () => allow(),
});
`,
  },
  inject: {
    event: EVENT.prompt,
    source: `import { experimental_defineInject, inject } from __HOOK__;
export default experimental_defineInject({
  on: "UserPromptSubmit",
  produce: () => inject("hi"),
});
`,
  },
};

function row(label, ms) {
  console.log(`  ${String(Math.round(ms)).padStart(5)} ms   ${label}`);
}

const tmp = mkdtempSync(join(tmpdir(), "vigiles-startup-"));
try {
  console.log(`\nnode ${process.version} · median of ${RUNS} spawns\n`);

  console.log("LAYER — what one require costs (whole graph):");
  row("bare `node -e ''`", timeSpawn(["-e", ""]));
  for (const mod of [
    "./dist/core/hook-program.js",
    "./dist/hook.js",
    "./dist/cli.js",
    "@iarna/toml",
    "mvdan-sh",
  ]) {
    row(`require ${mod}`, timeSpawn(["-e", `require(${JSON.stringify(mod)})`]));
  }

  console.log("\nE2E — a real `hook-runtime run-program`, by hook role:");
  // The bash gate is the shipped dogfood artifact, so this row prices the guard
  // behind the public 7/7 claim rather than a toy.
  row(
    "bash gate (examples/harness/safe-bash-guard.mjs)",
    timeSpawn(
      [
        "dist/cli.js",
        "hook-runtime",
        "run-program",
        "examples/harness/safe-bash-guard.mjs",
      ],
      { stdin: EVENT.bash },
    ),
  );
  for (const [label, hook] of Object.entries(HOOKS)) {
    const file = join(tmp, `${label.replace(/\W+/g, "-")}.mjs`);
    writeFileSync(
      file,
      hook.source.replace(/__HOOK__/g, JSON.stringify(HOOK_ENTRY)),
    );
    // A hook that failed to LOAD exits 2 in a few ms and would read as a
    // spectacular speedup. Prove it decided before timing it.
    const probe = spawnSync(
      process.execPath,
      ["dist/cli.js", "hook-runtime", "run-program", file],
      { cwd: ROOT, input: hook.event, encoding: "utf-8" },
    );
    if (probe.status !== 0) {
      throw new Error(
        `the ${label} fixture did not decide (exit ${probe.status}): ${probe.stderr}`,
      );
    }
    row(
      label,
      timeSpawn(["dist/cli.js", "hook-runtime", "run-program", file], {
        stdin: hook.event,
      }),
    );
  }
  console.log("");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
