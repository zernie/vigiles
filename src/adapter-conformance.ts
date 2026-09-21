/**
 * Adapter conformance kit — the reusable check every `HarnessAdapter` runs, so
 * authoring one is guided and safe rather than "hope it's wired right". It
 * verifies each port is populated AND a behavioural invariant: the adapter's
 * dialect actually drives tool-contract verification (its own built-in tool is
 * accepted). A third-party adapter author runs `assertAdapterConformance(myAdapter)`
 * in their test suite. See `docs/authoring-an-adapter.md`.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

import type { HarnessAdapter } from "./core/adapter.js";
import { compileAgent } from "./core/compile.js";
import { experimental_agent } from "./core/spec.js";
import { loadPlugin } from "./plugin-loader.js";
import {
  dialectVocabularyProblems,
  vocabularyProjectionProblems,
} from "./core/vocabulary-consistency.js";
import { injectableEventsOf } from "./core/event-capability.js";
import { RENDERABLE_SKILL_FRONTMATTER_KEYS } from "./core/dialect.js";
import { makeTmpDir } from "./core/tmp-root.js";

export interface ConformanceResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/** Check an adapter against the port contracts; returns the (possibly empty) failure list. */
export function checkAdapterConformance(
  adapter: HarnessAdapter,
): ConformanceResult {
  const failures: string[] = [];
  const need = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg);
  };

  const caps = adapter.capabilities;
  // Widen to boolean so a malformed (non-TS) adapter that set this false is still
  // caught at runtime — the literal `true` type would make a direct check redundant.
  const refVerification: boolean = caps.referenceVerification;
  need(adapter.name.length > 0, "name is empty");
  need(
    refVerification,
    "capabilities.referenceVerification must be true (every adapter does pillar 1)",
  );

  // --- Pillar 1 (always required): dialect + layout ---
  need(
    adapter.dialect.builtinAgentTools.length > 0,
    "dialect has no builtinAgentTools",
  );
  // The dialect's several name lists describe ONE vocabulary from different
  // angles, and nothing used to check they agreed — which is how `Agent` came to
  // sit in `neverAvailableTools` while its own alias `Task` sat in the built-in
  // catalog, undetected, for every consumer of the adapter. Cheap, total, and it
  // runs for every adapter including third-party ones.
  for (const problem of dialectVocabularyProblems(adapter.dialect))
    need(false, `dialect self-contradiction: ${problem}`);
  // When a dialect ships the richer vocabulary AND the flat lists, the flat ones
  // must be exactly its projections — else the two drift apart again, one level
  // down.
  if (adapter.dialect.subagentToolVocabulary !== undefined)
    for (const problem of vocabularyProjectionProblems(
      adapter.dialect.subagentToolVocabulary,
      adapter.dialect.builtinAgentTools,
      adapter.dialect.neverAvailableTools,
    ))
      need(false, `subagentToolVocabulary: ${problem}`);
  if (adapter.dialect.hookEventVocabulary !== undefined)
    for (const problem of vocabularyProjectionProblems(
      adapter.dialect.hookEventVocabulary,
      adapter.dialect.hookEvents,
      [],
    ))
      need(false, `hookEventVocabulary: ${problem}`);
  need(
    adapter.dialect.instructionTargets.length > 0,
    "dialect has no instructionTargets",
  );
  // The key set replaced a two-valued profile enum, which means a dialect can
  // now declare a set that no code path honours. Both halves are checkable:
  // a key the compiler cannot render is a declaration nothing acts on, and a
  // dialect that drops `name` or `description` emits a SKILL.md with no identity.
  for (const key of adapter.dialect.skillFrontmatterKeys)
    need(
      (RENDERABLE_SKILL_FRONTMATTER_KEYS as readonly string[]).includes(key),
      `dialect.skillFrontmatterKeys names "${key}", which the compiler cannot render`,
    );
  for (const required of ["name", "description"])
    need(
      adapter.dialect.skillFrontmatterKeys.includes(required),
      `dialect.skillFrontmatterKeys omits "${required}" — a SKILL.md without it has no identity`,
    );
  need(
    adapter.layout.instructionFile.length > 0,
    "layout.instructionFile is empty",
  );
  need(adapter.layout.manifestPath.length > 0, "layout.manifestPath is empty");
  need(adapter.layout.surfaceDirs.length > 0, "layout has no surfaceDirs");
  need(typeof adapter.detect === "function", "detect is not a function");

  // --- Pillar 2 transport ports: required ONLY for the capabilities the
  // adapter declares. A pillar-1-only adapter (harnessTesting:false) may omit
  // runtime/modelMock; a code-module-hook adapter (shellHooks:false) may omit
  // hookProtocol — and conformance must NOT demand a fake one. The flip side:
  // if it CLAIMS the capability, the port must be there and populated.
  const portNames: [string, string][] = [
    ["dialect", adapter.dialect.name],
    ["layout", adapter.layout.name],
  ];
  if (caps.harnessTesting) {
    need(
      adapter.runtime !== undefined,
      "capabilities.harnessTesting is true but runtime is missing",
    );
    need(
      adapter.modelMock !== undefined,
      "capabilities.harnessTesting is true but modelMock is missing",
    );
    if (adapter.runtime) {
      need(
        adapter.runtime.agentBinary.length > 0,
        "runtime.agentBinary is empty",
      );
      need(
        adapter.runtime.modelBaseUrlEnv.length > 0,
        "runtime.modelBaseUrlEnv is empty",
      );
      portNames.push(["runtime", adapter.runtime.name]);
    }
    if (adapter.modelMock) {
      need(
        adapter.modelMock.modelEndpoint.length > 0,
        "modelMock.modelEndpoint is empty",
      );
      portNames.push(["modelMock", adapter.modelMock.name]);
    }
  } else {
    need(
      adapter.runtime === undefined && adapter.modelMock === undefined,
      "capabilities.harnessTesting is false — omit runtime/modelMock (a pillar-1-only adapter must not ship a half-wired transport)",
    );
  }
  if (caps.shellHooks) {
    need(
      adapter.hookProtocol !== undefined,
      "capabilities.shellHooks is true but hookProtocol is missing",
    );
    if (adapter.hookProtocol) {
      need(
        Number.isInteger(adapter.hookProtocol.blockExitCode),
        "hookProtocol.blockExitCode is not an integer",
      );
      // A shell-hook harness must declare WHICH events can inject developer
      // context (`additionalContext`). Encoding it makes "can this harness
      // deliver an inject hook?" a tested contract — the gap that let Codex's
      // inject support sit unverified in prose. Empty would mean the harness
      // can't inject context from a hook at all; every harness we support can.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the legacy list is the FALLBACK for an adapter with no capability table, and the thing checked for drift below
      const declaredInject = adapter.hookProtocol.injectableEvents;
      need(
        injectableEventsOf(adapter.dialect, declaredInject).length > 0,
        "hookProtocol.injectableEvents is empty — a shell-hook harness must declare the events that honor additionalContext injection (or it can't deliver an inject/nudge hook)",
      );
      // …and when an adapter declares BOTH, they must agree. Without this the
      // table silently COVERS FOR a broken list: an adapter could ship
      // `injectableEvents: []` and still pass, because the effective answer came
      // from the dialect. Two sources that disagree are worse than one, and this
      // is the assertion that keeps the deprecation honest rather than lossy.
      if (adapter.dialect.eventCapabilities) {
        const derived = [...injectableEventsOf(adapter.dialect, [])].sort();
        need(
          derived.join("|") === [...declaredInject].sort().join("|"),
          `hookProtocol.injectableEvents disagrees with dialect.eventCapabilities — the list says [${[...declaredInject].sort().join(", ")}], the table says [${derived.join(", ")}]; they describe the same fact and must match`,
        );
      }
      portNames.push(["hookProtocol", adapter.hookProtocol.name]);
    }
  } else {
    need(
      adapter.hookProtocol === undefined,
      "capabilities.shellHooks is false — omit hookProtocol (hooks are code modules, not shell processes)",
    );
  }

  // Cross-port invariants — the kind of mismatch a copy-paste authoring slip
  // produces, that no single-port check would catch. Only the present ports.
  for (const [port, name] of portNames) {
    need(
      name === adapter.name,
      `${port}.name "${name}" != adapter.name "${adapter.name}"`,
    );
  }
  need(
    adapter.layout.pluginRootToken === adapter.dialect.pluginRootToken,
    "layout.pluginRootToken and dialect.pluginRootToken disagree",
  );
  need(
    adapter.dialect.instructionTargets.includes(adapter.layout.instructionFile),
    `layout.instructionFile "${adapter.layout.instructionFile}" is not one of dialect.instructionTargets`,
  );
  need(
    adapter.layout.settingsFormat === "json" ||
      adapter.layout.settingsFormat === "toml",
    `layout.settingsFormat "${adapter.layout.settingsFormat}" is not "json" | "toml"`,
  );

  // Behavioural: the dialect drives the compiler — its own built-in tool must
  // pass the subagent tool-contract check under this dialect.
  const tool = adapter.dialect.builtinAgentTools[0];
  if (tool) {
    const spec = experimental_agent({
      name: "conformance",
      description: "conformance probe",
      tools: [tool],
      body: "probe",
    });
    const r = compileAgent(spec, {
      specFile: "conformance.md.spec.ts",
      dialect: adapter.dialect,
    });
    need(
      !r.errors.some((e) => e.type === "unknown-tool"),
      `dialect rejects its own built-in tool "${tool}"`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/** Throw if the adapter fails conformance — drop this in an adapter's test suite. */
export function assertAdapterConformance(adapter: HarnessAdapter): void {
  const r = checkAdapterConformance(adapter);
  if (!r.ok) {
    throw new Error(
      `Adapter "${adapter.name}" failed conformance:\n  - ${r.failures.join("\n  - ")}`,
    );
  }
}

/**
 * Guard for the pillar-2 entry points (runHarnessTest/runEval): a pillar-1-only
 * adapter (Cursor, Devin, Amp, Amazon Q) has no mockable transport, so driving
 * the deterministic/eval tiers against it would hang or spawn nothing. Calling
 * this up front turns that into a clear, immediate error. Returns the narrowed
 * runtime+modelMock so the caller can use them without re-checking for undefined.
 */
export function assertHarnessTestable(adapter: HarnessAdapter): {
  runtime: NonNullable<HarnessAdapter["runtime"]>;
  modelMock: NonNullable<HarnessAdapter["modelMock"]>;
} {
  if (
    !adapter.capabilities.harnessTesting ||
    !adapter.runtime ||
    !adapter.modelMock
  ) {
    throw new Error(
      `Adapter "${adapter.name}" does not support harness testing (pillar 2): it is reference-verification-only (no mockable runtime). Use it for compile/scan/lint, not runHarnessTest/runEval.`,
    );
  }
  return { runtime: adapter.runtime, modelMock: adapter.modelMock };
}

/**
 * Behavioural conformance the pure checks can't reach: write a minimal settings
 * file in the adapter's declared `settingsFormat` (with a hook), load it through
 * the adapter's `layout`, and assert the hooks actually came back. This is what
 * catches a layout that points at the right file but in the wrong format (the
 * JSON-vs-TOML trap) — the pure checker would pass it, the agent would silently
 * run with zero hooks. Does filesystem IO, so it's a separate opt-in assert.
 */
export function assertAdapterLoadsHooks(adapter: HarnessAdapter): void {
  const dir = makeTmpDir("conformance");
  try {
    const settingsAbs = join(dir, adapter.layout.settingsPath);
    mkdirSync(dirname(settingsAbs), { recursive: true });
    const content =
      adapter.layout.settingsFormat === "toml"
        ? '[[hooks.PreToolUse]]\ncommand = "echo conformance"\n'
        : JSON.stringify({
            hooks: { PreToolUse: [{ command: "echo conformance" }] },
          });
    writeFileSync(settingsAbs, content);
    const loaded = loadPlugin(dir, adapter.layout);
    if (!loaded.settings.hooks) {
      throw new Error(
        `Adapter "${adapter.name}": loadPlugin read no hooks from a ${adapter.layout.settingsFormat} settings file at ${adapter.layout.settingsPath} — the settings-format wiring is broken.`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
