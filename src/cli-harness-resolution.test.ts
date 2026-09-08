/**
 * Prevention gate for the dogfood A/I3 bug class — a command that resolves the
 * harness by RAW auto-detection alone silently ignores the `.vigilesrc.json`
 * `harness` key (it honours only `--harness=`). The fix routes every command
 * through `resolveCommandHarness` / `resolveHarnessSelection`, which reads the
 * config. This test makes the OLD path irrepresentable in `cli.ts`: the CLI must
 * not call `detectAdapterResult(` directly (only `resolveHarnessSelection` may,
 * inside `adapter-registry.ts`). A future command that reaches for the raw
 * detector re-introduces the bug and fails here, without needing to run it.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `cli-main.ts`, not `cli.ts`: #216 reduced `cli.ts` to a dispatcher shim so a
// compiled hook stops loading the verbs to decide allow/deny. Every verb — and
// so every harness resolution this gate polices — lives in the barrel now.
const CLI_SRC = readFileSync(join(__dirname, "cli-main.ts"), "utf-8");

test("cli-main.ts resolves the harness through resolveHarnessSelection, never raw detect (dogfood A/I3)", () => {
  // A direct call — `detectAdapterResult(` — bypasses config.harness. Strip
  // line comments first so the doc comment on `resolveCommandHarness` (which
  // names the anti-pattern in prose) doesn't count as a call.
  const code = CLI_SRC.split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .filter((l) => !l.trimStart().startsWith("*"))
    .join("\n");
  assert.ok(
    !/\bdetectAdapterResult\s*\(/.test(code),
    "cli.ts must not call detectAdapterResult() directly — use resolveCommandHarness (honours --harness / config.harness / auto-detect). See dogfood A/I3.",
  );
});

/**
 * The SAME bug class, one layer down: a command that calls a layout-taking
 * detector and omits the layout gets `claudeCodeLayout` by default — silently, in
 * every repo, forever.
 *
 * 🔴 Found three times on one PR (2026-08-12), and the third was found only by
 * grepping for the shape of the first two:
 *   - `skillTestNudge` (PostToolUse) — a Codex repo's edited skill matched
 *     nothing, so the hook stayed silent while `lint` reported it untested.
 *   - `resolveRecords` (`vigiles test`/`eval`) — discovery returned no surfaces,
 *     so `recordsFrom` dropped every probe an execution had earned.
 *   - `rankPlugins` (multi-target `audit`) — a Codex plugin scanned as Claude Code
 *     shows no surfaces, nothing to deduct, and ranks at the TOP of the board.
 *
 * None of the three FAILED. Each returned an empty set, which reads as "clean".
 * That is why this is a source-level gate rather than three behavioural tests: the
 * fourth call site is the one nobody will write a test for.
 */
/**
 * Every argument list passed to `name(` in `src/cli-main.ts`. Brace-balanced rather
 * than a line regex: the options object spans lines and holds nested literals, so
 * a line-wise pattern would pass a call whose `layout` sat in a NESTED object.
 */
function argsOfCalls(name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  for (
    let i = CLI_SRC.indexOf(needle);
    i !== -1;
    i = CLI_SRC.indexOf(needle, i + 1)
  ) {
    let depth = 0;
    let end = i + needle.length;
    for (; end < CLI_SRC.length; end++) {
      const c = CLI_SRC[end];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" && depth === 0) break;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(CLI_SRC.slice(i + needle.length, end));
  }
  return out;
}

test("every layout-taking detector call in cli.ts passes a layout (2026-08-12 sweep)", () => {
  // BOTH entry points into the same detector: `findUntestedSurfaces` directly, and
  // `skillTestNudge`, which forwards its options straight into it. Filtered to the
  // calls carrying `basePath`, so the import list and the doc prose are not calls.
  for (const fn of ["findUntestedSurfaces", "skillTestNudge"]) {
    const calls = argsOfCalls(fn).filter((a) => a.includes("basePath"));
    assert.ok(calls.length >= 1, `${fn} call sites must exist`);
    for (const args of calls) {
      assert.match(
        args,
        /\blayout\b/,
        `${fn}(${args.trim().slice(0, 60)}…) omits \`layout\` — it silently scans ` +
          "every repo as Claude Code and finds nothing in a Codex one, and an empty " +
          "scan does not fail, it just goes quiet. Pass `harnessLayoutFor(root, " +
          "config)`, or `adapter.layout` where one is already resolved.",
      );
    }
  }
});
