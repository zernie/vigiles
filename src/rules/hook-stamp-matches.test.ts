/**
 * `hook-stamp-matches` — its policy, how a finding reads, and that `vigiles
 * lint` (the CI gate) FAILS on a hook edited without a recompile: the incident
 * this rule exists for passed CI because nothing compared a hook to its stamp.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { makeTmpDir, cleanupTmpDir } from "../core/test-utils.js";
import { stampHook } from "../core/hook-program.js";
import { RULE_GROUPS } from "./groups.js";
import { hookStampMatches } from "./hook-stamp-matches.js";

const CLI = resolve(__dirname, "..", "..", "dist", "cli.js");

const ISSUE = {
  sidecar: ".vigiles/hooks/heartbeat.hook.ts.json",
  source: "hooks/heartbeat.hook.ts",
};

describe("hook-stamp-matches", () => {
  it("is a graded, decidable rule that gates at error by default", () => {
    expect(hookStampMatches.id).toBe("hook-stamp-matches");
    expect(hookStampMatches.bucket).toBe("external-decidable");
    expect(hookStampMatches.defaultSeverity).toBe("error");
    expect(RULE_GROUPS[hookStampMatches.group].graded).toBe(true);
    expect(
      hookStampMatches.scored.narrow(
        { skills: [], instructionImportIssues: [], hookStampIssues: [ISSUE] },
        () => false,
      ).hookStampIssues,
    ).toEqual([]);
  });

  it("reports at the edited source, with the exact fix", () => {
    const [f] = hookStampMatches.findings({
      skills: [],
      instructionImportIssues: [],
      hookStampIssues: [ISSUE],
    });
    expect(f.kind).toBe("finding");
    expect(f.path).toBe(ISSUE.source);
    expect(f.message).toContain(ISSUE.sidecar);
    expect(f.message).toContain(`vigiles compile ${ISSUE.source}`);
  });

  it("`vigiles lint` exits non-zero on a stale stamp, and passes once it matches", () => {
    const dir = makeTmpDir();
    try {
      const source = "export default 'compiled';\n";
      mkdirSync(join(dir, "hooks"), { recursive: true });
      mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
      const hook = join(dir, ISSUE.source);
      writeFileSync(hook, source + "// edited, not recompiled\n");
      writeFileSync(
        join(dir, ISSUE.sidecar),
        JSON.stringify({ file: ISSUE.source, stamp: stampHook(source) }),
      );
      const lint = () =>
        spawnSync("node", [CLI, "lint"], { cwd: dir, encoding: "utf-8" });

      const stale = lint();
      expect(stale.status, stale.stdout + stale.stderr).not.toBe(0);
      expect(stale.stdout).toContain("hook-stamp-matches");
      expect(stale.stdout).toContain(`vigiles compile ${ISSUE.source}`);

      writeFileSync(hook, source);
      const fresh = lint();
      expect(fresh.stdout).not.toContain("hook-stamp-matches");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
