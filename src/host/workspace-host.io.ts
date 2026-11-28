/**
 * The host adapter of core's `WorkspaceHost` port (vigiles#416), assembled
 * from its three halves: the template and base record (`./repo-copy.io.ts`),
 * the installs (`./installs.io.ts`) and the link check (`./link-probe.io.ts`).
 * `src/entries/eval.ts` wires it into `paid_runEval`, inside {@link evalHost}:
 * the workspace plus the halves a regression case reads, and the engine
 * fingerprint its lock is keyed by (`./eval-engine.io.ts`).
 */
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { EvalHost } from "../core/eval-host.js";
import type { WorkspaceHost } from "../core/workspace.js";
import { caseWorldHost } from "./case-world.io.js";
import { containerHost } from "./container.io.js";
import { engineHost } from "./eval-engine.io.js";
import {
  copyInstalls,
  findInstalls,
  freeBytes,
  readWorld,
  treeBytes,
} from "./installs.io.js";
import { linksOutside } from "./link-probe.io.js";
import { regressionCaseHost } from "./regression-case.io.js";
import {
  buildTemplate,
  cloneTemplate,
  recordTrialBase,
  resolveCommit,
  showFile,
  touchedPaths,
  workTreeTop,
} from "./repo-copy.io.js";

export const repoCopyHost: WorkspaceHost = {
  workTreeTop,
  resolveCommit,
  showFile,
  // Where `makeTmpDir` puts its dirs, by real path (it resolves its own).
  tmpRoot: () => realpathSync(tmpdir()),
  buildTemplate,
  cloneTemplate,
  recordTrialBase,
  touchedPaths,
  findInstalls,
  linksOutside,
  copyInstalls,
  treeBytes,
  freeBytes,
  readWorld,
  removeDir: (dir) => {
    rmSync(dir, { recursive: true, force: true });
  },
};

/** Every machine port `paid_runEval` reads, as one value. */
export const evalHost: EvalHost = {
  ...repoCopyHost,
  ...regressionCaseHost,
  ...caseWorldHost,
  ...engineHost,
  container: containerHost,
};
