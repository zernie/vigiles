/**
 * `vigiles/rule-proof` — a package entry, and so a COMPOSITION ROOT: the one
 * file that puts the steps (core), the kit set (core) and the machine (host
 * adapter) together. Nothing else in rule-proof imports both sides.
 *
 * It installs and runs ANOTHER repository's linter and plugins. Install scripts
 * are off, but linting loads plugin code, so this is an explicit call meant for
 * a throwaway runner (CI), and nothing in `audit` or `lint` reaches it.
 */
import { PROOF_KITS } from "../core/rule-proof/kits/index.js";
import { ruleProofWith } from "../core/rule-proof/run.js";
import { nodeHost } from "../host/rule-proof.io.js";

/**
 * @experimental Prove a linter configuration fires on a planted pair, then list
 * the repository files it flags — ESLint and Ruff. `install` → `prove` →
 * `flagged`, each taking only what the step before returns. See
 * `docs/rule-proof.md`.
 */
export const experimental_ruleProof = ruleProofWith(nodeHost, PROOF_KITS);

export type {
  EslintReading,
  RuffReading,
} from "../core/rule-proof/kits/index.js";
export type {
  KitSet,
  Installed,
  PinnedLinter,
  Proof,
  ProvedReading,
} from "../core/rule-proof/run.js";
export type {
  BaseReading,
  FlaggedRun,
  Flagged,
  InstallOptions,
  NotInstalled,
  NotRun,
  NotRunStage,
  PlantedFile,
  PlantedPair,
  ReadingScope,
} from "../core/rule-proof/types.js";
