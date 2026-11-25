/**
 * Pure rules over `SKILL.md` text that the eval tier applies before a run: a
 * skill file dropped where no harness registers it, and a skill reduced to its
 * trigger surface (frontmatter kept, body stubbed). The filesystem side —
 * packaging skills into a plugin dir — stays with the run pipeline in
 * `src/eval.ts`.
 */
/**
 * A `SKILL.md` written straight into a run's cwd (via an arm's `files`) is NOT
 * registered as a skill by the harness. Claude Code — and Codex — load skills only
 * from a plugin / `.claude/skills` layout, so a bare cwd `SKILL.md` sits unread:
 * the arm silently measures NOTHING (baseline and "skill" become the same run). This
 * is the exact footgun the ecosystem benchmark hit — a skill file delivered where it
 * can never activate, with no error. Detect it so {@link runEval}
 * can WARN and point at `pluginDir` (a real `--plugin-dir` install) or `skillsDir`.
 *
 * HIGH-PRECISION (don't cry wolf): only a file whose basename is `SKILL.md` AND that
 * carries real skill frontmatter (a `---` block naming `name`/`description`) is flagged
 * — so an empty scratch `SKILL.md` a task is asked to AUTHOR is never flagged. Pure +
 * exported for testing.
 */
export function unregisteredSkillFiles(
  files: Record<string, string> | undefined,
): string[] {
  if (files === undefined) return [];
  return Object.entries(files)
    .filter(([p, c]) => skillBasename(p) && hasSkillFrontmatter(c))
    .map(([p]) => p);
}

function skillBasename(path: string): boolean {
  return (path.split(/[\\/]/).pop() ?? path) === "SKILL.md";
}

function hasSkillFrontmatter(content: string): boolean {
  const m = /^\uFEFF?\s*---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return m !== null && /(^|\n)\s*(name|description)\s*:/.test(m[1]);
}

/**
 * Rewrite a SKILL.md to keep its YAML frontmatter (the trigger surface — name +
 * description) but replace the body with a no-op stub. Trigger-rate is a property
 * of the frontmatter ONLY: the model picks a skill from its name + description
 * before the body is ever loaded, so the body is causally downstream of selection
 * and irrelevant to whether the skill fires. Stubbing it lets a trigger run stop
 * AT selection instead of executing an expensive multi-step procedure — cheaper,
 * faster, and side-effect-free, without changing what's measured. Pure.
 */
export function stubSkillBody(skillMd: string): string {
  const m = /^(---\n[\s\S]*?\n---\n)/.exec(skillMd);
  const frontmatter = m ? m[1] : "";
  return `${frontmatter}\nThis skill was selected (trigger-test stub). Acknowledge and stop — do not perform any actions.\n`;
}
