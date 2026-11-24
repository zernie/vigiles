/**
 * Cross-repository cases for the guardrail battery (#418): does a guard judge
 * the repository a command TARGETS, or the folder the session STARTED in?
 *
 * A guard that blocks `git push -f` on `main` usually asks git for the branch.
 * If it asks in its own working directory, `cd ../other && git push -f origin
 * HEAD` is judged by the branch of the session folder, not of `../other`: the
 * reporter of #418 found that defect in nine of their hooks. Text cases cannot
 * show it, because the decision depends on repository STATE the text does not
 * carry. So this builds real repositories — two per form, each set up by the
 * caller into the state that must be blocked or allowed — and plans the four
 * cases that separate "judged the target" from "judged the start folder".
 *
 * This module owns the repositories (git I/O, a temp root, cleanup) and the
 * plan. Running a case and scoring it stay in `guardrail-check.ts`, beside the
 * rest of the battery, which imports from here and never the other way round.
 */
import { join } from "node:path";

import { cleanupTmpDir, makeTmpDir } from "./core/tmp-root.js";
import { REAL_DEPS } from "./run-script.js";

/**
 * How a cross-repository case aims the command at the other repository.
 *
 * - `cd` — `cd <target> && <command>`;
 * - `git-C` — `git -C <target> <rest>`, only for a command that starts with `git `;
 * - `worktree` — the target is a LINKED WORKTREE of the start repository (not a
 *   separate clone), aimed at with `cd <target> && <command>`.
 *
 * Part of `experimental_targetRepo` on {@link VerifyGuardrailOptions}.
 *
 * @beta
 */
export type TargetRepoForm = "cd" | "git-C" | "worktree";

/**
 * Which setup a repository got: the state the guard must block in, or the one
 * it must allow in.
 *
 * @beta
 */
export type TargetRepoSide = "blocked" | "allowed";

/**
 * A real git repository with at least one commit, handed to a setup callback.
 * Part of `experimental_targetRepo`.
 *
 * @beta
 */
export interface TargetRepoFixture {
  /** The checkout's absolute directory, symlinks resolved. */
  readonly dir: string;
  /** Run `git <args>` in {@link TargetRepoFixture.dir}; returns trimmed stdout, throws on a non-zero exit. */
  git(...args: readonly string[]): string;
  /** Check out a branch named `name` at the current commit, creating it if needed (`git checkout -B`). */
  branch(name: string): void;
}

/**
 * The cross-repository cases to run instead of the disaster battery: one
 * command and the two repository states that decide it.
 *
 * @beta
 */
export interface TargetRepoCases {
  /** The command as the agent would type it in the target repository, e.g. `git push -f origin HEAD`. */
  readonly command: string;
  /** Put a repository into the state where `command` must be BLOCKED. */
  readonly blocked: (repo: TargetRepoFixture) => void;
  /** Put a repository into the state where `command` must be ALLOWED. */
  readonly allowed: (repo: TargetRepoFixture) => void;
  /**
   * The forms to run. Default: `cd` and `worktree`, plus `git-C` when `command`
   * starts with `git `. Asking for `git-C` with any other command throws.
   */
  readonly forms?: readonly TargetRepoForm[];
}

/**
 * One cross-repository case: where the session started, which repository the
 * command aims at, and the spelled command.
 *
 * A CONTROL aims the form at the start repository itself (`target` equals
 * `start`), so it shows whether the fixtures express what the guard checks at
 * all; a CROSS case aims at the other repository.
 *
 * @beta
 */
export interface TargetRepoEvent {
  /** Stable id: `<form>:<start>-><target>`, or `<form>:<start>->itself` for a control. */
  readonly id: string;
  /** One-line label, e.g. `cd form: started in feature/x, targeted main`. */
  readonly label: string;
  /** How the command aims at the target. */
  readonly via: TargetRepoForm;
  /** The state of the repository the session started in. */
  readonly start: TargetRepoSide;
  /** The state of the repository the command targets. */
  readonly target: TargetRepoSide;
  /** True when the command targets the start repository itself. */
  readonly control: boolean;
  /** The tool the event names (always `Bash`). */
  readonly tool: string;
  /** The `tool_input` payload. */
  readonly input: Record<string, unknown>;
}

/** A planned case: the event, what a correct guard does, and where it runs. */
export interface PlannedTargetCase {
  readonly event: TargetRepoEvent;
  readonly expect: "block" | "allow";
  /** The start repository: the event's `cwd` and the hook's working directory. */
  readonly startDir: string;
}

/**
 * What the fixture's OWN git calls add to the environment: no global or system
 * config (a `commit.gpgsign` there would fail the first commit) and a fixed
 * identity. The hook under test runs with the caller's environment, not this.
 */
const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "vigiles",
  GIT_AUTHOR_EMAIL: "vigiles@example.invalid",
  GIT_COMMITTER_NAME: "vigiles",
  GIT_COMMITTER_EMAIL: "vigiles@example.invalid",
};

/**
 * The variables that send git to a repository other than its working
 * directory (git's own list: `git rev-parse --local-env-vars`). The spawner
 * MERGES the caller's environment, so setting `cwd` alone does not isolate a
 * fixture: a `GIT_DIR` inherited from a git hook would point every fixture
 * call at the caller's repository and commit there. git's hook documentation
 * says the same of any foreign-repository operation: clear these first.
 */
const GIT_ROUTING_VARS: readonly string[] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** `env -u` each routing variable: removed, not set empty (both GNU and BSD `env`). */
const UNSET_ROUTING = `env ${GIT_ROUTING_VARS.map((v) => `-u ${v}`).join(" ")}`;

/** POSIX single-quoting, so a directory with spaces stays one word. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run `git <args>` in `dir` through the battery's own direct spawner — not
 * `runScript`, which would count each fixture call as a check of the harness.
 */
function runGit(dir: string, args: readonly string[]): string {
  const line = `${UNSET_ROUTING} git ${args.map(quote).join(" ")}`;
  const r = REAL_DEPS.direct(line, "", {
    cwd: dir,
    env: { ...FIXTURE_GIT_ENV },
    timeoutMs: 30_000,
  });
  if (r.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed in ${dir} (exit ${String(r.status)}): ${r.stderr.trim()}`,
    );
  return r.stdout.trim();
}

function fixture(dir: string): TargetRepoFixture {
  return {
    dir,
    git: (...args) => runGit(dir, args),
    branch: (name) => {
      runGit(dir, ["checkout", "-q", "-B", name]);
    },
  };
}

/**
 * A fresh repository with one commit on a neutral branch, so a setup that
 * checks out `main` is never refused because `main` is already the branch.
 */
function initRepo(root: string, dir: string): TargetRepoFixture {
  runGit(root, ["init", "-q", dir]); // creates `dir` and its parents
  runGit(dir, ["symbolic-ref", "HEAD", "refs/heads/vigiles-init"]);
  runGit(dir, ["commit", "-q", "--allow-empty", "-m", "vigiles fixture"]);
  return fixture(dir);
}

/** The two checkouts of one form: one set up blocked, one set up allowed. */
interface RepoPair {
  readonly blocked: TargetRepoFixture;
  readonly allowed: TargetRepoFixture;
}

/**
 * `cd` and `git-C` aim at a SEPARATE repository. `worktree` aims at a linked
 * worktree of the start repository: the main checkout is set up blocked, the
 * linked one allowed, so the two cross cases cover both directions (linked →
 * main, main → linked).
 */
function buildPair(root: string, form: TargetRepoForm): RepoPair {
  if (form !== "worktree")
    return {
      blocked: initRepo(root, join(root, form, "blocked")),
      allowed: initRepo(root, join(root, form, "allowed")),
    };
  const main = initRepo(root, join(root, form, "main"));
  const linked = join(root, form, "linked");
  main.git("worktree", "add", "-q", "-b", "vigiles-linked", linked);
  return { blocked: main, allowed: fixture(linked) };
}

/** What a reader calls a checkout: its branch, else its short commit. */
function describeCheckout(repo: TargetRepoFixture): string {
  const branch = repo.git("branch", "--show-current");
  return branch === ""
    ? `detached ${repo.git("rev-parse", "--short", "HEAD")}`
    : branch;
}

/**
 * Each side's name in a label: the branch when the two setups leave different
 * branches (`main` vs `feature/x`), else which setup it got.
 */
function sideNames(pair: RepoPair): Readonly<Record<TargetRepoSide, string>> {
  const blocked = describeCheckout(pair.blocked);
  const allowed = describeCheckout(pair.allowed);
  return blocked === allowed
    ? { blocked: "the blocked repo", allowed: "the allowed repo" }
    : { blocked, allowed };
}

const GIT_PREFIX = "git ";

/** `command` aimed at `dir` in `form`. */
function aim(command: string, form: TargetRepoForm, dir: string): string {
  return form === "git-C"
    ? `git -C ${quote(dir)} ${command.slice(GIT_PREFIX.length)}`
    : `cd ${quote(dir)} && ${command}`;
}

/** The forms to run: the caller's, checked, or the default for this command. */
export function targetForms(spec: TargetRepoCases): readonly TargetRepoForm[] {
  const isGit = spec.command.startsWith(GIT_PREFIX);
  if (spec.forms === undefined)
    return isGit ? ["cd", "git-C", "worktree"] : ["cd", "worktree"];
  if (spec.forms.length === 0)
    throw new TypeError(
      "`experimental_targetRepo.forms` is empty: no case would run, so nothing would be proven",
    );
  if (spec.forms.includes("git-C") && !isGit)
    throw new TypeError(
      `the \`git-C\` form rewrites a command that starts with \`git \`, and \`${spec.command}\` does not`,
    );
  return spec.forms;
}

const SIDES: readonly TargetRepoSide[] = ["allowed", "blocked"];

/** The four cases of one form: two controls, then the two crossings. */
function planForm(
  form: TargetRepoForm,
  pair: RepoPair,
  command: string,
): readonly PlannedTargetCase[] {
  const names = sideNames(pair);
  const controls = SIDES.map((start) => ({ start, target: start }));
  const crosses = SIDES.map((start) => ({
    start,
    target: start === "allowed" ? ("blocked" as const) : ("allowed" as const),
  }));
  return [...controls, ...crosses].map(({ start, target }) => {
    const control = start === target;
    const spelled = aim(command, form, pair[target].dir);
    return {
      expect: target === "blocked" ? "block" : "allow",
      startDir: pair[start].dir,
      event: {
        id: `${form}:${start}->${control ? "itself" : target}`,
        label: `${form} form${control ? " (control)" : ""}: started in ${names[start]}, targeted ${control ? "itself" : names[target]}`,
        via: form,
        start,
        target,
        control,
        tool: "Bash",
        input: { command: spelled },
      },
    };
  });
}

/**
 * Build the repositories, plan every case, hand the plan to `run`, and remove
 * the repositories afterwards — also when a setup callback or `run` throws.
 */
export function withTargetRepoCases<R>(
  spec: TargetRepoCases,
  run: (cases: readonly PlannedTargetCase[]) => R,
): R {
  const forms = targetForms(spec);
  const root = makeTmpDir("target-repo");
  try {
    const cases = forms.flatMap((form) => {
      const pair = buildPair(root, form);
      spec.blocked(pair.blocked);
      spec.allowed(pair.allowed);
      return planForm(form, pair, spec.command);
    });
    return run(cases);
  } finally {
    cleanupTmpDir(root);
  }
}
