/**
 * Hook-install suite (vitest): mergeHooksJson adds to an empty/existing settings object, preserves the user's own + a sibling vigiles hook for a different file, is idempotent (recompile replaces, never duplicates), preserves non-hook top-level keys; mergeHooksToml flattens to Codex's {matcher,command} + round-trips; discoverHookFiles finds JS/TS under .vigiles/hooks excluding stamps, [] when absent
 */
import { describe, it, expect } from "vitest";
import {
  hookGateRef,
  hookRuntimeRef,
  hookRuntimeMissingExit,
  mergeHooksJson,
  mergeHooksToml,
  normalizeHookRef,
  serializeConfig,
  discoverHookFiles,
} from "./hook-install.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..");
import { tmpdir } from "node:os";
import { join } from "node:path";

const compiled = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command" as const,
          command: "npx vigiles hook-runtime run-program .vigiles/hooks/g.mjs",
        },
      ],
    },
  ],
};

describe("mergeHooksJson", () => {
  // A settings.json wired the way Claude Code's own docs recommend carries BOTH
  // a quote and $CLAUDE_PROJECT_DIR. Before 2026-08-21 neither was stripped, so
  // recompiling appended a second block beside the first — measured at twelve
  // duplicates across twelve hooks in a real repo.
  const wiredByHand = (hook: string) => ({
    matcher: "Bash",
    hooks: [
      {
        type: "command" as const,
        command: `node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/${hook}"`,
      },
    ],
  });

  it("replaces a hand-wired entry that quotes the path and uses $CLAUDE_PROJECT_DIR", () => {
    const existing = {
      hooks: { PreToolUse: [wiredByHand(".claude/hooks/x.hook.ts")] },
    };
    const compiled = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .claude/hooks/x.hook.ts",
            },
          ],
        },
      ],
    };
    const out = mergeHooksJson(existing, compiled, ".claude/hooks/x.hook.ts");
    expect(out.hooks?.PreToolUse).toHaveLength(1);
  });

  // Recompiling a hook whose wiring changed used to drop its entry and append the
  // new one at the END, so one changed command showed up in the diff as three
  // entries swapping places. Measured on a real settings.json: the DNA guard gained
  // `|| exit 2` and moved from first to last among three PreToolUse entries.
  it("replaces a recompiled hook IN PLACE, keeping the order of its neighbours", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          wiredByHand(".claude/hooks/a.hook.ts"),
          wiredByHand(".claude/hooks/x.hook.ts"),
          wiredByHand(".claude/hooks/b.hook.ts"),
        ],
      },
    };
    const recompiled = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .claude/hooks/x.hook.ts || exit 2",
            },
          ],
        },
      ],
    };
    const out = mergeHooksJson(existing, recompiled, ".claude/hooks/x.hook.ts");
    expect(
      out.hooks?.PreToolUse?.map(
        (e) => e.hooks[0]?.command.match(/\w+\.hook\.ts/)?.[0],
      ),
    ).toEqual(["a.hook.ts", "x.hook.ts", "b.hook.ts"]);
    expect(out.hooks?.PreToolUse?.[1]?.hooks[0]?.command).toContain(
      "|| exit 2",
    );
  });

  it("appends a hook that was not wired before", () => {
    const existing = {
      hooks: { PreToolUse: [wiredByHand(".claude/hooks/a.hook.ts")] },
    };
    const out = mergeHooksJson(existing, compiled, ".vigiles/hooks/g.mjs");
    expect(out.hooks?.PreToolUse?.map((e) => e.hooks[0]?.command)).toEqual([
      existing.hooks.PreToolUse[0]?.hooks[0]?.command,
      compiled.PreToolUse[0]?.hooks[0]?.command,
    ]);
  });

  // The over-match that ACTUALLY threatens this change: `$CLAUDE_PROJECT_DIR` is
  // stripped because it IS the project root by definition. Any OTHER variable
  // names an unknown location — a sibling checkout, a plugin dir — and treating
  // it as the root would delete a hook pointing somewhere else entirely.
  it("does not treat a hook under a DIFFERENT variable as this project's", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command" as const,
                command:
                  'npx vigiles hook-runtime run-program "$OTHER_REPO/.claude/hooks/x.hook.ts"',
              },
            ],
          },
        ],
      },
    };
    const compiled = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .claude/hooks/x.hook.ts",
            },
          ],
        },
      ],
    };
    const out = mergeHooksJson(existing, compiled, ".claude/hooks/x.hook.ts");
    expect(out.hooks?.PreToolUse).toHaveLength(2);
  });

  // 🔴 The over-match half, and it needed its own case: a mutation that ORs in a
  // raw `command.includes(ref)` passed the "different hook" test green, because
  // `other.hook.ts` does not contain `x.hook.ts` as a substring. Only a PREFIX
  // COLLISION separates the two rules — which is the very case the module header
  // says a substring test used to get wrong.
  it("does not swallow a hand-wired hook whose name merely ENDS WITH this one", () => {
    const existing = {
      hooks: { PreToolUse: [wiredByHand(".claude/hooks/my-x.hook.ts")] },
    };
    const compiled = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .claude/hooks/x.hook.ts",
            },
          ],
        },
      ],
    };
    const out = mergeHooksJson(existing, compiled, ".claude/hooks/x.hook.ts");
    expect(out.hooks?.PreToolUse).toHaveLength(2);
  });

  it("still keeps a hand-wired entry for a DIFFERENT hook", () => {
    const existing = {
      hooks: { PreToolUse: [wiredByHand(".claude/hooks/other.hook.ts")] },
    };
    const compiled = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .claude/hooks/x.hook.ts",
            },
          ],
        },
      ],
    };
    const out = mergeHooksJson(existing, compiled, ".claude/hooks/x.hook.ts");
    expect(out.hooks?.PreToolUse).toHaveLength(2);
  });

  it("adds the hook block to an empty settings object", () => {
    const out = mergeHooksJson({}, compiled, ".vigiles/hooks/g.mjs");
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse[0].hooks[0].command).toMatch(/g\.mjs/);
  });

  it("preserves the user's own unrelated hooks", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command" as const, command: "mine" }],
          },
        ],
      },
    };
    const out = mergeHooksJson(existing, compiled, ".vigiles/hooks/g.mjs");
    // The user's entry stays; ours is appended.
    expect(out.hooks?.PreToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse[0].hooks[0].command).toBe("mine");
  });

  // 🔴 THE SHARED-BLOCK REGRESSION, from a real `.claude/settings.json`
  // (2026-09-15). Claude Code nests SEVERAL commands under one matcher, and a
  // consumer repo's PostToolUse/`Edit|Write|MultiEdit` entry held six: four
  // vigiles hooks plus the user's own kb-lint and paper-lint. Recompiling one
  // of the four dropped the whole entry, taking both hand-written checks with
  // it — silently, since the file stayed valid and the survivors kept firing.
  //
  // BOTH HALVES, because "preserves" is unfalsifiable without the other one:
  // ours must GO and theirs must STAY. A merge that kept everything would pass
  // the first assertion alone while duplicating our command on every compile.
  const sharedBlock = () => ({
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            {
              type: "command" as const,
              command:
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/kb-lint.mjs" post',
            },
            {
              type: "command" as const,
              command:
                'node "$CLAUDE_PROJECT_DIR/.claude/hooks/paper-lint.mjs" post',
            },
            {
              type: "command" as const,
              command:
                'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/ours.mjs"',
            },
            {
              type: "command" as const,
              command:
                'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/sibling.mjs"',
            },
          ],
        },
      ],
    },
  });
  const ourBlock = {
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [
          {
            type: "command" as const,
            command:
              "npx vigiles hook-runtime run-program .vigiles/hooks/ours.mjs",
          },
        ],
      },
    ],
  };
  const commandsIn = (out: ReturnType<typeof mergeHooksJson>) =>
    (out.hooks?.PostToolUse ?? []).flatMap((e) =>
      e.hooks.map((h) => h.command),
    );

  it("keeps a co-located hand-written command when our command shares its matcher block", () => {
    const out = mergeHooksJson(
      sharedBlock(),
      ourBlock,
      ".vigiles/hooks/ours.mjs",
    );
    const cmds = commandsIn(out);
    expect(cmds.some((c) => c.includes("kb-lint.mjs"))).toBe(true);
    expect(cmds.some((c) => c.includes("paper-lint.mjs"))).toBe(true);
    // A SIBLING vigiles hook is someone else's command too, as far as this
    // compile is concerned — only `ours.mjs` is being rewritten.
    expect(cmds.some((c) => c.includes("sibling.mjs"))).toBe(true);
  });

  it("still replaces OUR command in that shared block, exactly once", () => {
    const once = mergeHooksJson(
      sharedBlock(),
      ourBlock,
      ".vigiles/hooks/ours.mjs",
    );
    const twice = mergeHooksJson(once, ourBlock, ".vigiles/hooks/ours.mjs");
    expect(
      commandsIn(twice).filter((c) => c.includes("ours.mjs")),
    ).toHaveLength(1);
    // …and the survivors survived the second pass too.
    expect(
      commandsIn(twice).filter((c) => c.includes("lint.mjs")),
    ).toHaveLength(2);
  });

  it("drops an entry we emptied, rather than leaving a matcher with no commands", () => {
    const onlyOurs = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [
              {
                type: "command" as const,
                command:
                  'node "$CLAUDE_PROJECT_DIR/node_modules/vigiles/dist/cli.js" hook-runtime run-program "$CLAUDE_PROJECT_DIR/.vigiles/hooks/ours.mjs"',
              },
            ],
          },
        ],
      },
    };
    const out = mergeHooksJson(onlyOurs, ourBlock, ".vigiles/hooks/ours.mjs");
    expect(out.hooks?.PostToolUse).toHaveLength(1);
    expect(out.hooks?.PostToolUse.every((e) => e.hooks.length > 0)).toBe(true);
  });

  it("is idempotent — recompiling replaces our entry, never duplicates", () => {
    const once = mergeHooksJson({}, compiled, ".vigiles/hooks/g.mjs");
    const twice = mergeHooksJson(once, compiled, ".vigiles/hooks/g.mjs");
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });

  // Measured 2026-08-03: `vigiles compile x.hook.ts` then
  // `vigiles compile ./x.hook.ts` appended a SECOND {matcher, hooks:[…]} block
  // for the same hook, because the merge key was the raw string the user typed
  // and `"… run-program x.hook.mjs".includes("./x.hook.mjs")` is false. A few
  // edit-compile iterations left duplicate wirings that all fire.
  it("is idempotent across path SPELLINGS of the same file", () => {
    const spellings = [
      ".vigiles/hooks/g.mjs",
      "./.vigiles/hooks/g.mjs",
      ".vigiles//hooks/g.mjs",
      ".vigiles/hooks/../hooks/g.mjs",
      join(process.cwd(), ".vigiles/hooks/g.mjs"),
    ];
    let settings = mergeHooksJson({}, compiled, spellings[0] ?? "");
    for (const spelling of spellings.slice(1)) {
      settings = mergeHooksJson(settings, compiled, spelling);
    }
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
  });

  it("replaces an entry written with a DIFFERENT spelling (migrates old dupes)", () => {
    const legacy = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command" as const,
                command:
                  "npx vigiles hook-runtime run-program ./.vigiles/hooks/g.mjs",
              },
            ],
          },
        ],
      },
    };
    const out = mergeHooksJson(legacy, compiled, ".vigiles/hooks/g.mjs");
    expect(out.hooks?.PreToolUse).toHaveLength(1);
  });

  it("does NOT treat a path that merely CONTAINS ours as the same hook", () => {
    // The old substring test said `my-g.mjs` was managed by `g.mjs`.
    const neighbour = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command" as const,
                command:
                  "npx vigiles hook-runtime run-program .vigiles/hooks/my-g.mjs",
              },
            ],
          },
        ],
      },
    };
    const out = mergeHooksJson(neighbour, compiled, ".vigiles/hooks/g.mjs");
    expect(out.hooks?.PreToolUse).toHaveLength(2);
  });

  it("keeps a sibling vigiles hook for a DIFFERENT file", () => {
    const other = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command" as const,
              command:
                "npx vigiles hook-runtime run-program .vigiles/hooks/other.mjs",
            },
          ],
        },
      ],
    };
    const first = mergeHooksJson({}, other, ".vigiles/hooks/other.mjs");
    const both = mergeHooksJson(first, compiled, ".vigiles/hooks/g.mjs");
    expect(both.hooks?.PreToolUse).toHaveLength(2);
  });

  it("preserves non-hook top-level settings keys", () => {
    const out = mergeHooksJson(
      { permissions: { allow: ["Bash"] } },
      compiled,
      ".vigiles/hooks/g.mjs",
    );
    expect(out.permissions).toEqual({ allow: ["Bash"] });
  });
});

describe("mergeHooksToml", () => {
  it("flattens to Codex's {matcher, command} shape and round-trips", () => {
    const out = mergeHooksToml({}, compiled, ".vigiles/hooks/g.mjs");
    const toml = serializeConfig(out, "toml");
    expect(toml).toMatch(/\[\[hooks\.PreToolUse\]\]/);
    expect(toml).toMatch(/matcher = "Bash"/);
    expect(toml).toMatch(/g\.mjs/);
  });

  it("is idempotent by hook path", () => {
    const once = mergeHooksToml({}, compiled, ".vigiles/hooks/g.mjs");
    const twice = mergeHooksToml(once, compiled, ".vigiles/hooks/g.mjs");
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });

  it("is idempotent across path spellings too", () => {
    const once = mergeHooksToml({}, compiled, "./.vigiles/hooks/g.mjs");
    const twice = mergeHooksToml(once, compiled, ".vigiles/hooks/g.mjs");
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });
});

describe("normalizeHookRef", () => {
  it("canonicalizes every spelling of one file to the same ref", () => {
    const cwd = process.cwd();
    const refs = [
      ".vigiles/hooks/g.mjs",
      "./.vigiles/hooks/g.mjs",
      ".vigiles/hooks/../hooks/g.mjs",
      join(cwd, ".vigiles/hooks/g.mjs"),
    ].map((p) => normalizeHookRef(p, cwd));
    expect(new Set(refs).size).toBe(1);
    expect(refs[0]).toBe(".vigiles/hooks/g.mjs");
  });

  it("keeps a path outside the cwd absolute (still stable)", () => {
    const cwd = join(tmpdir(), "vig-cwd");
    const ref = normalizeHookRef(join(tmpdir(), "elsewhere/h.mjs"), cwd);
    expect(ref.endsWith("elsewhere/h.mjs")).toBe(true);
    expect(normalizeHookRef(ref, cwd)).toBe(ref); // idempotent
  });

  it("emits POSIX separators so the ref is platform-stable", () => {
    expect(normalizeHookRef(".vigiles/hooks/g.mjs")).not.toMatch(/\\/);
  });
});

describe("discoverHookFiles", () => {
  it("finds JS/TS sources under .vigiles/hooks, excludes stamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-hooks-"));
    try {
      mkdirSync(join(dir, ".vigiles/hooks"), { recursive: true });
      writeFileSync(join(dir, ".vigiles/hooks/a.mjs"), "");
      writeFileSync(join(dir, ".vigiles/hooks/b.ts"), "");
      writeFileSync(join(dir, ".vigiles/hooks/a.mjs.json"), "{}"); // stamp
      const found = discoverHookFiles(dir);
      expect(found).toEqual([
        join(".vigiles/hooks", "a.mjs"),
        join(".vigiles/hooks", "b.ts"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-nohooks-"));
    try {
      expect(discoverHookFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hookGateRef — what compile EMITS", () => {
  const CC = ["${CLAUDE_PROJECT_DIR}", "${CLAUDE_PROJECT}"] as const;
  const wire = (ref: string, tokens: readonly string[] | undefined) => ({
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command" as const,
            command: `npx vigiles hook-runtime run-program ${hookGateRef(ref, tokens)}`,
          },
        ],
      },
    ],
  });

  // 🔴 THE REGRESSION THIS FILE NOW OWNS AT BOTH ENDS. Until 2026-09-10 `compile` emitted
  // the BARE ref — the exact spelling `bareToken`'s header calls broken ("dies with exit 2
  // the moment the agent runs from a subdirectory"). Reading was fixed 2026-08-21; writing
  // was not. Measured in a consumer repo: one `cd` into a subdirectory and a PreToolUse gate
  // failed to load — a gate that cannot load must block, so the repo seized.
  it("anchors the path at the project root when the harness has one", () => {
    expect(hookGateRef(".claude/hooks/x.hook.ts", CC)).toBe(
      '"${CLAUDE_PROJECT_DIR}/.claude/hooks/x.hook.ts"',
    );
  });

  // A harness with no such variable has nothing to anchor to; inventing one would emit a
  // command expanding to `/.claude/...` — worse than relative, and silently so.
  it("leaves the ref alone when the harness declares no project-root token", () => {
    expect(hookGateRef(".claude/hooks/x.hook.ts", undefined)).toBe(
      ".claude/hooks/x.hook.ts",
    );
    expect(hookGateRef(".claude/hooks/x.hook.ts", [])).toBe(
      ".claude/hooks/x.hook.ts",
    );
  });

  // The property that keeps a recompile idempotent instead of duplicating: what the emitter
  // writes, the matcher must recognise as the SAME hook. Asserted through the public merge.
  it("what it emits is still matched as the same hook, so a recompile REPLACES", () => {
    const ref = ".claude/hooks/x.hook.ts";
    const merged = mergeHooksJson({ hooks: wire(ref, CC) }, wire(ref, CC), ref);
    expect(merged.hooks?.PreToolUse).toHaveLength(1);
  });

  // And the pre-2026-09-10 relative spelling is replaced, so upgrading vigiles REWRITES the
  // wiring in place rather than leaving a stale relative twin beside the new one.
  it("the old relative spelling is replaced and rewritten, not duplicated", () => {
    const ref = ".claude/hooks/x.hook.ts";
    const merged = mergeHooksJson(
      { hooks: wire(ref, undefined) },
      wire(ref, CC),
      ref,
    );
    const entries = merged.hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hooks[0]?.command).toContain("${CLAUDE_PROJECT_DIR}");
  });
});

describe("hookRuntimeRef — how compile LAUNCHES the runtime", () => {
  it("addresses the local install, so no invocation pays for an npx resolve", () => {
    expect(hookRuntimeRef(["${CLAUDE_PROJECT_DIR}"])).toBe(
      'node "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js"',
    );
    // Measured 2026-09-19, warm cache, five runs each: 193 ms here against
    // 2545 ms through `npx`, on every tool call, because npx re-resolves the
    // package each time — local, then global, then the registry.
    expect(hookRuntimeRef(["${CLAUDE_PROJECT_DIR}"])).not.toMatch(/\bnpx\b/);
  });

  it("falls back to the relative spelling when the harness has no root token", () => {
    expect(hookRuntimeRef(undefined)).toBe(
      "node node_modules/vigiles/dist/cli.js",
    );
  });
});

describe("hookRuntimeMissingExit — what the SHELL does when the runtime cannot start", () => {
  // No code of ours runs in that case, so this is the only place the policy can
  // live. It is not a new policy: the runtime's own load-failure branch has said
  // since 2026-08 that gates fail closed and injects degrade gracefully. This
  // carries the same rule one layer out.
  it("BLOCKS for every gate — a gate that silently passes is worse than no gate", () => {
    expect(hookRuntimeMissingExit("bash-gate")).toBe(2);
    expect(hookRuntimeMissingExit("file-gate")).toBe(2);
    expect(hookRuntimeMissingExit("prompt-gate")).toBe(2);
    expect(hookRuntimeMissingExit("stop-gate")).toBe(2);
  });

  it("PASSES for every nudge — a reminder is never worth a wedged repository", () => {
    // Measured here 2026-08-10: merge-conflict markers in package.json stopped
    // every hook loading, and the Bash gate then refused `git merge --abort` —
    // the one command that undoes the cause.
    expect(hookRuntimeMissingExit("inject")).toBe(0);
    expect(hookRuntimeMissingExit("react")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The migration itself, end to end, because changing the emitted command is
// only safe if a recompile RECOGNISES the old spelling as the same hook.
// `bareToken`/`managesHook` exist for exactly this, and this is the run that
// proves they still cover the form 27.x wrote into users' settings.
// ---------------------------------------------------------------------------
describe("recompiling over the previous launcher", () => {
  it("REPLACES the npx form rather than appending a second block", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-migrate-"));
    try {
      mkdirSync(join(dir, ".vigiles", "hooks"), { recursive: true });
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      symlinkSync(REPO, join(dir, "node_modules", "vigiles"));
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"name":"t"}\n');
      writeFileSync(
        join(dir, ".vigiles", "hooks", "gate.mjs"),
        'import { experimental_defineHook, allow } from "vigiles/hook";\n' +
          'export default experimental_defineHook({ on: "PreToolUse", decide: () => allow() });\n',
      );
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command:
                      'npx vigiles hook-runtime run-program "${CLAUDE_PROJECT_DIR}/.vigiles/hooks/gate.mjs"',
                  },
                ],
              },
            ],
          },
        }),
      );

      execFileSync("node", [join(REPO, "dist", "cli.js"), "compile"], {
        cwd: dir,
        stdio: "ignore",
      });

      const after = JSON.parse(
        readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
      ) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      const commands = Object.values(after.hooks)
        .flat()
        .flatMap((g) => g.hooks)
        .map((h) => h.command);

      // ONE, not two. A second entry here means every existing user grows a
      // duplicate hook on their next compile.
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("node_modules/vigiles/dist/cli.js");
      expect(commands[0]).not.toMatch(/\bnpx\b/);
      expect(commands[0]).toMatch(/\|\| exit 2$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
