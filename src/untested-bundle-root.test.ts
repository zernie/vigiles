/**
 * #281 — under `bundles: "all"`, a nested bundle's untested-surface check must
 * (1) resolve `include` from the directory that holds `.vigilesrc.json`, and
 * (2) print, and annotate, the finding at a path that exists from that directory.
 * Both halves: the centralized test credits the plugin skill, AND a plugin skill
 * with no test is still reported — at its repo-relative path.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { makeTmpDir, cleanupTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
let dir: string;

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}
const skillMd = (n: string): string =>
  `---\nname: ${n}\ndescription: Repro skill ${n}.\n---\nBody.\n`;

function lint(): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "true" };
  delete env.GITHUB_STEP_SUMMARY;
  try {
    return execFileSync("node", [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout ?? "";
  }
}
const annotated = (out: string): string[] =>
  [...out.matchAll(/^::(?:warning|error) file=([^:,]+)::skill /gm)].map(
    (m) => m[1],
  );

beforeEach(() => {
  dir = makeTmpDir();
  put(
    ".vigilesrc.json",
    JSON.stringify({
      bundles: "all",
      exclude: ["plugins/p/skills/vendored"],
      rules: {
        "untested-skill": [
          "warn",
          {
            include: [
              "tests/{surface}/evals/promptfooconfig*.yaml",
              "tests/*/{surface}/evals/promptfooconfig*.yaml",
            ],
          },
        ],
      },
    }),
  );
  put("skills/root-skill/SKILL.md", skillMd("root-skill"));
  put("plugins/p/.claude-plugin/plugin.json", JSON.stringify({ name: "p" }));
  put("plugins/p/skills/nested-skill/SKILL.md", skillMd("nested-skill"));
  put("plugins/p/skills/lonely/SKILL.md", skillMd("lonely"));
  put("plugins/p/skills/vendored/SKILL.md", skillMd("vendored"));
  put("tests/root-skill/evals/promptfooconfig.yaml", "x: 1\n");
  put("tests/p/nested-skill/evals/promptfooconfig.yaml", "x: 1\n");
});
afterEach(() => {
  cleanupTmpDir(dir);
});

test("a centralized suite at the repo root credits a NESTED bundle's skill (#281)", () => {
  const files = annotated(lint());
  assert.equal(
    files.some((f) => f.endsWith("nested-skill/SKILL.md")),
    false,
    `nested-skill has tests/p/nested-skill/evals/… and must be credited; got ${JSON.stringify(files)}`,
  );
});

test("an untested nested skill is annotated at a path that EXISTS from the repo root (#281)", () => {
  const files = annotated(lint());
  assert.deepEqual(files, ["plugins/p/skills/lonely/SKILL.md"]);
  for (const f of files)
    assert.ok(existsSync(join(dir, f)), `${f} does not exist`);
});

test("the repo-wide exclude reaches a nested bundle's untested walk (#281, same frame)", () => {
  const files = annotated(lint());
  assert.equal(
    files.some((f) => f.includes("vendored")),
    false,
    JSON.stringify(files),
  );
});

test("a ROOT-relative exclude does not alias into a nested bundle (#281, same frame)", () => {
  // `skills/lonely` names a path at the repo root, where nothing lives. Globbed
  // from inside `plugins/p` it would silently drop `plugins/p/skills/lonely`.
  put(
    ".vigilesrc.json",
    JSON.stringify({
      bundles: "all",
      exclude: ["plugins/p/skills/vendored", "skills/lonely"],
      rules: {
        "untested-skill": [
          "warn",
          {
            include: [
              "tests/*/{surface}/evals/promptfooconfig*.yaml",
              "tests/{surface}/evals/promptfooconfig*.yaml",
            ],
          },
        ],
      },
    }),
  );
  assert.deepEqual(annotated(lint()), ["plugins/p/skills/lonely/SKILL.md"]);
});
