/**
 * Adapter registry — the composition-root list the CLI uses to auto-detect which
 * harness a repo targets. The library API selects an adapter by import
 * (`vigiles/claude-code`); the CLI can't, so it walks this registry. Claude Code
 * is the default, so detection is backwards-compatible: an undetected repo (or a
 * repo with no adapter markers) resolves to Claude Code exactly as before.
 *
 * Adding a harness = add its `HarnessAdapter` to `ADAPTERS` (and a
 * `vigiles/<harness>` export). Order matters only if two adapters could both
 * match a repo; `detect()` returns a specificity score so the strongest signal
 * wins regardless of order.
 */
import type { HarnessAdapter } from "./core/adapter.js";
import type { HarnessDeclaration } from "./core/types.js";
import { normalizeSurfaceRoots } from "./core/surface-scopes.js";
import { detectInstructionMirror } from "./core/compose.js";
import { claudeCodeAdapter } from "./adapters/claude-code/adapter.js";
import { codexAdapter } from "./adapters/codex/adapter.js";

/** The default adapter when detection finds no harness markers. */
export const defaultAdapter: HarnessAdapter = claudeCodeAdapter;

/** All registered adapters. detect() specificity (not order) breaks ties. */
export const ADAPTERS: readonly HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
];

/** The result of auto-detecting a harness from a repo's layout. */
export interface DetectResult {
  readonly adapter: HarnessAdapter;
  /** True when detection found no harness markers and fell back to the default. */
  readonly fallback: boolean;
  /**
   * Other adapters that matched at the same top specificity — a non-empty list
   * means the repo looks like more than one harness (e.g. a CLAUDE.md + an
   * AGENTS.md), so the pick is ambiguous; resolve with `--harness`.
   */
  readonly ambiguousWith: readonly string[];
}

/**
 * Auto-detect the harness for a repo at `root` by highest detect() specificity.
 *
 * SCOPE (2026-07-21): `vigiles audit` is CLAUDE-CODE-FOCUSED for now. This is
 * file-marker detection (a specificity score); it picks ONE harness (or the CC
 * default) and reports `ambiguousWith` when several genuinely match. Mirror-collapse
 * (below) is done; the rest — treating a LONE `AGENTS.md` (an AAIF cross-tool
 * standard, not a Codex signal) as harness-agnostic, and auditing ALL detected
 * harnesses (shared-once + per-harness slice) — is DEFERRED. Full design + research:
 * `research/audit-harness-dx.md`.
 */
export function detectAdapterResult(root: string): DetectResult {
  const scored = ADAPTERS.map((a) => ({ a, score: a.detect(root) })).filter(
    (s) => s.score > 0,
  );
  if (scored.length === 0) {
    return { adapter: defaultAdapter, fallback: true, ambiguousWith: [] };
  }
  const top = Math.max(...scored.map((s) => s.score));
  let winners = scored.filter((s) => s.score === top).map((s) => s.a);

  // Mirror-collapse: the only false-"both" tie is at the weak instruction-file level
  // (top === 1 — Claude Code via CLAUDE.md, Codex via AGENTS.md). When those two files
  // are a MIRROR (symlink or byte-identical, per detectInstructionMirror), that's ONE
  // logical config, not two harnesses — `AGENTS.md` is a cross-tool standard bridged to
  // CLAUDE.md, not an independent Codex target (research/audit-harness-dx.md). Drop codex
  // so it resolves to Claude Code without a spurious "matches claude-code, codex" notice.
  // A genuine dual instruction file (different content, or a real .codex/config.toml at
  // score 3) is NOT a mirror at top 1 → stays ambiguous, exactly as it should.
  if (
    winners.length > 1 &&
    top === 1 &&
    winners.some((w) => w.name === "codex") &&
    detectInstructionMirror(root) !== null
  ) {
    // At top === 1 with a mirror, both files exist so Claude Code (CLAUDE.md) is
    // always a co-winner — dropping codex leaves a non-empty set.
    winners = winners.filter((w) => w.name !== "codex");
  }

  return {
    adapter: winners[0],
    fallback: false,
    ambiguousWith: winners.slice(1).map((a) => a.name),
  };
}

/** The detected adapter (highest specificity), else the default (Claude Code). */
export function detectAdapter(root: string): HarnessAdapter {
  return detectAdapterResult(root).adapter;
}

/**
 * Short-name aliases accepted anywhere a harness name is supplied (config,
 * `--harness=`). `init` historically uses `"claude"`; the canonical adapter name
 * is `"claude-code"`. Normalizing here keeps selection and the registry in sync.
 */
const HARNESS_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
};

/** Lower-case, trim, and map a short alias to its canonical adapter name. */
export function normalizeHarnessName(name: string): string {
  const n = name.trim().toLowerCase();
  return HARNESS_ALIASES[n] ?? n;
}

/** Look up a registered adapter by `name` (alias-aware, e.g. `claude`). */
export function getAdapter(name: string): HarnessAdapter | undefined {
  const canonical = normalizeHarnessName(name);
  return ADAPTERS.find((a) => a.name === canonical);
}

/**
 * The adapter whose instruction file is `filename` (e.g. `AGENTS.md` → codex,
 * `CLAUDE.md` → claude-code), if any. The per-spec disambiguation signal: a
 * `<file>.spec.ts` compiles a `<file>` instruction file, so the filename names
 * the harness more specifically than config/detect for THAT spec.
 */
export function adapterForInstructionFile(
  filename: string,
): HarnessAdapter | undefined {
  return ADAPTERS.find((a) => a.layout.instructionFile === filename);
}

/**
 * Resolve the adapter for a command: an explicit `--harness <name>` wins (throws
 * if unknown); otherwise auto-detect from `root`. The single entry point the CLI
 * uses so detection + override live in one place.
 */
export function resolveAdapter(root: string, harness?: string): HarnessAdapter {
  if (harness !== undefined && harness !== "") {
    const a = getAdapter(harness);
    if (!a) {
      const known = ADAPTERS.map((x) => x.name).join(", ");
      throw new Error(`Unknown harness "${harness}". Known: ${known}.`);
    }
    return a;
  }
  return detectAdapter(root);
}

/** Normalize a config `harness` value (string | string[]) to a canonical list. */
export function normalizeHarnessList(
  harness?: string | readonly string[],
): string[] {
  if (harness === undefined) return [];
  const arr = Array.isArray(harness) ? harness : [harness as string];
  return arr.map(normalizeHarnessName).filter(Boolean);
}

/**
 * The adapter chosen for a single-dialect operation. A discriminated union so an
 * invalid state — a "notice" with no message, or a clean pick carrying a stray
 * string — is unrepresentable: `kind: "ok"` has no `notice`, `kind: "notice"`
 * always carries a non-empty one. Both variants carry the `adapter`.
 */
export type HarnessSelection =
  | { readonly kind: "ok"; readonly adapter: HarnessAdapter }
  | {
      readonly kind: "notice";
      readonly adapter: HarnessAdapter;
      readonly notice: string;
    };

/**
 * Resolve the single harness a compile/lint operation should use, with explicit
 * precedence — the deterministic replacement for sniffing the cwd:
 *
 *   1. `--harness=` flag (wins; throws if unknown).
 *   2. config `harness` resolving to a single entry → use it.
 *   3. config `harness` with multiple entries → use the first, with a loud notice.
 *   4. no config → auto-detect, with a loud notice when the repo is ambiguous.
 *
 * `configHarness` is parsed once (alias-normalized) at the call site and passed
 * in; this function re-normalizes idempotently so it's safe either way. Pure
 * (besides reading `root`'s layout for detection) so the precedence is
 * unit-testable without a real compile. See research/multi-harness-compile.md.
 */
export function resolveHarnessSelection(opts: {
  root: string;
  flag?: string;
  configHarness?: string | readonly string[];
}): HarnessSelection {
  const { root, flag, configHarness } = opts;
  if (flag !== undefined && flag !== "") {
    return { kind: "ok", adapter: resolveAdapter(root, flag) };
  }
  const list = normalizeHarnessList(configHarness);
  if (list.length === 1) {
    return { kind: "ok", adapter: resolveAdapter(root, list[0]) };
  }
  if (list.length > 1) {
    const adapter = resolveAdapter(root, list[0]);
    return {
      kind: "notice",
      adapter,
      notice: `repo targets ${list.join(", ")} — compiling for ${adapter.name}; override with --harness=`,
    };
  }
  const det = detectAdapterResult(root);
  if (det.ambiguousWith.length > 0) {
    return {
      kind: "notice",
      adapter: det.adapter,
      notice: `repo matches ${[det.adapter.name, ...det.ambiguousWith].join(", ")} — set "harness" in .vigilesrc.json or use --harness=`,
    };
  }
  return { kind: "ok", adapter: det.adapter };
}

/**
 * The FULL adapter set a compile-time INSTALL should fan out to. Unlike
 * `resolveHarnessSelection` (which picks ONE dialect for a single-output compile,
 * since you emit a markdown file in one harness's format), an install writes the
 * SAME artifact into EVERY enabled harness's native config — so a repo targeting
 * both harnesses gets a compiled hook in `.claude/settings.json` AND
 * `.codex/config.toml`, not just the first. Precedence mirrors the single picker:
 *
 *   1. `--harness=` flag → just that one (an explicit override is singular).
 *   2. config `harness` list → ALL of them (the multi-harness fan-out).
 *   3. no config → auto-detect → the one detected.
 *
 * Returns ≥1 adapter, de-duplicated by name (a config that lists a harness twice,
 * or an alias + its canonical, collapses to one install).
 */
export function resolveHarnessAdapters(opts: {
  root: string;
  flag?: string;
  configHarness?: string | readonly string[];
}): HarnessAdapter[] {
  const { root, flag, configHarness } = opts;
  if (flag !== undefined && flag !== "") return [resolveAdapter(root, flag)];
  const list = normalizeHarnessList(configHarness);
  const adapters =
    list.length > 0
      ? list.map((h) => resolveAdapter(root, h))
      : [detectAdapterResult(root).adapter];
  const seen = new Set<string>();
  return adapters.filter((a) => !seen.has(a.name) && seen.add(a.name));
}

// ---------------------------------------------------------------------------
// The repo's own declaration — `.vigilesrc.json#harnesses` (#240)
// ---------------------------------------------------------------------------

/**
 * One declared harness, resolved: the adapter its KEY names, and the extra
 * surface roots declared under it, normalized.
 *
 * The pair is the whole point of the nested shape. Under the two flat keys the
 * roots were global and the harness list was ordered, so the layout a root was
 * read under was decided by array position; here the layout comes from the key
 * the root sits under, so there is no order to get wrong and nothing to guess.
 */
export interface DeclaredHarness {
  readonly adapter: HarnessAdapter;
  /** Normalized `.vigilesrc.json#harnesses.<name>.roots`, in declaration order. */
  readonly roots: readonly string[];
}

/**
 * The declared harness NAMES, in declaration order — the `string[]` every
 * existing single-dialect picker already takes.
 *
 * Deliberately NOT resolving adapters: `resolveHarnessSelection` /
 * `resolveHarnessAdapters` resolve (and throw on) an unknown name themselves,
 * and two places deciding what an unknown name means is how the two error
 * wordings would drift.
 */
export function declaredHarnessNames(
  harnesses?: Readonly<Record<string, HarnessDeclaration>>,
): string[] {
  return normalizeHarnessList(Object.keys(harnesses ?? {}));
}

/**
 * Every declared harness with its roots, in declaration order.
 *
 * Throws on an unknown key, through the SAME `resolveAdapter` the `--harness=`
 * flag goes through — so `{"claud-code": {}}` fails with the identical
 * `Unknown harness "claud-code". Known: claude-code, codex.` a bad flag gets.
 * That was already the loud half of the old shape and it is kept verbatim.
 *
 * Aliases collapse: `{"claude": {"roots":["a"]}, "claude-code": {"roots":["b"]}}`
 * is ONE Claude Code declaration reading both roots, not two competing ones —
 * the same de-duplication `resolveHarnessAdapters` does, extended to carry the
 * union of what each spelling declared.
 */
export function resolveDeclaredHarnesses(
  root: string,
  harnesses?: Readonly<Record<string, HarnessDeclaration>>,
): DeclaredHarness[] {
  const out: Array<{ adapter: HarnessAdapter; roots: string[] }> = [];
  for (const [key, decl] of Object.entries(harnesses ?? {})) {
    const adapter = resolveAdapter(root, key);
    const roots = [...normalizeSurfaceRoots(decl?.roots)];
    const prev = out.find((d) => d.adapter.name === adapter.name);
    if (prev) {
      for (const r of roots) if (!prev.roots.includes(r)) prev.roots.push(r);
    } else {
      out.push({ adapter, roots });
    }
  }
  return out;
}
