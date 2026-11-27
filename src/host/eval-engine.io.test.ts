/**
 * The engine fingerprint as the host reads it: a file with a string `hash` is
 * found; a missing file, a file that is not JSON, and a file without a hash
 * are each missing, naming the path; and the Node major is digits.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../core/tmp-root.js";
import { engineHost, readEngineFingerprint } from "./eval-engine.io.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A path in a fresh dir, holding `text` unless it is undefined. */
function fileWith(text: string | undefined): string {
  const dir = makeTmpDir("engine-fp");
  cleanup.push(dir);
  const path = join(dir, "eval-engine.json");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

describe("readEngineFingerprint", () => {
  it("a file with a string hash is found", () => {
    // Guards: the lock is keyed by the engine the build wrote.
    expect(readEngineFingerprint(fileWith('{"hash":"abc"}'))).toEqual({
      kind: "found",
      hash: "abc",
    });
  });

  it.each([
    ["no file", undefined],
    ["not JSON", "{not json"],
    ["no hash", '{"files":[]}'],
  ])("%s is missing, naming the path", (_name, text) => {
    const path = fileWith(text);
    // Guards: a fingerprint that cannot be read never throws; the lock refuses instead.
    expect(readEngineFingerprint(path)).toEqual({ kind: "missing", path });
  });
});

describe("engineHost", () => {
  it("reads the built fingerprint and the Node major", () => {
    // Guards: the lock's node input is the major version alone.
    expect(engineHost.nodeMajor()).toMatch(/^\d+$/);
    expect(["found", "missing"]).toContain(engineHost.engineFingerprint().kind);
  });
});
