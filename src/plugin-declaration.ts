/**
 * The project-level plugin DECLARATION that `vigiles init` writes into a repo's
 * `.claude/settings.json`.
 *
 * ⚠️ **What this does and does not buy — the claim matters.** Writing
 * `extraKnownMarketplaces` + `enabledPlugins` does **NOT** make the plugin
 * available to a collaborator. Per the Claude Code docs (Discover plugins →
 * "Configure team marketplaces"), as of CC v2.1.195:
 *
 * > A plugin that only the project's `.claude/settings.json` enables, and that
 * > comes from an external source such as a GitHub repository or npm package,
 * > doesn't load until the team member installs it. Until then, Claude Code
 * > reports the plugin as not installed and shows the `claude plugin install`
 * > command to run.
 *
 * vigiles ships from a GitHub marketplace, so that is exactly our case, and the
 * boundary is deliberate: plugins "can execute arbitrary code on your machine
 * with your user privileges", so a repo is not allowed to install one for you.
 *
 * The declaration buys exactly one thing: a collaborator who clones the repo is
 * told the project wants this plugin, with the command that installs it.
 * **Silent absence becomes a prompt.** It does not become a working install. What
 * the plugin adds on their machine is the HOOKS; the SKILLS do not depend on it
 * any more — `init` links them into `.claude/skills/` (`./skill-links.ts`), and
 * the links travel with the clone.
 *
 * Nothing is vendored: what lands in the repo is a *reference* (a marketplace
 * source plus an enabled flag). The plugin content still lives in the global
 * cache, one copy shared across every repo on the machine.
 *
 * Both directions are PURE functions over the parsed settings object, so the
 * merge rules are unit-tested without touching a file. The rule that matters
 * most is **never clobber**: this file holds the user's hooks, permissions and
 * other plugins, and destroying it would be far worse than the silence.
 */

/** The marketplace name vigiles registers under. */
export const VIGILES_MARKETPLACE_NAME = "vigiles";

/** The plugin id `claude plugin install` records — `<plugin>@<marketplace>`. */
export const VIGILES_PLUGIN_ID = "vigiles@vigiles";

/** The marketplace entry `init` writes (a reference, not vendored content). */
export const VIGILES_MARKETPLACE_ENTRY = {
  source: { source: "github", repo: "zernie/vigiles" },
} as const;

/** The result of an edit: the new settings, whether anything moved, and why. */
export interface DeclarationEdit {
  /** A NEW object — the input is never mutated. */
  readonly settings: Record<string, unknown>;
  /** False when the file already said what we wanted it to say. */
  readonly changed: boolean;
  /** Human-readable notes for the CLI to print (never invented state). */
  readonly notes: readonly string[];
}

/** A shallow object clone, or a fresh object when the value isn't one. */
function objectAt(
  settings: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = settings[key];
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {};
}

/** A copy of `obj` without `key`. Pure — the input is untouched. */
function omit(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/** Is `key` an own property of the object at `settings[parent]`? */
function has(
  settings: Record<string, unknown>,
  parent: string,
  key: string,
): boolean {
  const v = settings[parent];
  return (
    typeof v === "object" &&
    v !== null &&
    Object.prototype.hasOwnProperty.call(v, key)
  );
}

/**
 * Add the vigiles marketplace + enabled flag, **merging** into whatever is
 * already there. Pure — returns a new object.
 *
 * Two deliberate non-actions, both cases of "an existing answer is the user's
 * answer, not a gap to fill":
 *
 * - An existing `extraKnownMarketplaces.vigiles` is left **exactly** as-is. It
 *   may point at a fork or a pinned ref, and rewriting it to upstream would
 *   silently retarget their install.
 * - An existing `enabledPlugins["vigiles@vigiles"]` is left as-is **including
 *   when it is `false`** — that is a deliberate disable, and flipping it back
 *   would be the clobber this function exists to avoid.
 */
export function addVigilesDeclaration(
  settings: Record<string, unknown>,
): DeclarationEdit {
  const notes: string[] = [];
  const next = { ...settings };

  const haveMarketplace = has(
    settings,
    "extraKnownMarketplaces",
    VIGILES_MARKETPLACE_NAME,
  );
  const haveEnabled = has(settings, "enabledPlugins", VIGILES_PLUGIN_ID);

  if (!haveMarketplace) {
    const marketplaces = objectAt(settings, "extraKnownMarketplaces");
    marketplaces[VIGILES_MARKETPLACE_NAME] = VIGILES_MARKETPLACE_ENTRY;
    next.extraKnownMarketplaces = marketplaces;
    notes.push("registered the vigiles marketplace");
  } else {
    notes.push("left the existing vigiles marketplace entry alone");
  }

  if (!haveEnabled) {
    const enabled = objectAt(settings, "enabledPlugins");
    enabled[VIGILES_PLUGIN_ID] = true;
    next.enabledPlugins = enabled;
    notes.push(`declared ${VIGILES_PLUGIN_ID}`);
  } else {
    notes.push(`left the existing ${VIGILES_PLUGIN_ID} setting alone`);
  }

  return { settings: next, changed: !haveMarketplace || !haveEnabled, notes };
}

/**
 * Remove exactly what {@link addVigilesDeclaration} writes, and nothing else.
 * Pure. Other marketplaces and other plugins are never touched; a parent object
 * left empty is dropped so the file isn't littered with `{}`.
 *
 * Note what this deliberately does NOT do: uninstall the global plugin. That
 * install is shared by every repo on the machine, so one project cannot speak
 * for the others.
 */
export function removeVigilesDeclaration(
  settings: Record<string, unknown>,
): DeclarationEdit {
  const notes: string[] = [];
  let next = { ...settings };
  let changed = false;

  // Each removal is a pure rebuild: drop our key from the child, then either
  // keep the trimmed child or drop the parent when we emptied it (so the file
  // isn't littered with `{}` we introduced).
  const strip = (parent: string, key: string, note: string): void => {
    if (!has(settings, parent, key)) return;
    const kept = omit(objectAt(settings, parent), key);
    next =
      Object.keys(kept).length === 0
        ? omit(next, parent)
        : { ...next, [parent]: kept };
    changed = true;
    notes.push(note);
  };

  strip(
    "extraKnownMarketplaces",
    VIGILES_MARKETPLACE_NAME,
    "removed the vigiles marketplace entry",
  );
  strip("enabledPlugins", VIGILES_PLUGIN_ID, `removed ${VIGILES_PLUGIN_ID}`);

  if (!changed) notes.push("no vigiles declaration was present");
  return { settings: next, changed, notes };
}
