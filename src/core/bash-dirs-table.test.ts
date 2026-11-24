/**
 * Every row of the directory table against Fig's completion specs
 * (`@withfig/autocomplete`, MIT, a devDependency): for each program (and
 * subcommand) the table reads a "run in directory" option of, Fig must know
 * that option with one argument — or the row must carry a reviewed
 * `figException` saying why Fig disagrees. An exception Fig no longer needs
 * fails too, so the list cannot go stale.
 *
 * Fig is loaded HERE only. The hook runtime never imports it (vigiles rule
 * "Hook Startup Cost Is Watched"): the last test reads the compiled module
 * modules for a load of the package, and `src/hook-runtime-graph.test.ts` checks
 * the graph a `dirs()` gate really loads.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DIR_TABLE, WRAPPERS, GIT_GLOBAL } from "./bash-dirs-table.js";

interface FigOption {
  readonly name: string | readonly string[];
  readonly args?: unknown;
  readonly requiresSeparator?: boolean | string;
  readonly requiresEquals?: boolean;
}
interface FigCommand {
  readonly name?: string | readonly string[];
  readonly options?: readonly FigOption[];
  readonly subcommands?: readonly FigCommand[];
}

const FIG_BUILD = dirname(
  createRequire(__filename).resolve("@withfig/autocomplete"),
);

const isFigCommand = (x: unknown): x is FigCommand =>
  typeof x === "object" && x !== null;

/** Fig's spec for a program, or `null` when Fig has none. */
async function figSpec(program: string): Promise<FigCommand | null> {
  const file = join(FIG_BUILD, `${program}.js`);
  if (!existsSync(file)) return null;
  const mod: unknown = await import(pathToFileURL(file).href);
  const spec =
    typeof mod === "object" && mod !== null && "default" in mod
      ? mod.default
      : null;
  return isFigCommand(spec) ? spec : null;
}

function names(n: string | readonly string[] | undefined): readonly string[] {
  if (n === undefined) return [];
  return typeof n === "string" ? [n] : n;
}

/** Does Fig know `flag` on `cmd` with exactly one argument? */
function knows(cmd: FigCommand, flag: string, equals: boolean): boolean {
  const opt = (cmd.options ?? []).find((o) => names(o.name).includes(flag));
  if (opt === undefined) return false;
  const one = opt.args !== undefined ? 1 : 0;
  const arity = Array.isArray(opt.args) ? opt.args.length : one;
  const attached =
    opt.requiresEquals === true || opt.requiresSeparator !== undefined;
  return arity === 1 && (!equals || attached);
}

/** One thing the table reads, as Fig would be asked about it. */
interface Claim {
  readonly label: string;
  readonly program: string;
  readonly subs: readonly string[] | undefined;
  readonly flags: readonly {
    readonly flag: string;
    readonly equals: boolean;
  }[];
  readonly figException: string | undefined;
}

const claims: readonly Claim[] = [
  ...DIR_TABLE.map((r) => ({
    label: `${r.program}${r.sub ? ` ${r.sub.join("|")}` : ""}`,
    program: r.program,
    subs: r.sub,
    flags: [
      ...r.separate.map((flag) => ({ flag, equals: false })),
      ...r.equals.map((flag) => ({ flag, equals: true })),
    ],
    figException: r.figException,
  })),
  ...Object.entries(WRAPPERS).flatMap(([program, spec]) =>
    spec && spec.chdir.length > 0
      ? [
          {
            label: program,
            program,
            subs: undefined,
            flags: spec.chdir.map((flag) => ({ flag, equals: false })),
            figException: spec.figException,
          },
        ]
      : [],
  ),
  {
    label: "git",
    program: "git",
    subs: undefined,
    flags: GIT_GLOBAL.chdir.map((flag) => ({ flag, equals: false })),
    figException: undefined,
  },
];

/** Does Fig confirm every flag of the claim, on every subcommand it names? */
async function figConfirms(c: Claim): Promise<boolean> {
  const spec = await figSpec(c.program);
  if (spec === null) return false;
  const cmds =
    c.subs === undefined
      ? [spec]
      : c.subs.map((s) =>
          (spec.subcommands ?? []).find((x) => names(x.name).includes(s)),
        );
  return cmds.every(
    (cmd) =>
      cmd !== undefined && c.flags.every((f) => knows(cmd, f.flag, f.equals)),
  );
}

describe("the directory table against Fig", () => {
  test.each(claims.map((c) => [c.label, c] as const))(
    "%s: Fig knows the option, or a reviewed exception says why not",
    async (_label, c) => {
      const confirmed = await figConfirms(c);
      if (confirmed)
        assert.equal(
          c.figException,
          undefined,
          `${c.label}: Fig now confirms the row, so drop its figException`,
        );
      else
        assert.ok(
          (c.figException ?? "").length > 20,
          `${c.label}: Fig does not know ${c.flags.map((f) => f.flag).join(", ")} with one argument; fix the row or give a reviewed figException`,
        );
    },
  );

  test("Fig confirms the core rows outright", async () => {
    const confirmed = await Promise.all(claims.map(figConfirms));
    const ok = claims.filter((_, i) => confirmed[i]).map((c) => c.label);
    for (const label of ["git", "make", "docker exec|run", "terraform", "just"])
      assert.ok(ok.includes(label), `${label} not confirmed by Fig`);
  });
});

describe("Fig stays off the hook runtime", () => {
  test("no compiled module on the runtime's path names the package", () => {
    const dist = resolve(__dirname, "..", "..", "dist");
    for (const m of [
      "core/bash-dirs.js",
      "core/bash-dirs-table.js",
      "core/bash-effects.js",
      "core/hook-program.js",
      "hook.js",
      "hook-runtime.js",
    ]) {
      const file = join(dist, m);
      assert.ok(existsSync(file), `${m} not built; run npm run build`);
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /(?:require\(|import\(|from )\s*["']@withfig/,
        `${m} loads @withfig/autocomplete`,
      );
    }
  });
});
