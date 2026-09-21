import { test } from "vitest";
import assert from "node:assert/strict";

import { experimental_skill, prose } from "./core/spec.js";
import {
  optionalFrontmatterKeys,
  skillFrontmatterDropWarnings,
} from "./skill-harness.js";

const base = { name: "demo", description: "d", body: prose`x` };

test("optionalFrontmatterKeys picks up disable-model-invocation + argument-hint", () => {
  assert.deepEqual(
    optionalFrontmatterKeys(experimental_skill({ ...base })),
    [],
  );
  assert.deepEqual(
    optionalFrontmatterKeys(
      experimental_skill({ ...base, disableModelInvocation: true }),
    ),
    ["disable-model-invocation"],
  );
  assert.deepEqual(
    optionalFrontmatterKeys(
      experimental_skill({ ...base, argumentHint: "<x>" }),
    ),
    ["argument-hint"],
  );
  // `inputs` also drive the argument-hint key.
  assert.deepEqual(
    optionalFrontmatterKeys(
      experimental_skill({ ...base, inputs: [{ name: "x", hint: "an x" }] }),
    ),
    ["argument-hint"],
  );
});

test("warns for a declared harness whose dialect does not read the keys", () => {
  const spec = experimental_skill({ ...base, disableModelInvocation: true });
  const warnings = skillFrontmatterDropWarnings(spec, ["claude-code", "codex"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /disable-model-invocation/);
  assert.match(warnings[0], /codex/);
  assert.match(warnings[0], /drops it/);
});

test("no warning when the only declared harness reads the keys", () => {
  const spec = experimental_skill({
    ...base,
    disableModelInvocation: true,
    argumentHint: "<x>",
  });
  assert.deepEqual(skillFrontmatterDropWarnings(spec, ["claude-code"]), []);
});

test("no warning when the skill sets no optional keys", () => {
  assert.deepEqual(
    skillFrontmatterDropWarnings(experimental_skill({ ...base }), ["codex"]),
    [],
  );
});

test("plural phrasing + dedupe across repeated harness names", () => {
  const spec = experimental_skill({
    ...base,
    disableModelInvocation: true,
    argumentHint: "<x>",
  });
  const warnings = skillFrontmatterDropWarnings(spec, ["codex", "codex"]);
  assert.equal(warnings.length, 1, "deduped per harness");
  assert.match(warnings[0], /disable-model-invocation, argument-hint are/);
  assert.match(warnings[0], /drops them/);
});

test("unknown harness names are ignored, not thrown", () => {
  const spec = experimental_skill({ ...base, disableModelInvocation: true });
  assert.deepEqual(skillFrontmatterDropWarnings(spec, ["bogus"]), []);
});
