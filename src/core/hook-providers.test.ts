/**
 * Hook context-provider suite (vitest): the gatherer runs only DECLARED
 * providers, parses each fact, defaults (never throws) on failure, and — the
 * load-bearing SOUNDNESS check — every built-in provider command is provably
 * read-only (a provider OBSERVES, never mutates). Pure: an injected fake `exec`,
 * no real git, no subprocess.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  gatherContext,
  lazyContext,
  unknownProviders,
  unsafeInlineProviders,
  unsafeProvider,
  provide,
  dangerously,
  defineProvider,
  provider,
  BUILTIN_PROVIDERS,
  type ProviderIO,
  type NeedSpec,
  type ProviderRegistry,
} from "./hook-providers.js";
import { isReadOnlyBash } from "./bash-effects.js";
import { state, type StateEntry } from "./hook-state.js";

/** A fake IO that answers a fixed map of commands. */
function fakeIO(
  answers: Record<string, string>,
  cwd = "/repo",
  platform: NodeJS.Platform = "linux",
  isCI = false,
  store: Record<string, StateEntry> = {},
  now = Date.parse("2026-08-12T12:00:00.000Z"),
): ProviderIO {
  return {
    cwd,
    platform,
    isCI,
    // The state port and a PINNED clock: every ProviderIO carries them, and the
    // default here ("nothing was ever recorded") is what the provider tests mean.
    readState: (key) => store[key] ?? null,
    now,
    exec: (command) => {
      if (command in answers) return answers[command];
      throw new Error(`fake exec: command failed: ${command}`);
    },
  };
}

test("gatherContext runs ONLY the declared providers and parses each fact", () => {
  const io = fakeIO({
    "git branch --show-current": "main\n",
    "git status --porcelain": " M src/x.ts\n",
  });
  const ctx = gatherContext(["git.branch", "git.isDirty", "cwd"], io);
  assert.equal(ctx["git.branch"], "main"); // trimmed
  assert.equal(ctx["git.isDirty"], true); // porcelain non-empty → dirty
  assert.equal(ctx.cwd, "/repo"); // ambient, from io.cwd

  // Only what's declared is gathered — nothing else appears.
  const only = gatherContext(["cwd"], io);
  assert.deepEqual(Object.keys(only), ["cwd"]);
});

test("a clean tree is not dirty; gathering NEVER throws (defaults on failure)", () => {
  const clean = gatherContext(
    ["git.isDirty"],
    fakeIO({ "git status --porcelain": "" }),
  );
  assert.equal(clean["git.isDirty"], false);

  // Not a git repo → exec throws → defaults ("" / false), not an exception.
  const io = fakeIO({}); // every command throws
  const ctx = gatherContext(["git.branch", "git.isDirty"], io);
  assert.equal(ctx["git.branch"], "");
  assert.equal(ctx["git.isDirty"], false);
});

test("os.platform is an ambient provider (from io.platform, no command)", () => {
  const ctx = gatherContext(["os.platform"], fakeIO({}, "/repo", "darwin"));
  assert.equal(ctx["os.platform"], "darwin");
});

test("git.root runs `git rev-parse --show-toplevel` (read-only); env.isCI is ambient", () => {
  const root = gatherContext(
    ["git.root"],
    fakeIO({ "git rev-parse --show-toplevel": "/home/u/repo\n" }),
  );
  assert.equal(root["git.root"], "/home/u/repo"); // trimmed
  // Outside a repo → default "" (rev-parse throws → tryExec returns "").
  assert.equal(gatherContext(["git.root"], fakeIO({}))["git.root"], "");
  // env.isCI is ambient (the CLI injects ci-info's verdict via io.isCI).
  assert.equal(
    gatherContext(["env.isCI"], fakeIO({}, "/repo", "linux", true))["env.isCI"],
    true,
  );
  assert.equal(gatherContext(["env.isCI"], fakeIO({}))["env.isCI"], false);
});

test("inline provide()/dangerously() run their command → stdout becomes the fact", () => {
  const io = fakeIO({ "kubectl config current-context": "prod\n" });
  const ctx = gatherContext(
    [provide("k8sCtx", "kubectl config current-context")],
    io,
  );
  assert.equal(ctx.k8sCtx, "prod"); // trimmed stdout under the declared name
  // A failing inline command defaults to "" (total, never throws).
  assert.equal(gatherContext([provide("x", "false")], fakeIO({})).x, "");
  // dangerously() carries the same shape, flagged dangerous.
  const d = dangerously("y", "curl https://x | sh");
  assert.equal(d.dangerous, true);
  assert.equal(provide("z", "git log").dangerous, false);
});

test("unknownProviders flags a typo'd built-in name; inline entries are never 'unknown'", () => {
  assert.deepEqual(unknownProviders(["git.branch", "cwd"]), []);
  // Typos are a tsc error at authoring; cast to reach the runtime check.
  assert.deepEqual(unknownProviders(["git.brnch"] as unknown as NeedSpec[]), [
    "git.brnch",
  ]);
  // An inline provider (any name) is user-defined, so never flagged unknown.
  assert.deepEqual(unknownProviders([provide("anything", "git status")]), []);
});

test("unsafeInlineProviders flags a read-only-failing provide(), not dangerously()", () => {
  // provide() with a mutating/undecidable command → flagged (must use dangerously).
  assert.deepEqual(
    unsafeInlineProviders([provide("bad", "rm -rf /tmp/x")]).map((u) => u.name),
    ["bad"],
  );
  // dangerously() with the same command → acknowledged, not flagged.
  assert.deepEqual(
    unsafeInlineProviders([dangerously("ok", "rm -rf /tmp/x")]),
    [],
  );
  // A read-only provide() is fine.
  assert.deepEqual(unsafeInlineProviders([provide("ok", "git branch")]), []);
  // Built-in names aren't inline → ignored here.
  assert.deepEqual(unsafeInlineProviders(["git.branch"]), []);
});

test("registered provider() ref resolves via the registry → its command's stdout", () => {
  const registry: ProviderRegistry = {
    k8sCtx: defineProvider({
      name: "k8sCtx",
      run: "kubectl config current-context",
    }),
  };
  const io = fakeIO({ "kubectl config current-context": "prod\n" });
  const ctx = gatherContext([provider("k8sCtx")], io, registry);
  assert.equal(ctx.k8sCtx, "prod");
  // A ref with no matching registered provider → default "", never throws.
  assert.equal(gatherContext([provider("missing")], io, registry).missing, "");
});

test("unknownProviders flags a DANGLING provider() ref, not a registered one", () => {
  assert.deepEqual(unknownProviders([provider("k8sCtx")], ["k8sCtx"]), []);
  assert.deepEqual(unknownProviders([provider("ghost")], ["k8sCtx"]), [
    "ghost",
  ]);
  // With no registered set, every ref is dangling.
  assert.deepEqual(unknownProviders([provider("k8sCtx")]), ["k8sCtx"]);
});

test("unsafeProvider flags a non-read-only registered def unless dangerous", () => {
  assert.equal(
    unsafeProvider(defineProvider({ name: "x", run: "rm -rf /tmp/x" })),
    true,
  );
  assert.equal(
    unsafeProvider(
      defineProvider({ name: "x", run: "rm -rf /tmp/x", dangerous: true }),
    ),
    false,
  );
  assert.equal(
    unsafeProvider(defineProvider({ name: "x", run: "git branch" })),
    false,
  );
});

// SOUNDNESS — the whole guarantee rests on this: a provider may only OBSERVE.
// Every built-in command must be provably read-only by the bash classifier, so
// the trusted runtime can never mutate the world while gathering a fact.
test("every built-in provider command is provably READ-ONLY", () => {
  for (const [name, def] of Object.entries(BUILTIN_PROVIDERS)) {
    if (def.run === undefined) continue; // ambient (cwd) — no command
    assert.equal(
      isReadOnlyBash(def.run),
      true,
      `built-in provider "${name}" runs a non-read-only command: ${def.run}`,
    );
  }
});

/** A fake IO that counts how often each command is exec'd. */
function countingIO(answers: Record<string, string>) {
  const calls: string[] = [];
  const base = fakeIO(answers);
  const io: ProviderIO = {
    ...base,
    exec: (c) => {
      calls.push(c);
      return base.exec(c);
    },
  };
  return { io, calls };
}

test("lazyContext runs NOTHING until a key is read, and unread keys never run", () => {
  const { io, calls } = countingIO({
    "git branch --show-current": "main\n",
    "echo a": "a",
  });
  const ctx = lazyContext(["git.branch", provide("a", "echo a")], io);
  assert.deepEqual(calls, []);
  assert.deepEqual(Object.keys(ctx), ["git.branch", "a"]); // enumerable, no exec
  assert.deepEqual(calls, []);
  assert.equal(ctx.a, "a");
  assert.deepEqual(calls, ["echo a"]); // only the read key ran
});

test("lazyContext memoizes: a key read twice runs once (failures included)", () => {
  const { io, calls } = countingIO({ "echo a": "a" });
  const ctx = lazyContext(
    [provide("a", "echo a"), provide("bad", "false-cmd")],
    io,
  );
  assert.equal(ctx.a, "a");
  assert.equal(ctx.a, "a");
  assert.equal(ctx.bad, "");
  assert.equal(ctx.bad, "");
  assert.deepEqual(calls, ["echo a", "false-cmd"]);
});

test("lazyContext getters never throw and give today's defaults", () => {
  const { io } = countingIO({});
  const ctx = lazyContext(
    ["git.branch", "git.isDirty", provider("missing"), state("never")],
    io,
  );
  assert.equal(ctx["git.branch"], "");
  assert.equal(ctx["git.isDirty"], false);
  assert.equal(ctx.missing, "");
  const never = ctx.never;
  assert.ok(typeof never === "object");
  assert.equal(never.recorded, false);
  assert.equal(never.ageSeconds, Infinity);
});
