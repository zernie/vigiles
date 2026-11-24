/**
 * `spec-refs` on the surfaces that are NOT `claude` (#190).
 *
 * The rule re-derives a compiled file's references from its spec and validates
 * them the way `compile` does. It used to call `compileClaude` directly and skip
 * every other spec type, so a SKILL.md / subagent / railway artifact committed
 * while its refs were live stayed green forever after the target was deleted:
 * `lint` reported `hash valid` (the artifact DOES match its own header — that is
 * the wrong question) while `compile` reported the broken ref.
 *
 * Measured on this repo when the gap was found: `examples/SKILL.md.spec.ts` named
 * `skills/enforce-rules-format/SKILL.md`, which does not exist, and `lint` was
 * green on it.
 *
 * The fixture reproduces the ORDER that makes it a lint question rather than a
 * compile one — compile while the ref resolves, THEN delete the target. A test
 * that merely wrote a broken spec would be caught by `compile` and prove nothing
 * about `lint`.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;

const run = (args: string[]) =>
  spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-spec-refs-surfaces-"));
  writeFileSync(join(dir, "TARGET.md"), "# the file the skill points at\n");
  writeFileSync(
    join(dir, "SKILL.md.spec.ts"),
    [
      `import { experimental_skill, file, prose } from ${JSON.stringify(resolve(import.meta.dirname, "core", "spec.js"))};`,
      "export default experimental_skill({",
      '  name: "fixture",',
      '  description: "A fixture skill whose one reference is about to die",',
      '  body: prose`See ${file("TARGET.md")} for the format.`,',
      "});",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("spec-refs reaches non-claude surfaces", () => {
  it("compiles clean while the ref resolves", () => {
    const r = run(["compile"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(dir, "SKILL.md")), "SKILL.md was not written");
  });

  it("lint FLAGS the skill once its target is deleted", () => {
    // The artifact still matches its own hash — integrity has nothing to say.
    // Only re-deriving the refs from the spec can see this.
    rmSync(join(dir, "TARGET.md"));
    const r = run(["lint"]);
    const out = r.stdout + r.stderr;
    assert.match(out, /Spec reference check/, out);
    assert.match(out, /TARGET\.md/, out);
  });
});
