/**
 * The install half of a repo workspace (vigiles#416): which `node_modules`
 * belong to the world, the byte copy into each trial, and the sizes the disk
 * check needs. Part of the host
 * adapter of core's `WorkspaceHost` port (`./repo-copy.io.ts` assembles it).
 *
 * Never a hardlink copy: measured, the scoring command itself (`vitest run`)
 * rewrites `node_modules/.vite/vitest/<hash>/results.json` in place, so a
 * shared inode is a write into the user's own install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
      .map((p) => [p, smallText(template.root, p)]),
  );
}

function smallText(root: string, path: string): string {
  const full = inWorld(root, path);
  const st =
    full === undefined ? undefined : statSync(full, { throwIfNoEntry: false });
  return full !== undefined &&
    st?.isFile() === true &&
    st.size <= WORLD_FILE_LIMIT
    ? readFileSync(full, "utf-8")
    : "";
}

/**
 * The real file behind `path`, followed through links the way the harness
 * reads it, or undefined when it dangles or lands outside the world.
 */
function inWorld(root: string, path: string): string | undefined {
  const full = join(root, path);
  if (!existsSync(full)) return undefined;
  const real = realpathSync(full);
  const rel = relative(realpathSync(root), real);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : real;
}
