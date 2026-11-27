/**
 * The host adapter of core's `EngineHost` port (vigiles#416): the eval
 * engine's fingerprint, read from `eval-engine.json` (written by
 * `scripts/build-eval-engine.mjs` beside the compiled modules, one directory
 * up from this one), and the Node major the run is on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EngineFingerprint, EngineHost } from "../core/eval-host.js";

/** Where the build writes the fingerprint: `dist/`, beside `dist/eval.js`. */
const ENGINE_FILE = join(import.meta.dirname, "..", "eval-engine.json");

const FINGERPRINT = z.object({ hash: z.string() });

/** Read `path`. A file that is not JSON, or has no string `hash`, counts as missing. */
export function readEngineFingerprint(path: string): EngineFingerprint {
  if (!existsSync(path)) return { kind: "missing", path };
  const parsed = FINGERPRINT.safeParse(jsonOf(readFileSync(path, "utf-8")));
  return parsed.success
    ? { kind: "found", hash: parsed.data.hash }
    : { kind: "missing", path };
}

/** `text` as JSON, or `undefined` when it is not JSON. */
function jsonOf(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

export const engineHost: EngineHost = {
  engineFingerprint: () => readEngineFingerprint(ENGINE_FILE),
  nodeMajor: () => process.versions.node.split(".")[0] ?? process.versions.node,
};
