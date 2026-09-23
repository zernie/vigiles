/**
 * vigiles — record/replay cache for the eval tier.
 *
 * A real-model eval is slow and costs money, yet most iteration is on the
 * `measure` function, not the model call. This cache records each trial's raw
 * output AND its post-run filesystem, keyed on everything that determines the
 * model's behaviour — `task`, the resolved fixture files + settings, model,
 * tools, and the trial index — but DELIBERATELY NOT the `measure` function. So
 * editing your metric and re-running re-scores the captured runs for free; the
 * model is only re-called when a model-affecting input changes (or `cache:"off"`,
 * which always re-samples for a fresh statistic).
 *
 * Restoring the post-run filesystem is what makes replay *sound*: `measure`
 * routinely reads agent-produced files via `ctx.file()` / `ctx.sh("grep …")`, so
 * a stdout-only cache would silently mis-score on replay. We snapshot the cwd's
 * text files after the run and restore them into a fresh dir before re-scoring.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, dirname } from "node:path";

import { sha256short, type SHA256Hash } from "./core/hash.js";
import {
  EVAL_CACHE_DIR,
  VIGILES_DIR,
  ensureLocalFilesIgnored,
} from "./local-files.js";
import type { RunOut } from "./eval.js";

/** Cache behaviour: never touch the cache / read-only / read-and-write. */
export type CacheMode = "off" | "read" | "readwrite";

/** Everything that determines a trial's model output (the cache key inputs). */
export interface CacheKeyInput {
  readonly task: string;
  readonly model: string;
  /**
   * Reasoning budget (`--effort`). Keyed for the same reason `model` is: it moves
   * the output distribution, so a replay across effort levels would serve a result
   * the caller did not ask for. `undefined` (the harness default) drops out of the
   * hash via JSON, so entries recorded before effort existed stay valid.
   */
  readonly effort?: string | number;
  readonly tools: readonly string[];
  /** The resolved fixture + arm + plugin files written before the run. */
  readonly files: Record<string, string>;
  /** The resolved `.claude/settings.json` for the arm (or undefined). */
  readonly settings: unknown;
  /**
   * Per-run env that affects model behaviour (e.g. `VIGILES_INTERCEPT_TOOLS`).
   * Keyed because two intercept configs that share tool names — so produce
   * identical merged `settings` — still differ in their `when`/`denyReason`, which
   * lives only in the env. Omit when there's no model-affecting env.
   */
  readonly env?: Record<string, string>;
  /**
   * Content digest of a natively-installed plugin dir (`--plugin-dir`), or
   * undefined when there is none. Folded in so editing a skill INSIDE the dir
   * invalidates the entry — a path-only key would false-replay, since the dir's
   * files are NOT in `files` (that holds only the materialized fixture / `plugin`
   * arm, not a native install). See {@link hashDir}.
   */
  readonly pluginDirHash?: string;
  /**
   * The harness BINARY version (e.g. `claude --version`). The harness evolves
   * fast — a CLI upgrade changes the system prompt + tool definitions, which steer
   * behaviour as much as the model does — so a cached result must invalidate when
   * the binary changes, or a replay silently serves a result from a different
   * harness. Resolved once per run; omit when unknown (then it doesn't partition).
   */
  readonly harnessVersion?: string;
  /** Which trial this is — distinct trials are distinct samples, cached apart. */
  readonly trialIndex: number;
}

/** A recorded trial: its raw output plus the post-run cwd snapshot. */
export interface CacheRecord {
  readonly out: RunOut;
  /** Text files present in the cwd after the run (relative path → contents). */
  readonly files: Record<string, string>;
}

const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Canonicalize a value so the key is stable regardless of object key order —
 * recursively sorts object keys. Arrays keep order (it's significant for tools).
 * Exported so the eval LOCK ({@link ./eval-lock}) hashes its inputs the same way.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonical(obj[k]);
    return out;
  }
  return value;
}

/**
 * Cache record-format version, SALTED into every key (Jest `CACHE_VERSION` /
 * webpack `cache.version` pattern). Bump when the `CacheRecord` shape — or how a
 * record is produced in a way the key can't otherwise see — changes, so old
 * entries become *unreachable* rather than deserializing into a stale shape (no
 * brittle read-time version gate needed). A major bump means orphaned files on
 * disk; reclaim them by deleting the cache dir.
 */
export const CACHE_FORMAT_VERSION = 2;

/**
 * Per-run env keys that are PURE NOISE for the cache key — a fresh random path
 * every run, never model-affecting. The opt-in ephemeral run env
 * ({@link ephemeralRunEnv} in `eval.ts`) points `HOME`/`TMPDIR` at a throwaway
 * dir generated per trial, so folding them into the key would make every
 * ephemeral run unique → the cache could NEVER hit. We drop them here so the
 * exclusion holds however the env was assembled. A non-ephemeral run normally
 * carries neither in its per-run `env` (it's an overlay over `process.env`, not
 * a complete env), so dropping them is a no-op there.
 */
const CACHE_KEY_ENV_EXCLUDE: readonly string[] = ["HOME", "TMPDIR"];

/** Strip the per-run-noise env keys ({@link CACHE_KEY_ENV_EXCLUDE}) from a keyed
 *  env, returning `undefined` when nothing model-affecting remains (so the key is
 *  byte-identical to a run that had no env at all). */
function keyedEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (CACHE_KEY_ENV_EXCLUDE.includes(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deterministic content hash of the key inputs (order-independent). */
export function cacheKey(input: CacheKeyInput): SHA256Hash {
  const normalized = {
    ...input,
    // The tool list is logically a SET, so ["Read","Bash"] and ["Bash","Read"]
    // must hash the same — sort it to avoid phantom-distinct keys. (canonical()
    // already sorts object keys; it deliberately keeps other array order.)
    tools: [...input.tools].sort(),
    // Drop the throwaway ephemeral HOME/TMPDIR — per-run noise, not model input.
    env: keyedEnv(input.env),
    cacheFormatVersion: CACHE_FORMAT_VERSION,
  };
  return sha256short(JSON.stringify(canonical(normalized)));
}

/**
 * Read a cached record by key. A MISS (no file) returns `null` — normal, the run
 * proceeds. A CORRUPT record (file present but not valid JSON) **throws** instead
 * of silently degrading to a re-run: a broken cassette is a real failure the CI
 * gate must surface, not mask. The message tells you how to recover.
 */
export function readCache(dir: string, key: SHA256Hash): CacheRecord | null {
  const path = join(dir, `${key}.json`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as CacheRecord;
  } catch {
    throw new Error(
      `eval cache: corrupt record ${path} (invalid JSON) — delete it or clear the cache dir`,
    );
  }
}

/**
 * Write a cached record by key (creating the cache dir as needed). When `dir` is
 * the default `.vigiles/eval-cache`, the recorded runs are per-checkout, so the
 * `.vigiles/.gitignore` is kept current; a `cacheDir` the spec chose elsewhere is
 * the author's to place and is left alone.
 */
export function writeCache(
  dir: string,
  key: SHA256Hash,
  record: CacheRecord,
): void {
  mkdirSync(dir, { recursive: true });
  if (
    basename(dir) === EVAL_CACHE_DIR &&
    basename(dirname(dir)) === VIGILES_DIR
  ) {
    ensureLocalFilesIgnored(dirname(dir));
  }
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(record));
}

/** Snapshot the text files under `cwd` as `relativePath → contents` (bounded). */
export function snapshotDir(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size <= MAX_SNAPSHOT_FILE_BYTES) {
        out[relative(cwd, full)] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(resolve(cwd));
  return out;
}

/** Restore a snapshot into `cwd`, recreating directories as needed. */
export function restoreDir(cwd: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = resolve(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Content digest of a directory: a lexicographically-sorted list of
 * `relativePath:contentHash` for every file, hashed to one value. Editing,
 * adding, removing, or moving any file changes the digest. It hashes file
 * CONTENT (not mtime — CI checkouts reset mtimes, the classic stale-cache
 * anti-pattern) and includes the relative path (so a rename invalidates and two
 * files can't swap contents undetected). A flat sorted list, NOT a Merkle tree —
 * sufficient at plugin-dir scale; the tree's incremental-recompute payoff isn't
 * worth the complexity here (cf. Bazel/Turborepo hash content per file).
 */
export function hashDir(dir: string): SHA256Hash {
  const root = resolve(dir);
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile())
        parts.push(
          `${relative(root, full)}:${sha256short(readFileSync(full))}`,
        );
    }
  };
  walk(root);
  return sha256short(parts.join("\n"));
}
