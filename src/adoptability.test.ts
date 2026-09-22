/**
 * Adoptability-preview suite (vitest, no model): the deterministic "disposes" half
 * is proven against real tmp fixtures (file/cmd/dir refs resolve or break), the
 * tolerant draft parser handles bare/fenced/prose/malformed output, and the
 * load-bearing property — a hallucinated rule from the model is VERIFIED as broken,
 * never trusted as a pass — is asserted via a fake drafter (the LLM-proposes seam).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyDraftedRefs,
  parseDraftJson,
  runAdoptabilityTier,
  formatAdoptability,
  draftWith,
  DraftRunFailed,
  type DraftedRef,
} from "./adoptability.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vigiles-adopt-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
  );
  writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "src"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyDraftedRefs (the deterministic verdict)", () => {
  it("resolves a real file / script / dir (not broken)", () => {
    const refs: DraftedRef[] = [
      { kind: "file", ref: "real.ts" },
      { kind: "cmd", ref: "npm run build" },
      { kind: "dir", ref: "src" },
    ];
    const r = verifyDraftedRefs(refs, dir);
    expect(r.total).toBe(3);
    expect(r.broken).toBe(0);
    expect(r.brokenRefs).toEqual([]);
  });

  it("flags a missing file / script / dir as broken right now", () => {
    const refs: DraftedRef[] = [
      { kind: "file", ref: "nope.ts" },
      { kind: "cmd", ref: "npm run nonexistent" },
      { kind: "dir", ref: "missing-dir" },
    ];
    const r = verifyDraftedRefs(refs, dir);
    expect(r.total).toBe(3);
    expect(r.broken).toBe(3);
    expect(r.brokenRefs.map((b) => b.ref).sort()).toEqual([
      "missing-dir",
      "nope.ts",
      "npm run nonexistent",
    ]);
  });

  it("a hallucinated linter rule is verified as broken, never trusted (the load-bearing property)", () => {
    const refs: DraftedRef[] = [
      { kind: "enforce", ref: "madeuplinter/totally-fake-rule-xyz" },
    ];
    const r = verifyDraftedRefs(refs, dir);
    expect(r.broken).toBe(1);
    expect(r.brokenRefs[0].kind).toBe("enforce");
  });

  it("dedupes identical (kind, ref) pairs so total counts distinct refs", () => {
    const refs: DraftedRef[] = [
      { kind: "file", ref: "real.ts" },
      { kind: "file", ref: "real.ts" },
      { kind: "cmd", ref: "npm run build" },
    ];
    const r = verifyDraftedRefs(refs, dir);
    expect(r.total).toBe(2);
  });

  it("mixes resolved and broken into the right counts", () => {
    const refs: DraftedRef[] = [
      { kind: "file", ref: "real.ts" }, // ok
      { kind: "file", ref: "ghost.ts" }, // broken
      { kind: "dir", ref: "src" }, // ok
    ];
    const r = verifyDraftedRefs(refs, dir);
    expect(r.total).toBe(3);
    expect(r.broken).toBe(1);
    expect(r.brokenRefs[0].ref).toBe("ghost.ts");
  });
});

describe("parseDraftJson (tolerant)", () => {
  it("parses a bare JSON array", () => {
    expect(
      parseDraftJson(
        '[{"kind":"file","ref":"a.ts"},{"kind":"cmd","ref":"npm test"}]',
      ),
    ).toEqual([
      { kind: "file", ref: "a.ts" },
      { kind: "cmd", ref: "npm test" },
    ]);
  });

  it("extracts a fenced / prose-wrapped array", () => {
    const text =
      'Here are the refs:\n```json\n[{"kind":"dir","ref":"src"}]\n```\nDone.';
    expect(parseDraftJson(text)).toEqual([{ kind: "dir", ref: "src" }]);
  });

  it("returns [] on malformed JSON or no array", () => {
    expect(parseDraftJson("not json at all")).toEqual([]);
    expect(parseDraftJson("[ broken ")).toEqual([]);
    expect(parseDraftJson('{"kind":"file","ref":"a.ts"}')).toEqual([]); // object, not array
  });

  it("drops entries with an unknown kind or non-string ref", () => {
    const text =
      '[{"kind":"file","ref":"a.ts"},{"kind":"bogus","ref":"b"},{"kind":"cmd","ref":123},{"kind":"dir"}]';
    expect(parseDraftJson(text)).toEqual([{ kind: "file", ref: "a.ts" }]);
  });

  it("trims refs and drops empty ones", () => {
    expect(
      parseDraftJson(
        '[{"kind":"file","ref":"  a.ts  "},{"kind":"file","ref":"   "}]',
      ),
    ).toEqual([{ kind: "file", ref: "a.ts" }]);
  });
});

describe("runAdoptabilityTier (compose with an injected drafter)", () => {
  it("drafts (fake) then verifies deterministically", async () => {
    const fakeDraft = () =>
      Promise.resolve<DraftedRef[]>([
        { kind: "file", ref: "real.ts" }, // resolves
        { kind: "cmd", ref: "npm run ghost" }, // broken
      ]);
    const r = await runAdoptabilityTier({
      instructionContent: "# anything",
      basePath: dir,
      draft: fakeDraft,
    });
    expect(r.total).toBe(2);
    expect(r.broken).toBe(1);
    expect(r.brokenRefs[0].ref).toBe("npm run ghost");
  });
});

describe("formatAdoptability", () => {
  it("renders the no-refs case", () => {
    const out = formatAdoptability(
      { total: 0, broken: 0, brokenRefs: [] },
      "CLAUDE.md",
    );
    expect(out).toMatch(/no machine-verifiable references/);
  });

  it("renders the all-resolve case as an invitation", () => {
    const out = formatAdoptability(
      { total: 5, broken: 0, brokenRefs: [] },
      "CLAUDE.md",
    );
    expect(out).toMatch(/5 verifiable reference/);
    expect(out).toMatch(/all resolve right now/);
  });

  it("renders broken refs + the init hand-off", () => {
    const out = formatAdoptability(
      {
        total: 4,
        broken: 1,
        brokenRefs: [
          { kind: "file", ref: "x.ts", issue: 'File not found: "x.ts"' },
        ],
      },
      "AGENTS.md",
    );
    expect(out).toMatch(/1 broken right now/);
    expect(out).toMatch(/File not found/);
    expect(out).toMatch(/vigiles init/);
  });
});

describe("a FAILED run is not an empty result", () => {
  // 🔴 THE TIER REACHES THE HARNESS BINARY DIRECTLY — no behavioral probe in
  // front of it to self-report unavailability — so when the binary is missing
  // the runner returns a non-zero code with empty stdout, the parser yields no
  // output, `parseDraftJson` yields `[]`, and the report printed "no
  // machine-verifiable references found in CLAUDE.md". A confident answer to a
  // question that was never asked, and indistinguishable from the real thing.
  //
  // Surfaced on review of #265, against the unconditional `subscription` this
  // PR gave the Codex driver: that removed the last gate in front of this path.
  const spawnFailed = { code: 1, stdout: "", stderr: "codex: not found" };

  it("a non-zero exit throws instead of drafting nothing", async () => {
    const draft = draftWith({
      runner: () => Promise.resolve(spawnFailed),
      parse: () => ({ output: "", toolCalls: [], usage: undefined }),
      runError: () => null,
      harness: "codex",
    } as never);
    await expect(draft("# rules\n")).rejects.toBeInstanceOf(DraftRunFailed);
    await expect(draft("# rules\n")).rejects.toThrow(/not found/);
  });

  it("a ZERO exit the driver calls failed throws too", async () => {
    // The exit code is not the only signal: a refusal or a turn error can ride
    // inside a successful process. `runError` is the driver's own reader for it.
    const draft = draftWith({
      runner: () => Promise.resolve({ code: 0, stdout: "{}" }),
      parse: () => ({ output: "", toolCalls: [], usage: undefined }),
      runError: () => "turn failed: rate limited",
      harness: "codex",
    } as never);
    await expect(draft("# rules\n")).rejects.toThrow(/rate limited/);
  });

  it("control: a clean run still drafts, so this is not just 'always throw'", async () => {
    const draft = draftWith({
      runner: () => Promise.resolve({ code: 0, stdout: "ok" }),
      parse: () => ({
        output: JSON.stringify([{ kind: "file", ref: "README.md" }]),
        toolCalls: [],
        usage: undefined,
      }),
      runError: () => null,
      harness: "codex",
    } as never);
    expect(await draft("# rules\n")).toEqual([
      { kind: "file", ref: "README.md" },
    ]);
  });
});
