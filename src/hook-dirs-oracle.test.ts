/**
 * The directory model behind `e.command.dirs()` against real bash.
 *
 * Commands are generated from a small grammar — `cd`, `pushd`, `popd`,
 * `cd -`, a bare `cd`, `command [-p] cd`, `builtin cd`, `eval "cd …"`, a
 * function chain that `cd`s, `env -C dir` and `env -Cdir`, `git -C`,
 * `bash -c "cd … && …"`, `cd -P` and `git -C`/`env -C` over a symlink's `..`,
 * `trap -- 'cd …' DEBUG`, a function declared inside `eval`, a bare `pushd`,
 * steering assignments (`for CDPATH in`, `read`/`printf -v`/`declare` into
 * `CDPATH`, a `CDPATH=` prefix on a function), quoted and backslashed
 * directory words, and `logout`/`return`/`exec 3>…`,
 * `&&`, `||`, `;`, `|`, `&`, subshells, groups and `if` — over a temp tree with a directory that does not
 * exist, so every `cd` can fail as well as succeed. Every leaf records where it
 * actually ran: `pwd >> out/L<k>`, or for git `git -C D rev-parse
 * --show-prefix >> out/L<k>`, which is git's own word for its directory.
 *
 * The one forbidden outcome: bash ran a leaf in a directory the model did not
 * list. `unresolved` is always allowed (it asks, it does not guess), and so is
 * a candidate bash did not use — a `cd` that might have failed lists both. The
 * oracle is bash; sets are compared, never error text.
 *
 * Integration tier: needs bash and git. Elsewhere it is skipped LOUDLY.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, posix } from "node:path";

import { readShell, type NormalizedLeaf } from "./core/bash-effects.js";
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

/**
 * Round 3: steering assignments (CDPATH=S/a sends `cd b` to S/a/b), quoted
 * and escaped operands, and builtins that do not end the shell.
 */
function roundThreeAtoms(
  pick: <T>(xs: readonly [T, ...T[]]) => T,
  absA: string,
): readonly (() => string)[] {
  return [
    () => `for CDPATH in ${absA}; do :; done`,
    () => `read CDPATH <<< ${absA}`,
    () => `printf -v CDPATH %s ${absA}`,
    () => `printf -v 'CDPATH[0]' %s ${absA}`,
    () => `declare CDPATH=${absA}`,
    () => `k(){ cd b; }; CDPATH=${absA} k`,
    () => `cd ${pick(['"a"', "a\\/b", "'b'", '"$HOME"'])}`,
    () => pick(["logout", "return", "exec 3>/dev/null"]),
  ];
}

/** The command generator: a seeded choice, and a fresh marker per leaf. */
function generator(seed: number, out: string, abs: string, absA: string) {
  const next = rng(seed);
  let leaves = 0;
  const pick = <T>(xs: readonly [T, ...T[]]): T =>
    xs[Math.floor(next() * xs.length)] ?? xs[0];
  // `l` is a symlink to `a/b`: through it `..` means different things to a
  // logical `cd` (lexical) and to `cd -P` / `env -C` / `git -C` (physical).
  // A bare `l` is not generated: two names for one directory is a limit of
  // any path-string comparison, said in the docs, not a model fault.
  const dir = (): string =>
    pick(["a", "b", "a/b", "nope", "..", "~", abs, "a/..", "b/../a", "l/.."]);
  const leaf = (): string => {
    const target = `${out}/L${String(leaves++)}`;
    return pick([
      `pwd >> ${target}`,
      `pwd >> ${target}`,
      `git -C ${pick([".", "a", "a/b", "nope", "b"])} rev-parse --show-prefix >> ${target}`,
      `env ${pick(["-C ", "-C"])}${pick(["a", "b", "nope", "l/.."])} pwd >> ${target}`,
      `git -C ${pick(["l/..", "a/..", '"a"', "a\\/b", "'b'", '""'])} rev-parse --show-prefix >> ${target}`,
      `bash -c "cd ${dir()} && pwd >> ${target}"`,
    ]);
  };
  const atom = (depth: number): string => {
    const simple: [() => string, ...(() => string)[]] = [
      () => `cd ${dir()}`,
      () => `pushd ${dir()} >/dev/null`,
      () => "popd >/dev/null",
      () => "cd -",
      () => "cd",
      () => `command cd ${dir()}`,
      () => `command -p cd ${dir()}`,
      () => `builtin cd ${dir()}`,
      () => `eval "cd ${dir()}"`,
      () => `m(){ n; }; n(){ cd ${dir()}; }; m`,
      () => `cd -P ${pick(["l/..", "l", "a", "nope"])}`,
      () => `trap -- 'cd ${dir()}' DEBUG`,
      () => `eval 'g(){ cd ${dir()}; }'; g`,
      () => "pushd >/dev/null",
      ...roundThreeAtoms(pick, absA),
      leaf,
      leaf,
      leaf,
      leaf,
      leaf,
    ];
    const nested: (() => string)[] = [
      () => `( ${seq(depth + 1)} )`,
      () => `{ ${seq(depth + 1)}; }`,
      () => `if cd ${dir()}; then ${seq(depth + 1)}; fi`,
      () => `if true; then cd ${dir()}; fi`,
    ];
    return pick(depth < 2 ? [...simple, ...nested] : simple)();
  };
  const seq = (depth: number): string => {
    const n = 1 + Math.floor(next() * 4);
    const first = atom(depth);
    const rest = Array.from(
      { length: n - 1 },
      () => ` ${pick(["&&", "||", ";", ";", "|", "&"])} ${atom(depth)}`,
    );
    return first + rest.join("");
  };
  return { line: () => `${seq(0)}; wait` };
}

/** Where a tree under test sits: the start, its `$HOME`, the marker directory. */
interface Tree {
  readonly start: string;
  readonly home: string;
  readonly out: string;
}

type Verdict =
  | "skip"
  | "unresolved"
  | "exact"
  | "several"
  | { readonly miss: string };

/**
 * One leaf against what bash recorded for it. The shell opens the marker file
 * before the program runs, so an EMPTY file means the program did not get to
 * print (a failed `env -C nope`, `git -C nope`); git at the top prints one
 * empty line.
 */
function judge(leaf: NormalizedLeaf, tree: Tree): Verdict {
  const target = leaf.redirects.find(
    (r) => r.writes && r.target?.startsWith(`${tree.out}/`),
  )?.target;
  const text = target && existsSync(target) ? readFileSync(target, "utf8") : "";
  if (text === "") return "skip";
  if (leaf.at.kind === "unresolved") return "unresolved";
  const line = text.split("\n")[0] ?? "";
  const actual =
    leaf.head === "git"
      ? posix.normalize(`${tree.start}/${line}`).replace(/\/$/, "")
      : line;
  const placed = leaf.at.dirs.map((d) =>
    d === "~" || d.startsWith("~/")
      ? posix.normalize(tree.home + d.slice(1))
      : posix.resolve(tree.start, d),
  );
  if (!placed.includes(actual))
    return {
      miss: `leaf ${leaf.argv.join(" ")} ran in ${actual}, model said ${JSON.stringify(leaf.at.dirs)}`,
    };
  return placed.length === 1 ? "exact" : "several";
}

/** Run one line under bash in a clean marker directory; judge each leaf. */
function runLine(cmd: string, tree: Tree): readonly Verdict[] {
  rmSync(tree.out, { recursive: true, force: true });
  mkdirSync(tree.out);
  spawnSync("bash", ["-c", cmd], {
    cwd: tree.start,
    env: { PATH: process.env["PATH"] ?? "", HOME: tree.home },
    timeout: 10_000,
  });
  return readShell(cmd).effects.flatMap((e) =>
    e.kind === "leaf" ? [judge(e.leaf, tree)] : [],
  );
}

test("every directory bash ran a leaf in is among the candidates, else unresolved", () => {
  if (!hasTools) return;
  const tmp = makeTmpDir();
  try {
    const root = realpathSync(tmp);
    const start = join(root, "s");
    const tree: Tree = {
      start,
      home: join(start, "h"),
      out: join(root, "out"),
    };
    for (const d of ["a/b", "b", "c", "h"])
      mkdirSync(join(start, d), { recursive: true });
    symlinkSync("a/b", join(start, "l"));
    spawnSync("git", ["init", "-q", start]);
    const gen = generator(
      20261124,
      tree.out,
      join(start, "c"),
      join(start, "a"),
    );
    const verdicts = Array.from({ length: 1800 }, () => gen.line()).flatMap(
      (cmd) =>
        runLine(cmd, tree).map((v) =>
          typeof v === "object" ? { miss: `${cmd}\n    ${v.miss}` } : v,
        ),
    );
    const count = (k: Verdict): number =>
      verdicts.filter((v) => v === k).length;
    const misses = verdicts.flatMap((v) =>
      typeof v === "object" ? [v.miss] : [],
    );
    const ran = verdicts.length - count("skip");
    assert.deepEqual(
      misses,
      [],
      `${String(misses.length)} leaves ran outside the model`,
    );
    // The run must exercise the model, not only its `unresolved` exit.
    assert.ok(ran > 500, `only ${String(ran)} leaves ran`);
    assert.ok(
      count("exact") + count("several") > ran / 2,
      `${String(count("unresolved"))}/${String(ran)} unresolved`,
    );
    console.log(
      `dirs oracle: ${String(ran)} leaves ran — ${String(count("exact"))} one candidate, ${String(count("several"))} several, ${String(count("unresolved"))} unresolved, 0 outside`,
    );
  } finally {
    cleanupTmpDir(tmp);
  }
}, 120_000);
