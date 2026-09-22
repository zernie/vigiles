/**
 * Codex's instruction chain — the one file a repo-root session loads, and why
 * every other `AGENTS.md`-shaped file in the map does not.
 *
 * Verbatim from the vendor page (`https://developers.openai.com/codex/guides/agents-md`,
 * fetched 2026-09-21 and recorded in zernie/vigiles#262): starting at the
 * project root Codex walks DOWN to the current working directory, taking **at
 * most one file per directory** along that path, checking `AGENTS.override.md`
 * first, then `AGENTS.md`, then fallback names the repo itself declares via
 * `project_doc_fallback_filenames` in `config.toml`. The files are concatenated
 * root-down and truncated at a byte cap on file boundaries.
 *
 * 🔴 SO `"**\/AGENTS.md"` WAS NOT MERELY UNBOUNDED, IT WAS WRONG. At a repo-root
 * session the chain is the ROOT DIRECTORY ALONE — cwd and root are the same
 * directory, so there is no path to walk down. Summing every nested `AGENTS.md`
 * added up files that never load together: a monorepo with twelve package-level
 * files was told it was 12× over a budget no session ever approaches. Codex
 * TRUNCATES silently over its budget, so this number is the only warning a user
 * gets, and it was crying wolf on the harness where wolf means "your rules do
 * not exist".
 *
 * And `AGENTS.override.md` is the mirror image of Claude Code's local file: it
 * REPLACES the committed file rather than being appended after it. That is the
 * difference the `replaced` reason exists to carry — the combination rule is the
 * harness's, the fact that a file was hidden is reported to the core.
 */
import type {
  InstructionChain,
  LoadedInstruction,
  UnloadedInstruction,
} from "../../core/instruction-chain.js";
import { siblingNamed } from "../../core/instruction-chain.js";

/** The `config.toml` key by which a repo declares its own instruction names. */
const FALLBACK_NAMES_KEY = "project_doc_fallback_filenames";

/** `AGENTS.md` → `AGENTS.override.md`: the per-machine file that REPLACES it. */
export function overrideSiblingOf(instructionFile: string): string {
  return siblingNamed(instructionFile, "override");
}

/** Inputs the layout supplies so this module names no path of its own. */
export interface CodexChainInput {
  /** `AGENTS.md`. */
  readonly instructionFile: string;
  /** The settings files, in precedence order (repo, then the local sibling). */
  readonly settingsPaths: readonly string[];
  /** The layout's own codec — this module does not know the encoding. */
  readonly parseSettings: (text: string) => Record<string, unknown>;
}

/** `project_doc_fallback_filenames`, in the order the repo declared them. */
function fallbackNames(
  files: Readonly<Record<string, string>>,
  input: CodexChainInput,
): readonly string[] {
  const out: string[] = [];
  for (const path of input.settingsPaths) {
    const text = files[path];
    if (text === undefined) continue;
    let value: Record<string, unknown>;
    try {
      value = input.parseSettings(text);
    } catch {
      // A config mid-merge must not decide which instructions load; falling
      // back to "the documented names only" is the conservative reading.
      continue;
    }
    const raw = value[FALLBACK_NAMES_KEY];
    if (!Array.isArray(raw)) continue;
    for (const name of raw) {
      if (typeof name === "string" && name !== "" && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

export function codexInstructionChain(
  files: Readonly<Record<string, string>>,
  input: CodexChainInput,
): InstructionChain {
  const override = overrideSiblingOf(input.instructionFile);
  // The root directory's ONE slot, in the vendor's precedence order.
  //
  // 🔴 THE OVERRIDE IS A REPOSITORY FILE, NOT A PER-MACHINE ONE. It used to be
  // `scope: "local"` on the reasoning "like Claude Code's, it is a per-machine
  // file" — an analogy, and the vendor does not support it. Codex's guide:
  // "In each directory along the path, it checks for `AGENTS.override.md`,
  // then `AGENTS.md`". The one override it calls temporary is the GLOBAL
  // `~/.codex/AGENTS.override.md`; the guide never mentions `.gitignore`.
  // Measured on the browser engine, where every file is committed by
  // construction: a repository holding both files published `committed 0`,
  // while Codex loads the override's bytes. Same class as the invented
  // `.codex/config.local.toml` earlier in this PR — a sibling modelled by
  // analogy instead of by observation.
  const candidates: readonly LoadedInstruction[] = [
    { path: override, role: "root", scope: "repo" },
    { path: input.instructionFile, role: "root", scope: "repo" },
    ...fallbackNames(files, input).map(
      (name): LoadedInstruction => ({
        path: name,
        role: "fallback",
        scope: "repo",
      }),
    ),
  ];

  const loaded: LoadedInstruction[] = [];
  const unloaded: UnloadedInstruction[] = [];
  for (const candidate of candidates) {
    if (files[candidate.path] === undefined) continue;
    const winner = loaded[0];
    if (winner === undefined) {
      loaded.push(candidate);
      continue;
    }
    // AT MOST ONE FILE PER DIRECTORY. Everything after the winner is present
    // and does not load, and says by whom it was replaced — which is the whole
    // content of the field #262 called `shadows`.
    unloaded.push({
      ...candidate,
      reason: { kind: "replaced", by: winner.path },
    });
  }

  // A nested `AGENTS.md` is NOT loaded at a repo-root session: the walk goes
  // root→cwd, and at the root those are the same directory. The domain's bound
  // never enumerates one, so this branch is reached only by a caller holding a
  // wider map — and then the honest answer is "only when the session runs in
  // that directory", not "always".
  const named = new Set([...loaded, ...unloaded].map((e) => e.path));
  const leaves = new Set([input.instructionFile, override]);
  for (const path of Object.keys(files).sort()) {
    if (named.has(path) || !path.includes("/")) continue;
    if (!leaves.has(path.slice(path.lastIndexOf("/") + 1))) continue;
    unloaded.push({
      path,
      role: "root",
      scope: "repo",
      reason: { kind: "on-demand", when: "subdirectory" },
    });
  }

  // No imports and no patterns: Codex's project doc has no include mechanism —
  // an empty array here is a STATEMENT, not a stub, and the property tests hold
  // over it the same way they hold over a populated one.
  return { loaded, unloaded, imports: [], patterns: [], redirects: [] };
}
