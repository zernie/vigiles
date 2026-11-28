/**
 * The checks of `./container-preflight.io.ts` that need no Docker and no
 * testcontainers: which Node can load the library, and what a failed import
 * of it means.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  importFinding,
  nodePreflight,
  TESTCONTAINERS_NODE,
} from "./container-preflight.io.js";

const { major, minor } = TESTCONTAINERS_NODE;
const at = (a: number, b: number, c = 0): string =>
  `${String(a)}.${String(b)}.${String(c)}`;

describe("nodePreflight", () => {
  it("refuses a Node below the one testcontainers declares", () => {
    // Guards: Node 20, which vigiles itself supports, gets the Node cure.
    expect(nodePreflight("20.19.5")).toEqual({
      kind: "node-too-old",
      have: "20.19.5",
      need: `${String(major)}.${String(minor)}`,
    });
    // Guards: one minor below the floor is refused.
    expect(nodePreflight(at(major, minor - 1, 9))).toMatchObject({
      kind: "node-too-old",
    });
  });

  it("lets the exact minimum and a newer major through", () => {
    // Guards: the floor is inclusive, as `>=` in the package's engines.
    expect(nodePreflight(at(major, minor))).toBeUndefined();
    expect(nodePreflight(at(major + 1, 0))).toBeUndefined();
  });

  it("asks for the Node the installed testcontainers declares", () => {
    const raw: unknown = createRequire(import.meta.url)(
      "testcontainers/package.json",
    );
    const pkg = z
      .object({ engines: z.object({ node: z.string() }) })
      .parse(raw);
    // Guards: a testcontainers upgrade that moves its Node floor fails here, not on a user's machine.
    expect(pkg.engines.node).toBe(`>= ${String(major)}.${String(minor)}`);
  });
});

describe("importFinding", () => {
  it("reads a missing module as not installed", () => {
    const missing = Object.assign(new Error("Cannot find package"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    // Guards: only a missing module is told to install the package.
    expect(importFinding(missing)).toEqual({ kind: "no-testcontainers" });
  });

  it("reads any other import error as installed but failing, with its message", () => {
    const broken = new Error(
      "Cannot read properties of undefined (reading 'bind')",
    );
    // Guards: an installed package that throws is not told to install itself.
    expect(importFinding(broken)).toEqual({
      kind: "testcontainers-failed",
      detail: "Cannot read properties of undefined (reading 'bind')",
    });
  });
});
