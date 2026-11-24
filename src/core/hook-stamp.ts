/**
 * A compiled hook's STAMP — whether its source still matches what `compile`
 * stamped. One home, so the runtime, `lint` and `audit` cannot disagree on what
 * "stale" means (`one-detector-no-drift`).
 *
 * THE INCIDENT THIS EXISTS FOR (2026-11): a user edited the source of an
 * `inject` hook wired on `UserPromptSubmit` and did not recompile. The runtime
 * found the stamp stale and exited 2 — on EVERY prompt. A prompt is not a tool
 * call, so the agent could not repair anything in that loop, and the human
 * could not type their way out: each prompt was blocked before it was read.
 * CI stayed green, because nothing in `lint` compared a hook to its stamp.
 *
 * So a stale stamp is now a FAILURE of the hook, never a decision: the runtime
 * skips the unverified body and exits 1 (`core/hook-exit.ts`), and the wiring's
 * per-hook failure policy, which `compile` writes from the hook's role, decides
 * what that does to the action. The `lint` side of the same question is
 * {@link staleHookStamps}.
 *
 * No `node:crypto` here: the hasher is handed in, so this module stays
 * importable by the browser-safe scan engine and costs the runtime nothing.
 */
import { HOOKS_DIR } from "./hook-paths.js";

/**
 * What a hook's stamp sidecar says about its source. Five answers, because
 * "not stale" has three different reasons and only one of them is "checked and
 * fine" (`make-the-distinction-a-type`).
 */
export type StampCheck =
  /** No sidecar: never compiled, or a fixture — it runs unstamped. */
  | { readonly kind: "no-sidecar" }
  /** A sidecar without a `stamp` — the documented manual clear (`{}`). */
  | { readonly kind: "cleared" }
  /** The sidecar is not JSON, or the source cannot be read: nothing to compare. */
  | { readonly kind: "unreadable"; readonly what: "sidecar" | "source" }
  | { readonly kind: "matches" }
  /** The source changed after `compile` stamped it. */
  | { readonly kind: "stale"; readonly stamp: string };

/** `stamp` out of a sidecar's text; `undefined` when there is none, `null` when the text is not JSON. */
function stampField(text: string): string | undefined | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || !("stamp" in parsed))
      return undefined;
    const { stamp } = parsed;
    return typeof stamp === "string" && stamp !== "" ? stamp : undefined;
  } catch {
    return null;
  }
}

/**
 * Compare a hook source with its sidecar. `undefined` text = the file is
 * absent. `stampOf` is the compile-time hasher (`stampHook`), injected.
 */
export function checkHookStamp(
  sidecarText: string | undefined,
  sourceText: string | undefined,
  stampOf: (source: string) => string,
): StampCheck {
  if (sidecarText === undefined) return { kind: "no-sidecar" };
  const stamp = stampField(sidecarText);
  if (stamp === null) return { kind: "unreadable", what: "sidecar" };
  if (stamp === undefined) return { kind: "cleared" };
  if (sourceText === undefined) return { kind: "unreadable", what: "source" };
  return stampOf(sourceText) === stamp
    ? { kind: "matches" }
    : { kind: "stale", stamp };
}

/** The one command that repairs a stale stamp — shared by every message. */
export function stampFixCommand(hookFile: string): string {
  return `vigiles compile ${hookFile}`;
}

/** A hook source whose stamp no longer matches it — the scan's finding. */
export interface StaleHookStamp {
  /** The sidecar, repo-relative (`.vigiles/hooks/<name>.json`). */
  readonly sidecar: string;
  /** The hook source the sidecar stamps, as `compile` recorded it. */
  readonly source: string;
}

/** The source a sidecar names: its `file`, else the hook beside it in `.vigiles/hooks/`. */
function sourceOf(sidecarRef: string, sidecarText: string): string {
  try {
    const parsed: unknown = JSON.parse(sidecarText);
    if (parsed !== null && typeof parsed === "object" && "file" in parsed) {
      const { file } = parsed;
      if (typeof file === "string" && file !== "") return file;
    }
  } catch {
    /* not JSON: `checkHookStamp` reports it unreadable; the name is only a fallback */
  }
  return sidecarRef.replace(/\.json$/, "");
}

/**
 * Every stamp sidecar under `.vigiles/hooks/` whose hook source no longer
 * matches it. `sidecarRefs` are repo-relative; `readText` is the engine's file
 * port (`undefined` = absent). A source that cannot be read is NOT reported
 * here — a missing file a compiled hook needs is `hook-script-exists`' finding.
 */
export function staleHookStamps(
  sidecarRefs: readonly string[],
  readText: (ref: string) => string | undefined,
  stampOf: (source: string) => string,
): readonly StaleHookStamp[] {
  return sidecarRefs
    .filter((ref) => ref.startsWith(`${HOOKS_DIR}/`) && ref.endsWith(".json"))
    .flatMap((sidecar) => {
      const text = readText(sidecar);
      if (text === undefined) return [];
      const source = sourceOf(sidecar, text);
      const check = checkHookStamp(text, readText(source), stampOf);
      return check.kind === "stale" ? [{ sidecar, source }] : [];
    });
}
