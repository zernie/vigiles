import { describe, it, expect } from "vitest";
import {
  normalizeHooks,
  hookEventNames,
  nonCommandHookActions,
} from "./hook-normalize.js";

describe("normalizeHooks", () => {
  it("flattens the Claude Code nested shape", () => {
    const raw = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ command: "guard.sh" }, { command: "audit.sh" }],
        },
      ],
    };
    expect(normalizeHooks(raw)).toEqual([
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "guard.sh",
        condition: null,
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "audit.sh",
        condition: null,
      },
    ]);
  });

  it("reads the Codex flat shape (no `hooks` array → entry is the command holder)", () => {
    // Codex TOML `[[hooks.SessionStart]] command="setup.sh"` loads flat.
    const raw = { SessionStart: [{ command: "setup.sh" }] };
    expect(normalizeHooks(raw)).toEqual([
      {
        event: "SessionStart",
        matcher: null,
        command: "setup.sh",
        condition: null,
      },
    ]);
  });

  it("carries the matcher as null when the entry declares none", () => {
    const raw = { Stop: [{ hooks: [{ command: "x.sh" }] }] };
    expect(normalizeHooks(raw)).toEqual([
      { event: "Stop", matcher: null, command: "x.sh", condition: null },
    ]);
  });

  it("drops empty/non-string commands and non-object entries", () => {
    const raw = {
      PreToolUse: [
        { hooks: [{ command: "" }, { command: 42 }, { command: "ok.sh" }] },
        "garbage",
        { hooks: ["nope", { nope: true }] },
      ],
    };
    expect(normalizeHooks(raw)).toEqual([
      { event: "PreToolUse", matcher: null, command: "ok.sh", condition: null },
    ]);
  });

  it("returns [] for non-object / array / null input (never throws)", () => {
    expect(normalizeHooks(null)).toEqual([]);
    expect(normalizeHooks(undefined)).toEqual([]);
    expect(normalizeHooks([{ command: "x" }])).toEqual([]);
    expect(normalizeHooks("hooks")).toEqual([]);
    expect(normalizeHooks({ PreToolUse: "not-an-array" })).toEqual([]);
  });
});

describe("hookEventNames", () => {
  it("returns the object keys for the object-keyed shape", () => {
    expect(hookEventNames({ PreToolUse: [], SessionStart: [] }).sort()).toEqual(
      ["PreToolUse", "SessionStart"],
    );
  });

  it("returns [] for an array (a non-CC custom format we don't interpret)", () => {
    expect(hookEventNames([{ event: "tool-use" }])).toEqual([]);
    expect(hookEventNames(null)).toEqual([]);
  });
});

describe("nonCommandHookActions — what normalizeHooks correctly drops", () => {
  // Codex round 2, P2. Claude Code supports five action types; `normalizeHooks`
  // keeps only `command`, correctly. But the caller read the empty list as "no
  // hooks are declared" — an accusation about the repository — when the truth
  // was "four guards this tier cannot drive".
  const raw = {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "prompt", prompt: "Is this safe?" },
          { type: "http", url: "https://example.test/h" },
          { type: "command", command: "sh guard.sh" },
        ],
      },
    ],
    PostToolUse: [{ type: "agent", agent: "reviewer" }],
  };

  it("returns the non-command actions with their event, matcher and type", () => {
    expect(nonCommandHookActions(raw)).toEqual([
      { event: "PreToolUse", matcher: "Bash", type: "prompt" },
      { event: "PreToolUse", matcher: "Bash", type: "http" },
      { event: "PostToolUse", matcher: null, type: "agent" },
    ]);
  });

  it("never returns a command action — the two readers do not overlap", () => {
    expect(nonCommandHookActions(raw).map((a) => a.type)).not.toContain(
      "command",
    );
    expect(normalizeHooks(raw)).toHaveLength(1);
  });

  it("does NOT invent an action out of malformed config", () => {
    // An entry with neither a type nor a command is junk, not a declared guard;
    // counting it would manufacture a hook the repository never wrote.
    expect(
      nonCommandHookActions({ PreToolUse: [{ matcher: "Bash" }] }),
    ).toEqual([]);
    expect(
      nonCommandHookActions({ PreToolUse: [{ hooks: [{ command: "" }] }] }),
    ).toEqual([]);
  });

  it("returns [] for malformed input and never throws", () => {
    for (const bad of [null, undefined, 42, "x", [], { PreToolUse: 3 }])
      expect(nonCommandHookActions(bad)).toEqual([]);
  });
});
