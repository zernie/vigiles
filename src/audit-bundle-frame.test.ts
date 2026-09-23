/**
 * #281 (D7) — `vigiles audit <nested bundle>` must agree with itself about what
 * `.vigilesrc.json#exclude` removed, and must print adoption commands that run
 * from where the user stands.
 *
 * Measured on 2c0ada7 with this fixture (`audit plugins/p --json`):
 *
 *   inventory.skills   1    ← the excluded skill left out of the grade
 *   inventory.untested 2    ← …and counted as untested anyway
 *   adoptable          npx vigiles init --target=skills/vendored/SKILL.md
 *                           (excluded, AND a path that does not exist from cwd)
 *
 * The cause was one string list of root-relative patterns globbed from inside
 * the bundle, where `plugins/p/skills/vendored` matches nothing.
 */
import { afterEach, beforeEach, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupTmpDir, makeTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
let dir: string;

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}
const skillMd = (n: string): string =>
  `---\nname: ${n}\ndescription: Repro skill ${n}.\n---\nBody.\n`;

interface AuditJson {
  inventory: { skills: number; untested: number };
  adoptable?: { surfaces: { path: string; command: string }[] };
}

function audit(target: string): AuditJson {
  const out = execFileSync("node", [CLI, "audit", target, "--json"], {
    cwd: dir,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return JSON.parse(out) as AuditJson;
}

beforeEach(() => {
  dir = makeTmpDir("audit-bundle-frame");
  put(
    ".vigilesrc.json",
    JSON.stringify({ exclude: ["plugins/p/skills/vendored"] }),
  );
  put("plugins/p/.claude-plugin/plugin.json", JSON.stringify({ name: "p" }));
  put("plugins/p/skills/kept/SKILL.md", skillMd("kept"));
  put("plugins/p/skills/vendored/SKILL.md", skillMd("vendored"));
});
afterEach(() => {
  cleanupTmpDir(dir);
});

it("an excluded skill is neither graded NOR counted untested (one answer, not two)", () => {
  const r = audit("plugins/p");
  assert.equal(r.inventory.skills, 1);
  assert.equal(
    r.inventory.untested,
    1,
    "the untested walk must drop what the grade dropped",
  );
});

it("adoption paths and commands are in the repo frame, and skip the excluded skill", () => {
  const surfaces = audit("plugins/p").adoptable?.surfaces ?? [];
  assert.deepEqual(
    surfaces.map((s) => s.path),
    ["plugins/p/skills/kept/SKILL.md"],
  );
  for (const s of surfaces) {
    assert.ok(existsSync(join(dir, s.path)), `${s.path} missing from cwd`);
    assert.equal(s.command, `npx vigiles init --target=${s.path}`);
  }
});

it("the control: auditing the repo root itself is unchanged", () => {
  // With the target AT the root the two frames coincide, so nothing may move.
  put("skills/top/SKILL.md", skillMd("top"));
  const paths = (audit(".").adoptable?.surfaces ?? []).map((s) => s.path);
  assert.ok(paths.includes("skills/top/SKILL.md"), JSON.stringify(paths));
});
