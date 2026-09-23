/**
 * `local/frame-mint`: a cast to a path-frame brand fires; the conversions that
 * `src/core/frame.ts` provides, and casts to unrelated types, stay silent.
 */
import { RuleTester } from "eslint";
import tsparser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

import rule from "./frame-mint.mjs";

RuleTester.describe = describe as never;
RuleTester.it = it as never;
RuleTester.itOnly = it.only as never;

const tester = new RuleTester({
  languageOptions: {
    parser: tsparser as never,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const OPTS = [{ types: ["RepoPath", "BundlePath"] }];

tester.run("frame-mint", rule as never, {
  valid: [
    { code: "const p = frame.repo(abs);", options: OPTS },
    { code: "const p = bundle.scanned(issue.path);", options: OPTS },
    { code: "const n = x as string;", options: OPTS },
    { code: "const h = x as SHA256Hash;", options: OPTS },
    { code: "type T = { p: RepoPath };", options: OPTS },
  ],
  invalid: [
    {
      code: "const p = issue.path as RepoPath;",
      options: OPTS,
      errors: [{ messageId: "forged", data: { name: "RepoPath" } }],
    },
    {
      code: "const p = <BundlePath>rel;",
      options: OPTS,
      errors: [{ messageId: "forged", data: { name: "BundlePath" } }],
    },
    {
      code: "ghAnnotate('warning', m, s.path as RepoPath);",
      options: OPTS,
      errors: [{ messageId: "forged" }],
    },
  ],
});
