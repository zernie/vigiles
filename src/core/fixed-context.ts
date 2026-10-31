/**
 * The FIXED CONTEXT: everything the harness loads at session start without a
 * decision — the always-loaded instructions, the output style the committed
 * settings select, and the skill listing — summed in the harness's own unit.
 *
 * WHY THE SUM, AND NOT THE INSTRUCTIONS ALONE. `./instruction-weight.ts`
 * explains why a per-FILE weight invites the evasion it is meant to catch: text
 * moved into an always-loaded sibling is still loaded. The output style and the
 * skill listing are always-loaded siblings of the same kind. A section cut
 * from `CLAUDE.md` into the selected style, or into a skill's description,
 * still reaches the model on every request; a weight that counts only the
 * instruction file reads that move as a shrink. The parts are reported one by
 * one so a reader can see WHERE the weight is, and summed so a move between
 * them nets out.
 *
 * WHAT IT IS NOT. It is the part of every request THE REPOSITORY decides, not
 * the size of a request: the harness's own system prompt and tool definitions,
 * user- and plugin-level skills, and the conversation history are added in a
 * real session and are not repository facts. Units are the harness's own
 * (characters for Claude Code, bytes for Codex) and never tokens, for the
 * reason `InstructionBudget.unit` gives.
 *
 * WHAT IS COUNTED, PER PART.
 *
 *   - output style: only a style the COMMITTED settings select and the
 *     repository holds as a file in the session's own style folder. A style
 *     selected in a per-machine settings file is not a property of the commit;
 *     a name no repository file declares (a built-in style, or a typo the
 *     harness silently resolves to its default) has no size vigiles can read,
 *     and is reported by name rather than counted as zero.
 *   - skill listing: every skill in the folder a session at the repository
 *     root loads (`skillsHome`), rendered by the harness's own entry format
 *     with its per-entry cap. A plugin's `skills/` folder is what the plugin's
 *     USERS load, not a session here.
 *
 * Pure: the caller hands in a file map (repo-relative path → text) holding the
 * committed settings, the style files and the SKILL.md files. The CLI reads
 * them from disk; the browser engine passes the tree it fetched.
 */
import type { HarnessDialect } from "./dialect.js";
import { frontmatterBody, readFrontmatter } from "./frontmatter-read.js";
import { sizeIn, type HarnessUnit } from "./harness-unit.js";
import { skillsHome, type PluginLayout } from "./layout.js";
import { outputStyleHomes, type OutputStyle } from "./output-style.js";
import type { ListedSkill } from "./skill-listing.js";

/** The parts that join the instructions in the fixed context. */
export type FixedPartName = "output-style" | "skill-listing";

/** One file's share of a part, in the harness's unit. */
export interface FixedPartFile {
  readonly path: string;
  readonly size: number;
}

/**
 * One part of the fixed context. Each absence is its own fact, because each
 * calls for a different reading:
 *
 *   - `counted` — the part loads, and this is its size;
 *   - `none` — the harness has this part and the repository loads nothing of
 *     it (no style selected, no listed skill);
 *   - `not-supported` — the harness has no such thing (Codex has no output
 *     styles);
 *   - `not-modelled` — the adapter does not say how the harness does it, so
 *     vigiles cannot measure it; NOT the same as zero;
 *   - `unresolved` — a style is selected by a name no repository file
 *     declares: a built-in style, or a typo that loads the default.
 */
export type FixedPart =
  | {
      readonly kind: "counted";
      readonly total: number;
      readonly files: readonly FixedPartFile[];
    }
  | { readonly kind: "none" }
  | { readonly kind: "not-supported" }
  | { readonly kind: "not-modelled" }
  | { readonly kind: "unresolved"; readonly name: string };

export interface FixedContext {
  readonly unit: HarnessUnit;
  /** The instructions' committed total — the same number the weight scores. */
  readonly instructions: number;
  readonly outputStyle: FixedPart;
  readonly skillListing: FixedPart;
  /** Instructions plus every `counted` part. */
  readonly total: number;
}

type FixedLayout = Pick<
  PluginLayout,
  "outputStyles" | "userSurfaceRoot" | "surfaces" | "settings" | "settingsPath"
>;

/** The instructions' weight, as `weighInstructions` measured it. */
export interface WeighedInstructions {
  readonly unit: HarnessUnit;
  /** The SCORED total — what a teammate on the same commit also loads. */
  readonly committedTotal: number;
}

export interface FixedContextInput {
  readonly weight: WeighedInstructions;
  readonly files: Readonly<Record<string, string>>;
  readonly layout: FixedLayout;
  readonly dialect: Pick<HarnessDialect, "skillListing">;
}

/** What one part is measured from: the input, in the weight's unit. */
export interface FixedPartInput {
  readonly files: Readonly<Record<string, string>>;
  readonly layout: FixedLayout;
  readonly dialect: Pick<HarnessDialect, "skillListing">;
  readonly unit: HarnessUnit;
}

/** The committed settings object; `{}` when absent or not parseable. */
function committedSettings(
  layout: FixedLayout,
  files: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  const text = files[layout.settingsPath];
  if (text === undefined) return {};
  try {
    return layout.settings.parse(text);
  } catch {
    return {};
  }
}

const counted = (files: readonly FixedPartFile[]): FixedPart =>
  files.length === 0
    ? { kind: "none" }
    : {
        kind: "counted",
        total: files.reduce((sum, f) => sum + f.size, 0),
        files,
      };

/** The style files in the folder a session at the repository root reads. */
function sessionStyles(
  layout: FixedLayout,
  files: Readonly<Record<string, string>>,
): readonly OutputStyle[] {
  const rules = layout.outputStyles;
  const home = outputStyleHomes(layout).at(-1);
  if (rules === undefined || home === undefined) return [];
  return Object.entries(files)
    .filter(([path]) => path.startsWith(`${home}/`))
    .filter(([path]) => rules.isStyleFile(path.slice(home.length + 1)))
    .map(([path, text]) => rules.read(path, text));
}

/** The selected output style's part. */
export function outputStylePart(
  input: FixedPartInput,
  settings: Readonly<Record<string, unknown>>,
): FixedPart {
  const rules = input.layout.outputStyles;
  if (rules === undefined) return { kind: "not-supported" };
  if (rules.selected === undefined) return { kind: "not-modelled" };
  const selection = rules.selected(settings);
  if (selection.kind !== "named") return { kind: "none" };
  const style = sessionStyles(input.layout, input.files).find(
    (s) => s.name === selection.name,
  );
  return style === undefined
    ? { kind: "unresolved", name: selection.name }
    : counted([{ path: style.path, size: sizeIn(style.body, input.unit) }]);
}

/** Every SKILL.md one level under the session's skills folder, read once. */
export function sessionSkills(
  layout: FixedLayout,
  files: Readonly<Record<string, string>>,
): readonly ListedSkill[] {
  const home = skillsHome(layout);
  if (home === null) return [];
  const re = new RegExp(`^${escapeRe(home)}/([^/]+)/SKILL\\.md$`);
  const found = Object.entries(files).flatMap(([path, text]) => {
    const m = re.exec(path);
    return m === null ? [] : [{ path, dirName: m[1] ?? "", text }];
  });
  return [...found]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, dirName, text }) => {
      const fm = readFrontmatter(text);
      return {
        path,
        dirName,
        frontmatter: fm.malformed ? null : (fm.data ?? {}),
        body: frontmatterBody(text),
      };
    });
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The skill listing's part: each listed skill's entry, sized. */
export function skillListingPart(
  input: FixedPartInput,
  settings: Readonly<Record<string, unknown>>,
): FixedPart {
  const rules = input.dialect.skillListing;
  if (rules === undefined) return { kind: "not-modelled" };
  return counted(
    sessionSkills(input.layout, input.files).flatMap((skill) => {
      const line = rules.entry(skill, settings);
      return line === null
        ? []
        : [{ path: skill.path, size: sizeIn(line, input.unit) }];
    }),
  );
}

/** The size a part adds to the sum: its total when counted, else nothing. */
export const partTotal = (part: FixedPart): number =>
  part.kind === "counted" ? part.total : 0;

/**
 * Weigh the fixed context: the instructions' committed total (already
 * measured by the instruction weight) plus the selected output style and the
 * skill listing, each in the same unit by the same `sizeIn`.
 */
export function weighFixedContext(input: FixedContextInput): FixedContext {
  const part: FixedPartInput = {
    files: input.files,
    layout: input.layout,
    dialect: input.dialect,
    unit: input.weight.unit,
  };
  const settings = committedSettings(input.layout, input.files);
  const outputStyle = outputStylePart(part, settings);
  const skillListing = skillListingPart(part, settings);
  const instructions = input.weight.committedTotal;
  return {
    unit: part.unit,
    instructions,
    outputStyle,
    skillListing,
    total: instructions + partTotal(outputStyle) + partTotal(skillListing),
  };
}
