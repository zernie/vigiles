/**
 * The Ruff kit: the version the repository pins, run through `uvx`, the
 * reading's settings as the TOML Ruff reads, and `--output-format json` read
 * back as per-file reports.
 */
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { load as loadYaml } from "js-yaml";
import { join, posix } from "node:path";
import { z } from "zod";
import type { ProofKit } from "../port.js";
import { jsonArray, toRelative, unreadable } from "../report.js";
import type { FileReport, LintParse, ReadingScope } from "../types.js";

/** One Ruff configuration of one rule. */
export interface RuffReading {
  readonly linter: "ruff";
  /** The rule code: `E501`. */
  readonly rule: string;
  /** Ruff settings in the pinned version's own dialect, e.g. `{ "line-length": 100 }`. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly scope: ReadingScope;
}

const lockSchema = z.object({
  package: z.array(z.object({ name: z.string(), version: z.string() })),
});

function fromLock(text: string): string | null {
  try {
    const lock = lockSchema.safeParse(parseToml(text));
    return lock.success
      ? (lock.data.package.find((p) => p.name === "ruff")?.version ?? null)
      : null;
  } catch {
    return null;
  }
}

const EXACT = /^\s*ruff\s*==\s*([\w.]+)\s*$/m;

const exact = (text: string): string | null => EXACT.exec(text)?.[1] ?? null;

/** Every string anywhere in a parsed document. */
function strings(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

function fromPyproject(text: string): string | null {
  try {
    return (
      strings(parseToml(text))
        .map(exact)
        .find((v) => v !== null) ?? null
    );
  } catch {
    return null;
  }
}

const preCommitSchema = z.object({
  repos: z.array(z.object({ repo: z.string(), rev: z.string().optional() })),
});

function fromPreCommit(text: string): string | null {
  try {
    const config = preCommitSchema.safeParse(loadYaml(text));
    const rev = config.success
      ? config.data.repos.find((r) => r.repo.endsWith("/ruff-pre-commit"))?.rev
      : undefined;
    return rev === undefined ? null : rev.replace(/^v/, "");
  } catch {
    return null;
  }
}

const LOCKS = ["uv.lock", "poetry.lock", "pdm.lock"] as const;
const REQUIREMENTS = /^requirements.*\.txt$/;
const PYPROJECT = "pyproject.toml";
const PRE_COMMIT = ".pre-commit-config.yaml";

/**
 * The Ruff version a repository pins, from the files it would come from, most
 * exact first: a lockfile, then `ruff==` in a requirements file or
 * `pyproject.toml`, then the pre-commit hook's `rev`. A ranged requirement is no
 * pin. Keys are file names at the repository root, values their text.
 */
export function ruffPin(
  files: Readonly<Record<string, string>>,
): string | null {
  const named = (keep: (name: string) => boolean): readonly string[] =>
    Object.entries(files)
      .filter(([name]) => keep(name))
      .map(([, text]) => text);
  const candidates: readonly (() => string | null)[] = [
    ...LOCKS.flatMap((lock) => named((n) => n === lock)).map(
      (t) => () => fromLock(t),
    ),
    ...named((n) => REQUIREMENTS.test(n)).map((t) => () => exact(t)),
    ...named((n) => n === PYPROJECT).map((t) => () => fromPyproject(t)),
    ...named((n) => n === PRE_COMMIT).map((t) => () => fromPreCommit(t)),
  ];
  return candidates.reduce<string | null>(
    (found, next) => found ?? next(),
    null,
  );
}

const isPinFile = (name: string): boolean =>
  LOCKS.some((lock) => lock === name) ||
  REQUIREMENTS.test(name) ||
  name === PYPROJECT ||
  name === PRE_COMMIT;

const settingsSchema = z.record(z.string(), z.any());

/** A reading's settings as the TOML file `--config` reads. */
export function ruffConfigToml(settings: RuffReading["settings"]): string {
  return stringifyToml(settingsSchema.parse(settings));
}

const reportSchema = z.array(
  z.object({
    code: z.string().nullable(),
    filename: z.string(),
    message: z.string(),
  }),
);

/** How each Ruff version spells "this file did not parse". */
const PARSE_CODES: ReadonlySet<string | null> = new Set([
  null,
  "E999",
  "invalid-syntax",
  "syntax-error",
]);

/**
 * Ruff's `--output-format json` as per-file reports. Ruff lists diagnostics,
 * not files, so the files passed in are the denominator: one with no
 * diagnostic was linted and is clean.
 */
export function parseRuffReport(
  stdout: string,
  dir: string,
  files: readonly string[],
  rule: string,
): LintParse {
  const parsed = reportSchema.safeParse(jsonArray(stdout));
  if (!parsed.success) return unreadable(stdout);
  const diags = parsed.data.map((d) => ({
    ...d,
    path: toRelative(dir, d.filename),
  }));
  return {
    kind: "parsed",
    files: files.map((path): FileReport => {
      const own = diags.filter((d) => d.path === path);
      const broken = own.find((d) => PARSE_CODES.has(d.code));
      if (broken !== undefined)
        return { path, kind: "parse-error", message: broken.message };
      return {
        path,
        kind: "linted",
        hits: own.filter((d) => d.code === rule).length,
      };
    }),
  };
}

export const ruffKit: ProofKit<RuffReading> = {
  linter: "ruff",
  plan(root) {
    const pins = root.names.filter(isPinFile);
    const version = ruffPin(
      Object.fromEntries(pins.map((n) => [n, root.read(n) ?? ""])),
    );
    if (version === null)
      return {
        kind: "none",
        stage: "no-pin",
        reason:
          "no exact Ruff pin in a lockfile, requirements, pyproject.toml or pre-commit",
      };
    const tool = `ruff@${version}`;
    return {
      kind: "plan",
      install: ["uvx", tool, "--version"],
      command: () => ["uvx", tool],
      version: () => version,
      missing: "",
    };
  },
  env: (cacheDir) => ({ UV_CACHE_DIR: posix.join(cacheDir, "uv") }),
  // The config sits in the repository, so a relative `extend` in the settings
  // resolves against the repository as it would in the repository's own file.
  invocation: (reading, files, { dir }) => {
    const configPath = join(dir, ".vigiles-rule-proof.ruff.toml");
    return {
      configPath,
      configText: ruffConfigToml(reading.settings),
      args: [
        ...["check", "--no-cache", "--output-format", "json", "--exit-zero"],
        // A reading's own settings may not change WHAT is measured: with
        // `force-exclude` an excluded twin vanishes from the report and would
        // read clean, and with `fix` the planted violation is rewritten away.
        ...["--no-force-exclude", "--no-fix"],
        ...["--select", reading.rule, "--config", configPath, ...files],
      ],
    };
  },
  reportCodes: [0],
  parse: (stdout, files, reading, dir) =>
    parseRuffReport(stdout, dir, files, reading.rule),
};
