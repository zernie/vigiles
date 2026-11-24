/**
 * Dogfood — conformance over vigiles's OWN shipped skills (`.claude-plugin/`).
 *
 * The second pillar says "test the harness as the assembled machine it ships as."
 * This points that at us: `loadPlugin` parses our real plugin manifest and
 * materializes every `skills/<name>/SKILL.md`, and we assert the invariants a
 * skill must satisfy to be activatable — it loads, it has a `name`, and it has a
 * non-empty `description` (the surface the model triggers on). Model-free and
 * in-gate (no `claude`, no key), so it runs on every commit.
 *
 * What this tier CANNOT do: prove a description actually *fires* — that's a model
 * decision, the eval tier (`measureTriggerRate`), which needs model auth. The
 * ready-to-run per-skill trigger/outcome evals live under
 * `examples/harness/dogfood/` and are exercised where a key exists. This gate is
 * the free floor: a skill that won't even load can never trigger.
 *
 * Invariants, not trivia: we check "every shipped skill loads with a usable
 * description", not "exactly N skills" (which would break on a harmless add).
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPlugin } from "./plugin-loader.js";
import { SHIPPED_SKILLS } from "../../setup-plan.js";

// __dirname is dist/ at runtime; the plugin manifest lives at the repo root.
const ROOT = join(import.meta.dirname, "..", "..", "..");

/** name + description from a SKILL.md YAML frontmatter block (the trigger surface). */
function parseFrontmatter(md: string): {
  name?: string;
  description?: string;
} {
  // Tolerate a leading compiled-by comment (`<!-- vigiles:sha256 … -->`) before
  // the `---` block — compiled skills carry it; hand-written ones start at `---`.
  const m = /(?:^|\n)---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  return { name, description };
}

const skillEntries = (files: Record<string, string>): [string, string][] =>
  Object.entries(files).filter(([f]) => /skills\/.*\/SKILL\.md$/.test(f));

test("vigiles plugin: loadPlugin materializes every shipped skill", () => {
  const loaded = loadPlugin(ROOT);
  const skills = skillEntries(loaded.files);

  // every skills/<name>/ directory that actually IS a skill (has a SKILL.md;
  // skills/linter-docs/ is a reference-doc dir, not a skill) shows up
  // materialized — no skill silently dropped by a bad manifest path.
  //
  // This repo is itself the two-scope shape (shipped `skills/` + a large local
  // `.claude/skills/`), which the loader used to read as ONE. So the assertion is
  // per-scope: every shipped skill under its own key, every dev skill under
  // `.claude/`, and NEITHER count standing in for the other.
  const shippedNames = readdirSync(join(ROOT, "skills"), {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(ROOT, "skills", d.name, "SKILL.md")))
    .map((d) => d.name);
  assert.ok(shippedNames.length > 0, "repo ships at least one skill");
  for (const name of shippedNames) {
    assert.ok(
      loaded.files[`skills/${name}/SKILL.md`] !== undefined,
      `shipped skill ${name} materializes under its own repo-relative key`,
    );
  }
  const devNames = existsSync(join(ROOT, ".claude", "skills"))
    ? readdirSync(join(ROOT, ".claude", "skills"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .filter((d) =>
          existsSync(join(ROOT, ".claude", "skills", d.name, "SKILL.md")),
        )
        .map((d) => d.name)
    : [];
  for (const name of devNames) {
    assert.ok(
      loaded.files[join(".claude", "skills", name, "SKILL.md")] !== undefined,
      `project skill ${name} is materialized, not shadowed by the shipped scope`,
    );
  }
  assert.equal(
    skills.length,
    shippedNames.length + devNames.length,
    `expected ${String(shippedNames.length)} shipped + ${String(devNames.length)} project skills, got ${String(skills.length)}`,
  );

  // ${CLAUDE_PLUGIN_ROOT} must be expanded in the loaded settings (a skill/hook
  // shipping an unresolved placeholder would silently never run).
  assert.ok(
    !JSON.stringify(loaded.settings).includes("${CLAUDE_PLUGIN_ROOT}"),
    "no unresolved ${CLAUDE_PLUGIN_ROOT} placeholder",
  );
});

test("vigiles plugin: every hook command's ${CLAUDE_PLUGIN_ROOT} script exists", () => {
  // The bug this guards: a hook command resolves a script at
  // ${CLAUDE_PLUGIN_ROOT}/hooks/x.sh, but the script lives elsewhere (e.g. under
  // .claude-plugin/) — so the hook silently never runs once installed. Component
  // dirs (hooks/, skills/, …) must sit at the plugin ROOT, not inside
  // .claude-plugin/ (Claude Code plugins-reference). Parse the real manifest and
  // assert every referenced script is actually there. `loadPlugin`'s dangling-ref
  // scan does NOT cover plugin.json command paths, so this is the precise check.
  const manifest = readFileSync(
    join(ROOT, ".claude-plugin/plugin.json"),
    "utf-8",
  );
  const refs = [
    ...manifest.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)["\s]/g),
  ].map((m) => m[1]);
  assert.ok(refs.length > 0, "expected the plugin to declare hook scripts");
  for (const rel of refs) {
    assert.ok(
      existsSync(join(ROOT, rel)),
      `plugin.json references \${CLAUDE_PLUGIN_ROOT}/${rel} but ${rel} does not exist at the plugin root`,
    );
  }
});

test("SHIPPED_SKILLS matches the skills/ dir (Codex install scope stays honest)", () => {
  // #dogfood-I2: the Codex install scopes to SHIPPED_SKILLS with `-s`. If that
  // list drifts from what actually ships under skills/, a user either misses a
  // real skill or (worse) we re-leak a contributor skill. Keep them in lockstep.
  const onDisk = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(ROOT, "skills", d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
  assert.deepEqual(
    [...SHIPPED_SKILLS].sort(),
    onDisk,
    "SHIPPED_SKILLS (setup-plan.ts) must match the skills/ dirs that ship a SKILL.md",
  );
});

test("vigiles marketplace.json declares owner (Claude Code v2.1.x requires it)", () => {
  // Regression for #108: CC >= v2.1.x's marketplace schema requires a top-level
  // `owner` object ({ name, url? }). Without it `claude plugin marketplace add
  // zernie/vigiles` throws "owner: expected object, received undefined" and the
  // whole plugin install (skills + hooks) fails for anyone on a recent CC — so
  // `init`'s plugin step silently never completes. Our own inspectMarketplace is
  // lax about it, so this is the guard that keeps the shipped manifest installable.
  const market = JSON.parse(
    readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf-8"),
  ) as { owner?: { name?: unknown } };
  assert.ok(
    market.owner &&
      typeof market.owner.name === "string" &&
      market.owner.name.length > 0,
    "marketplace.json must declare owner.name (required by Claude Code v2.1.x)",
  );
});

test("vigiles plugin: every skill has a name and a non-empty description", () => {
  // The description is what the model triggers on — an empty one is a skill that
  // can never fire. This is the cheap floor under the (paid) trigger-rate eval.
  const loaded = loadPlugin(ROOT);
  for (const [path, md] of skillEntries(loaded.files)) {
    const { name, description } = parseFrontmatter(md);
    assert.ok(name && name.length > 0, `${path}: missing frontmatter name`);
    assert.ok(
      description && description.length >= 20,
      `${path}: missing/too-short description (the trigger surface)`,
    );
  }
});
