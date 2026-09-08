/**
 * Scaffold-test engine suite (vitest): each kind (hook/skill/agent) yields the right colocated path + tier + public import + core call + the surface's metadata (namespaced id, declared tools, the user-invoked caveat, the <plugin> fallback), formatScaffolds empty-vs-listed, AND a node --check syntax-validity gate over every generated template (a template typo can't ship a broken scaffold)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldTest,
  formatScaffolds,
  type ScaffoldInput,
} from "./scaffold-test.js";

/** Assert generated content is syntactically valid JS (node --check, parse only). */
function assertValidJs(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
  try {
    const file = join(dir, "gen.mjs");
    writeFileSync(file, content);
    // Throws (non-zero exit) on a syntax error; resolves imports lazily, so the
    // unresolvable `vigiles/*` specifiers don't matter for a parse-only check.
    execFileSync("node", ["--check", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scaffoldTest — hook (unit tier)", () => {
  const input: ScaffoldInput = {
    kind: "hook",
    name: "pre-edit",
    path: "hooks/pre-edit.sh",
    hookCommand: "bash hooks/pre-edit.sh",
  };

  it("emits a .harness.mjs at the colocated path, unit tier", () => {
    const s = scaffoldTest(input);
    expect(s.path).toBe("hooks/pre-edit.harness.mjs");
    expect(s.tier).toBe("unit");
    expect(s.kind).toBe("hook");
  });

  it("wires runHook from the vigiles root + the hook command", () => {
    const { content } = scaffoldTest(input);
    expect(content).toContain('from "vigiles"');
    expect(content).toContain("runHook(");
    expect(content).toContain('"bash hooks/pre-edit.sh"');
    expect(content).toContain("assertHookAllowed");
  });

  it("defaults the command to `bash <path>` when none is given", () => {
    const { content } = scaffoldTest({ ...input, hookCommand: undefined });
    expect(content).toContain('"bash hooks/pre-edit.sh"');
  });

  it("produces syntactically valid JS", () => {
    assertValidJs(scaffoldTest(input).content);
  });
});

describe("scaffoldTest — skill (eval tier)", () => {
  const input: ScaffoldInput = {
    kind: "skill",
    name: "strengthen",
    path: "skills/strengthen/SKILL.md",
    pluginName: "vigiles",
  };

  it("emits an .eval.mjs at the colocated path, eval tier", () => {
    const s = scaffoldTest(input);
    expect(s.path).toBe("skills/strengthen/strengthen.eval.mjs");
    expect(s.tier).toBe("eval");
  });

  it("wires measureTriggerRate + the namespaced id + the precision gate", () => {
    const { content } = scaffoldTest(input);
    expect(content).toContain('from "vigiles/eval"');
    expect(content).toContain("paid_measureTriggerRate(");
    expect(content).toContain('"vigiles:strengthen"');
    expect(content).toContain("irrelevantPrompts");
    expect(content).toContain("assertTriggerRate(report, { min: 0.8");
  });

  it("falls back to a <plugin> placeholder when the plugin name is unknown", () => {
    const { content } = scaffoldTest({ ...input, pluginName: undefined });
    expect(content).toContain('"<plugin>:strengthen"');
  });

  it("notes the caveat for a user-invoked skill", () => {
    const plain = scaffoldTest(input).content;
    const userInvoked = scaffoldTest({ ...input, userInvoked: true }).content;
    expect(plain).not.toContain("user-invoked");
    expect(userInvoked).toContain("user-invoked");
  });

  it("produces syntactically valid JS", () => {
    assertValidJs(scaffoldTest(input).content);
    assertValidJs(scaffoldTest({ ...input, userInvoked: true }).content);
  });
});

describe("scaffoldTest — agent (harness tier)", () => {
  const input: ScaffoldInput = {
    kind: "agent",
    name: "reviewer",
    path: "agents/reviewer.md",
    tools: ["Read", "Grep"],
  };

  it("emits a .harness.mjs, harness tier", () => {
    const s = scaffoldTest(input);
    expect(s.path).toBe("agents/reviewer.harness.mjs");
    expect(s.tier).toBe("harness");
  });

  it("asserts the declared tool contract when tools are known", () => {
    const { content } = scaffoldTest(input);
    expect(content).toContain("runHarnessTest(");
    expect(content).toContain('assertToolUsed(r, "Read")');
    expect(content).toContain("Read, Grep");
  });

  it("falls back to asserting Task dispatch when tools are absent", () => {
    const { content } = scaffoldTest({ ...input, tools: null });
    expect(content).toContain('assertToolUsed(r, "Task")');
  });

  it("produces syntactically valid JS", () => {
    assertValidJs(scaffoldTest(input).content);
    assertValidJs(scaffoldTest({ ...input, tools: null }).content);
  });
});

describe("scaffoldTest — agent with a typed contract (the typed-spec payoff)", () => {
  const withContract: ScaffoldInput = {
    kind: "agent",
    name: "reviewer",
    path: "agents/reviewer.md",
    tools: ["Read", "Grep", "Bash"],
    sideEffectingTools: ["Bash"],
    resultContract: {
      ok: [{ name: "summary", type: "string" }],
      err: [
        { name: "findings", type: "string[]" },
        { name: "blocking", type: "boolean" },
      ],
    },
  };

  it("generates an assertAgentOk outcome test from the result() contract", () => {
    const { content } = scaffoldTest(withContract);
    expect(content).toContain(
      'import { experimental_agent } from "vigiles/spec"',
    );
    expect(content).toContain("assertAgentOk(okOutput, contract)");
    // the contract is reconstructed with the REAL parsed fields
    expect(content).toContain('{ summary: "string" }');
    expect(content).toContain('{ findings: "string[]", blocking: "boolean" }');
    // no LLM judge — the whole point
    expect(content).not.toContain("judged(");
  });

  it("generates a safety check from the side-effecting tools contract", () => {
    const { content } = scaffoldTest(withContract);
    expect(content).toContain("assertChecks(");
    expect(content).toContain(
      'notTool("Bash", { command: /git push|rm -rf/ })',
    );
    expect(content).toContain("side-effecting tools: Bash");
  });

  it("derives didNotWrite from a Write/Edit contract", () => {
    const { content } = scaffoldTest({
      ...withContract,
      sideEffectingTools: ["Write"],
    });
    expect(content).toContain('didNotWrite("secrets.env")');
  });

  it("omits the safety block when no tools are side-effecting", () => {
    const { content } = scaffoldTest({
      ...withContract,
      sideEffectingTools: [],
    });
    expect(content).not.toContain("Safety (deterministic)");
    expect(content).not.toContain("assertChecks(");
  });

  it("produces syntactically valid JS for the contract + safety paths", () => {
    assertValidJs(scaffoldTest(withContract).content);
    assertValidJs(
      scaffoldTest({ ...withContract, sideEffectingTools: ["Write"] }).content,
    );
  });
});

describe("formatScaffolds", () => {
  it("reports the empty case honestly", () => {
    expect(formatScaffolds([])).toContain("Nothing to scaffold");
  });

  it("lists each path with its kind + tier", () => {
    const out = formatScaffolds([
      scaffoldTest({ kind: "hook", name: "h", path: "hooks/h.sh" }),
      scaffoldTest({ kind: "skill", name: "s", path: "skills/s/SKILL.md" }),
    ]);
    expect(out).toContain("hooks/h.harness.mjs");
    expect(out).toContain("skills/s/s.eval.mjs");
    expect(out).toContain("hook → unit");
    expect(out).toContain("skill → eval");
  });
});
