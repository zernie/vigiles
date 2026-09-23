/**
 * `.vigiles/` per-checkout files stay out of git — tested THROUGH git.
 *
 * The property that matters is not "the `.gitignore` has these lines" but "after
 * vigiles writes its local files, `git status` shows none of them, and still
 * shows the files a project commits". String-matching the ignore file would pass
 * with a pattern git reads differently (an unanchored `state/` also swallows a
 * `hooks/state/`; a missing trailing slash on a directory still matches), so the
 * load-bearing cases below ask git.
 *
 * Deterministic, offline → the free unit tier. Needs `git` on PATH, as the rest
 * of this suite already does (`core/test-utils.ts#initGitRepo`).
 */
import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

import { initGitRepo, makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";
import {
  COMMITTED_PATHS,
  LOCAL_FILES,
  LOCAL_GITIGNORE_HEADER,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
  localIgnoreEntries,
} from "./local-files.js";
import {
  COVERAGE_ARTIFACT_VERSION,
  writeCoverageArtifact,
} from "./coverage-artifact.js";
import { appendObservation } from "./observe.js";
import { writeHookState } from "./hook-state-store.js";
import { record } from "./core/hook-state.js";
import { recordGuardCall } from "./core/guards.js";
import { writeCache, type CacheRecord } from "./eval-cache.js";
import { setActiveSkill } from "./adapters/claude-code/skill-runtime.js";
import { pushActiveAgent } from "./adapters/claude-code/agent-runtime.js";
import { setEffectActive } from "./adapters/claude-code/effect-region.js";
import {
  formatTrackedLocalFiles,
  trackedLocalFiles,
} from "./local-files-tracked.js";

let dir: string;
beforeEach(() => {
  dir = makeTmpDir("local-files");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

const vigilesDir = (): string => join(dir, VIGILES_DIR);
const gitignore = (): string => join(vigilesDir(), ".gitignore");

function git(...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout };
}

/** Everything git would offer to commit under `.vigiles/`, one path per line. */
function statusUnderVigiles(): string[] {
  return git("status", "--porcelain", "--untracked-files=all")
    .stdout.split("\n")
    .filter((l) => l.includes(`${VIGILES_DIR}/`));
}

/**
 * Every per-checkout writer vigiles has, driven the way the runtime drives it —
 * one entry per {@link LOCAL_FILES} name, so each writer's OWN ensure call is
 * tested in isolation (run together, any one writer's ignore file hides a
 * sibling that forgot to call it).
 */
const WRITERS: Record<string, () => void> = {
  "coverage.json": () => {
    writeCoverageArtifact(dir, {
      v: COVERAGE_ARTIFACT_VERSION,
      generated: "2026-09-23T00:00:00.000Z",
      runs: [],
    });
  },
  "runs.jsonl": () => {
    appendObservation(
      { kind: "hook", event: "PreToolUse", decision: "allow" },
      dir,
    );
  },
  state: () => {
    writeHookState(".claude/hooks/nag.hook.ts", record("nag.spoke"), {
      cwd: dir,
    });
  },
  "active-skill.json": () => {
    setActiveSkill(dir, ".claude/skills/x/SKILL.md");
  },
  "active-agent.json": () => {
    pushActiveAgent(dir, ".claude/agents/y.md");
  },
  "effect-active.json": () => {
    setEffectActive(dir);
  },
  "guard-ledger.json": () => {
    recordGuardCall(dir, { tool: "Bash", input: { command: "ls" } });
  },
  "eval-cache": () => {
    writeCache(join(vigilesDir(), "eval-cache"), "a".repeat(16) as never, {
      out: {} as CacheRecord["out"],
      files: {},
    });
  },
  // The observe-mode record's writer is private to `hook-runtime.ts` and reached
  // only through a live `hook-runtime run-program` (`hook.test.ts`). Placed by
  // hand after the ensure call that writer makes, so what is under test is
  // git's view of the file, not the private writer.
  "hook-observations.jsonl": () => {
    ensureLocalFilesIgnored(vigilesDir());
    writeFileSync(join(vigilesDir(), "hook-observations.jsonl"), "{}\n");
  },
};

function writeEveryLocalFile(): void {
  for (const w of Object.values(WRITERS)) w();
}

describe("ensureLocalFilesIgnored", () => {
  test("creates the file with the header and every entry, including itself", () => {
    ensureLocalFilesIgnored(vigilesDir());
    const lines = readFileSync(gitignore(), "utf-8").split("\n");
    assert.deepEqual(lines.slice(0, LOCAL_GITIGNORE_HEADER.length), [
      ...LOCAL_GITIGNORE_HEADER,
    ]);
    for (const e of localIgnoreEntries()) assert.ok(lines.includes(e), e);
    assert.ok(lines.includes("/.gitignore"));
    for (const f of LOCAL_FILES) {
      assert.ok(
        localIgnoreEntries().includes(`/${f.name}${f.dir ? "/" : ""}`),
        f.name,
      );
    }
  });

  test("is idempotent: a second call leaves content AND mtime alone", () => {
    ensureLocalFilesIgnored(vigilesDir());
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(gitignore(), past, past);
    const before = readFileSync(gitignore(), "utf-8");
    ensureLocalFilesIgnored(vigilesDir());
    assert.equal(readFileSync(gitignore(), "utf-8"), before);
    assert.equal(statSync(gitignore()).mtimeMs, past.getTime());
  });

  test("keeps someone's own lines and appends only the missing entries", () => {
    mkdirSync(vigilesDir(), { recursive: true });
    const theirs = "# mine\n/scratch/\n/coverage.json"; // no trailing newline
    writeFileSync(gitignore(), theirs);
    ensureLocalFilesIgnored(vigilesDir());
    const after = readFileSync(gitignore(), "utf-8");
    assert.ok(after.startsWith(theirs + "\n"), after);
    const lines = after.split("\n");
    for (const e of localIgnoreEntries()) {
      assert.equal(lines.filter((l) => l === e).length, 1, e);
    }
    assert.ok(lines.includes("/scratch/"));
  });

  test("swallows an fs error: an unwritable location is not a failure", () => {
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    assert.doesNotThrow(() => {
      ensureLocalFilesIgnored(join(file, VIGILES_DIR));
    });
  });
});

describe("through git", () => {
  beforeEach(() => {
    initGitRepo(dir);
  });

  test("there is a writer case for every listed local file", () => {
    assert.deepEqual(
      Object.keys(WRITERS).sort(),
      LOCAL_FILES.map((f) => f.name).sort(),
    );
  });

  for (const [name, write] of Object.entries(WRITERS)) {
    test(`${name}: once written, git offers none of it — nor the ignore file`, () => {
      write();
      // A dead writer would pass the status check vacuously.
      assert.ok(existsSync(join(vigilesDir(), name)), `${name} written`);
      assert.deepEqual(statusUnderVigiles(), []);
    });
  }

  // Codex review on #274: presence was judged by TEXT (a trimmed set), so two
  // hand-edited files read as "entry present" while git still offered the file.
  for (const [label, content] of [
    ["a later !entry cancels the entry", "/coverage.json\n!/coverage.json\n"],
    ["a leading space makes a different pattern", " /coverage.json\n"],
  ] as const) {
    test(`a hand-edited ignore file is repaired when ${label}`, () => {
      mkdirSync(vigilesDir(), { recursive: true });
      writeFileSync(gitignore(), content);
      writeFileSync(join(vigilesDir(), "coverage.json"), "{}\n");
      const rel = `${VIGILES_DIR}/coverage.json`;
      // The premise: as written, git does NOT ignore it.
      assert.equal(git("check-ignore", "-q", rel).status, 1, "premise");
      ensureLocalFilesIgnored(vigilesDir());
      assert.equal(git("check-ignore", "-q", rel).status, 0, `${rel} ignored`);
      // And the owner's lines are still there, in their order.
      assert.ok(readFileSync(gitignore(), "utf-8").startsWith(content));
    });
  }

  test("committed .vigiles/ paths stay committable", () => {
    writeEveryLocalFile();
    const committed = [
      ".vigiles/hooks/nag.hook.ts",
      ".vigiles/hooks/nag.hook.ts.json",
      ".vigiles/hooks/state/x.json", // a same-named dir DEEPER must not be caught
      ".vigiles/eval-locks/x.lock.json",
      ".vigiles/generated.d.ts",
      ".vigiles/CLAUDE.md.inputs.json",
    ];
    for (const rel of committed) {
      mkdirSync(resolve(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "{}\n");
      // `check-ignore` exits 1 for "not ignored", 0 for ignored.
      assert.equal(
        git("check-ignore", "-q", "--no-index", rel).status,
        1,
        `${rel} must not be ignored`,
      );
    }
    assert.deepEqual(
      statusUnderVigiles()
        .map((l) => l.slice(3))
        .sort(),
      [...committed].sort(),
    );
  });
});

describe("the tracked-file warning", () => {
  beforeEach(() => {
    initGitRepo(dir);
  });

  test("names an already-tracked local file and how to untrack it", () => {
    writeEveryLocalFile();
    // What a consumer did before this fix: committed it on purpose or by `-f`.
    git("add", "-f", ".vigiles/coverage.json", ".vigiles/state");
    const tracked = trackedLocalFiles(dir);
    assert.ok(tracked.includes(".vigiles/coverage.json"), tracked.join());
    const line = formatTrackedLocalFiles(tracked);
    assert.ok(line);
    assert.match(line, /\.vigiles\/coverage\.json, \.vigiles\/state are/);
    assert.match(line, /does not untrack/);
    assert.match(line, /git rm -r --cached \.vigiles\/coverage\.json/);
    assert.equal(line.split("\n").length, 1);
  });

  test("is silent when nothing is tracked", () => {
    writeEveryLocalFile();
    assert.deepEqual(trackedLocalFiles(dir), []);
    assert.equal(formatTrackedLocalFiles([]), null);
  });

  test("is silent outside a git work tree", () => {
    const bare = makeTmpDir("local-files-nogit");
    try {
      assert.deepEqual(trackedLocalFiles(bare), []);
    } finally {
      cleanupTmpDir(bare);
    }
  });
});

// ---------------------------------------------------------------------------
// The list is complete — every `.vigiles/` path the source spells is classified
// ---------------------------------------------------------------------------

/**
 * Every path under `.vigiles/` that the source NAMES, by its first segment, with
 * where it was named. Read through the TypeScript AST, so a comment or a
 * docstring mentioning `.vigiles/foo` is not a path and is not counted.
 *
 * Two spellings are seen: a literal starting `.vigiles/` (`".vigiles/x.json"`,
 * a template head `` `.vigiles/hooks/${…}` ``), and a path-join argument list in
 * which `".vigiles"` or `VIGILES_DIR` is followed by a string literal
 * (`resolve(root, ".vigiles", "eval-cache")`). NOT seen: a path assembled from a
 * bare `.vigiles` directory in one statement and a literal in another, or a name
 * held in a local constant. That limit is why the writers import their names
 * from `local-files.ts` rather than spelling them.
 */
function namedVigilesPaths(): { seg: string; where: string }[] {
  const out: { seg: string; where: string }[] = [];
  const srcRoot = __dirname;
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts") &&
        p !== join(srcRoot, "local-files.ts")
      )
        files.push(p);
    }
  };
  walk(srcRoot);
  const prefix = `${VIGILES_DIR}/`;
  const textOf = (n: ts.Node): string | undefined => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return n.text;
    return ts.isTemplateExpression(n) ? n.head.text : undefined;
  };
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const at = (n: ts.Node): string =>
      `${relative(srcRoot, file)}:${String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)}`;
    const visit = (n: ts.Node): void => {
      const t = textOf(n);
      if (t?.startsWith(prefix)) {
        out.push({ seg: t.slice(prefix.length).split("/")[0], where: at(n) });
      }
      if (ts.isCallExpression(n)) {
        n.arguments.forEach((arg, i) => {
          const isDir =
            textOf(arg) === VIGILES_DIR ||
            (ts.isIdentifier(arg) && arg.text === "VIGILES_DIR");
          const next = n.arguments[i + 1];
          const nextText = next ? textOf(next) : undefined;
          if (isDir && nextText !== undefined) {
            out.push({ seg: nextText.split("/")[0], where: at(next) });
          }
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("the local-files list is complete", () => {
  test("every .vigiles/ path the source names is on a list — and a local one only by its constant", () => {
    const local = new Set(LOCAL_FILES.map((f) => f.name));
    const committed = new Set(COMMITTED_PATHS);
    const named = namedVigilesPaths();
    // Guard the guard: the scan must actually see the committed spellings that
    // exist today, or an empty scan would pass everything.
    assert.ok(
      named.some((n) => n.seg === "hooks"),
      "scan found no .vigiles/hooks — it is not reading the source",
    );
    const problems: string[] = [];
    for (const { seg, where } of named) {
      if (seg === "" || seg.includes("*")) continue; // the dir itself, a glob
      if (local.has(seg)) {
        problems.push(
          `${where}: spells local file "${seg}" — import its constant from local-files.ts`,
        );
      } else if (!committed.has(seg)) {
        problems.push(
          `${where}: ".vigiles/${seg}" is on neither list — classify it in src/local-files.ts ` +
            `(LOCAL_FILES if it describes this checkout, COMMITTED_PATHS if the project commits it)`,
        );
      }
    }
    assert.deepEqual(problems, []);
  });

  test("no name is on both lists", () => {
    const committed = new Set(COMMITTED_PATHS);
    assert.deepEqual(
      LOCAL_FILES.filter((f) => committed.has(f.name)).map((f) => f.name),
      [],
    );
  });
});
