/**
 * `paid_runEval` on a repo workspace (vigiles#416): everything decided ONCE
 * per eval, before a token is spent — the refusals, the sealed template, the
 * installs to copy, the world the instruction check reads — and the per-trial
 * seeding and base record that replace writing a `fixture`.
 *
 * Pure decisions are in `src/core/workspace.ts`; the machine work goes through
 * its `WorkspaceHost` port (the host adapter is `src/host/repo-copy.io.ts`,
 * wired by the `vigiles/eval` entry). This file only orders them.
 */
import { relative } from "node:path";
import { normalizeHarnessList } from "./adapter-registry.js";
import {
  harnessRefusal,
  WorkspaceRefusalError,
  type RepoTemplate,
  type RepoWorkspace,
  type TrialWorkspaceView,
  type WorkspaceHost,
  type WorkspaceRefusal,
} from "./core/workspace.js";

/** A workspace after its checks: the template every trial clones. */
export interface PreparedWorkspace {
  readonly host: WorkspaceHost;
  readonly template: RepoTemplate;
  /** The checkout the installs are copied from. */
  readonly top: string;
  /** Repo-relative `node_modules` dirs copied into every trial. */
  readonly installs: readonly string[];
  /** The template's tracked files, for the instruction check. */
  readonly world: Readonly<Record<string, string>>;
  /** What the lock key holds: the world by tree id, and how deps are made. */
  readonly lockView: {
    readonly tree: string;
    readonly deps: RepoWorkspace["deps"]["kind"];
  };
}

/** What the checks need from the rest of the spec. */
export interface WorkspaceContext {
  readonly host: WorkspaceHost;
  readonly hasFixture: boolean;
  readonly cache: string;
  readonly concurrency: number;
  /** The harness `paid_runEval` drives. */
  readonly driven: string;
}

function refuse(r: WorkspaceRefusal): never {
  throw new WorkspaceRefusalError(r);
}

/**
 * Check the workspace and build its template; throw a
 * {@link WorkspaceRefusalError} on the first refusal. Nothing is left on disk
 * when it throws.
 */
export function prepareWorkspace(
  ws: RepoWorkspace,
  ctx: WorkspaceContext,
): PreparedWorkspace {
  const { top, sha, installs } = checkedSource(ws, ctx);
  const template = ctx.host.buildTemplate({
    dir: top,
    ref: sha,
    ...(ws.patch === undefined ? {} : { patch: ws.patch }),
  });
  try {
    refuseLowDisk(ctx, template, { top, installs });
    refuseOutsideLinks(ctx.host, template, { top, installs });
    const world = ctx.host.readWorld(template);
    const lockView = { tree: template.tree, deps: ws.deps.kind };
    return { host: ctx.host, template, top, installs, world, lockView };
  } catch (e) {
    disposeWorkspace({ host: ctx.host, template });
    throw e;
  }
}

/** Every check that reads the source repo, in the order a user fixes them. */
function checkedSource(
  ws: RepoWorkspace,
  ctx: WorkspaceContext,
): {
  readonly top: string;
  readonly sha: string;
  readonly installs: readonly string[];
} {
  const top = specRefusals(ws, ctx);
  const sha = ctx.host.resolveCommit(top, ws.ref);
  if (sha === undefined) refuse({ kind: "ref-not-a-commit", ref: ws.ref });
  const harness = harnessRefusal(declaredAt(ctx.host, top, sha), ctx.driven);
  if (harness !== undefined) refuse(harness);
  const tmp = ctx.host.tmpRoot();
  if (!relative(top, tmp).startsWith(".."))
    refuse({ kind: "trial-dir-inside-repo", dir: tmp });
  const installs =
    ws.deps.kind === "none" ? [] : ctx.host.findInstalls(top, sha);
  return { top, sha, installs };
}

/**
 * Refused when a link the trials would get leaves the world. Read on the
 * patched template, not the commit: the patch can add a link.
 */
function refuseOutsideLinks(
  host: WorkspaceHost,
  template: RepoTemplate,
  at: { readonly top: string; readonly installs: readonly string[] },
): void {
  const links = host.linksOutside(template, at.top, at.installs);
  if (links.length > 0) refuse({ kind: "link-outside-world", links });
}

/** The checks that need no commit: the key's neighbours and the directory. */
function specRefusals(ws: RepoWorkspace, ctx: WorkspaceContext): string {
  if (ctx.hasFixture) refuse({ kind: "workspace-with-fixture" });
  if (ctx.cache !== "off")
    refuse({ kind: "cache-not-supported-with-workspace" });
  const top = ctx.host.workTreeTop(ws.dir);
  if (top === undefined) refuse({ kind: "not-a-git-work-tree", dir: ws.dir });
  return top;
}

/** The harnesses the world's own `.vigilesrc.json` declares; none when it has none or does not parse. */
function declaredAt(
  host: WorkspaceHost,
  top: string,
  sha: string,
): readonly string[] {
  const text = host.showFile(top, sha, ".vigilesrc.json");
  return text === undefined ? [] : harnessKeys(text);
}

function harnessKeys(text: string): readonly string[] {
  try {
    const cfg: unknown = JSON.parse(text);
    const harnesses =
      typeof cfg === "object" && cfg !== null && "harnesses" in cfg
        ? cfg.harnesses
        : undefined;
    return typeof harnesses === "object" && harnesses !== null
      ? normalizeHarnessList(Object.keys(harnesses))
      : [];
  } catch {
    return [];
  }
}

/**
 * Each trial in flight holds a world and a copy of every install, and the
 * scoring of a regression case holds as much again: refuse when the temp
 * file system cannot hold `concurrency × 2 ×` that.
 */
function refuseLowDisk(
  ctx: WorkspaceContext,
  template: RepoTemplate,
  source: { readonly top: string; readonly installs: readonly string[] },
): void {
  const { host } = ctx;
  const one = source.installs.reduce(
    (sum, i) => sum + host.treeBytes(`${source.top}/${i}`),
    host.treeBytes(template.root),
  );
  const neededBytes = ctx.concurrency * 2 * one;
  const freeBytes = host.freeBytes(template.root);
  if (freeBytes < neededBytes)
    refuse({ kind: "not-enough-disk", neededBytes, freeBytes });
}

/** Lay the workspace into an empty trial dir: the template's world, then its installs. */
export function seedTrial(ws: PreparedWorkspace, cwd: string): void {
  ws.host.cloneTemplate(ws.template, cwd);
  ws.host.copyInstalls(ws.top, ws.installs, cwd);
}

/**
 * Record a trial's base after every per-arm write and before the spawn. The
 * `armPaths` are the arm's own files and `settings.json`.
 */
export function recordView(
  ws: PreparedWorkspace,
  at: { readonly gitDir: string; readonly cwd: string },
  arm: { readonly name: string; readonly paths: readonly string[] },
): TrialWorkspaceView {
  const base = ws.host.recordTrialBase(ws.template, {
    ...at,
    armPaths: arm.paths,
  });
  return { arm: arm.name, gitDir: at.gitDir, ...base };
}

/** Remove the template. */
export function disposeWorkspace(ws: {
  readonly host: WorkspaceHost;
  readonly template: RepoTemplate;
}): void {
  ws.host.removeDir(ws.template.root);
}
