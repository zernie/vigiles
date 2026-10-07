/**
 * Are vigiles's SHIPPED SKILLS actually reachable by the agent in this repo?
 *
 * vigiles publishes six user-facing skills (`SHIPPED_SKILLS`) — the teaching
 * surface. `test-harness` alone answers "which testing tier do I want?", the
 * question this project's docs are otherwise organized around. They reach the
 * agent two ways (`docs/agent-setup.md`):
 *
 * - the LINKS `vigiles init` commits into `.claude/skills/` (one relative
 *   symlink per skill into `node_modules/vigiles/skills/`, `src/skill-links.ts`)
 *   — a fact about the REPOSITORY, so every clone and container has them once
 *   `npm install` has run;
 * - the GLOBAL plugin install (`claude plugin install vigiles@vigiles`, into
 *   `~/.claude/plugins/`) — a fact about ONE machine, namespaced
 *   `vigiles:<name>`.
 *
 * The failure this module makes loud: `npm install vigiles` ALSO puts those
 * skills on disk, at `node_modules/vigiles/skills/` (they are in package.json's
 * `files`, because the npm tarball doubles as the plugin payload). Claude Code
 * never scans `node_modules`. So a repo that took the dependency but never ran
 * the plugin install has all six skills present, unreachable, and **silent** —
 * observed in a real consumer repo, where a full day went into re-deriving what
 * `test-harness` teaches while it sat three directories away.
 *
 * ⚠️ The part that is easy to get wrong, and did get wrong TWICE, in opposite
 * directions:
 *
 * 1. The authoritative record of a `claude plugin install` is the GLOBAL
 *    `~/.claude/plugins/installed_plugins.json`. A repo's `.claude/settings.json`
 *    carries PROJECT-level `enabledPlugins`, which a correctly-installed
 *    user-scope plugin does not appear in. Judging "is it wired?" from
 *    `settings.json` alone reports a working install as broken — the misread
 *    that made this look like an npm packaging bug.
 * 2. The converse is ALSO false: a project `enabledPlugins` entry does not make
 *    the plugin load. Per the Claude Code docs (Discover plugins → "Configure
 *    team marketplaces"), as of CC v2.1.195 — "A plugin that only the project's
 *    `.claude/settings.json` enables, and that comes from an external source
 *    such as a GitHub repository or npm package, doesn't load until the team
 *    member installs it." vigiles ships from a GitHub marketplace, so that is
 *    exactly our case. Committing `extraKnownMarketplaces` + `enabledPlugins`
 *    makes Claude Code PROMPT each collaborator to install; it does not install.
 *    Confirmed empirically: in a repo whose committed settings.json declares an
 *    external plugin project-level, the global registry had no marketplace
 *    entry, no cache dir, and no install record for it, while a plugin installed
 *    the normal way on the same machine had all three.
 *
 * So a project declaration is a THIRD state — declared, not installed — that
 * still warrants a warning, with a different fix line: the collaborator runs the
 * install, the repo cannot run it for them.
 *
 * Shape follows `./dialect-drift.ts`: pure parsers + a best-effort local read
 * that NEVER throws + a formatter that returns null when there is nothing to
 * say, so `vigiles audit` can print it without a new verb, flag, or failure mode.
 * It is ADVISORY — it never touches the audit score, because reachability is
 * partly a property of the machine (is the plugin installed? has `npm install`
 * run?), and a score that moved between a laptop and CI for identical source
 * would be a lie.
 */
import type { InstallReader } from "../../core/adapter.js";
import { SHIPPED_SKILLS } from "../../setup-plan.js";
import { skillsHome } from "../../core/layout.js";
import { claudeCodeLayout } from "./layout.js";

/** The plugin id `claude plugin install` records — `<plugin>@<marketplace>`. */
export const VIGILES_PLUGIN_ID = "vigiles@vigiles";

/**
 * Where a reachable install was found. Deliberately does NOT include a project
 * `enabledPlugins` entry: that declares the plugin, it does not install it (see
 * the header). It is reported as {@link SkillReachability.declaredNotInstalled}.
 */
export type ReachabilitySource =
  /** `~/.claude/plugins/installed_plugins.json` — what `claude plugin install` writes. */
  | "global-plugin"
  /** The repo's own `.claude/skills/<name>/SKILL.md` resolves — a link `init` made, or a copy. */
  | "repo-skills";

/** The advisory: can the agent see vigiles's skills from this repo? */
export interface SkillReachability {
  /** True when at least one {@link ReachabilitySource} was found. */
  readonly reachable: boolean;
  /** Every source that resolved, in check order. Empty when un-wired. */
  readonly sources: readonly ReachabilitySource[];
  /**
   * The repo's `.claude/settings.json` enables the plugin, but no install was
   * found. Claude Code will prompt this collaborator to install it; until they
   * do, it does not load. A distinct state from "nothing configured at all",
   * because the fix belongs to the person, not the repo.
   */
  readonly declaredNotInstalled: boolean;
  /**
   * Shipped skills found under `node_modules/vigiles/skills/` while UNREACHABLE
   * — present on disk, invisible to the agent. Empty when reachable (there is
   * nothing stranded if they are wired) or when the package isn't installed yet.
   */
  readonly strandedSkills: readonly string[];
  /**
   * Shipped skills whose `.claude/skills/<name>` entry is a LINK that does not
   * resolve: the links came with `git clone`, the package they point into did
   * not. The fix is `npm install`, not re-linking.
   */
  readonly danglingLinks: readonly string[];
  /**
   * Skills the package ships that the repo has not linked while it HAS linked
   * others — the state after an upgrade adds a skill. Empty unless at least one
   * shipped skill resolves in the repo.
   */
  readonly unlinkedSkills: readonly string[];
}

/**
 * Does the global registry record a live install of the vigiles plugin? Pure over
 * the raw `installed_plugins.json` text. An entry with an EMPTY array is a
 * leftover record, not an install, so it does not count.
 */
export function hasGlobalPluginInstall(installedPluginsJson: string): boolean {
  try {
    const parsed = JSON.parse(installedPluginsJson) as {
      plugins?: Record<string, unknown>;
    };
    const entry = parsed.plugins?.[VIGILES_PLUGIN_ID];
    return Array.isArray(entry) && entry.length > 0;
  } catch {
    return false;
  }
}

/**
 * Does the repo's `.claude/settings.json` explicitly enable the vigiles plugin?
 * Pure. An explicit `false` is a deliberate disable and does NOT count.
 */
export function hasEnabledPlugin(settingsJson: string): boolean {
  try {
    const parsed = JSON.parse(settingsJson) as {
      enabledPlugins?: Record<string, unknown>;
    };
    return parsed.enabledPlugins?.[VIGILES_PLUGIN_ID] === true;
  } catch {
    return false;
  }
}

/** Where this harness keeps a repo's skills — the layout's answer, not a literal. */
const SKILLS_HOME = skillsHome(claudeCodeLayout) ?? ".claude/skills";

/** The per-repo fix, printed wherever the repo itself lacks the links. */
const LINK_FIX =
  "npx vigiles init — links each skill into .claude/skills/ (relative links into node_modules; commit them), and leaves any skill you already have alone";

/**
 * Best-effort, read-local reachability check for `vigiles audit`. Returns null
 * when the question does not apply — the repo does not depend on vigiles, or IS
 * vigiles — so a non-consumer is never nagged. NEVER throws: every read the
 * reader performs degrades to "not found".
 *
 * 🔴 IT READS THROUGH A REPO-BOUND {@link InstallReader}, NOT `node:fs`. Two of
 * its reads are of files NO adapter claims (`package.json`, vigiles's own
 * package under `node_modules`), so the domain performs those and passes the
 * ANSWER; the rest go through a reader that refuses any path this adapter does
 * not claim. That is why this module does not import `node:fs` at all.
 *
 * Each shipped skill is probed for its own `SKILL.md` rather than by listing
 * `.claude/skills/` — enumeration is what the reader exists to prevent, and the
 * names are known: the installed package's when it is installed, else the
 * shipped list. A directory named after a shipped skill but holding no
 * `SKILL.md` is not reachable; it was never loadable by the agent.
 */
export function checkSkillReachability(
  read: InstallReader,
): SkillReachability | null {
  if (!read.repoDependsOnVigiles) return null;

  const shipped: readonly string[] =
    read.vendoredSkillNames.length > 0
      ? read.vendoredSkillNames
      : SHIPPED_SKILLS;
  const { inRepo, dangling } = repoSkillState(read, shipped);
  const sources = reachabilitySources(read, inRepo);
  const reachable = sources.length > 0;

  // A project declaration is NOT a source — it makes Claude Code prompt for an
  // install, it does not perform one. Only meaningful while unreachable.
  const settings = read.repo(".claude/settings.json");
  const vendored = new Set(read.vendoredSkillNames);
  return {
    reachable,
    sources,
    declaredNotInstalled:
      !reachable && settings !== null && hasEnabledPlugin(settings),
    strandedSkills: reachable
      ? []
      : SHIPPED_SKILLS.filter((s) => vendored.has(s)),
    danglingLinks: dangling,
    unlinkedSkills:
      inRepo.length > 0
        ? shipped.filter((s) => !inRepo.includes(s) && !dangling.includes(s))
        : [],
  };
}

/** Which shipped skills resolve in the repo, and which are links that dangle. */
function repoSkillState(
  read: InstallReader,
  shipped: readonly string[],
): {
  readonly inRepo: readonly string[];
  readonly dangling: readonly string[];
} {
  const resolves = (s: string): boolean =>
    read.repo(`${SKILLS_HOME}/${s}/SKILL.md`) !== null;
  return {
    inRepo: shipped.filter(resolves),
    dangling: shipped.filter(
      (s) => !resolves(s) && read.repoLink(`${SKILLS_HOME}/${s}`) !== null,
    ),
  };
}

/** The sources that resolved, in check order. */
function reachabilitySources(
  read: InstallReader,
  inRepo: readonly string[],
): readonly ReachabilitySource[] {
  const installed = read.home(".claude/plugins/installed_plugins.json");
  return [
    ...(installed !== null && hasGlobalPluginInstall(installed)
      ? (["global-plugin"] as const)
      : []),
    // Only vigiles's OWN skill names count. A repo with 38 unrelated skills in
    // `.claude/skills/` is still un-wired.
    ...(inRepo.length > 0 ? (["repo-skills"] as const) : []),
  ];
}

/**
 * The advisory, or null when there is nothing to say. Most specific state
 * first, each ending on the command that fixes it:
 *
 * 1. links that dangle — `npm install`;
 * 2. nothing reaches the agent — link them (per repo), or install the plugin
 *    (per machine);
 * 3. only this machine's plugin reaches it — a fresh clone or container will
 *    not have them. Not a failure; said in one line;
 * 4. some linked, some not (an upgrade added one) — link the rest.
 */
export function formatSkillReachability(
  r: SkillReachability | null,
): string | null {
  if (!r) return null;
  if (r.danglingLinks.length > 0) return formatDangling(r);
  if (!r.reachable) return formatUnreachable(r);
  if (!r.sources.includes("repo-skills"))
    return (
      `ℹ vigiles's skills reach your agent only through this machine's plugin ` +
      `install (~/.claude/plugins/), so a fresh clone or container won't have ` +
      `them.\n  Fix (per repo): ${LINK_FIX}`
    );
  if (r.unlinkedSkills.length > 0)
    return (
      `⚠ ${String(r.unlinkedSkills.length)} of vigiles's skills aren't linked ` +
      `into ${SKILLS_HOME}/: ${r.unlinkedSkills.join(", ")}.\n  Fix: ${LINK_FIX}`
    );
  return null;
}

/** Links that came with the clone, into a package that did not. */
function formatDangling(r: SkillReachability): string {
  const plugin = r.sources.includes("global-plugin")
    ? " This machine's plugin install still provides them as vigiles:<name>."
    : "";
  return (
    `⚠ ${String(r.danglingLinks.length)} of vigiles's skills are linked into ` +
    `${SKILLS_HOME}/ but the links don't resolve here — node_modules/vigiles ` +
    `isn't installed.${plugin}\n` +
    `  Fix: npm install (a session that started before it may need /reload-skills or a restart)`
  );
}

/** Nothing reaches the agent: the per-repo fix first, the per-machine one second. */
function formatUnreachable(r: SkillReachability): string {
  const stranded =
    r.strandedSkills.length > 0
      ? ` ${String(r.strandedSkills.length)} of them are sitting in ` +
        `node_modules/vigiles/skills/, which the agent never scans.`
      : "";
  const why = r.declaredNotInstalled
    ? `This repo DECLARES the vigiles plugin in .claude/settings.json, but a ` +
      `project declaration doesn't install it — Claude Code loads an ` +
      `external-source plugin only once each collaborator installs it on their ` +
      `own machine.`
    : `This repo depends on vigiles, but it does not link vigiles's skills and the plugin isn't installed here.`;
  return (
    `⚠ vigiles's skills are NOT reachable by your agent here. ${why} So the ` +
    `shipped skills (${SHIPPED_SKILLS.join(", ")}) can't be selected — ` +
    `including test-harness, which picks the testing tier for you.${stranded}\n` +
    `  Fix (per repo, reaches every clone): ${LINK_FIX}\n` +
    `  Or per machine: claude plugin marketplace add zernie/vigiles && ` +
    `claude plugin install ${VIGILES_PLUGIN_ID}`
  );
}
