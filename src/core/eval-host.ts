/**
 * Every machine port an eval reads, as one type (vigiles#416): the repository
 * copy (`experimental_workspace`), the scoring of a case's tree, the reads a
 * case's world is built from, and the facts a case's lock is keyed by. A
 * root wires one value (`src/host/workspace-host.io.ts`).
 */
import type { RegressionCaseHost } from "./case-scoring.js";
import type { CaseWorldHost } from "./case-world.js";
import type { WorkspaceHost } from "./workspace.js";

/** The eval engine's fingerprint, or where it should have been. */
export type EngineFingerprint =
  | { readonly kind: "found"; readonly hash: string }
  | { readonly kind: "missing"; readonly path: string };

/** What a case's lock reads about the code that scores it (the port). */
export interface EngineHost {
  /** The fingerprint the build wrote beside the compiled engine. */
  engineFingerprint(): EngineFingerprint;
  /** The major version of the Node the scoring runs on. */
  nodeMajor(): string;
}

export type EvalHost = WorkspaceHost &
  RegressionCaseHost &
  CaseWorldHost &
  EngineHost;
