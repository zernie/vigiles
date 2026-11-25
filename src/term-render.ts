/**
 * How vigiles lays out and colours what it prints to a terminal — one place,
 * so every surface uses the same few tones and the same finding layout, and
 * none hard-codes an escape code (`tidy-output`).
 *
 * A renderer takes a {@link Paint} and never asks whether to colour; tests
 * pass {@link plain}, so no test reads an escape code. This module imports
 * nothing from Node: the in-browser demo renders the same report through it.
 * Whether to colour, and how, is `./term-colour.ts`, which only the CLI loads.
 */
import { namesLine, type FindingGroup } from "./core/finding-groups.js";

/** The few things a colour may say. */
export type Tone = "bad" | "warn" | "good" | "fix" | "muted";

/** Paints text in a tone, or returns it as is. */
export type Paint = (tone: Tone, text: string) => string;

/** No colour: for tests, pipes, and every caller that does not opt in. */
export const plain: Paint = (_tone, text) => text;

/**
 * A group of findings as three lines: the problem after its mark, the edit
 * after an arrow, then the units it applies to, quiet.
 *
 * ```
 * ⚠ no `disallowed-tools:` line, so every session tool is inherited
 *   → add `disallowed-tools: WebFetch, WebSearch, Bash` to close untrusted intake
 *   code-quality · debug-my-harness · generate-logo +3 more
 * ```
 */
export function groupBlock(
  g: FindingGroup,
  o: {
    readonly indent: string;
    readonly mark: string;
    readonly tone: "bad" | "warn";
    readonly paint: Paint;
  },
): readonly string[] {
  const problem = o.paint(o.tone, `${o.mark} ${g.problem}`);
  const edit = o.paint("fix", `→ ${g.edit}`);
  return [
    o.indent + problem,
    `${o.indent}  ${edit}`,
    `${o.indent}  ${o.paint("muted", namesLine(g.names, " · "))}`,
  ];
}

/** One finding at a file, for {@link fileBlocks}. */
export interface FileFinding {
  readonly path: string;
  readonly mark: string;
  readonly tone: "bad" | "warn";
  readonly problem: string;
  readonly edit: string;
}

/**
 * Findings grouped by FILE, the way a linter prints them: the path, then each
 * finding under it as its problem and, below, its edit. Every finding is
 * printed; nothing merges across files, so the output stays predictable. No
 * blank line between files: a rule that reports once per file would spend a
 * quarter of its lines on them.
 *
 * ```
 * .claude/skills/half/SKILL.md
 *   ⚠ `disallowed-tools: Read` closes no leg
 *     → deny `WebFetch`, `WebSearch`, `Bash` to close untrusted intake
 * ```
 */
export function fileBlocks(
  findings: readonly FileFinding[],
  indent: string,
  paint: Paint,
): readonly string[] {
  const paths = [...new Set(findings.map((f) => f.path))];
  return paths.flatMap((path) => [
    indent + path,
    ...findings
      .filter((f) => f.path === path)
      .flatMap((f) => {
        const edit = paint("fix", `→ ${f.edit}`);
        return [
          `${indent}  ${paint(f.tone, f.mark)} ${f.problem}`,
          `${indent}    ${edit}`,
        ];
      }),
  ]);
}
