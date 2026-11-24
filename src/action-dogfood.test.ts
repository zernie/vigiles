/**
 * EVERY COMMAND THE ACTION ACCEPTS RUNS THROUGH THE ACTION IN THIS REPO'S CI.
 *
 * The contributor rules said so in prose ("dogfooded in this repo's CI") and it
 * did not hold: `command: test` shipped with no `uses: ./` step running it, so
 * the wrapper path a user takes was never executed here. Prose cannot notice
 * that; this test can.
 *
 * Both sides are read from their own source of truth, never a list typed here:
 * the accepted commands from `VIGILES_COMMANDS` in action.yml's step (the list
 * the script itself validates against), and the dogfood steps from every
 * workflow file. An exemption is DATA — command → reason — and a stale one (a
 * command the Action no longer accepts) fails as well.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");

/** Commands the Action accepts but this repo's CI deliberately does not run, with why. */
const NOT_DOGFOODED: Readonly<Record<string, string>> = {};

const actionSchema = z.object({
  runs: z.object({
    steps: z.array(
      z.object({ env: z.record(z.string(), z.string()).optional() }),
    ),
  }),
});

const workflowSchema = z.object({
  jobs: z
    .record(
      z.string(),
      z.object({
        steps: z
          .array(
            z.object({
              uses: z.string().optional(),
              with: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

function acceptedCommands(): readonly string[] {
  const action = actionSchema.parse(
    load(readFileSync(join(ROOT, "action.yml"), "utf-8")),
  );
  const list = action.runs.steps[0]?.env?.["VIGILES_COMMANDS"] ?? "";
  return list.split(" ").filter((c) => c !== "");
}

/** `command` of every `uses: ./` step in every workflow (default `lint`). */
function dogfoodedCommands(): ReadonlySet<string> {
  const dir = join(ROOT, ".github", "workflows");
  const steps = readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .flatMap((f) => {
      const wf = workflowSchema.parse(
        load(readFileSync(join(dir, f), "utf-8")),
      );
      return Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
    });
  return new Set(
    steps
      .filter((s) => s.uses === "./")
      .map((s) => {
        const cmd = s.with?.["command"];
        return typeof cmd === "string" ? cmd : "lint";
      }),
  );
}

test("the Action's accepted commands are read from action.yml", () => {
  assert.deepEqual([...acceptedCommands()].sort(), [
    "compile",
    "eval-check",
    "lint",
    "test",
  ]);
});

test("every command the Action accepts runs through `uses: ./` in this repo's CI", () => {
  const ran = dogfoodedCommands();
  const missing = acceptedCommands().filter(
    (c) => !ran.has(c) && NOT_DOGFOODED[c] === undefined,
  );
  assert.deepEqual(
    missing,
    [],
    `not dogfooded: ${missing.join(", ")} — add a \`uses: ./\` step with ` +
      "`version: local`, or an entry with a reason to NOT_DOGFOODED",
  );
});

test("every exemption is still a command the Action accepts", () => {
  const accepted = new Set(acceptedCommands());
  const stale = Object.keys(NOT_DOGFOODED).filter((c) => !accepted.has(c));
  assert.deepEqual(stale, []);
});
