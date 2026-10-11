import { describe, it, expect } from "vitest";
import { routeRules, mergeRoutings } from "./rule-routing.js";

describe("routeRules", () => {
  it("routes an off-the-shelf rule mention to reuse (config-line)", () => {
    const r = routeRules("- Never use `console.log` in shipped code.");
    const reuse = r.rules.filter((x) => x.category === "reuse");
    expect(reuse).toHaveLength(1);
    expect(reuse[0].rule).toBe("no-console");
    expect(reuse[0].mechanism).toBe("config-line");
    expect(r.counts.reuse).toBe(1);
  });

  it("routes an action rule to hook (a linter can't see git push)", () => {
    const r = routeRules("- Never force-push to main.");
    const hook = r.rules.filter((x) => x.category === "hook");
    expect(hook).toHaveLength(1);
    expect(hook[0].mechanism).toBe("hook");
  });

  it("action cue wins over a rule-name mention (never commit console.log → hook)", () => {
    const r = routeRules(
      "- Never commit `console.log` — run tests before you commit.",
    );
    expect(r.rules[0]?.category).toBe("hook");
  });

  it("routes a regenerate-on-change guard to hook (both clause orders)", () => {
    const a = routeRules(
      "- Run `pnpm update-references` after adding a dependency.",
    );
    expect(a.rules[0]?.category).toBe("hook");
    const b = routeRules(
      "- Always regenerate the snapshots when the schema changes.",
    );
    expect(b.rules[0]?.category).toBe("hook");
    // A benign "when ready" (no change-verb) must NOT match.
    const c = routeRules("- Run the app when you are ready to demo.");
    expect(c.rules[0]?.category).not.toBe("hook");
  });

  it("routes commit/PR hygiene (no push verb) to hook", () => {
    for (const t of [
      "- DO NOT COMMIT unless the user asks.",
      "- Never add yourself or an AI tool as a co-author.",
      '- Do NOT add "Generated with Claude Code" footers to commits.',
      "- Use semantic PR titles for pull requests.",
    ]) {
      expect(routeRules(t).rules[0]?.category).toBe("hook");
    }
    // A style sentence merely NAMING PR titles is NOT a gate (stays non-hook).
    const style = routeRules("- Use sentence case for headings and PR titles.");
    expect(style.rules[0]?.category).not.toBe("hook");
  });

  it("routes a construct-prohibition to reuse via no-restricted-syntax (looks custom, isn't)", () => {
    // A whole class of "no <construct>" rules are enforceable by the built-in
    // no-restricted-syntax — deterministic reuse, no synthesis.
    for (const t of [
      "- Never use classes.",
      "- No default exports; prefer named.",
      "- Avoid TypeScript enums.",
      "- Do not use enums in new code.",
      "- Never use namespaces.",
    ]) {
      const rule = routeRules(t).rules[0];
      expect(rule?.category).toBe("reuse");
      expect(rule?.rule).toBe("no-restricted-syntax");
    }
  });

  it("construct-prohibition is precision-first — no FP on benign construct words", () => {
    // A prohibition head must sit next to the construct; CSS/utility/first-class
    // usages and non-prohibition sentences must NOT route to reuse.
    for (const t of [
      "## Rules\n\n- Use utility classes for styling.",
      "## Rules\n\n- Support first-class functions.",
      "## Rules\n\n- Add a CSS class to the button.",
      "## Rules\n\n- Enumerate the config files before parsing.",
    ]) {
      const rule = routeRules(t).rules.find(
        (r) => r.rule === "no-restricted-syntax",
      );
      expect(rule).toBeUndefined();
    }
  });

  it("routes a judgment call to semantic (stays prose)", () => {
    const r = routeRules(
      "## Rules\n\n- Keep names readable and code idiomatic.",
    );
    const semantic = r.rules.filter((x) => x.category === "semantic");
    expect(semantic.length).toBeGreaterThanOrEqual(1);
    expect(semantic[0].mechanism).toBe("prose");
  });

  it("routes an un-cued mechanizable rule to unrouted (mechanism 'synthesize', never the spec 'compile' verb)", () => {
    // A real imperative with no off-the-shelf rule, no action cue, no judgment cue.
    const r = routeRules("- Always wrap fetch calls in a retry with backoff.");
    const unrouted = r.rules.filter((x) => x.category === "unrouted");
    expect(unrouted.length).toBeGreaterThanOrEqual(1);
    // The hard bucket's mechanism is `synthesize` (an opt-in skill MAY write a
    // gated custom rule) — deliberately NOT "compile" (that's the unrelated
    // spec→markdown verb; conflating them was the bug).
    expect(unrouted[0].mechanism).toBe("synthesize");
    // Every mechanism is one of the four honest rungs.
    const RUNGS = new Set(["config-line", "hook", "prose", "synthesize"]);
    expect(r.rules.every((x) => RUNGS.has(x.mechanism))).toBe(true);
  });

  it("routes an agent-instruction to meta (not a code rule), never unrouted", () => {
    // "read X first" is guidance to the agent, not an enforceable code norm — it
    // must NOT read as "compilable but hard".
    const r = routeRules("## Rules\n\n- Always read the root CLAUDE.md first.");
    const meta = r.rules.filter((x) => x.category === "meta");
    expect(meta.length).toBeGreaterThanOrEqual(1);
    expect(meta[0].mechanism).toBe("prose");
    // and it did not leak into the "hard to compile" bucket
    expect(r.rules.some((x) => x.category === "unrouted")).toBe(false);
  });

  it("routes an agent-attention norm (never re-read a file) to meta, not unrouted", () => {
    // Fable's H5: nothing reliably gates "don't re-read/re-run" — it's agent
    // guidance (meta), never a compilable rule.
    const r = routeRules(
      "## Rules\n\n- Never re-read the same section of a file without code changes in between.",
    );
    expect(r.rules.some((x) => x.category === "meta")).toBe(true);
    expect(r.rules.some((x) => x.category === "unrouted")).toBe(false);
  });

  it("dynamic catalog: a bullet naming ANY repo rule → reuse with enabled state", () => {
    const availableRules = {
      linter: "eslint" as const,
      available: 2,
      enabled: 1,
      rules: [
        {
          id: "no-only-tests/no-only-tests",
          linter: "eslint" as const,
          plugin: "no-only-tests",
          enabled: false,
        },
        {
          id: "boundaries/dependencies",
          linter: "eslint" as const,
          plugin: "boundaries",
          enabled: true,
        },
      ],
    };
    const md = [
      "## Rules",
      "",
      "- No `.only()` in tests (`no-only-tests/no-only-tests`)",
      "- Never import an adapter from the core layer (`boundaries/dependencies`)",
    ].join("\n");

    // WITHOUT a catalog, the first bullet is unrouted (its `/` breaks the static
    // INTENT_MAP whole-token match) — the exact named-but-hard case.
    const bare = routeRules(md);
    expect(bare.rules[0]?.category).toBe("unrouted");
    expect(bare.rules[0]?.enabled).toBeUndefined();

    // WITH the catalog, both route to reuse; the disabled one carries the
    // "documented but OFF" nudge, and architecture (boundaries) is enforceable.
    const r = routeRules(md, undefined, { availableRules });
    const only = r.rules.find((x) => x.rule === "no-only-tests/no-only-tests");
    expect(only?.category).toBe("reuse");
    expect(only?.enabled).toBe(false);
    const arch = r.rules.find((x) => x.rule === "boundaries/dependencies");
    expect(arch?.category).toBe("reuse");
    expect(arch?.enabled).toBe(true);
  });

  it("polyglot collision: the symbol routes conservatively, the Pylint code stays OFF", () => {
    // `no-else-return` is in BOTH linters — ESLint ON, Pylint OFF (code R1705).
    // A doc naming the SYMBOL must not read "OFF" (ESLint enforces it); a doc
    // naming the Pylint CODE must still surface the documented-but-OFF Pylint rule.
    const availableRules = {
      linter: "eslint" as const,
      available: 2,
      enabled: 1,
      rules: [
        {
          id: "no-else-return",
          linter: "eslint" as const,
          plugin: null,
          enabled: true,
        },
        {
          id: "no-else-return",
          linter: "pylint" as const,
          plugin: null,
          code: "R1705",
          enabled: false,
        },
      ],
    };
    const md = [
      "## Rules",
      "",
      "- Prefer a guard clause over else-after-return (`no-else-return`)",
      "- No else after return (`R1705`)",
    ].join("\n");
    const r = routeRules(md, undefined, { availableRules });

    const sym = r.rules.find((x) => x.rule === "no-else-return");
    expect(sym?.category).toBe("reuse");
    expect(sym?.enabled).toBe(true); // ESLint enforces it → not "documented but OFF"
    expect(sym?.linter).toBe("eslint");

    const code = r.rules.find((x) => x.rule === "R1705");
    expect(code?.category).toBe("reuse");
    expect(code?.enabled).toBe(false); // the disabled Pylint rule surfaces
    expect(code?.linter).toBe("pylint");
  });

  it("dynamic catalog rescues a MEDIUM declarative bullet that names a real repo rule", () => {
    const availableRules = {
      linter: "eslint" as const,
      available: 1,
      enabled: 1,
      rules: [
        {
          id: "boundaries/dependencies",
          linter: "eslint" as const,
          plugin: "boundaries",
          enabled: true,
        },
      ],
    };
    // Declarative subject ("The core layer must not …"), no imperative head — the
    // segmenter scores this MEDIUM, so the high-only default drops it.
    const md = [
      "## Rules",
      "",
      "- The core layer must not import an adapter (`boundaries/dependencies`).",
    ].join("\n");

    // WITHOUT the catalog it's dropped entirely (medium < high).
    const bare = routeRules(md);
    expect(bare.segmented).toBe(0);

    // WITH the catalog the medium bullet is rescued (it names a real rule) and
    // routes to reuse, ON.
    const r = routeRules(md, undefined, { availableRules });
    const arch = r.rules.find((x) => x.rule === "boundaries/dependencies");
    expect(arch?.category).toBe("reuse");
    expect(arch?.enabled).toBe(true);
  });

  it("carries provenance (line span + verbatim quote) from the segmenter", () => {
    const md = "# Style\n\n- Use `eqeqeq` everywhere.\n";
    const r = routeRules(md, "CLAUDE.md");
    const rule = r.rules.find((x) => x.rule === "eqeqeq");
    expect(rule?.file).toBe("CLAUDE.md");
    expect(rule?.lineStart).toBe(3);
    expect(rule?.quote).toContain("eqeqeq");
    expect(rule?.confidence === "high" || rule?.confidence === "medium").toBe(
      true,
    );
  });

  it("counts add up to the number of segmented rules", () => {
    const md = [
      "## Conventions",
      "",
      "- Never use `console.log`.",
      "- Never force-push to main.",
      "- Keep code readable.",
      "- Always validate user input.",
    ].join("\n");
    const r = routeRules(md);
    const sum =
      r.counts.reuse +
      r.counts.hook +
      r.counts.meta +
      r.counts.semantic +
      r.counts.unrouted;
    expect(sum).toBe(r.segmented);
    expect(r.segmented).toBeGreaterThanOrEqual(4);
  });

  it("mergeRoutings folds per-file routings, preserving each rule's own provenance", () => {
    // Two sources routed SEPARATELY — each rule keeps its OWN file + line numbers
    // (concatenating first would offset the second file's lines).
    const a = routeRules("# A\n\n- Never use `console.log`.\n", "CLAUDE.md");
    const b = routeRules("# B\n\n- Never force-push to main.\n", "AGENTS.md");
    const merged = mergeRoutings([a, b]);

    expect(merged.segmented).toBe(a.segmented + b.segmented);
    expect(merged.rules).toHaveLength(a.rules.length + b.rules.length);
    // counts sum per-category
    expect(merged.counts.reuse).toBe(a.counts.reuse + b.counts.reuse);
    expect(merged.counts.hook).toBe(a.counts.hook + b.counts.hook);
    // provenance is per-file, not a concatenated blob
    expect(merged.rules.find((r) => r.rule === "no-console")?.file).toBe(
      "CLAUDE.md",
    );
    expect(merged.rules.find((r) => r.category === "hook")?.file).toBe(
      "AGENTS.md",
    );
    // both rules land on their own file's line 3 (not offset by the other file)
    expect(merged.rules.every((r) => r.lineStart === 3)).toBe(true);
  });

  it("mergeRoutings of [] is an empty routing", () => {
    const merged = mergeRoutings([]);
    expect(merged.segmented).toBe(0);
    expect(merged.rules).toEqual([]);
    expect(merged.counts).toEqual({
      reuse: 0,
      hook: 0,
      meta: 0,
      semantic: 0,
      unrouted: 0,
    });
  });

  it("S0/S1: routes explicit markers definitively (Enforced by / Guard / Guidance)", () => {
    const md = [
      "### No Floating Promises",
      "",
      "**Enforced by:** `@typescript-eslint/no-floating-promises`",
      "**Why:** Unhandled rejections crash the process.",
      "",
      "### Recompile On Spec Change",
      "",
      "**Guard:** `*.spec.ts` → `npx vigiles compile`",
      "**Why:** Recompile when a spec changes.",
      "",
      "### Format Before Commit",
      "",
      "**Guidance only** — Run the formatter before you commit.",
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md");
    const enf = r.rules.find((x) => x.rule?.includes("no-floating-promises"));
    expect(enf?.category).toBe("reuse");
    expect(enf?.source).toBe("marker");
    expect(
      r.rules.find((x) => x.text === "Recompile On Spec Change")?.category,
    ).toBe("hook");
    // promote-prose: a guidance body that's really an action → would-be hook
    expect(
      r.rules.find((x) => x.text === "Format Before Commit")?.category,
    ).toBe("hook");
  });

  it("S0/S1: a marked section is CONSUMED — no double-count by the heuristic", () => {
    // The heading "Never Skip Tests" is rule-ish and its guidance body would be
    // sentence-split by the heuristic — the marker pre-pass must consume it.
    const md = [
      "### Never Skip Tests",
      "",
      "**Guidance only** — All tests must pass. Never skip a failing test.",
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md");
    // Exactly ONE rule (the marker), not the marker plus split body sentences.
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].source).toBe("marker");
  });

  it("S0/S1: a compiled **Claimed (unverified):** reference routes like Enforced by (#351)", () => {
    const md = [
      "### No Restricted Imports",
      "",
      "**Claimed (unverified):** `eslint/no-restricted-imports`",
      "**Why:** Barrel imports only.",
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md");
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].category).toBe("reuse");
    expect(r.rules[0].source).toBe("marker");
    expect(r.rules[0].rule).toBe("eslint/no-restricted-imports");
  });

  it("S0/S1: a hand-written **Enforced by:** that is NOT a rule id is not claimed", () => {
    const md = ["### Tested In CI", "", "**Enforced by:** CI pipeline"].join(
      "\n",
    );
    const r = routeRules(md, "CLAUDE.md");
    // "CI pipeline" is a prose claim, not a rule id → not emitted as reuse.
    expect(r.rules.some((x) => x.category === "reuse")).toBe(false);
  });

  it("S0/S1: a marked reuse rule carries catalog enabled-state", () => {
    const availableRules = {
      linter: "eslint" as const,
      available: 1,
      enabled: 0,
      rules: [
        {
          id: "@typescript-eslint/no-explicit-any",
          linter: "eslint" as const,
          plugin: "@typescript-eslint",
          enabled: false,
        },
      ],
    };
    const md = [
      "### No Any",
      "",
      "**Enforced by:** `@typescript-eslint/no-explicit-any`",
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md", { availableRules });
    const rule = r.rules.find((x) => x.source === "marker");
    expect(rule?.category).toBe("reuse");
    expect(rule?.enabled).toBe(false); // documented but OFF
  });

  it("keeps per-linter provenance in a POLYGLOT catalog (eslint + pylint merged)", () => {
    // A project with BOTH linters: the merged catalog carries each rule's linter,
    // so a routed reuse hit says pylint:invalid-name vs eslint:no-console — not a
    // linter-less `undefined:`. This is the multi-linter resolution.
    const availableRules = {
      linter: "eslint" as const, // cosmetic summary; routing reads each rule's linter
      available: 2,
      enabled: 1,
      rules: [
        {
          id: "@typescript-eslint/no-floating-promises",
          linter: "eslint" as const,
          plugin: "@typescript-eslint",
          enabled: true,
        },
        {
          id: "invalid-name",
          linter: "pylint" as const,
          plugin: null,
          code: "C0103",
          enabled: false,
        },
      ],
    };
    const md = [
      "# Rules",
      "",
      "## JS",
      "",
      "- No floating promises (`@typescript-eslint/no-floating-promises`).",
      "",
      "## Python",
      "",
      "- Follow naming conventions (`invalid-name`).",
      "",
    ].join("\n");
    const reuse = routeRules(md, "CLAUDE.md", { availableRules }).rules.filter(
      (x) => x.category === "reuse",
    );
    const js = reuse.find(
      (x) => x.rule === "@typescript-eslint/no-floating-promises",
    );
    const py = reuse.find((x) => x.rule === "invalid-name");
    expect(js?.linter).toBe("eslint");
    expect(js?.enabled).toBe(true);
    expect(py?.linter).toBe("pylint"); // NOT undefined — provenance kept
    expect(py?.enabled).toBe(false); // documented but OFF
  });

  it("splits detection into CONFIDENT / POSSIBLE / SKIPPED tiers", () => {
    const md = [
      "# Rules",
      "",
      "## Conventions",
      "",
      "- Never use `eval()`.", // imperative → confident
      "- Every public API should stay backwards compatible.", // declarative norm, no rule → possible
      "",
      "## Setup", // anti-context heading
      "",
      "- Run `npm install` to get started.", // → skipped (section)
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md");

    // CONFIDENT: the imperative rule is routed.
    expect(r.rules.some((x) => x.text.includes("eval()"))).toBe(true);
    // POSSIBLE: the declarative norm is surfaced for review, NOT routed as fact.
    expect(
      r.possible.some((x) => x.text.includes("backwards compatible")),
    ).toBe(true);
    expect(r.rules.some((x) => x.text.includes("backwards compatible"))).toBe(
      false,
    );
    // SKIPPED: the setup bullet is set aside WITH a reason, not silently dropped.
    const setup = r.skipped.find((s) => s.text.includes("npm install"));
    expect(setup?.reason).toBe("section");
  });

  it("POSSIBLE keeps only norm-ish bullets; prose without a norm signal is skipped", () => {
    const md = [
      "## Notes",
      "",
      "- Every public API should stay backwards compatible.", // norm (should) → possible
      "- `README.md` documents the v2 API.", // prose, no norm → skipped
    ].join("\n");
    const r = routeRules(md, "CLAUDE.md");
    expect(
      r.possible.some((x) => x.text.includes("backwards compatible")),
    ).toBe(true);
    expect(r.possible.some((x) => x.text.includes("documents"))).toBe(false);
    // the descriptive bullet is set aside (visible) with a no-signal reason
    expect(
      r.skipped.some(
        (s) => s.text.includes("documents") && s.reason === "no-signal",
      ),
    ).toBe(true);
  });

  it("rescues a declarative rule that NAMES/matches a real rule to CONFIDENT (recall)", () => {
    // "Every function must have a docstring" fails the imperative gate (declarative
    // subject) but matches the docstring pattern rule — so it's rescued to reuse,
    // not lost. The two-tier fold recovers this recall.
    const r = routeRules(
      "## Docstrings\n\n- Every function must have a docstring.",
      "CLAUDE.md",
    );
    expect(r.rules.some((x) => x.category === "reuse")).toBe(true);
  });

  it("minConfidence:'medium' does NOT promote a gate-rejected no-signal bullet", () => {
    // A bullet the segmenter rejects as `no-signal` (context only, no rule/norm
    // signal) is folded back in for a possible RESCUE — but the medium opt-in must
    // NOT resurrect it as a confident rule (that would inflate `rules`/counts).
    const md = "## Notes\n\n- The team meets weekly to sync.\n";
    const med = routeRules(md, "CLAUDE.md", { minConfidence: "medium" });
    expect(med.rules).toHaveLength(0);
    expect(med.skipped.some((s) => s.reason === "no-signal")).toBe(true);
    // a REAL medium segment is still promoted in medium mode (unchanged behaviour)
    const seg = routeRules(
      "## Notes\n\n- `README.md` documents the v2 API.\n",
      "f",
      {
        minConfidence: "medium",
      },
    );
    expect(seg.rules.length).toBeGreaterThan(0);
  });

  it("a MARKED reuse rule carries its catalog linter (polyglot provenance)", () => {
    const availableRules = {
      linter: "pylint" as const,
      available: 1,
      enabled: 0,
      rules: [
        {
          id: "missing-function-docstring",
          linter: "pylint" as const,
          plugin: null,
          code: "C0116",
          enabled: false,
        },
      ],
    };
    const r = routeRules(
      "### Docstrings\n\n**Enforced by:** `missing-function-docstring`",
      "CLAUDE.md",
      { availableRules },
    );
    const marked = r.rules.find((x) => x.source === "marker");
    expect(marked?.linter).toBe("pylint"); // NOT undefined
    expect(marked?.enabled).toBe(false);
  });

  it("a MARKER using a Pylint numeric code (C0116) is accepted, not rejected as prose", () => {
    const availableRules = {
      linter: "pylint" as const,
      available: 1,
      enabled: 0,
      rules: [
        {
          id: "missing-function-docstring",
          linter: "pylint" as const,
          plugin: null,
          code: "C0116",
          enabled: false,
        },
      ],
    };
    const r = routeRules("### D\n\n**Enforced by:** `C0116`", "CLAUDE.md", {
      availableRules,
    });
    const marked = r.rules.find((x) => x.source === "marker");
    expect(marked?.category).toBe("reuse");
    expect(marked?.rule).toBe("C0116");
    expect(marked?.linter).toBe("pylint");
  });

  it("returns an empty routing for prose with no rules", () => {
    const r = routeRules("This project is a knowledge base. It has notes.");
    expect(r.segmented).toBe(0);
    expect(r.rules).toEqual([]);
    expect(r.possible).toEqual([]);
  });
});
