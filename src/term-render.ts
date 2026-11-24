/**
 * How vigiles lays out and colours what it prints to a terminal — one place,
 * so every surface uses the same few tones and the same finding layout, and
 * none hard-codes an escape code (`tidy-output`).
 *
 * Colour is decided once per run, from the stream and the environment: on for
 * a terminal, off when piped or captured, off under `NO_COLOR`, forced on by
 * `FORCE_COLOR` (and off by `FORCE_COLOR=0`) — the two conventions other CLIs
 * honour. A renderer takes a {@link Paint} and never asks; tests pass
 * {@link plain}, so no test reads an escape code. Node's own `util.styleText`,
 * no dependency.
 */
import { styleText } from "node:util";
import { namesLine, type FindingGroup } from "./core/finding-groups.js";

/** The few things a colour may say. */
export type Tone = "bad" | "warn" | "good" | "fix" | "muted";

/** Paints text in a tone, or returns it as is. */
export type Paint = (tone: Tone, text: string) => string;

/** No colour: for tests, pipes, and every caller that does not opt in. */
export const plain: Paint = (_tone, text) => text;

const STYLE = {
  bad: "red",
  warn: "yellow",
  good: "green",
  fix: "green",
  muted: "gray",
} as const satisfies Record<Tone, string>;

/** Whether to colour: `NO_COLOR` wins, then `FORCE_COLOR`, then a real terminal. */
export function colourEnabled(
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return isTTY && env.TERM !== "dumb";
}

/** The paint for a stream: the root passes `process.stdout.isTTY` and `process.env`. */
export function terminalPaint(
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>>,
): Paint {
  return colourEnabled(isTTY, env)
    ? (tone, text) => styleText(STYLE[tone], text, { validateStream: false })
    : plain;
}

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
