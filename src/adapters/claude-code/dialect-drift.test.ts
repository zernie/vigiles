/**
 * Dialect-drift suite: pure parser units + a GATED read-local freshness check
 * against the INSTALLED @anthropic-ai/claude-code. The gated checks ALARM (fail)
 * when CC's tool/event surface drifts from `claudeCodeDialect` — the deterministic
 * backstop for the hand-maintained catalog. They read the user's own install only
 * (ToS-clean; we never ship their types) and skip LOUDLY when CC isn't installed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACKNOWLEDGED_TOOL_INPUT_TYPES,
  parseToolInputTypes,
  parseClaudeVersion,
  onPathClaudeVersion,
  eventsMissingFromBundle,
  findClaudeCodePackage,
  findClaudeCodeBundle,
  formatDialectDrift,
} from "./dialect-drift.js";
import { claudeCodeDialect } from "./dialect.js";

describe("dialect-drift parsers (pure)", () => {
  it("parses tool-input interface names, sorted + de-duped", () => {
    const dts =
      "export interface BashInput {}\nexport interface AgentInput {}\nexport interface BashInput {}";
    expect(parseToolInputTypes(dts)).toEqual(["Agent", "Bash"]);
  });

  it("ignores non-Input interfaces and other declarations", () => {
    const dts =
      "export interface ToolAnnotations {}\nexport type Foo = string;\nexport interface GrepInput {}";
    expect(parseToolInputTypes(dts)).toEqual(["Grep"]);
  });

  it("flags events absent from a bundle (whole-word)", () => {
    const bundle = '...,"PreToolUse",... x.PostToolUseX ...';
    expect(
      eventsMissingFromBundle(bundle, ["PreToolUse", "PostToolUse"]),
    ).toEqual([
      "PostToolUse", // only appears inside PostToolUseX → not a whole word
    ]);
  });

  it("parseClaudeVersion: extracts semver core, null when absent", () => {
    expect(parseClaudeVersion("2.1.211 (Claude Code)")).toBe("2.1.211");
    expect(parseClaudeVersion("2.1.42")).toBe("2.1.42");
    expect(parseClaudeVersion("Claude Code (no version)")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
  });

  it("formatDialectDrift: null when no drift (or no report)", () => {
    expect(formatDialectDrift(null)).toBeNull();
    expect(
      formatDialectDrift({
        installedVersion: "2.1.99",
        runningVersion: null,
        validatedVersion: "2.1.42",
        newToolTypes: [],
        removedToolTypes: [],
      }),
    ).toBeNull(); // version differs but tool surface unchanged → no noise
  });

  it("formatDialectDrift: warns with added/removed tools + both versions", () => {
    const msg = formatDialectDrift({
      installedVersion: "2.2.0",
      runningVersion: "2.2.0", // located package IS the running CC → trust its types
      validatedVersion: "2.1.42",
      newToolTypes: ["NewTool"],
      removedToolTypes: ["Bash"],
    });
    expect(msg).toMatch(/2\.1\.42/);
    expect(msg).toMatch(/2\.2\.0/);
    expect(msg).toMatch(/NewTool/);
    expect(msg).toMatch(/removed: Bash/);
  });

  it("formatDialectDrift: SUPPRESSES when the located package isn't the running CC", () => {
    // The exact leftover-package footgun: a stale 2.1.42 npm package sits beside a
    // newer native-binary CC (2.1.211). Its tool set differs from ACKNOWLEDGED, but
    // it's NOT what's running — so a warning would be a false alarm.
    expect(
      formatDialectDrift({
        installedVersion: "2.1.42",
        runningVersion: "2.1.211",
        validatedVersion: "2.1.187",
        newToolTypes: ["Config"],
        removedToolTypes: ["TaskCreate", "Workflow"],
      }),
    ).toBeNull();
  });
});

describe("dialect freshness vs the INSTALLED claude-code (read-local, ToS-clean)", () => {
  const pkg = findClaudeCodePackage();
  // The located package must be the CC actually RUNNING. In the native-binary era a
  // box can carry a stale leftover npm package (readable sdk-tools.d.ts, months old)
  // beside a newer native binary — asserting its tool set against ACKNOWLEDGED would
  // fail against a version nobody's on. Reconcile with `claude --version` and SKIP
  // LOUDLY on a mismatch (no-silent-skips), rather than a false failure. CI pins CC,
  // so there the package IS the running one and the gate runs for real.
  const pkgVersion =
    pkg &&
    (
      JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8")) as {
        version?: string;
      }
    ).version;
  const running = onPathClaudeVersion();
  const packageIsRunningCC =
    !!pkg && (running == null || running === pkgVersion);
  const gate = packageIsRunningCC ? it : it.skip;

  if (!pkg) {
    // Loud skip (no-silent-skips): the alarm only runs where CC is installed.
    it.skip("freshness checks skipped — @anthropic-ai/claude-code not installed", () => {
      /* gated above */
    });
  } else if (!packageIsRunningCC) {
    it.skip(`freshness checks skipped — located package ${String(pkgVersion)} is a stale leftover, not the running CC ${String(running)}`, () => {
      /* gated above */
    });
  }

  gate(
    "sdk-tools.d.ts tool-input types still match ACKNOWLEDGED_TOOL_INPUT_TYPES",
    () => {
      if (!pkg) return; // narrows (gated)
      const dts = readFileSync(join(pkg, "sdk-tools.d.ts"), "utf-8");
      const installed = parseToolInputTypes(dts);
      expect(
        installed,
        "Claude Code's tool-input type set changed — re-check claudeCodeDialect.builtinAgentTools and update ACKNOWLEDGED_TOOL_INPUT_TYPES",
      ).toEqual([...ACKNOWLEDGED_TOOL_INPUT_TYPES].sort());
    },
  );

  // The hook-event check needs a READABLE JS bundle (old `cli.js`). CC ≥ ~2.1.18x
  // ships a native binary with none, so gate on the bundle and SKIP LOUDLY (one
  // self-explaining test, per no-silent-skips) instead of crashing on a missing file.
  //
  // It ALSO needs `packageIsRunningCC`, which it did not have until 2026-08-17 —
  // its sibling above applied the stale-leftover reconciliation and this one
  // didn't. That asymmetry meant the only bundle this ever ran against was
  // whatever old package happened to be lying around: on the capture box a
  // leftover 2.1.42 `cli.js` beside a running 2.1.233 native binary, which
  // reported 15 real events as "renamed/removed in CC?" purely because 2.1.42
  // predates them. Reconciling here is the same guard `formatDialectDrift`
  // already applies at runtime, not a weakening of the gate.
  const bundle = pkg && packageIsRunningCC ? findClaudeCodeBundle(pkg) : null;
  const eventsGate = bundle ? it : it.skip;

  eventsGate(
    "our hook events still exist in the installed JS bundle (skipped when CC ships a native binary, no readable cli.js)",
    () => {
      if (!bundle) return; // narrows (gated on a readable bundle)
      const missing = eventsMissingFromBundle(
        readFileSync(bundle, "utf-8"),
        claudeCodeDialect.hookEvents,
      );
      expect(
        missing,
        "hook event(s) in claudeCodeDialect no longer appear in the bundle — renamed/removed in CC?",
      ).toEqual([]);
    },
  );

  gate("reports the validated CC version (visibility, not asserted)", () => {
    if (!pkg) return; // narrows (gated)
    const { version } = JSON.parse(
      readFileSync(join(pkg, "package.json"), "utf-8"),
    ) as { version: string };
    // eslint-disable-next-line no-console
    console.log(
      `dialect-drift: validated against @anthropic-ai/claude-code ${version}`,
    );
    expect(typeof version).toBe("string");
  });
});
