/**
 * The pure half of how `vigiles init` makes vigiles's skills visible to the
 * agent in EVERY clone: one relative symlink per shipped skill,
 * `<skills home>/<name> -> ../../node_modules/vigiles/skills/<name>`, committed
 * with the repo. The IO half (lstat, readlink, symlink) is `linkVigilesSkills`
 * in `cli-main.ts`; everything that decides something is here, so it is tested
 * without a filesystem.
 *
 * 🔴 WHY LINKS AND NOT ONLY THE PLUGIN. `npm install vigiles` puts the skills at
 * `node_modules/vigiles/skills/`, which no harness scans. The Claude Code plugin
 * install carries them, but it lands in `~/.claude/plugins/` — a fact about ONE
 * machine. A fresh clone or a fresh container has an empty home directory, and
 * the project's `enabledPlugins` declaration only makes Claude Code PROMPT for
 * an install (`./plugin-declaration.ts`); headless, nobody sees the prompt. The
 * skills were on disk and silently absent. A link is part of the repository, so
 * it arrives with `git clone` and resolves as soon as `npm install` has run —
 * the same step every other dependency already needs.
 *
 * Both harnesses document following a symlinked skill folder:
 *
 * > Claude Code: "a `<skill-name>` entry in the enterprise, personal, or project
 * > location can be a symlink to a directory elsewhere on disk. Claude Code
 * > reads `SKILL.md` from the target" (code.claude.com/docs/en/skills, fetched
 * > 2026-10-07).
 *
 * > Codex: "Codex supports symlinked skill folders and follows the symlink
 * > target when scanning these locations" (learn.chatgpt.com/docs/build-skills,
 * > fetched 2026-10-07).
 *
 * The layout is the one paperlint's `init` already ships (its `link-skills.ts`),
 * kept on purpose: the links that work in a real consumer are the proven shape.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *   what to link     every skill the package ships: the installed package's
 *                    `skills/` when it is installed, the running CLI's own
 *                    otherwise (the version `init` just declared).
 *   where it points  `node_modules/vigiles` as the PROJECT spells it, found by
 *                    walking up no further than the repository root. A link that
 *                    leaves the repository resolves on this machine only — the
 *                    defect this module exists to remove. Under pnpm the real
 *                    path is a version-stamped store directory; a link spelled
 *                    through `node_modules/vigiles` survives the next upgrade.
 *   what it touches  only what is missing. An entry that already leads to the
 *                    shipped skill is kept; ANY other entry of the same name —
 *                    the user's own skill directory, a file, a link elsewhere —
 *                    is theirs, and is reported, never replaced.
 *
 * Names are not namespaced: a linked skill is `test-harness`, where the plugin's
 * copy is `vigiles:test-harness`. A user's own skill of the same name therefore
 * wins by construction (we never replace it) and the report names the skill
 * they did not get.
 */
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isVigilesSkillTarget } from "./core/skill-link-target.js";

/** The package whose skills are linked. */
export const VIGILES_PACKAGE = "vigiles";

/** What occupies `<skills home>/<name>` today, as the IO edge observed it. */
export type SkillEntry =
  | { readonly kind: "missing" }
  | {
      readonly kind: "link";
      /** The link's stored target, exactly as `readlink` returns it. */
      readonly target: string;
      /** Where it resolves, or null when it dangles. */
      readonly resolvesTo: string | null;
    }
  | { readonly kind: "directory" }
  | { readonly kind: "file" };

/** What `init` should do about one skill. */
export type SkillLinkDecision =
  | {
      readonly name: string;
      /** `replace`: an earlier `init`'s link that now points at the wrong place. */
      readonly action: "create" | "replace";
      readonly target: string;
    }
  | { readonly name: string; readonly action: "keep" }
  | {
      readonly name: string;
      readonly action: "refuse";
      readonly reason: string;
    };

/** The link `init` wants for one skill. */
export interface WantedLink {
  /** The relative target to write (and to recognise on a re-run). */
  readonly target: string;
  /** The real path of the shipped skill, or null while it is not installed. */
  readonly real: string | null;
}

/**
 * Decide one entry. A link with OUR target is ours even while it dangles — that
 * is exactly how a committed link looks in a clone that has not run
 * `npm install` yet, and calling it foreign would make re-running `init` noisy
 * in precisely the place it is meant to help.
 */
export function decideSkillLink(
  name: string,
  entry: SkillEntry,
  want: WantedLink,
): SkillLinkDecision {
  switch (entry.kind) {
    case "missing":
      return { name, action: "create", target: want.target };
    case "link":
      if (
        entry.target === want.target ||
        (entry.resolvesTo !== null && entry.resolvesTo === want.real)
      )
        return { name, action: "keep" };
      // Provably ours (the shape `init` writes, same skill) but aimed elsewhere —
      // e.g. linked before a workspace install hoisted the package. Rewrite it.
      if (isVigilesSkillTarget(entry.target, name))
        return { name, action: "replace", target: want.target };
      return {
        name,
        action: "refuse",
        reason:
          entry.resolvesTo === null
            ? `a dangling link to ${entry.target}`
            : `a link to ${entry.target}`,
      };
    case "directory":
      return { name, action: "refuse", reason: "a directory (your own skill)" };
    case "file":
      return { name, action: "refuse", reason: "a file" };
  }
}

/** Where the package is, as the project spells it. */
export type PackageSite =
  /** Installed: `<ancestor>/node_modules/vigiles`, inside the repository. */
  | { readonly kind: "installed"; readonly dir: string }
  /** Not installed yet: where npm puts the devDependency `init` declares. */
  | { readonly kind: "expected"; readonly dir: string }
  /**
   * Not installed, and the project is a member of a workspace: npm and yarn
   * hoist its dependencies to the workspace ROOT's `node_modules`, pnpm keeps
   * them in the member's own, and a hoist can be refused by a version
   * conflict. Which one happens is decided by the install, so no link is made
   * before it — a guessed link can dangle for good.
   */
  | { readonly kind: "unsure"; readonly reason: string };

/** What the walk may ask of the filesystem. */
export interface PackageProbe {
  /** Is `dir` an installed vigiles package (its `package.json` names it)? */
  readonly isPackage: (dir: string) => boolean;
  /** Is `dir` the repository root (it holds `.git`)? The walk stops there. */
  readonly isRepoRoot: (dir: string) => boolean;
  /** Is `dir` a workspace root (`workspaces` in package.json, or pnpm-workspace.yaml)? */
  readonly isWorkspaceRoot: (dir: string) => boolean;
}

/** Is there a workspace root strictly above `project`, up to the repo root? */
function insideWorkspace(project: string, probe: PackageProbe): boolean {
  const walk = (dir: string): boolean => {
    if (dir !== project && probe.isWorkspaceRoot(dir)) return true;
    if (probe.isRepoRoot(dir) || dirname(dir) === dir) return false;
    return walk(dirname(dir));
  };
  return walk(project);
}

/**
 * Node's own lookup — the first `node_modules/vigiles` up the tree — bounded by
 * the repository root, because a committed link that leaves the repository is a
 * link only this machine can follow.
 */
export function locatePackage(
  project: string,
  probe: PackageProbe,
): PackageSite {
  // The walk stops at the repository root; with no repository yet (before
  // `git init`) the project itself is the boundary, or an unrelated ancestor's
  // node_modules would be linked into it.
  const repoRoot = (dir: string): string | null => {
    if (probe.isRepoRoot(dir)) return dir;
    return dirname(dir) === dir ? null : repoRoot(dirname(dir));
  };
  const boundary = repoRoot(project) ?? project;
  const walk = (dir: string): PackageSite | null => {
    const candidate = join(dir, "node_modules", VIGILES_PACKAGE);
    if (probe.isPackage(candidate))
      return { kind: "installed", dir: candidate };
    if (dir === boundary || dirname(dir) === dir) return null;
    return walk(dirname(dir));
  };
  const installed = walk(project);
  if (installed !== null) return installed;
  return insideWorkspace(project, probe)
    ? {
        kind: "unsure",
        reason:
          "vigiles isn't installed yet and this package is in a workspace, where the install decides whether it lands in this package's node_modules or the workspace root's — run npm install, then npx vigiles init",
      }
    : { kind: "expected", dir: join(project, "node_modules", VIGILES_PACKAGE) };
}

/**
 * Is the real path `path` the project's own real path or somewhere under it?
 * Both must be physical (symlink-free), or a link could pass for a child.
 */
export function isWithinProject(project: string, path: string): boolean {
  const rel = relative(project, path);
  // A child can be NAMED `..cache`; only a whole `..` segment leaves the project.
  return rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

/** The facts that decide whether linking makes sense at all here. */
export interface LinkFacts {
  /** The project IS vigiles — its skills are the plugin's own `skills/`. */
  readonly isVigilesItself: boolean;
  /** `package.json` declares vigiles (so `npm install` will put it in node_modules). */
  readonly dependsOnVigiles: boolean;
  /** The package already resolves from the project. */
  readonly installed: boolean;
}

/**
 * Why NOT to link, or null to go ahead. A link into a `node_modules/vigiles`
 * that no install will ever create is a dangling link committed to the repo — a
 * worse state than no link, because it looks like the job was done.
 */
export function linkPrecondition(facts: LinkFacts): string | null {
  if (facts.isVigilesItself)
    return "this is the vigiles repository itself; its skills are the plugin's own skills/";
  if (!facts.installed && !facts.dependsOnVigiles)
    return "this repo has no package.json dependency on vigiles, so no install will create node_modules/vigiles for a link to point at; the global install carries the skills here instead";
  return null;
}

/** Everything {@link planSkillLinks} needs, observed by the IO edge. */
export interface SkillLinkInput {
  /** The skills the package ships. */
  readonly names: readonly string[];
  readonly site: Exclude<PackageSite, { kind: "unsure" }>;
  /**
   * The skills home as it PHYSICALLY exists (`.claude` may itself be a link).
   * A relative link target resolves against the directory that holds the link.
   */
  readonly physicalHome: string;
  readonly entries: (name: string) => SkillEntry;
  /** The real path of the installed skill, or null. */
  readonly realOf: (name: string) => string | null;
}

/** The decisions, and whether the links will dangle until `npm install`. */
export interface SkillLinkPlan {
  readonly pending: boolean;
  readonly decisions: readonly SkillLinkDecision[];
}

/**
 * A link target as it is committed: `/` separators on every OS. `relative()` on
 * Windows yields `..\\..\\node_modules\\…`, and a clone on Linux or macOS
 * reads those backslashes as ordinary filename characters, so the link dangles.
 */
export function portableTarget(
  target: string,
  separator: string = sep,
): string {
  return target.split(separator).join("/");
}

export function planSkillLinks(input: SkillLinkInput): SkillLinkPlan {
  const skillsDir = join(input.site.dir, "skills");
  return {
    pending: input.site.kind === "expected",
    decisions: input.names.map((name) =>
      decideSkillLink(name, input.entries(name), {
        target: portableTarget(
          relative(input.physicalHome, join(skillsDir, name)),
        ),
        real: input.realOf(name),
      }),
    ),
  };
}

/** The three filesystem calls that write a link; the IO edge passes the real ones. */
export interface LinkIo {
  readonly symlink: (target: string, path: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (path: string) => void;
}

/** Where a replacement link is built before it takes the old one's place. */
export function relinkTempPath(entry: string): string {
  return join(dirname(entry), `.${basename(entry)}.vigiles-new`);
}

/**
 * Write the link `decision` asks for. A `replace` never leaves a gap: the new
 * link is built under a temporary name beside the old one and renamed over it,
 * which is atomic. Removing the old link first would lose it for good when the
 * new one cannot be created (a Windows account without the symlink privilege,
 * a full disk) — a skill that worked yesterday gone, and only a warning to show
 * for it. Any failure leaves the old link in place and throws.
 */
export function writeSkillLink(
  io: LinkIo,
  entry: string,
  target: string,
  action: "create" | "replace",
): void {
  if (action === "create") {
    io.symlink(target, entry);
    return;
  }
  const temp = relinkTempPath(entry);
  // Whatever already sits at the temporary name is not ours to delete: the
  // `symlink` then fails (EEXIST) and is reported, and both entries stay.
  io.symlink(target, temp);
  try {
    io.rename(temp, entry);
  } catch (e) {
    try {
      // Only the link this call just created is removed.
      io.unlink(temp);
    } catch {
      // Already gone: the rename error is the news.
    }
    throw e;
  }
}

/** Why a `symlink` call failed, with the fix when there is a known one. */
export function linkFailureReason(code: string, message: string): string {
  const base = `could not create the link: ${message}`;
  return code === "EPERM"
    ? `${base} — on Windows, creating a symlink needs Developer Mode (or an elevated shell), and git needs core.symlinks=true to check one out`
    : base;
}

/** One skill's result after the IO ran. */
export type SkillLinkResult =
  | {
      readonly name: string;
      readonly status: "created" | "relinked" | "present";
    }
  | {
      readonly name: string;
      readonly status: "skipped";
      readonly reason: string;
    };

/** What `init` did about the skills for one harness. */
export type SkillLinkOutcome =
  | {
      readonly kind: "linked";
      /** Repo-relative skills home, e.g. `.claude/skills`. */
      readonly home: string;
      /**
       * The same home with every symlink resolved, repo-relative with `/`.
       * Git refuses a pathspec that runs through a symlink, so the commit hint
       * names this one.
       */
      readonly physicalHome: string;
      readonly pending: boolean;
      readonly results: readonly SkillLinkResult[];
    }
  | { readonly kind: "not-linked"; readonly reason: string };

/** At least one shipped skill now reaches the agent through a link. */
export function skillLinksUsable(outcome: SkillLinkOutcome): boolean {
  return (
    outcome.kind === "linked" &&
    outcome.results.some((r) => r.status !== "skipped")
  );
}

/**
 * The lines `init` prints. Skipped skills are named one by one: the user loses
 * that skill, and the reason is theirs to act on.
 */
export function formatSkillLinks(outcome: SkillLinkOutcome): readonly string[] {
  if (outcome.kind === "not-linked")
    return [`⚠ vigiles's skills were NOT linked — ${outcome.reason}`];
  const count = (s: SkillLinkResult["status"]): number =>
    outcome.results.filter((r) => r.status === s).length;
  const skipped = outcome.results.filter(
    (r): r is Extract<SkillLinkResult, { status: "skipped" }> =>
      r.status === "skipped",
  );
  const mark = skipped.length > 0 ? "⚠" : "✓";
  return [
    `${mark} vigiles's ${String(outcome.results.length)} skills → ${outcome.home}/ (relative links into node_modules; commit them): ` +
      `${String(count("created"))} linked now, ${String(count("present"))} already linked, ` +
      (count("relinked") > 0 ? `${String(count("relinked"))} relinked, ` : "") +
      `${String(skipped.length)} skipped`,
    ...skipped.map(
      (r) =>
        `  ${outcome.home}/${r.name} left alone — it is ${r.reason}. Rename it to get vigiles's ${r.name}.`,
    ),
    ...(outcome.pending
      ? [
          "  They resolve once vigiles is installed: run npm install (every clone and container needs it anyway).",
        ]
      : []),
  ];
}
