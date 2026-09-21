/**
 * WHERE a repo's model surfaces (skills/agents/commands) live — and the key each
 * one is materialized under.
 *
 * 🔴 THIS EXISTS BECAUSE THE LOADER USED TO CHOOSE. It read the repo-root
 * `skills/` **or** the project-level `.claude/skills/` — never both — and
 * materialized whichever it picked under the SAME canonical
 * `<materializeRoot>/<surface>/…` key. Two real files, one key: the loser was
 * never read, and the winner's content sat under the loser's name. Measured
 * 2026-08-18 on `nyldn/claude-octopus` (pinned corpus): **50 skill names exist in
 * both `skills/` and `.claude/skills/`, and all 50 pairs differ** — the `.claude/`
 * copies carry multi-line unquoted `description:` blocks that a strict YAML
 * loader rejects. vigiles reported those fifty skills as clean without ever
 * having opened the files it named.
 *
 * The vendor settles it — Claude Code loads BOTH, in two namespaces:
 *
 * > Plugin skills use a `plugin-name:skill-name` namespace, so they can't
 * > conflict with other levels.
 * > For example, `my-plugin/skills/deploy/SKILL.md` becomes `/my-plugin:deploy`
 * > and loads alongside a `deploy` skill in your project's `.claude/skills/`.
 * > — https://code.claude.com/docs/en/skills § "Where skills live"
 *
 * So "pick one" was never a tie-break to get right; it was a question that has no
 * answer, asked because the key shape forced one. The fix removes the question:
 * every scope present is read, and **a scope's key prefix is derived from the
 * scope, not from a winner**, so two files can no longer claim one key.
 *
 * Node-free and IO-free on purpose: the disk loader (`src/plugin-loader.ts`) and
 * the browser file-map twin (`src/scan-files.ts`) each probe their own storage
 * and call THIS for the decision, so the pair that this repo has repeatedly been
 * bitten by fixing on one side only cannot disagree about scoping.
 */
import type { PluginLayout } from "./layout.js";

/**
 * One discovery level, and the prefix its files are materialized under.
 *
 * `base` is the repo-relative dir the surfaces really live under (`""` = the repo
 * root, the published-plugin shape; `.claude` = the plain-user project shape).
 * `materializeUnder` is the prefix prepended to `<surface>/<rel>` to form the
 * `LoadedPlugin.files` key.
 */
export interface SurfaceScope {
  /** Repo-relative dir holding `<surface>/…`; `""` for the repo root. */
  readonly base: string;
  /** Key prefix for this scope's files; `""` for none. */
  readonly materializeUnder: string;
  /** Human label for warnings — `plugin` (root) or `project` (`.claude/`). */
  readonly label: string;
  /**
   * This scope exists only because the REPO OWNER named its base in
   * `.vigilesrc.json#harnesses["<name>"].roots` — it is not a location the harness itself
   * reads. Marked so {@link multiScopeWarning} can stay about the ambiguity it
   * describes (plugin-vs-project, both of which a real session loads) instead of
   * claiming the harness loads a declared root too.
   */
  readonly declared?: boolean;
}

/** Which shape the audited target is, and every scope to read from it. */
export type SurfaceSource =
  | { readonly kind: "single-skill"; readonly skillName: string }
  | { readonly kind: "scopes"; readonly scopes: readonly SurfaceScope[] };

/** What the caller must probe on its own storage for {@link surfaceSource}. */
export interface SurfaceProbe {
  /** A `<root>/SKILL.md` exists — the target IS one skill dir. */
  readonly hasRootSkillFile: boolean;
  /** Name to give that single skill (the target dir's basename). */
  readonly skillName: string;
  /** Some `<root>/<surface>/` holds a loadable file. */
  readonly rootHasLoadable: boolean;
  /** A plugin manifest or the hooks convention path exists. */
  readonly isPluginShaped: boolean;
  /** Some `<root>/<userSurfaceRoot>/<surface>/` holds a loadable file. */
  readonly userHasLoadable: boolean;
  /**
   * The repo owner's declared roots, normalized by {@link normalizeSurfaceRoots},
   * in declaration order.
   *
   * Unlike the flags above this is NOT a probe result — the caller passes the
   * declaration as written and does not check whether each root holds anything.
   * It does not have to: a declared scope is appended AFTER the no-scope
   * fallback, so an empty one adds an empty tree and changes nothing, while a
   * filter here would be a guard with no observable behaviour to defend.
   */
  readonly declaredRoots?: readonly string[];
}

/**
 * The repo owner's `.vigilesrc.json#harnesses["<name>"].roots`, normalized — or
 * dropped. (The flat top-level `surfaceRoots` key this once read was removed in
 * the same change that nested it under a harness name.)
 *
 * A DECLARATION BY THE REPO OWNER, never by an adapter: the rejected option B
 * let each harness declare roots, which inverts the dependency (registering a
 * Cursor adapter would start reading `.cursor/rules` in everyone's repo). A key
 * in the repo's own config cannot do that — it widens exactly one repository,
 * the one whose owner wrote it. See `research/audit-harness-dx.md` §9.
 *
 * Dropped rather than errored, because the failure of a bad entry is harmless
 * (nothing extra is read) while refusing to audit over a config typo is not:
 * absolute paths, `.`/empty, and anything with a `..` segment, which would reach
 * OUTSIDE the audited repo and is the only entry that could do real damage.
 * Order is kept and duplicates collapse, so the scope list is stable.
 */
export function normalizeSurfaceRoots(
  roots: readonly string[] | undefined,
): readonly string[] {
  const out: string[] = [];
  for (const raw of roots ?? []) {
    const r = raw
      .split("\\")
      .join("/")
      .replace(/^(?:\.\/)+/, "")
      .replace(/\/+$/, "")
      .trim();
    if (r === "" || r === "." || r.startsWith("/")) continue;
    if (r.split("/").includes("..")) continue;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Classify the target and list every scope to read, HIGHEST-PRECEDENCE FIRST.
 *
 * Precedence decides only one thing: which scope keeps the canonical
 * `<materializeRoot>/…` key. The project scope takes it, because that key IS
 * where a project skill lives — `.claude/skills/deploy/SKILL.md` is loaded from
 * exactly that path and answers to `/deploy`. A plugin scope keeps its own real
 * location (`skills/deploy/SKILL.md`), which is likewise where the harness reads
 * it from, under `/plugin:deploy`. Nothing is relocated on top of something else.
 *
 * 🔴 THE COLLISION IS STRUCTURAL, NOT CHECKED. Only the FIRST scope is relocated;
 * every later one keeps `base` as its prefix. Since the first scope is the only
 * one that can produce a `<materializeRoot>/…` key, and every other prefix is a
 * distinct real directory, two scopes cannot mint the same key — there is no
 * ordering, no "if already taken", and no last-write-wins to get wrong.
 * {@link assertDistinctScopeKeys} is the LOUD backstop for a future
 * `PluginLayout` that breaks the premise (e.g. one naming `.claude` as BOTH its
 * `materializeRoot` and a second scope's base).
 */
export function surfaceSource(
  layout: PluginLayout,
  probe: SurfaceProbe,
): SurfaceSource {
  if (layout.skillDir && probe.hasRootSkillFile) {
    return { kind: "single-skill", skillName: probe.skillName };
  }
  const scopes: SurfaceScope[] = [];
  if (layout.userSurfaceRoot !== undefined && probe.userHasLoadable) {
    scopes.push({
      base: layout.userSurfaceRoot,
      materializeUnder: layout.materializeRoot,
      label: "project",
    });
  }
  if (probe.rootHasLoadable || probe.isPluginShaped) {
    scopes.push({
      base: "",
      materializeUnder: scopes.length === 0 ? layout.materializeRoot : "",
      label: "plugin",
    });
  }
  // A layout with no user root and nothing at the root still has to read the
  // project shape, or a plain repo would load as an empty machine — the reason
  // `userSurfaceRoot` exists. An empty list means genuinely nothing loadable.
  if (scopes.length === 0 && layout.userSurfaceRoot !== undefined) {
    scopes.push({
      base: layout.userSurfaceRoot,
      materializeUnder: layout.materializeRoot,
      label: "project",
    });
  }
  // The repo owner's declared roots, read with the DETECTED layout's surface
  // dirs — `.ai` + `skills` for Claude Code. It does not invent a dialect: the
  // declaration says WHERE, the layout still says what a surface is and how it
  // is read. A root already serving as a scope's base is skipped (declaring
  // `.claude` to Claude Code is a no-op, not a second reading of one tree), and
  // so is one equal to `materializeRoot` — that key belongs to the scope holding
  // it, and two scopes minting one prefix is what {@link assertDistinctScopeKeys}
  // exists to refuse. Each keeps its OWN base as the key prefix, like a non-first
  // plugin scope, so nothing is relocated on top of anything.
  //
  // 🔴 APPENDED LAST, AFTER THE NO-SCOPE FALLBACK, AND THE ORDER IS THE POINT: a
  // declaration may only ADD. Run before the fallback, a declared root makes the
  // list non-empty and CANCELS it — measured on a repo whose `.claude/skills`
  // held only a non-loadable file: adding one config line naming another
  // directory dropped `.claude/skills/alpha/README.md` out of the loaded files.
  // Nobody would connect that to the line they wrote. Pinned by
  // `plugin-loader.test.ts` ("an EMPTY declared root does not cancel the project
  // scope"), which asserts the full key list both before and after filling it.
  for (const base of probe.declaredRoots ?? []) {
    if (base === layout.materializeRoot) continue;
    if (scopes.some((sc) => sc.base === base)) continue;
    scopes.push({
      base,
      materializeUnder: base,
      label: "declared",
      declared: true,
    });
  }
  return { kind: "scopes", scopes };
}

/** The `LoadedPlugin.files` key for one file under one scope. */
export function scopeKey(
  scope: SurfaceScope,
  surface: string,
  rel: string,
): string {
  return [scope.materializeUnder, surface, rel]
    .filter((s) => s !== "")
    .join("/");
}

/**
 * Throw when two scopes would mint the same key prefix. Unreachable for every
 * shipped layout (see {@link surfaceSource}) — it exists so a NEW layout that
 * breaks the premise fails loudly at load, rather than silently dropping a
 * surface file the way the shadowing bug did for a year.
 */
export function assertDistinctScopeKeys(
  scopes: readonly SurfaceScope[],
  layoutName: string,
): void {
  const seen = new Map<string, string>();
  for (const s of scopes) {
    const prev = seen.get(s.materializeUnder);
    if (prev !== undefined) {
      throw new Error(
        `layout "${layoutName}": surface scopes "${prev}" and "${s.base}" both materialize under ` +
          `"${s.materializeUnder || "<repo root>"}" — one would silently shadow the other. ` +
          `Give each scope a distinct materialize prefix (see src/core/surface-scopes.ts).`,
      );
    }
    seen.set(s.materializeUnder, s.base);
  }
}

/**
 * The warning to emit when more than one scope is present. Both scopes load in a
 * real session under DIFFERENT names, but the deterministic sandbox is a project
 * dir — it registers the project scope only, so a plugin-scope skill sitting at
 * `skills/…` in the fixture never activates there (the footgun
 * `unregisteredSkillFiles` already warns about for inline arm files). Say so,
 * rather than quietly relocating one on top of the other.
 */
export function multiScopeWarning(
  allScopes: readonly SurfaceScope[],
  counts: Record<string, number>,
): string | undefined {
  // Declared roots are excluded, and not for tidiness: every sentence below is
  // about what a REAL SESSION loads under two names. A harness does not load a
  // declared root at all — vigiles reads it because the repo owner said to — so
  // including one here would make the warning state a falsehood about the
  // harness the moment someone declares `harnesses.<name>.roots`.
  const scopes = allScopes.filter((s) => s.declared !== true);
  if (scopes.length < 2) return undefined;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    `repo carries surfaces at TWO discovery levels (${scopes
      .map((s) => `${s.label} → ${s.base === "" ? "<repo root>" : s.base}/`)
      .join(
        ", ",
      )}); ${String(total)} file(s) were read from both. Claude Code loads both — ` +
    `a plugin skill as \`/<plugin>:<name>\`, a project skill as \`/<name>\` — so a name in both ` +
    `places is TWO surfaces, not one. The deterministic sandbox is a project dir and registers ` +
    `the project scope only; install the plugin scope with \`pluginDir\` to exercise it.`
  );
}
