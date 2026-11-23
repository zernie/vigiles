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
import { RUNNERS, type RunnerMode } from "./shell-runners.js";

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
  eval: "eval git push -f",
  source: "source x.sh",
  ".": ". x.sh",
};

/** The modes whose command the descent cannot read: they must say so. */
const OPAQUE: ReadonlySet<RunnerMode> = new Set(["script-file"]);

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
});
