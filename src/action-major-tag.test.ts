/**
 * The Action's floating major tag — does the ref we EMIT resolve to a ref the
 * release pipeline MAINTAINS?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `vigiles init` writes a workflow containing `uses: zernie/vigiles@v1`, and
 * docs/github-action.md tells users to pin that. The release pipeline was moving
 * a floating tag derived from the newest PACKAGE version (`v1.2.3` -> `v1`, so at
 * package 26 it moved `v26`), which meant `v1` was never created at all: every
 * new user's first PR after `init` failed with "Unable to resolve action
 * zernie/vigiles@v1". Nothing caught it for 25 majors because this repo dogfoods
 * the Action as `uses: ./`, a path that resolves no ref — so the one ref that
 * ships to users was the one ref nothing ever resolved.
 *
 * ── WHY IT READS BOTH SIDES INSTEAD OF ASSERTING "v1" ───────────────────────────
 * A test that hardcodes the string cannot fail for the reason this bug happened:
 * the two sides disagreeing. Both are EXTRACTED — the maintained tag from
 * release.yml's `ACTION_MAJOR_TAG`, the emitted refs from src/cli-main.ts — so a
 * future rename that touches only one side fails here, and a rename that touches
 * both passes without editing this file.
 *
 * src/cli-main.ts is read as TEXT on purpose: the workflow template is a private
 * string builder, and the point is to assert on the bytes that actually reach the
 * user's `.github/workflows/vigiles.yml`, not on a re-derivation of them.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(__dirname, "..");
const RELEASE = resolve(ROOT, ".github", "workflows", "release.yml");
// The verb barrel, where `init`'s workflow template lives. `src/cli.ts` is only
// the dispatcher shim since #216 and emits no Action ref at all.
const CLI = resolve(ROOT, "src", "cli-main.ts");

/** A `zernie/vigiles@<ref>` occurrence: the ref, and the line it sits on. */
type Ref = { ref: string; line: number; file: string };

/** Every action ref in a blob of text, with 1-based line numbers for the message. */
function refsIn(text: string, file: string): Ref[] {
  const out: Ref[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/zernie\/vigiles@([A-Za-z0-9][\w.-]*)/g))
      out.push({ ref: m[1], line: i + 1, file });
  });
  return out;
}

/**
 * The floating tag the release pipeline actually moves. Read from the step's
 * `env:` rather than from a comment, because the env value is what the shell
 * pushes — a comment could agree while the code disagreed.
 */
function maintainedTag(): string {
  const yml = readFileSync(RELEASE, "utf8");
  const m = /^\s*ACTION_MAJOR_TAG:\s*(\S+)\s*$/m.exec(yml);
  if (m === null)
    throw new Error(
      "no ACTION_MAJOR_TAG in .github/workflows/release.yml — the floating-tag " +
        "step was renamed or restructured, and this test can no longer see the " +
        "tag it is asserting. Re-point it at whatever declares the tag now; do " +
        "not delete the assertion.",
    );
  return m[1];
}

describe("the Action's floating major tag", () => {
  it("is declared in a shape the pipeline can push (vN)", () => {
    assert.match(
      maintainedTag(),
      /^v[0-9]+$/,
      "the maintained ref must be a bare major tag like `v1` — a full version " +
        "would stop floating, and anything else is not a tag the step can push",
    );
  });

  it("is the same ref `vigiles init` emits into the user's workflow", () => {
    const tag = maintainedTag();
    const emitted = refsIn(readFileSync(CLI, "utf8"), "src/cli-main.ts");
    assert.ok(
      emitted.length > 0,
      "src/cli-main.ts emits no `zernie/vigiles@<ref>` at all — either init stopped " +
        "wiring the Action, or the template moved and this test went blind",
    );
    for (const { ref, line, file } of emitted)
      assert.equal(
        ref,
        tag,
        `${file}:${line} emits \`zernie/vigiles@${ref}\` but the release pipeline ` +
          `maintains \`${tag}\` (.github/workflows/release.yml ACTION_MAJOR_TAG). ` +
          `Users who run \`vigiles init\` would get "Unable to resolve action". ` +
          `Change both sides together.`,
      );
  });

  it("is the ref every doc and skill tells users to pin", () => {
    const tag = maintainedTag();
    // Tracked files only, and never this file (it names refs to describe them).
    const hits = execFileSync(
      "git",
      ["grep", "-n", "-I", "-e", "zernie/vigiles@", "--", ".", ":!dist"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const self = "src/action-major-tag.test.ts";
    const bad: string[] = [];
    for (const raw of hits.split("\n")) {
      if (raw === "" || raw.startsWith(`${self}:`)) continue;
      const [file, line] = raw.split(":", 2);
      for (const { ref } of refsIn(
        raw.slice(raw.indexOf(":", raw.indexOf(":") + 1)),
        file,
      )) {
        // Legitimate pins, all documented in docs/github-action.md: the
        // floating major the pipeline moves, an IMMUTABLE full release tag, a
        // commit SHA, or `main`. What must never appear is a DIFFERENT bare
        // major (`@v7`, `@v26`) — the v2…v26 tags the old package-derived logic
        // left behind are frozen, so pinning one silently freezes the wrapper.
        const ok =
          ref === tag ||
          /^v\d+\.\d+(\.\d+)?$/.test(ref) ||
          /^[0-9a-f]{40}$/.test(ref) ||
          ref === "main";
        if (!ok) bad.push(`${file}:${line} pins @${ref}`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `these pin a floating major the release pipeline does not move (it moves ` +
        `\`${tag}\`; a full release tag or a SHA is fine, another bare major is ` +
        `frozen forever): ${bad.join(", ")}`,
    );
  });
});
