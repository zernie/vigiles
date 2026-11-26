/**
 * The install half of a repo workspace (vigiles#416): which `node_modules`
 * belong to the world, whether a link in one leaves the world, the byte copy
 * into each trial, and the sizes the disk check needs. Part of the host
 * adapter of core's `WorkspaceHost` port (`./repo-copy.io.ts` assembles it).
 *
 * Never a hardlink copy: measured, the scoring command itself (`vitest run`)
 * rewrites `node_modules/.vite/vitest/<hash>/results.json` in place, so a
 * shared inode is a write into the user's own install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statfsSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RepoTemplate } from "../core/workspace.js";
import { gitEnv } from "./git-env.io.js";

const INSTALL = "node_modules";

function entries(dir: string): readonly Dirent[] {
  return readdirSync(dir, { withFileTypes: true });
}

const under = (rel: string, name: string): string =>
  rel === "" ? name : `${rel}/${name}`;

/**
 * Every `node_modules` directory of the checkout at `top` that is not inside
 * another one or inside `.git`, and whose parent directory exists in `sha`'s
 * tree (so it belongs to a package of the world). Repo-relative, sorted.
 */
export function findInstalls(top: string, sha: string): readonly string[] {
  return [...installsUnder(top, sha, "")].sort((a, b) => a.localeCompare(b));
}

function installsUnder(
  top: string,
  sha: string,
  rel: string,
): readonly string[] {
  return entries(join(top, rel))
    .filter((e) => e.isDirectory() && e.name !== ".git")
    .flatMap((e) => installOrDeeper({ top, sha }, rel, e.name));
}

function installOrDeeper(
  at: { readonly top: string; readonly sha: string },
  rel: string,
  name: string,
): readonly string[] {
  const { top, sha } = at;
  if (name !== INSTALL) return installsUnder(top, sha, under(rel, name));
  return rel === "" || inTree(top, sha, rel) ? [under(rel, name)] : [];
}

function inTree(top: string, sha: string, rel: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}:${rel}`], {
      cwd: top,
      env: gitEnv(),
    }).status === 0
  );
}

/**
 * The links that would reach out of a trial, as `path -> target`, sorted: of
 * every link the patched template tracks and every link under the installs
 * (both copied as they are), each one that is absolute or whose text, read
 * from its own directory, climbs past the root.
 *
 * Judged on the link's text and never on where it lands in the checkout: an
 * absolute target inside the checkout is still the user's checkout from a
 * trial. Both lists hold real paths (`git` tracks no path through a link, the
 * install walk does not follow one), so when every link passes, no chain of
 * them can leave the root either.
 */
export function linksOutside(
  template: RepoTemplate,
  top: string,
  installs: readonly string[],
): readonly string[] {
  return [
    ...trackedLinks(template),
    ...installs.flatMap((install) => installLinks(top, install)),
  ]
    .filter(escapes)
    .map((l) => `${l.path} -> ${l.target}`)
    .sort((a, b) => a.localeCompare(b));
}

interface Link {
  readonly path: string;
  readonly target: string;
}

/** Links in the template's tree (mode 120000), with their stored targets. */
function trackedLinks(template: RepoTemplate): readonly Link[] {
  const listed = execFileSync("git", ["ls-tree", "-r", "-z", template.tree], {
    cwd: template.root,
    encoding: "utf-8",
    env: gitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((row) => row.startsWith("120000 "))
    .map((row) => trackedLink(template.root, row));
}

function trackedLink(root: string, row: string): Link {
  const [meta = "", path = ""] = row.split("\t");
  const object = meta.split(" ")[2] ?? "";
  const target = execFileSync("git", ["cat-file", "blob", object], {
    cwd: root,
    encoding: "utf-8",
    env: gitEnv(),
  });
  return { path, target };
}

function installLinks(top: string, rel: string): readonly Link[] {
  return entries(join(top, rel)).flatMap((e) => {
    const path = `${rel}/${e.name}`;
    if (e.isSymbolicLink()) {
      return [{ path, target: readlinkSync(join(top, path)) }];
    }
    return e.isDirectory() ? installLinks(top, path) : [];
  });
}

/**
 * Absolute; or a `..` after a name (it would climb from wherever that name
 * leads, which may be a link); or more leading `..` than the link has
 * directories above it. Leading `..` walk up real directories (the link's
 * path is real) and every name after them only descends, so a set of links
 * that all pass cannot reach past the root through any chain of them.
 */
function escapes(link: Link): boolean {
  if (isAbsolute(link.target)) return true;
  const parts = link.target.split("/").filter((p) => p !== "" && p !== ".");
  const firstName = parts.findIndex((p) => p !== "..");
  const climbs = firstName === -1 ? parts.length : firstName;
  if (parts.slice(climbs).includes("..")) return true;
  return climbs > link.path.split("/").length - 1;
}

/**
 * Copy each install from `top` into `dest` byte for byte: a copy-on-write
 * clone where the file system has one, a full copy otherwise, links kept as
 * links.
 */
export function copyInstalls(
  top: string,
  installs: readonly string[],
  dest: string,
): void {
  installs.forEach((install) => {
    // Into the directory, never onto it: the commit may already track one
    // (a `.gitkeep`), and `cp -a from to` with an existing `to` nests `from`.
    const to = join(dest, install);
    mkdirSync(to, { recursive: true });
    copyTree(join(top, install), to);
  });
}

/**
 * GNU `cp` on Linux (measured: 1.83 s for 543 MB on ext4, where reflink falls
 * back to a full copy); BSD `cp -c` (APFS clonefile) on macOS, NOT measured.
 */
const CP_FLAGS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> =
  {
    linux: ["-a", "--reflink=auto"],
    darwin: ["-a", "-c"],
  };

/** The contents of `from` into the directory `to` (it exists), with the platform's clone flag; Node's copy where there is none. */
function copyTree(from: string, to: string): void {
  const flags = CP_FLAGS[process.platform];
  /* v8 ignore start -- a platform with neither GNU nor BSD `cp`; CI is Linux */
  if (flags === undefined) {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    return;
  }
  /* v8 ignore stop */
  execFileSync("cp", [...flags, `${from}/.`, to], { stdio: "ignore" });
}

/** Bytes under `path` (files and links, by `lstat`), without following links. */
export function treeBytes(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce(
    (sum, entry) => sum + treeBytes(join(path, entry)),
    0,
  );
}

/** Free bytes on the file system that holds `dir`. */
export function freeBytes(dir: string): number {
  const fs = statfsSync(dir);
  return fs.bavail * fs.bsize;
}

const WORLD_FILE_LIMIT = 256 * 1024;

/**
 * The template's tracked files as a path → text map, for the instruction
 * check (it picks the instruction files and follows their imports). A file
 * over 256 KB, or not a regular file, is listed with no text.
 */
export function readWorld(
  template: RepoTemplate,
): Readonly<Record<string, string>> {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: template.root,
    encoding: "utf-8",
    env: gitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  return Object.fromEntries(
    listed
      .split("\0")
      .filter((p) => p !== "")
      .map((p) => [p, smallText(join(template.root, p))]),
  );
}

function smallText(full: string): string {
  const st = lstatSync(full, { throwIfNoEntry: false });
  return st?.isFile() === true && st.size <= WORLD_FILE_LIMIT
    ? readFileSync(full, "utf-8")
    : "";
}
