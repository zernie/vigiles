/**
 * C1, differential: real bash is the oracle for `execSites`.
 *
 * Each form runs under `bash -c` in a temp directory with a stub `git` first in
 * `PATH` that logs its argv; remote and privilege runners are stubbed to do
 * nothing. The ONE forbidden outcome: the stub logged a force push and the sites
 * say nothing about it — no exec site with that push and no `unseen` site.
 * Sets are compared, never messages.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execSites } from "./bash-effects.js";

const hasBash =
  spawnSync("bash", ["-c", "test ${BASH_VERSINFO[0]} -ge 4"]).status === 0;
if (!hasBash)
  console.warn(
    "SKIPPED: the bash>=4 oracle for execSites is not installed here",
  );

const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
/** How a payload is quoted into a `-c` string, one way per entry. */
const QUOTINGS: readonly ((s: string) => string)[] = [
  q,
  (s) => `"${s.replace(/["$`\\]/g, "\\$&")}"`,
  (s) => `$'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`,
  (s) => `${q(s.slice(0, 3))}${q(s.slice(3))}`,
];
/** `git push -f` in `depth` levels of `shell -c`, each level quoted by `quote`. */
const wrapIn = (
  shell: string,
  quote: (s: string) => string,
  depth: number,
): string =>
  Array.from({ length: depth }).reduce(
    (c: string) => `${shell} -c ${quote(c)}`,
    "git push -f",
  );
const generated = ["sh", "bash", "dash"].flatMap((shell) =>
  QUOTINGS.flatMap((quote) =>
    [1, 2, 3, 4, 5].map((d) => wrapIn(shell, quote, d)),
  ),
);

const nestedOnce = `bash -c 'git push -f'`;
const FORMS = [
  ...generated,
  `bash -c 'git push "$1"' _ -f`,
  `bash -c 'git push -f "$@"' -- origin main`,
  `find . -name w -exec sh -c "git push -f" \\;`,
  `find . -name w -exec git push -f \\;`,
  `bash -c "git push $(echo -f)"`,
  `bash -c "$CMD"`,
  `eval "$CMD"`,
  `eval git push -f`,
  `builtin eval "git push -f"`,
  `bash <<< "git push -f"`,
  `bash <<EOF\ngit push -f\nEOF`,
  `sh -s <<'EOF'\ngit push -f\nEOF`,
  `echo 'git push -f' | bash`,
  `source x.sh`,
  `bash x.sh`,
  `$(echo git) push -f`,
  `G=git; $G push -f`,
  `exec git push -f`,
  `exec sh -c "git push -f"`,
  `script -qc "git push -f" /dev/null`,
  `flock lock -c "git push -f"`,
  `flock lock git push -f`,
  `env -S 'git push -f'`,
  `env -S 'git push -f' origin main`,
  `bash <<< ':' 3<<< 'git push -f' <&3`,
  `timeout 5 setsid git push -f`,
  `ls | xargs -I{} sh -c "cd {} && git push -f"`,
];

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
    },
    timeout: 5000,
  });
  const lines = readFileSync(log, { encoding: "utf8", flag: "a+" }).split("\n");
  return lines.some(
    (l) => l.startsWith("push") && / (-f|--force)( |$)/.test(` ${l}`),
  );
}

/** Does `execSites` say anything about a force push in `form`: proven, or unseen? */
function seen(form: string): boolean {
  return execSites(form).some(
    (s) =>
      s.kind === "unseen" || (s.leaf.head === "git" && s.leaf.hasFlag("force")),
  );
}

function stubTree(): string {
  const work = mkdtempSync(join(tmpdir(), "exec-sites-"));
  mkdirSync(join(work, "bin"));
  mkdirSync(join(work, "w", "w"), { recursive: true });
  const log = join(work, "git.log");
  writeFileSync(
    join(work, "bin", "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(join(work, "w", "x.sh"), "git push -f\n");
  return work;
}

describe.skipIf(!hasBash)("C1: real bash is the oracle (integration)", () => {
  test("a push bash performed is always a site: proven or unseen", () => {
    const work = stubTree();
    const silent = FORMS.filter((f) => bashPushed(work, f) && !seen(f));
    rmSync(work, { recursive: true, force: true });
    assert.deepEqual(silent, []);
  });

  test("the oracle is live: the stub sees a push, and only a push", () => {
    const work = stubTree();
    const ran = [`git push -f`, nestedOnce, `git push`].map((f) =>
      bashPushed(work, f),
    );
    rmSync(work, { recursive: true, force: true });
    assert.deepEqual(ran, [true, true, false]);
  });
});
