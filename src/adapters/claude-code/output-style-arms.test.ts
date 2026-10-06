/**
 * `experimental_outputStyleArms` against the REAL `claude` binary and the scripted mock
 * model: the arms a paid style eval compares, built from the style FILE, with
 * delivery proven by one free run first. Skipped where the CLI is absent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { claudeAvailable } from "../../harness-test.js";
import { experimental_outputStyleArms } from "../../output-style-arms.js";
import { claudeCodeAdapter } from "./adapter.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeOutputStyles as rules } from "./output-style.js";

const STYLE = resolve("test/fixtures/output-styles/status-footer.md");
const maybe = claudeAvailable() ? test : test.skip;

describe("experimental_outputStyleArms on Claude Code (real binary, scripted model)", () => {
  maybe(
    "builds a with arm selected by the name in the file, and a bare without arm",
    async () => {
      const arms = await experimental_outputStyleArms(STYLE);
      expect(arms).toEqual({
        with: {
          files: {
            ".claude/output-styles/status-footer.md": readFileSync(
              STYLE,
              "utf-8",
            ),
          },
          settings: { outputStyle: "Status Footer" },
        },
        without: {},
      });
    },
    180_000,
  );

  maybe(
    "throws before any paid trial when the style does not reach the model",
    async () => {
      const blind = {
        ...claudeCodeAdapter,
        layout: {
          ...claudeCodeLayout,
          outputStyles: { ...rules, reached: () => false },
        },
      };
      await expect(
        experimental_outputStyleArms(STYLE, { adapter: blind }),
      ).rejects.toThrow(/"Status Footer" never reached the model/);
    },
    180_000,
  );
});

describe("experimental_outputStyleArms refuses before running", () => {
  test("when the file does not exist", async () => {
    await expect(
      experimental_outputStyleArms("nope/missing.md"),
    ).rejects.toThrow(/outputStyle: no such file: nope\/missing\.md/);
  });
});
