/**
 * Is a symlink's stored target one that `vigiles init` writes — a path ending
 * in `node_modules/vigiles/skills/<name>`, for the SAME skill name?
 *
 * Two readers ask, and must agree, so the answer lives here once:
 *
 * - `init` (`../skill-links.ts`): an existing link of this shape that points
 *   somewhere other than where `init` would link now was made by an earlier
 *   `init` (for example before a workspace install hoisted the package), so it
 *   is replaced instead of being refused as the user's;
 * - `audit` (`../adapters/claude-code/skill-reachability.ts`): only a dangling
 *   link of this shape is "vigiles's link, run npm install". A dangling link
 *   that merely shares a skill's NAME is the user's, and the advice would send
 *   them to fix the wrong thing.
 *
 * The test is on path SEGMENTS (either separator, so a link written on Windows
 * reads the same), not on a substring: `my-node_modules/vigiles/...` is not it.
 */
export function isVigilesSkillTarget(target: string, name: string): boolean {
  const tail = target
    .split(/[\\/]+/)
    .filter((s) => s !== "")
    .slice(-4);
  return (
    tail.length === 4 &&
    tail[0] === "node_modules" &&
    tail[1] === "vigiles" &&
    tail[2] === "skills" &&
    tail[3] === name
  );
}
