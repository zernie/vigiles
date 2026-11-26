/**
 * The link check of a repo workspace (vigiles#416): build ONE trial the way
 * every trial is built (clone the template, copy the installs), walk it
 * without following any link, and judge each link found where it really
 * sits. Part of the host adapter of core's `WorkspaceHost` port.
 *
 * Why a built probe and not reasoning about the source: four reviews of
 * #585 each found a link that a check over the commit, the checkout or the
 * patch let through (a chain through a tracked link, a link the patch adds,
 * a `..` after a link, an install under a directory that is a link in the
 * copy). Walking the tree the trials will have removes the question of
 * where a link would end up: it is already there.
 */
import { readdirSync, readlinkSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { makeTmpDir } from "../core/tmp-root.js";
import type { RepoTemplate } from "../core/workspace.js";
import { copyInstalls } from "./installs.io.js";
import { cloneTemplate } from "./repo-copy.io.js";

interface Link {
  readonly path: string;
  readonly target: string;
}

/**
 * The links of a built trial that would reach out of it, as
 * `path -> target`, sorted. Escaping links in the template are reported
 * without copying the installs. The probe is removed before this returns.
 */
export function linksOutside(
  template: RepoTemplate,
  top: string,
  installs: readonly string[],
): readonly string[] {
  const probe = makeTmpDir("link-probe");
  try {
    cloneTemplate(template, probe);
    const tracked = escapingLinks(probe);
    if (tracked.length > 0) return tracked;
    copyInstalls(top, installs, probe);
    return escapingLinks(probe);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * The links under `probe` (not followed) that would reach out of it, as
 * `path -> target`, sorted. Run once before the installs are copied and once after: the copy writes
 * through any link above an install, so a tracked link that escapes would
 * let the probe itself write outside. With none escaping, every link the
 * copy passes resolves inside the probe (the argument at `escapes`).
 */
export function escapingLinks(probe: string): readonly string[] {
  return linksUnder(probe, "")
    .filter(escapes)
    .map((l) => `${l.path} -> ${l.target}`)
    .sort((a, b) => a.localeCompare(b));
}

/** Every link under `rel`, by the path it really has; links are not followed. */
function linksUnder(root: string, rel: string): readonly Link[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) {
      return [{ path, target: readlinkSync(join(root, path)) }];
    }
    return e.isDirectory() && path !== ".git" ? linksUnder(root, path) : [];
  });
}

/**
 * Absolute (from a trial, still the user's machine); or a `..` after a name
 * (it climbs from wherever that name leads, which may be a link); or more
 * leading `..` than the link has directories above it. Leading `..` walk up
 * real directories, since the walk found the link at its real path, and every
 * name after them only descends, so a set of links that all pass cannot
 * reach past the root through any chain of them.
 */
function escapes(link: Link): boolean {
  if (isAbsolute(link.target)) return true;
  const parts = link.target.split("/").filter((p) => p !== "" && p !== ".");
  const firstName = parts.findIndex((p) => p !== "..");
  const climbs = firstName === -1 ? parts.length : firstName;
  if (parts.slice(climbs).includes("..")) return true;
  return climbs > link.path.split("/").length - 1;
}
