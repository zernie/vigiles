/**
 * ONE HOOK INVENTORY. "Which hooks exist" had four owners — the identity
 * reader, an `inline` count printed as "no script file" (#443), a regex over
 * the raw manifest for coverage that never read a plugin's `hooks/hooks.json`
 * (#283), and the empty-surface test (#199). These pin that every consumer
 * reads the same inventory, on both engines (disk and file map) and both
 * adapters, by asserting typed values — never printed text.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scanPlugin } from "./scan.js";
import { fileMapHookInventory, scanFiles } from "./scan-files.js";
import type { HookInventory } from "./scan-core.js";
import { findUntestedSurfaces } from "./test-coverage.js";
import { buildAuditReport } from "./audit-report.js";
import { applyRules } from "./core/apply-rules.js";
import { RULES, RULE_GROUPS } from "./rules/index.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import {
  hookGateRef,
  hookRuntimeRef,
  runProgramCommand,
} from "./core/hook-command.js";
import { withRoleExit } from "./core/hook-program.js";
import type { PluginLayout } from "./core/layout.js";
import { ADAPTERS } from "./adapter-registry.js";

type Files = Readonly<Record<string, string>>;

/** A `hooks` block registering `commands` under `event`, in the nested shape both harnesses read. */
const hooksBlock = (event: string, commands: readonly string[]) => ({
  hooks: {
    [event]: commands.map((command) => ({
      matcher: "Bash",
      hooks: [{ type: "command", command }],
    })),
  },
});

/** The instruction file and a settings file registering PreToolUse lines, in the layout's own encoding. */
function settings(layout: PluginLayout, ...commands: readonly string[]): Files {
  return {
    [layout.instructionFile]: "# x\n",
    [layout.settingsPath]: layout.settings.render(
      hooksBlock("PreToolUse", commands),
    ),
  };
}

/** The layout's hook-convention file registering one PostToolUse line. */
function pluginHooks(layout: PluginLayout, command: string): Files {
  if (layout.hooksConventionPath === undefined)
    throw new Error(`${layout.name} declares no hook-convention file`);
  return {
    [layout.hooksConventionPath]: JSON.stringify(
      hooksBlock("PostToolUse", [command]),
    ),
  };
}

const PROGRAM = ".vigiles/hooks/guard.hook.mjs";

/** A compiled hook's source and stamp, and the exact line compile writes for it. */
function compiledHook(layout: PluginLayout): {
  readonly files: Files;
  readonly line: string;
} {
  const tokens = layout.projectRootTokens;
  return {
    files: {
      [PROGRAM]: "export default {};\n",
      [`${PROGRAM}.json`]: JSON.stringify({ stamp: "s", role: "react" }),
    },
    line: withRoleExit(
      runProgramCommand(hookRuntimeRef(tokens), hookGateRef(PROGRAM, tokens)),
      "react",
    ),
  };
}

/** Write `files` under a fresh dir, run `body`, clean up. */
function onDisk<T>(files: Files, body: (dir: string) => T): T {
  const dir = makeTmpDir("hook-inventory");
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return body(dir);
  } finally {
    cleanupTmpDir(dir);
  }
}

const allOn = { mayFire: () => true };

describe.each(
  ADAPTERS.map((a) => ({ name: a.name, layout: a.layout, dialect: a.dialect })),
)("one hook inventory ($name)", (h) => {
  // The #443 repro: a hand-written line that runs a script in the repo.
  const handWritten = {
    ...settings(h.layout, "bash scripts/guard.sh"),
    "scripts/guard.sh": "#!/usr/bin/env bash\nexit 0\n",
  };

  it("a hand-written line that runs a script is hand-written, never a missing script file (#443)", () => {
    const disk = onDisk(handWritten, (dir) =>
      scanPlugin(dir, h.layout, h.dialect),
    );
    const map = scanFiles(handWritten, h.layout, h.dialect);
    for (const r of [disk, map]) {
      expect(r.hookInventory.map((e) => e.line.kind)).toEqual(["hand-written"]);
      expect(r.hookInventory.map((e) => e.source)).toEqual(["loaded"]);
      // No file is checked for a line vigiles did not write.
      expect(r.hooks).toEqual([]);
    }
  });

  it("hand-written lines are not untested surfaces: their coverage is not measured", () => {
    const report = onDisk(handWritten, (dir) =>
      findUntestedSurfaces({ basePath: dir, layout: h.layout }),
    );
    expect(report.untested.filter((s) => s.kind === "hook")).toEqual([]);
    expect(report.unmeasuredHookLines).toBe(1);
    const map = scanFiles(handWritten, h.layout, h.dialect);
    expect(map.untested).toBe(0);
  });

  it("a compiled hook declared only in a plugin's hook-convention file is a coverage surface (#283)", () => {
    const compiled = compiledHook(h.layout);
    const files = {
      ...pluginHooks(h.layout, compiled.line),
      ...compiled.files,
    };
    const hooks = (kinds: readonly { kind: string; path: string }[]) =>
      kinds.filter((s) => s.kind === "hook").map((s) => s.path);
    const disk = onDisk(files, (dir) => ({
      coverage: findUntestedSurfaces({ basePath: dir, layout: h.layout }),
      scan: scanPlugin(dir, h.layout, h.dialect),
    }));
    // Exactly the program — not the runtime under node_modules, not the stamp.
    expect(hooks(disk.coverage.untested)).toEqual([PROGRAM]);
    expect(disk.coverage.unmeasuredHookLines).toBe(0);
    expect(disk.scan.untested).toBe(1);
    const map = scanFiles(files, h.layout, h.dialect);
    expect(map.hookInventory.map((e) => e.line.kind)).toEqual(["compiled"]);
    expect(map.untested).toBe(1);
  });
});

describe.each(
  ADAPTERS.map((a) => ({ name: a.name, layout: a.layout, dialect: a.dialect })),
)("the hook inventory count ($name)", (h) => {
  it("the inventory count is the number of hook LINES, one unit", () => {
    const compiled = compiledHook(h.layout);
    const files = {
      ...settings(h.layout, "bash scripts/guard.sh", compiled.line),
      ...compiled.files,
    };
    const disk = onDisk(files, (dir) => scanPlugin(dir, h.layout, h.dialect));
    const map = scanFiles(files, h.layout, h.dialect);
    for (const r of [disk, map]) {
      // The compiled line needs three files (runtime, program, stamp); the
      // count is still one per line.
      expect(r.hooks.length).toBe(3);
      const audit = buildAuditReport(applyRules(RULES, RULE_GROUPS, allOn, r), {
        harness: h.name,
        vigilesVersion: "0.0.0",
      });
      expect(audit.inventory.hooks).toBe(r.hookInventory.length);
      expect(audit.inventory.hooks).toBe(2);
    }
  });
});

/**
 * EVERY DECLARED HARNESS (#447 review, a slice of #324). The loader keeps the
 * FIRST harness's hooks — that is what a run executes — and the inventory used
 * to be built from that choice, so a repo declaring one harness before another
 * lost the second one's hooks from the Hooks block, the count and coverage.
 */
type Harness = (typeof ADAPTERS)[number];
const scanHarness = (a: Harness) => ({
  layout: a.layout,
  dialect: a.dialect,
  roots: [],
});
const lines = (inv: HookInventory) =>
  inv.map((e) => [e.harness.name, e.line.kind, e.command]);
/** The same lines in a fixed order, to compare as a set. */
const asSet = (rows: readonly (readonly string[])[]) =>
  [...rows].sort((x, y) => x.join("\0").localeCompare(y.join("\0")));

/** Every ordered pair of distinct registered adapters. */
const PAIRS = ADAPTERS.flatMap((a) =>
  ADAPTERS.filter((b) => b.name !== a.name).map((b) => ({
    names: `${a.name} hand-written, ${b.name} compiled`,
    handWrittenIn: a,
    compiledIn: b,
  })),
);

/** A hand-written line in one harness's settings, an untested compiled hook in the other's. */
function twoHarnessRepo(a: Harness, b: Harness) {
  const hook = compiledHook(b.layout);
  return {
    files: {
      ...settings(a.layout, "bash scripts/guard.sh"),
      "scripts/guard.sh": "#!/usr/bin/env bash\nexit 0\n",
      ...settings(b.layout, hook.line),
      ...hook.files,
    },
    expected: [
      [a.name, "hand-written", "bash scripts/guard.sh"],
      [b.name, "compiled", hook.line],
    ],
  };
}

/** Both engines' inventories of `files`, declaring `order`. */
function inventories(files: Files, order: readonly Harness[]) {
  const layouts = order.map((h) => h.layout);
  return {
    disk: lines(scanDeclaring(files, order).scan.hookInventory),
    map: lines(fileMapHookInventory(files, layouts)),
  };
}

/** The disk scan and the disk coverage of `files`, declaring `order`. */
function scanDeclaring(files: Files, order: readonly Harness[]) {
  const [first] = order;
  if (first === undefined) throw new Error("no harness declared");
  return onDisk(files, (dir) => ({
    scan: scanPlugin(dir, first.layout, first.dialect, {
      harnesses: order.map(scanHarness),
    }),
    coverage: findUntestedSurfaces({
      basePath: dir,
      layout: first.layout,
      harnessLayouts: order.map((h) => h.layout),
    }),
  }));
}

describe.each(PAIRS)(
  "the hook inventory reads every declared harness ($names)",
  (p) => {
    const repo = twoHarnessRepo(p.handWrittenIn, p.compiledIn);
    const orders = [
      [p.handWrittenIn, p.compiledIn],
      [p.compiledIn, p.handWrittenIn],
    ] as const;

    it.each(orders)(
      "declared %s first: both lines are inventoried, the compiled one is an untested surface",
      (...order) => {
        const disk = scanDeclaring(repo.files, order);
        expect(asSet(lines(disk.scan.hookInventory))).toEqual(
          asSet(repo.expected),
        );
        const audit = buildAuditReport(
          applyRules(RULES, RULE_GROUPS, allOn, disk.scan),
          { harness: order[0].name, vigilesVersion: "0.0.0" },
        );
        expect(audit.inventory.hooks).toBe(2);
        expect(
          disk.coverage.untested
            .filter((s) => s.kind === "hook")
            .map((s) => s.path),
        ).toEqual([PROGRAM]);
        expect(disk.coverage.unmeasuredHookLines).toBe(1);
        expect(disk.scan.untested).toBe(1);
        // The compiled line's files are read under ITS harness's root variables:
        // the program is found, whichever harness is declared first.
        expect(
          disk.scan.hooks
            .filter((h) => h.script.endsWith(PROGRAM))
            .map((h) => h.status),
        ).toEqual(["ok"]);
        // The file-map engine's inventory over the same declaration.
        const map = fileMapHookInventory(
          repo.files,
          order.map((h) => h.layout),
        );
        expect(lines(map)).toEqual(lines(disk.scan.hookInventory));
      },
    );

    it("the declaration order does not change the inventory, on either engine", () => {
      const [one, other] = orders.map((order) =>
        inventories(repo.files, order),
      );
      expect(one).toEqual(other);
    });
  },
);

describe.each(ADAPTERS.map((a) => ({ name: a.name, harness: a })))(
  "one file, two harnesses ($name)",
  ({ harness }) => {
    it("a file two declared harnesses both read is inventoried once", () => {
      // A second harness whose files ARE this harness's files.
      const mirror = {
        ...harness,
        layout: { ...harness.layout, name: `${harness.name}-mirror` },
      };
      const hook = compiledHook(harness.layout);
      const files = { ...settings(harness.layout, hook.line), ...hook.files };
      for (const order of [
        [harness, mirror],
        [mirror, harness],
      ] as const) {
        const disk = onDisk(files, (dir) =>
          scanPlugin(dir, order[0].layout, harness.dialect, {
            harnesses: order.map(scanHarness),
          }),
        );
        const want = [[harness.name, "compiled", hook.line]];
        expect(lines(disk.hookInventory)).toEqual(want);
        expect(
          lines(
            fileMapHookInventory(
              files,
              order.map((h) => h.layout),
            ),
          ),
        ).toEqual(want);
      }
    });

    it("the file-map scan tags its one harness", () => {
      const map = scanFiles(
        settings(harness.layout, "bash scripts/guard.sh"),
        harness.layout,
        harness.dialect,
      );
      expect(lines(map.hookInventory)).toEqual([
        [harness.name, "hand-written", "bash scripts/guard.sh"],
      ]);
    });
  },
);
