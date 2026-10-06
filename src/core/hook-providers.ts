/**
 * Hook CONTEXT PROVIDERS — let a compiled gate decide on EXTERNAL STATE (git
 * branch, working-tree dirtiness, cwd, OS) WITHOUT breaking `capability = API
 * surface`. The design (research/hook-context-providers.md, grounded in
 * Cedar/OPA/Gatekeeper): the pure `decide` never fetches; the TRUSTED runtime
 * gathers a DECLARED set of read-only facts and hands them in as `e.ctx`. A hook
 * declares `needs: [...]`, so the dependency is explicit + auditable, and the
 * fact-gathering I/O lives here (the trusted host), never inside the hook.
 *
 * Two tiers of `needs` entry, both DECLARED (the opt-out ladder):
 *  - a built-in provider NAME (`"git.branch"`) — the curated, famous-80% set;
 *  - an INLINE one-off — `provide(name, cmd)` (read-only, compile-rejected if not)
 *    or `dangerously(name, cmd)` (the loud, greppable escape for a command that
 *    isn't provably read-only) — for the long tail, no registration ceremony.
 *
 * Every built-in command is provably read-only (asserted in the test via
 * bash-effects); a `provide()` command is checked the same way at compile. The
 * gathering is parameterized over an injected `ProviderIO`, so the registry is
 * testable with a fake exec and core depends on no child_process.
 */
import { isReadOnlyBash } from "./bash-effects.js";
import {
  isStateNeed,
  stateFact,
  type StateEntry,
  type StateFact,
  type StateNeed,
} from "./hook-state.js";

/** The closed set of built-in facts a gate may declare via `needs`, with value types. */
export interface ProviderResults {
  /** The current git branch, or "" outside a git repo / on an unborn HEAD. */
  readonly "git.branch": string;
  /** True iff the working tree has uncommitted changes (false if not a repo). */
  readonly "git.isDirty": boolean;
  /** The repo's top-level directory, or "" outside a git repo. */
  readonly "git.root": string;
  /** The directory the hook runs in. */
  readonly cwd: string;
  /** The OS platform (`process.platform`: "darwin" | "linux" | "win32" | …). */
  readonly "os.platform": NodeJS.Platform;
  /** True iff running on a CI server (detected via the `ci-info` library). */
  readonly "env.isCI": boolean;
}

/** A declarable built-in provider name. */
export type ProviderName = keyof ProviderResults;

/**
 * An INLINE one-off provider: a command declared right in `needs` (no registered
 * file), run by the trusted runtime, its stdout becoming `e.ctx[name]` (a string).
 * `dangerous` marks the loud escape — a command not provably read-only. Built via
 * {@link provide} (read-only) or {@link dangerously} (acknowledged).
 */
export interface InlineProvider<Name extends string = string> {
  readonly kind: "inline";
  readonly name: Name;
  readonly run: string;
  readonly dangerous: boolean;
}

/**
 * A `needs` entry — a built-in name, an inline `provide`/`dangerously`, a
 * `provider()` ref, or a `state()` read of a fact some hook recorded.
 *
 * `state()` rides this union rather than getting its own accessor so that ALL of
 * a hook's external inputs stay in one declared list: the dependency is auditable
 * from outside the hook, and reading an undeclared one is a `tsc` error. See the
 * design note in `hook-state.ts`.
 */
export type NeedSpec =
  | ProviderName
  | InlineProvider
  | RegisteredRef
  | StateNeed;

/**
 * Declare an INLINE read-only fact: `provide("k8sCtx", "kubectl config current-context")`.
 * The command MUST be provably read-only (compile rejects it otherwise — use
 * {@link dangerously} to acknowledge a side-effecting/undecidable one). Its stdout
 * is `e.ctx[name]`.
 */
export const provide = <const Name extends string>(
  name: Name,
  run: string,
): InlineProvider<Name> => ({ kind: "inline", name, run, dangerous: false });

/**
 * Declare an INLINE fact whose command ISN'T provably read-only — the loud,
 * greppable escape hatch (the `dangerouslySetInnerHTML` / `unsafe` / `http.send`
 * convention; sibling of `purity:'dangerously-unrestricted'`). A security review
 * searches for this one word.
 */
export const dangerously = <const Name extends string>(
  name: Name,
  run: string,
): InlineProvider<Name> => ({ kind: "inline", name, run, dangerous: true });

/**
 * A REGISTERED provider — a reusable, named fact authored once in
 * `.vigiles/providers/<name>.provider.{mjs,ts}` (default-exported via {@link defineProvider})
 * and referenced from many hooks by {@link provider} name. The reusable sibling of
 * the one-off inline {@link provide}; same read-only-by-default rule.
 */
export interface RegisteredProvider<Name extends string = string> {
  readonly kind: "provider-def";
  readonly name: Name;
  readonly run: string;
  readonly dangerous: boolean;
}

/** Author a registered provider: `export default defineProvider({ name, run })`. */
export const defineProvider = <const Name extends string>(p: {
  readonly name: Name;
  readonly run: string;
  /** Acknowledge a command that isn't provably read-only (the loud escape). */
  readonly dangerous?: boolean;
}): RegisteredProvider<Name> => ({
  kind: "provider-def",
  name: p.name,
  run: p.run,
  dangerous: p.dangerous ?? false,
});

/** A reference to a registered provider, used in a hook's `needs`: `provider("myFact")`. */
export interface RegisteredRef<Name extends string = string> {
  readonly kind: "provider-ref";
  readonly name: Name;
}

/** Reference a registered provider (from `.vigiles/providers/`) by name in `needs`. */
export const provider = <const Name extends string>(
  name: Name,
): RegisteredRef<Name> => ({ kind: "provider-ref", name });

/** name → its registered provider; the runtime resolves a `provider(name)` ref against this. */
export type ProviderRegistry = Record<string, RegisteredProvider>;

type NeedName<E extends NeedSpec> = E extends ProviderName
  ? E
  : E extends InlineProvider<infer Nm>
    ? Nm
    : E extends RegisteredRef<infer Rn>
      ? Rn
      : E extends StateNeed<infer Sn>
        ? Sn
        : never;
type NeedValue<E extends NeedSpec> = E extends ProviderName
  ? ProviderResults[E]
  : E extends StateNeed
    ? StateFact
    : string;

/**
 * The typed `e.ctx` for a hook that declared `needs: N` — ONLY the declared facts
 * are present (built-in name → its typed value, inline → string), so reading an
 * undeclared one is a `tsc` error (the typed-purity trick). With `N = readonly []`
 * the ctx is empty. The default `readonly ProviderName[]` is the erased runtime
 * shape (built-ins only — an inline `string` name would force an index signature
 * that clashes with `git.isDirty: boolean`; concrete authored inline names are
 * literals, so they never clash).
 */
export type HookCtx<N extends readonly NeedSpec[] = readonly ProviderName[]> = {
  readonly [E in N[number] as NeedName<E>]: NeedValue<E>;
};

/** The read-only capabilities a provider may use to gather its fact. */
export interface ProviderIO {
  /** Run a read-only command, return stdout (throws on non-zero exit). */
  readonly exec: (command: string) => string;
  /** The hook's working directory. */
  readonly cwd: string;
  /** The OS platform (`process.platform`). */
  readonly platform: NodeJS.Platform;
  /** Whether the process is on a CI server (the CLI injects `ci-info`'s verdict). */
  readonly isCI: boolean;
  /**
   * Read one recorded fact from THIS hook's state namespace, or `null` if it was
   * never recorded. The namespace is resolved by the caller, so a key can never
   * address another owner's store — see `hook-state.ts`.
   */
  readonly readState: (key: string) => StateEntry | null;
  /** Epoch milliseconds, injected so fact ages are pinnable in a test. */
  readonly now: number;
}

interface ProviderDef<K extends ProviderName> {
  /**
   * The read-only command the provider runs (for audit + the read-only
   * soundness test). Absent for an ambient fact gathered without a subprocess.
   */
  readonly run?: string;
  /** Produce the fact; TOTAL — returns a sensible default on failure, never throws. */
  readonly gather: (io: ProviderIO) => ProviderResults[K];
}

/** Run a command and trim, returning "" on any failure (total). */
function tryExec(io: ProviderIO, command: string): string {
  try {
    return io.exec(command).trim();
  } catch {
    return "";
  }
}

/** The closed built-in registry. Each `run` is provably read-only (see the test). */
export const BUILTIN_PROVIDERS: {
  readonly [K in ProviderName]: ProviderDef<K>;
} = {
  "git.branch": {
    run: "git branch --show-current",
    gather: (io) => tryExec(io, "git branch --show-current"),
  },
  "git.isDirty": {
    run: "git status --porcelain",
    gather: (io) => tryExec(io, "git status --porcelain").length > 0,
  },
  "git.root": {
    run: "git rev-parse --show-toplevel",
    gather: (io) => tryExec(io, "git rev-parse --show-toplevel"),
  },
  cwd: {
    gather: (io) => io.cwd,
  },
  "os.platform": {
    gather: (io) => io.platform,
  },
  "env.isCI": {
    gather: (io) => io.isCI,
  },
};

/** True iff a `needs` entry is an inline `provide`/`dangerously`. */
function isInline(need: NeedSpec): need is InlineProvider {
  return typeof need !== "string" && need.kind === "inline";
}

/** True iff a `needs` entry is a `provider()` reference to a registered provider. */
function isRef(need: NeedSpec): need is RegisteredRef {
  return typeof need !== "string" && need.kind === "provider-ref";
}

/**
 * `needs` entries that don't resolve: a built-in NAME that isn't a built-in (a
 * typo), or a `provider()` ref whose name isn't in `registeredNames` (a dangling
 * ref). Inline `provide`/`dangerously` are always self-defined, so never flagged.
 */
export function unknownProviders(
  needs: readonly NeedSpec[],
  registeredNames: readonly string[] = [],
): string[] {
  const registered = new Set(registeredNames);
  const out: string[] = [];
  for (const n of needs) {
    if (isInline(n)) continue;
    // A `state()` key is self-defining: it resolves to "never recorded" until
    // some hook records it, which is a legitimate steady state (the very first
    // run of every throttled hook), not a dangling reference.
    if (isStateNeed(n)) continue;
    if (isRef(n)) {
      if (!registered.has(n.name)) out.push(n.name);
    } else if (!(n in BUILTIN_PROVIDERS)) out.push(n);
  }
  return out;
}

/**
 * Inline `provide()` entries whose command ISN'T provably read-only — these must
 * switch to `dangerously()` (the acknowledged escape) or compile is rejected. A
 * `dangerously()` entry is never flagged (it already acknowledged the risk).
 */
export function unsafeInlineProviders(
  needs: readonly NeedSpec[],
): InlineProvider[] {
  return needs
    .filter(isInline)
    .filter((n) => !n.dangerous && !isReadOnlyBash(n.run));
}

/**
 * Is a REGISTERED provider's command unsafe (not read-only and not acknowledged
 * `dangerous`)? Reused when compiling a `.vigiles/providers/` file.
 */
export function unsafeProvider(def: RegisteredProvider): boolean {
  return !def.dangerous && !isReadOnlyBash(def.run);
}

/**
 * Gather the DECLARED facts into a context object (the trusted-host step). Only
 * the names in `needs` are gathered, each at most once; a built-in, inline, or
 * registered provider that can't resolve yields its default ("" / false), never
 * throws. Pure over the injected `io` (CLI passes a real execSync; tests a fake)
 * and the `registry` (the loaded `.vigiles/providers/`, for `provider()` refs).
 */
export function gatherContext(
  needs: readonly NeedSpec[],
  io: ProviderIO,
  registry: ProviderRegistry = {},
): Record<string, string | boolean | StateFact> {
  const ctx: Record<string, string | boolean | StateFact> = {};
  for (const need of needs) {
    if (isStateNeed(need)) {
      // The one need that reaches no subprocess: the trusted runtime hands the
      // stored entry (or null) straight in, and the fact view does the clamping
      // every shell stamp-reader used to re-implement by hand.
      ctx[need.name] = stateFact(io.readState(need.name), io.now);
    } else if (isInline(need)) ctx[need.name] = tryExec(io, need.run);
    else if (isRef(need)) {
      const def = registry[need.name];
      ctx[need.name] = def ? tryExec(io, def.run) : "";
    } else ctx[need] = BUILTIN_PROVIDERS[need].gather(io);
  }
  return ctx;
}
