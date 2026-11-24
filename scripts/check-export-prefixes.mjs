#!/usr/bin/env node
/**
 * check-export-prefixes.mjs — a subpath that carries a WARNING in its name must
 * carry it on every symbol behind it too.
 *
 * ONE quarantine subpath in this package pairs a path with a name prefix:
 *
 *   ./eval          →  every runtime export starts with `paid_`, except the
 *                      free report readers SURFACES names one by one
 *
 * There were two. `./experimental` was deleted 2026-08-21 on the argument this
 * header already made — that of the pair, only the NAME is present where the
 * reader is — so the `experimental_` prefix now stands alone, enforced per
 * declaration by the ESLint rule `local/experimental-name` rather than per
 * subpath by this script. Nothing was relaxed: the prefix is checked in MORE
 * places than before, since it no longer depends on which door a symbol left by.
 *
 * 🔴 That deletion is also how this check earned its own bug report. Moving R3
 * onto `./eval` looked reasonable and this gate rejected it: `paid_` means "this
 * call can bill you", and `experimental_startServices` takes a
 * `ContainerRuntime` and starts containers — it calls no model. The tempting fix
 * was `paid_experimental_startServices`, which would have quietly redefined
 * `paid_` as "expensive in some sense" and turned the prefix back into
 * decoration. R3 went to the package root instead. A quarantine prefix is only
 * worth having while it is narrow enough to be false somewhere.
 *
 * The reason the prefix exists at all is that the import path warns ONCE, at the
 * top of a file, and the name warns EVERY time, at the call site. Reading
 * `await judged(trace, "did it refuse?")` on line 140, the import line is long
 * out of view; `await paid_judged(...)` still says what it costs.
 *
 * A convention held only by prose decays the moment someone adds one export in a
 * hurry — and it HAD decayed: `makeDockerRuntime` sat unprefixed among six
 * `experimental_` siblings on the old `./experimental` until this check was
 * written. One missing prefix is worse than none at all, because the six that
 * are prefixed teach the reader that an unprefixed name means "safe".
 *
 * TYPES ARE EXEMPT, BY DESIGN, NOT BY OVERSIGHT. The prefix warns about calling
 * something. A type is never called and can never bill or misbehave, so
 * `paid_EvalReport` would be noise on a symbol that cannot do the thing being
 * warned about — and the report types live on the free root `vigiles`, where a
 * `paid_` name would be false. This script reads the built `.d.ts` with the TypeScript
 * compiler rather than grepping the source precisely so that it can tell a value
 * from a type instead of guessing.
 *
 * Exit code 1 on any violation — this FAILS, it does not nudge. A quarantine
 * convention that only prints a suggestion is the prose it was meant to replace.
 *
 *   node scripts/check-export-prefixes.mjs [repoRoot]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

/** The contract: one built type-entry, one required prefix on every VALUE export. */
export const SURFACES = [
  {
    subpath: "./eval",
    dts: "dist/entries/eval.d.ts",
    prefix: "paid_",
    // The report READERS share this door with the runners (v50): their only
    // reader is someone who just ran an eval. They spend nothing, so they carry
    // no `paid_` — and they are a CLOSED list here, so a new unprefixed export
    // still fails until someone decides it is free and names it.
    free: [
      "compare",
      "assertImproves",
      "assertNoRegression",
      "assertRates",
      // Builds the arms a paid eval runs; its one proving run uses the scripted model.
      "experimental_outputStyleArms",
    ],
  },
];

/**
 * Report every value export of `surfaces` whose name lacks the required prefix.
 * Exported (rather than inlined into the CLI tail) so the test can drive it over
 * a fixture package instead of only over this repo — a check that can only be
 * run on a clean tree cannot be shown to FIRE, and a check nobody has seen fire
 * is indistinguishable from a dead one.
 */
export function findPrefixViolations(root, surfaces = SURFACES) {
  const req = createRequire(join(root, "package.json"));
  const ts = req("typescript");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const out = [];

  for (const s of surfaces) {
    // The exports map is the authority on which subpaths are public: a surface
    // listed here but absent from package.json is a stale contract, not a pass.
    const mapped = pkg.exports?.[s.subpath];
    if (mapped === undefined) {
      out.push({
        subpath: s.subpath,
        symbol: "(the subpath itself)",
        why: `not present in package.json "exports" — this check is stale`,
      });
      continue;
    }

    const entry = join(root, s.dts);
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      skipLibCheck: true,
      noEmit: true,
    });
    const sf = program.getSourceFile(entry);
    if (!sf) {
      out.push({
        subpath: s.subpath,
        symbol: "(the barrel itself)",
        why: `${s.dts} not found — run \`npm run build\` first`,
      });
      continue;
    }
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exports = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol)
      : [];

    for (const sym of exports) {
      const name = sym.getName();
      if (!isValueExport(ts, checker, sym)) continue; // types are exempt — see header
      if (name.startsWith(s.prefix)) continue;
      if (s.free?.includes(name)) continue; // a declared free reader — see SURFACES
      out.push({
        subpath: s.subpath,
        symbol: name,
        why: `runtime export on "${s.subpath}" must be named \`${s.prefix}${name}\``,
      });
    }
  }
  return out;
}

/**
 * Is this export something a caller can CALL or read at runtime (as opposed to a
 * pure type)? An aliased re-export (`export { x as paid_x } from …`) reports the
 * alias flag, so resolve it before asking — otherwise every renamed export, i.e.
 * every export on `./eval`, would be misread as a type and the check would pass
 * vacuously on the exact surface it exists to police.
 */
function isValueExport(ts, checker, sym) {
  let s = sym;
  if (s.getFlags() & ts.SymbolFlags.Alias) {
    try {
      s = checker.getAliasedSymbol(s);
    } catch {
      /* unresolvable alias: fall through and judge by the local flags */
    }
  }
  return Boolean(s.getFlags() & ts.SymbolFlags.Value);
}

// --- CLI ---------------------------------------------------------------------
// `import.meta.main` is not available on the Node this repo targets, so compare
// argv[1] instead; the test imports this module and must not trip the exit.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);

if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? ".");
  const violations = findPrefixViolations(root);
  for (const v of violations) {
    console.error(`✗ ${v.subpath}: ${v.symbol} — ${v.why}`);
  }
  const surfaces = SURFACES.map((s) => `${s.subpath} (${s.prefix}*)`).join(
    ", ",
  );
  if (violations.length > 0) {
    console.error(
      `\n${String(violations.length)} export(s) break the quarantine naming contract.`,
    );
    process.exit(1);
  }
  console.log(`export prefixes verified: ${surfaces} — no violations.`);
}
