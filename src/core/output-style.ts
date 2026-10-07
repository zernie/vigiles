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
  /**
   * Relative to the directory the caller scanned (a bundle), `/`-separated,
   * exactly as the caller's file map keyed it. A plain string by the same
   * contract as every scan-core path; `Bundle.scanned` in `frame.ts` gives it
   * a frame. Not the `BundlePath` brand: that type is internal and must not
   * reach this public interface.
   */
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
  /**
   * The settings that switch every style off, so a run without the style does
   * not pick up one the user turned on for all their projects.
   */
  readonly selectNone: Readonly<Record<string, unknown>>;
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

/** A run with one style switched on, or why it cannot be set up. */
export type StyleRunPlan =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "planned";
      /** The style as the harness will read it, at its place in the work dir. */
      readonly style: OutputStyle;
      readonly files: Readonly<Record<string, string>>;
      readonly settings: Readonly<Record<string, unknown>>;
    };

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Where the style goes and what it is called there, or why it cannot go. */
function placeStyle(
  layout: StyleLayout,
  source: { readonly path: string; readonly text: string },
): OutputStyle | string {
  const rules = layout.outputStyles;
  const home = outputStyleHomes(layout).at(-1);
  if (rules === undefined || home === undefined)
    return "this harness has no output styles";
  // Either separator: a Windows path from `path.resolve` uses backslashes.
  const file = source.path.split(/[\\/]/).at(-1) ?? source.path;
  if (!rules.isStyleFile(file))
    return `this harness would not load "${file}" as an output style`;
  const style = rules.read(`${home}/${file}`, source.text);
  return style.name === null
    ? `cannot tell which name selects "${source.path}"`
    : style;
}

/** The fixture's settings with the selection added, or why they clash. */
function selectIn(
  settings: unknown,
  selection: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | string {
  const base = settings ?? {};
  if (!isPlainObject(base)) return "the fixture's settings are not an object";
  const clash = Object.keys(selection).find((key) => key in base);
  return clash === undefined
    ? { ...base, ...selection }
    : `the fixture's settings already set "${clash}"; the style option sets it`;
}

/**
 * Put one style file into a test's fixture and switch it on BY THE NAME THE
 * HARNESS READS from it — never a name the caller types. Pure: the caller reads
 * the file. Refuses instead of guessing when the harness has no styles, would
 * not load such a file, cannot tell its name, or the fixture already decides.
 */
export function planStyleRun(
  layout: StyleLayout,
  source: { readonly path: string; readonly text: string },
  fixture: {
    readonly files: Readonly<Record<string, string>>;
    readonly settings: unknown;
  },
): StyleRunPlan {
  const style = placeStyle(layout, source);
  if (typeof style === "string") return { kind: "refused", reason: style };
  if (style.path in fixture.files)
    return {
      kind: "refused",
      reason: `the fixture already has a file at ${style.path}`,
    };
  const selection = layout.outputStyles?.select(style.name ?? "") ?? {};
  const settings = selectIn(fixture.settings, selection);
  return typeof settings === "string"
    ? { kind: "refused", reason: settings }
    : {
        kind: "planned",
        style,
        files: { ...fixture.files, [style.path]: source.text },
        settings,
      };
}

/** Whether any request of a run carried the style, by its harness's own rule. */
export function styleReached(
  rules: OutputStyleRules,
  style: OutputStyle,
  requests: readonly ModelRequest[],
): boolean {
  return requests.some((request) => rules.reached(style, request));
}
