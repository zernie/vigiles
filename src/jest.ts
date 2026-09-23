// 🔴 PUBLIC ENTRY POINT `vigiles/jest` — every export here is a promise to users. The default for a
// symbol is INTERNAL. It is exported only if (a) a NAMED external consumer uses it, or (b) it is
// a deliberate extension point listed in STABILITY.md (the adapter kit is the example). "Might
// be useful" is neither. Review point: the diff of `api-surface/vigiles-jest.api.md`, which
// `npm run api:check` fails on.
/* eslint-disable max-params, @typescript-eslint/no-explicit-any --
   The matcher signatures mirror the runtime vigilesMatchers (positional args);
   `Check<any>` matches the runtime generic for the type-only augmentation. */
/**
 * vigiles — jest integration (opt-in).
 *
 * Importing this entry registers the vigiles matchers AND augments jest's types
 * so `toHaveCreated` / `toBeatBaseline` type-check.
 *
 *   // jest.config.js →  setupFilesAfterEnv: ["vigiles/jest"]
 *   // …or at the top of a test file:
 *   import "vigiles/jest";
 *
 *   expect(result).toHaveCreated("DONE");
 *   expect(report).toBeatBaseline("vanilla", "gated", "caught");
 *
 * jest is an optional peer dependency — only jest users load this entry.
 */
import { expect } from "@jest/globals";
import { vigilesMatchers } from "./harness-assert.js";
import type { Check } from "./check.js";

expect.extend(vigilesMatchers);

declare module "@jest/expect" {
  interface Matchers<R> {
    toHaveCreated(path: string): R;
    toBlock(): R;
    toBeatBaseline(
      baseline: string,
      arm: string,
      metric: string,
      by?: number,
    ): R;
    toPass(check: Check<any>): R;
    toPassAll(checks: readonly Check<any>[]): R;
  }
}
