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

import {
  equivalentCommands,
  equivalentSpellings,
  sameOperation,
} from "./bash-equivalents.js";

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
    "bash -c 'git push --force origin main'",
    "sh -c 'git push --force origin main'",
    "eval 'git push --force origin main'",
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

test("sameOperation reads inside bash -c, sh -c and eval as the gate does", () => {
  for (const v of [
    "bash -c 'git push --force origin main'",
    "sh -c 'git push --force origin main'",
    "eval 'git push --force origin main'",
    `bash -c "git commit --no-verify -m 'skip hooks'"`,
  ])
    assert.ok(
      sameOperation(
        v.includes("commit") ? "git commit --no-verify -m 'skip hooks'" : SEED,
        v,
      ),
      v,
    );
});

test("a handed-on command the gate cannot read is never the same operation", () => {
  for (const v of [
    'bash -c "$X"',
    'sh -c "$CMD"',
    'eval "$X"',
    'bash -c "$(echo git push --force origin main)"',
  ])
    assert.equal(sameOperation(SEED, v), false, v);
});

test("git -C . is a spelling: the same push in the same directory", () => {
  const form = "git -C . push --force origin main";
  assert.equal(sameOperation(SEED, form), true);
  assert.ok(equivalentCommands(SEED).includes(form));
  // Another directory is another repository, not a spelling.
  assert.equal(
    sameOperation(SEED, "git -C ../o push --force origin main"),
    false,
  );
  // The compound seed: `-C .` goes on its first git leaf.
  assert.ok(
    equivalentCommands(
      "git commit -am wip && git push -f origin main",
    ).includes("git -C . commit -am wip && git push -f origin main"),
  );
});

test("flag aliases are scoped by program and subcommand, never global", () => {
  const out = (seed: string) => equivalentCommands(seed);
  // git push -n is --dry-run, not --no-verify.
  assert.ok(
    !out("git push --no-verify origin main").includes(
      "git push -n origin main",
    ),
  );
  // kubectl -f is a file, sed -n is quiet: no table, so no alias spellings.
  assert.ok(
    !out("kubectl delete -f prod.yaml").some((v) => v.includes("--force")),
  );
  assert.ok(!out("sed -n p f").some((v) => v.includes("--no-verify")));
  // Where the man page says so, the alias is emitted.
  assert.ok(out("git commit --no-verify -m x").includes("git commit -n -m x"));
  assert.ok(
    out("git push --force origin main").includes("git push -f origin main"),
  );
  assert.ok(out("rm -r build").includes("rm --recursive build"));
});

test("seeds a user might write never break the generator", () => {
  for (const seed of [
    "git push --force-with-lease origin main",
    "rm -rf / # cleanup",
    "cat > f <<'EOF'\nrm -rf /\nEOF",
    "[[ -d .git ]] && git push --force",
    "DROP=1 psql -c 'drop table users'",
  ]) {
    const out = equivalentCommands(seed);
    for (const v of out) assert.ok(sameOperation(seed, v), `${seed} → ${v}`);
    assert.ok(!out.some((v) => v.includes("-f-with-lease")), seed);
    assert.ok(
      !out.some((v) =>
        /^(\/usr\/bin\/|\/bin\/|\\|sudo |\$')(DROP=|\[\[)/.test(v),
      ),
      seed,
    );
  }
  assert.ok(
    equivalentCommands("rm -rf / # cleanup").includes(
      "( rm -rf / # cleanup\n)",
    ),
  );
  assert.deepEqual(equivalentCommands(""), []);
});

test("a family that cannot prove a rewrite throws by default and is counted when lenient", () => {
  const bogus = [{ name: "bogus", rewrite: () => ["git push origin main"] }];
  assert.throws(() => equivalentCommands(SEED, { families: bogus }));
  const lenient = equivalentSpellings(SEED, { families: bogus });
  assert.deepEqual(lenient.proven, []);
  assert.deepEqual(lenient.unproven, ["git push origin main"]);
});
