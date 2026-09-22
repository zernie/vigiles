/**
 * The bounded reader an adapter's `advisories` is handed — built HERE, by the
 * domain, never by the adapter.
 *
 * 🔴 WHY A READER AND NOT A ROOT. It is the same rule `detect(exists)` follows:
 * an adapter given a directory and `node:fs` could enumerate anything under it,
 * so registering an adapter would change what vigiles reads in someone's
 * repository. {@link InstallReader.repo} answers only for paths that adapter
 * `claims`, and spells a refusal exactly like an absence — so an adapter cannot
 * even probe for the existence of a file outside its own surface.
 *
 * Two facts travel as VALUES rather than reads, because the shipped checks need
 * them from files NO adapter claims: the repo's `package.json`, and vigiles's
 * own package inside `node_modules`. Reading those is the domain's business, so
 * the domain reads them once and passes the answer instead of widening the port.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessAdapter, InstallReader } from "./adapter.js";

/** Read a file, or null when it is missing or unreadable. Never throws. */
function readOrNull(absolute: string): string | null {
  try {
    return existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Directory names directly under `dir`, or [] when it is not readable. */
function dirNames(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Is `vigiles` a declared dependency of this `package.json` text? Pure. Any of
 * the four dependency fields counts — the question is "did this repo take
 * vigiles on", not how. The vigiles repo itself is not a consumer: it IS the
 * package, so it answers false.
 */
export function declaresVigilesDependency(pkgJson: string): boolean {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (pkg.name === "vigiles") return false;
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].some((f) => {
    const deps = pkg[f];
    return typeof deps === "object" && deps !== null && "vigiles" in deps;
  });
}

/**
 * Build the reader for one adapter over one repo root.
 *
 * `home` is injectable so the machine read is testable without a real `$HOME`;
 * it defaults to the user's own. Everything it feeds is advisory-only.
 */
export function buildInstallReader(
  adapter: HarnessAdapter,
  root: string,
  opts: { readonly home?: string } = {},
): InstallReader {
  const pkgJson = readOrNull(join(root, "package.json"));
  const home = opts.home ?? homedir();
  return {
    repo: (repoRelative) =>
      adapter.claims(repoRelative)
        ? readOrNull(resolve(root, repoRelative))
        : null,
    home: (homeRelative) => readOrNull(join(home, homeRelative)),
    repoDependsOnVigiles:
      pkgJson !== null && declaresVigilesDependency(pkgJson),
    vendoredSkillNames: dirNames(
      join(root, "node_modules", "vigiles", "skills"),
    ),
  };
}
