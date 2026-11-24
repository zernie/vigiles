/**
 * Two classes of the closed directory grammar, swept over the whole table
 * rather than pinned one program at a time (PR #514, Codex findings):
 *
 *  1. OPTIONS BEFORE THE SUBCOMMAND. For a program whose rows are scoped to
 *     subcommands, any option ahead of the subcommand is read through that
 *     program's own row (its pre-subcommand options), or the leaf is unknown.
 *     It never falls through to the starting directory (`go -C /x test`).
 *  2. REPEATS. Every "run in directory" option declares what a second
 *     occurrence does — `cumulative` (each relative to the last), `last-wins`
 *     (only the last, against the directory the program started in), or
 *     `none` (the leaf is unknown). `env -C /a -C . cmd` runs in `.`.
 *
 * Unit tier: `lineDirs` is pure. Real bash, env, git and make as the oracle:
 * `src/hook-dirs-oracle.test.ts`.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { lineDirs, joinDir, type LeafDir } from "./bash-dirs.js";
import {
  DIR_TABLE,
  WRAPPERS,
  GIT_GLOBAL,
  type DirRow,
  type Repeat,
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

const UNKNOWN_OPTIONS = ["--vigiles-unknown", "-%"] as const;

/** The spellings of an option the table reads: `-C v`, `--long v`, `--long=v`, `-chdir=v`. */
function spellings(
  separate: readonly string[],
  equals: readonly string[],
): readonly ((v: string) => string)[] {
  return [
    ...separate.map((f) => (v: string) => `${f} ${v}`),
    ...separate
      .filter((f) => f.startsWith("--"))
      .map((f) => (v: string) => `${f}=${v}`),
    ...equals.map((f) => (v: string) => `${f}=${v}`),
  ];
}

/** For one subcommand row: every line with an unknown option ahead of a subcommand. */
function unknownFirst(r: DirRow): readonly string[] {
  const opts = spellings(r.separate, r.equals);
  return (r.sub ?? []).flatMap((s) =>
    UNKNOWN_OPTIONS.flatMap((u) => [
      `${r.program} ${u} ${s} x`,
      ...opts.map((opt) => `${r.program} ${u} ${s} ${opt("/r")} x`),
    ]),
  );
}

const subScoped = [
  ...new Set(DIR_TABLE.flatMap((r) => (r.sub ? [r.program] : []))),
];

describe("class 1: an option before the subcommand is read by the program's row, or unknown", () => {
  test("the reported case: go reads -C before its subcommand too", () => {
    assert.deepEqual(leafAt("go -C /foreign test"), {
      kind: "dir",
      dir: "/foreign",
    });
    assert.deepEqual(leafAt("go -C /foreign test ./..."), {
      kind: "dir",
      dir: "/foreign",
    });
  });

  test("go reads -C after the whole command path, which the table does not track: unknown", () => {
    for (const line of [
      "go mod edit -C /x -json",
      "go mod -C /x edit -json",
      "go -C /a test -C /b",
      "go --C /x test",
      "go -C=/x test",
    ])
      assert.ok(isUnknown(leafAt(line)), line);
  });

  test("every subcommand-scoped program, every subcommand, an unknown option first: unknown", () => {
    const lines = DIR_TABLE.filter((r) => r.sub).flatMap(unknownFirst);
    assert.ok(lines.length > 40, `only ${String(lines.length)} lines`);
    const known = lines.filter((l) => !isUnknown(leafAt(l)));
    assert.deepEqual(known, [], "read as known past an unread option");
  });

  test("git, whose global options precede the subcommand: an unknown one is unknown", () => {
    for (const u of UNKNOWN_OPTIONS)
      for (const line of [`git ${u} status`, `git ${u} -C /r status`])
        assert.ok(isUnknown(leafAt(line)), line);
  });

  test("a subcommand-scoped program's own row stops at the subcommand", () => {
    for (const r of DIR_TABLE)
      if (r.sub === undefined && subScoped.includes(r.program))
        assert.equal(r.beforeOperand, true, `${r.program}: beforeOperand`);
  });
});

/** Where `twice(first, second)` must run under `repeat`, from the start `.`; `null` is unknown. */
function expected(
  repeat: Repeat,
  first: string,
  second: string,
): string | null {
  if (repeat === "none") return null;
  const base = repeat === "cumulative" ? joinDir(".", first) : ".";
  return joinDir(base, second);
}

interface RepeatCase {
  readonly label: string;
  readonly repeat: Repeat;
  /** The line with the option given twice, the values in the middle. */
  readonly twice: (first: string, second: string) => string;
  /** A container row reads only absolute values. */
  readonly container: boolean;
}

const repeatCases: readonly RepeatCase[] = [
  ...DIR_TABLE.flatMap((r) =>
    spellings(r.separate, r.equals).map(
      (opt, k): RepeatCase => ({
        label: `${r.program}${r.sub ? ` ${r.sub[0] ?? ""}` : ""} #${String(k)}`,
        repeat: r.repeat,
        twice: (a, b) =>
          `${r.program}${r.sub ? ` ${r.sub[0] ?? ""}` : ""} ${opt(a)} ${opt(b)} x`,
        container: r.container === true,
      }),
    ),
  ),
  ...Object.entries(WRAPPERS).flatMap(([w, spec]) =>
    spec
      ? spellings(spec.chdir, []).map(
          (opt, k): RepeatCase => ({
            label: `${w} #${String(k)}`,
            repeat: spec.repeat,
            twice: (a, b) => `${w} ${opt(a)} ${opt(b)} prog`,
            container: false,
          }),
        )
      : [],
  ),
  {
    label: "git -C",
    repeat: GIT_GLOBAL.repeat,
    twice: (a, b) => `git -C ${a} -C ${b} status`,
    container: false,
  },
];

describe("class 2: a repeated directory option follows its declared semantics, or is unknown", () => {
  test("the reported case: env -C takes only the last, against where env started", () => {
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

  test.each(repeatCases.map((c) => [c.label, c] as const))(
    "%s given twice",
    (_label, c) => {
      const [first, second] = c.container ? ["/a", "/b"] : ["/a", "sub"];
      const line = c.twice(first, second);
      const at = leafAt(line);
      // A container row reads absolute values only, so both repeats give `/b`.
      const inContainer = c.repeat === "none" ? null : second;
      const want = c.container
        ? inContainer
        : expected(c.repeat, first, second);
      if (want === null) assert.ok(isUnknown(at), line);
      else assert.deepEqual(at, { kind: "dir", dir: want }, line);
    },
  );

  test("every repeat the table declares is exercised", () => {
    const declared = new Set(repeatCases.map((c) => c.repeat));
    for (const r of ["cumulative", "last-wins", "none"] as const)
      assert.ok(declared.has(r), `no row declares ${r}`);
  });
});
