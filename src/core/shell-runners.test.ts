/**
 * The closed table of runners — programs that run a command they were handed.
 *
 * The property under test is the table's promise: every row is either PARSED
 * (its command becomes a leaf) or reported UNSEEN, never silence. The test walks
 * the table itself, not a copy of it, so a new row without an instance here
 * fails until someone writes down what that row should find.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { execSites, type ExecSite } from "./bash-effects.js";
import { RUNNERS, decodeAnsiC, type RunnerMode } from "./shell-runners.js";

/** One command per row that hands that row `git push -f` (or an opaque payload). */
const INSTANCES: Readonly<Record<string, string>> = {
  env: "env FOO=1 git push -f",
  command: "command git push -f",
  nice: "nice -n5 git push -f",
  timeout: "timeout 5 git push -f",
  sudo: "sudo -u x git push -f",
  xargs: "echo | xargs git push -f",
  nohup: "nohup git push -f",
  exec: "exec -a name git push -f",
  builtin: "builtin eval 'git push -f'",
  setsid: "setsid -f git push -f",
  stdbuf: "stdbuf -o L git push -f",
  ionice: "ionice -c 3 git push -f",
  chrt: "chrt -b 0 git push -f",
  taskset: "taskset 0x1 git push -f",
  time: "command time -p git push -f",
  find: "find . -name x -execdir git push -f {} +",
  sh: "sh -c 'git push -f'",
  bash: "bash -e -o pipefail -c 'git push -f'",
  dash: "dash -c 'git push -f'",
  zsh: "zsh -c 'git push -f'",
  ksh: "ksh -c 'git push -f'",
  mksh: "mksh -c 'git push -f'",
  ash: "ash -c 'git push -f'",
  su: "su -c 'git push -f' me",
  runuser: "runuser me --command='git push -f'",
  flock: "flock /tmp/l -c 'git push -f'",
  script: "script -qc 'git push -f' /dev/null",
  npx: "npx -c 'git push -f'",
  eval: "eval git push -f",
  watch: "watch -n1 'git push -f'",
  parallel: "parallel -j2 'git push -f' ::: a",
  source: "source x.sh",
  ".": ". x.sh",
  python: "python -c 'import os'",
  python3: "python3 - <<'EOF'\nimport os\nEOF",
  node: "node --eval=1",
  perl: "perl -E 1",
  ruby: "ruby -e 1",
  php: "php -r 1",
  deno: "deno eval 1",
  bun: "bun -e 1",
  osascript: "osascript -e 1",
  pwsh: "pwsh -c 1",
  powershell: "powershell -Command 1",
  lua: "lua -e 1",
  fish: "fish -c 'git push -f'",
  ssh: "ssh -p 22 host 'git push -f'",
  docker: "docker exec c sh -c 'git push -f'",
  podman: "podman exec c sh",
  kubectl: "kubectl exec p -- sh",
  lxc: "lxc exec c -- sh",
  nsenter: "nsenter -t 1 sh",
  chroot: "chroot /x sh",
};

/** The modes whose command the descent cannot read: they must say so. */
const OPAQUE: ReadonlySet<RunnerMode> = new Set([
  "script-file",
  "foreign-interpreter",
  "other-context",
]);

const forcePush = (s: ExecSite): boolean =>
  s.kind === "exec" &&
  s.leaf.head === "git" &&
  s.leaf.args.includes("push") &&
  s.leaf.hasFlag("force");

describe("every RUNNERS row is parsed or opaque, never silent", () => {
  test("every row has an instance here", () => {
    const missing = [...RUNNERS.keys()].filter((h) => !(h in INSTANCES));
    assert.deepEqual(missing, [], "a RUNNERS row without an instance");
  });

  test.each([...RUNNERS.entries()])("%s", (head, row) => {
    const sites = execSites(INSTANCES[head] ?? "");
    if (OPAQUE.has(row.mode)) {
      const u = sites.find((s) => s.kind === "unseen" && s.head === head);
      assert.ok(u, `no unseen site for ${head}: ${JSON.stringify(sites)}`);
      return;
    }
    assert.ok(sites.some(forcePush), `${head}: the push is not a site`);
    // A wrapper is resolved IN PLACE (today's leaf); every other row nests.
    const nested = sites.some((s) => forcePush(s) && s.via.length > 0);
    assert.equal(nested, row.mode !== "wrapper", head);
  });

  test("env -S splits its string into the command", () => {
    assert.ok(execSites("env -S 'git push -f'").some(forcePush));
  });
});

/** An exec site the runner handed on: it must not exist past an undeclared option. */
const cameThrough = (s: ExecSite, head: string): boolean =>
  s.kind === "exec" && s.via.some((c) => c.head === head);

/** `cmd` with `token` inserted right after the row's head, before its command. */
const withOption = (cmd: string, head: string, token: string): string => {
  const at = cmd.indexOf(`${head} `);
  return `${cmd.slice(0, at + head.length)} ${token}${cmd.slice(at + head.length)}`;
};

describe("an option a row does not declare is unseen, never a guessed argv", () => {
  test.each([...RUNNERS.entries()])("%s --zz-unknown", (head, row) => {
    const cmd = withOption(INSTANCES[head] ?? "", head, "--zz-unknown");
    const sites = execSites(cmd);
    const named = sites.filter((s) => s.kind === "unseen" && s.head === head);
    assert.ok(named.length > 0, `${cmd}: ${JSON.stringify(sites)}`);
    if (OPAQUE.has(row.mode)) return;
    assert.ok(
      named.some(
        (s) => s.kind === "unseen" && s.reason.kind === "runner-options",
      ),
      cmd,
    );
    assert.ok(!sites.some((s) => cameThrough(s, head)), cmd);
  });
});

describe("decodeAnsiC: what bash hands the program for $'…'", () => {
  const codes = Array.from({ length: 128 }, (_, i) => i);

  test("every ASCII code round-trips through \\xHH and \\NNN", () => {
    for (const c of codes) {
      const ch = String.fromCharCode(c);
      assert.equal(decodeAnsiC(`\\x${c.toString(16)}`), ch);
      assert.equal(decodeAnsiC(`\\${c.toString(8).padStart(3, "0")}`), ch);
      assert.equal(decodeAnsiC(`\\u${c.toString(16).padStart(4, "0")}`), ch);
    }
  });

  test("named escapes, quotes and control characters", () => {
    assert.equal(decodeAnsiC("git push\\t-f"), "git push\t-f");
    assert.equal(decodeAnsiC("a\\'b\\\\c\\\"d"), "a'b\\c\"d");
    assert.equal(decodeAnsiC("\\cA\\e"), "\u0001\u001b");
    assert.equal(decodeAnsiC("\\U0001F600"), "\u{1F600}");
  });

  test("an escape it does not know is not guessed", () => {
    for (const raw of ["\\q", "tail\\", "\\x", "\\u"])
      assert.equal(decodeAnsiC(raw), null, raw);
  });
});
