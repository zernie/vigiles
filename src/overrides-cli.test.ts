/**
 * `.vigilesrc.json#overrides` through the REAL built CLI (`node dist/cli.js
 * lint`), in both directions: a folder an override turns a rule off for
 * produces no finding, while a sibling folder still does.
 *
 * Three rules: `require-instructions-spec` (the case the override exists for —
 * a repo that keeps some instruction files hand-written on purpose), and the two
 * whose own `exclude` option the override replaced (`untested-*`,
 * `orphan-docs`), each asserting the override does what the removed option did.
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { handWrittenInstructionRemedy } from "./core/instruction-remedies.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
const dirs: string[] = [];

afterEach(() => {
  dirs.splice(0).forEach((d) => {
    rmSync(d, { recursive: true, force: true });
  });
});

/** A scratch repo with these files, `.vigilesrc.json` serialized from `config`. */
function repo(
  config: unknown,
  files: Readonly<Record<string, string>>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-overrides-e2e-"));
  dirs.push(dir);
  const all = { ".vigilesrc.json": JSON.stringify(config), ...files };
  Object.entries(all).forEach(([rel, text]) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  });
  return dir;
}

/** `vigiles lint` in `cwd`: combined output and exit code. */
function lint(cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, "lint"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { out, code: 0 };
  } catch (e: unknown) {
    const field = (k: string): unknown =>
      typeof e === "object" && e !== null && k in e
        ? Reflect.get(e, k)
        : undefined;
    const text = (k: string): string => {
      const v = field(k);
      return typeof v === "string" ? v : "";
    };
    const status = field("status");
    return {
      out: `${text("stdout")}${text("stderr")}`,
      code: typeof status === "number" ? status : 1,
    };
  }
}

const HAND = "# Notes\n\nHand-written on purpose.\n";

describe("require-instructions-spec under vigiles:recommended", () => {
  it("an overridden folder has no finding; a sibling folder still errors, saying what to do", () => {
    const dir = repo(
      {
        extends: "vigiles:recommended",
        overrides: [
          {
            files: ["notes/**"],
            rules: { "require-instructions-spec": "off" },
          },
        ],
      },
      { "notes/CLAUDE.md": HAND, "pkg/CLAUDE.md": HAND },
    );
    const r = lint(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(
      r.out,
      /✗ \[require-instructions-spec\] No spec file found for "pkg\/CLAUDE\.md"/,
    );
    assert.doesNotMatch(r.out, /No spec file found for "notes\/CLAUDE\.md"/);
    assert.ok(
      r.out.includes(handWrittenInstructionRemedy("pkg/CLAUDE.md")),
      r.out,
    );
  });

  it("with every hand-written folder overridden, lint is clean of it", () => {
    const dir = repo(
      {
        extends: "vigiles:recommended",
        overrides: [
          {
            files: ["notes", "pkg"],
            rules: { "require-instructions-spec": "off" },
          },
        ],
      },
      { "notes/CLAUDE.md": HAND, "pkg/CLAUDE.md": HAND },
    );
    const r = lint(dir);
    assert.doesNotMatch(r.out, /\[require-instructions-spec\]/);
  });
});

const SKILL = (name: string): string =>
  `---\nname: ${name}\ndescription: Does the ${name} thing for the tests here\n---\nBody.\n`;

describe("an override reproduces each removed per-rule `exclude`", () => {
  it("untested-*: a folder turned off is not reported; its sibling is", () => {
    const dir = repo(
      {
        rules: { "untested-skill": "warn" },
        overrides: [
          { files: ["skills/legacy/**"], rules: { "untested-skill": "off" } },
        ],
      },
      {
        "skills/legacy/SKILL.md": SKILL("legacy"),
        "skills/live/SKILL.md": SKILL("live"),
      },
    );
    const r = lint(dir);
    assert.match(r.out, /skill skills\/live\/SKILL\.md/);
    assert.doesNotMatch(r.out, /skill skills\/legacy\/SKILL\.md/);
  });

  it("orphan-docs: a folder turned off is not reported; its sibling is", () => {
    const dir = repo(
      {
        rules: { "orphan-docs": "warn" },
        orphans: { include: ["docs/**/*.md"] },
        overrides: [
          { files: ["docs/archive/**"], rules: { "orphan-docs": "off" } },
        ],
      },
      {
        "README.md": "# r\n",
        "docs/lonely.md": "# lonely\n",
        "docs/archive/old.md": "# old\n",
      },
    );
    const r = lint(dir);
    assert.match(r.out, /docs\/lonely\.md/);
    assert.doesNotMatch(r.out, /docs\/archive\/old\.md/);
  });
});
