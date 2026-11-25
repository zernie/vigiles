/**
 * Whether and how the CLI colours what it prints: decided once per run, from
 * the stream and the environment — on for a terminal, off when piped or
 * captured, off under `NO_COLOR`, forced on by `FORCE_COLOR` (and off by
 * `FORCE_COLOR=0`), the two conventions other CLIs honour. Node's own
 * `util.styleText`, no dependency.
 *
 * Split from `./term-render.ts` because it imports `node:util`: the layout is
 * also bundled into the in-browser demo, this is not.
 */
import { styleText } from "node:util";
import { plain, type Paint, type Tone } from "./term-render.js";

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
