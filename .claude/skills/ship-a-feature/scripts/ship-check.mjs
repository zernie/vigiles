#!/usr/bin/env node
/**
 * ship-check.mjs — the executable half of the `ship-a-feature` skill.
 *
 * Two modes:
 *
 *   node ship-check.mjs <symbol> [--stable "<why>"] [--root DIR] [--no-regen]
 *       REACHABLE · SURFACE · DOCUMENTED · MARKED for one new public symbol.
 *   node ship-check.mjs --gate [--root DIR] [--cmd "<command>"]
 *       Run the gate (default `npm run check`) on a FROZEN tree, in the
 *       foreground, and exit with ITS code.
 *
 * Every check maps to one failure measured on 2026-09-02 while shipping
 * `equivalentDisasters` (see SKILL.md, the numbers in parentheses). None of them
 * is covered by `npm run check`: the api-extractor gate REGENERATES the surface
 * but nothing reads the diff; the ESLint rule holds tag→name but cannot write the
 * tag; nothing at all asks whether a symbol is reachable from a door.
 *
 * `--root` and `--no-regen` exist so the colocated harness can drive this over a
 * fixture repo — a check that can only run on a clean tree cannot be shown to
 * FIRE, and a check nobody has seen fire is indistinguishable from a dead one.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
/** A flag with a value (`--root DIR`); the value is removed from argv with it. */
const valued = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
/** A bare boolean flag — it never consumes the argument after it. */
const bool = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const root = resolve(valued("--root") ?? process.cwd());
const gate = bool("--gate");
const cmd = valued("--cmd") ?? "npm run check";
const stable = valued("--stable");
const noRegen = bool("--no-regen");
const symbols = argv.filter((a) => !a.startsWith("--"));

const findings = [];
const ok = (check, msg) => console.log(`✓ ${check} ${msg}`);
const bad = (check, msg, fix) => {
  findings.push(check);
  console.log(`✗ ${check} ${msg}\n    fix: ${fix}`);
};

function sh(command, opts = {}) {
  const r = spawnSync(command, {
    shell: true,
    cwd: root,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * A hash of EVERYTHING in the working tree, untracked files included, without
 * touching the real index: `git add -A` into a throwaway index, then
 * `write-tree`. Two equal hashes = nothing moved between them.
 */
function treeHash() {
  const idx = join(
    tmpdir(),
    `ship-check-idx-${String(process.pid)}-${String(Date.now())}`,
  );
  const env = { GIT_INDEX_FILE: idx };
  const add = sh("git add -A", { env });
  if (add.code !== 0)
    throw new Error(`not a git work tree (${root}): ${add.out.trim()}`);
  const tree = sh("git write-tree", { env });
  sh(`rm -f "${idx}"`);
  return tree.out.trim();
}

function walk(dir, pred, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

const wordRe = (symbol) =>
  new RegExp(`(?<![A-Za-z0-9_$])${symbol}(?![A-Za-z0-9_$])`);

// ─── the gate ────────────────────────────────────────────────────────────────
if (gate) {
  const before = treeHash();
  console.log(`▶ GATE ${cmd}  (tree ${before.slice(0, 12)})`);
  // Foreground, inherited stdio: nothing to poll, nothing to `pgrep`, and the
  // exit code below is the command's own — no pipe between it and us (6, 7).
  const { code } = sh(cmd, { inherit: true });
  const after = treeHash();
  if (before !== after)
    bad(
      "GATE",
      `the tree MOVED while the gate ran (${before.slice(0, 12)} → ${after.slice(0, 12)}); its result belongs to no state (5)`,
      "stop editing, then re-run the gate on the tree you mean to ship",
    );
  else ok("GATE", `frozen tree, exit ${String(code)}`);
  process.exit(findings.length ? 1 : code);
}

if (symbols.length === 0) {
  console.error(
    "usage: ship-check.mjs <symbol> [--stable <why>] [--root DIR] [--no-regen]\n" +
      "       ship-check.mjs --gate [--root DIR] [--cmd <command>]",
  );
  process.exit(2);
}

// ─── REACHABLE (1) ───────────────────────────────────────────────────────────
async function checkReachable(symbol) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const doors = Object.entries(pkg.exports ?? {});
  if (doors.length === 0)
    return bad(
      "REACHABLE",
      "package.json has no `exports` map",
      "a public symbol needs a door to be public through",
    );
  const reached = [];
  const closed = [];
  for (const [sub, target] of doors) {
    const file =
      typeof target === "string"
        ? target
        : (target.import ?? target.default ?? target.require);
    if (typeof file !== "string") continue;
    const abs = resolve(root, file);
    if (!existsSync(abs)) {
      closed.push(`${sub} (missing ${file} — run \`npm run build\`)`);
      continue;
    }
    try {
      const m = await import(pathToFileURL(abs).href);
      if (symbol in m) reached.push(sub);
    } catch (e) {
      closed.push(`${sub} (${String(e.message).split("\n")[0]})`);
    }
  }
  if (reached.length === 0)
    return bad(
      "REACHABLE",
      `\`${symbol}\` is not a key on any public door (${doors.map(([s]) => s).join(", ")})` +
        (closed.length ? `; could not open: ${closed.join("; ")}` : ""),
      "re-export it from the barrel behind the door you chose (e.g. `src/entries/index.ts` for `.`), rebuild, re-run",
    );
  ok("REACHABLE", `\`${symbol}\` via ${reached.join(", ")}`);
}

// ─── SURFACE (2) ─────────────────────────────────────────────────────────────
function checkSurface(symbol) {
  const dir = join(root, "api-surface");
  if (!existsSync(dir))
    return bad(
      "SURFACE",
      "no api-surface/ directory",
      "this repo's public API is snapshotted by api-extractor; run `npm run api:report`",
    );
  if (!noRegen) {
    const r = sh("node scripts/api-extractor.mjs --local");
    if (r.code !== 0)
      return bad(
        "SURFACE",
        `api-extractor failed:\n${r.out.trim()}`,
        "fix the build first",
      );
  }
  const reports = walk(dir, (p) => p.endsWith(".api.md"));
  const hits = [];
  for (const p of reports) {
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^export\b/.test(line) && wordRe(symbol).test(line)) {
        // the tag line sits directly above the declaration in an api.md
        const tag = lines[i - 1] ?? "";
        hits.push({ file: relative(root, p), tag, line });
      }
    });
  }
  if (hits.length === 0)
    return bad(
      "SURFACE",
      `\`${symbol}\` appears in no api-surface/*.api.md`,
      "it is not exported from any entry api-extractor scans — fix REACHABLE, rebuild, re-run",
    );
  const own = hits.filter((h) => h.tag.includes("(undocumented)"));
  if (own.length)
    return bad(
      "SURFACE",
      `\`${symbol}\` is exported UNDOCUMENTED in ${own.map((h) => h.file).join(", ")}`,
      "give the declaration a JSDoc block directly above it (no blank line, nothing in between)",
    );
  // Now READ the diff the gate only regenerates. `-U1` so the line after a
  // `+// @public (undocumented)` — the declaration that lost its doc — is shown.
  const diff = sh("git diff -U1 -- api-surface").out.split("\n");
  const stolen = [];
  diff.forEach((line, i) => {
    if (/^\+(?!\+\+).*\(undocumented\)/.test(line))
      stolen.push((diff[i + 1] ?? "").replace(/^[+ ]/, "").trim());
  });
  if (stolen.length)
    return bad(
      "SURFACE",
      `the regenerated surface diff introduces \`(undocumented)\` on: ${stolen.join(" · ")}`,
      "your declaration probably sits between a neighbour's JSDoc and its declaration — move it, rebuild, `git diff api-surface` must show no new `(undocumented)`",
    );
  ok(
    "SURFACE",
    `in ${hits.map((h) => h.file).join(", ")}, documented, no neighbour lost its doc`,
  );
}

// ─── DOCUMENTED (3) ──────────────────────────────────────────────────────────
function checkDocumented(symbol) {
  const files = walk(join(root, "docs"), (p) => p.endsWith(".md"));
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.push(readme);
  const homes = files
    .filter((p) => wordRe(symbol).test(readFileSync(p, "utf8")))
    .map((p) => relative(root, p));
  if (homes.length === 0)
    return (
      bad(
        "DOCUMENTED",
        `\`${symbol}\` is named nowhere under docs/ or README.md`,
        "write its WHY into the docs/ section whose claim it changes (document-the-why); a bare mention is not enough, but zero mentions is impossible",
      ),
      []
    );
  ok("DOCUMENTED", `named in ${homes.join(", ")}`);
  return homes;
}

// ─── MARKED (4) ──────────────────────────────────────────────────────────────
function checkMarked(symbol) {
  const decl = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(function|const|let|var|class|type|interface|enum)\\s+(?:\\*\\s*)?${symbol}\\b`,
  );
  const sources = walk(
    join(root, "src"),
    (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"),
  );
  for (const p of sources) {
    const lines = readFileSync(p, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]);
      if (!m) continue;
      const where = `${relative(root, p)}:${String(i + 1)}`;
      if (m[1] === "type" || m[1] === "interface")
        return ok(
          "MARKED",
          `${where} is a type — the prefix convention covers call sites, types are exempt`,
        );
      // The JSDoc must END on the line directly above the declaration.
      let j = i - 1;
      const doc = [];
      if ((lines[j] ?? "").trim().endsWith("*/")) {
        for (; j >= 0; j--) {
          doc.unshift(lines[j]);
          if (lines[j].trim().startsWith("/**")) break;
        }
      }
      const tagged = doc.some((l) => /@experimental\b/.test(l));
      const prefixed = symbol.startsWith("experimental_");
      if (tagged)
        return ok(
          "MARKED",
          `${where} carries @experimental (ESLint local/experimental-name holds the name)`,
        );
      if (prefixed)
        return bad(
          "MARKED",
          `${where} is named experimental_ but its JSDoc has no @experimental tag`,
          "STABILITY.md: the tag is how it is DECLARED; add it so the lint rule can hold tag↔name",
        );
      if (typeof stable === "string" && stable.trim())
        return ok("MARKED", `${where} stable — ${stable.trim()}`);
      return bad(
        "MARKED",
        `${where} is exported with NO @experimental tag and NO experimental_ prefix, and you have not said it is stable`,
        'decide now: if it is days old / has one consumer / may change without a major bump → add `@experimental` to the JSDoc and rename `experimental_" + symbol + "`; otherwise re-run with --stable "<why>" and put that sentence in the PR body',
      );
    }
  }
  bad(
    "MARKED",
    `no \`export … ${symbol}\` declaration found under src/`,
    "check the spelling, or pass the declared name (the barrel re-export is not the declaration)",
  );
}

// ─── FINDABLE (5) ────────────────────────────────────────────────────────────
// DOCUMENTED asks whether the capability is written down. This asks whether a
// reader who does not already know where to look can REACH what was written.
//
// The measured failure (2026-09-02): `experimental_equivalentDisasters` (since
// renamed `experimental_alternateSpellings`) was documented, once, under its own heading inside `docs/compiled-hooks.md` — a
// guide about a DIFFERENT feature. Nothing linked to that heading, and the
// testing guide, where someone asking "does my guard actually block?" would
// look, named it zero times. Written down, unreachable.
//
// Two ways to pass, because both are real findability and neither is a proxy:
//   a) two different pages name it — a second entry point exists; or
//   b) one page names it, and another page LINKS to that section's anchor.
// One page, one mention, no inbound link is the shape that fails.
function checkFindable(symbol, homes) {
  if (homes.length === 0) return; // DOCUMENTED already reported the harder fault
  if (homes.length > 1)
    return ok(
      "FINDABLE",
      `named from ${String(homes.length)} pages: ${homes.join(", ")}`,
    );

  const home = homes[0];
  const body = readFileSync(join(root, home), "utf8");
  // github-slugger: lowercase, drop punctuation, then replace EACH space with a
  // hyphen WITHOUT collapsing runs — so "a — b" is "a--b", not "a-b".
  const slug = (h) =>
    h
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/ /g, "-");
  const anchors = [];
  for (const m of body.matchAll(/^#{2,6} +(.+)$/gm))
    if (wordRe(symbol).test(m[1])) anchors.push(slug(m[1]));

  if (anchors.length) {
    const others = walk(join(root, "docs"), (p) => p.endsWith(".md"));
    const readme = join(root, "README.md");
    if (existsSync(readme)) others.push(readme);
    for (const p of others) {
      if (relative(root, p) === home) continue;
      const t = readFileSync(p, "utf8");
      const hit = anchors.find((a) => t.includes(`#${a}`));
      if (hit)
        return ok(
          "FINDABLE",
          `${home}#${hit} is linked from ${relative(root, p)}`,
        );
    }
  }

  bad(
    "FINDABLE",
    `\`${symbol}\` is named only in ${home}, and no other page links to it there`,
    anchors.length
      ? `link \`${home}#${anchors[0]}\` from the page a reader with this problem actually opens — a section reachable only by someone already inside ${home} is not findable`
      : `name it on a second page too (the guide for the problem it solves, or a one-line README pointer), or give it its own heading and link that heading from there`,
  );
}

for (const symbol of symbols) {
  console.log(`── ${symbol}`);
  await checkReachable(symbol);
  checkSurface(symbol);
  const homes = checkDocumented(symbol);
  checkFindable(symbol, homes ?? []);
  checkMarked(symbol);
}
if (findings.length) {
  console.log(
    `\n${String(findings.length)} finding(s): ${findings.join(", ")}`,
  );
  process.exit(1);
}
console.log("\nall checks passed");
