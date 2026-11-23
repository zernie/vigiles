/**
 * Tests for the spelling generator behind `experimental_alternateSpellings`.
 *
 * Two properties carry the whole design and each is asserted directly:
 * (1) every emitted spelling is the SAME OPERATION by our own normalizer — a
 * family that produced something else must THROW, never drop it silently;
 * (2) the families cover the shell's own obfuscations (quoting inside a word,
 * ANSI-C quoting, a backslash before an ordinary character, blank runs), so a
 * source-string matcher is exercised on each. Counts are asserted as floors,
 * not exact numbers: adding a family must not break this file.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { equivalentCommands, sameOperation } from "./bash-equivalents.js";

const SEED = "git push --force origin main";

test("sameOperation: the shell's own obfuscations are the same operation", () => {
  for (const v of [
    'git push "--force" origin main',
    "git push -f origin main",
    "/usr/bin/git push --force origin main",
    "sudo git push --force origin main",
    'g""it push --force origin main',
    "$'git' push --force origin main",
    "g\\it push --force origin main",
    "git\tpush   --force\torigin main",
  ])
    assert.ok(sameOperation(SEED, v), `expected equivalent: ${v}`);
});

test("sameOperation: a different operation, or an undecidable one, is NOT", () => {
  assert.equal(sameOperation(SEED, "git push origin main"), false);
  assert.equal(sameOperation(SEED, "$CMD push --force origin main"), false);
  assert.equal(sameOperation(SEED, 'eval "git push --force"'), false);
  assert.equal(sameOperation("", SEED), false);
});

test("every family fires on the force-push seed and every output is equivalent", () => {
  const out = equivalentCommands(SEED);
  assert.ok(out.length >= 15, `expected a real set, got ${String(out.length)}`);
  assert.ok(!out.includes(SEED), "the seed itself is never emitted");
  for (const v of out)
    assert.ok(
      sameOperation(SEED, v),
      `generator emitted a non-equivalent: ${v}`,
    );
  for (const must of [
    'git push "--force" origin main',
    "git push -f origin main",
    "/usr/bin/git push --force origin main",
    "\\git push --force origin main",
    "sudo git push --force origin main",
    'g""it push --force origin main',
    '"git" push --force origin main',
    'gi"t" push --force origin main',
    "$'git' push --force origin main",
    "g\\it push --force origin main",
    "git   push   --force   origin   main",
    "git\tpush\t--force\torigin\tmain",
    "( git push --force origin main )",
  ])
    assert.ok(out.includes(must), `missing spelling: ${JSON.stringify(must)}`);
});

test("whitespace family keeps blanks INSIDE quotes and collapses a source tab", () => {
  const out = equivalentCommands("git commit --no-verify -m 'skip hooks'");
  assert.ok(out.includes("git\tcommit\t--no-verify\t-m\t'skip hooks'"));
  const tabbed = equivalentCommands("git\tpush --force origin main");
  assert.ok(tabbed.includes("git   push   --force   origin   main"));
});

test("a family that does not apply yields nothing rather than something wrong", () => {
  // A one-letter head: nothing to quote or alias, and the escaped-LETTER family
  // needs two letters (`g\it`), so it yields nothing — while the older
  // leading-backslash family (`\w`, the alias-bypass idiom) still applies.
  const out = equivalentCommands("w");
  assert.ok(out.every((v) => sameOperation("w", v)));
  assert.ok(out.includes("\\w"), "leading backslash still emitted");
  assert.ok(
    !out.some((v) => v.startsWith("w\\")),
    "no escaped letter inside a 1-letter head",
  );
});

test("the forms one-level sameOperation cannot prove stay out of the generator", () => {
  // `bash -c`, `sh -c`, `eval` hand the seed on as ONE word, and `git -C .`
  // keeps `.` as an argument: the one-level normalizer reads none of them as
  // the seed's operation, so none is emitted (the self-check would throw).
  const unproven = [
    "bash -c 'git push --force origin main'",
    "sh -c 'git push --force origin main'",
    "eval 'git push --force origin main'",
    "git -C . push --force origin main",
  ];
  const out = equivalentCommands(SEED);
  for (const form of unproven) {
    assert.equal(sameOperation(SEED, form), false, form);
    assert.ok(!out.includes(form), form);
  }
});
