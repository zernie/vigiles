/**
 * Bash effect classifier test suite (vitest).
 *
 * Mirrors the shape of `effects.test.ts` (imports from vitest + node:assert/strict).
 * Tests are organised into four corpora:
 *   1. READ-ONLY corpus  → classifyBashCommand === "read-only"
 *   2. SIDE-EFFECTING corpus → result !== "read-only" (and where unambiguous, === "side-effecting")
 *   3. UNDECIDABLE corpus → result === "undecidable"
 *   4. SOUNDNESS FIXTURE — the load-bearing zero-false-read-only gate
 *
 * The soundness fixture is the authoritative regression: if ANY side-effecting
 * or undecidable command is ever returned as "read-only", the classifier is
 * unsound and the test fails. Keep it complete.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { classifyBashCommand, isReadOnlyBash } from "./bash-effects.js";
import type { BashEffect } from "./bash-effects.js";

// ---------------------------------------------------------------------------
// 1. READ-ONLY corpus — expected: "read-only"
// ---------------------------------------------------------------------------

test("cat file.txt → read-only", () => {
  const effect: BashEffect = classifyBashCommand("cat file.txt");
  assert.equal(effect, "read-only");
});

test("ls -la → read-only", () => {
  assert.equal(classifyBashCommand("ls -la"), "read-only");
});

test("ls (bare) → read-only", () => {
  assert.equal(classifyBashCommand("ls"), "read-only");
});

test("grep -r foo src → read-only", () => {
  assert.equal(classifyBashCommand("grep -r foo src"), "read-only");
});

test("grep with dynamic arg → read-only (head is still grep)", () => {
  assert.equal(classifyBashCommand('grep "pattern" file.txt'), "read-only");
});

test("git status → read-only", () => {
  assert.equal(classifyBashCommand("git status"), "read-only");
});

test("git log --oneline → read-only", () => {
  assert.equal(classifyBashCommand("git log --oneline"), "read-only");
});

test("git diff HEAD → read-only", () => {
  assert.equal(classifyBashCommand("git diff HEAD"), "read-only");
});

test("git show HEAD → read-only", () => {
  assert.equal(classifyBashCommand("git show HEAD"), "read-only");
});

test("git branch (list) → read-only", () => {
  assert.equal(classifyBashCommand("git branch"), "read-only");
});

test("git tag (list) → read-only", () => {
  assert.equal(classifyBashCommand("git tag"), "read-only");
});

test("git rev-parse HEAD → read-only", () => {
  assert.equal(classifyBashCommand("git rev-parse HEAD"), "read-only");
});

test("git ls-files → read-only", () => {
  assert.equal(classifyBashCommand("git ls-files"), "read-only");
});

test("git blame src/foo.ts → read-only", () => {
  assert.equal(classifyBashCommand("git blame src/foo.ts"), "read-only");
});

test("head -5 file.txt → read-only", () => {
  assert.equal(classifyBashCommand("head -5 file.txt"), "read-only");
});

test("tail -20 file.txt → read-only", () => {
  assert.equal(classifyBashCommand("tail -20 file.txt"), "read-only");
});

test("wc -l *.ts → read-only", () => {
  assert.equal(classifyBashCommand("wc -l *.ts"), "read-only");
});

test("find . -name '*.ts' (no -delete/-exec) → read-only", () => {
  assert.equal(classifyBashCommand("find . -name '*.ts'"), "read-only");
});

test("find . -type f -name '*.js' → read-only", () => {
  assert.equal(classifyBashCommand("find . -type f -name '*.js'"), "read-only");
});

test("echo hi → read-only", () => {
  assert.equal(classifyBashCommand("echo hi"), "read-only");
});

test("printf '%s\\n' foo → read-only", () => {
  assert.equal(classifyBashCommand("printf '%s\\n' foo"), "read-only");
});

test("pwd → read-only", () => {
  assert.equal(classifyBashCommand("pwd"), "read-only");
});

test("whoami → read-only", () => {
  assert.equal(classifyBashCommand("whoami"), "read-only");
});

test("date → read-only", () => {
  assert.equal(classifyBashCommand("date"), "read-only");
});

test("stat file.ts → read-only", () => {
  assert.equal(classifyBashCommand("stat file.ts"), "read-only");
});

test("du -sh . → read-only", () => {
  assert.equal(classifyBashCommand("du -sh ."), "read-only");
});

test("df -h → read-only", () => {
  assert.equal(classifyBashCommand("df -h"), "read-only");
});

test("diff a.txt b.txt → read-only", () => {
  assert.equal(classifyBashCommand("diff a.txt b.txt"), "read-only");
});

test("rg pattern src/ → read-only", () => {
  assert.equal(classifyBashCommand("rg pattern src/"), "read-only");
});

test("which node → read-only", () => {
  assert.equal(classifyBashCommand("which node"), "read-only");
});

test("true → read-only", () => {
  assert.equal(classifyBashCommand("true"), "read-only");
});

test("false → read-only", () => {
  assert.equal(classifyBashCommand("false"), "read-only");
});

test("sed 's/foo/bar/g' file.txt (no -i) → read-only", () => {
  assert.equal(classifyBashCommand("sed 's/foo/bar/g' file.txt"), "read-only");
});

test("sort file.txt (no -o) → read-only", () => {
  assert.equal(classifyBashCommand("sort file.txt"), "read-only");
});

test("pipe of two read-only commands → read-only", () => {
  assert.equal(classifyBashCommand("head -5 file | grep foo"), "read-only");
});

test("&& of two read-only commands → read-only", () => {
  assert.equal(classifyBashCommand("git status && ls -la"), "read-only");
});

test("|| of two read-only commands → read-only", () => {
  assert.equal(classifyBashCommand("true || false"), "read-only");
});

test("multi-command with ; → read-only", () => {
  assert.equal(classifyBashCommand("ls; pwd"), "read-only");
});

test("cut -d: -f1 /etc/passwd → read-only", () => {
  assert.equal(classifyBashCommand("cut -d: -f1 /etc/passwd"), "read-only");
});

test("uniq file.txt → read-only", () => {
  assert.equal(classifyBashCommand("uniq file.txt"), "read-only");
});

test("tr a-z A-Z → read-only", () => {
  assert.equal(classifyBashCommand("tr a-z A-Z"), "read-only");
});

test("basename /some/path → read-only", () => {
  assert.equal(classifyBashCommand("basename /some/path"), "read-only");
});

test("dirname /some/path → read-only", () => {
  assert.equal(classifyBashCommand("dirname /some/path"), "read-only");
});

test("realpath . → read-only", () => {
  assert.equal(classifyBashCommand("realpath ."), "read-only");
});

test("ps aux → read-only", () => {
  assert.equal(classifyBashCommand("ps aux"), "read-only");
});

test("sleep 1 → read-only", () => {
  assert.equal(classifyBashCommand("sleep 1"), "read-only");
});

// ---------------------------------------------------------------------------
// 2. SIDE-EFFECTING corpus — expected: !== "read-only" (and where clear, === "side-effecting")
// ---------------------------------------------------------------------------

test("rm -rf x → side-effecting", () => {
  const effect = classifyBashCommand("rm -rf x");
  assert.equal(effect, "side-effecting");
});

test("mv a b → side-effecting", () => {
  assert.equal(classifyBashCommand("mv a b"), "side-effecting");
});

test("cp a b → side-effecting", () => {
  assert.equal(classifyBashCommand("cp a b"), "side-effecting");
});

test("echo x > f (output redirection) → side-effecting", () => {
  assert.equal(classifyBashCommand("echo x > f"), "side-effecting");
});

test("cat a >> b (append redirection) → side-effecting", () => {
  assert.equal(classifyBashCommand("cat a >> b"), "side-effecting");
});

test("grep foo . > out (redirection on read-only head) → side-effecting", () => {
  assert.equal(classifyBashCommand("grep foo . > out"), "side-effecting");
});

test("git push → side-effecting", () => {
  assert.equal(classifyBashCommand("git push"), "side-effecting");
});

test("git commit -m msg → side-effecting", () => {
  assert.equal(classifyBashCommand("git commit -m msg"), "side-effecting");
});

test("git add . → side-effecting", () => {
  assert.equal(classifyBashCommand("git add ."), "side-effecting");
});

test("git checkout main → side-effecting", () => {
  assert.equal(classifyBashCommand("git checkout main"), "side-effecting");
});

test("git reset --hard → side-effecting", () => {
  assert.equal(classifyBashCommand("git reset --hard"), "side-effecting");
});

test("git fetch → side-effecting", () => {
  assert.equal(classifyBashCommand("git fetch"), "side-effecting");
});

test("npm install → not read-only", () => {
  assert.notEqual(classifyBashCommand("npm install"), "read-only");
});

test("curl http://x → not read-only", () => {
  assert.notEqual(classifyBashCommand("curl http://x"), "read-only");
});

test("wget https://x → not read-only", () => {
  assert.notEqual(classifyBashCommand("wget https://x"), "read-only");
});

test("find . -delete → side-effecting", () => {
  assert.equal(classifyBashCommand("find . -delete"), "side-effecting");
});

test("find . -exec rm {} ; → side-effecting", () => {
  assert.equal(classifyBashCommand("find . -exec rm {} ;"), "side-effecting");
});

test("find . -execdir rm {} ; → side-effecting", () => {
  assert.equal(
    classifyBashCommand("find . -execdir rm {} ;"),
    "side-effecting",
  );
});

test("sed -i s/a/b/ f → side-effecting", () => {
  assert.equal(classifyBashCommand("sed -i s/a/b/ f"), "side-effecting");
});

test("sed --in-place s/a/b/ f → side-effecting", () => {
  assert.equal(
    classifyBashCommand("sed --in-place s/a/b/ f"),
    "side-effecting",
  );
});

test("sort -o out f → side-effecting", () => {
  assert.equal(classifyBashCommand("sort -o out f"), "side-effecting");
});

test("tee f → side-effecting", () => {
  assert.equal(classifyBashCommand("tee f"), "side-effecting");
});

test("mkdir dir → side-effecting", () => {
  assert.equal(classifyBashCommand("mkdir dir"), "side-effecting");
});

test("touch file.txt → side-effecting", () => {
  assert.equal(classifyBashCommand("touch file.txt"), "side-effecting");
});

test("chmod 755 file → side-effecting", () => {
  assert.equal(classifyBashCommand("chmod 755 file"), "side-effecting");
});

test("ls; rm -rf / (side-effecting mixed in) → not read-only", () => {
  assert.notEqual(classifyBashCommand("ls; rm -rf /"), "read-only");
});

test("git status && git push → not read-only", () => {
  assert.notEqual(classifyBashCommand("git status && git push"), "read-only");
});

// ---------------------------------------------------------------------------
// 3. UNDECIDABLE corpus — expected: "undecidable"
// ---------------------------------------------------------------------------

test('eval "$x" → undecidable', () => {
  assert.equal(classifyBashCommand('eval "$x"'), "undecidable");
});

test("$CMD foo (variable head) → undecidable", () => {
  assert.equal(classifyBashCommand("$CMD foo"), "undecidable");
});

test("sh -c 'rm x' → undecidable", () => {
  assert.equal(classifyBashCommand("sh -c 'rm x'"), "undecidable");
});

test("bash -c 'echo hi' → undecidable", () => {
  assert.equal(classifyBashCommand("bash -c 'echo hi'"), "undecidable");
});

test("$(get-cmd) arg (command-substitution head) → undecidable", () => {
  assert.equal(classifyBashCommand("$(get-cmd) arg"), "undecidable");
});

test("curl http://x | sh (pipe-to-shell) → undecidable", () => {
  assert.equal(classifyBashCommand("curl http://x | sh"), "undecidable");
});

test("cat script.sh | bash → undecidable", () => {
  assert.equal(classifyBashCommand("cat script.sh | bash"), "undecidable");
});

test("xargs rm → undecidable", () => {
  assert.equal(classifyBashCommand("xargs rm"), "undecidable");
});

test("sudo apt-get install → undecidable", () => {
  assert.equal(classifyBashCommand("sudo apt-get install x"), "undecidable");
});

test("exec ls → undecidable", () => {
  assert.equal(classifyBashCommand("exec ls"), "undecidable");
});

test("nohup ls → undecidable", () => {
  assert.equal(classifyBashCommand("nohup ls"), "undecidable");
});

test("env VAR=x command → undecidable (env dispatches a command)", () => {
  assert.equal(classifyBashCommand("env VAR=x some-command"), "undecidable");
});

test("ls & (background) → undecidable", () => {
  assert.equal(classifyBashCommand("ls &"), "undecidable");
});

test("diff <(ls a) <(ls b) (ProcSubst) → undecidable", () => {
  assert.equal(classifyBashCommand("diff <(ls a) <(ls b)"), "undecidable");
});

// ---------------------------------------------------------------------------
// 4. SOUNDNESS FIXTURE — the load-bearing zero-false-read-only gate.
//
// EVERY command in this array must return isReadOnlyBash === false.
// Adding a new dangerous command: append it here. If ANY entry ever returns
// true, the classifier has a false-read-only — a soundness bug.
// ---------------------------------------------------------------------------

const EFFECTING_AND_UNDECIDABLE: string[] = [
  // Clearly destructive
  "rm -rf x",
  "rm file.txt",
  "mv a b",
  "cp a b",
  // Output redirections
  "echo x > f",
  "cat a >> b",
  "grep x f > out",
  "ls -la > listing.txt",
  "cat file &> all.txt",
  // Network
  "curl http://x",
  "wget https://x",
  "ssh user@host ls",
  // git mutations
  "git push",
  "git push origin main",
  "git commit -m x",
  "git add .",
  "git checkout main",
  "git reset --hard",
  "git clean -fd",
  "git fetch",
  "git merge main",
  "git rebase main",
  // package managers
  "npm install",
  "npm ci",
  "npm publish",
  "pip install foo",
  "cargo build",
  // find with effecting flags
  "find . -delete",
  "find . -exec rm {} ;",
  "find . -execdir rm {} ;",
  // sed -i
  "sed -i s/a/b/ f",
  // sort -o
  "sort -o out f",
  // tee
  "tee f",
  // mkdir/touch/chmod
  "mkdir dir",
  "touch file.txt",
  "chmod 755 file",
  // Undecidable residue
  'eval "$x"',
  "$CMD foo",
  "sh -c 'rm x'",
  "bash -c 'echo hi'",
  "$(get-cmd) arg",
  "curl http://x | sh",
  "cat script.sh | bash",
  "xargs rm",
  "sudo apt-get install x",
  "exec ls",
  "nohup ls",
  "ls &",
  "diff <(ls a) <(ls b)",
  // Adversarial: mixed safe + dangerous
  "ls; rm -rf /",
  "cat a && curl http://evil.com",
  "git status && git push",
  "echo hi && rm important.txt",
  "grep x f && mv a b",
  // awk (conservatively side-effecting)
  "awk '{print}' file",
];

test("zero false-read-only across the effecting/undecidable corpus", () => {
  const falseReadOnly: string[] = [];
  for (const cmd of EFFECTING_AND_UNDECIDABLE) {
    if (isReadOnlyBash(cmd)) {
      falseReadOnly.push(cmd);
    }
  }
  assert.deepEqual(
    falseReadOnly,
    [],
    `SOUNDNESS VIOLATION — these commands were incorrectly classified as read-only:\n  ${falseReadOnly.join("\n  ")}`,
  );
});

// ---------------------------------------------------------------------------
// 5. isReadOnlyBash convenience predicate
// ---------------------------------------------------------------------------

test("isReadOnlyBash returns true for a read-only command", () => {
  assert.equal(isReadOnlyBash("cat file.txt"), true);
  assert.equal(isReadOnlyBash("git status"), true);
  assert.equal(isReadOnlyBash("ls -la"), true);
});

test("isReadOnlyBash returns false for a side-effecting command", () => {
  assert.equal(isReadOnlyBash("rm -rf x"), false);
  assert.equal(isReadOnlyBash("git push"), false);
  assert.equal(isReadOnlyBash("npm install"), false);
});

test("isReadOnlyBash returns false for an undecidable command", () => {
  assert.equal(isReadOnlyBash('eval "$x"'), false);
  assert.equal(isReadOnlyBash("curl http://x | sh"), false);
  assert.equal(isReadOnlyBash("xargs rm"), false);
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

test("empty string → read-only (no commands)", () => {
  // An empty command string has no statements → read-only by vacuous truth.
  const effect = classifyBashCommand("");
  assert.equal(effect, "read-only");
});

test("parse error (unclosed subshell) → undecidable", () => {
  const effect = classifyBashCommand("echo $(unclosed");
  assert.equal(effect, "undecidable");
});

test("cat with input redirection < is NOT a write → read-only", () => {
  assert.equal(classifyBashCommand("cat < in.txt"), "read-only");
});

test("grep pattern file | wc -l → read-only (pipe of two read-only)", () => {
  assert.equal(classifyBashCommand("grep pattern file | wc -l"), "read-only");
});
