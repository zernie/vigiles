/**
 * The words the directory table READS, against Fig's completion specs
 * (`@withfig/autocomplete`, MIT, a devDependency): every git global option the
 * table reads (a flag, or `-C` with one argument) and env's `-C`/`--chdir`.
 * Fig must know the option with the same arity — or the row must carry a
 * reviewed `figException` saying why Fig disagrees. An exception Fig no longer
 * needs fails too, so the list cannot go stale. Options the table calls
 * unknown are not checked: their arity is never used.
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

import { ENV, GIT_GLOBALS } from "./bash-dirs-table.js";

interface FigOption {
  readonly name: string | readonly string[];
  readonly args?: unknown;
}
interface FigCommand {
  readonly name?: string | readonly string[];
  readonly options?: readonly FigOption[];
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

/** Does Fig know `flag` on `cmd` with exactly `arity` arguments? */
function knows(cmd: FigCommand, flag: string, arity: 0 | 1): boolean {
  const opt = (cmd.options ?? []).find((o) => names(o.name).includes(flag));
  if (opt === undefined) return false;
  const one = opt.args !== undefined ? 1 : 0;
  return (Array.isArray(opt.args) ? opt.args.length : one) === arity;
}

/** One option the table reads, as Fig would be asked about it. */
interface Claim {
  readonly label: string;
  readonly program: string;
  readonly flag: string;
  readonly arity: 0 | 1;
  readonly figException: string | undefined;
}

const claims: readonly Claim[] = [
  ...GIT_GLOBALS.filter((g) => g.effect !== "unknown").flatMap((g) =>
    g.names.map((flag) => ({
      label: `git ${flag}`,
      program: "git",
      flag,
      arity: g.arity,
      figException: g.figException,
    })),
  ),
  ...ENV.chdir.map((flag) => ({
    label: `env ${flag}`,
    program: "env",
    flag,
    arity: 1 as const,
    figException: ENV.figException,
  })),
];

async function figConfirms(c: Claim): Promise<boolean> {
  const spec = await figSpec(c.program);
  return spec !== null && knows(spec, c.flag, c.arity);
}

describe("the words the table reads, against Fig", () => {
  test.each(claims.map((c) => [c.label, c] as const))(
    "%s: Fig knows the option with its arity, or a reviewed exception says why not",
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
          `${c.label}: Fig does not know it with ${String(c.arity)} argument(s); fix the row or give a reviewed figException`,
        );
    },
  );

  test("Fig confirms git -C and the common flags outright", async () => {
    const confirmed = await Promise.all(claims.map(figConfirms));
    const ok = claims.filter((_, i) => confirmed[i]).map((c) => c.label);
    for (const label of ["git -C", "git --no-pager", "git -p"])
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
