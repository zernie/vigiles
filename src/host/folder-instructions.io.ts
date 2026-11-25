/**
 * Every FOLDER's own instruction file under `root` — the names the layout
 * declares in `folderInstructionFiles` — with its contents, keyed by
 * repo-relative POSIX path. The root's own files are left out: those are the
 * launch-time read (`boundedInstructionFiles`).
 *
 * 🔴 THIS IS THE ONE UNBOUNDED WALK, AND THE REASON IS WEIGHT. The discovery
 * bound keeps registering an adapter from widening what vigiles reads; it also
 * kept a 153 KB folder file from ever being weighed. Such a file loads the
 * first time the agent reads a file in its folder and stays until compaction,
 * so its size is real. The walk is narrowed instead: only the declared paths,
 * never through a dot-directory (a `.claude/worktrees/*` checkout is a copy of
 * the repository, not a folder of it) — a declared path such as
 * `.claude/CLAUDE.md` names its own dot segment, which `**` still never
 * descends into — never `node_modules`, never a symlink, and
 * the repository's `exclude` applies. Absent `folderInstructionFiles` ⇒
 * nothing is walked.
 *
 * I/O, so it lives here and the composition root hands the result to the
 * on-demand check (`measureOnDemand` in `src/scan.ts`).
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";
import { sortBy } from "remeda";

import { withIgnored, type GlobIgnore } from "../core/glob-ignore.js";
import type { PluginLayout } from "../core/layout.js";

/** The text of a regular file (never a symlink), or `undefined`. */
function readRegular(abs: string): string | undefined {
  try {
    return lstatSync(abs).isFile() ? readFileSync(abs, "utf-8") : undefined;
  } catch {
    return undefined;
  }
}

/** Each folder instruction file below `root`, path → text. */
export function folderInstructionFiles(
  root: string,
  layout: Pick<PluginLayout, "folderInstructionFiles">,
  /** The repository's `exclude`, as its glob face (`ExcludeSet.globIgnore`). */
  ignore?: GlobIgnore,
): Readonly<Record<string, string>> {
  const names = layout.folderInstructionFiles ?? [];
  if (names.length === 0) return {};
  const paths = globSync(
    names.map((n) => `**/${n}`),
    {
      cwd: root,
      posix: true,
      nodir: true,
      dot: false,
      follow: false,
      ignore: withIgnored(["**/node_modules/**"], ignore),
    },
  ).filter((rel) => rel.includes("/"));
  return Object.fromEntries(
    sortBy(paths, (p) => p).flatMap((rel) => {
      const text = readRegular(join(root, rel));
      return text === undefined ? [] : [[rel, text] as const];
    }),
  );
}
