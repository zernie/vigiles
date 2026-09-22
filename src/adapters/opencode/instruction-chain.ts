/**
 * OpenCode's instruction chain — EXPERIMENTAL, like the rest of this adapter.
 *
 * It exists because it is the port's THIRD implementation, and the third one is
 * where a shape has room to go wrong: both of the layout port's live illegal
 * states were here, in the implementation the contract suite did not range over.
 * For `instructionChain` it earns its keep a second way — it is the only
 * implementation in this repo that populates {@link InstructionChain.patterns},
 * so without it that half of the interface would be typed, documented and
 * exercised by nothing.
 *
 * ⚠️ SOURCE OF THE `instructions` FACT, NAMED RATHER THAN IMPLIED. The key and
 * its glob shape (`instructions: ["packages/*\/AGENTS.md"]`) are taken from
 * `docs/design/port-redesign-round-2-2026-09-21.md` §1, which is where this
 * adapter's other shapes come from too. It is NOT a vendor page this session
 * fetched, and the adapter is unregistered and unexported, so nothing a user
 * runs depends on it being exactly right. Do not promote it to a registered
 * adapter without re-reading the vendor.
 *
 * What it does NOT do is expand those globs. A pattern is reported so the weight
 * can say "plus N pattern(s) not weighed" instead of printing a number that is
 * quietly missing them — the same stance the Codex chain takes towards a nested
 * file, and the opposite of what the glob list this replaced did, which was to
 * expand an adapter's pattern by walking the user's repository.
 */
import type {
  InstructionChain,
  LoadedInstruction,
  PatternFrom,
  NamedImport,
} from "../../core/instruction-chain.js";
import { isRepoRootedImport } from "../../core/instruction-chain.js";

/** The manifest key listing extra instruction files, as the design records it. */
const INSTRUCTIONS_KEY = "instructions";

/** A value the domain would have to WALK to expand, rather than look up. */
function isPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value) || value.includes("://");
}

/** Inputs the layout supplies so this module names no path of its own. */
export interface OpencodeChainInput {
  /** `AGENTS.md`. */
  readonly instructionFile: string;
  /** `opencode.json` — both the manifest and the settings file here. */
  readonly settingsPaths: readonly string[];
  /** The layout's own codec — this module does not know the encoding. */
  readonly parseSettings: (text: string) => Record<string, unknown>;
}

/** The `instructions` entries one settings file declares, in declared order. */
function declaredInstructions(
  files: Readonly<Record<string, string>>,
  input: OpencodeChainInput,
): readonly NamedImport[] {
  const out: NamedImport[] = [];
  for (const from of input.settingsPaths) {
    const text = files[from];
    if (text === undefined) continue;
    let value: Record<string, unknown>;
    try {
      value = input.parseSettings(text);
    } catch {
      continue;
    }
    const raw = value[INSTRUCTIONS_KEY];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry === "string" && entry !== "") {
        // The token AS WRITTEN is the manifest string itself — OpenCode names
        // a path directly rather than prefixing it, so token === path here.
        out.push({ path: entry, token: entry, from });
      }
    }
  }
  return out;
}

export function opencodeInstructionChain(
  files: Readonly<Record<string, string>>,
  input: OpencodeChainInput,
): InstructionChain {
  const loaded: LoadedInstruction[] = [];
  const imports: NamedImport[] = [];
  const patterns: PatternFrom[] = [];
  if (files[input.instructionFile] !== undefined) {
    loaded.push({ path: input.instructionFile, role: "root", scope: "repo" });
  }
  for (const entry of declaredInstructions(files, input)) {
    if (isPattern(entry.path)) {
      patterns.push({ pattern: entry.path, from: entry.from });
      continue;
    }
    if (!isRepoRootedImport(entry.path)) continue;
    imports.push(entry);
    if (files[entry.path] === undefined) continue;
    if (loaded.some((e) => e.path === entry.path)) continue;
    loaded.push({
      path: entry.path,
      role: "import",
      scope: "repo",
      via: { from: entry.from, token: entry.token },
    });
  }
  // No `unloaded`, and no `redirects`: nothing in OpenCode's documented shape
  // hides one file behind another, and its extra instruction files are named in
  // the MANIFEST rather than inside the root file, so the root file cannot be a
  // pure pointer. Empty arrays are the statement, not a gap.
  return { loaded, unloaded: [], imports, patterns, redirects: [] };
}
