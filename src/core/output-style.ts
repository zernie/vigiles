/**
 * Output styles: files that set how the agent talks for a whole session,
 * chosen by a name in the harness settings.
 *
 * The core knows only that idea. Where the files live, how a name is read from
 * one, which setting selects it and how a run shows that it arrived are each
 * harness's own rules, given by its layout as `outputStyles`. A layout without
 * them is a harness that has no output styles.
 */
import type { ModelRequest } from "./harness-driver.js";
import type { PluginLayout } from "./layout.js";

/** One style, read by its harness's rules. */
export interface OutputStyle {
  /** Path from the repository root. */
  readonly path: string;
  /** The name a setting must spell, or null when the harness cannot tell. */
  readonly name: string | null;
  /** The text the harness delivers, frontmatter removed. */
  readonly body: string;
}

/** How one harness keeps output styles and switches one on. */
export interface OutputStyleRules {
  /** The folder of style files, e.g. `output-styles`. */
  readonly dir: string;
  /** Whether a path inside that folder is a file the harness loads. */
  readonly isStyleFile: (pathInDir: string) => boolean;
  /** Reads one style file as this harness does. */
  readonly read: (path: string, text: string) => OutputStyle;
  /** The settings that switch the named style on. */
  readonly select: (name: string) => Readonly<Record<string, unknown>>;
  /** Whether one model request carries the style. */
  readonly reached: (style: OutputStyle, request: ModelRequest) => boolean;
}

/** What a repository holds, or that its harness has no such thing. */
export type OutputStyleScan =
  | { readonly kind: "not-supported" }
  | { readonly kind: "found"; readonly styles: readonly OutputStyle[] };

type StyleLayout = Pick<PluginLayout, "outputStyles" | "userSurfaceRoot">;

/** The folders a harness reads styles from: a plugin's root and the user surface root. */
export function outputStyleHomes(layout: StyleLayout): readonly string[] {
  const dir = layout.outputStyles?.dir;
  if (dir === undefined) return [];
  const root = layout.userSurfaceRoot;
  return root === undefined || root === "" ? [dir] : [dir, `${root}/${dir}`];
}

const pathInside = (home: string, path: string): string | null =>
  path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;

/** Every style among `files` (repository path → text). Pure: the caller reads the disk. */
export function findOutputStyles(
  layout: StyleLayout,
  files: ReadonlyMap<string, string>,
): OutputStyleScan {
  const rules = layout.outputStyles;
  if (rules === undefined) return { kind: "not-supported" };
  const homes = outputStyleHomes(layout);
  const isStyle = (path: string): boolean =>
    homes.some((home) => {
      const rest = pathInside(home, path);
      return rest !== null && rules.isStyleFile(rest);
    });
  const styles = [...files]
    .filter(([path]) => isStyle(path))
    .map(([path, text]) => rules.read(path, text));
  return {
    kind: "found",
    styles: [...styles].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
