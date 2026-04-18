/**
 * Freshness detection for compiled instruction files.
 *
 * Three modes:
 * - "strict": recompile in memory, diff against existing output (zero false positives)
 * - "input-hash": hash tracked input files, compare to stored fingerprint (fast)
 * - "output-hash": existing behavior — only detects hand-edits to compiled .md
 *
 * Per-file sidecar manifests (.vigiles/<target>.inputs.json) store individual
 * file hashes for granular change reporting and affected-specs queries.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";

import { sha256short } from "./hash.js";
import type { FreshnessMode } from "./types.js";
import type { ClaudeSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Lock file detection
// ---------------------------------------------------------------------------

/** Known lock files, ordered by ecosystem then preference. */
const KNOWN_LOCK_FILES: readonly string[] = [
  // Node.js
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  // Ruby
  "Gemfile.lock",
  // Python
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "requirements.txt",
  // Rust
  "Cargo.lock",
  // Go
  "go.sum",
  // PHP
  "composer.lock",
  // .NET
  "packages.lock.json",
  // Swift
  "Package.resolved",
  // Elixir
  "mix.lock",
];

/** Known linter configuration files. */
const KNOWN_LINTER_CONFIGS: readonly string[] = [
  // ESLint
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.ts",
  "eslint.config.cjs",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc.cjs",
  // Stylelint
  ".stylelintrc.json",
  ".stylelintrc.js",
  ".stylelintrc.yml",
  ".stylelintrc.yaml",
  "stylelint.config.js",
  "stylelint.config.cjs",
  "stylelint.config.mjs",
  // Python
  "pyproject.toml",
  "ruff.toml",
  ".pylintrc",
  "setup.cfg",
  // Rust
  "Cargo.toml",
  "clippy.toml",
  ".clippy.toml",
  // Ruby
  ".rubocop.yml",
  ".rubocop.yaml",
];

function filterExistingFiles(
  basePath: string,
  candidates: readonly string[],
): string[] {
  return candidates.filter((f) => existsSync(resolve(basePath, f)));
}

/**
 * Detect lock files present at `basePath`.
 * Returns all found (a project may have multiple ecosystems).
 */
export function detectLockFiles(basePath: string): string[] {
  return filterExistingFiles(basePath, KNOWN_LOCK_FILES);
}

/**
 * Detect linter config files present at `basePath`.
 */
export function detectLinterConfigs(basePath: string): string[] {
  return filterExistingFiles(basePath, KNOWN_LINTER_CONFIGS);
}

// ---------------------------------------------------------------------------
// Input discovery
// ---------------------------------------------------------------------------

export interface DiscoveredInputs {
  /** All input file paths (relative to basePath), sorted. */
  files: string[];
  /** Which lock files were detected. */
  lockFiles: string[];
  /** Which linter configs were detected. */
  linterConfigs: string[];
}

/**
 * Discover all input files that affect a compiled spec's output.
 *
 * Categories:
 * 1. Spec source file
 * 2. Linter configuration files
 * 3. Package manifest (package.json)
 * 4. Lock files (per-ecosystem)
 * 5. Referenced files from keyFiles
 * 6. Generated types (.vigiles/generated.d.ts)
 * 7. Extra files from freshnessInputs config
 */
export function discoverInputs(
  specFile: string,
  spec: ClaudeSpec,
  basePath: string,
  extraInputs?: string[],
): DiscoveredInputs {
  const files = new Set<string>();

  // 1. Spec source
  files.add(specFile);

  // 2. Linter configs
  const linterConfigs = detectLinterConfigs(basePath);
  for (const cfg of linterConfigs) files.add(cfg);

  // 3. Package manifest
  if (existsSync(resolve(basePath, "package.json"))) {
    files.add("package.json");
  }

  // 4. Lock files
  const lockFiles = detectLockFiles(basePath);
  for (const lf of lockFiles) files.add(lf);

  // 5. Referenced files from keyFiles
  if (spec.keyFiles) {
    for (const filePath of Object.keys(spec.keyFiles)) {
      files.add(filePath);
    }
  }

  // 6. Generated types
  if (existsSync(resolve(basePath, ".vigiles/generated.d.ts"))) {
    files.add(".vigiles/generated.d.ts");
  }

  // 7. Extra configured inputs
  if (extraInputs) {
    for (const f of extraInputs) files.add(f);
  }

  const sorted = [...files].sort();
  return { files: sorted, lockFiles, linterConfigs };
}

// ---------------------------------------------------------------------------
// Input hash computation
// ---------------------------------------------------------------------------

const INPUT_HASH_RE = /^<!-- vigiles:inputs:([a-f0-9]+) -->\r?\n?/m;

/**
 * Compute a combined SHA-256 fingerprint of all input files.
 * Missing files hash to "MISSING:<path>" so deletion changes the hash.
 */
export function computeInputHash(
  inputFiles: string[],
  basePath: string,
): string {
  const fileHashes = inputFiles.map((f) => {
    const fullPath = resolve(basePath, f);
    if (!existsSync(fullPath)) return `MISSING:${f}`;
    const content = readFileSync(fullPath);
    return sha256short(content);
  });
  return sha256short(fileHashes.join("\n"));
}

/** Embed input hash as an HTML comment in compiled markdown. */
export function addInputHash(markdown: string, inputHash: string): string {
  // Insert after the existing vigiles:sha256 comment (first line)
  const lines = markdown.split("\n");
  if (lines[0].startsWith("<!-- vigiles:sha256:")) {
    lines.splice(1, 0, `<!-- vigiles:inputs:${inputHash} -->`);
    return lines.join("\n");
  }
  // Fallback: prepend
  return `<!-- vigiles:inputs:${inputHash} -->\n${markdown}`;
}

/** Extract stored input hash from compiled markdown. */
export function extractInputHash(content: string): string | null {
  const match = content.match(INPUT_HASH_RE);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Freshness check result
// ---------------------------------------------------------------------------

export interface FreshnessResult {
  fresh: boolean;
  mode: FreshnessMode;
  reason?: string;
  /** Files that changed (input-hash mode only). */
  changedFiles?: string[];
}

/**
 * Check freshness of a compiled file using output-hash mode.
 * Only detects hand-edits to the compiled markdown.
 */
export function checkOutputHashFreshness(content: string): FreshnessResult {
  // Re-use existing hash verification
  const hashLine = content.match(
    /^<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->/,
  );
  if (!hashLine) {
    return {
      fresh: true,
      mode: "output-hash",
      reason: "No hash found (hand-written file)",
    };
  }
  const expectedHash = hashLine[1];
  const body = content
    .replace(
      /^<!-- vigiles:sha256:[a-f0-9]+ compiled from .+ -->\r?\n\r?\n?/,
      "",
    )
    .replace(INPUT_HASH_RE, "");
  const actualHash = sha256short(body);
  if (actualHash !== expectedHash) {
    return {
      fresh: false,
      mode: "output-hash",
      reason: "Compiled file was manually edited (hash mismatch)",
    };
  }
  return { fresh: true, mode: "output-hash" };
}

/**
 * Check freshness using input-hash mode.
 * Compares stored input fingerprint against current file state.
 */
export function checkInputHashFreshness(
  content: string,
  inputFiles: string[],
  basePath: string,
): FreshnessResult {
  const storedHash = extractInputHash(content);
  if (!storedHash) {
    return {
      fresh: false,
      mode: "input-hash",
      reason: "No input hash found — run `vigiles compile` to generate one",
    };
  }

  const currentHash = computeInputHash(inputFiles, basePath);
  if (storedHash !== currentHash) {
    // Report missing files (we can't identify other changes without
    // storing per-file hashes, but missing files are obvious)
    const changedFiles: string[] = [];
    for (const f of inputFiles) {
      if (!existsSync(resolve(basePath, f))) {
        changedFiles.push(`${f} (deleted)`);
      }
    }

    return {
      fresh: false,
      mode: "input-hash",
      reason: "Inputs changed since last compile — run `vigiles compile`",
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    };
  }

  return { fresh: true, mode: "input-hash" };
}

// ---------------------------------------------------------------------------
// Per-file sidecar manifest
// ---------------------------------------------------------------------------

/** Per-file hashes stored in .vigiles/<target>.inputs.json. */
export interface SidecarManifest {
  /** The spec source file (relative to basePath). */
  specFile: string;
  /** The compilation target (e.g., "CLAUDE.md"). */
  target: string;
  /** ISO 8601 timestamp of last compilation. */
  compiledAt: string;
  /** Per-file SHA-256 hashes (truncated to 16 hex chars). */
  files: Record<string, string>;
}

/** Result of diffing a sidecar manifest against current file state. */
export interface SidecarDiff {
  fresh: boolean;
  /** Files whose content hash changed. */
  changed: string[];
  /** Files that existed at compile time but are now missing. */
  deleted: string[];
  /** Files now discovered as inputs that weren't tracked before. */
  added: string[];
}

/**
 * Compute per-file SHA-256 hashes for all input files.
 * Missing files map to "MISSING" so deletion is detectable.
 */
export function computePerFileHashes(
  inputFiles: string[],
  basePath: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of inputFiles) {
    const fullPath = resolve(basePath, f);
    if (!existsSync(fullPath)) {
      result[f] = "MISSING";
    } else {
      const content = readFileSync(fullPath);
      result[f] = sha256short(content);
    }
  }
  return result;
}

/** Path to the sidecar manifest for a given target. */
export function sidecarPath(basePath: string, target: string): string {
  return resolve(basePath, ".vigiles", `${target}.inputs.json`);
}

/**
 * Write a sidecar manifest to .vigiles/<target>.inputs.json.
 * Creates the .vigiles/ directory if it doesn't exist.
 */
export function writeSidecarManifest(
  basePath: string,
  manifest: SidecarManifest,
): void {
  const dir = resolve(basePath, ".vigiles");
  mkdirSync(dir, { recursive: true });
  const filePath = sidecarPath(basePath, manifest.target);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Read a sidecar manifest. Returns null if the file doesn't exist
 * or can't be parsed.
 */
export function readSidecarManifest(
  basePath: string,
  target: string,
): SidecarManifest | null {
  const filePath = sidecarPath(basePath, target);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SidecarManifest;
  } catch {
    return null;
  }
}

/**
 * Diff a stored sidecar manifest against current file state.
 *
 * Compares the stored per-file hashes against freshly computed hashes
 * for the current input set. Reports changed, deleted, and newly
 * discovered files individually.
 */
export function diffSidecarManifest(
  manifest: SidecarManifest,
  currentInputFiles: string[],
  basePath: string,
): SidecarDiff {
  const currentHashes = computePerFileHashes(currentInputFiles, basePath);
  const changed: string[] = [];
  const deleted: string[] = [];
  const added: string[] = [];

  // Check files that were tracked at compile time
  for (const [file, storedHash] of Object.entries(manifest.files)) {
    if (!(file in currentHashes)) {
      // File was tracked but is no longer in the discovered input set.
      // Check if it still exists on disk — if not, it's deleted.
      if (!existsSync(resolve(basePath, file))) {
        deleted.push(file);
      }
      continue;
    }
    const currentHash = currentHashes[file];
    if (currentHash === "MISSING" && storedHash !== "MISSING") {
      deleted.push(file);
    } else if (currentHash !== storedHash) {
      changed.push(file);
    }
  }

  // Check for newly discovered inputs not in the manifest
  for (const file of currentInputFiles) {
    if (!(file in manifest.files)) {
      added.push(file);
    }
  }

  const fresh =
    changed.length === 0 && deleted.length === 0 && added.length === 0;
  return { fresh, changed, deleted, added };
}

// ---------------------------------------------------------------------------
// Affected-specs reporter
// ---------------------------------------------------------------------------

/**
 * Read all sidecar manifests from .vigiles/ and build a reverse index
 * from input file → affected targets.
 *
 * Returns a map: { "eslint.config.mjs": ["CLAUDE.md", "AGENTS.md"], ... }
 */
export function buildReverseIndex(basePath: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const dir = resolve(basePath, ".vigiles");
  if (!existsSync(dir)) return index;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return index;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".inputs.json")) continue;
    const manifest = readSidecarManifest(
      basePath,
      entry.replace(".inputs.json", ""),
    );
    if (!manifest) continue;
    for (const file of Object.keys(manifest.files)) {
      const targets = index.get(file);
      if (targets) {
        targets.push(manifest.target);
      } else {
        index.set(file, [manifest.target]);
      }
    }
  }
  return index;
}

/**
 * Given a list of changed files, return which spec targets are affected.
 *
 * Uses the reverse index built from sidecar manifests. A target is
 * affected if any of its tracked input files appear in the changed set.
 */
export function affectedSpecs(
  basePath: string,
  changedFiles: string[],
): string[] {
  const index = buildReverseIndex(basePath);
  const affected = new Set<string>();
  for (const file of changedFiles) {
    const targets = index.get(file);
    if (targets) {
      for (const t of targets) affected.add(t);
    }
  }
  return [...affected].sort();
}
