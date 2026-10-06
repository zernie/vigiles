/**
 * Source-kinds suite (vitest, unit tier): the one classifier that decides what a
 * file in `.vigiles/hooks/` or `.vigiles/providers/` IS — a hook, a provider, a
 * vigiles test, a declaration, a stamp, something that is not a source at all, or
 * a runnable file nothing claims. Asserts the returned kind for named inputs, the
 * markers' spelling in both directions, that every test-discovery pattern is
 * derived from the same table, and — over a generated set of names, against the
 * REAL discovery functions on disk — that hook discovery and test discovery can
 * never both claim a file.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import {
  DEFAULT_TEST_GLOBS,
  RUNNABLE_EXTS,
  classifySource,
  isEvalScript,
  markedName,
  preMarkerName,
  testGlob,
  type SourceKind,
} from "./source-kinds.js";
import { discoverHookFiles, discoverProviderFiles } from "./hook-install.js";
import {
  discoverScripts,
  scriptGlob,
} from "./adapters/claude-code/run-scripts.js";

const kind = (name: string): SourceKind["kind"] => classifySource(name).kind;

describe("classifySource: one kind per name", () => {
  it.each(RUNNABLE_EXTS)("a `.hook.` file is a hook (.%s)", (ext) => {
    expect(classifySource(`guard.hook.${ext}`)).toEqual({ kind: "hook" });
  });

  it.each(RUNNABLE_EXTS)("a `.provider.` file is a provider (.%s)", (ext) => {
    expect(classifySource(`k8s.provider.${ext}`)).toEqual({ kind: "provider" });
  });

  it.each(RUNNABLE_EXTS)(
    "`.harness.` and `.eval.` are vigiles tests (.%s)",
    (ext) => {
      expect(classifySource(`guard.harness.${ext}`)).toEqual({
        kind: "vigiles-test",
        test: "harness",
      });
      expect(classifySource(`guard.eval.${ext}`)).toEqual({
        kind: "vigiles-test",
        test: "eval",
      });
    },
  );

  it.each(["x.d.ts", "x.d.mts", "x.d.cts", "x.hook.d.ts", "x.harness.d.mts"])(
    "%s is a declaration, whatever its infix says",
    (name) => {
      expect(kind(name)).toBe("declaration");
    },
  );

  it.each(["guard.hook.mjs.json", "guard.mjs.json", "x.harness.ts.json"])(
    "%s is a stamp: the .json sidecar of a runnable source",
    (name) => {
      expect(kind(name)).toBe("stamp");
    },
  );

  it.each([
    "README.md",
    ".gitkeep",
    "config.json",
    "guard.hook.md",
    "guard.hook.mjs.bak",
    "guard.hook",
    "guard",
    "x.hook.tsx",
  ])("%s is not a runnable source at all", (name) => {
    expect(kind(name)).toBe("non-source");
  });

  it.each([
    "guard.mjs", // a hook written before the marker existed
    "hook.mjs", // the word, not the marker: there is no stem before it
    ".hook.mjs", // an empty stem
    "util.ts",
    "guard.test.ts", // a default vitest/jest name: vigiles does not run it
    "guard.spec.mjs",
    "guard.hook.test.ts",
    "guard.harness.helper.ts", // the LAST infix decides, and it is not ours
    "guard.hooks.mjs", // near miss
    "guard.Hook.mjs", // case-sensitive
  ])("%s is unclaimed: runnable, and nobody's", (name) => {
    expect(kind(name)).toBe("unclaimed");
  });

  it("a name with a newline in it is still classified by its extension and marker, never dropped as a non-source", () => {
    // `.` does not match `\n`, so a pattern built on it let a hook whose name
    // had a newline fall out of every kind and vanish from compile silently.
    expect(kind("gu\nard.mjs")).toBe("unclaimed");
    expect(kind("gu\nard.hook.mjs")).toBe("hook");
    expect(kind("a\nb.harness.ts")).toBe("vigiles-test");
    expect(kind("a\n.hook.ts")).toBe("hook");
    expect(kind("a\nb.md")).toBe("non-source");
  });

  it("a stemless `.harness.mjs` / `.eval.ts` is a vigiles test, because the runner's glob matches it", () => {
    for (const ext of RUNNABLE_EXTS) {
      expect(classifySource(`.harness.${ext}`)).toEqual({
        kind: "vigiles-test",
        test: "harness",
      });
      expect(classifySource(`.eval.${ext}`)).toEqual({
        kind: "vigiles-test",
        test: "eval",
      });
    }
    // …while a stemless hook or provider is still nobody's: there is nothing to
    // name it by, and a hook must be nameable.
    expect(kind(".hook.mjs")).toBe("unclaimed");
    expect(kind(".provider.ts")).toBe("unclaimed");
  });

  it("the LAST infix decides, so a name can only ever have one kind", () => {
    expect(kind("gate.hook.harness.mjs")).toBe("vigiles-test");
    expect(kind("gate.harness.hook.mjs")).toBe("hook");
    expect(kind("gate.eval.provider.ts")).toBe("provider");
  });

  it("`isEvalScript` is the same question asked of the same table", () => {
    expect(isEvalScript("a.eval.mjs")).toBe(true);
    expect(isEvalScript("a.eval.ts")).toBe(true);
    expect(isEvalScript("a.harness.mjs")).toBe(false);
    expect(isEvalScript("parser.eval.test.ts")).toBe(false);
    expect(isEvalScript("a.eval.mjs.json")).toBe(false);
  });
});

describe("the marker, in both directions", () => {
  it("markedName inserts the infix before the extension", () => {
    expect(markedName("guard.mjs", "hook")).toBe("guard.hook.mjs");
    expect(markedName("a.b.ts", "hook")).toBe("a.b.hook.ts");
    expect(markedName("k8s.mjs", "provider")).toBe("k8s.provider.mjs");
  });

  it("both separators are directory separators (a Windows path)", () => {
    expect(markedName(".vigiles\\hooks\\guard.mjs", "hook")).toBe(
      ".vigiles\\hooks\\guard.hook.mjs",
    );
    expect(markedName("C:\\repo\\a.b\\guard.ts", "hook")).toBe(
      "C:\\repo\\a.b\\guard.hook.ts",
    );
    expect(preMarkerName(".vigiles\\hooks\\guard.hook.mjs", "hook")).toBe(
      ".vigiles\\hooks\\guard.mjs",
    );
    // a stemless name has no earlier name, whichever separator precedes it
    expect(preMarkerName("a\\.hook.mjs", "hook")).toBeUndefined();
    expect(preMarkerName("a/.hook.mjs", "hook")).toBeUndefined();
    // a dot in a DIRECTORY name must not be taken for the marker
    expect(preMarkerName("a.hook\\x.mjs", "hook")).toBeUndefined();
  });

  it("markedName keeps the directory", () => {
    expect(markedName(".vigiles/hooks/guard.mjs", "hook")).toBe(
      ".vigiles/hooks/guard.hook.mjs",
    );
  });

  it("preMarkerName undoes it, and answers nothing for a name that has no marker", () => {
    expect(preMarkerName("guard.hook.mjs", "hook")).toBe("guard.mjs");
    expect(preMarkerName(".vigiles/hooks/a.hook.ts", "hook")).toBe(
      ".vigiles/hooks/a.ts",
    );
    expect(preMarkerName("guard.mjs", "hook")).toBeUndefined();
    expect(preMarkerName("guard.harness.mjs", "hook")).toBeUndefined();
  });

  it("markedName and preMarkerName are inverses on every runnable extension", () => {
    for (const ext of RUNNABLE_EXTS) {
      const bare = `guard.${ext}`;
      expect(preMarkerName(markedName(bare, "hook"), "hook")).toBe(bare);
    }
  });
});

describe("test discovery is DERIVED from the table, not copied", () => {
  it("testGlob spells the extension set from RUNNABLE_EXTS", () => {
    expect(testGlob("harness")).toBe("**/*.harness.{mjs,cjs,js,mts,cts,ts}");
    expect(testGlob("eval")).toBe("**/*.eval.{mjs,cjs,js,mts,cts,ts}");
  });

  it("every derived glob matches names that classify as a vigiles test of THAT tier", () => {
    for (const glob of DEFAULT_TEST_GLOBS) {
      for (const ext of RUNNABLE_EXTS) {
        const name = glob.replace("**/*", "x").replace(/\{[^}]*\}/, ext);
        const k = classifySource(name);
        expect(k.kind, name).toBe("vigiles-test");
        expect(name).toContain(`.${k.kind === "vigiles-test" ? k.test : "?"}.`);
      }
    }
  });

  it("the runner's discovery glob and the coverage default are the same patterns", () => {
    expect(DEFAULT_TEST_GLOBS).toEqual([
      scriptGlob("harness"),
      scriptGlob("eval"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The drift guard. Names are GENERATED from the vocabulary the table itself
// exports plus the near-misses that have bitten (declarations, stamps, `.test.`,
// double infixes), and the question is asked of the REAL discovery functions on a
// real directory — not of the classifier — so a consumer that grows its own
// opinion about a name fails here.
// ---------------------------------------------------------------------------

// "" is a STEMLESS name (`.harness.mjs`), "a\nb" one with a newline in it.
const STEMS = ["guard", "a.b", "task-list-nudge", "", "a\nb"];
const INFIXES = [
  "",
  ".hook",
  ".provider",
  ".harness",
  ".eval",
  ".test",
  ".spec",
  ".helper",
  ".HARNESS", // case: the classifier is case-sensitive, so the glob must be too
  ".Hook",
  ".hook.test",
  ".hook.harness",
  ".harness.hook",
  ".eval.test",
  ".d",
];
const TAILS = ["", ".json", ".bak"];

function generatedNames(): string[] {
  const names = new Set<string>();
  for (const stem of STEMS)
    for (const infix of INFIXES)
      for (const ext of [...RUNNABLE_EXTS, "tsx", "md"])
        for (const tail of TAILS) names.add(`${stem}${infix}.${ext}${tail}`);
  return [...names].sort();
}

function populate(root: string, dir: string, names: readonly string[]): void {
  mkdirSync(join(root, dir), { recursive: true });
  for (const n of names) writeFileSync(join(root, dir, n), "");
}

describe("hook discovery and test discovery never both claim a file", () => {
  const names = generatedNames();

  it("generates a set big enough to mean something", () => {
    expect(names.length).toBeGreaterThan(400);
  });

  it("no name is found by both, and every test-glob match is refused by hook discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "vig-kinds-"));
    try {
      populate(root, ".vigiles/hooks", names);
      populate(root, ".vigiles/providers", names);
      const hookClaimed = new Set(
        discoverHookFiles(root).claimed.map((p) => p.split("/").pop() ?? p),
      );
      const providerClaimed = new Set(
        discoverProviderFiles(root).claimed.map((p) => p.split("/").pop() ?? p),
      );

      // Test discovery two ways: the patterns coverage credits tests with, and
      // the glob the runner expands on disk (`vigiles test` / `vigiles eval`).
      const byPattern = names.filter((n) =>
        DEFAULT_TEST_GLOBS.some((g) =>
          minimatch(`.vigiles/hooks/${n}`, g, { dot: true, nocase: false }),
        ),
      );
      const onDisk = [
        ...discoverScripts(
          [],
          scriptGlob("harness"),
          join(root, ".vigiles/hooks"),
          [],
        ),
        ...discoverScripts(
          [],
          scriptGlob("eval"),
          join(root, ".vigiles/hooks"),
          [],
        ),
      ].sort();

      expect(byPattern.length).toBeGreaterThan(0);
      // The classifier and the glob can never disagree about what a test is:
      // stemless, uppercase and newline names included.
      expect([...byPattern].sort()).toEqual(
        names.filter((n) => kind(n) === "vigiles-test").sort(),
      );
      // The two ways of discovering a test agree with each other…
      expect([...byPattern].sort()).toEqual(onDisk);
      // …and hook discovery refuses every one of them, in both directories.
      for (const n of byPattern) {
        expect(hookClaimed.has(n), `hook discovery claimed ${n}`).toBe(false);
        expect(providerClaimed.has(n), `provider discovery claimed ${n}`).toBe(
          false,
        );
      }
      // Nothing is claimed by BOTH the hook and the provider role either.
      for (const n of hookClaimed)
        expect(providerClaimed.has(n), `${n} claimed twice`).toBe(false);
      // And what discovery DOES claim is exactly the marked, non-declaration names.
      expect([...hookClaimed].sort()).toEqual(
        names.filter((n) => kind(n) === "hook").sort(),
      );
      expect([...providerClaimed].sort()).toEqual(
        names.filter((n) => kind(n) === "provider").sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every name lands in exactly one bucket: claimed, unclaimed, or deliberately ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "vig-kinds-"));
    try {
      populate(root, ".vigiles/hooks", names);
      const d = discoverHookFiles(root);
      const base = (p: string): string => p.split("/").pop() ?? p;
      const claimed = new Set(d.claimed.map(base));
      const unclaimed = new Set(d.unclaimed.map(base));
      for (const n of names) {
        const k = kind(n);
        expect(claimed.has(n), `claimed ${n}`).toBe(k === "hook");
        // An unclaimed name is a hook-or-provider-shaped orphan: runnable, not a
        // test, not a declaration, not a stamp. A provider-marked file in the
        // HOOKS directory is nobody's there, so it is reported too.
        expect(unclaimed.has(n), `unclaimed ${n}`).toBe(
          k === "unclaimed" || k === "provider",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
