/**
 * The files vigiles writes into a project's `.vigiles/` that describe ONE
 * checkout on ONE machine — and the `.gitignore` that keeps them out of git.
 *
 * `.vigiles/` holds two kinds of file. Some are the project's own and are
 * committed: hook sources and their stamps (`hooks/`), eval locks
 * (`eval-locks/`), providers, the eval baseline, spec sidecars. The rest are a
 * record of what happened HERE — which run exercised which surface, which skill
 * is active right now, when a throttled hook last spoke — and committing one
 * transplants that record onto a machine where none of it happened. A committed
 * `coverage.json` credits coverage nobody ran; a committed `state/` silences a
 * teammate's hook for a window they never saw; a committed `guard-ledger.json`
 * satisfies a `requireBefore` guard with a prerequisite someone else ran.
 *
 * ## Why this file exists
 *
 * The rule "do not commit these" lived as one sentence in
 * `docs/rules/untested-skill.md`, and vigiles honoured it only in its OWN repo's
 * root `.gitignore`. Consumers committed them anyway: two repos carried
 * `.vigiles/coverage.json` for weeks, one built a `merge=ours` git driver to
 * paper over the conflicts it caused, and the other shipped `coverage.json` and
 * `runs.jsonl` inside its npm tarball. A rule that exists only as prose enforces
 * nothing, so the writer now enforces it where the write happens.
 *
 * ## The mechanism: a `.gitignore` INSIDE `.vigiles/`
 *
 * Tools that keep local state in a project leave the project's root
 * `.gitignore` alone and drop one inside their own directory — `ruff` writes
 * `.ruff_cache/.gitignore` containing `*`. `*` is wrong here, because the same
 * directory holds committed files, so the file lists the local paths instead,
 * each anchored with a leading `/` so it cannot match a same-named file deeper
 * down. It also lists ITSELF, like ruff's `*` covers its own file: it then
 * leaves no footprint in the project's history and never churns on upgrade.
 *
 * `.gitignore` does not untrack a file that is already tracked. That half is
 * `local-files-tracked.ts`, which runs from the CLI only — it spawns `git`, and
 * nothing here may, because {@link ensureLocalFilesIgnored} is called from hook
 * runtimes on the decision path.
 *
 * ## One list, and the constants live IN it
 *
 * Every writer imports its file name from here rather than spelling it, so a
 * name cannot drift from the ignore entry. The constants were defined in their
 * writer modules before; the direction is inverted on purpose. With the list
 * importing from the writers, each writer would import this module back (for
 * the ensure call), a cycle in which a top-level list reads a `const` still in
 * its temporal dead zone — and a hook deciding a `Bash` call would load
 * `eval.ts` and `coverage-artifact.ts` just to learn two file names. This module
 * imports nothing from the package, so every writer can depend on it for free.
 * `local-files.test.ts` guards the other direction: every `.vigiles/` path the
 * source spells must be either on this list or on {@link COMMITTED_PATHS}.
 *
 * Node-only (it reads and writes a file).
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/** vigiles's own directory in a project. */
export const VIGILES_DIR = ".vigiles";

/** The execution tier of coverage (`coverage-artifact.ts`). */
export const COVERAGE_ARTIFACT_FILE = "coverage.json";
/** The flight-recorder ledger (`observe.ts`). */
export const LEDGER_FILE = "runs.jsonl";
/** Compiled hooks' named state, `record()`/`state()` (`hook-state-store.ts`). */
export const HOOK_STATE_DIR = "state";
/** The skill in progress (`adapters/claude-code/skill-runtime.ts`). */
export const ACTIVE_SKILL_FILE = "active-skill.json";
/** The subagent stack in progress (`adapters/claude-code/agent-runtime.ts`). */
export const ACTIVE_AGENT_FILE = "active-agent.json";
/** Inside-an-effect-boundary marker (`adapters/claude-code/effect-region.ts`). */
export const EFFECT_ACTIVE_FILE = "effect-active.json";
/** The calls a guard allowed this session (`core/guards.ts`). */
export const GUARD_LEDGER_FILE = "guard-ledger.json";
/** What an `observe`-mode hook would have blocked (`hook-runtime.ts`). */
export const HOOK_OBSERVATIONS_FILE = "hook-observations.jsonl";
/** Recorded model runs for eval replay, the default `cacheDir` (`eval.ts`). */
export const EVAL_CACHE_DIR = "eval-cache";

/** One per-checkout path under `.vigiles/`. */
export interface LocalFile {
  /** The name directly under `.vigiles/`. */
  readonly name: string;
  /** A directory (its whole subtree is local) rather than a single file. */
  readonly dir: boolean;
}

/** Every per-checkout path vigiles writes under `.vigiles/`. The one list. */
export const LOCAL_FILES: readonly LocalFile[] = [
  { name: COVERAGE_ARTIFACT_FILE, dir: false },
  { name: LEDGER_FILE, dir: false },
  { name: HOOK_STATE_DIR, dir: true },
  { name: ACTIVE_SKILL_FILE, dir: false },
  { name: ACTIVE_AGENT_FILE, dir: false },
  { name: EFFECT_ACTIVE_FILE, dir: false },
  { name: GUARD_LEDGER_FILE, dir: false },
  { name: HOOK_OBSERVATIONS_FILE, dir: false },
  { name: EVAL_CACHE_DIR, dir: true },
];

/**
 * The names under `.vigiles/` that ARE the project's and must stay committable.
 * Not used at runtime — it is the other half of the classification the guard in
 * `local-files.test.ts` holds the source to, and the list that test checks is
 * NOT ignored.
 */
export const COMMITTED_PATHS: readonly string[] = [
  "hooks", // hook sources + their stamps (`hook-install.ts`)
  "providers", // registered hook-context providers
  "eval-locks", // committed eval staleness stamps (`eval-lock.ts`)
  "eval-baseline.json", // the committed regression baseline (`eval-baseline.ts`)
  "generated.d.ts", // linter-rule types for specs (`vigiles init` / `generate types`)
  "schema.json", // YAML-LSP frontmatter schema (`vigiles init`)
  "guards.json", // the declared guard set (`core/guards.ts`)
  "action-gates.json", // declared action gates (`action-gate.ts`)
];

/** The header comment on a `.vigiles/.gitignore` vigiles creates. */
/** The ignore file vigiles keeps inside `.vigiles/`. One spelling for every reader. */
export const LOCAL_GITIGNORE_FILE = ".gitignore";

export const LOCAL_GITIGNORE_HEADER: readonly string[] = [
  "# Written by vigiles. These files describe one checkout on one machine and are",
  "# never committed. Everything else in .vigiles/ is the project's: commit it.",
];

/** The ignore lines, in order: every local path, then the file itself. */
export function localIgnoreEntries(): string[] {
  return [
    ...LOCAL_FILES.map((f) => `/${f.name}${f.dir ? "/" : ""}`),
    `/${LOCAL_GITIGNORE_FILE}`,
  ];
}

/**
 * Is `entry` ignoring its path after git reads `lines` top to bottom.
 *
 * Conservative on purpose: ANY negation after the entry's last occurrence counts
 * as cancelling it. Git re-includes on `!/coverage.json`, but equally on
 * `!coverage.json` or `!*.json` (last matching pattern wins), and matching
 * gitignore globs here would be a second, partial implementation of git. The
 * cost of being conservative is one extra append after an unrelated negation;
 * the next call finds the entries last and leaves the file alone.
 */
function inEffect(lines: readonly string[], entry: string): boolean {
  let on = false;
  for (const line of lines) {
    if (line === entry) on = true;
    else if (line.startsWith("!")) on = false;
  }
  return on;
}

/**
 * Keep `<vigilesDir>/.gitignore` listing every local path. Call it where a
 * local file is written — not from `vigiles init`, which a project may never
 * run, while the write always happens.
 *
 * - Absent → created with {@link LOCAL_GITIGNORE_HEADER} and every entry.
 * - Every entry IN EFFECT → not touched (no rewrite, no mtime change).
 * - Otherwise the entries not in effect are appended and nothing is removed
 *   or reordered. Appending is enough because git's last matching rule wins.
 *
 * "In effect" is judged the way git reads the file, not by text membership:
 * lines in order, a later negation cancels an earlier `/entry` (see
 * {@link inEffect}), and leading whitespace is part of the pattern (only
 * trailing whitespace is dropped).
 * Both cases were measured with `git check-ignore`: `/coverage.json` followed
 * by `!/coverage.json`, and ` /coverage.json`, each leave the file NOT
 * ignored while a trimmed set would call the entry present.
 *
 * Costs one read on the hot path. Best-effort: any fs error is swallowed —
 * keeping git tidy must never break a hook, a test run or an audit.
 */
export function ensureLocalFilesIgnored(vigilesDir: string): void {
  try {
    const file = resolve(vigilesDir, LOCAL_GITIGNORE_FILE);
    const entries = localIgnoreEntries();
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf-8");
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      mkdirSync(vigilesDir, { recursive: true });
      writeFileSync(
        file,
        [...LOCAL_GITIGNORE_HEADER, ...entries, ""].join("\n"),
      );
      return;
    }
    const lines = current.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
    const missing = entries.filter((e) => !inEffect(lines, e));
    if (missing.length === 0) return;
    const header = lines.includes(LOCAL_GITIGNORE_HEADER[0])
      ? []
      : LOCAL_GITIGNORE_HEADER;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(file, sep + [...header, ...missing, ""].join("\n"));
  } catch {
    /* best-effort — an unwritable .vigiles/ is not a failure of anything */
  }
}
