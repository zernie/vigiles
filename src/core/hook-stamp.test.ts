/**
 * The stale-stamp DETECTOR, decided without a process. What the runtime does
 * with a stale stamp (a failure, exit 1, for every role) is asserted through
 * the real runtime in `src/hook-stale-stamp.test.ts`.
 */
import { describe, test, expect } from "vitest";

import { checkHookStamp, staleHookStamps } from "./hook-stamp.js";
import { stampHook } from "./hook-program.js";

describe("checkHookStamp", () => {
  const source = "export default 1;\n";
  const sidecar = (stamp: unknown): string => JSON.stringify({ stamp });

  test("tells each reason a stamp is not compared apart", () => {
    expect(checkHookStamp(undefined, source, stampHook)).toEqual({
      kind: "no-sidecar",
    });
    expect(checkHookStamp("{}", source, stampHook)).toEqual({
      kind: "cleared",
    });
    expect(checkHookStamp("{not json", source, stampHook)).toEqual({
      kind: "unreadable",
      what: "sidecar",
    });
    expect(
      checkHookStamp(sidecar(stampHook(source)), undefined, stampHook),
    ).toEqual({ kind: "unreadable", what: "source" });
  });

  test("a matching source matches; an edited one is stale", () => {
    const stamp = stampHook(source);
    expect(checkHookStamp(sidecar(stamp), source, stampHook)).toEqual({
      kind: "matches",
    });
    expect(
      checkHookStamp(sidecar(stamp), source + "// edited\n", stampHook),
    ).toEqual({ kind: "stale", stamp });
  });
});

describe("staleHookStamps", () => {
  const fresh = "export default 'fresh';\n";
  const edited = "export default 'edited';\n";

  test("reports only a sidecar whose source moved, by the source it names", () => {
    const files: Record<string, string> = {
      "hooks/a.hook.ts": edited,
      ".vigiles/hooks/a.hook.ts.json": JSON.stringify({
        file: "hooks/a.hook.ts",
        stamp: stampHook(fresh),
      }),
      ".vigiles/hooks/b.hook.mjs": fresh,
      ".vigiles/hooks/b.hook.mjs.json": JSON.stringify({
        stamp: stampHook(fresh),
      }),
      ".vigiles/hooks/c.hook.mjs.json": "{}",
      // A sidecar whose source is gone is `hook-script-exists`' finding.
      ".vigiles/hooks/d.hook.mjs.json": JSON.stringify({
        file: "gone.hook.mjs",
        stamp: stampHook(fresh),
      }),
    };
    expect(
      staleHookStamps(Object.keys(files), (ref) => files[ref], stampHook),
    ).toEqual([
      {
        sidecar: ".vigiles/hooks/a.hook.ts.json",
        source: "hooks/a.hook.ts",
      },
    ]);
  });

  test("falls back to the hook beside the sidecar when it names no file", () => {
    const files: Record<string, string> = {
      ".vigiles/hooks/b.hook.mjs": edited,
      ".vigiles/hooks/b.hook.mjs.json": JSON.stringify({
        stamp: stampHook(fresh),
      }),
    };
    expect(
      staleHookStamps(Object.keys(files), (ref) => files[ref], stampHook),
    ).toEqual([
      {
        sidecar: ".vigiles/hooks/b.hook.mjs.json",
        source: ".vigiles/hooks/b.hook.mjs",
      },
    ]);
  });
});
