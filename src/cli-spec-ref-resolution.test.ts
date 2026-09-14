/**
 * `require-instructions-spec` must not report a spec that is sitting right next
 * to the file it is checking.
 *
 * THE BUG THIS PREVENTS. `vigiles compile` stamps the spec path exactly as it
 * was typed on that invocation, so the `compiled from <path>` header is relative
 * to the COMPILER's cwd — an anchor the reader does not share. The validator
 * resolved it against the READER's cwd, which agrees only while both are the
 * same directory. They stop agreeing the moment a compiled instruction file is
 * consumed from elsewhere, which is what shipping skills inside a package does:
 * the publisher compiles from the package root and stamps
 * `skills/<name>/SKILL.md.spec.ts`; the consumer lints from its own root and is
 * told the spec "no longer exists" while it lies beside the very file under
 * test. Measured on a real consumer 2026-09-14: two false `error`s, and since
 * this rule can be gated, they failed that build.
 *
 * 🔴 THE BRANCH HAD NO TEST AT ALL before this file — `grep "but that spec"`
 * over `src/**\/*.test.ts` returned nothing. That is why a false positive of the
 * loudest severity could ship: nothing ever asserted what the message means.
 *
 * Both halves are here, per the house rule: it must stay QUIET when the spec is
 * reachable (either way) and it must still FIRE when the spec is genuinely gone.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const CLI = resolve(__dirname, "..", "dist", "cli.js");

// `lint .claude`, not `lint .`: the spec-ref validator runs over the instruction
// files under an EXPLICIT path. A bare `lint .` reports the corpus-level checks
// and never reaches this branch — measured while writing this file, and the
// reason the first draft of these assertions passed vacuously.

function lint(cwd: string, args = ".claude"): { out: string; code: number } {
  try {
    return {
      out: execSync(`node ${CLI} lint ${args}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      }),
      code: 0,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      out: (err.stdout ?? "") + (err.stderr ?? ""),
      code: err.status ?? 1,
    };
  }
}

/** A compiled skill whose header names `headerRef`, with an optional real spec beside it. */
function skill(
  root: string,
  name: string,
  headerRef: string,
  withSibling: boolean,
): void {
  const dir = join(root, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill for spec-ref resolution.\n---\n` +
      `<!-- vigiles:sha256:deadbeefdeadbeef compiled from ${headerRef} -->\n\n# ${name}\n\nBody.\n`,
  );
  if (withSibling) {
    writeFileSync(join(dir, "SKILL.md.spec.ts"), "export default {};\n");
  }
}

describe("require-instructions-spec resolves the compiled-from header", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-specref-"));
    writeFileSync(
      join(dir, ".vigilesrc.json"),
      JSON.stringify({ rules: { "require-instructions-spec": "error" } }),
    );
    // PACKAGE-SHAPED: header is relative to a root this consumer does not have
    // (`<cwd>/skills/packaged/...` does not exist), spec sits beside the file.
    skill(dir, "packaged", "skills/packaged/SKILL.md.spec.ts", true);
    // CONSUMER-SHAPED: header already resolves from cwd. The unchanged path.
    skill(dir, "local", ".claude/skills/local/SKILL.md.spec.ts", true);
    // GENUINELY GONE: neither cwd nor the sibling has it.
    skill(dir, "orphan", "skills/orphan/SKILL.md.spec.ts", false);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet when the header is package-root-relative but the spec is beside the file", () => {
    const { out } = lint(dir);
    assert.ok(
      !/packaged\/SKILL\.md references/.test(out),
      `the spec lies next to the file; the rule must not call it missing.\n${out}`,
    );
  });

  it("stays quiet on the ordinary cwd-relative header (no behaviour change)", () => {
    const { out } = lint(dir);
    assert.ok(
      !/local\/SKILL\.md references/.test(out),
      `an already-resolving header must keep resolving.\n${out}`,
    );
  });

  it("still FIRES when the spec is reachable from neither cwd nor the file's own directory", () => {
    const { out } = lint(dir);
    assert.match(
      out,
      /\[require-instructions-spec\] .*orphan\/SKILL\.md references "skills\/orphan\/SKILL\.md\.spec\.ts" but that spec no longer exists/,
      `a genuinely missing spec must still be reported — otherwise the fallback\n` +
        `turned a real finding into silence.\n${out}`,
    );
  });

  it("names BOTH places it looked, so the message is actionable", () => {
    const { out } = lint(dir);
    assert.match(out, /looked under .* and beside the file/, out);
  });
});
