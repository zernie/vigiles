/**
 * Module-customization hooks for HARNESS scripts (`vigiles test` / `vigiles eval`).
 * Two jobs, one registration:
 *
 * 1. RESOLVE — make a bare `vigiles` import resolve to the CLI's OWN
 *    installation. The rescue itself — why it exists, what it refuses to touch —
 *    lives in `./self-resolve.mjs`, because the spec host registers the same
 *    branch from `./spec-hooks.mjs` and two copies of it is exactly the
 *    divergence that put `test` and `compile` on different answers to the same
 *    question. What stays here is the protocol: try normal resolution first, and
 *    only consider the rescue on the way out of the failure.
 *
 * 2. LOAD — tell the runner whether the script LOADED (#243). ESM links the
 *    whole import graph before evaluating any of it, and evaluates a module's
 *    imports in source order. So a marker import placed FIRST in the script's
 *    module evaluates if and only if every module in the graph was found, parsed
 *    and linked — and before any dependency or the script body runs. The marker
 *    writes a file; the runner reads it. No output text is read, so a harness
 *    that prints a loader error as EVIDENCE about the thing it tests (a hook
 *    transcript, say) can no longer be mistaken for one that never ran.
 *
 * The probe paths arrive through `register(…, { data })` → `initialize`, NOT the
 * environment, so a process the harness spawns cannot inherit them and write
 * over its parent's answer.
 */
import { writeFileSync } from "node:fs";
import { resolveSelfSpecifier } from "./self-resolve.mjs";

type ResolveContext = { parentURL?: string; conditions: string[] };
type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Resolved | Promise<Resolved>;
type LoadContext = { format?: string | null; conditions: string[] };
type Loaded = {
  format?: string | null;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
};
type NextLoad = (url: string, context: LoadContext) => Loaded | Promise<Loaded>;

/** What the runner hands this hook for ONE child. See `run-scripts.ts`. */
export interface LoadProbe {
  /** The script's own module URL (realpath), whatever process entry runs it. */
  readonly entryURL: string;
  /** Written (empty) by the marker module when it evaluates: the graph linked. */
  readonly loadedFile: string;
  /** Written with `{ format, marked }` when this hook sees the script's module. */
  readonly seenFile: string;
}

const MARKER_URL = "vigiles-internal:loaded";

/**
 * Formats the marker can be planted in. 🔴 CommonJS is deliberately absent: it
 * has no link phase to mark (a `require` resolves while the body runs), so a CJS
 * script carries no marker and a non-zero exit from it is conservatively a
 * `fail` — which retracts coverage rather than hiding a real failure.
 * `module-typescript` is Node's own type stripping (22.6+), which strips in
 * place and so keeps positions.
 */
const MARKABLE = new Set(["module", "module-typescript"]);

let probe: LoadProbe | undefined;

export function initialize(data: LoadProbe | undefined): void {
  probe = data;
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<Resolved> {
  if (probe !== undefined && specifier === MARKER_URL)
    return { url: MARKER_URL, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only AFTER normal resolution failed, so a locally installed vigiles always
    // wins and no other package is affected.
    const rescued = resolveSelfSpecifier(specifier);
    if (!rescued) throw err;
    return rescued;
  }
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<Loaded> {
  if (probe !== undefined && url === MARKER_URL)
    return {
      format: "module",
      shortCircuit: true,
      source: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(probe.loadedFile)}, "");`,
    };
  const loaded = await nextLoad(url, context);
  if (probe === undefined || url !== probe.entryURL) return loaded;
  const marked = MARKABLE.has(String(loaded.format));
  // Written BEFORE the graph links, so its presence proves the hook saw the
  // script. Without it a missing `loadedFile` would mean nothing: a script this
  // hook never saw (a loader that rewrote its URL, say) is never did-not-load.
  writeFileSync(
    probe.seenFile,
    JSON.stringify({ format: loaded.format, marked }),
  );
  if (!marked) return loaded;
  return { ...loaded, source: withMarker(sourceText(loaded.source)) };
}

function sourceText(source: Loaded["source"]): string {
  if (typeof source === "string") return source;
  // `String(uint8array)` gives "1,2,3", so decode explicitly.
  return new TextDecoder().decode(source ?? new Uint8Array());
}

/**
 * Put the marker import on the file's FIRST line — after a shebang, which must
 * stay first — so no line number moves; only columns on that one line do.
 */
function withMarker(src: string): string {
  const mark = `import ${JSON.stringify(MARKER_URL)};`;
  if (!src.startsWith("#!")) return mark + src;
  const nl = src.indexOf("\n");
  if (nl === -1) return `${src}\n${mark}`;
  return src.slice(0, nl + 1) + mark + src.slice(nl + 1);
}
