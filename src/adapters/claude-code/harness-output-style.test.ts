/**
 * `runHarnessTest({ outputStyle })` against the REAL `claude` binary and the
 * scripted mock model — no key, no cost; skipped where the CLI is absent.
 *
 * The option exists because of one measured trap, reproduced here as the
 * control: a hand-spelled, mis-cased `outputStyle` setting makes Claude Code
 * load no style WITHOUT an error, and a test that checks nothing else passes.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { styleReached } from "../../core/output-style.js";
import { claudeAvailable, runHarnessTest } from "../../harness-test.js";
import { claudeCodeAdapter } from "./adapter.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeOutputStyles as rules } from "./output-style.js";

const STYLE = resolve("test/fixtures/output-styles/status-footer.md");
const TEXT = readFileSync(STYLE, "utf-8");
const AT = ".claude/output-styles/status-footer.md";
const RUN = { sandbox: false, timeoutMs: 120_000, prompt: "hi" } as const;
const maybe = claudeAvailable() ? test : test.skip;

/** A Stop hook that blocks once, so the agent writes a second reply. */
const STOP_ONCE = {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `if [ -f .stopped ]; then exit 0; fi; touch .stopped; echo '{"decision":"block","reason":"finish the checklist"}'`,
          },
        ],
      },
    ],
  },
};

describe("runHarnessTest outputStyle on Claude Code (real binary, scripted model)", () => {
  maybe(
    "writes the style, selects it by the name in the file, and the style reaches the model",
    async () => {
      const r = await runHarnessTest({
        ...RUN,
        outputStyle: STYLE,
        model: [{ text: "done" }],
      });
      try {
        expect(r.file(AT)).toBe(TEXT);
        expect(
          JSON.parse(readFileSync(join(r.cwd, "settings.json"), "utf-8")),
        ).toEqual({ outputStyle: "Status Footer" });
      } finally {
        r.cleanup();
      }
    },
    180_000,
  );

  maybe(
    "CONTROL: a mis-cased hand-written name runs green and loads nothing; the exact name loads",
    async () => {
      const style = rules.read(AT, TEXT);
      const run = async (outputStyle: string) => {
        const r = await runHarnessTest({
          ...RUN,
          files: { [AT]: TEXT },
          settings: { outputStyle },
          model: [{ text: "done" }],
        });
        r.cleanup();
        return {
          exitCode: r.exitCode,
          reached: styleReached(rules, style, r.modelRequests),
        };
      };
      // The vacuous pass the option removes: exit 0, a normal trace, no style.
      expect(await run("status footer")).toEqual({
        exitCode: 0,
        reached: false,
      });
      expect(await run("Status Footer")).toEqual({
        exitCode: 0,
        reached: true,
      });
    },
    300_000,
  );
});

describe("what a style test can catch on Claude Code (real binary)", () => {
  maybe(
    "throws, keeping the work dir, when the style never reaches the model",
    async () => {
      // The harness's own rule says "never arrived": the check must turn that
      // into a failure rather than a trace.
      const blind = {
        ...claudeCodeAdapter,
        layout: {
          ...claudeCodeLayout,
          outputStyles: { ...rules, reached: () => false },
        },
      };
      await expect(
        runHarnessTest(
          { ...RUN, outputStyle: STYLE, model: [{ text: "done" }] },
          { adapter: blind },
        ),
      ).rejects.toThrow(
        /"Status Footer" never reached the model.*Work dir kept/s,
      );
    },
    180_000,
  );

  maybe(
    "replies holds both replies of a turn a Stop hook continued; output only the last",
    async () => {
      const r = await runHarnessTest({
        ...RUN,
        transcript: true,
        outputStyle: STYLE,
        settings: STOP_ONCE,
        model: [
          { text: "first\n---\n**Status** A" },
          { text: "second\n---\n**Status** B" },
        ],
      });
      try {
        expect(r.replies).toEqual([
          "first\n---\n**Status** A",
          "second\n---\n**Status** B",
        ]);
        expect(r.output).toBe("second\n---\n**Status** B");
        // The defect a style test can now see: one user message, two footers.
        const footers = (r.replies ?? []).filter((t) =>
          t.includes("**Status**"),
        );
        expect(footers).toHaveLength(2);
      } finally {
        r.cleanup();
      }
    },
    180_000,
  );
});

describe("runHarnessTest outputStyle refuses before running", () => {
  test("when the fixture's settings already pick a style", async () => {
    await expect(
      runHarnessTest({
        ...RUN,
        outputStyle: STYLE,
        settings: { outputStyle: "Other" },
        model: [],
      }),
    ).rejects.toThrow(
      /outputStyle: the fixture's settings already set "outputStyle"/,
    );
  });

  test("when the file does not exist", async () => {
    await expect(
      runHarnessTest({ ...RUN, outputStyle: "nope/missing.md", model: [] }),
    ).rejects.toThrow(/outputStyle: no such file: nope\/missing\.md/);
  });
});
