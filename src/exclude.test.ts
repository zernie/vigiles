/**
 * The exclusion predicate every repo-policing walk consumes (#192). Two things
 * are pinned here that the walks' own tests cannot see: the SPELLINGS a user
 * writes (a bare directory name above all — glob's string ignore silently
 * matched nothing for it), and the function face staying correct when a glob is
 * rooted BELOW the repo root.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

import { EXCLUDE_FLOOR, excludeSet } from "./exclude.js";
import { withIgnored } from "./core/glob-ignore.js";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

describe("excludeSet — spellings", () => {
  const root = "/repo";

  it("a bare directory name excludes the directory AND its subtree (tsconfig-style)", () => {
    const ex = excludeSet(root, ["bench"]);
    assert.equal(ex.matches("bench"), true);
    assert.equal(ex.matches("bench/evals/x.eval.mjs"), true);
    assert.equal(
      ex.matches("benchmark/x.md"),
      false,
      "a prefix is not a match",
    );
    assert.equal(
      ex.matches("src/bench/x.md"),
      false,
      "root-relative, not anywhere",
    );
  });

  it("accepts the other spellings the same way: trailing slash, /**, and a leading ./", () => {
    for (const spelling of ["bench/", "bench/**", "./bench"]) {
      const ex = excludeSet(root, [spelling]);
      assert.equal(ex.matches("bench/deep/x.md"), true, spelling);
      assert.equal(ex.matches("live/x.md"), false, spelling);
    }
  });

  it("a glob pattern still globs (`**/fixtures` excludes at any depth; `*.snap` a file shape)", () => {
    const ex = excludeSet(root, ["**/fixtures", "*.snap"]);
    assert.equal(ex.matches("a/b/fixtures/x.md"), true);
    assert.equal(ex.matches("fixtures/x.md"), true);
    assert.equal(ex.matches("out.snap"), true);
    assert.equal(ex.matches("a/x.md"), false);
  });

  it("the floor is always in, and dotdirs match with dot:true", () => {
    const ex = excludeSet(root, []);
    for (const p of [
      "node_modules/x/y.js",
      "dist/cli.js",
      ".git/HEAD",
      ".vigiles/state.json",
    ])
      assert.equal(ex.matches(p), true, p);
    for (const p of EXCLUDE_FLOOR)
      assert.equal(ex.explain(p.replace("/**", "/x")), p, p);
    assert.deepEqual([...ex.patterns], [], "the floor is not a user pattern");
  });

  it("the root itself, `.`, and a path outside the root are never excluded", () => {
    const ex = excludeSet(root, ["bench"]);
    assert.equal(ex.matches(""), false);
    assert.equal(ex.matches("."), false);
    assert.equal(ex.matches("../sibling/bench/x"), false);
  });

  it("explain() names the user pattern that matched, or null", () => {
    const ex = excludeSet(root, ["bench", "vendor/**"]);
    assert.equal(ex.explain("bench/x.md"), "bench");
    assert.equal(ex.explain("vendor/a/b.md"), "vendor/**");
    assert.equal(
      ex.explain("node_modules/x"),
      "node_modules/**",
      "the floor explains itself too",
    );
    assert.equal(ex.explain("src/x.md"), null);
  });

  it("a user pattern excludes itself AND its subtree, with or without a trailing slash", () => {
    const ex = excludeSet(root, ["bench", "docs/gen/"]);
    for (const p of ["bench", "bench/x/y.md", "docs/gen", "docs/gen/a.md"])
      assert.equal(ex.matches(p), true, p);
    assert.equal(ex.matches("benchmark/x.md"), false, "a name is not a prefix");
    assert.deepEqual([...ex.patterns], ["bench", "docs/gen"]);
    // An empty or whitespace-only entry is dropped rather than excluding everything.
    assert.deepEqual([...excludeSet(root, ["", "./"]).patterns], []);
  });
});

describe("excludeSet — the glob function face", () => {
  it("filters a glob rooted AT the root, with the bare-name spelling", () => {
    const dir = makeTmpDir("exclude");
    try {
      mkdirSync(join(dir, "bench", "deep"), { recursive: true });
      mkdirSync(join(dir, "live"), { recursive: true });
      writeFileSync(join(dir, "bench", "deep", "X.md.spec.ts"), "");
      writeFileSync(join(dir, "bench", "Y.md.spec.ts"), "");
      writeFileSync(join(dir, "live", "Z.md.spec.ts"), "");
      const ex = excludeSet(dir, ["bench"]);
      assert.deepEqual(
        globSync("**/*.md.spec.ts", {
          cwd: dir,
          dot: true,
          ignore: ex.globIgnore,
        }).sort(),
        ["live/Z.md.spec.ts"],
      );
      // Control — the same tree, an empty exclude: all three, so the line above
      // is not passing by finding nothing.
      assert.deepEqual(
        globSync("**/*.md.spec.ts", {
          cwd: dir,
          dot: true,
          ignore: excludeSet(dir, []).globIgnore,
        }).sort(),
        ["bench/Y.md.spec.ts", "bench/deep/X.md.spec.ts", "live/Z.md.spec.ts"],
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("stays correct for a glob rooted BELOW the root (`vigiles lint some/dir`)", () => {
    // The string face cannot do this: relative to `some/dir`, a root-relative
    // `some/dir/vendored/**` matches nothing. The function face keys on the
    // path's position relative to the REPO root.
    const dir = makeTmpDir("exclude-subroot");
    try {
      mkdirSync(join(dir, "some", "dir", "vendored"), { recursive: true });
      writeFileSync(join(dir, "some", "dir", "vendored", "CLAUDE.md"), "");
      writeFileSync(join(dir, "some", "dir", "CLAUDE.md"), "");
      const ex = excludeSet(dir, ["some/dir/vendored"]);
      const sub = join(dir, "some", "dir");
      assert.deepEqual(
        globSync("**/CLAUDE.md", { cwd: sub, ignore: ex.globIgnore }).sort(),
        ["CLAUDE.md"],
      );
      // Why the string face was RETIRED (#281): the same root-relative pattern,
      // as a plain list, globbed from below the root, matches nothing.
      assert.deepEqual(
        globSync("**/CLAUDE.md", {
          cwd: sub,
          ignore: withIgnored([], ["some/dir/vendored/**"]),
        }).sort(),
        ["CLAUDE.md", "vendored/CLAUDE.md"],
      );
      // …and the union keeps the function face's answer when a detector adds
      // its own floor (`glob` takes a list OR one IgnoreLike, never both).
      assert.deepEqual(
        globSync("**/CLAUDE.md", {
          cwd: sub,
          ignore: withIgnored(["nothing-here/**"], ex.globIgnore),
        }).sort(),
        ["CLAUDE.md"],
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
