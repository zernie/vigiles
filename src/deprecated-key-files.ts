/**
 * The `deprecated-key-files` rule: every instruction spec that still uses the
 * deprecated `keyFiles` field. ONE detector, two readers — `lint` (this file's
 * `checkDeprecatedKeyFiles`) and `audit` (`scanPlugin`'s `deprecatedKeyFiles`)
 * both call {@link findDeprecatedKeyFiles}, so they cannot disagree.
 *
 * The decisions — what a spec's `keyFiles` costs, what the finding says — are
 * pure and live in `core/keyfiles.ts` / `core/keyfiles-source.ts`; this module
 * owns what is left: matching specs to findings and printing them. The
 * effects — walking the repository and reading files — happen in the composition root (`cli-main.ts`,
 * `specsUsingKeyFiles`) and are handed in. Migration guide:
 * docs/rules/deprecated-key-files.md.
 */
import { findKeyFilesInSpecSource } from "./core/keyfiles-source.js";
import {
  instructionFileOfSpec,
  keyFilesDeprecationMessage,
  type KeyFilesUsage,
} from "./core/keyfiles.js";
import type { RuleSeverity } from "./core/types.js";

/** One spec still using `keyFiles`, relative to the directory searched. */
export interface DeprecatedKeyFilesFinding extends KeyFilesUsage {
  readonly path: string;
}

/**
 * The detector: of the given instruction specs, the ones still using
 * `keyFiles`, sorted by path. The file walk and the reads are the caller's
 * (the composition root), so this stays free of I/O.
 */
export function findDeprecatedKeyFiles(io: {
  /** Instruction specs (`**\/*.md.spec.ts`, the glob `compile` uses), relative paths. */
  readonly specPaths: readonly string[];
  readonly read: (path: string) => string;
}): readonly DeprecatedKeyFilesFinding[] {
  return [...io.specPaths].sort().flatMap((path) => {
    const usage = findKeyFilesInSpecSource(io.read(path));
    return usage === null ? [] : [{ path, ...usage }];
  });
}

/**
 * `lint`'s side of the rule. Runs ONCE over the repository, like the
 * instruction-weight ratchet: a nested bundle's spec would otherwise be
 * reported again by every bundle that encloses it. Warning by default — a
 * deprecation that gated would turn a consumer's CI red on upgrade, which the
 * one-major window exists to prevent.
 */
export function checkDeprecatedKeyFiles(opts: {
  readonly severity: RuleSeverity;
  /** Called only when the rule is on. */
  readonly find: () => readonly DeprecatedKeyFilesFinding[];
  readonly silent: boolean;
  /** One per finding, with the spec's path relative to `root`. */
  readonly annotate: (
    level: "error" | "warning",
    message: string,
    path: string,
  ) => void;
}): { readonly issues: number; readonly errors: number } {
  const { severity } = opts;
  if (!severity) return { issues: 0, errors: 0 };
  const found = opts.find();
  const mark = severity === "error" ? "✗" : "⚠";
  const level = severity === "error" ? "error" : "warning";
  if (!opts.silent && found.length > 0)
    console.log("\nDeprecated-key-files check:\n");
  // Silent (`--json`, `--summary`) prints nothing at all, annotations
  // included: they go to stdout and would corrupt the JSON.
  if (!opts.silent)
    found.forEach((f) => {
      const message = keyFilesDeprecationMessage(
        f,
        instructionFileOfSpec(f.path),
      );
      console.log(`  ${mark} ${f.path}: ${message}`);
      opts.annotate(level, message, f.path);
    });
  return {
    issues: found.length,
    errors: severity === "error" ? found.length : 0,
  };
}
