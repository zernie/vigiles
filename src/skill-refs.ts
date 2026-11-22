/**
 * A skill that names a SIBLING SKILL that does not exist.
 *
 * ## The gap this closes
 *
 * A skill referring to another skill BY NAME, in prose, was checked by nothing.
 *
 * That is the reference agents actually follow. Skills route to each other
 * constantly — "run `verify-citations` first", "compose with `find-venue`" — and
 * a rename breaks every mention SILENTLY. Nothing crashes: the model reads a
 * route to a skill that is not there and does something adjacent, which is the
 * failure mode this whole tool exists for. Found 2026-08-11 in a consumer repo
 * whose orchestrator skill listed the pipeline's stages by name; two stages had
 * been added and never listed, and one local hand-written harness was the only
 * thing that noticed.
 *
 * ## Precision first, and why it is a NEAR-MISS check rather than a name check
 *
 * The naive version — "every backticked kebab token must be a skill" — fires on
 * `claude-code`, `node-fetch`, `pull-request`, every hyphenated noun an author
 * writes. A checker that fires on clean input is muted within a day, which is
 * worse than one that misses, so this asks a narrower question:
 *
 *   is this token ALMOST a skill that exists?
 *
 * A kebab token within a small edit distance of a real skill name, that is not
 * itself a real skill, is a rename or a typo with high probability — while
 * `node-fetch` in a repo of paper skills is far from all of them and stays
 * silent. The check is deliberately blind to a reference to a skill that never
 * existed under any similar name; that case is indistinguishable from ordinary
 * hyphenated prose without reading intent.
 *
 * Pure: takes names and contents, touches no filesystem, so the disk walker and
 * any in-browser twin can share it.
 */

/** One skill as this module needs to see it. */
export interface SkillRefSource {
  /** Skill id (directory name). */
  readonly name: string;
  /** Repo-relative path of its SKILL.md, for the message. */
  readonly path: string;
  /** Its markdown. */
  readonly content: string;
}

export interface SkillRefIssue {
  /** The skill whose text carries the broken reference. */
  readonly from: string;
  /** Path of the file to open. */
  readonly path: string;
  /** The name it referred to. */
  readonly missing: string;
  /** The existing skill it most resembles — the likely intended target. */
  readonly didYouMean: string;
}

/**
 * Levenshtein distance, capped: stops as soon as the best possible result
 * exceeds `max`, because every call here only asks "is it within 2?".
 */
function distanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(
        (row[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return null; // no cell in this row can lead anywhere useful
    prev = row;
  }
  const d = prev[b.length] ?? Number.POSITIVE_INFINITY;
  return d <= max ? d : null;
}

/**
 * Kebab-case tokens inside backticks — the shape a skill id has, and the way
 * every skill in the wild refers to one. At least one hyphen is required: a
 * single word in backticks is overwhelmingly a flag, a field or a variable.
 */
const KEBAB_IN_TICKS = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g;

/** How far a token may be from a real skill name and still count as a near-miss. */
const MAX_EDIT_DISTANCE = 2;

/**
 * Broken skill→skill references across a set of skills.
 *
 * Self-references are ignored (a skill naming itself is normal), and so is any
 * token that IS a skill — the check only speaks about near-misses.
 */
export function brokenSkillRefs(
  skills: readonly SkillRefSource[],
): SkillRefIssue[] {
  const names = new Set(skills.map((s) => s.name));
  const issues: SkillRefIssue[] = [];
  for (const skill of skills) {
    const seen = new Set<string>();
    for (const m of skill.content.matchAll(KEBAB_IN_TICKS)) {
      const token = m[1];
      if (token === undefined || names.has(token) || seen.has(token)) continue;
      seen.add(token);
      let best: { name: string; d: number } | null = null;
      for (const candidate of names) {
        if (candidate === skill.name) continue;
        const d = distanceWithin(token, candidate, MAX_EDIT_DISTANCE);
        if (d !== null && (best === null || d < best.d))
          best = { name: candidate, d };
      }
      if (best !== null)
        issues.push({
          from: skill.name,
          path: skill.path,
          missing: token,
          didYouMean: best.name,
        });
    }
  }
  return issues;
}

/** One line per issue, in the report's voice. */
export function formatSkillRefIssue(i: SkillRefIssue): string {
  return (
    `${i.path}: refers to \`${i.missing}\`, and no such skill exists — did you mean ` +
    `\`${i.didYouMean}\`? Nothing crashes on a broken skill reference: the agent reads ` +
    `a route to a skill that is not there and does something adjacent.`
  );
}
