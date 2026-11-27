/**
 * Run the built CLI inside the test's own process (#607): one Node start per test
 * file instead of one per assertion.
 *
 * It loads `dist/cli-main.js`, never the source: the CLI finds its shipped files
 * (the report template, the plugin) relative to its own module, and those exist
 * only beside the build. It captures what the run writes to stdout and stderr,
 * sets `env` for the run, and puts the process back as it found it.
 *
 * Machine I/O by nature (it swaps the process's streams, env and cwd for the
 * length of a run), so it lives in the host adapter. A capture buffer is mutable
 * by nature too, hence the two marked writes below.
 *
 * Not for `hook-runtime` (it ends through its own exit path) or `--serve` (it
 * blocks): spawn those.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Console } from "node:console";
import { Writable } from "node:stream";

/** How the run ended: the two endings `run` reports, or an error it let out. */
export type CliEnd = "stopped" | "finished" | "threw";

/** What a CLI run printed, how it ended, and the exit code a spawned bin would have had. */
export type CliResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly end: CliEnd;
};

type Env = Readonly<Record<string, string | undefined>>;
type Sink = Readonly<Writable>;

const BUILT_MAIN = pathToFileURL(
  resolve(import.meta.dirname, "..", "..", "dist", "cli-main.js"),
).href;

const setEnv = (k: string, v: string | undefined): void => {
  if (v === undefined) Reflect.deleteProperty(process.env, k);
  else Reflect.set(process.env, k, v);
};

/** Lay `env` over the process environment (undefined deletes a key); returns the undo. */
function applyEnv(env: Env): () => void {
  const before = Object.keys(env).map((k) => [k, process.env[k]] as const);
  Object.entries(env).forEach(([k, v]) => {
    setEnv(k, v);
  });
  return () => {
    before.forEach(([k, v]) => {
      setEnv(k, v);
    });
  };
}

/** A stream that keeps what is written to it. */
function sink(): { readonly stream: Sink; readonly text: () => string } {
  // eslint-disable-next-line functional/prefer-immutable-types -- a capture buffer accumulates by nature.
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Readonly<Buffer> | string, _enc, done): void {
      // eslint-disable-next-line functional/immutable-data -- same buffer.
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** Send `process.<name>.write` (a direct write) into `to`; returns the undo. */
function redirect(name: "stdout" | "stderr", to: Sink): () => void {
  const stream = process[name];
  const original: unknown = Reflect.get(stream, "write");
  Reflect.set(stream, "write", (chunk: string | Readonly<Uint8Array>) =>
    to.write(chunk),
  );
  return () => {
    Reflect.set(stream, "write", original);
  };
}

/**
 * Install a console writing to `out`/`err`: a test runner may replace the global
 * console with its own, which never reaches `process.stdout`. Returns the undo.
 */
function swapConsole(out: Sink, err: Sink): () => void {
  const original = globalThis.console;
  Reflect.set(globalThis, "console", new Console({ stdout: out, stderr: err }));
  return () => {
    Reflect.set(globalThis, "console", original);
  };
}

/** Capture both streams and lay `env` over the process; `undo` puts all of it back. */
function enterCapture(env: Env): {
  readonly out: ReturnType<typeof sink>;
  readonly err: ReturnType<typeof sink>;
  readonly undo: () => void;
} {
  const out = sink();
  const err = sink();
  const cwd = process.cwd();
  const undos = [
    applyEnv(env),
    redirect("stdout", out.stream),
    redirect("stderr", err.stream),
    swapConsole(out.stream, err.stream),
  ];
  return {
    out,
    err,
    undo: () => {
      undos.forEach((u) => {
        u();
      });
      process.chdir(cwd);
    },
  };
}

/**
 * Load `run` from the build. Read as `unknown` and checked, because a dynamic
 * import of a path is untyped and the host imports no app module.
 */
async function loadRun(): Promise<
  (argv: readonly string[]) => Promise<unknown>
> {
  const mod: unknown = await import(BUILT_MAIN);
  const run: unknown = Reflect.get(Object(mod), "run");
  if (typeof run !== "function")
    throw new Error(`${BUILT_MAIN} exports no run(): run \`npm run build\`.`);
  return async (argv) => {
    const end: unknown = await Reflect.apply(run, undefined, [argv]);
    return end;
  };
}

/** Read `run`'s `{ kind, code }` into the result's two fields. */
function endOf(value: unknown): {
  readonly end: CliEnd;
  readonly exitCode: number;
} {
  const kind: unknown = Reflect.get(Object(value), "kind");
  const code: unknown = Reflect.get(Object(value), "code");
  if ((kind === "stopped" || kind === "finished") && typeof code === "number")
    return { end: kind, exitCode: code };
  throw new Error(`run() returned an unknown ending: ${JSON.stringify(value)}`);
}

/**
 * What the bin does with an error a verb throws (`die` in `src/cli.ts`): one
 * `✗ <message>` line on stderr, exit 2. `cli.ts` keeps no top-level imports so it
 * can report even a broken install, which is why the two lines are not shared.
 */
function died(
  e: unknown,
  err: Sink,
): { readonly end: CliEnd; readonly exitCode: number } {
  err.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
  return { end: "threw", exitCode: 2 };
}

/**
 * Run `vigiles <argv>` in this process, in `cwd` when given, with `env` laid over
 * the current environment.
 */
export async function runCliInProcess(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly env?: Env } = {},
): Promise<CliResult> {
  const run = await loadRun();
  const { out, err, undo } = enterCapture(opts.env ?? {});
  try {
    if (opts.cwd !== undefined) process.chdir(opts.cwd);
    const ended = await run(argv).then(endOf, (e: unknown) =>
      died(e, err.stream),
    );
    return { stdout: out.text(), stderr: err.text(), ...ended };
  } finally {
    undo();
  }
}
