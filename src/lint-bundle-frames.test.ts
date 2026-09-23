/**
 * #281 — under `bundles: "all"`, every path `vigiles lint` PRINTS or ANNOTATES
 * is relative to the repo root, whichever bundle the finding came from.
 *
 * The same defects are planted in the root bundle (names ending `-r`) and in a
 * nested bundle `plugins/p` (names ending `-n`), with every per-bundle rule on,
 * and the built CLI runs with annotations enabled. Before the fix, 11 of the 21
 * bundle-iterated checks annotated a nested finding as `file=skills/x-n/…` — a
 * file that does not exist from the repo root — and the hook checks printed an
 * absolute machine path.
 *
 * Three properties, each with its planted-defect proof recorded beside it:
 *   1. every `file=` names a file that EXISTS from the repo root (a check that
 *      annotates in its bundle's frame, or with an absolute path, fails here);
 *   2. every nested finding is annotated UNDER `plugins/p/` — including a skill
 *      whose name the root bundle shares, where the wrong frame lands on the
 *      root's real file and property 1 alone stays green;
 *   3. a finding with no file names its bundle, so two identical messages from
 *      two bundles can be told apart.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupTmpDir, makeTmpDir } from "./core/test-utils.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

const RULES = [
  "delegation-trifecta",
  "description-overlap",
  "disallowed-tools-contract",
  "frontmatter-valid",
  "hook-block-ineffective",
  "hook-events",
  "hook-matcher",
  "hook-script-exists",
  "lethal-trifecta",
  "mcp-config",
  "mcp-hook-target-resolves",
  "mcp-tool-resolves",
  "plugin-dir-layout",
  "prefer-compiled-hooks",
  "skill-description-budget",
  "skill-frontmatter",
  "skill-missing-fence",
  "skill-resource-resolves",
  "subagent-frontmatter",
  "subagent-tool-contract",
  "untested-skill",
  "untested-subagent",
  "untested-hook",
];

let dir: string;
let out: string;

function put(rel: string, body: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** The same defects, once per bundle; `at` is the bundle dir, `s` the suffix. */
function plant(at: string, s: string): void {
  const p = (rel: string): string => (at ? `${at}/${rel}` : rel);
  const hooks = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bsh",
          hooks: [
            {
              type: "command",
              command: `\${CLAUDE_PLUGIN_ROOT}/hooks/missing-${s}.sh`,
            },
          ],
        },
      ],
      PreToolUs: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  });
  put(p("hooks/hooks.json"), hooks);
  put(p(".mcp.json"), JSON.stringify({ mcpServers: { [`broken-${s}`]: {} } }));
  put(
    p(`agents/bad-agent-${s}.md`),
    `---\nname: bad-agent-${s}\ndescription: An agent.\ntools: Bsh, Reed\nmodel: sonet\n---\nbody\n`,
  );
  put(p(`agents/nofm-${s}.md`), `---\nname: nofm-${s}\n---\nbody\n`);
  put(
    p(`skills/badyaml-${s}/SKILL.md`),
    `---\nname: badyaml-${s}\ndescription: [unclosed\n---\nbody\n`,
  );
  put(
    p(`skills/longdesc-${s}/SKILL.md`),
    `---\nname: longdesc-${s}\ndescription: ${"word ".repeat(150)}\n---\nbody\n`,
  );
  put(
    p(`skills/nofence-${s}/SKILL.md`),
    `name: nofence-${s}\ndescription: no fence here\n\nbody\n`,
  );
  put(
    p(`skills/res-skill-${s}/SKILL.md`),
    `---\nname: res-skill-${s}\ndescription: Uses a script ${s}.\n---\nRun \`scripts/missing.sh\` to go.\n`,
  );
  // The SAME name in both bundles: the case where an annotation in the wrong
  // frame lands on the root's REAL file and nothing looks broken.
  put(p("skills/dup/SKILL.md"), "name: dup\ndescription: no fence\n\nbody\n");
  put(
    p(`.claude-plugin/skills/inside-${s}/SKILL.md`),
    `---\nname: inside\ndescription: hidden\n---\n`,
  );
}

/** `::warning file=X::msg` → `{ file, msg }`; `::warning::msg` → no file. */
function annotations(): { file?: string; msg: string }[] {
  return [
    ...out.matchAll(/^::(?:warning|error)(?: file=([^:,]+))?::(.*)$/gm),
  ].map((m) => ({ file: m[1], msg: m[2] ?? "" }));
}

beforeAll(() => {
  dir = makeTmpDir("lint-bundle-frames");
  put(
    ".vigilesrc.json",
    JSON.stringify({
      bundles: "all",
      rules: Object.fromEntries(RULES.map((r) => [r, "warn"])),
    }),
  );
  put("plugins/p/.claude-plugin/plugin.json", JSON.stringify({ name: "p" }));
  plant("", "r");
  plant("plugins/p", "n");
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "true" };
  delete env.GITHUB_STEP_SUMMARY;
  try {
    out = execFileSync("node", [CLI, "lint"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
});
afterAll(() => {
  cleanupTmpDir(dir);
});

describe("lint under bundles: all — one frame for every printed path (#281)", () => {
  it("the fixture actually produced findings in BOTH bundles", () => {
    // Guards the assertions below against passing on an empty run.
    const files = annotations().flatMap((a) => (a.file ? [a.file] : []));
    assert.ok(
      files.some((f) => f.includes("-r")),
      out,
    );
    assert.ok(
      files.some((f) => f.includes("-n")),
      out,
    );
  });

  it("every file= names a file that exists from the repo root, and none is absolute", () => {
    for (const { file } of annotations()) {
      if (file === undefined) continue;
      assert.ok(!file.startsWith("/"), `absolute file=: ${file}`);
      assert.ok(
        existsSync(join(dir, file)),
        `${file} does not exist from the repo root`,
      );
    }
    assert.ok(!out.includes(dir), "a machine path leaked into the output");
  });

  it("every nested finding is annotated under plugins/p/, never in the root's frame", () => {
    const nested = annotations().filter((a) => a.file?.includes("-n"));
    assert.ok(nested.length >= 8, `only ${String(nested.length)}: ${out}`);
    for (const { file } of nested)
      assert.ok(
        file?.startsWith("plugins/p/"),
        `root frame for ${String(file)}`,
      );
  });

  it("a skill name both bundles share is annotated once at EACH real path", () => {
    // The silent form of the bug: in the root's frame the nested finding reads
    // `file=skills/dup/SKILL.md`, which exists — so the property above sees no
    // `-n` and the one before it sees a real file. Only a count per path tells.
    const fence = annotations()
      .filter((a) => a.msg.startsWith("dup: SKILL.md is missing"))
      .map((a) => a.file)
      .sort();
    assert.deepEqual(fence, [
      "plugins/p/skills/dup/SKILL.md",
      "skills/dup/SKILL.md",
    ]);
  });

  it("a finding with no file names its bundle, so the two bundles' copies differ", () => {
    const bare = annotations().filter((a) => a.file === undefined);
    const hookEvent = bare.filter((a) => a.msg.includes('"PreToolUs"'));
    assert.equal(hookEvent.length, 2, out);
    assert.notEqual(hookEvent[0]?.msg, hookEvent[1]?.msg);
    assert.ok(
      hookEvent.some((a) => a.msg.startsWith("[plugins/p] ")),
      JSON.stringify(hookEvent),
    );
    // The lint target itself is never labelled — output for the common case,
    // one bundle, is byte-identical to what it was.
    assert.ok(hookEvent.some((a) => !a.msg.startsWith("[")));
  });

  it("the hook-script finding prints the script in the repo frame, not as a machine path", () => {
    const missing = annotations().filter((a) => a.msg.includes("hook script"));
    assert.deepEqual(
      missing.map((a) => a.msg.slice(0, a.msg.indexOf(" is referenced"))),
      [
        'hook script "hooks/missing-r.sh"',
        '[plugins/p] hook script "plugins/p/hooks/missing-n.sh"',
      ],
    );
  });
});
