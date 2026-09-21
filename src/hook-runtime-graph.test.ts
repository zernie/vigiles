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

// ---------------------------------------------------------------------------
// THE FIFTH LAZY BOUNDARY: the harness-test DRIVER, behind a thunk on the
// adapter (`HarnessAdapter.harnessTestDriver`).
//
// The react role is the one that reaches the adapter registry, and an adapter
// used to HOLD its driver. A driver lives in `harness-test.ts`, which imports
// the conformance suite, which imports the compiler, which imports the
// cross-language symbol index, which loads a NATIVE `.node` binary. So every
// react hook — on every matching tool call — loaded the test harness and a
// native module to read one event table.
//
// Measured 2026-09-19, `require("./dist/adapter-registry.js")`:
//
//     eager thunk:  107 modules, 7 ast-grep, 1 native .node,  95 ms
//     lazy  thunk:   18 modules, 0 ast-grep, 0 native .node,   6 ms
//
// ...against a `resolveAdapter()` whose own work is about one millisecond.
// ---------------------------------------------------------------------------
describe("the harness-test driver is not on the hook path", () => {
  function reactFixture(): string {
    const p = join(dir, "react.mjs");
    writeFileSync(
      p,
      `import { experimental_defineReact, tools, nothing } from ${JSON.stringify(HOOK_DIST)};
export default experimental_defineReact({
  on: "PostToolUse",
  match: tools("Edit"),
  react: () => nothing(),
});
`,
    );
    return p;
  }

  test("a react run loads NEITHER the test harness NOR a native binary", () => {
    const graph = graphOf(
      ["hook-runtime", "run-program", reactFixture()],
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "notes/x.md" },
      }),
    );
    // The react role DOES reach the registry — that is the point of the probe.
    expect(
      has(graph, "adapter-registry"),
      "react must reach the registry",
    ).toBe(true);
    expect(has(graph, "harness-test")).toBe(false);
    expect(has(graph, "adapter-conformance")).toBe(false);
    expect(has(graph, "ast-grep")).toBe(false);
    // 🔴 THE TWO PARSERS THE INSTRUCTION CHAIN NEEDS, NAMED HERE BECAUSE THEY
    // WERE BRIEFLY ON THIS PATH. `claudeCodeLayout.instructionChain` reaches
    // `minimatch` (claudeMdExcludes) and `markdown-it` (reading prose without
    // code fences), and the layout IS on the hook path — a top-level import of
    // the chain implementation took this graph from 37 modules to 92. It is
    // lazily required for that reason; these two assertions say which names the
    // ceiling below was defending against, so the next reader does not have to
    // bisect to find out.
    expect(has(graph, "minimatch")).toBe(false);
    expect(has(graph, "markdown-it")).toBe(false);
    // And the third, found only because the CEILING below fired after the first
    // two were fixed: a rule's `paths:` frontmatter decides whether it loads, so
    // the chain reaches the frontmatter reader and through it `js-yaml`. Each
    // named assertion here was added AFTER the count caught something it could
    // not have been told to look for — which is the argument for keeping both.
    expect(has(graph, "js-yaml")).toBe(false);
    expect(graph.some((m) => m.endsWith(".node"))).toBe(false);

    // 🔴 AND A CEILING, because every assertion above names something we ALREADY
    // know is heavy, and by construction none of them can catch the next heavy
    // thing under a name nobody thought to write down. The count is the only
    // check here that does not need to be told what to look for.
    //
    // A CEILING WITH HEADROOM, not an exact ratchet: pinning the number makes
    // every honest one-module addition a failing build, and a check that cries
    // on correct work gets its number bumped without being read, which is how a
    // gate becomes a formality. The bound is roughly double the real figure —
    // routine growth passes, a graph explosion does not.
    //
    // Measured 2026-09-19: 37 modules; 2026-09-21: 46, after the instruction
    // chain put `core/instruction-chain.js`, the chain implementation and the
    // frontmatter/markdown readers on the path. The three PARSERS they reach
    // stay off it, lazily required — see above. Identical across runs (the count
    // is the repo's own CJS graph, so it is deterministic, not sampled). The
    // eager-driver tree this test was written against loaded 107 from
    // `adapter-registry` ALONE, so the bound catches that regression with room
    // to spare. Re-measure before raising it, and say in the commit what was
    // added; a bound raised without a reason is a bound that has stopped
    // meaning anything.
    expect(
      graph.length,
      `react graph grew to ${graph.length} modules — re-measure and justify before raising the bound`,
    ).toBeLessThan(60);
  });

  // The other direction, because an "is absent" assertion that can never fail is
  // worth nothing: CALLING the thunk is what loads the driver.
  test("...but CALLING the thunk loads it, so the test tier still gets a driver", async () => {
    const registry = (await import("./adapter-registry.js")) as {
      resolveAdapter: (root: string) => {
        harnessTestDriver?: () => Promise<unknown>;
      };
    };
    const adapter = registry.resolveAdapter(REPO_ROOT);
    expect(typeof adapter.harnessTestDriver).toBe("function");
    expect(await adapter.harnessTestDriver?.()).toBeDefined();
  });
});
