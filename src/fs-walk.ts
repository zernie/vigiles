/**
 * The ONE symlink policy for every recursive directory walk in vigiles.
 *
 * 🔴 WHY THIS IS A MODULE AND NOT A HELPER INSIDE ONE WALK. Two walks used to
 * cross the same trees — the loader's `readTree` (`plugin-loader.ts`, which builds
 * the file map the whole report is computed from) and the surface enumerator
 * behind the foreign-runner warning (`harnessSurfaceFilesOnDisk`, `scan.ts`).
 * Both used `statSync`, which FOLLOWS a symlink, so a surface dir holding a link
 * to an ancestor was a cycle: measured 2026-08-12 on a two-file fixture, the
 * loader did not merely slow down, it THREW `ELOOP: too many symbolic links
 * encountered` out of `scanPlugin`, and the enumerator reported the same file once
 * per lap. A link to a large external tree is the quieter half: an advisory scan
 * reads a foreign tree into the report.
 *
 * ⚠️ The SECOND walk is gone — the foreign-runner warning and its enumerator were
 * deleted the same day (see the tombstone in `core/foreign-runner.ts`), so the
 * loader is currently the only caller. The policy stays a module rather than
 * folding back into it: the bug it fixes is a property of walking a surface tree,
 * not of one function, and fixing such a pair on only one side is this repo's
 * known failure shape. The next walk over these trees inherits the policy instead
 * of rediscovering ELOOP.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** What a walk should do with one directory entry. */
export type EntryKind = "dir" | "file" | "skip";

/** A classified entry, plus the size the loader needs. */
export interface Entry {
  readonly kind: EntryKind;
  /** Byte size of the target; `0` for anything that is not a `"file"`. */
  readonly size: number;
}

/**
 * Classify a directory entry for a recursive walk, refusing to descend into a
 * symlinked DIRECTORY.
 *
 * 🔴 THE SIZE COMES BACK FROM THE SAME `stat`, and that is not a convenience. The
 * loader needs both "is this a file" and "is it under the size cap", and asking
 * twice produced a SECOND failure path that nothing could reach: between a
 * successful classification and a second `statSync` the file has to vanish, so the
 * `catch` around the size check was dead code that the 100% coverage gate could
 * only ever fail on. One syscall answers both questions and there is no second
 * path to test.
 *
 * `lstat` describes the ENTRY, `stat` describes its target, and both are needed:
 * the first decides whether descending is safe, the second decides what a link
 * actually points at. A symlink to a FILE is still `"file"` — it cannot recurse,
 * it is genuinely part of the tree, and dropping it would lose real findings.
 *
 * A cycle is removed by CONSTRUCTION rather than by a visited-set: there is no
 * bookkeeping to get wrong, and nothing outside the checkout is ever entered. The
 * cost is a deliberate omission — files under a symlinked SUBdirectory are not
 * seen — which for an advisory finding is the correct direction (silence), and for
 * the loader means a linked-in tree is not loaded rather than loaded forty times.
 *
 * Anything unreadable (a dangling link, a permissions error, a socket) is
 * `"skip"`: a walk feeding a read-only report must not die on one bad entry.
 */
export function entryOf(path: string): Entry {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const target = statSync(path);
      return target.isFile()
        ? { kind: "file", size: target.size }
        : { kind: "skip", size: 0 };
    }
    const st = statSync(path);
    if (st.isDirectory()) return { kind: "dir", size: 0 };
    if (st.isFile()) return { kind: "file", size: st.size };
    return { kind: "skip", size: 0 };
  } catch {
    return { kind: "skip", size: 0 };
  }
}

/**
 * May a walk DESCEND INTO THIS ROOT — a top-level surface dir such as
 * `.claude/skills`, `skills` or `agents`?
 *
 * 🔴 THE POLICY ABOVE WAS APPLIED TO EVERY ENTRY INSIDE A WALK AND TO NO WALK'S
 * ENTRY POINT. Both walks take their roots straight to `readdirSync`, which
 * FOLLOWS a link, so a symlinked `.claude/skills` was never classified at all —
 * the containment each walk documents ("only the surface dirs are walked, so the
 * rest of the repo and any `node_modules` beside it is never entered"; "a foreign
 * tree is not read into the file map the whole report is computed from") simply
 * did not hold at the top. Same class as the entry-level defect, one level up.
 *
 * ⚠️ A ROOT GETS A DIFFERENT RULE FROM AN INNER ENTRY, AND THE DIFFERENCE IS
 * DELIBERATE — do not "fix" the inconsistency later. An inner symlinked dir is one
 * the walk FOUND BY ITSELF; following it is the walk deciding to leave the tree on
 * its own initiative, so it is refused outright. A surface root is one the LAYOUT
 * NAMES: `.claude/skills` is where a Claude Code repo keeps skills, and linking
 * that at a shared directory (one skills folder used by several checkouts) is an
 * ordinary, supported setup. Refusing it the way an inner entry is refused would
 * report ZERO skills for those repos, silently — a worse failure than the one
 * being fixed, and the exact silent-under-report this file exists to prevent.
 *
 * So a symlinked root IS followed, with one refusal: a target that CONTAINS the
 * scanned root. That is the cycle-and-swallow case — `.claude/skills -> ..`,
 * `skills -> /`, `.claude/skills -> .` — where the walk re-enters the very tree it
 * is scanning through a door the layout did not open, and starts reading
 * `node_modules`, `.git` and every sibling as harness surface.
 *
 * Termination is still by CONSTRUCTION, not by bookkeeping: everything BELOW a
 * followed root goes through {@link entryOf}, which refuses a symlinked dir, so
 * exactly one link hop is taken per root and the hop count for a whole scan is
 * bounded by the number of surface dirs. There is no visited-set to get wrong.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH: a root linked at a huge unrelated
 * external tree (`.claude/skills -> ~/`). Reading it is slow and wide, but the
 * user pointed at it — refusing would be the silent-empty failure above, and
 * "the user asked for a big directory" is not a defect we can tell apart from
 * "the user has a big skills library".
 *
 * A root that is not a symlink at all is `true` unchanged: callers have already
 * established it is a directory, and this must not become a second existence
 * check that quietly disagrees with the first.
 */
export function walkableRoot(dir: string, scanRoot: string): boolean {
  let link;
  try {
    link = lstatSync(dir);
  } catch {
    return false; // unreadable: the same answer `entryOf` gives
  }
  if (!link.isSymbolicLink()) return true;
  try {
    return !contains(realpathSync(dir), realpath(scanRoot));
  } catch {
    return false; // dangling link — nothing to walk
  }
}

/** A classified entry, plus whether entries BELOW it may still cross a directory link. */
export interface LinkedEntry extends Entry {
  readonly mayFollowBelow: boolean;
}

/**
 * {@link entryOf} for a walk over a SKILLS folder, where ONE symlinked directory
 * per path may be entered.
 *
 * 🔴 WHY SKILLS GET THIS AND OTHER SURFACES DO NOT. `vigiles init` installs a
 * shipped skill by linking its folder into the skills folder, and both Claude
 * Code and Codex list a linked skill folder like a real one. Under
 * {@link entryOf} alone the loader refused every such link, so on a real
 * repository `vigiles audit` printed `Skills (58)` while the skill listing it
 * weighs — and the harness — carried 83: 27 skill folders were links. The
 * listing reader and the loader now both classify through this function, so the
 * count and the listing cannot disagree about which folders exist.
 *
 * THE POLICY IS {@link walkableRoot}'s, ONE LEVEL DOWN. A linked skill folder is
 * an entry the layout names, like a surface root, so it is followed — with two
 * refusals, both the cycle case: a target that CONTAINS the scanned root
 * (`skills/x -> <repo>`), and a target that contains the link itself
 * (`skills/a/self -> skills`), which re-enters the tree being walked.
 *
 * Termination is by CONSTRUCTION, as everywhere in this module: below a
 * followed link `mayFollowBelow` is `false`, so every path crosses at most one
 * directory link (plus its root's own), and a walk over finite real
 * directories ends. A chain of links that never points back at an ancestor
 * (`A/b -> B`, `B/c -> A`) is cut at the second hop by the same rule. There is
 * no visited-set to get wrong.
 */
export function skillTreeEntryOf(
  path: string,
  scanRoot: string,
  mayFollow: boolean,
): LinkedEntry {
  const entry = entryOf(path);
  if (entry.kind === "skip" && mayFollow && followableDirLink(path, scanRoot))
    return { kind: "dir", size: 0, mayFollowBelow: false };
  return { ...entry, mayFollowBelow: mayFollow };
}

/**
 * Whether an entry {@link entryOf} skipped is a directory link a skills walk may
 * enter. Only skipped entries are asked, so a plain directory never reaches
 * here; a dangling link throws from `realpathSync` and is refused.
 */
function followableDirLink(path: string, scanRoot: string): boolean {
  try {
    const target = realpathSync(path);
    return (
      !contains(target, realpath(scanRoot)) &&
      !contains(target, realpathSync(dirname(path))) &&
      statSync(target).isDirectory()
    );
  } catch {
    return false;
  }
}

/** `realpathSync`, falling back to a plain resolve for a root that is not there. */
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether `outer` is `inner` itself or one of its ancestors. */
function contains(outer: string, inner: string): boolean {
  return (
    inner === outer ||
    inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
  );
}
