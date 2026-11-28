/**
 * What loading `./workspace-host.io.ts` (the eval host every run uses) pulls
 * in: never `testcontainers`, the optional peer dependency only a container
 * run loads (vigiles#599).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nodePreflight } from "./container-preflight.io.js";

/** How many `testcontainers` modules are loaded after importing `specifier` in a fresh node. */
const testcontainersLoadedBy = (specifier: string): number =>
  Number(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { createRequire } from "node:module";
await import(${JSON.stringify(specifier)});
const keys = Object.keys(createRequire(import.meta.url).cache);
console.log(keys.filter((k) => k.includes("/testcontainers/")).length);`,
      ],
      { encoding: "utf8", cwd: import.meta.dirname },
    ).trim(),
  );

const nodeOk = nodePreflight(process.versions.node) === undefined;
if (!nodeOk) {
  const why = `SKIPPED — Node ${process.versions.node} is older than testcontainers needs, so its load probe did not run`;
  process.stderr.write(`⚠ src/host/workspace-host.io.test.ts: ${why}\n`);
  // Loud skip, never a silent pass: the reporter names why nothing ran.
  it.skip(why, () => {
    expect(nodeOk).toBe(true);
  });
}

// The control loads testcontainers, which throws on a Node it does not support.
(nodeOk ? describe : describe.skip)("the eval host stays light", () => {
  it("loading it does not load testcontainers", () => {
    const host = new URL("./workspace-host.io.ts", import.meta.url).href;
    // Guards: the optional peer dependency loads only when a container run asks for it.
    expect(testcontainersLoadedBy(host)).toBe(0);
    // Guards: the control: the probe does see testcontainers when it is loaded.
    expect(testcontainersLoadedBy("testcontainers")).toBeGreaterThan(0);
  });
});
