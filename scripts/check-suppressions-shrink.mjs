#!/usr/bin/env node
/**
 * `eslint-suppressions.json` may only shrink, unless a commit of the change
 * declares why it grows (`Suppressions-Grow: <reason>` trailer) — checked
 * against the base branch's copy, because the file cannot vouch for itself (see
 * `scripts/lib/suppressions-shrink.mjs`). Also prints, for every file the change
 * touched that has suppressions, its total before and after.
 *
 * Base: `GITHUB_BASE_REF` in CI (the `check` job checks out full history),
 * `origin/main` locally; the comparison point is the merge-base with HEAD.
 * A missing git or base ref fails rather than passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  GROW_TRAILER,
  growthReasons,
  suppressionGrowth,
  touchedFiles,
} from "./lib/suppressions-shrink.mjs";

const FILE = "eslint-suppressions.json";
const SHOWN = 40;
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

const ref = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : "origin/main";

let mergeBase;
try {
  mergeBase = git("merge-base", "HEAD", ref);
} catch (error) {
  console.error(
    `✗ suppressions-shrink: cannot find the merge-base of HEAD and ${ref} (${String(error).split("\n")[0]}). ` +
      `Fetch the base branch (CI: actions/checkout with fetch-depth: 0).`,
  );
  process.exit(1);
}

const base = JSON.parse(git("show", `${mergeBase}:${FILE}`));
const head = JSON.parse(readFileSync(FILE, "utf8"));
const at = `${ref} (${mergeBase.slice(0, 7)})`;

const touched = touchedFiles(
  base,
  head,
  git("diff", "--name-only", `${mergeBase}...HEAD`).split("\n"),
);
for (const t of touched) {
  const verdict =
    t.after < t.before ? "better" : t.after > t.before ? "WORSE" : "same";
  console.log(
    `  ${t.file}: ${String(t.before)} → ${String(t.after)} suppressed (${verdict})`,
  );
}

const growth = suppressionGrowth(base, head);
if (growth.length === 0) {
  console.log(`✓ suppressions-shrink: ${FILE} only shrank against ${at}`);
  process.exit(0);
}

const reasons = growthReasons(
  git(
    "log",
    `--format=%(trailers:key=${GROW_TRAILER},valueonly)`,
    `${mergeBase}..HEAD`,
  ),
);
const added = growth.reduce((n, g) => n + g.after - g.before, 0);
const lines = growth
  .slice(0, SHOWN)
  .map(
    (g) => `  - ${g.file} ${g.rule}: ${String(g.before)} → ${String(g.after)}`,
  );
const more =
  growth.length > SHOWN
    ? [`  … and ${String(growth.length - SHOWN)} more`]
    : [];

if (reasons.length > 0) {
  console.log(
    `✓ suppressions-shrink: ${FILE} grew by ${String(added)} against ${at}, declared:`,
  );
  for (const r of reasons) console.log(`  ${GROW_TRAILER}: ${r}`);
  process.exit(0);
}

console.error(
  `✗ suppressions-shrink: ${FILE} grew by ${String(added)} against ${at}:`,
);
for (const l of [...lines, ...more]) console.error(l);
console.error(
  `  Fix the new violations instead of suppressing them. If the growth is meant ` +
    `(a new rule, a moved file), add a "${GROW_TRAILER}: <reason>" trailer to a commit.`,
);
process.exit(1);
