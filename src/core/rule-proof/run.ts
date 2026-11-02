/**
 * `experimental_ruleProof`'s three steps, over the {@link RuleProofHost} port
 * and a set of {@link ProofKit}s. This file names no machine and no linter: the
 * host adapter does every effect, a kit knows its linter, and the entry root
 * hands both in.
 *
 *   install(linter, dir)   → a PinnedLinter: the repository's own linter version
 *   prove(pinned, reading, { bad, good })
 *                          → a ProvedReading only when the planted violation is
 *                            flagged AND its twin is not
 *   flagged(proved)        → the repository files that reading flags
 *
 * Each step takes a value only the step before can make. So a reading cannot be
 * run over a repository before it passed its pair, the pair cannot be half a
 * pair, and the pair cannot be checked at one linter version and the
 * repository run at another: `flagged` takes the ProvedReading alone, and it
 * carries the PinnedLinter it was proved on. The classes are nominal (a
 * `private` member), so an object of the same shape is not one.
 */
import { join, posix, relative } from "node:path";
import { inScope, judgePair, summarize } from "./pair.js";
import type { ProofKit, RuleProofHost } from "./port.js";
import type {
  BaseReading,
  ExecResult,
  FileReport,
  FlaggedRun,
  InstallOptions,
  LintParse,
  NotInstalled,
  NotRun,
  NotRunStage,
  PlantedFile,
  PlantedPair,
} from "./types.js";

type Settled = Required<InstallOptions>;

/** A repository's own linter at its pinned version. Only `install` makes one. */
export class PinnedLinter<R extends BaseReading> {
  declare private readonly brand: "pinned";
  /** @internal */
  constructor(
    readonly linter: R["linter"],
    readonly version: string,
    readonly dir: string,
    /** @internal the kit, the argv prefix that runs the linter, the settled options */
    readonly run: {
      readonly kit: ProofKit<R>;
      readonly command: readonly string[];
      readonly options: Settled;
    },
  ) {}
}

/** A reading that passed its planted pair on one PinnedLinter. Only `prove` makes one. */
export class ProvedReading<R extends BaseReading> {
  declare private readonly brand: "proved";
  /** @internal */
  constructor(
    readonly pinned: PinnedLinter<R>,
    readonly reading: R,
  ) {}
}

/** The install's outcome. */
export type Installed<R extends BaseReading> =
  | { readonly kind: "installed"; readonly linter: PinnedLinter<R> }
  | NotInstalled;

/** The verdict on one reading's planted pair. */
export type Proof<R extends BaseReading> =
  | { readonly kind: "proved"; readonly reading: ProvedReading<R> }
  | {
      readonly kind: "not-proved";
      readonly badHits: number;
      readonly goodHits: number;
    }
  | NotRun;

/** One lint call: per-file reports, or no verdict. */
type LintRun =
  | { readonly kind: "files"; readonly files: readonly FileReport[] }
  | NotRun;

const CONFIG_LOAD = "config-load";

const tail = (text: string): string =>
  text.trim().split("\n").slice(-5).join("\n");

const notInstalled = (
  stage: NotInstalled["stage"],
  reason: string,
): NotInstalled => ({ kind: "not-installed", stage, reason });

const notRun = (stage: NotRunStage, reason: string): NotRun => ({
  kind: "not-run",
  stage,
  reason,
});

/** An ExecResult that is not a clean exit, as why nothing was installed. */
function installFailure(command: string, r: ExecResult): NotInstalled | null {
  if (r.kind === "timeout")
    return notInstalled("timeout", `${command} ran past its time limit`);
  if (r.kind === "spawn-error")
    return notInstalled("install", `${command} could not start: ${r.message}`);
  if (r.kind === "killed")
    return notInstalled("install", `${command} was killed by ${r.signal}`);
  return r.code === 0
    ? null
    : notInstalled(
        "install",
        `${command} exited ${String(r.code)}: ${tail(r.stderr)}`,
      );
}

/** A lint call's stdout, or why there is no report to read. */
function outputOf(
  r: ExecResult,
  reportCodes: readonly number[],
): NotRun | { readonly kind: "output"; readonly stdout: string } {
  if (r.kind === "timeout")
    return notRun("timeout", "the linter ran past its time limit");
  if (r.kind === "spawn-error")
    return notRun(CONFIG_LOAD, `the linter could not start: ${r.message}`);
  if (r.kind === "killed")
    return notRun(CONFIG_LOAD, `the linter was killed by ${r.signal}`);
  if (!reportCodes.includes(r.code))
    return notRun(CONFIG_LOAD, tail(`${r.stderr}\n${r.stdout}`));
  return { kind: "output", stdout: r.stdout };
}

const fromParse = (parse: LintParse): LintRun =>
  parse.kind === "unreadable"
    ? notRun(CONFIG_LOAD, parse.reason)
    : { kind: "files", files: parse.files };

/** Files per lint call, so a large repository never meets the argv limit. */
const CHUNK = 200;

/** `a/b/c.js` → `["a", "a/b"]`. */
const ancestorsOf = (path: string): readonly string[] =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

const settle = (o: InstallOptions): Settled => ({
  installTimeoutMs: 600_000,
  lintTimeoutMs: 150_000,
  ...o,
});

/** HOME and the shared caches under `cacheDir`, plus the kit's own tools' caches. */
function envFor<R extends BaseReading>(
  kit: ProofKit<R>,
  cacheDir: string,
): Readonly<Record<string, string>> {
  return {
    HOME: posix.join(cacheDir, "home"),
    XDG_CACHE_HOME: posix.join(cacheDir, "xdg"),
    CI: "1",
    ...kit.env(cacheDir),
  };
}

function install<R extends BaseReading>(
  host: RuleProofHost,
  kit: ProofKit<R>,
  dir: string,
  o: Settled,
): Installed<R> {
  const plan = kit.plan({
    names: host.list(dir),
    read: (name) => host.read(join(dir, name)),
  });
  if (plan.kind === "none") return notInstalled(plan.stage, plan.reason);
  const [command, ...args] = plan.install;
  const env = envFor(kit, o.cacheDir);
  const failed = installFailure(
    command,
    host.exec(command, args, { cwd: dir, env, timeoutMs: o.installTimeoutMs }),
  );
  if (failed !== null) return failed;
  const version = plan.version((path) => host.read(join(dir, path)));
  if (version === null) return notInstalled("no-linter", plan.missing);
  const run = { kit, command: plan.command(dir), options: o };
  return {
    kind: "installed",
    linter: new PinnedLinter(kit.linter, version, dir, run),
  };
}

/** Lint `files` (relative paths) with one reading on its pinned linter. */
function lint<R extends BaseReading>(
  host: RuleProofHost,
  pinned: PinnedLinter<R>,
  reading: R,
  files: readonly string[],
): LintRun {
  const { kit, command, options } = pinned.run;
  const places = { dir: pinned.dir, cacheDir: options.cacheDir };
  const call = kit.invocation(reading, files, places);
  // A repository file at the scratch path is never overwritten, nor deleted.
  if (host.exists(call.configPath))
    return notRun(
      "scratch-path-taken",
      `${relative(pinned.dir, call.configPath)} already exists in the repository`,
    );
  host.write(call.configPath, call.configText);
  try {
    const [bin = "", ...prefix] = command;
    const result = host.exec(bin, [...prefix, ...call.args], {
      cwd: pinned.dir,
      env: envFor(kit, options.cacheDir),
      timeoutMs: options.lintTimeoutMs,
    });
    const out = outputOf(result, kit.reportCodes);
    if (out.kind === "not-run") return out;
    return fromParse(kit.parse(out.stdout, files, reading, pinned.dir));
  } finally {
    host.remove(call.configPath);
  }
}

/** Write a planted file; return what to remove: the topmost directory it created, or itself. */
function plant(host: RuleProofHost, dir: string, file: PlantedFile): string {
  const missing = ancestorsOf(file.path)
    .map((a) => join(dir, a))
    .find((a) => !host.exists(a));
  host.write(join(dir, file.path), file.text);
  return missing ?? join(dir, file.path);
}

/** Why a pair may not be planted at all. */
function blocked(
  host: RuleProofHost,
  dir: string,
  reading: BaseReading,
  pair: PlantedPair,
): NotRun | null {
  const planted = [pair.bad, pair.good];
  const outside = planted.find((f) => !inScope(f.path, reading.scope));
  if (outside !== undefined)
    return notRun(
      "pair-outside-scope",
      `${outside.path} is not in the reading's scope`,
    );
  const taken = planted.find((f) => host.exists(join(dir, f.path)));
  return taken === undefined
    ? null
    : notRun(
        "pair-path-taken",
        `${taken.path} already exists in the repository`,
      );
}

/** The pair's two reports, or which planted file the linter said nothing about. */
function pairReports(
  run: LintRun,
  pair: PlantedPair,
): NotRun | readonly [FileReport, FileReport] {
  if (run.kind === "not-run") return run;
  const reportOf = (f: PlantedFile): FileReport | undefined =>
    run.files.find((r) => r.path === f.path);
  const nothingFor = (f: PlantedFile): NotRun =>
    notRun(CONFIG_LOAD, `the linter reported nothing for ${f.path}`);
  const bad = reportOf(pair.bad);
  if (bad === undefined) return nothingFor(pair.bad);
  const good = reportOf(pair.good);
  return good === undefined ? nothingFor(pair.good) : [bad, good];
}

const isPair = (
  r: NotRun | readonly [FileReport, FileReport],
): r is readonly [FileReport, FileReport] => Array.isArray(r);

function prove<R extends BaseReading>(
  host: RuleProofHost,
  pinned: PinnedLinter<R>,
  reading: R,
  pair: PlantedPair,
): Proof<R> {
  const stop = blocked(host, pinned.dir, reading, pair);
  if (stop !== null) return stop;
  const created = [pair.bad, pair.good].map((f) => plant(host, pinned.dir, f));
  try {
    const paths = [pair.bad.path, pair.good.path];
    const reports = pairReports(lint(host, pinned, reading, paths), pair);
    if (!isPair(reports)) return reports;
    const judged = judgePair(...reports);
    return judged.kind === "proved"
      ? { kind: "proved", reading: new ProvedReading(pinned, reading) }
      : judged;
  } finally {
    created.forEach((p) => {
      host.remove(p);
    });
  }
}

function flagged<R extends BaseReading>(
  host: RuleProofHost,
  proved: ProvedReading<R>,
): FlaggedRun {
  const { pinned, reading } = proved;
  const files = host
    .files(pinned.dir, reading.scope.files)
    .filter((p) => inScope(p, reading.scope))
    .sort((a, b) => a.localeCompare(b));
  const chunks = Array.from(
    { length: Math.ceil(files.length / CHUNK) },
    (_, i) => files.slice(i * CHUNK, (i + 1) * CHUNK),
  );
  const results = chunks.map((chunk) => lint(host, pinned, reading, chunk));
  const stopped = results.find((r): r is NotRun => r.kind === "not-run");
  const reports = results.flatMap((r) => (r.kind === "files" ? r.files : []));
  return stopped ?? { kind: "ran", ...summarize(reports) };
}

/** A kit set keyed by linter name, each kit typed by its own reading. */
export type KitSet<M extends Record<string, BaseReading>> = {
  readonly [N in keyof M]: ProofKit<M[N]>;
};

/** The three steps over one host and one kit set. */
export function ruleProofWith<M extends Record<string, BaseReading>>(
  host: RuleProofHost,
  kits: KitSet<M>,
) {
  return {
    install: <N extends keyof M>(
      linter: N,
      dir: string,
      options: InstallOptions,
    ): Installed<M[N]> => install(host, kits[linter], dir, settle(options)),
    prove: <R extends BaseReading>(
      pinned: PinnedLinter<R>,
      // The reading's type comes from the pinned linter, never the other way:
      // a reading of another linter is a type error here.
      reading: NoInfer<R>,
      pair: PlantedPair,
    ): Proof<R> => prove(host, pinned, reading, pair),
    flagged: <R extends BaseReading>(proved: ProvedReading<R>): FlaggedRun =>
      flagged(host, proved),
  };
}
