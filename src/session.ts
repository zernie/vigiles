/**
 * Post-session audit: analyze what an agent changed vs. what specs expected.
 *
 * Compares the git diff (files changed since a base ref) against the spec
 * surface area (keyFiles, commands, tracked inputs). Reports:
 * - Files modified that aren't in any spec's keyFiles
 * - Specs whose inputs changed (may need recompile)
 *
 * Read-only analysis. No commands executed, no files modified.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { iterateSidecars } from "./sidecar.js";
import type { SidecarManifest } from "./sidecar.js";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get files changed since a base ref (commit, branch, or HEAD~N).
 * Returns paths relative to the repo root.
 *
 * Uses execFileSync with an argv array — `baseRef` is passed as a separate
 * argument so shell metacharacters can't escape into command execution.
 * `--no-renames` keeps both source and destination paths visible (without it,
 * `git mv old.ts new.ts` would only report `new.ts`).
 *
 * Throws on git failure (e.g., invalid baseRef) so a typo doesn't silently
 * masquerade as "no changes" and suppress real findings downstream.
 */
export function gitChangedFiles(basePath: string, baseRef: string): string[] {
  const exec = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

  let diffOutput: string;
  try {
    diffOutput = exec([
      "diff",
      "--name-only",
      "--no-renames",
      baseRef,
      "--",
      ".",
    ]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`git diff failed for baseRef "${baseRef}": ${detail}`, {
      cause: e,
    });
  }

  let untrackedOutput = "";
  try {
    untrackedOutput = exec([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".",
    ]);
  } catch {
    // ls-files failure is non-fatal — diff already succeeded
  }

  const files = new Set<string>();
  if (diffOutput) {
    for (const f of diffOutput.split("\n")) files.add(f);
  }
  if (untrackedOutput) {
    for (const f of untrackedOutput.split("\n")) files.add(f);
  }
  return [...files].sort();
}

/**
 * Get the most recent commit hash. Returns null if not a git repo.
 */
export function gitHead(basePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Find a reasonable base ref for session analysis.
 *
 * Strategy:
 * 1. If `--base` is provided, use it directly.
 * 2. If sidecar manifests exist, use the most recent compiledAt commit.
 * 3. Fall back to HEAD (shows only uncommitted changes).
 */
export function resolveBaseRef(explicitBase?: string): string {
  if (explicitBase) return explicitBase;
  return "HEAD";
}

// ---------------------------------------------------------------------------
// Spec surface area
// ---------------------------------------------------------------------------

/** Aggregated surface area from all specs via sidecar manifests. */
export interface SpecSurface {
  /** All files declared in any spec's keyFiles. */
  keyFiles: Set<string>;
  /** All files tracked as inputs to any spec. */
  trackedInputs: Set<string>;
  /** All spec source files. */
  specFiles: Set<string>;
  /** All compiled targets. */
  targets: Set<string>;
  /** Map: file → which spec targets track it. */
  fileToSpecs: Map<string, string[]>;
  /** Loaded manifests. */
  manifests: SidecarManifest[];
}

/**
 * Load all sidecar manifests and build the aggregate spec surface area.
 */
export function loadSpecSurface(basePath: string): SpecSurface {
  const surface: SpecSurface = {
    keyFiles: new Set(),
    trackedInputs: new Set(),
    specFiles: new Set(),
    targets: new Set(),
    fileToSpecs: new Map(),
    manifests: [],
  };

  iterateSidecars(basePath, (_target, manifest) => {
    surface.manifests.push(manifest);
    surface.targets.add(manifest.target);
    surface.specFiles.add(manifest.specFile);

    for (const file of Object.keys(manifest.files)) {
      surface.trackedInputs.add(file);
      const specs = surface.fileToSpecs.get(file);
      if (specs) {
        specs.push(manifest.target);
      } else {
        surface.fileToSpecs.set(file, [manifest.target]);
      }
    }
  });

  return surface;
}

/**
 * Load keyFiles from compiled markdown files. Reads each target's
 * "## Key Files" section and extracts the file paths.
 */
export function loadKeyFilesFromSpecs(basePath: string): Set<string> {
  const keyFiles = new Set<string>();

  iterateSidecars(basePath, (_target, manifest) => {
    const targetPath = resolve(basePath, manifest.target);
    if (!existsSync(targetPath)) return;

    try {
      // Normalize CRLF → LF so the regex works on Windows checkouts.
      const content = readFileSync(targetPath, "utf-8").replace(/\r\n/g, "\n");
      const keyFilesMatch = content.match(
        /## Key Files\n\n((?:- `[^`]+` — .+\n?)+)/,
      );
      if (keyFilesMatch) {
        const lines = keyFilesMatch[1].split("\n");
        for (const line of lines) {
          const pathMatch = line.match(/^- `([^`]+)`/);
          if (pathMatch) keyFiles.add(pathMatch[1]);
        }
      }
    } catch {
      // Skip unreadable files
    }
  });

  return keyFiles;
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

/** A finding about a file not tracked by any spec. */
interface UntrackedFinding {
  type: "untracked-file";
  file: string;
  message: string;
}

/** A finding about a file tracked by one or more specs. */
interface TrackedFinding {
  type: "stale-spec" | "spec-modified" | "target-modified";
  file: string;
  message: string;
  specs: string[];
}

/** A single finding from session analysis. */
export type SessionFinding = UntrackedFinding | TrackedFinding;

/** Full session analysis result. */
export interface SessionReport {
  /** Git base ref used for comparison. */
  baseRef: string;
  /** All files changed since baseRef. */
  changedFiles: string[];
  /** Files changed that are tracked by at least one spec. */
  trackedChanges: string[];
  /** Files changed that are NOT tracked by any spec. */
  untrackedChanges: string[];
  /** Individual findings. */
  findings: SessionFinding[];
}

/**
 * Analyze a session: compare changed files against spec surface area.
 */
export function analyzeSession(
  basePath: string,
  baseRef: string,
): SessionReport {
  const changedFiles = gitChangedFiles(basePath, baseRef);
  const surface = loadSpecSurface(basePath);
  const keyFiles = loadKeyFilesFromSpecs(basePath);

  const trackedChanges: string[] = [];
  const untrackedChanges: string[] = [];
  const findings: SessionFinding[] = [];

  for (const file of changedFiles) {
    const isTracked = surface.trackedInputs.has(file) || keyFiles.has(file);
    // Treat any *.md.spec.ts as a spec even when sidecars haven't been
    // written yet — without this, the first compile after `vigiles init`
    // would silently drop the spec edit from the session report.
    const isSpec = surface.specFiles.has(file) || file.endsWith(".md.spec.ts");
    const isTarget = surface.targets.has(file);
    const affectedSpecs = surface.fileToSpecs.get(file);

    if (isTarget) {
      findings.push({
        type: "target-modified",
        file,
        message: `Compiled output modified directly — edit the .spec.ts source instead`,
        specs: affectedSpecs ?? [],
      });
      trackedChanges.push(file);
    } else if (isSpec) {
      findings.push({
        type: "spec-modified",
        file,
        message: "Spec modified — run `vigiles compile` to update output",
        specs: affectedSpecs ?? [],
      });
      trackedChanges.push(file);
    } else if (isTracked) {
      findings.push({
        type: "stale-spec",
        file,
        message: `Tracked input changed — affected specs may need recompile`,
        specs: affectedSpecs ?? [],
      });
      trackedChanges.push(file);
    } else if (!file.startsWith(".vigiles/") && !isIgnoredFile(file)) {
      // Agent modified a file not in any spec
      untrackedChanges.push(file);
      findings.push({
        type: "untracked-file",
        file,
        message: "Modified file not tracked by any spec",
      });
    }
  }

  return {
    baseRef,
    changedFiles,
    trackedChanges,
    untrackedChanges,
    findings,
  };
}

/** Files that are always expected to change and shouldn't be flagged. */
function isIgnoredFile(file: string): boolean {
  return (
    file === "package-lock.json" ||
    file === "yarn.lock" ||
    file === "pnpm-lock.yaml" ||
    file === "bun.lockb" ||
    file.startsWith("node_modules/") ||
    file.startsWith("dist/") ||
    file.startsWith(".git/")
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a session report as human-readable text. */
export function formatSessionReport(report: SessionReport): string {
  if (report.changedFiles.length === 0) {
    return "No changes detected since " + report.baseRef;
  }

  const lines: string[] = [];
  lines.push(
    `Session analysis (${String(report.changedFiles.length)} files changed since ${report.baseRef}):`,
  );
  lines.push("");

  const stale = report.findings.filter(
    (f): f is TrackedFinding => f.type === "stale-spec",
  );
  const untracked = report.findings.filter(
    (f): f is UntrackedFinding => f.type === "untracked-file",
  );
  const targetMods = report.findings.filter(
    (f): f is TrackedFinding => f.type === "target-modified",
  );
  const specMods = report.findings.filter(
    (f): f is TrackedFinding => f.type === "spec-modified",
  );

  if (targetMods.length > 0) {
    lines.push("  Compiled outputs modified directly:");
    for (const f of targetMods) {
      lines.push(`    ${f.file} — edit the .spec.ts source instead`);
    }
    lines.push("");
  }

  if (specMods.length > 0) {
    lines.push("  Specs modified:");
    for (const f of specMods) {
      lines.push(`    ${f.file} — run vigiles compile`);
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push("  Tracked inputs changed (specs may need recompile):");
    for (const f of stale) {
      const specList = f.specs.join(", ") || "unknown";
      lines.push(`    ${f.file} (affects ${specList})`);
    }
    lines.push("");
  }

  if (untracked.length > 0) {
    lines.push("  Files not tracked by any spec:");
    for (const f of untracked) {
      lines.push(`    ${f.file}`);
    }
    lines.push("");
  }

  // Summary
  const issues = targetMods.length + stale.length;
  if (issues === 0 && untracked.length === 0) {
    lines.push("  All changes are within spec surface area.");
  } else {
    const parts: string[] = [];
    if (targetMods.length > 0)
      parts.push(
        `${String(targetMods.length)} compiled output(s) edited directly`,
      );
    if (stale.length > 0)
      parts.push(`${String(stale.length)} input(s) changed`);
    if (untracked.length > 0)
      parts.push(`${String(untracked.length)} untracked file(s)`);
    lines.push("  Summary: " + parts.join(", "));
  }

  return lines.join("\n");
}
