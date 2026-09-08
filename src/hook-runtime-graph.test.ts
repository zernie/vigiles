/**
 * The MODULE-GRAPH invariant behind the hook runtime's startup cost (#216).
 *
 * A compiled hook runs on every matching tool call, so what `vigiles hook-runtime
 * run-program` LOADS is a user-visible cost, not an implementation detail. The
 * whole fix was a set of lazy boundaries: the CLI verb barrel behind the
 * dispatcher shim (`src/cli.ts`), `@iarna/toml` behind its two serialize sites
 * (`core/hook-program.ts`, `hook-install.ts`), `mvdan-sh` behind the first parse
 * (`core/bash-effects.ts`), and the adapter registry behind the react role
 * (`hook-runtime.ts`). Each of those is one convenient top-level `import` away
 * from being undone, silently, by someone who has no reason to suspect the file
 * they are editing is on a hot path.
 *
 * SO THIS ASSERTS THE GRAPH, NOT A DURATION. A timing threshold on a shared CI
 * runner is flaky and would be the first thing quarantined — #216 says so in as
 * many words. The graph is deterministic: same input, same modules, every run,
 * every machine. The NUMBERS live in `tools/measure-hook-startup.mjs`, which is
 * run by hand and re-measured rather than trusted.
 *
 * HOW IT OBSERVES: a `--require` preload dumps `Object.keys(require.cache)` on
 * exit of the REAL spawned CLI. The whole dist is CommonJS, so that cache IS the
 * graph — including the modules pulled in lazily DURING the decision, which is
 * exactly what a static import scan would miss.
 *
 * BOTH DIRECTIONS ARE ASSERTED, because an "is absent" test that can only ever
 * pass is worth nothing:
 *
 *   file gate → `mvdan-sh` ABSENT   (it never parses a command)
 *   bash gate → `mvdan-sh` PRESENT  (it does, and that cost is the work it asked for)
 *   `--help`  → `cli-main.js` PRESENT (the shim did not accidentally orphan the verbs)
 *
 * Harness scope (`test-both-harnesses`): ONE run covers both. Nothing here
 * branches on harness — the dispatcher reads argv, and the runtime's own
 * harness-specific edge (which events accept injected context) is read from the
 * resolved adapter behind a lazy require that only the react role reaches. The
 * emitted-command contract these boundaries must not disturb is asserted
 * per-harness in `src/hook-install.test.ts` / `src/hook.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");
/** The built `vigiles/hook` entry, as a file URL a tmpdir fixture can import. */
const HOOK_DIST = pathToFileURL(resolve(REPO_ROOT, "dist", "hook.js")).href;

/** The shipped dogfood bash gate — a real hook, not a toy, for the parser arm. */
const BASH_GATE = resolve(REPO_ROOT, "examples/harness/safe-bash-guard.mjs");

const PROBE = `const fs = require("node:fs");
process.on("exit", () => {
  try {
    fs.writeFileSync(process.env.VIGILES_GRAPH_OUT, Object.keys(require.cache).join("\\n"));
  } catch {}
});
`;

let dir: string;
let probe: string;

beforeAll(() => {
  dir = makeTmpDir();
  probe = join(dir, "probe.cjs");
  writeFileSync(probe, PROBE);
});

afterAll(() => {
  cleanupTmpDir(dir);
});

/** Run the REAL built CLI under the preload; return the CJS modules it loaded. */
function graphOf(args: string[], stdin = ""): string[] {
  const out = join(dir, `graph-${Math.random().toString(36).slice(2)}.txt`);
  const res = spawnSync(process.execPath, ["-r", probe, CLI, ...args], {
    cwd: REPO_ROOT,
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, VIGILES_GRAPH_OUT: out },
  });
  // A hook that failed to LOAD exits 2 in milliseconds and loads almost nothing
  // — which would make every "is absent" assertion below pass for the wrong
  // reason. Refuse to read a graph the run did not really produce.
  expect(
    res.status,
    `the probed run did not decide (exit ${String(res.status)}): ${res.stderr}`,
  ).toBe(0);
  return readFileSync(out, "utf-8").split("\n").filter(Boolean);
}

const has = (graph: string[], needle: string): boolean =>
  graph.some((m) => m.includes(needle));

function fileGateFixture(): string {
  const p = join(dir, "file-gate.mjs");
  writeFileSync(
    p,
    `import { experimental_defineFileGate, tools, allow } from ${JSON.stringify(HOOK_DIST)};
export default experimental_defineFileGate({
  on: "PreToolUse",
  match: tools("Write"),
  decide: () => allow(),
});
`,
  );
  return p;
}

const FILE_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "notes/x.md" },
});
const BASH_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
});

describe("hook-runtime module graph", () => {
  test("a decision never loads the CLI verb barrel", () => {
    const graph = graphOf(
      ["hook-runtime", "run-program", fileGateFixture()],
      FILE_EVENT,
    );
    expect(has(graph, "hook-runtime.js")).toBe(true);
    expect(
      has(graph, "cli-main.js"),
      "a hook decision pulled dist/cli-main.js — the ~85-import verb barrel " +
        "(compile/lint/audit/eval/init). Something added a top-level import to " +
        "src/cli.ts or src/hook-runtime.ts. Keep it lazy, inside the branch that " +
        "needs it. See tools/measure-hook-startup.mjs for what this costs.",
    ).toBe(false);
  });

  test("a decision never loads the TOML serializer (a compile-time dependency)", () => {
    const graph = graphOf(
      ["hook-runtime", "run-program", fileGateFixture()],
      FILE_EVENT,
    );
    expect(
      has(graph, "@iarna/toml"),
      "a hook decision pulled @iarna/toml, which only serializes a Codex " +
        "settings block at COMPILE time. Both of its call sites " +
        "(core/hook-program.ts, hook-install.ts) require it lazily — one of " +
        "them was hoisted back to the top.",
    ).toBe(false);
  });

  test("a NON-BASH decision never loads the shell parser", () => {
    const graph = graphOf(
      ["hook-runtime", "run-program", fileGateFixture()],
      FILE_EVENT,
    );
    expect(
      has(graph, "mvdan-sh"),
      "a file gate pulled mvdan-sh. It never inspects a command, so it must " +
        "not pay for the parser — core/bash-effects.ts requires it on first " +
        "parse, not at module load.",
    ).toBe(false);
  });

  test("a BASH decision DOES load the shell parser — the absence above is real", () => {
    // The other half of the pair. Without it, every assertion above would also
    // pass if the runtime had simply stopped working.
    const graph = graphOf(
      ["hook-runtime", "run-program", BASH_GATE],
      BASH_EVENT,
    );
    expect(has(graph, "mvdan-sh")).toBe(true);
    expect(has(graph, "cli-main.js")).toBe(false);
  });

  test("a VERB still loads the barrel — the shim did not orphan the verbs", () => {
    const graph = graphOf(["--help"]);
    expect(has(graph, "cli-main.js")).toBe(true);
  });
});
