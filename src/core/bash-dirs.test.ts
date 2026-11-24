/**
 * git's argv, CLOSED, swept rather than pinned one option at a time (PR #514,
 * Codex findings `make -f -C /trusted deploy` and `env -- FOO=bar git -C /x
 * pull`, both of the class "the reader skipped a word it did not understand"):
 *
 *  1. EVERY GLOBAL OPTION git(1) lists, given before the subcommand, has the
 *     effect its row in {@link GIT_GLOBALS} declares — no move, `-C`, or
 *     unknown — and an option git(1) does not list is unknown.
 *  2. THE SUBCOMMAND is one of {@link GIT_SUBCOMMANDS}, whose own options
 *     cannot move git; any other word there is unknown.
 *  3. REPEATS. `git -C` is cumulative; `env -C` keeps only the last, against
 *     where env started.
 *  4. EVERY OTHER PROGRAM is unknown.
 *
 * Unit tier: `lineDirs` is pure. Real bash and git as the oracle:
 * `src/hook-dirs-oracle.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { lineDirs, type LeafDir } from "./bash-dirs.js";
import {
  GIT_GLOBALS,
  GIT_CHDIR_REPEAT,
  GIT_SUBCOMMANDS,
  ENV,
} from "./bash-dirs-table.js";

/** Where the one leaf of `line` runs, or `"line"` when the whole line is unknown. */
function leafAt(line: string): LeafDir | "line" {
  const r = lineDirs(line);
  if (r.kind === "unknown") return "line";
  assert.equal(r.leaves.length, 1, `${line}: one leaf`);
  const at = r.leaves[0]?.at;
  assert.ok(at !== undefined, line);
  return at;
}

const isUnknown = (at: LeafDir | "line"): boolean =>
  at === "line" || at.kind === "unknown";

/**
 * git(1) "OPTIONS", git 2.43 plus the two later additions (`--no-lazy-fetch`
 * 2.44, `--no-advice` 2.46) and the removed `--super-prefix` — copied here by
 * hand, apart from the table, so an option missing from the table fails.
 * Each with the words it takes: 0, or 1 (`-C <path>`, `--git-dir=<path>`).
 */
const GIT_1: readonly (readonly [string, 0 | 1])[] = [
  ["-v", 0],
  ["--version", 0],
  ["-h", 0],
  ["--help", 0],
  ["-C", 1],
  ["-c", 1],
  ["--config-env", 1],
  ["--exec-path", 0],
  ["--html-path", 0],
  ["--man-path", 0],
  ["--info-path", 0],
  ["-p", 0],
  ["--paginate", 0],
  ["-P", 0],
  ["--no-pager", 0],
  ["--git-dir", 1],
  ["--work-tree", 1],
  ["--namespace", 1],
  ["--super-prefix", 1],
  ["--bare", 0],
  ["--no-replace-objects", 0],
  ["--no-lazy-fetch", 0],
  ["--no-optional-locks", 0],
  ["--no-advice", 0],
  ["--literal-pathspecs", 0],
  ["--glob-pathspecs", 0],
  ["--noglob-pathspecs", 0],
  ["--icase-pathspecs", 0],
  ["--list-cmds", 1],
  ["--attr-source", 1],
];

/** Every way to give `name` its value `v`: separate, and `--long=v`. */
function spellings(name: string, arity: 0 | 1, v: string): readonly string[] {
  if (arity === 0) return [name];
  return name.startsWith("--")
    ? [`${name} ${v}`, `${name}=${v}`]
    : [`${name} ${v}`];
}

describe("class 1: every git global option gives its declared effect, or unknown", () => {
  test("every option git(1) lists has a row", () => {
    const rowed = new Set(GIT_GLOBALS.flatMap((g) => g.names));
    const missing = GIT_1.map(([n]) => n).filter((n) => !rowed.has(n));
    assert.deepEqual(missing, [], "git(1) options without a row");
  });

  test.each(GIT_1.map(([n, a]) => [n, a] as const))(
    "git %s before the subcommand",
    (name, arity) => {
      const row = GIT_GLOBALS.find((g) => g.names.includes(name));
      assert.ok(row !== undefined, name);
      for (const opt of spellings(name, arity, "/r")) {
        const line = `git ${opt} pull`;
        const at = leafAt(line);
        if (row.effect === "unknown") assert.ok(isUnknown(at), line);
        else if (row.effect === "none")
          assert.deepEqual(at, { kind: "dir", dir: "." }, line);
        else if (opt.includes("="))
          // git reads `-C` only as a separate word.
          assert.ok(isUnknown(at), line);
        else assert.deepEqual(at, { kind: "dir", dir: "/r" }, line);
      }
    },
  );

  test("an option git(1) does not list is unknown, wherever it sits before the subcommand", () => {
    for (const u of ["--bogus", "-%", "--", "-", "-Cx", "-C=/r", "--no-pagerx"])
      for (const line of [
        `git ${u} pull`,
        `git ${u} -C /r pull`,
        `git -C /r ${u} pull`,
      ])
        assert.ok(isUnknown(leafAt(line)), line);
  });

  test("a row git reads as a flag or -C takes the arity git(1) gives it", () => {
    for (const g of GIT_GLOBALS)
      if (g.effect !== "unknown")
        for (const n of g.names)
          assert.equal(
            g.arity,
            GIT_1.find(([x]) => x === n)?.[1],
            `${n}: arity`,
          );
  });
});

describe("class 2: the subcommand is one whose own options cannot move git, or unknown", () => {
  test("every listed subcommand, with options after it, runs where git's globals put it", () => {
    for (const s of GIT_SUBCOMMANDS)
      assert.deepEqual(
        leafAt(`git -C /r ${s} -C x --git-dir=y --work-tree z`),
        { kind: "dir", dir: "/r" },
        s,
      );
  });

  test("a subcommand that can work elsewhere, an alias or an external is unknown", () => {
    for (const s of [
      "worktree",
      "clone",
      "init",
      "submodule",
      "config",
      "log",
      "diff",
      "show",
      "archive",
      "bundle",
      "format-patch",
      "rebase",
      "bisect",
      "filter-branch",
      "difftool",
      "help",
      "rec",
      "co",
    ])
      assert.ok(isUnknown(leafAt(`git -C /r ${s} x`)), s);
  });

  test("git with no subcommand runs nothing, where its globals put it", () => {
    assert.deepEqual(leafAt("git -C /r"), { kind: "dir", dir: "/r" });
  });
});

describe("class 3: a repeated directory option follows its declared semantics", () => {
  test("git -C is cumulative", () => {
    assert.equal(GIT_CHDIR_REPEAT, "cumulative");
    assert.deepEqual(leafAt("git -C /a -C sub pull"), {
      kind: "dir",
      dir: "/a/sub",
    });
    assert.deepEqual(leafAt("git -C a -C /b pull"), { kind: "dir", dir: "/b" });
  });

  test("env -C takes only the last, against where env started", () => {
    assert.equal(ENV.repeat, "last-wins");
    assert.deepEqual(leafAt("env -C /trusted -C . git pull"), {
      kind: "dir",
      dir: ".",
    });
    assert.deepEqual(leafAt("env -C /a -C b git pull"), {
      kind: "dir",
      dir: "b",
    });
    assert.deepEqual(leafAt("env -C a env -C b git pull"), {
      kind: "dir",
      dir: "a/b",
    });
  });
});

describe("class 4: every program but git is unknown", () => {
  test("the reported case and every program an earlier table read", () => {
    for (const line of [
      "make -f -C /trusted deploy",
      "make -C /r deploy",
      "env -C /r make deploy",
      "npm --prefix /r run build",
      "go -C /r test",
      "ls",
    ])
      assert.deepEqual(
        leafAt(line),
        { kind: "unknown", reason: "unread-program" },
        line,
      );
  });

  test("env's every option word is read by its row, or the leaf is unknown", () => {
    for (const f of ENV.flags)
      assert.deepEqual(
        leafAt(`env ${f} git pull`),
        { kind: "dir", dir: "." },
        f,
      );
    for (const v of ENV.valued)
      assert.deepEqual(
        leafAt(`env ${v} X git pull`),
        { kind: "dir", dir: "." },
        v,
      );
    for (const line of [
      "env -S git pull",
      "env --split-string=git pull",
      "env --ignore-signal git pull",
      "env -0i git pull",
      "env -uX git pull",
      "env -- FOO=bar git pull",
      "env FOO=bar -- git pull",
    ])
      assert.ok(isUnknown(leafAt(line)), line);
  });
});
