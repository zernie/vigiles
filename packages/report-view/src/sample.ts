import type { AuditReport } from "./schema";

/** Dev/fallback fixture — shown by `npm run dev` and if the CLI hasn't injected data. */
export const SAMPLE: AuditReport = {
  meta: {
    schemaVersion: 2,
    tool: "vigiles",
    kind: "audit",
    vigilesVersion: "0.0.0",
    harness: "claude-code",
    dir: "my-plugin",
  },
  score: {
    overall: 77,
    grade: "C",
    empty: false,
    // A real graded harness: skills/agents/commands WERE read, so neither the
    // empty nor the instructions-only qualifier applies (see AuditScore).
    instructionsOnly: false,
    categories: [
      { key: "Truthfulness", score: 100, weight: 1, findings: [] },
      {
        key: "Triggering",
        score: 92,
        weight: 1,
        findings: ["1 near-identical skill description (wrong one fires)"],
      },
      {
        key: "Structure",
        score: 92,
        weight: 1,
        findings: ["1 agent tool that doesn't exist (typo / never-available)"],
      },
      {
        key: "Safety",
        score: 80,
        weight: 1,
        findings: [
          "1 subagent holding all three lethal-trifecta legs (prompt-injection exfil path)",
        ],
      },
      {
        key: "Tested",
        score: 88,
        weight: 1,
        advisory: true,
        findings: ["4 surfaces with no vigiles harness (deterministic, free)"],
      },
      // The THIRD state, in the sample on purpose: a deterministic read never
      // asks whether a skill fires, so the ring says so rather than reporting an
      // unearned 0.
      {
        key: "Evaluated",
        score: null,
        weight: 1,
        advisory: true,
        notMeasured: true,
        findings: [
          "4 surfaces whose firing was never measured",
          "not measured — run `npx vigiles audit` interactively to measure, or add a `*.eval.mjs` (`paid_measureTriggerRate`, vigiles/eval)",
        ],
      },
    ],
  },
  verdict: {
    sentence: "Two one-line fixes away from a B.",
    grade: "C",
    pointsToNextGrade: 3,
    fixesToNextGrade: 2,
    perRecommendation: [
      { index: 0, pointsIfFixed: 4 },
      { index: 1, pointsIfFixed: 2 },
    ],
  },
  recommendations: [
    {
      surface: "reviewer",
      action: "fix",
      rationale:
        'Unknown tool "Reed" — silently dropped, the agent can\'t use it.',
      fix: 'change the tool "Reed" to "Read"',
      detector: "subagent-tool-contract",
      confidence: "likely",
    },
    {
      surface: "deploy ↔ ship",
      action: "differentiate",
      rationale:
        "Near-identical descriptions (0.92 similar) — the selector can't tell them apart.",
      fix: "differentiate the descriptions of deploy and ship",
      detector: "description-overlap",
      confidence: "possible",
    },
  ],
  inventory: {
    skills: 2,
    agents: 1,
    hooks: 1,
    commands: 0,
    mcp: false,
    untested: 4,
    untestedHarness: 4,
    unevaluated: 4,
  },
  adoptable: {
    createAllCommand: "npx vigiles init",
    surfaces: [
      {
        path: "skills/deploy/SKILL.md",
        command: "npx vigiles init --target=skills/deploy/SKILL.md",
      },
      {
        path: "agents/reviewer.md",
        command: "npx vigiles init --target=agents/reviewer.md",
      },
    ],
  },
  adoptability: {
    total: 7,
    broken: 2,
    brokenRefs: [
      {
        kind: "file",
        ref: "src/auth/login.ts",
        issue: "file does not exist",
      },
      {
        kind: "dir",
        ref: "packages/legacy/",
        issue: "directory does not exist",
      },
    ],
  },
  ruleRouting: {
    segmented: 8,
    counts: { reuse: 3, hook: 2, meta: 0, semantic: 1, unrouted: 2 },
    rules: [
      {
        text: "Never use `console.log` in shipped code.",
        quote: "- Never use `console.log` in shipped code.",
        file: "CLAUDE.md",
        lineStart: 12,
        lineEnd: 12,
        confidence: "high",
        category: "reuse",
        mechanism: "config-line",
        rule: "no-console",
        linter: "eslint",
        // Named in the docs but turned OFF in the config — the sharp catalog
        // finding surfaced by the "documented but OFF" callout.
        enabled: false,
        source: "marker",
      },
      {
        text: "Never push directly to `main` — open a PR.",
        quote: "- Never push directly to `main` — open a PR.",
        file: "CLAUDE.md",
        lineStart: 18,
        lineEnd: 18,
        confidence: "high",
        category: "hook",
        mechanism: "hook",
      },
      {
        text: "Run `npm test` before every commit.",
        quote: "- Run `npm test` before every commit.",
        file: "CLAUDE.md",
        lineStart: 19,
        lineEnd: 19,
        confidence: "high",
        category: "hook",
        mechanism: "hook",
      },
      {
        text: "Write clear, self-documenting code.",
        quote: "- Write clear, self-documenting code.",
        file: "CLAUDE.md",
        lineStart: 21,
        lineEnd: 21,
        confidence: "high",
        category: "semantic",
        mechanism: "prose",
      },
      {
        text: "Prefer named exports over default exports.",
        quote: "- Prefer named exports over default exports.",
        file: "CLAUDE.md",
        lineStart: 22,
        lineEnd: 22,
        confidence: "high",
        category: "unrouted",
        mechanism: "synthesize",
      },
    ],
  },
  rulesInventory: [
    {
      intent: "strict equality ===",
      linter: "eslint",
      matched: "eqeqeq",
      rule: "eqeqeq",
      configState: "contradiction",
      configFix: '"eqeqeq": "error"',
    },
    {
      intent: "no console.log / use the logger",
      linter: "eslint",
      matched: "console.log",
      rule: "no-console",
      configState: "not-in-config",
      configFix: '"no-console": "error"',
    },
    {
      intent: "no debugger",
      linter: "eslint",
      matched: "no-debugger",
      rule: "no-debugger",
      configState: "not-in-config",
      configFix: '"no-debugger": "error"',
    },
    {
      intent: "no `any` type",
      linter: "eslint",
      matched: "no-explicit-any",
      rule: "@typescript-eslint/no-explicit-any",
      configState: "in-config",
      configFix: '"@typescript-eslint/no-explicit-any": "error"',
    },
    {
      intent: "no floating promises",
      linter: "eslint",
      matched: "no-floating-promises",
      rule: "@typescript-eslint/no-floating-promises",
      configState: "preset-maybe",
      configFix: '"@typescript-eslint/no-floating-promises": "error"',
    },
  ],
};
