/**
 * Cross-harness skill-frontmatter verification (slice 3 of
 * research/multi-harness-compile.md, the *verify* half).
 *
 * A skill's `SKILL.md` references are harness-agnostic; the one harness-specific
 * surface is the frontmatter PROFILE. The `claude-code` profile emits CC-only
 * keys (`disable-model-invocation`, `argument-hint`); the `minimal` profile
 * (Codex, OpenCode) omits them. So a skill that sets those keys, in a repo that
 * also targets a minimal-profile harness, has a silent semantic gap: the
 * constraint the author expressed won't take effect there.
 *
 * This reports that gap. It is ASSUMPTION-FREE — the minimal profile *drops* the
 * keys, so the warning states a fact about vigiles's own output, not a guess
 * about another tool's parser tolerance.
 */
import type { SkillSpec } from "./core/spec.js";
import { getAdapter } from "./adapter-registry.js";

/**
 * The optional frontmatter keys a skill spec would emit that this check ranges
 * over. `name` and `description` are excluded because conformance requires
 * every dialect to read them, so they can never be dropped.
 *
 * ⚠️ NOT the whole optional set: `context`, `allowed-tools` and
 * `disallowed-tools` are also droppable and are not listed here. That is the
 * pre-existing scope of this warning, carried over unchanged when the profile
 * enum became a key set — widening it is a behaviour change to argue
 * separately, not a side effect of the rename.
 */
export function optionalFrontmatterKeys(spec: SkillSpec): string[] {
  const keys: string[] = [];
  if (spec.disableModelInvocation !== undefined) {
    keys.push("disable-model-invocation");
  }
  if (spec.argumentHint || (spec.inputs && spec.inputs.length > 0)) {
    keys.push("argument-hint");
  }
  return keys;
}

/**
 * Warn for each declared harness that would DROP frontmatter keys this skill
 * sets, because its dialect does not read them. Empty when the skill uses no
 * optional keys, or when every declared harness reads the ones it uses.
 *
 * 🔴 THE KEYS THE WARNING NAMES ARE NOW THE KEYS ACTUALLY DROPPED. It used to
 * test `dialect.skillFrontmatter === "minimal"` and then print every
 * Claude-Code-only key the spec set — one bucket for every non-CC harness, and
 * a message that could name a key the harness in fact reads. The set difference
 * is both the condition and the message, so the two cannot disagree.
 */
export function skillFrontmatterDropWarnings(
  spec: SkillSpec,
  harnessNames: readonly string[],
): string[] {
  const optionalKeys = optionalFrontmatterKeys(spec);
  if (optionalKeys.length === 0) return [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const name of harnessNames) {
    const adapter = getAdapter(name);
    if (!adapter || seen.has(adapter.name)) continue;
    seen.add(adapter.name);
    const read = adapter.dialect.skillFrontmatterKeys;
    const dropped = optionalKeys.filter((key) => !read.includes(key));
    if (dropped.length > 0) {
      const one = dropped.length === 1;
      warnings.push(
        `skill "${spec.name}": ${dropped.join(", ")} ${one ? "is" : "are"} not read by declared harness "${adapter.name}" — it drops ${one ? "it" : "them"}.`,
      );
    }
  }
  return warnings;
}
