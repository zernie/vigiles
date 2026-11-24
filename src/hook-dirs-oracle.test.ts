/**
 * The directory model behind `e.command.dirs()` against real bash.
 *
 * Commands are generated from a small grammar — `cd`, `pushd`, `popd`,
 * `cd -`, a bare `cd`, `env -C`, `git -C`, `&&`, `||`, `;`, `|`, `&`,
 * subshells, groups and `if` — over a temp tree with a directory that does not
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
} from "node:fs";
import { join, posix } from "node:path";

import { readShell } from "./core/bash-effects.js";
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

interface Gen {
  readonly next: () => number;
  leaf: number;
  readonly out: string;
  readonly abs: string;
}

const pick = <T>(g: Gen, xs: readonly T[]): T =>
  xs[Math.floor(g.next() * xs.length)] as T;

function dir(g: Gen): string {
  return pick(g, ["a", "b", "a/b", "nope", "..", "~", g.abs, "a/..", "b/../a"]);
}

function leafCmd(g: Gen): string {
  const k = g.leaf++;
  const target = `${g.out}/L${k}`;
  return pick(g, [
    `pwd >> ${target}`,
    `pwd >> ${target}`,
    `git -C ${pick(g, [".", "a", "a/b", "nope", "b"])} rev-parse --show-prefix >> ${target}`,
    `env -C ${pick(g, ["a", "b", "nope"])} pwd >> ${target}`,
  ]);
}

function atom(g: Gen, depth: number): string {
  const simple = [
    () => `cd ${dir(g)}`,
    () => `pushd ${dir(g)} >/dev/null`,
    () => "popd >/dev/null",
    () => "cd -",
    () => "cd",
    () => leafCmd(g),
    () => leafCmd(g),
  ];
  const nested = [
    () => `( ${seq(g, depth + 1)} )`,
    () => `{ ${seq(g, depth + 1)}; }`,
    () => `if cd ${dir(g)}; then ${seq(g, depth + 1)}; fi`,
    () => `if true; then cd ${dir(g)}; fi`,
  ];
  return pick(g, depth < 2 ? [...simple, ...nested] : simple)();
}

function seq(g: Gen, depth: number): string {
  const n = 1 + Math.floor(g.next() * 4);
  let s = atom(g, depth);
  for (let i = 1; i < n; i++)
    s += ` ${pick(g, ["&&", "||", ";", ";", "|", "&"])} ${atom(g, depth)}`;
  return s;
}

test("every directory bash ran a leaf in is among the candidates, else unresolved", () => {
  if (!hasTools) return;
  const tmp = makeTmpDir();
  try {
    const root = realpathSync(tmp);
    const S = join(root, "s");
    const home = join(S, "h");
    const out = join(root, "out");
    for (const d of ["a/b", "b", "c", "h"])
      mkdirSync(join(S, d), { recursive: true });
    spawnSync("git", ["init", "-q", S]);
    const g: Gen = { next: rng(20261124), leaf: 0, out, abs: join(S, "c") };

    const misses: string[] = [];
    let ran = 0;
    let exact = 0;
    let several = 0;
    let unresolved = 0;
    for (let i = 0; i < 600; i++) {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out);
      const cmd = `${seq(g, 0)}; wait`;
      spawnSync("bash", ["-c", cmd], {
        cwd: S,
        env: { PATH: process.env["PATH"] ?? "", HOME: home },
        timeout: 10_000,
      });
      for (const e of readShell(cmd).effects) {
        if (e.kind !== "leaf") continue;
        const target = e.leaf.redirects.find((r) => r.writes)?.target;
        if (!target || !existsSync(target)) continue;
        const line = readFileSync(target, "utf8").split("\n")[0] ?? "";
        const actual =
          e.leaf.head === "git"
            ? posix.normalize(`${S}/${line}`).replace(/\/$/, "")
            : line;
        ran++;
        const at = e.leaf.at;
        if (at.kind === "unresolved") {
          unresolved++;
          continue;
        }
        const placed = at.dirs.map((d) =>
          d === "~" || d.startsWith("~/")
            ? posix.normalize(home + d.slice(1))
            : posix.resolve(S, d),
        );
        if (placed.includes(actual)) {
          if (placed.length === 1) exact++;
          else several++;
        } else
          misses.push(
            `${cmd}\n    leaf ${e.leaf.argv.join(" ")} ran in ${actual}, model said ${JSON.stringify(at.dirs)}`,
          );
      }
    }
    assert.deepEqual(
      misses,
      [],
      `${misses.length} leaves ran outside the model`,
    );
    // The run must exercise the model, not only its `unresolved` exit.
    assert.ok(ran > 500, `only ${ran} leaves ran`);
    assert.ok(exact + several > ran / 2, `${unresolved}/${ran} unresolved`);
    console.log(
      `dirs oracle: ${ran} leaves ran — ${exact} one candidate, ${several} several, ${unresolved} unresolved, 0 outside`,
    );
  } finally {
    cleanupTmpDir(tmp);
  }
}, 120_000);
