/**
 * ONE HOOK INVENTORY. "Which hooks exist" had owners besides the identity
 * reader — an `inline` count printed as "no script file" (#443), an inventory
 * count that summed files with lines, and the empty-surface test (#199). These
 * pin that each reads the same inventory, on both engines (disk and file map)
 * and both adapters, by asserting typed values — never printed text.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scanPlugin } from "./scan.js";
import { scanFiles } from "./scan-files.js";
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
