/**
 * DRIFT TEST for the always-loaded context on Claude Code: the skill-listing entries
 * `claudeCodeSkillListing` renders, and the body of the selected output style,
 * must appear VERBATIM in the first request the real `claude` binary sends to
 * the scripted mock model (harness tier: no key, no cost; skipped where the
 * CLI is absent).
 *
 * WHY THIS AND NOT ONLY THE GOLDEN STRINGS in `always-loaded.test.ts`. A golden
 * string pins what we BELIEVE the harness renders; only the binary says what it
 * sends. The first run of this test found five such beliefs wrong — the
 * `when_to_use` separator, the angle-bracket escape, the control-character
 * rule, the cut marker, and the `dir (name)` label — each invisible to a
 * golden string written from the docs. When a Claude Code release changes the
 * rendering, this test fails, rather than every consumer's baseline quietly
 * moving.
 */
import { describe, expect, test } from "vitest";

import { sessionSkills } from "../../core/always-loaded.js";
import { styleReached } from "../../core/output-style.js";
import { claudeAvailable, runHarnessTest } from "../../harness-test.js";
import { claudeCodeLayout } from "./layout.js";
import { claudeCodeOutputStyles as styles } from "./output-style.js";
import { claudeCodeSkillListing } from "./skill-listing.js";

const maybe = claudeAvailable() ? test : test.skip;

const STYLE_AT = ".claude/output-styles/terse.md";
const STYLE =
  "---\nname: Terse Talk\n---\nAnswer in one line. Never use <tags>.";

/** One skill per rendering rule the entry encodes. */
const FILES: Record<string, string> = {
  ".claude/skills/alpha/SKILL.md":
    "---\nname: alpha\ndescription: Run <cmd> now & then\nwhen_to_use: When the user says <go>\n---\nbody",
  ".claude/skills/long/SKILL.md": `---\nname: long\ndescription: ${"L".repeat(1600)}\n---\nbody`,
  ".claude/skills/brackets/SKILL.md": `---\nname: brackets\ndescription: "${"<".repeat(1530)}tail"\n---\nbody`,
  ".claude/skills/ctrl/SKILL.md":
    '---\nname: ctrl\ndescription: "a\\u0007b\\u200bc  d"\n---\nbody',
  ".claude/skills/dirx/SKILL.md":
    "---\nname: namex\ndescription: renamed\n---\nbody",
  ".claude/skills/bare/SKILL.md": "---\nname: bare\n---\n",
  ".claude/skills/fromBody/SKILL.md":
    "---\nname: fromBody\n---\n\n  First <line>\nsecond",
  ".claude/skills/brief/SKILL.md": "---\ndescription: never shown\n---\n",
  ".claude/skills/manual/SKILL.md":
    "---\ndescription: hidden\ndisable-model-invocation: true\n---\n",
  [STYLE_AT]: STYLE,
};

const SETTINGS = {
  outputStyle: "Terse Talk",
  skillOverrides: { brief: "name-only" },
};

describe("Claude Code skill listing and output style, as the binary sends them", () => {
  maybe(
    "every rendered entry and the style body reach the model verbatim",
    async () => {
      const r = await runHarnessTest({
        sandbox: false,
        timeoutMs: 120_000,
        prompt: "hi",
        files: FILES,
        settings: SETTINGS,
        model: [{ text: "done" }],
      });
      try {
        const first =
          r.modelRequests.find((q) => q.sideChannel !== true) ??
          r.modelRequests[0];
        const sent = [
          first?.system ?? "",
          ...(first?.messages ?? []).map((m) => m.text),
        ].join("\n");
        const lines = new Set(sent.split("\n"));
        const rendered = sessionSkills(claudeCodeLayout, FILES).map(
          (skill) =>
            [
              skill.dirName,
              claudeCodeSkillListing.entry(skill, SETTINGS),
            ] as const,
        );
        // Every rule above produced an entry, and the hidden one none.
        expect(rendered.filter(([, e]) => e === null).map(([d]) => d)).toEqual([
          "manual",
        ]);
        for (const [, entry] of rendered) {
          if (entry !== null) expect(lines.has(entry), entry).toBe(true);
        }
        expect([...lines].some((l) => l.startsWith("- manual"))).toBe(false);
        // The part counts the style's body; that exact text is what arrives.
        const style = styles.read(STYLE_AT, STYLE);
        expect(styleReached(styles, style, r.modelRequests)).toBe(true);
        expect(sent).toContain(style.body);
      } finally {
        r.cleanup();
      }
    },
    180_000,
  );
});
