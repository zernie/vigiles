/**
 * Unit tests for the known-flag registry — the half of the "audit silently
 * swallows unknown flags" defect that can be tested without spawning the CLI.
 * The behavioural half (exit codes, `--help`, the nothing-to-audit outcome)
 * lives in src/scan-cli.test.ts, which drives the real built binary.
 */
import { describe, it, test } from "vitest";
import assert from "node:assert/strict";

import {
  COMMAND_FLAGS,
  formatUnknownFlag,
  knownFlagsFor,
  nearestFlag,
  unknownFlags,
  rebasePathArgs,
} from "./cli-flag-check.js";
import { VERBS } from "./cli-commands.js";

test("an unrecognised flag is reported, per verb", () => {
  // The measured reproduction: this ran a complete audit and exited 0.
  assert.deepEqual(unknownFlags("audit", ["--this-flag-does-not-exist"]), [
    "--this-flag-does-not-exist",
  ]);
  // …and a typo of a REAL flag, which is the dangerous case: `--no-htlm` used
  // to write the HTML report while the author believed they had suppressed it.
  assert.deepEqual(unknownFlags("audit", ["--no-htlm"]), ["--no-htlm"]);
});

test("every flag a verb actually reads is accepted", () => {
  // Guards the other direction: over-rejecting is worse than the defect, since
  // it breaks working invocations.
  for (const verb of VERBS) {
    for (const spec of COMMAND_FLAGS[verb]) {
      const arg = spec.endsWith("=") ? `${spec}value` : spec;
      assert.deepEqual(
        unknownFlags(verb, [arg]),
        [],
        `${verb} must accept its own flag ${arg}`,
      );
    }
  }
});

test("shared flags are accepted everywhere; positionals are never flags", () => {
  for (const verb of VERBS) {
    assert.deepEqual(unknownFlags(verb, ["--harness=codex", "--help"]), []);
  }
  assert.deepEqual(
    unknownFlags("audit", ["./some/dir", "-", "--", "--wat"]),
    [],
    "a positional, a lone dash, and everything after `--` are not flags",
  );
});

test("hook-runtime is exempt — its argv comes from the harness, not a human", () => {
  assert.deepEqual(unknownFlags("hook-runtime", ["--anything-at-all"]), []);
});

test("a value flag rejects the space-separated form it cannot read", () => {
  // `flagValue()` only ever reads `--out=x`. `--out dir` used to leave `--out`
  // unread and `dir` interpreted as the scan target — the exact shape of the
  // bug that made an audit run over the wrong directory.
  assert.deepEqual(unknownFlags("audit", ["--out", "/tmp/x"]), ["--out"]);
  assert.deepEqual(unknownFlags("audit", ["--out=/tmp/x"]), []);
});

test("the nearest-flag suggestion fires on a typo and stays quiet otherwise", () => {
  const known = knownFlagsFor("audit");
  assert.equal(nearestFlag("--no-htlm", known), "--no-html");
  assert.equal(nearestFlag("--jsonn", known), "--json");
  // Nothing close: a wrong suggestion invites "fixing" a flag never meant.
  assert.equal(nearestFlag("--completely-unrelated-thing", known), undefined);
});

test("the message names the flag, the verb, and where to look", () => {
  const msg = formatUnknownFlag("audit", "--no-htlm");
  assert.ok(msg.includes('unknown flag "--no-htlm"'), msg);
  assert.ok(msg.includes("Did you mean `--no-html`?"), msg);
  assert.ok(msg.includes("vigiles audit --help"), msg);
});

describe("rebasePathArgs: paths typed in a subdirectory, re-expressed from the root", () => {
  const up = (p: string) => `src/${p}`;

  it("rebases path positionals and path-valued flags only", () => {
    assert.deepEqual(
      rebasePathArgs("lint", [".", "--json", "--json-out=r.json"], up),
      ["src/.", "--json", "--json-out=src/r.json"],
    );
    assert.deepEqual(rebasePathArgs("audit", ["--out=rep", "--no-html"], up), [
      "--out=src/rep",
      "--no-html",
    ]);
  });

  it("leaves a generate kind, a word, and everything after -- alone", () => {
    assert.deepEqual(rebasePathArgs("generate", ["types", "out.d.ts"], up), [
      "types",
      "src/out.d.ts",
    ]);
    assert.deepEqual(rebasePathArgs("compile", ["a.spec.ts", "--", "x"], up), [
      "src/a.spec.ts",
      "--",
      "x",
    ]);
  });

  it("never touches hook-runtime's machine-supplied argv or an unknown verb", () => {
    const argv = ["run-program", "x.hook.mjs"];
    assert.deepEqual(rebasePathArgs("hook-runtime", argv, up), argv);
    assert.deepEqual(rebasePathArgs("nope", argv, up), argv);
  });
});
