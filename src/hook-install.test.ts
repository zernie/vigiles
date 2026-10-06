/**
 * Hook-install suite (vitest): mergeHooksJson adds to an empty/existing settings object, preserves the user's own + a sibling vigiles hook for a different file, is idempotent (recompile replaces, never duplicates), preserves non-hook top-level keys; mergeHooksToml flattens to Codex's {matcher,command} + round-trips; discoverHookFiles finds JS/TS under .vigiles/hooks excluding stamps, [] when absent
 */
import { describe, it, expect } from "vitest";
import {
  hookGateRef,
  hookRuntimeRef,
  mergeHooksJson,
  mergeHooksToml,
  normalizeHookRef,
  serializeConfig,
  discoverHookFiles,
  discoverProviderFiles,
  partitionHookArgs,
  renameCommand,
  invalidArgMessage,
  unclaimedMessage,
} from "./hook-install.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

describe("discoverHookFiles / discoverProviderFiles", () => {
  // The contributor's report (#278): a harness test colocated beside a hook was
  // compiled AS a hook. Kept as the spine of this test, with the expectation
  // restated for the rule that replaced the name-subtraction patch: a hook is a
  // `.hook.` file and nothing else, so the question is no longer which
  // companions to exclude — a companion is simply not a hook.
  it.each(["mjs", "cjs", "js", "mts", "cts", "ts"])(
    "claims only the marked file, refuses the unmarked, leaves tests/declarations/stamps alone (.%s)",
    (ext) => {
      const dir = mkdtempSync(join(tmpdir(), "vig-companions-"));
      const files = [
        `gate.${ext}`, // a hook from before the marker: nobody's
        `gate.hook.${ext}`,
        `harness-check.${ext}`, // contains the word, carries no marker
        `test-tier-nudge.hook.${ext}`,
        `gate.harness.helper.${ext}`,
        `gate.test.helper.${ext}`,
        `gate.provider.${ext}`,
        `gate.harness.${ext}`, // a vigiles test: neither hook nor error
        `gate.eval.${ext}`,
        `gate.test.${ext}`, // a default vitest/jest name: vigiles runs none of those
        `gate.hook.test.${ext}`,
        "gate.d.ts",
        "gate.hook.mjs.json",
        "README.md",
      ];
      try {
        for (const sourceDir of [".vigiles/hooks", ".vigiles/providers"]) {
          mkdirSync(join(dir, sourceDir), { recursive: true });
          for (const file of files)
            writeFileSync(join(dir, sourceDir, file), "");
        }
        const at = (d: string) => (names: string[]) =>
          names.sort().map((f) => join(d, f));

        const hooks = discoverHookFiles(dir);
        expect(hooks.claimed).toEqual(
          at(".vigiles/hooks")([
            `gate.hook.${ext}`,
            `test-tier-nudge.hook.${ext}`,
          ]),
        );
        expect(hooks.unclaimed).toEqual(
          at(".vigiles/hooks")([
            `gate.${ext}`,
            `harness-check.${ext}`,
            `gate.harness.helper.${ext}`,
            `gate.test.helper.${ext}`,
            `gate.provider.${ext}`, // a provider in the hooks directory is nobody's there
            `gate.test.${ext}`,
            `gate.hook.test.${ext}`,
          ]),
        );

        const providers = discoverProviderFiles(dir);
        expect(providers.claimed).toEqual(
          at(".vigiles/providers")([`gate.provider.${ext}`]),
        );
        expect(providers.unclaimed).toEqual(
          at(".vigiles/providers")([
            `gate.${ext}`,
            `gate.hook.${ext}`,
            `harness-check.${ext}`,
            `test-tier-nudge.hook.${ext}`,
            `gate.harness.helper.${ext}`,
            `gate.test.helper.${ext}`,
            `gate.test.${ext}`,
            `gate.hook.test.${ext}`,
          ]),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("finds `.hook.` sources under .vigiles/hooks, excludes stamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-hooks-"));
    try {
      mkdirSync(join(dir, ".vigiles/hooks"), { recursive: true });
      writeFileSync(join(dir, ".vigiles/hooks/a.hook.mjs"), "");
      writeFileSync(join(dir, ".vigiles/hooks/b.hook.ts"), "");
      writeFileSync(join(dir, ".vigiles/hooks/a.hook.mjs.json"), "{}"); // stamp
      expect(discoverHookFiles(dir)).toEqual({
        claimed: [
          join(".vigiles/hooks", "a.hook.mjs"),
          join(".vigiles/hooks", "b.hook.ts"),
        ],
        unclaimed: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds nothing when the dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "vig-nohooks-"));
    try {
      expect(discoverHookFiles(dir)).toEqual({ claimed: [], unclaimed: [] });
      expect(discoverProviderFiles(dir)).toEqual({
        claimed: [],
        unclaimed: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("partitionHookArgs", () => {
  // The probe is injected so the pure rules can be asserted without a disk; the
  // CLI tests below run the real one.
  const files = (p: string): "file" | "directory" =>
    p.endsWith("/") ? "directory" : "file";

  it("sorts explicit paths with the same classifier discovery uses", () => {
    expect(
      partitionHookArgs(
        [
          ".vigiles/hooks/a.hook.ts",
          ".claude/hooks/elsewhere.hook.mjs", // a marked hook anywhere is a hook
          ".vigiles/hooks/old.mjs",
          ".vigiles/hooks/a.harness.mjs",
          ".vigiles/hooks/a.hook.ts.json",
        ],
        files,
      ),
    ).toEqual({
      hooks: [".vigiles/hooks/a.hook.ts", ".claude/hooks/elsewhere.hook.mjs"],
      unclaimed: [".vigiles/hooks/old.mjs"],
      skipped: [
        { path: ".vigiles/hooks/a.harness.mjs", kind: "vigiles-test" },
        { path: ".vigiles/hooks/a.hook.ts.json", kind: "stamp" },
      ],
      invalid: [],
    });
  });

  it("applies to explicit paths ANYWHERE: a plugin or .claude hook without the marker is refused too", () => {
    const r = partitionHookArgs(
      [".claude/hooks/x.mjs", "node_modules/plug/hooks/guard.mjs"],
      files,
    );
    expect(r.hooks).toEqual([]);
    expect(r.unclaimed).toEqual([
      ".claude/hooks/x.mjs",
      "node_modules/plug/hooks/guard.mjs",
    ]);
  });

  it("a path that is missing, a directory, or not a source at all is an error, not a skip", () => {
    const probe = (p: string) =>
      p === "nope/typo.json"
        ? ("missing" as const)
        : p === ".vigiles/hooks"
          ? ("directory" as const)
          : ("file" as const);
    expect(
      partitionHookArgs(
        [
          "nope/typo.json",
          ".vigiles/hooks",
          "/etc/passwd",
          "README.md",
          "src/guard.d.ts",
        ],
        probe,
      ),
    ).toEqual({
      hooks: [],
      unclaimed: [],
      skipped: [{ path: "src/guard.d.ts", kind: "declaration" }],
      invalid: [
        { path: "nope/typo.json", reason: "missing" },
        { path: ".vigiles/hooks", reason: "directory" },
        { path: "/etc/passwd", reason: "not-a-source" },
        { path: "README.md", reason: "not-a-source" },
      ],
    });
  });

  it("a README the shell glob swept up inside the vigiles source directories is skipped, not an error", () => {
    expect(
      partitionHookArgs(
        [".vigiles/hooks/README.md", ".vigiles/providers/.gitkeep"],
        files,
      ),
    ).toMatchObject({
      invalid: [],
      skipped: [
        { path: ".vigiles/hooks/README.md", kind: "non-source" },
        { path: ".vigiles/providers/.gitkeep", kind: "non-source" },
      ],
    });
  });

  it("a provider named explicitly is skipped, except where it does not belong", () => {
    const r = partitionHookArgs(
      [".vigiles/providers/k.provider.mjs", ".vigiles/hooks/k.provider.mjs"],
      files,
    );
    expect(r.skipped).toEqual([
      { path: ".vigiles/providers/k.provider.mjs", kind: "provider" },
    ]);
    expect(r.unclaimed).toEqual([".vigiles/hooks/k.provider.mjs"]);
  });

  it("reads Windows paths: both separators are directory separators", () => {
    const r = partitionHookArgs(
      [
        ".vigiles\\hooks\\a.hook.mjs",
        ".vigiles\\hooks\\old.mjs",
        ".vigiles\\hooks\\README.md",
      ],
      files,
    );
    expect(r.hooks).toEqual([".vigiles\\hooks\\a.hook.mjs"]);
    expect(r.unclaimed).toEqual([".vigiles\\hooks\\old.mjs"]);
    expect(r.skipped).toEqual([
      { path: ".vigiles\\hooks\\README.md", kind: "non-source" },
    ]);
  });
});

describe("invalidArgMessage", () => {
  it("says what is wrong with each kind of bad argument", () => {
    expect(invalidArgMessage("a/b.json", "missing")).toMatch(/no such file/);
    expect(invalidArgMessage(".vigiles/hooks", "directory")).toMatch(
      /is a directory/,
    );
    expect(invalidArgMessage("/etc/passwd", "not-a-source")).toMatch(
      /not a hook source/,
    );
  });
});

describe("unclaimedMessage", () => {
  it("names the rename for a hook, copy first and delete last, ending in a recompile of the NEW path", () => {
    const m = unclaimedMessage(".vigiles/hooks/guard.mjs", "hook");
    expect(m).toContain(
      "cp -n -- '.vigiles/hooks/guard.mjs' '.vigiles/hooks/guard.hook.mjs' && " +
        "npx vigiles compile '.vigiles/hooks/guard.hook.mjs' && " +
        "rm -f -- '.vigiles/hooks/guard.mjs' '.vigiles/hooks/guard.mjs.json'",
    );
    expect(m.startsWith(".vigiles/hooks/guard.mjs — not compiled")).toBe(true);
    expect(m).toContain("not a hook, move it out");
  });

  it("reads Windows paths: the target and the directory are found with either separator", () => {
    const m = unclaimedMessage("C:\\repo\\.vigiles\\hooks\\guard.mjs", "hook");
    expect(m).toContain("guard.hook.mjs");
    expect(m).toContain("move it out of C:\\repo\\.vigiles\\hooks\\");
  });

  it("when the marked name ALREADY EXISTS it names both files and prints no copy command", () => {
    const m = unclaimedMessage(".vigiles/hooks/guard.mjs", "hook", true);
    expect(m).toContain(".vigiles/hooks/guard.mjs");
    expect(m).toContain(".vigiles/hooks/guard.hook.mjs");
    expect(m).toMatch(/already exists/);
    expect(m).toMatch(/by hand/);
    expect(m).not.toContain("cp ");
    expect(m).not.toContain("rm ");
  });

  it("names a plain rename for a provider (providers are never wired by path)", () => {
    expect(unclaimedMessage(".vigiles/providers/k8s.ts", "provider")).toContain(
      "mv -n -- '.vigiles/providers/k8s.ts' '.vigiles/providers/k8s.provider.ts'",
    );
  });

  it("says where a misplaced marked file belongs instead of suggesting a rename", () => {
    const m = unclaimedMessage(".vigiles/hooks/k8s.provider.ts", "hook");
    expect(m).toContain("belongs in .vigiles/providers/");
    expect(m).not.toContain("cp ");
  });
});

describe("mergeHooksJson / mergeHooksToml: a marked hook takes over its pre-marker wiring", () => {
  const wiring = (file: string, matcher = "Bash") => ({
    matcher,
    hooks: [
      {
        type: "command" as const,
        command: `node "\${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "\${CLAUDE_PROJECT_DIR}/.vigiles/hooks/${file}" || exit 2`,
      },
    ],
  });
  const fresh = {
    PreToolUse: [wiring("guard.hook.mjs")],
  };

  it("replaces the entry an older vigiles wrote for guard.mjs, in the same slot, leaving others", () => {
    const user = {
      matcher: "Bash",
      hooks: [{ type: "command" as const, command: "./my-own-check.sh" }],
    };
    const out = mergeHooksJson(
      {
        hooks: {
          PreToolUse: [user, wiring("guard.mjs"), wiring("other.hook.mjs")],
        },
      },
      fresh,
      ".vigiles/hooks/guard.hook.mjs",
    );
    expect(out.hooks?.PreToolUse).toEqual([
      user,
      wiring("guard.hook.mjs"),
      wiring("other.hook.mjs"),
    ]);
  });

  it("does NOT treat an unrelated unmarked hook as owned", () => {
    const out = mergeHooksJson(
      { hooks: { PreToolUse: [wiring("other.mjs")] } },
      fresh,
      ".vigiles/hooks/guard.hook.mjs",
    );
    expect(out.hooks?.PreToolUse).toEqual([
      wiring("other.mjs"),
      wiring("guard.hook.mjs"),
    ]);
  });

  it("an unmarked path owns only itself (there is no earlier name to take over)", () => {
    const out = mergeHooksJson(
      { hooks: { PreToolUse: [wiring("guard.hook.mjs")] } },
      { PreToolUse: [wiring("guard.mjs")] },
      ".vigiles/hooks/guard.mjs",
    );
    expect(out.hooks?.PreToolUse).toEqual([
      wiring("guard.hook.mjs"),
      wiring("guard.mjs"),
    ]);
  });

  it("the TOML merge takes over the same way", () => {
    const flat = (file: string) => ({
      matcher: "Bash",
      command: wiring(file).hooks[0].command,
    });
    const out = mergeHooksToml(
      { hooks: { PreToolUse: [flat("guard.mjs")] } },
      fresh,
      ".vigiles/hooks/guard.hook.mjs",
    );
    expect(out.hooks?.PreToolUse).toEqual([flat("guard.hook.mjs")]);
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
        join(dir, ".vigiles", "hooks", "gate.hook.mjs"),
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
                      'npx vigiles hook-runtime run-program "${CLAUDE_PROJECT_DIR}/.vigiles/hooks/gate.hook.mjs"',
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
        .map((h) => h.command)
        // The start-of-session check is an extra entry on purpose. It is not a
        // duplicate of this hook, which is what this test counts.
        .filter((c) => !c.includes("hook-check.sh"));

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

// ---------------------------------------------------------------------------
// `vigiles compile` over a directory holding more than hooks (#278), through the
// real built CLI: what is wired, what is printed, the exit code.
// ---------------------------------------------------------------------------
describe("vigiles compile over a mixed .vigiles/hooks/ directory", () => {
  const HOOK =
    'import { experimental_defineHook, allow } from "vigiles/hook";\n' +
    'export default experimental_defineHook({ on: "PreToolUse", decide: () => allow() });\n';
  const PROVIDER =
    'import { defineProvider } from "vigiles/hook";\n' +
    'export default defineProvider({ name: "who", run: "git config user.name" });\n';

  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "vig-mixed-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(REPO, join(dir, "node_modules", "vigiles"));
    writeFileSync(join(dir, "package.json"), '{"name":"t"}\n');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return dir;
  }
  const compile = (dir: string, ...args: string[]) => {
    const r = spawnSync(
      "node",
      [join(REPO, "dist", "cli.js"), "compile", ...args],
      {
        cwd: dir,
        encoding: "utf-8",
      },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const wiredPaths = (dir: string): string[] => {
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    return Object.values(settings.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command))
      .flatMap((c) => /\.vigiles\/hooks\/([\w.-]+?)"/.exec(c)?.[1] ?? []);
  };

  it("a harness test beside its hook is not compiled, not reported, and the build is green (#278)", () => {
    const dir = repo({
      ".vigiles/hooks/task-list-nudge.hook.ts": HOOK,
      ".vigiles/hooks/task-list-nudge.harness.mjs": "export {};\n",
      ".vigiles/hooks/task-list-nudge.eval.mjs": "export {};\n",
    });
    try {
      const r = compile(dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Compilation complete.");
      expect(r.out).not.toContain("harness.mjs");
      expect(r.out).not.toContain("eval.mjs");
      expect(wiredPaths(dir)).toEqual(["task-list-nudge.hook.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unmarked hook is refused out loud with the exact fix, exit 1, and the good hooks still compile", () => {
    const dir = repo({
      ".vigiles/hooks/old.mjs": HOOK,
      ".vigiles/hooks/fine.hook.mjs": HOOK,
    });
    try {
      const r = compile(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "✗ .vigiles/hooks/old.mjs — not compiled: a hook source must carry `.hook.`",
      );
      expect(r.out).toContain(
        "cp -n -- '.vigiles/hooks/old.mjs' '.vigiles/hooks/old.hook.mjs' && " +
          "npx vigiles compile '.vigiles/hooks/old.hook.mjs' && " +
          "rm -f -- '.vigiles/hooks/old.mjs' '.vigiles/hooks/old.mjs.json'",
      );
      expect(r.out).toContain("Compilation complete with errors.");
      expect(wiredPaths(dir)).toEqual(["fine.hook.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a directory holding ONLY unmarked files is an error, not 'no hook files found'", () => {
    const dir = repo({ ".vigiles/hooks/old.mjs": HOOK });
    try {
      const r = compile(dir);
      expect(r.code).toBe(1);
      expect(r.out).not.toContain(
        "No .spec.ts or .vigiles/hooks/ hook files found",
      );
      expect(r.out).toContain("old.mjs — not compiled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`compile <file>` asks the same question: an unmarked path is refused, a test or stamp is skipped aloud", () => {
    const dir = repo({
      ".vigiles/hooks/old.mjs": HOOK,
      ".vigiles/hooks/a.harness.mjs": "export {};\n",
    });
    try {
      const refused = compile(dir, ".vigiles/hooks/old.mjs");
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("old.mjs — not compiled");

      const skipped = compile(dir, ".vigiles/hooks/a.harness.mjs");
      expect(skipped.code).toBe(0);
      expect(skipped.out).toContain(
        "- .vigiles/hooks/a.harness.mjs skipped: a vigiles-test, not a hook.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the marker rename: compiling x.hook.mjs takes over the wiring written for x.mjs, leaving no dead entry", () => {
    const dir = repo({ ".vigiles/hooks/gate.hook.mjs": HOOK });
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
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
                      'node "${CLAUDE_PROJECT_DIR}/node_modules/vigiles/dist/cli.js" hook-runtime run-program "${CLAUDE_PROJECT_DIR}/.vigiles/hooks/gate.mjs" || exit 2',
                  },
                ],
              },
            ],
          },
        }),
      );
      const r = compile(dir, ".vigiles/hooks/gate.hook.mjs");
      expect(r.code).toBe(0);
      expect(wiredPaths(dir)).toEqual(["gate.hook.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unmarked provider fails the compile naming the rename; a test beside a provider does not", () => {
    const dir = repo({
      ".vigiles/hooks/h.hook.mjs": HOOK,
      ".vigiles/providers/who.mjs": PROVIDER,
      ".vigiles/providers/who.harness.mjs": "export {};\n",
    });
    try {
      const r = compile(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "mv -n -- '.vigiles/providers/who.mjs' '.vigiles/providers/who.provider.mjs'",
      );
      expect(r.out).not.toContain("who.harness.mjs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit paths that are not files are errors: a directory, an unexpanded glob, a typo, /etc/passwd", () => {
    const dir = repo({ ".vigiles/hooks/h.hook.mjs": HOOK });
    try {
      for (const bad of [
        ".vigiles/hooks",
        ".vigiles/hooks/*",
        "nonexistent/typo.json",
        "/etc/passwd",
      ]) {
        const r = compile(dir, bad);
        expect(r.code, `${bad}: ${r.out}`).toBe(1);
        expect(r.out).toContain(`✗ ${bad} — `);
        expect(r.out).not.toContain("Compilation complete.");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a run in which every path was skipped says NOTHING was compiled, not 'Compilation complete.'", () => {
    const dir = repo({
      ".vigiles/hooks/a.harness.mjs": "export {};\n",
      ".vigiles/hooks/README.md": "# notes\n",
    });
    try {
      const r = compile(
        dir,
        ".vigiles/hooks/a.harness.mjs",
        ".vigiles/hooks/README.md",
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain("Nothing was compiled");
      expect(r.out).not.toContain("Compilation complete.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with BOTH guard.mjs and guard.hook.mjs present the message names both and prints no command that could overwrite", () => {
    const dir = repo({
      ".vigiles/hooks/guard.mjs": HOOK + "// OLD, WEAKER\n",
      ".vigiles/hooks/guard.hook.mjs": HOOK + "// EDITED, STRONGER\n",
    });
    try {
      const r = compile(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("guard.mjs");
      expect(r.out).toContain("already exists");
      expect(r.out).not.toContain("cp ");
      expect(
        readFileSync(join(dir, ".vigiles/hooks/guard.hook.mjs"), "utf-8"),
      ).toContain("EDITED, STRONGER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every unmarked provider gets its own ✗, and with ALL hooks unmarked one compile shows the provider problem too", () => {
    const dir = repo({
      ".vigiles/hooks/old.mjs": HOOK,
      ".vigiles/providers/a.mjs": PROVIDER,
      ".vigiles/providers/b.mjs": PROVIDER.replace('"who"', '"who2"'),
    });
    try {
      const r = compile(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("✗ .vigiles/hooks/old.mjs — not compiled");
      expect(r.out).toContain("✗ .vigiles/providers/a.mjs — not compiled");
      expect(r.out).toContain("✗ .vigiles/providers/b.mjs — not compiled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compile never imports a colocated test or helper: their side effects leave no marker", () => {
    const touch = (name: string) =>
      `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../../${name}", import.meta.url), "ran");\n`;
    const dir = repo({
      ".vigiles/hooks/fine.hook.mjs": HOOK,
      ".vigiles/hooks/fine.harness.mjs": touch("RAN-harness"),
      ".vigiles/hooks/fine.eval.mjs": touch("RAN-eval"),
      ".vigiles/hooks/fine.test.mjs": touch("RAN-test"),
      ".vigiles/hooks/helper.mjs": touch("RAN-helper"),
      ".vigiles/providers/p.harness.mjs": touch("RAN-pharness"),
    });
    try {
      const r = compile(dir);
      // helper.mjs and fine.test.mjs are unclaimed, so the run is red — and
      // still imported nothing.
      expect(r.code).toBe(1);
      expect(readdirSync(dir).filter((f) => f.startsWith("RAN-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a marked provider compiles cleanly beside its harness test", () => {
    const dir = repo({
      ".vigiles/hooks/h.hook.mjs": HOOK,
      ".vigiles/providers/who.provider.mjs": PROVIDER,
      ".vigiles/providers/who.harness.mjs": "export {};\n",
    });
    try {
      const r = compile(dir);
      expect(r.out).toContain("Compilation complete.");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The printed command is a copy-paste payload, so it is EXECUTED here, in a temp
// directory, against hostile and awkward file names. `npx` is a shim that records
// its argv, so what is asserted is what a shell really did with the text.
// ---------------------------------------------------------------------------
describe("renameCommand, executed", () => {
  const NAMES = [
    "plain.mjs",
    "my guard.mjs",
    "it's.mjs",
    "x;touch PWNED;.mjs",
    "$(touch PWNED).mjs",
    "`touch PWNED`.mjs",
    "a\nb.mjs",
    'dq"uote.mjs',
    "back\\slash.mjs",
    "star*.mjs",
  ];

  function sandbox(): { dir: string; bin: string } {
    const dir = mkdtempSync(join(tmpdir(), "vig-rename-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npx"),
      '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$SHIM_OUT"\n',
      { mode: 0o755 },
    );
    mkdirSync(join(dir, "w", ".vigiles", "hooks"), { recursive: true });
    return { dir, bin };
  }

  const run = (command: string, cwd: string, bin: string, out: string) =>
    spawnSync("sh", ["-c", command], {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SHIM_OUT: out,
      },
    });

  it.each(NAMES)(
    "%j: the target is created, the old file and stamp go, nothing else runs",
    (name) => {
      const { dir, bin } = sandbox();
      try {
        const cwd = join(dir, "w");
        const src = `.vigiles/hooks/${name}`;
        const target = markedNameFor(src);
        writeFileSync(join(cwd, src), "OLD");
        writeFileSync(join(cwd, `${src}.json`), "{}");
        const out = join(dir, "argv");
        const r = run(renameCommand(src, "hook"), cwd, bin, out);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(join(cwd, target), "utf-8")).toBe("OLD");
        expect(existsSync(join(cwd, src))).toBe(false);
        expect(existsSync(join(cwd, `${src}.json`))).toBe(false);
        // The shell treated the name as ONE argument: this is what `npx` received.
        expect(readFileSync(out, "utf-8").split("\0").slice(0, -1)).toEqual([
          "vigiles",
          "compile",
          target,
        ]);
        // …and nothing in the name was executed as a command.
        expect(existsSync(join(cwd, "PWNED"))).toBe(false);
        expect(readdirSync(cwd).sort()).toEqual([".vigiles"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("never overwrites a marked file that is already there (cp -n), and stops the chain", () => {
    const { dir, bin } = sandbox();
    try {
      const cwd = join(dir, "w");
      writeFileSync(join(cwd, ".vigiles/hooks/guard.mjs"), "OLD, WEAKER");
      writeFileSync(
        join(cwd, ".vigiles/hooks/guard.hook.mjs"),
        "EDITED, STRONGER",
      );
      const out = join(dir, "argv");
      run(renameCommand(".vigiles/hooks/guard.mjs", "hook"), cwd, bin, out);
      expect(
        readFileSync(join(cwd, ".vigiles/hooks/guard.hook.mjs"), "utf-8"),
      ).toBe("EDITED, STRONGER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the provider form is a single quoted mv", () => {
    const { dir, bin } = sandbox();
    try {
      const cwd = join(dir, "w");
      mkdirSync(join(cwd, ".vigiles/providers"), { recursive: true });
      writeFileSync(join(cwd, ".vigiles/providers/it's a.mjs"), "P");
      const r = run(
        renameCommand(".vigiles/providers/it's a.mjs", "provider"),
        cwd,
        bin,
        join(dir, "argv"),
      );
      expect(r.status, r.stderr).toBe(0);
      expect(
        readFileSync(
          join(cwd, ".vigiles/providers/it's a.provider.mjs"),
          "utf-8",
        ),
      ).toBe("P");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what the message prints", () => {
    const p = ".vigiles/hooks/my guard.mjs";
    expect(unclaimedMessage(p, "hook")).toContain(renameCommand(p, "hook"));
  });
});

const markedNameFor = (p: string): string => {
  const i = p.lastIndexOf(".");
  return `${p.slice(0, i)}.hook${p.slice(i)}`;
};
