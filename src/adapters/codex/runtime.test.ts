/**
 * The Codex runtime port's declarations that decide what an eval may ask of
 * it. Its mock-model wiring is tested in `mock-model.test.ts`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { codexRuntime } from "./runtime.js";

test("Codex declares no container image, so a container eval of it is refused at plan time", () => {
  // Guards: `planExecution` refuses a runtime without this declaration, so a
  // Codex eval asking for `execution: { kind: "container" }` fails loudly
  // instead of running on the host — without the core naming the harness.
  assert.equal(codexRuntime.containerImage, undefined);
});
