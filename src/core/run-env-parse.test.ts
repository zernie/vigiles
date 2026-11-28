/**
 * The eval spec boundary for `env`: parsed once, before a token is spent, into
 * the current spelling, with messages that name the field and the rewrite. An
 * eval file is often plain JS, so nothing type-checks the literal; this parse
 * is the guard.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseRunEnv } from "./run-env-parse.js";

/** A made-up harness auth file: the core names no real harness. */
const KEEP = [".acme/token"];

const parse = (raw: unknown) => parseRunEnv(raw, "runEval", KEEP);

// --- the kinds -------------------------------------------------------------------

test("env is required: no default, and the message names all three kinds", () => {
  assert.throws(
    () => parse(undefined),
    (e: Error) => {
      assert.match(e.message, /runEval: `env` is required/);
      // Guards: each current spelling is offered where the choice is made.
      assert.match(e.message, /env: \{ kind: "local", inherit: "none" \}/);
      assert.match(
        e.message,
        /env: \{ kind: "local", inherit: "all", reason: "…" \}/,
      );
      assert.match(e.message, /env: \{ kind: "docker" \}/);
      return true;
    },
  );
});

test("local: inherit none, with or without a seeded HOME; inherit all with a reason; no warning", () => {
  const seed = { kind: "files", files: { ".config/x/y.txt": "z" } };
  // Guards: a current spelling parses as given and prints nothing.
  assert.deepEqual(parse({ kind: "local", inherit: "none" }), {
    env: { kind: "local", inherit: "none" },
    deprecation: undefined,
  });
  assert.deepEqual(parse({ kind: "local", inherit: "none", home: seed }), {
    env: { kind: "local", inherit: "none", home: seed },
    deprecation: undefined,
  });
  assert.deepEqual(
    parse({ kind: "local", inherit: "all", reason: "needs my gh auth" }),
    {
      env: { kind: "local", inherit: "all", reason: "needs my gh auth" },
      deprecation: undefined,
    },
  );
});

test("the deprecated inherit and ephemeral still parse, as their local forms, with one warning naming the new spelling", () => {
  const seed = { kind: "files", files: { a: "b" } };
  const old = parse({ kind: "ephemeral", home: seed });
  // Guards: past the parse only the new spelling exists, seed kept.
  assert.deepEqual(old.env, { kind: "local", inherit: "none", home: seed });
  // Guards: the warning names the spelling to write instead.
  assert.match(
    old.deprecation ?? "",
    /runEval: env: \{ kind: "ephemeral" \} is deprecated — write env: \{ kind: "local", inherit: "none" \}/,
  );
  const inherit = parse({ kind: "inherit", reason: "r" });
  assert.deepEqual(inherit.env, { kind: "local", inherit: "all", reason: "r" });
  assert.match(
    inherit.deprecation ?? "",
    /env: \{ kind: "inherit" \} is deprecated — write env: \{ kind: "local", inherit: "all", reason: "…" \}/,
  );
});

test("a bare docker env parses to the docker kind, with no warning", () => {
  // Guards: a container needs no options (vigiles builds the image).
  assert.deepEqual(parse({ kind: "docker" }), {
    env: { kind: "docker" },
    deprecation: undefined,
  });
});

test("docker keeps its seed and its allowlisted options as given", () => {
  const raw = {
    kind: "docker",
    home: { kind: "files", files: { ".config/x": "y" } },
    networkMode: "none",
    resourcesQuota: { memory: 2, cpu: 1 },
    droppedCapabilities: ["NET_RAW"],
  };
  // Guards: the seed and every option reach the runner untouched.
  assert.deepEqual(parse(raw).env, raw);
});

// --- combinations that cannot be written ------------------------------------------

test("home exists only on a throwaway HOME: seeding your real one is refused, in either spelling", () => {
  const home = { kind: "files", files: { a: "b" } };
  for (const raw of [
    { kind: "local", inherit: "all", reason: "r", home },
    { kind: "inherit", reason: "r", home },
  ])
    // Guards: no spelling writes a seed into your real HOME; the field is named.
    assert.throws(
      () => parse(raw),
      /runEval: env\.home: `home` exists only on a throwaway HOME: seeding would write into your real HOME\. Use env: \{ kind: "local", inherit: "none", home: … \}/,
    );
});

test("a reason on a throwaway HOME, inherit on docker, and local without inherit are each refused naming the field", () => {
  // Guards: `reason` belongs to `inherit: "all"` only.
  assert.throws(
    () => parse({ kind: "local", inherit: "none", reason: "r" }),
    /runEval: env\.reason: `reason` exists only on inherit: "all"/,
  );
  // Guards: a container never inherits your HOME or environment, so it takes
  // no `inherit` — and the refusal is not the allowlist's "container option".
  assert.throws(
    () => parse({ kind: "docker", inherit: "all" }),
    /runEval: env\.inherit: a docker run always starts from a throwaway HOME/,
  );
  // Guards: a local run must say what it inherits; there is no default.
  assert.throws(
    () => parse({ kind: "local" }),
    /runEval: env\.inherit: a local run says what it inherits/,
  );
  // Guards: an inherit value outside the two is refused at its field.
  assert.throws(
    () => parse({ kind: "local", inherit: "some" }),
    /runEval: env\.inherit: /,
  );
});

test("an empty reason and an unknown kind are refused naming the field", () => {
  // Guards: a real-HOME run must say why, in either spelling.
  assert.throws(
    () => parse({ kind: "local", inherit: "all", reason: "  " }),
    /env\.reason/,
  );
  assert.throws(() => parse({ kind: "inherit", reason: "  " }), /env\.reason/);
  // Guards: a made-up kind is not read as any of the real ones.
  assert.throws(() => parse({ kind: "sandbox" }), /env\.kind/);
});

// --- the seed ----------------------------------------------------------------------

test("a seed path outside HOME, or over the harness's own auth file, is refused before any trial", () => {
  const seed = (path: string) =>
    parse({
      kind: "local",
      inherit: "none",
      home: { kind: "files", files: { [path]: "x" } },
    });
  for (const p of ["../escape", "/etc/x", "a/../../b", "", "a//b", "./a"])
    // Guards: every path that leaves HOME or is not spelled plainly.
    assert.throws(() => seed(p), /env\.home\.files: /);
  // Guards: the harness's own auth file cannot be replaced by a seed.
  assert.throws(
    () => seed(".acme/token"),
    /env\.home\.files: ".acme\/token" is the harness's own auth file/,
  );
  // Guards: an empty seed says to omit `home` instead.
  assert.throws(
    () =>
      parse({
        kind: "local",
        inherit: "none",
        home: { kind: "files", files: {} },
      }),
    /env\.home\.files: .*no files/,
  );
});

test("seed paths that cannot coexist are refused at the boundary, naming both", () => {
  const seed = (files: Record<string, string>) =>
    parse({ kind: "local", inherit: "none", home: { kind: "files", files } });
  // Guards: a file and a path beneath it.
  assert.throws(
    () => seed({ a: "x", "a/b": "y" }),
    /env\.home\.files: "a" is written as a file but "a\/b" needs it to be a directory/,
  );
  assert.throws(
    () => seed({ "a/b": "y", "a/b/c/d": "z", e: "w" }),
    /"a\/b" is written as a file but "a\/b\/c\/d" needs it/,
  );
  // Guards: a seed file standing where the harness's own auth file needs a directory.
  assert.throws(
    () => seed({ ".acme": "x" }),
    /"\.acme" is written as a file but "\.acme\/token" \(the harness's own auth file\) needs it to be a directory/,
  );
  // Guards: a seed path beneath the auth file, which is a file.
  assert.throws(
    () => seed({ ".acme/token/x": "x" }),
    /"\.acme\/token" \(the harness's own auth file\) is written as a file but "\.acme\/token\/x" needs it to be a directory/,
  );
  // Guards: siblings, a shared directory, and a name that only SHARES A PREFIX are fine.
  assert.doesNotThrow(() => seed({ "a/b": "1", "a/c": "2", ab: "3" }));
  assert.doesNotThrow(() => seed({ ".acme/other": "1" }));
});

test("a docker seed is checked like a local one", () => {
  // Guards: a container's HOME is the same throwaway HOME, so its seed may
  // not leave it or replace the harness's auth file either.
  assert.throws(
    () =>
      parse({
        kind: "docker",
        home: { kind: "files", files: { "../x": "y" } },
      }),
    /env\.home\.files: /,
  );
});

// --- the container allowlist ---------------------------------------------------------

test("a field outside the container allowlist is refused as breaking containment", () => {
  for (const key of ["privileged", "env", "bindMounts", "reuse", "user"]) {
    // Guards: each setting that would let a process outlive or escape the
    // attempt has no way in, and the message names the field and why.
    assert.throws(
      () => parse({ kind: "docker", [key]: true }),
      new RegExp(
        `runEval: env\\.${key}: not a container option — it would break the containment`,
      ),
    );
  }
});

test("a wrong container value, or a container option on a local env, is refused naming the field", () => {
  // Guards: an option's value is checked, not only its name.
  assert.throws(
    () => parse({ kind: "docker", pullPolicy: "sometimes" }),
    /runEval: env\.pullPolicy/,
  );
  // Guards: a local env takes no container option, so a stray one is not
  // silently dropped and the run is not quietly left on the host.
  assert.throws(
    () => parse({ kind: "local", inherit: "none", image: "x" }),
    /runEval: env/,
  );
  // Guards: nor does one on your real HOME: a container around it cannot be written.
  assert.throws(
    () => parse({ kind: "local", inherit: "all", reason: "r", image: "x" }),
    /runEval: env/,
  );
});

test("an env that is not an object is refused by the schema, naming the field", () => {
  // Guards: a bare string skips the shape rules and still fails at `env`, not later.
  assert.throws(() => parse("docker"), /runEval: .*env/);
});
