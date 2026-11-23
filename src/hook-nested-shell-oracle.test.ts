/**
 * vigiles#460 against real bash: does a force-push bash actually PERFORMS ever
 * get a silent `allow` from a gate that blocks `git push -f`?
 *
 * Each form runs under `bash -c` in a temp directory with a stub `git` first in
 * `PATH` that logs its argv; `sudo`, `su`, `ssh`, `docker` and `kubectl` are
 * stubbed to run nothing (so "no push" in those rows means "not here", not
 * "safe"). The one forbidden outcome: the stub logged a force push and the
 * gate said `allow`. A form outside what the gate claims to see — a dynamic
 * program name, a script file, another language's interpreter, a flag held in
 * a variable — is named in {@link OUT_OF_SCOPE}, so the set that still slips
 * through is pinned exactly: a regression adds a row, an improvement removes
 * one, and both fail this test until the list is edited on purpose.
 *
 * Integration tier: needs bash ≥ 4. Elsewhere it is skipped LOUDLY.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  experimental_defineHook,
  allow,
  deny,
  decideProgram,
} from "./core/hook-program.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const hasBash =
  spawnSync("bash", ["-c", "test ${BASH_VERSINFO[0]} -ge 4"]).status === 0;
if (!hasBash)
  console.warn("SKIPPED: the bash>=4 oracle for vigiles#460 is not installed");

const forcePushGuard = experimental_defineHook({
  on: "PreToolUse",
  decide: (e) =>
    e.command.runs("git push", { force: true }) ? deny("force-push") : allow(),
});

/** The forms of the #460 measurement: the plain push, its wrappers, its carriers. */
const FORMS: readonly string[] = [
  `git push -f`,
  `cd w && git push -f`,
  `bash -c "cd w && git push -f"`,
  `sh -c "git push -f"`,
  `sh -c 'git push -f'`,
  `zsh -c "git push -f"`,
  `ksh -c "git push -f"`,
  `dash -c "git push -f"`,
  `/bin/sh -c "git push -f"`,
  `env bash -c "git push -f"`,
  `env -i bash -c "git push -f"`,
  `bash -lc "git push -f"`,
  `bash -e -c "git push -f"`,
  `bash -o pipefail -c "git push -f"`,
  `bash -c -e 'git push -f'`,
  `bash -xc 'git push -f'`,
  `bash --norc -c 'git push -f'`,
  `bash -c 'git push -f "$@"' -- origin main`,
  `bash -c 'git push "$1"' _ -f`,
  `sudo sh -c "git push -f"`,
  `sudo -u x bash -c "git push -f"`,
  `timeout 5 sh -c "git push -f"`,
  `nohup sh -c "git push -f"`,
  `command sh -c "git push -f"`,
  `echo x | xargs sh -c "git push -f"`,
  `ls | xargs -I{} sh -c "cd {} && git push -f"`,
  `find . -name w -exec sh -c "git push -f" \\;`,
  `find . -name w -exec git push -f \\;`,
  `bash -c "sh -c 'git push -f'"`,
  `cd w && bash -c "git push -f"`,
  `bash -c "git push $(echo -f)"`,
  `bash -c "$CMD"`,
  `bash -c "git pu""sh -f"`,
  `bash -c $'git push -f'`,
  `eval "git push -f"`,
  `eval git push -f`,
  `builtin eval "git push -f"`,
  `eval "$X"`,
  `bash <<< "git push -f"`,
  `bash <<EOF\ngit push -f\nEOF`,
  `bash <<'EOF'\ngit push -f\nEOF`,
  `sh -s <<EOF\ngit push -f\nEOF`,
  `echo 'git push -f' | bash`,
  `printf 'git push -f' | sh`,
  `source x.sh`,
  `. ./x.sh`,
  `bash x.sh`,
  `echo $(git push -f)`,
  "echo `git push -f`",
  `cat <(git push -f)`,
  `$(echo git) push -f`,
  `G=git; $G push -f`,
  `F=-f; git push $F`,
  `exec git push -f`,
  `exec sh -c "git push -f"`,
  `time git push -f`,
  `f(){ git push -f; }; f`,
  `if true; then git push -f; fi`,
  `script -qc "git push -f" /dev/null`,
  `flock lock -c "git push -f"`,
  `flock lock git push -f`,
  `su -c "git push -f" me`,
  `watch -n1 "git push -f"`,
  `parallel "git push -f" ::: a`,
  `env -S 'git push -f'`,
  `timeout 5 setsid git push -f`,
  `echo -f | xargs git push`,
  `ssh host 'git push -f'`,
  `docker exec c sh -c "git push -f"`,
  `kubectl exec p -- sh -c "git push -f"`,
  `node -e "require('child_process').execSync('git push -f')"`,
  `python3 -c "import os; os.system('git push -f')"`,
  `perl -e 'system("git push -f")'`,
  `git -c alias.p='push -f' p`,
  `git -c alias.p='!git push -f' p`,
  `git commit -m "bash -c 'git push -f'"`,
];

/**
 * What still reaches `allow` while bash pushes, by design: the gate reads the
 * plain shell and `eval` forms and asks on the programs it knows hide a
 * command; these are not in that closed set (docs/compiled-hooks.md, "What a
 * Bash gate can and cannot see").
 */
const OUT_OF_SCOPE: readonly string[] = [
  `source x.sh`,
  `. ./x.sh`,
  `bash x.sh`,
  `$(echo git) push -f`,
  `G=git; $G push -f`,
  `F=-f; git push $F`,
  `node -e "require('child_process').execSync('git push -f')"`,
  `python3 -c "import os; os.system('git push -f')"`,
  `perl -e 'system("git push -f")'`,
];

function stubTree(): string {
  const work = makeTmpDir();
  mkdirSync(join(work, "bin"));
  mkdirSync(join(work, "w", "w"), { recursive: true });
  const log = join(work, "git.log");
  writeFileSync(
    join(work, "bin", "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`,
    { mode: 0o755 },
  );
  for (const inert of ["sudo", "su", "ssh", "docker", "kubectl"])
    writeFileSync(join(work, "bin", inert), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  writeFileSync(join(work, "w", "x.sh"), "git push -f\n");
  return work;
}

/** Run `form` under real bash; did the stub record a force push? */
function bashPushed(work: string, form: string): boolean {
  const log = join(work, "git.log");
  rmSync(log, { force: true });
  spawnSync("bash", ["-c", form], {
    cwd: join(work, "w"),
    env: {
      PATH: `${join(work, "bin")}:/usr/bin:/bin`,
      HOME: work,
      CMD: "git push -f",
      X: "git push -f",
    },
    input: "",
    timeout: 3000,
  });
  const lines = readFileSync(log, { encoding: "utf8", flag: "a+" }).split("\n");
  return lines.some(
    (l) => /^push\b/.test(l) && / (-f|--force)( |$)/.test(` ${l}`),
  );
}

const allowed = (form: string): boolean =>
  decideProgram(forcePushGuard, {
    tool_name: "Bash",
    tool_input: { command: form },
  }).kind === "allow";

describe.skipIf(!hasBash)("vigiles#460: real bash is the oracle", () => {
  test("a push bash performed is never a silent allow, outside the named scope", () => {
    const work = stubTree();
    try {
      const pushed = FORMS.filter((f) => bashPushed(work, f));
      const silent = pushed.filter(allowed);
      console.log(
        `vigiles#460 oracle: ${FORMS.length} forms, bash pushed in ${pushed.length}, allowed while pushing ${silent.length}`,
      );
      assert.deepEqual(
        silent,
        OUT_OF_SCOPE.filter((f) => pushed.includes(f)),
      );
    } finally {
      cleanupTmpDir(work);
    }
  });

  test("the oracle is live: the stub sees a push, and only a push", () => {
    const work = stubTree();
    try {
      const ran = [`git push -f`, `bash -c 'git push -f'`, `git push`].map(
        (f) => bashPushed(work, f),
      );
      assert.deepEqual(ran, [true, true, false]);
    } finally {
      cleanupTmpDir(work);
    }
  });
});
