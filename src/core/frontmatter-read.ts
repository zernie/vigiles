/**
 * Lenient frontmatter reader — ONE reader for the SKILL.md / subagent `---` block,
 * shared by `scan` and the PreToolUse rail (`agent-runtime`). It is deliberately
 * fault-tolerant: it audits arbitrary third-party files, so it must never throw
 * and must salvage the few scalar/list fields it needs even from a block that
 * isn't valid YAML.
 *
 * The strategy is "real parser, with a safety net": try `js-yaml` (so block
 * scalars, quoted/multi-line values, and flow arrays parse correctly for free);
 * if the block isn't valid YAML, fall back to a regex salvage of the requested
 * field and record `malformed: true` (the signal the `frontmatter-valid` rule
 * reports). A single bad line therefore never blanks out a whole file's metadata.
 *
 * This replaces three divergent hand-parsers (the old `readField` in scan.ts and
 * the regex parse in agent-runtime.ts); `core/frontmatter.ts` is a DIFFERENT
 * concern (the Level-1 `vigiles:` rule block) and is untouched.
 */
import { load, YAMLException } from "js-yaml";

export interface FrontmatterRead {
  /** Parsed mapping when the block is valid YAML, else null (malformed or scalar). */
  readonly data: Record<string, unknown> | null;
  /** Raw text inside the leading `---` fences, or null when there's no block. */
  readonly block: string | null;
  /** True when a leading `---` block EXISTS but is NOT valid YAML. */
  readonly malformed: boolean;
}

// Frontmatter is the very first thing in the file. Anchoring at the start — not
// `(?:^|\n)` — means a `---` horizontal rule in the BODY is never mistaken for
// frontmatter (which matters for the malformed-YAML verdict). A leading BOM is
// stripped first; an optional leading HTML comment is allowed too, which is what
// lets this reader still parse files compiled BEFORE 2026-08-17, when vigiles put
// the `<!-- vigiles:sha256:… -->` stamp above the `---` and thereby hid the
// frontmatter from every stricter reader. Since then the stamp goes BELOW the
// frontmatter (placeIntegrityHeader), so this branch is backward compatibility,
// not a description of what the compiler emits today.
const BLOCK_RE = /^\uFEFF?(?:<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---/;

/** A YAML block-scalar indicator: `>`/`|` with optional chomp (`+`/`-`) + indent digit. */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** Extract + parse the leading frontmatter block, never throwing. */
export function readFrontmatter(markdown: string): FrontmatterRead {
  const m = BLOCK_RE.exec(markdown);
  if (!m) return { data: null, block: null, malformed: false };
  const block = m[1];
  try {
    const parsed = load(block);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return {
        data: parsed as Record<string, unknown>,
        block,
        malformed: false,
      };
    }
    // Valid YAML but not a mapping (e.g. a bare scalar) — usable as no data, but
    // not "malformed": it parsed fine. Salvage will read fields from the block.
    return { data: null, block, malformed: false };
  } catch (e) {
    if (e instanceof YAMLException)
      return { data: null, block, malformed: true };
    throw e;
  }
}

/**
 * A top-level scalar field — from parsed YAML when valid, else a regex salvage
 * from the raw block (handling a block scalar `>`/`|` and a quoted value that
 * starts on the next indented line).
 */
export function frontmatterScalar(
  fm: FrontmatterRead,
  key: string,
): string | undefined {
  if (fm.data && Object.prototype.hasOwnProperty.call(fm.data, key)) {
    const v = fm.data[key];
    if (typeof v === "string") return v.trim() || undefined;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return undefined; // an array/object/null isn't a scalar field
  }
  return fm.block === null ? undefined : salvageField(fm.block, key);
}

/**
 * A tool-list field (`tools:` / `disallowedTools:`) — an array or a comma list,
 * normalized to string[]. Returns `null` when the key is ABSENT (the "no
 * contract / inherits all" signal the rail honors) and `[]` when the key is
 * PRESENT but empty ("no tools"). Salvages from the raw block when YAML is
 * malformed, so the rail still reads the contract.
 */
export function frontmatterList(
  fm: FrontmatterRead,
  key: string,
): string[] | null {
  if (fm.data && Object.prototype.hasOwnProperty.call(fm.data, key)) {
    const v = fm.data[key];
    if (v === null) return []; // `key:` with nothing after it → empty contract
    if (Array.isArray(v))
      return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
    if (typeof v === "string") return splitList(v);
    return [];
  }
  return fm.block === null ? null : salvageList(fm.block, key);
}

// --- salvage (the malformed-YAML / no-data fallback) ------------------------

/** Old `readField`: gather a possibly multi-line scalar value from the raw block. */
function salvageField(block: string, key: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (idx === -1) return undefined;
  const keyIndent = /^(\s*)/.exec(lines[idx])?.[1].length ?? 0;
  const inline = (
    new RegExp(`^${key}:[ \\t]*(.*)$`).exec(lines[idx])?.[1] ?? ""
  ).trim();
  if (inline && !BLOCK_SCALAR_RE.test(inline)) {
    return inline.replace(/^["']|["']$/g, "").trim() || undefined;
  }
  const collected: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0;
    if (indent <= keyIndent) break;
    collected.push(lines[i].trim());
  }
  return (
    collected
      .join(" ")
      .trim()
      .replace(/^["']/, "")
      .replace(/["']$/, "")
      .trim() || undefined
  );
}

/** Salvage a list field from the raw block (single-line key only). */
function salvageList(block: string, key: string): string[] | null {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block);
  if (!match) return null;
  return splitList(match[1]);
}

/**
 * Split a tool-list string into trimmed, de-quoted tokens.
 *
 * WHITESPACE IS A SEPARATOR, BUT ONLY AT PAREN DEPTH 0 — and that qualifier is
 * the whole rule. Claude Code documents three equivalent spellings of
 * `allowed-tools:`/`disallowed-tools:` (a comma-separated string, a
 * SPACE-separated string, a YAML list), and its own documented example is
 * space-separated with spaces INSIDE the tokens:
 *
 *   allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
 *
 * Until #217 this split on `,` alone, so a space-separated fence arrived as ONE
 * token that matches no built-in name. That failed in the direction that misleads:
 * a fence the harness really enforces was reported as closing no lethal-trifecta
 * leg, so an author who wrote a correct fence was told it did nothing. Reported
 * with a reproduction by @vlad-ryzhkov, measured on a 22-skill harness where the
 * separator alone moved Safety 81 → 80 → 81.
 *
 * THE NAIVE FIX IS WORSE THAN THE BUG, which is why this is a tokenizer and not
 * `split(/[,\s]+/)`: that shreds `Bash(git push *)` into `Bash(git`, `push`, `*)`,
 * and since `bashGrantIsUnbounded()` answers "unbounded" when it cannot recognise
 * a grant, a BOUNDED grant would start reading as an unbounded one. That is the
 * false-exposed side of the trade `core/lethal-trifecta.ts` already reasons about
 * — a scarier verdict for a reason the author cannot see anywhere in their file.
 *
 * Quotes are stripped per token AFTER splitting, never treated as a delimiter:
 * `allowed-tools: "Read Write Glob"` is a YAML-quoted scalar whose VALUE is a
 * space-separated list, and Claude Code splits it. Treating the quotes as token
 * boundaries would keep exactly the bug this fixes for every skill that quotes
 * its list.
 */
function splitList(raw: string): string[] {
  const out: string[] = [];
  let token = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const flush = (): void => {
    const t = token.trim().replace(/^["']|["']$/g, "");
    if (t.length > 0) out.push(t);
    token = "";
  };
  for (const ch of raw.trim().replace(/^\[|\]$/g, "")) {
    if (escaped) {
      escaped = false;
      token += ch;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      token += ch;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) quote = ch;
    else if (quote === ch) quote = null;
    // Depth tracks STRUCTURE, so a parenthesis inside a quoted string is a
    // character, not a bracket. Without this, `Bash(printf '( %s' foo) Read`
    // leaves depth at 1 after the grant closes and swallows `Read` into the
    // same token — on a subagent that denies a tool the author granted, which
    // is the exact failure this function exists to fix.
    else if (quote === null) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    // Quotes deliberately do NOT suppress splitting: `allowed-tools: "Read
    // Write Glob"` is a YAML-quoted scalar whose VALUE is a space-separated
    // list, and Claude Code splits it. The quotes come off per token below.
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      flush();
      continue;
    }
    token += ch;
  }
  flush();
  return out;
}
