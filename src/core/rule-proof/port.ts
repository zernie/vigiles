/**
 * The two ports of `experimental_ruleProof`.
 *
 * {@link RuleProofHost} is every effect the steps need from the machine; the
 * host adapter (`src/host/rule-proof.io.ts`) implements it. {@link ProofKit} is
 * everything the steps need to know about ONE linter; each kit is a module in
 * `./kits/`, and the set is assembled there and handed in by the entry root. The
 * steps (`./run.ts`) know neither a machine nor a linter by name.
 */
import type {
  BaseReading,
  ExecOptions,
  ExecResult,
  LintParse,
} from "./types.js";

/** Every effect rule-proof needs. Paths are absolute unless a member says otherwise. */
export interface RuleProofHost {
  readonly exec: (
    command: string,
    args: readonly string[],
    options: ExecOptions,
  ) => ExecResult;
  /** A file's text, or null when it is absent or unreadable. */
  readonly read: (path: string) => string | null;
  readonly exists: (path: string) => boolean;
  /** Entry names directly in `dir`. */
  readonly list: (dir: string) => readonly string[];
  /** Write a file, making its parent directories. */
  readonly write: (path: string, text: string) => void;
  /** Remove a file or a directory tree; absent is fine. */
  readonly remove: (path: string) => void;
  /**
   * Files under `dir` matching `patterns`: relative, `/`-separated, never
   * inside node_modules or .git.
   */
  readonly files: (
    dir: string,
    patterns: readonly string[],
  ) => readonly string[];
}

/** What a kit may look at in a repository's root before installing. */
export interface RootView {
  /** Entry names at the root. */
  readonly names: readonly string[];
  /** A root file's text by name, or null. */
  readonly read: (name: string) => string | null;
}

/** How to install a linter at the repository's pinned version, or why that is impossible. */
export type KitPlan =
  | {
      readonly kind: "plan";
      /** The install command and its arguments, run in the repository. */
      readonly install: readonly [string, ...string[]];
      /** The argv prefix that runs the linter once installed. */
      readonly command: (dir: string) => readonly string[];
      /** The installed version, given a reader of repository-relative files; null when absent. */
      readonly version: (
        read: (path: string) => string | null,
      ) => string | null;
      /** What to say when `version` finds nothing after the install. */
      readonly missing: string;
    }
  | {
      readonly kind: "none";
      readonly stage: "no-lockfile" | "no-pin";
      readonly reason: string;
    };

/** One lint call: the config file to write, and the arguments after the command. */
export interface Invocation {
  readonly configPath: string;
  readonly configText: string;
  readonly args: readonly string[];
}

/** Where a lint call runs and where its scratch files go. */
export interface Places {
  readonly dir: string;
  readonly cacheDir: string;
}

/**
 * Everything the steps need to know about one linter. Methods, not function
 * properties: a kit of a narrower reading is still a kit.
 */
export interface ProofKit<R extends BaseReading> {
  readonly linter: R["linter"];
  plan(root: RootView): KitPlan;
  /** Environment that keeps this linter's tools' caches under `cacheDir`. */
  env(cacheDir: string): Readonly<Record<string, string>>;
  invocation(reading: R, files: readonly string[], places: Places): Invocation;
  /** Exit codes after which stdout holds a report. Any other is `config-load`. */
  readonly reportCodes: readonly number[];
  parse(
    stdout: string,
    files: readonly string[],
    reading: R,
    dir: string,
  ): LintParse;
}
