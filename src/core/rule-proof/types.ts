/**
 * The vocabulary of `experimental_ruleProof`, shared by the steps, the port and
 * every linter kit. It names no linter: a kit adds its own reading fields on top
 * of {@link BaseReading}.
 *
 * Two lessons from hand-written copies of this, kept as types rather than notes:
 * a config that did not load printed nothing and was scored "no diagnostic", so
 * an unreadable report is its own case and never an empty list; and a file that
 * did not parse is not a clean file, so a per-file report has three kinds.
 */

/** Where a reading applies, as patterns relative to the repository root. */
export interface ReadingScope {
  readonly files: readonly string[];
  readonly ignores: readonly string[];
}

/** What every reading has. A kit's reading adds the linter's own options. */
export interface BaseReading {
  /** The kit's name, as the kit set is keyed. */
  readonly linter: string;
  /** The rule as the linter spells it. */
  readonly rule: string;
  readonly scope: ReadingScope;
}

/** What one lint run said about one file. */
export type FileReport =
  | { readonly path: string; readonly kind: "linted"; readonly hits: number }
  | {
      readonly path: string;
      readonly kind: "parse-error";
      readonly message: string;
    }
  | { readonly path: string; readonly kind: "ignored" };

/** A linter's output read as per-file facts, or why it could not be. */
export type LintParse =
  | { readonly kind: "parsed"; readonly files: readonly FileReport[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Why a reading or a run produced no verdict. */
export type NotRunStage =
  | "pair-outside-scope"
  | "pair-path-taken"
  | "pair-ignored"
  | "parse"
  | "config-load"
  | "timeout";

/** No verdict, and why. */
export interface NotRun {
  readonly kind: "not-run";
  readonly stage: NotRunStage;
  readonly reason: string;
}

/** The verdict on a planted pair, before the proved reading is bound to its linter. */
export type PairVerdict =
  | { readonly kind: "proved" }
  | {
      readonly kind: "not-proved";
      readonly badHits: number;
      readonly goodHits: number;
    }
  | NotRun;

/** Why there is no pinned linter. */
export interface NotInstalled {
  readonly kind: "not-installed";
  readonly stage:
    | "no-lockfile"
    | "no-pin"
    | "install"
    | "timeout"
    | "no-linter";
  readonly reason: string;
}

/** A file planted for the proof: a path relative to the repository and its text. */
export interface PlantedFile {
  readonly path: string;
  readonly text: string;
}

/** The violation and its twin. Both are required: one direction proves nothing. */
export interface PlantedPair {
  readonly bad: PlantedFile;
  readonly good: PlantedFile;
}

/** The repository files a proved reading flags, and the ones it could not judge. */
export interface Flagged {
  /** Files the linter parsed, flagged or not. */
  readonly linted: number;
  readonly flagged: readonly string[];
  readonly parseErrors: readonly string[];
  readonly ignored: readonly string[];
}

/** What a proved reading flags in the repository. */
export type FlaggedRun = ({ readonly kind: "ran" } & Flagged) | NotRun;

/** Where install keeps every cache, and how long each step may take. */
export interface InstallOptions {
  /** A directory the caller owns; HOME and every package-manager cache go here. */
  readonly cacheDir: string;
  /** Default 600 s. */
  readonly installTimeoutMs?: number;
  /** Per lint call, default 150 s. */
  readonly lintTimeoutMs?: number;
}

/** What a command did. A timeout and a binary that never started are not exit codes. */
export type ExecResult =
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "killed"; readonly signal: string }
  | { readonly kind: "spawn-error"; readonly message: string };

/** Options for one command. `env` is added to the inherited environment. */
export interface ExecOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}
