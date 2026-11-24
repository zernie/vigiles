/**
 * The stale-stamp POLICY and its detector, decided without a process.
 *
 * The matrix is the contract: every role × every shape an event capability can
 * take (what it carries × whether it honours a veto), plus the unrecorded event
 * with and without a tool call in its payload. Only a tool gate on an event
 * whose deny vetoes a tool call may refuse; the rest skip. The same matrix over
 * every registered adapter's REAL event table is in `src/hook-stale-stamp.test.ts`.
 */
import { describe, test, expect } from "vitest";

import {
  checkHookStamp,
  staleHookStamps,
  staleStampResponse,
  type StaleStampResponse,
} from "./hook-stamp.js";
import {
  capabilityOf,
  type EventCapabilityTable,
  type EventPayload,
} from "./event-capability.js";
import { stampHook, type DispatchKind } from "./hook-program.js";

/** Every role; the type below fails to compile if a new kind is missing. */
const ROLES = [
  "bash-gate",
  "file-gate",
  "prompt-gate",
  "stop-gate",
  "inject",
  "react",
] as const satisfies readonly DispatchKind[];
const EVERY_ROLE_LISTED: Exclude<
  DispatchKind,
  (typeof ROLES)[number]
> extends never
  ? true
  : never = true;

const TOOL_GATES: ReadonlySet<DispatchKind> = new Set([
  "bash-gate",
  "file-gate",
]);

const PAYLOADS: readonly EventPayload[] = [
  "tool",
  "prompt",
  "stop",
  "session",
  "none",
];

/** One synthetic event per (payload, veto) pair. */
const TABLE: EventCapabilityTable = {
  capturedFrom: "synthetic: every payload × veto/no-veto",
  events: Object.fromEntries(
    PAYLOADS.flatMap((carries) =>
      [true, false].map((veto) => [
        `${carries}-${veto ? "veto" : "noveto"}`,
        {
          carries,
          honours: veto ? ["veto", "inject"] : ["inject", "feedback"],
          matcher: carries === "tool",
          denyShape: "exit-code",
        },
      ]),
    ),
  ),
};

/** What the contract says a stale stamp does for this role on this synthetic event. */
function expectedFor(role: DispatchKind, event: string): StaleStampResponse {
  if (!TOOL_GATES.has(role)) return { kind: "skip", reason: "not-a-tool-gate" };
  if (event === "tool-veto") return { kind: "refuse" };
  return { kind: "skip", reason: "event-cannot-veto" };
}

describe("staleStampResponse — every role × every event shape", () => {
  test("lists every role", () => {
    expect(EVERY_ROLE_LISTED).toBe(true);
  });

  for (const role of ROLES) {
    for (const event of Object.keys(TABLE.events)) {
      test(`${role} on ${event}`, () => {
        const capability = capabilityOf(TABLE, event);
        for (const carriesToolCall of [true, false]) {
          expect(
            staleStampResponse(role, { capability, carriesToolCall }),
          ).toEqual(expectedFor(role, event));
        }
      });
    }
  }
});

describe("staleStampResponse — an event the harness has not recorded", () => {
  const unknown = capabilityOf(undefined, "PreToolUse");

  for (const role of ROLES) {
    test(`${role}: refuses only as a tool gate over a payload carrying a tool call`, () => {
      expect(
        staleStampResponse(role, {
          capability: unknown,
          carriesToolCall: true,
        }),
      ).toEqual(
        TOOL_GATES.has(role)
          ? { kind: "refuse" }
          : { kind: "skip", reason: "not-a-tool-gate" },
      );
      expect(
        staleStampResponse(role, {
          capability: unknown,
          carriesToolCall: false,
        }),
      ).toEqual(
        TOOL_GATES.has(role)
          ? { kind: "skip", reason: "event-cannot-veto" }
          : { kind: "skip", reason: "not-a-tool-gate" },
      );
    });
  }
});

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
