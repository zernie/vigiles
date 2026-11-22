/**
 * vigiles — SKILL.md missing-fence detector (the cross-reference moat applied
 * to SKILL.md frontmatter structure).
 *
 * A SKILL.md that begins with frontmatter-looking keys (`name:`, `description:`,
 * `allowed-tools:`, etc.) but is MISSING the opening `---` fence is a very
 * common real-world pain: the harness loads the whole file as plain body text —
 * no name, no description, no tool list — so the skill is INVISIBLE and never
 * fires. The model-selector has nothing to match against and the agent can never
 * find the skill at all.
 *
 * HIGH-PRECISION / FP-SAFE, by the same don't-cry-wolf discipline as the rest of
 * vigiles (see `confidentToolIssues`): we flag ONLY when the
 * first non-blank, non-comment line matches a KNOWN frontmatter key at column 0
 * from an explicit whitelist (`name`, `description`, `allowed-tools`, `tools`,
 * `model`, `color`, `disable-model-invocation`, `argument-hint`, `version`,
 * `license`, `metadata`). A random prose line like `Note: something` is never
 * flagged — the whitelist is what keeps the check FP-safe. Prefer MISSING a
 * real finding over emitting a false positive.
 *
 * Pure: no IO. Input is the raw SKILL.md content string.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A finding returned when a SKILL.md is missing its opening `---` fence but
 * begins with what looks like a frontmatter key.
 */
export interface SkillFenceFinding {
  /** The frontmatter-looking key that appears unfenced (e.g. `"name"`). */
  readonly key: string;
  /** 1-based line number of the first unfenced key in the content string. */
  readonly line: number;
  /** Human-readable explanation and fix. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Constants (FP-safety whitelist)
// ---------------------------------------------------------------------------

/**
 * The known SKILL.md / agent-harness frontmatter keys. A line that matches one
 * of these at column 0 is flagged when there is no opening `---` fence. Any
 * key NOT in this list is treated as prose and silently skipped.
 */
const KNOWN_KEYS = [
  "name",
  "description",
  "allowed-tools",
  "tools",
  "model",
  "color",
  "disable-model-invocation",
  "argument-hint",
  "version",
  "license",
  "metadata",
] as const;

/**
 * Pre-built regex: matches `<known-key>:` at column 0, optionally followed by
 * whitespace or end-of-line. Capturing group 1 holds the matched key name.
 */
const KNOWN_KEY_RE = new RegExp(`^(${KNOWN_KEYS.join("|")})\\s*:`);

/**
 * Lines that are unambiguously prose or markdown structure — NOT frontmatter.
 * When the first meaningful line starts with any of these, return null
 * immediately without even testing the key whitelist.
 */
const PROSE_START_RE = /^(?:#|>|-|\*|`|<|\d+\.|[A-Za-z]{4,}(?:\s|$))/;

/**
 * A vigiles integrity / meta comment that may legitimately precede frontmatter.
 * We skip it so `name:` on line 2 (after the comment on line 1) is still found.
 */
const VIGILES_COMMENT_RE = /^<!--\s*vigiles:/;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Detect a SKILL.md body that begins with a known frontmatter key at column 0
 * but is missing the required opening `---` fence.
 *
 * Returns a {@link SkillFenceFinding} describing the unfenced key, or `null`
 * when no problem is detected (the file is correctly fenced, starts with prose,
 * or is empty).
 *
 * Pure — no IO. The shared detector behind both `vigiles lint`
 * (`skill-missing-fence` rule) and `vigiles audit` — one detector, no drift.
 */
export function skillMissingFence(skillBody: string): SkillFenceFinding | null {
  // Strip a leading UTF-8 BOM (U+FEFF) if present.
  const content = skillBody.startsWith("﻿") ? skillBody.slice(1) : skillBody;

  const lines = content.split("\n");

  let firstMeaningfulLine: string | null = null;
  let firstMeaningfulLineNo = 0; // 1-based

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();

    // Skip blank lines.
    if (trimmed.trim() === "") continue;

    // Skip a leading vigiles integrity/meta comment (`<!-- vigiles:... -->`).
    if (VIGILES_COMMENT_RE.test(trimmed.trim())) continue;

    firstMeaningfulLine = trimmed;
    firstMeaningfulLineNo = i + 1; // convert to 1-based
    break;
  }

  // Empty or all-blank file — nothing to flag.
  if (firstMeaningfulLine === null) return null;

  // A proper opening fence — correctly structured, nothing to flag.
  if (firstMeaningfulLine.startsWith("---")) return null;

  // Unambiguous prose / markdown constructs — not a frontmatter key.
  if (PROSE_START_RE.test(firstMeaningfulLine)) return null;

  // Check against the known-key whitelist (the FP-safety gate).
  const match = KNOWN_KEY_RE.exec(firstMeaningfulLine);
  if (!match) return null;

  const key = match[1];
  return {
    key,
    line: firstMeaningfulLineNo,
    message:
      `SKILL.md is missing its opening \`---\` frontmatter fence: ` +
      `\`${key}:\` on line ${firstMeaningfulLineNo} is loaded as body text, ` +
      `so the skill has no name, description, or trigger and will never fire. ` +
      `Wrap the metadata block in \`---\` … \`---\`.`,
  };
}
