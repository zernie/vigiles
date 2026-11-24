#!/usr/bin/env node
/**
 * check-docs.mjs — type-check the TypeScript examples in the docs against THIS
 * repo's own build, with two tiers:
 *
 *   GATE 1 (always, every ts block): report ONLY diagnostics about this package's
 *           own module surface — a subpath that is not in the exports map, or a
 *           named import the built package does not export. Free variables,
 *           partial snippets and deliberate type errors are invisible to it, so
 *           an illustrative fragment cannot make it fire.
 *   GATE 2 (opt-in, block marked `<!-- vigiles:check -->`): full tsc diagnostics.
 *
 * 🔴 RECONSIDERED AND REFUTED BY MEASUREMENT, 2026-08-21 — recorded so it is not
 * proposed again. A review round found two doc blocks calling this package's own
 * exports without importing them (`experimental_agent` in railway-subagents.md,
 * `result` in emit-channel.md) — both the residue of a rename that updated the
 * import line and not the body. Gate 1 is blind to them by design, since they are
 * free variables.
 *
 * The tempting narrowing: report TS2304, but ONLY for names this package actually
 * exports. It sounds precise — a fragment referencing a local `planner` stays
 * silent, a fragment calling `result()` with no import does not. It was
 * implemented and run against the corpus before being kept, and the number
 * settled it: **66 findings across 93 blocks.** Docs legitimately name our
 * exports as free variables all over — `skillResolved`, `assertTriggerRate` (since folded into `assertRates`),
 * `codexAdapter` — in fragments that deliberately omit the import they already
 * showed three blocks earlier. A gate opening at 66 is muted the same day, which
 * is the founding decision above, re-derived the hard way.
 *
 * What was done instead: the two blocks in question are COMPLETE programs, so
 * they now carry `<!-- vigiles:check -->` and get real tsc diagnostics forever.
 * That is Gate 2 used as intended — per-block opt-in where completeness is a
 * property of the block, rather than a corpus-wide rule that cannot be true of a
 * corpus mostly made of fragments.
 *
 * No network. No new CLI verb. Resolution is TypeScript's own package
 * self-reference: `import ... from "vigiles/eval"` resolves through this
 * package.json's `exports` map to the local ./dist.
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(process.argv[2] ?? ".");
const req = createRequire(join(ROOT, "package.json"));
const ts = req("typescript");
const MarkdownIt = req("markdown-it");
const md = new MarkdownIt();
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;

const LANGS = new Set(["ts", "typescript", "tsx"]);
// This check owns its own file-level opt-out. It must NOT reuse
// `vigiles:ignore-file`, which answers a different question — that marker tells
// the REFERENCE resolver to leave a doc's `vigiles:gate`/`file()` markers alone,
// and docs full of illustrative markers carry it for that reason. Sharing one
// marker made opting out of ref-resolution silently opt out of import-checking
// too: `docs/skills.md` carried it, so the one doc with provably broken imports
// (`vigiles/skill`, `vigiles/skill-test` — neither subpath exists) was the one
// file this gate could not see. Measured 2026-08-16, the day after it shipped.
const IGNORE_FILE = /<!--\s*vigiles:ignore-imports\s*-->/;
const IGNORE = /<!--\s*vigiles:ignore\s*-->/;
const CHECK = /<!--\s*vigiles:check\s*-->/;

function mdFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) mdFiles(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const targets = [];
for (const arg of process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["docs", "README.md"]) {
  const p = join(ROOT, arg);
  try {
    statSync(p).isDirectory() ? mdFiles(p, targets) : targets.push(p);
  } catch {}
}
targets.sort();

const WORK = join(ROOT, ".doccheck-tmp");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const blocks = [];
for (const f of targets) {
  const src = readFileSync(f, "utf8");
  if (IGNORE_FILE.test(src)) continue;
  const lines = src.split("\n");
  for (const t of md.parse(src, {})) {
    if (t.type !== "fence") continue;
    if (!LANGS.has((t.info || "").trim().split(/\s+/)[0])) continue;
    // look at the two source lines above the fence for a marker
    const above = lines.slice(Math.max(0, t.map[0] - 3), t.map[0]).join("\n");
    if (IGNORE.test(above)) continue;
    const full = CHECK.test(above);
    const id = `b${String(blocks.length).padStart(3, "0")}`;
    const file = join(WORK, `${id}.ts`);
    writeFileSync(
      file,
      t.content.endsWith("\n") ? t.content : t.content + "\n",
    );
    blocks.push({ file, doc: relative(ROOT, f), line: t.map[0] + 1, full });
  }
}

const program = ts.createProgram(
  blocks.map((b) => b.file),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    types: ["node"],
    typeRoots: [join(ROOT, "node_modules", "@types")],
  },
);

// Gate-1 codes: the module surface of THIS package only.
const OWN_MODULE = new RegExp(`['"\`]${PKG}(/[^'"\`]*)?['"\`]`);
const SURFACE = new Set([
  2307, // Cannot find module 'X' or its corresponding type declarations
  2305, // Module 'X' has no exported member 'Y'
  2724, // 'X' has no exported member named 'Y'. Did you mean 'Z'?
  2614, // Module 'X' has no exported member 'Y'. Did you mean to use 'import Y from'?
]);

let findings = 0;
for (const b of blocks) {
  const sf = program.getSourceFile(b.file);
  const diags = b.full
    ? [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ]
    : program.getSemanticDiagnostics(sf).filter((d) => {
        if (!SURFACE.has(d.code)) return false;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        return OWN_MODULE.test(msg);
      });
  for (const d of diags) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    console.log(
      `${b.doc}:${b.line} (block line ${line + 1}:${character + 1}) TS${d.code}: ` +
        ts.flattenDiagnosticMessageText(d.messageText, " ") +
        (b.full ? "  [vigiles:check]" : ""),
    );
    findings++;
  }
}
rmSync(WORK, { recursive: true, force: true });
console.log(
  `\nblocks scanned: ${blocks.length}  (full-check: ${blocks.filter((b) => b.full).length})`,
);
console.log(`findings: ${findings}`);
process.exit(findings ? 1 : 0);
