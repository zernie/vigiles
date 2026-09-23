/**
 * Effect-boundary position-aware state tracking.
 * Mirrors active-unit tracking (.vigiles/active-agent.json / .vigiles/active-skill.json).
 * The PreToolUse hook reads this file to decide whether the agent is inside an
 * effect boundary (set by `vigiles hook-runtime effect-enter`) or outside it.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";

import {
  EFFECT_ACTIVE_FILE,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "../../local-files.js";

const EFFECT_ACTIVE_PATH = `${VIGILES_DIR}/${EFFECT_ACTIVE_FILE}`;

/** Record that the agent has entered an effect boundary. */
export function setEffectActive(cwd: string): void {
  const p = resolve(cwd, EFFECT_ACTIVE_PATH);
  mkdirSync(dirname(p), { recursive: true });
  ensureLocalFilesIgnored(dirname(p));
  writeFileSync(p, JSON.stringify({ active: true }) + "\n");
}

/** Clear the effect-active marker (the agent exited the effect boundary). */
export function clearEffectActive(cwd: string): void {
  const p = resolve(cwd, EFFECT_ACTIVE_PATH);
  if (existsSync(p)) rmSync(p);
}

/** True iff the agent is currently inside an effect boundary. Tolerates malformed file. */
export function readEffectActive(cwd: string): boolean {
  const p = resolve(cwd, EFFECT_ACTIVE_PATH);
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
      active?: unknown;
    };
    return parsed.active === true;
  } catch {
    return false;
  }
}

/** True iff the compiled markdown declares an effect boundary (`<!-- vigiles:effect -->`). */
export function hasEffectBoundary(markdown: string): boolean {
  return markdown.includes("<!-- vigiles:effect -->");
}
