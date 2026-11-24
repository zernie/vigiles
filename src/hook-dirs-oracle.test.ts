/**
 * The closed directory grammar behind `e.command.dirs()` against real bash
 * and git.
 *
 * 1800 seeded lines are generated from the forms the grammar reads — `cd` to absolute,
 * `./` and `../` words, `&&`, `;`, `||`, a plain `|`, `git -C` (cumulative),
 * `env -C` (a repeat keeps only the last) and git's options before its
 * subcommand — and from forms it must call unknown: bare `cd b` under a
 * CDPATH, `cd -`, a bare `cd`, `cd -P`, quoted and backslashed words,
 * `pushd`/`popd`, `command cd`, `builtin cd`, `eval`, `bash -c`, functions,
 * subshells, groups, `if`, a `CDPATH=` prefix, a redirect, `&`, a file
 * sourced through `command .` that moves the shell, every wrapper but `env`, an `env` assignment, an unknown git option, and `..` through a
 * symlink, where a logical `cd` and a physical `env -C`/`git -C` disagree.
 * The tree has a directory that does not exist, so every `cd` can fail as
 * well as succeed.
 *
 * Every leaf is a git call that prints where git ran: each directory holds a
 * file `here` with the lines `L<k> <its real path>`, and the leaf is
 * `git … grep --no-index -h -w -e L<k> -- here`, so the marker needs no
 * redirect (which the grammar refuses) and no program but git (the only one
 * whose directory it reads).
 *
 * The forbidden outcome: git ran a leaf somewhere the model did not say, or
 * ran a leaf of a line the model read that it does not list. `unknown` is
 * always allowed. Integration tier: needs bash and git; elsewhere it is
 * skipped LOUDLY.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { lineDirs, joinDir } from "./core/bash-dirs.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const hasTools =
  spawnSync("bash", ["-c", "true"]).status === 0 &&
  spawnSync("git", ["--version"]).status === 0;
if (!hasTools)
  console.warn(
    "SKIPPED: the bash+git oracle for e.command.dirs() is not installed",
  );

/** A small deterministic PRNG (mulberry32), so a failure reproduces by seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The directory words and the leaves a line is built from. */
function forms(
  pick: <T>(xs: readonly [T, ...T[]]) => T,
  mark: () => string,
  abs: string,
) {
  const read = (): string =>
    pick([
      "./a",
      "./b",
      "./a/b",
      "./nope",
      "../s/a",
      abs,
      "./l/..",
      "./a/..",
      `${abs}/../b`,
    ]);
  const unread = (): string =>
    pick(["b", "a", "-", "", "-P ./l/..", '"./a"', "./a\\/b", "'./b'", "~"]);
  /** A git leaf that prints `L<k> <where git ran>`, with `pre` before `grep`. */
  const git = (pre = ""): string =>
    `git ${pre}grep --no-index -h -w -e ${mark()} -- here`;
  const leaf = (): string =>
    pick([
      git(),
      git(),
      git(`-C ${pick([".", "./a", "a/b", "nope", "l/..", "a/.."])} `),
      git("-C ./a -C b "),
      `env -C ${pick(["a", "b", "nope", "l/.."])} ${git()}`,
      // A repeated env -C: only the last counts, against where env started.
      `env -C ${pick([abs, "a", "nope"])} -C ${pick([".", "b", "a/b"])} ${git()}`,
      // Git's options before its subcommand: read by its table, or unknown.
      git(
        `${pick(["-c x.y=1", "--no-pager", "-P", "--bogus", "--bare"])} -C ${pick(["a", "b"])} `,
      ),
      `env ${pick(["-i", "-", "--", "-- X=1", "X=1"])} ${git()}`,
      `${pick(["timeout 5", "command", "nice"])} ${git()}`,
    ]);
  // Half the lines stay inside the grammar: answers, not only `unknown`.
  const inside: [() => string, ...(() => string)[]] = [
    () => `cd ${read()}`,
    () => `cd ${unread()}`,
    // A sourced file that moves the shell, and builtins that cannot.
    () => `command . ${abs}/move`,
    () => pick(["echo x", "true", ": x", "test -d a"]),
    leaf,
    leaf,
  ];
  return { read, unread, leaf, git, inside };
}

/** The command generator: a seeded choice, and a fresh marker per leaf. */
function generator(seed: number, abs: string) {
  const next = rng(seed);
  let leaves = 0;
  let plainLine = false;
  const pick = <T>(xs: readonly [T, ...T[]]): T =>
    xs[Math.floor(next() * xs.length)] ?? xs[0];
  const mark = (): string => `L${String(leaves++)}`;
  const { read, unread, leaf, git, inside } = forms(pick, mark, abs);
  const atom = (depth: number): string => {
    const simple: [() => string, ...(() => string)[]] = [
      () => `cd ${read()}`,
      () => `cd ${unread()}`,
      () => `pushd ${read()} >/dev/null`,
      () => "popd >/dev/null",
      () => `command cd ${read()}`,
      () => `builtin cd ${read()}`,
      () => `eval "cd ${read()}"`,
      () => `bash -c "cd ${read()} && ${git()}"`,
      () => `f(){ cd ${read()}; }; f`,
      () => `CDPATH=${abs} ${git()}`,
      () => `${pick(["command", "env"])} . ${abs}/move`,
      () => `${git()} > /dev/null`,
      () => `${git()} | cat`,
      leaf,
      leaf,
      leaf,
    ];
    const nested: (() => string)[] = [
      () => `( ${seq(depth + 1)} )`,
      () => `{ ${seq(depth + 1)}; }`,
      () => `if cd ${read()}; then ${seq(depth + 1)}; fi`,
    ];
    if (plainLine) return pick(inside)();
    return pick(depth < 1 ? [...simple, ...nested] : simple)();
  };
  const seq = (depth: number): string => {
    const n = 1 + Math.floor(next() * 4);
    const first = atom(depth);
    const rest = Array.from(
      { length: n - 1 },
      () =>
        ` ${pick(plainLine ? ["&&", "&&", "&&", "||", ";", "|"] : ["&&", "||", ";", "|", "&"])} ${atom(depth)}`,
    );
    return first + rest.join("");
  };
  return {
    line: () => {
      leaves = 0;
      plainLine = next() < 0.5;
      return seq(0);
    },
  };
}

/** Where a tree under test sits. */
interface Tree {
  readonly start: string;
}

type Verdict = "known" | "several" | "unknown" | { readonly miss: string };

/** Run one line under bash: marker → the directory git printed for it. */
function runLine(cmd: string, tree: Tree): ReadonlyMap<string, string> {
  const r = spawnSync("bash", ["-c", `${cmd}\nwait`], {
    cwd: tree.start,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: join(tree.start, "h"),
      CDPATH: join(tree.start, "a"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  const ran = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(L\d+) (\/\S*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) ran.set(m[1], m[2]);
  }
  return ran;
}

/** Every leaf bash ran, against what the grammar said of it. */
function judgeLine(cmd: string, tree: Tree): readonly Verdict[] {
  const ran = runLine(cmd, tree);
  const model = lineDirs(cmd);
  if (model.kind === "unknown") return [...ran.keys()].map(() => "unknown");
  return [...ran].map(([mark, actual]): Verdict => {
    const leaf = model.leaves.find((l) =>
      new RegExp(`\\b${mark}\\b`).test(l.text),
    );
    if (leaf === undefined)
      return {
        miss: `leaf ${mark} ran in ${actual}, model lists no such leaf`,
      };
    if (leaf.at.kind === "unknown") return "unknown";
    const placed = joinDir(tree.start, leaf.at.dir);
    return placed === actual
      ? "known"
      : { miss: `leaf ${mark} ran in ${actual}, model said ${placed}` };
  });
}

test("every leaf bash ran is where the grammar said, or the grammar said unknown", () => {
  if (!hasTools) return;
  const tmp = makeTmpDir();
  try {
    const root = realpathSync(tmp);
    const start = join(root, "s");
    const tree: Tree = { start };
    for (const d of ["a/b", "b", "c", "h"])
      mkdirSync(join(start, d), { recursive: true });
    symlinkSync("a/b", join(start, "l"));
    spawnSync("git", ["init", "-q", start]);
    // `move`: sourced through `command .`, it changes the shell's directory.
    writeFileSync(join(start, "c", "move"), `cd ${join(start, "a")}\n`);
    // `here` in every real directory: `L<k> <its real path>`, one line per marker.
    for (const d of [".", "a", "a/b", "b", "c", "h"]) {
      const real = realpathSync(join(start, d));
      const lines = Array.from(
        { length: 64 },
        (_, k) => `L${String(k)} ${real}`,
      );
      writeFileSync(join(start, d, "here"), `${lines.join("\n")}\n`);
    }
    const gen = generator(20261124, join(start, "c"));
    const verdicts = Array.from({ length: 1800 }, () => gen.line()).flatMap(
      (cmd) =>
        judgeLine(cmd, tree).map((v) =>
          typeof v === "object" ? { miss: `${cmd}\n    ${v.miss}` } : v,
        ),
    );
    const count = (k: Verdict): number =>
      verdicts.filter((v) => v === k).length;
    const misses = verdicts.flatMap((v) =>
      typeof v === "object" ? [v.miss] : [],
    );
    assert.deepEqual(
      misses,
      [],
      `${String(misses.length)} leaves ran outside the model`,
    );
    // The run must exercise the model, not only its `unknown` exit.
    assert.ok(verdicts.length > 1000, `only ${String(verdicts.length)} ran`);
    assert.ok(count("known") > 200, `only ${String(count("known"))} known`);
    console.log(
      `dirs oracle: ${String(verdicts.length)} leaves ran — ${String(count("known"))} known, ${String(count("several"))} several, ${String(count("unknown"))} unknown, 0 outside`,
    );
  } finally {
    cleanupTmpDir(tmp);
  }
}, 180_000);
