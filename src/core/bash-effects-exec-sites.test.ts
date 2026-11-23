/**
 * `execSites` — the descent into commands a command hands to another program.
 *
 * Properties, not printed text: a literal nested command is an exec site; a
 * command the descent cannot read is an `unseen` site with a reason; the caps
 * end in `unseen`, never in an empty list; data that merely LOOKS like a command
 * stays data; and the one-level extractors are exactly the depth-0 projection.
 * The forms are the ones measured against real bash for vigiles#460.
 */
import { describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  execSites,
  leafCommands,
  leafCommandsNormalized,
  type ExecSite,
  type NormalizedLeaf,
} from "./bash-effects.js";
import { DISASTER_CATALOG } from "../guardrail-check.js";
import { equivalentCommands } from "./bash-equivalents.js";

const forcePush = (s: ExecSite): boolean =>
  s.kind === "exec" &&
  s.leaf.head === "git" &&
  s.leaf.args.includes("push") &&
  s.leaf.hasFlag("force");
const pushes = (cmd: string): boolean => execSites(cmd).some(forcePush);
const reasons = (cmd: string): string[] =>
  execSites(cmd).flatMap((s) => (s.kind === "unseen" ? [s.reason.kind] : []));

/** `s` as one single-quoted shell word. */
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
/** `git push -f` wrapped in `n` levels of `sh -c`. */
const nest = (n: number): string =>
  Array.from({ length: n }).reduce(
    (c: string) => `sh -c ${q(c)}`,
    "git push -f",
  );

/** Forms where real bash performed the push and the command string is literal. */
const FOUND = [
  `bash -c "cd ../o && git push -f"`,
  `sh -c 'git push -f'`,
  `/bin/sh -c "git push -f"`,
  `env -i bash -c "git push -f"`,
  `bash -lc "git push -f"`,
  `bash -c -e 'git push -f'`,
  `bash -xc 'git push -f'`,
  `bash --norc -c 'git push -f'`,
  `bash -o pipefail -c "git push -f"`,
  `bash -c 'git push -f "$@"' -- origin main`,
  `bash -c 'git push "$1"' _ -f`,
  `sudo -u x bash -c "git push -f"`,
  `timeout 5 sh -c "git push -f"`,
  `ls | xargs -I{} sh -c "cd {} && git push -f"`,
  `find . -name x -exec sh -c "git push -f" \\;`,
  `find . -name x -exec git push -f \\;`,
  `bash -c "sh -c 'git push -f'"`,
  `cd x && bash -c "git push -f"`,
  `bash -c "git pu""sh -f"`,
  `bash -c $'git push\\t-f'`,
  `eval "git push -f"`,
  `builtin eval "git push -f"`,
  `bash <<< "git push -f"`,
  `bash <<EOF\ngit push -f\nEOF`,
  `bash <<'EOF'\ngit push $x -f\nEOF`,
  `bash <<-EOF\n\tgit push -f\n\tEOF`,
  `sh -s <<EOF\ngit push -f\nEOF`,
  `exec sh -c "git push -f"`,
  `script -qc "git push -f" /dev/null`,
  `flock /tmp/l -c "git push -f"`,
  `su -c "git push -f" me`,
  `watch -n1 "git push -f"`,
];

describe("a literal nested command is an exec site", () => {
  test.each(FOUND)("%s", (cmd) => {
    assert.ok(pushes(cmd), JSON.stringify(execSites(cmd)));
  });

  test("the nested words are what the program receives", () => {
    const [, inner] = execSites(`bash -c "echo \\"x\\" > f"`);
    assert.equal(inner?.kind, "exec");
    assert.deepEqual(inner.kind === "exec" ? inner.argv : null, [
      { kind: "text", text: "echo" },
      { kind: "text", text: "x" },
    ]);
    assert.equal(
      inner.kind === "exec" ? inner.leaf.redirects[0]?.target : 0,
      "f",
    );
  });

  test("find's {} is a dynamic word, and so is a positional bound to it", () => {
    const sites = execSites(`find . -exec sh -c 'git push "$1"' _ {} \\;`);
    assert.ok(!sites.some(forcePush));
    const git = sites.find((s) => s.kind === "exec" && s.leaf.head === "git");
    assert.deepEqual(git?.kind === "exec" ? git.argv[2] : null, {
      kind: "dynamic",
    });
  });

  test("the carriers are recorded, outermost first", () => {
    const git = execSites(`exec bash -c "eval 'git push -f'"`).find(forcePush);
    assert.deepEqual(
      git?.via.map((c) => c.head),
      ["exec", "bash", "eval"],
    );
  });
});

describe("what the descent cannot read is unseen, with its reason", () => {
  test.each([
    [`bash -c "$CMD"`, "dynamic-command-string"],
    [`bash $OPTS -c "git push -f"`, "dynamic-command-string"],
    [`bash <<< "$X"`, "dynamic-command-string"],
    [`eval "$X"`, "dynamic-eval"],
    [`echo 'git push -f' | bash`, "stdin-fed-shell"],
    [`printf 'git push -f\\n' | sh`, "stdin-fed-shell"],
    [`source x.sh`, "script-file"],
    [`bash script.sh`, "script-file"],
    [`bash < x.sh`, "script-file"],
    [`$(echo git) push -f`, "dynamic-head"],
    [`G=git; $G push -f`, "dynamic-head"],
    [`ssh host 'git push -f'`, "other-context"],
    [`kubectl exec p -- sh -c "git push -f"`, "other-context"],
    [`python -c "import os; os.system('git push -f')"`, "foreign-interpreter"],
    [`bash -c $'git push \\q'`, "parse-error"],
    [`bash -c "if then"`, "parse-error"],
  ])("%s → %s", (cmd, reason) => {
    assert.ok(reasons(cmd).includes(reason));
  });

  test("a hole in the string is CODE: the leaves stay, and the hole is reported", () => {
    const cmd = `bash -c "git push $(echo -f)"`;
    assert.ok(reasons(cmd).includes("hole-in-command-string"));
    const git = execSites(cmd).find(
      (s) => s.kind === "exec" && s.leaf.head === "git",
    );
    assert.deepEqual(git?.kind === "exec" ? git.argv[2] : null, {
      kind: "dynamic",
    });
  });

  test("a command the outer shell cannot parse is unseen, not empty", () => {
    assert.deepEqual(reasons("if then"), ["parse-error"]);
  });
});

describe("the caps end in unseen, never in an empty list", () => {
  test("depth 4 is read; depth 5 is too-deep", () => {
    assert.ok(pushes(nest(4)));
    assert.ok(!pushes(nest(5)));
    assert.deepEqual(reasons(nest(5)), ["too-deep"]);
  });

  test("a nested string over 256 KiB is too-large", () => {
    const big = `bash -c ${q(`git push -f; ${": ;".repeat(90_000)}`)}`;
    assert.ok(!pushes(big));
    assert.deepEqual(reasons(big), ["too-large"]);
  });
});

describe("data that mentions a command stays data", () => {
  test.each([
    `git commit -m "bash -c 'git push -f'"`,
    `echo 'sh -c "rm -rf /"'`,
    `grep 'bash -c' x`,
    `cat <<'EOF' > f.sh\ngit push -f\nEOF`,
    `printf '%s' "eval git push -f"`,
  ])("%s", (cmd) => {
    const sites = execSites(cmd);
    assert.ok(sites.every((s) => s.kind === "exec" && s.via.length === 0));
  });
});

/** A leaf as plain data, so two extractions compare by value. */
const shape = (l: NormalizedLeaf): unknown => ({
  ...l,
  flags: [...l.flags],
  assigns: [...l.assigns],
  hasFlag: undefined,
  hasAssign: undefined,
});

describe("the one-level extractors are the depth-0 projection", () => {
  const corpus = [
    ...DISASTER_CATALOG.flatMap((d) => {
      const c = String(d.input.command);
      return [c, ...equivalentCommands(c)];
    }),
    `bash -c "git push -f"`,
    `exec git push -f`,
    `G=git; $G push -f && echo $(rm -rf x) > out`,
    `sudo -D a env -C b FOO=1 git push "--force" 2>&1`,
    `f(){ git push -f; }; f`,
    `if true; then git push -f; fi | tee log`,
  ];

  test.each(corpus)("%s", (cmd) => {
    const top = execSites(cmd).flatMap((s) =>
      s.kind === "exec" && s.via.length === 0 ? [shape(s.leaf)] : [],
    );
    assert.deepEqual(leafCommandsNormalized(cmd).map(shape), top);
  });

  test("leafCommands still keeps a dynamic head's literal words", () => {
    assert.deepEqual(leafCommands("$G push -f"), [["push", "-f"]]);
    assert.deepEqual(leafCommandsNormalized("$G push -f"), []);
  });
});

/** The one field of the mvdan-sh module this test spies on. */
interface ParserModule {
  readonly syntax: { NewParser: () => unknown };
}
const isParserModule = (m: unknown): m is ParserModule =>
  typeof m === "object" && m !== null && "syntax" in m;

describe("the hot path", () => {
  test("a command with no runner is parsed exactly once", () => {
    const mvdan: unknown = createRequire(__filename)("mvdan-sh");
    assert.ok(isParserModule(mvdan));
    const spy = vi.spyOn(mvdan.syntax, "NewParser");
    execSites("git status && ls -la | wc -l > n.txt");
    assert.equal(spy.mock.calls.length, 1);
    execSites(`bash -c "git status"`);
    assert.equal(spy.mock.calls.length, 3);
    spy.mockRestore();
  });
});
