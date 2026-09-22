/**
 * Adapter conformance kit — the reusable check every `HarnessAdapter` runs, so
 * authoring one is guided and safe rather than "hope it's wired right". It
 * verifies each port is populated AND a behavioural invariant: the adapter's
 * dialect actually drives tool-contract verification (its own built-in tool is
 * accepted). A third-party adapter author runs `assertAdapterConformance(myAdapter)`
 * in their test suite. See `docs/authoring-an-adapter.md`.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";

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
import { surfaceDirs } from "./core/layout.js";
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

  // 🔴 THE KIT IS THE EXPLANATION, THE TYPE IS THE GATE. Every check below is
  // now unreachable for an adapter authored in TypeScript: `HarnessAdapter` is
  // an intersection of discriminated unions, so "declares the capability, ships
  // no port" and "denies the capability, ships the port" are both compile
  // errors. The checks stay for the two cases the type does not reach — a
  // third-party adapter authored in JavaScript, and an object crossing a
  // package boundary through a cast — and because a TypeScript error against a
  // 4-member intersection reads badly next to a sentence naming the field.
  //
  // `capabilities.referenceVerification` was checked here and is gone. It was
  // typed as the literal `true` on every adapter, so the check could not fail;
  // a field that can hold one value carries no information.
  need(adapter.name.length > 0, "name is empty");

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
  need(
    surfaceDirs(adapter.layout).length > 0,
    "layout.surfaces names no surface — at least one kind is required",
  );
  // A2: TypeScript has no non-empty-string type worth the ceremony (the
  // template-literal `${string}${string}` trick matches `""` too), so the "no
  // second spelling of absent" rule is a test for every optional path. An
  // absent key already means "this harness has no such thing"; `""` would be a
  // second one, and every reader would have to remember to test for both.
  const optionalPaths: readonly (readonly [string, string | undefined])[] = [
    ["rulesDir", adapter.layout.rulesDir],
    ["hookScriptsDir", adapter.layout.hookScriptsDir],
    ["hooksConventionPath", adapter.layout.hooksConventionPath],
    ["userSurfaceRoot", adapter.layout.userSurfaceRoot],
    ["surfaces.skill", adapter.layout.surfaces.skill],
    ["surfaces.agent", adapter.layout.surfaces.agent],
    ["surfaces.command", adapter.layout.surfaces.command],
  ];
  for (const [field, value] of optionalPaths)
    need(
      value === undefined || value.length > 0,
      `layout.${field} is "" — absence is spelled by omitting the key, never by an empty string`,
    );
  // A7: `hooksConventionPath` names a FILE, and every reader treats it as one
  // (dirname it, parse it, round-trip it). `opencodeLayout` used to name the
  // DIRECTORY `.opencode/plugin` there, so each of those readers was wrong
  // about it in its own way. A basename with an extension is the cheapest
  // statement of "this is a file" that does not touch the disk.
  if (adapter.layout.hooksConventionPath !== undefined)
    need(
      /\.[^./]+$/.test(basename(adapter.layout.hooksConventionPath)),
      `layout.hooksConventionPath "${adapter.layout.hooksConventionPath}" has no file extension — it names a standalone hooks FILE, not a directory (omit it when the harness has none)`,
    );
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
  if (adapter.harnessTesting) {
    need(
      adapter.runtime !== undefined,
      "harnessTesting is true but runtime is missing",
    );
    need(
      adapter.modelMock !== undefined,
      "harnessTesting is true but modelMock is missing",
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
    // 🔴 THE CHECK THAT WAS MISSING, AND THE STATE IT MISSED WAS SHIPPING.
    // This block checked `runtime` and `modelMock` and not the DRIVER, so
    // `opencodeAdapter` — `harnessTesting: true`, both ports present, no thunk
    // — passed conformance and threw at run time inside `runHarnessTest`. The
    // type now makes that shape unwritable in TypeScript; this is the same
    // statement for an adapter the type never saw.
    need(
      typeof adapter.harnessTestDriver === "function",
      "harnessTesting is true but harnessTestDriver is missing — the runner has nothing to dispatch through",
    );
    // ⚠️ AND THE SAME STATEMENT FOR THE PORT ADDED BY #263, because the comment
    // above describes a gap that has now recurred once. `liveDriver` is
    // REQUIRED in this arm of the type, so TypeScript covers every adapter it
    // compiles — and this function exists for the adapters it does not: a
    // third-party JavaScript one, or a cast object. Without this line such an
    // adapter passed conformance and threw later inside `modelAccessFor` or a
    // behavioral probe, which is exactly how `opencodeAdapter` shipped.
    need(
      typeof adapter.liveDriver === "function",
      "harnessTesting is true but liveDriver is missing — the executing tiers have no model access or probe to read",
    );
  } else {
    need(
      adapter.runtime === undefined &&
        adapter.modelMock === undefined &&
        adapter.harnessTestDriver === undefined &&
        adapter.liveDriver === undefined,
      "harnessTesting is false — omit runtime/modelMock/harnessTestDriver/liveDriver (a pillar-1-only adapter must not ship a half-wired transport)",
    );
  }
  if (adapter.shellHooks) {
    need(
      adapter.hookProtocol !== undefined,
      "shellHooks is true but hookProtocol is missing",
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
      "shellHooks is false — omit hookProtocol (hooks are code modules, not shell processes)",
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
  // 🔴 THE ENUM CHECK THAT USED TO BE HERE IS DELETED, and its deletion is the
  // ratchet rather than a loosening. It asserted
  // `layout.settingsFormat === "json" || === "toml"` — the core re-checking a
  // closed set it had itself declared, which is the tell that the "data" field
  // was a hidden switch. With a CODEC there is no set to be outside of, so a
  // third-party adapter whose settings are YAML is legal and every reader
  // already handles it. What IS checked is the round trip, below: a codec has
  // to be able to read back what it wrote.
  need(
    adapter.layout.settings.label.length > 0,
    "layout.settings has no label",
  );
  try {
    const probe = { vigilesConformance: { n: 1 } };
    const back = adapter.layout.settings.parse(
      adapter.layout.settings.render(probe),
    );
    need(
      JSON.stringify(back) === JSON.stringify(probe),
      `layout.settings ("${adapter.layout.settings.label}") does not round-trip: rendered then parsed gave ${JSON.stringify(back)}`,
    );
  } catch (e) {
    need(
      false,
      `layout.settings ("${adapter.layout.settings.label}") threw on its own output: ${String(e)}`,
    );
  }

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
  if (!adapter.harnessTesting || !adapter.runtime || !adapter.modelMock) {
    throw new Error(
      `Adapter "${adapter.name}" does not support harness testing (pillar 2): it is reference-verification-only (no mockable runtime). Use it for compile/scan/lint, not runHarnessTest/runEval.`,
    );
  }
  return { runtime: adapter.runtime, modelMock: adapter.modelMock };
}

/**
 * Behavioural conformance the pure checks can't reach: write a minimal settings
 * file using the adapter's OWN codec and registration shape, load it through
 * the adapter's `layout`, and assert the hooks actually came back. This is what
 * catches a layout that points at the right file but in the wrong format (the
 * JSON-vs-TOML trap) — the pure checker would pass it, the agent would silently
 * run with zero hooks. Does filesystem IO, so it's a separate opt-in assert.
 */
export function assertAdapterLoadsHooks(adapter: HarnessAdapter): void {
  // Only a shell-hook harness has a hooks file to round-trip; the caller
  // (`adapter-contract.test.ts`) already skips the others loudly, and the type
  // is what says so — `hookProtocol` is `?: never` on the `shellHooks: false`
  // arm, so this narrowing is the union doing its job rather than a guard.
  if (!adapter.shellHooks) {
    throw new Error(
      `Adapter "${adapter.name}" declares shellHooks:false — there is no shell-hook settings round-trip to assert.`,
    );
  }
  const dir = makeTmpDir("conformance");
  try {
    const settingsAbs = join(dir, adapter.layout.settingsPath);
    mkdirSync(dirname(settingsAbs), { recursive: true });
    // 🔴 THE FIXTURE IS NOW BUILT FROM THE PORTS, not from a format branch.
    // It used to be `settingsFormat === "toml" ? <TOML text> : <JSON text>`,
    // which tested the two encodings the CHECK knew about rather than the ones
    // the ADAPTER declares — a third encoding would have been handed JSON and
    // failed for the wrong reason. `registration` supplies the harness's entry
    // SHAPE and `settings.render` its ENCODING, which is exactly the pair this
    // assertion exists to prove is wired to the same file.
    const content = adapter.layout.settings.render(
      adapter.hookProtocol.registration(
        "PreToolUse",
        undefined,
        "echo conformance",
      ) as unknown as Record<string, unknown>,
    );
    writeFileSync(settingsAbs, content);
    const loaded = loadPlugin(dir, adapter.layout);
    if (!loaded.settings.hooks) {
      throw new Error(
        `Adapter "${adapter.name}": loadPlugin read no hooks from a ${adapter.layout.settings.label} settings file at ${adapter.layout.settingsPath} — the settings codec / registration wiring is broken.`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
