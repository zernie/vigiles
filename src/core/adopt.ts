/**
 * Faithful markdown → typed-spec adoption — the deterministic half of `init`
 * auto-adopt (research/install-enforcement-dx.md).
 *
 * Turns an existing instruction file (CLAUDE.md / AGENTS.md) into a `instructionFile()`
 * spec source that compiles back to ~the same file, so adopting a rich,
 * hand-tuned instruction file is SAFE: every heading becomes a prose section
 * (verbatim), no rule is invented, nothing is dropped. The contract to the user
 * is "review the diff" — for a well-headed file that diff is small (whitespace +
 * the canonical `# <target>` h1). The agentic path (the `adopt-spec` skill)
 * handles irregular prose better; this is the zero-model floor.
 *
 * WHY IT ALWAYS COMPILES: the compiler only rejects `#`/`##` headers INSIDE a
 * section body (sections render as `##`), so we split the file on every `#`/`##`
 * heading — each becomes its own section, and `###`+ subheadings ride along
 * inside the body untouched. Reserved lowercase keys
 * (`commands`/`keyFiles`/`rules`) are never produced (`safeKey`). `guidance()`
 * vs `enforce()` is deliberately NOT guessed here — that cross-referencing is
 * `strengthen`'s separate, later job; adoption is lossless transcription.
 */

import { DEFAULT_MAX_SECTION_LINES } from "./compile.js";
import { findIntegrityHeader, parseIntegrityHeader } from "./integrity.js";
import {
  readFrontmatter,
  frontmatterScalar,
  frontmatterList,
  type FrontmatterRead,
} from "./frontmatter-read.js";
import {
  experimental_skill,
  experimental_agent,
  type SkillSpec,
  type AgentSpec,
} from "./spec.js";
import { fencedLineFlags } from "./markdown.js";

export type AdoptTier = "structured" | "raw";

export interface AdoptResult {
  /** Generated `.spec.ts` source (compiles back to ~the original file). */
  source: string;
  /**
   * Backticked paths that RESOLVED at adoption time and were emitted as verified
   * `file()` refs. Empty when no `exists` predicate was supplied (the faithful,
   * extract-nothing behaviour) or when nothing resolved.
   */
  adoptedRefs?: readonly string[];
  /**
   * `structured` = a clean `##`-headed file mapped 1:1 to sections (the diff is
   * just the canonical h1 + whitespace). `raw` = a heading-less or
   * intro-bearing file we wrapped under a synthesized `Overview` section —
   * content is preserved verbatim, but the diff adds a heading, so "review the
   * diff" matters more.
   */
  tier: AdoptTier;
  /** Number of named sections produced (excluding the auto-rendered h1). */
  sectionCount: number;
}

/**
 * The intermediate adoption result: the `instructionFile()` spec FIELDS (before
 * rendering to source). Exposed so the renderer and the round-trip tests share
 * one parse — the test can feed `sections` straight into `compileClaude` and
 * assert the file is reproduced, without evaluating generated TS source.
 */
export interface AdoptedSpec {
  target: string;
  /** Heading → verbatim section body, in document order. */
  sections: Record<string, string>;
  /** Set only when a faithful section exceeds the compiler's 200-line guard. */
  maxSectionLines?: number;
  tier: AdoptTier;
}

interface Block {
  /** Heading text, or null for the leading preamble block. */
  heading: string | null;
  /** Hash count (1 or 2) for a heading block; null for the preamble. */
  level: 1 | 2 | null;
  lines: string[];
}

// A top-level heading is `#` or `##` (the levels the compiler reserves for
// document/section structure). `###`+ stay inside a section body.
const HEADING_RE = /^ {0,3}(#{1,2})\s+(.*)$/;

// Mirrors compile.ts RESERVED_SECTION_KEYS — keys that clash with the structured
// `commands`/`keyFiles`/`rules` fields and would be a compile error as a section.
const RESERVED_SECTION_KEYS = new Set([
  "commands",
  "keyFiles",
  "key-files",
  "key_files",
  "rules",
]);

/**
 * Split a markdown body into a leading preamble block plus one block per
 * top-level (`#`/`##`) heading. Fence-aware, so a `## ` inside a fenced code
 * block is not a split point (matching the compiler's own section validator).
 */
function splitIntoBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let current: Block = { heading: null, level: null, lines: [] };
  const lines = body.split("\n");
  const fenced = fencedLineFlags(body);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A heading only splits when it is NOT inside a fenced code block. Fence
    // lines (and everything inside) stay as verbatim content of the current
    // block — matching the prior behavior, but fence-correct on nesting.
    const m = fenced[i] ? null : line.match(HEADING_RE);
    if (m) {
      blocks.push(current);
      current = {
        heading: m[2].trim(),
        level: m[1].length as 1 | 2,
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Avoid a reserved lowercase section key (`commands`/`rules`/…) by capitalizing
 * the first letter — which is exactly the heading the compiler renders anyway,
 * so there's no visible diff.
 */
function safeKey(heading: string): string {
  return RESERVED_SECTION_KEYS.has(heading)
    ? heading.charAt(0).toUpperCase() + heading.slice(1)
    : heading;
}

/**
 * Allocate a unique section key, disambiguating a duplicate with ` (2)`, ` (3)`,
 * … and recording it in `used`. Shared by the real-heading loop and the
 * synthesized `Overview`, so no two sections collide on one object key (which
 * would silently drop the earlier one's content).
 */
function allocKey(base: string, used: Set<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base} (${n})`;
  used.add(key);
  return key;
}

/**
 * Emit a readable multi-line TS template literal for arbitrary section content,
 * escaping the three sequences that would break it: backslash, backtick, and the
 * `${` interpolation opener. TS un-escapes them back to the original string, so
 * the round-trip is exact.
 */
function tsTemplate(s: string): string {
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return "`" + esc + "`";
}

/**
 * A backticked token that looks like a repo-relative path: contains a slash and
 * no whitespace. Deliberately loose — the DECIDING filter is not the shape, it is
 * whether the path RESOLVES (see {@link refInterpolatedTemplate}).
 */
const PATH_LIKE = /`([^`\s]+)`/g;

/** Whether a backticked token may be adopted as a verified `file()` reference. */
function adoptableRef(token: string, exists: (p: string) => boolean): boolean {
  // A path claim, not a symbol or a command: it has a separator.
  if (!token.includes("/")) return false;
  // Someone else's world — a URL, an absolute path, a home path, an escape.
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false;
  if (token.startsWith("/") || token.startsWith("~")) return false;
  if (token.includes("..")) return false;
  // 🔴 THE WHOLE DESIGN IS THIS LINE. Adoption emits a ref ONLY for a path that
  // resolves in THIS repo right now.
  return exists(token);
}

/**
 * Render a section as a template, turning every backticked path that RESOLVES
 * TODAY into a verified `${file("…")}` reference.
 *
 * WHY THIS EXISTS. Adoption used to transcribe faithfully and extract NOTHING —
 * `rules: {}`, every reference left as inert prose — on the stated grounds that
 * cross-referencing is `strengthen`'s later job. An adopter measured what that
 * trade actually costs (2026-08-28, a 51-skill monorepo): running
 * `vigiles init --target=CLAUDE.md` turned the file into one opaque template with
 * zero refs extracted, so "the price is paid immediately — the file becomes a
 * build artifact, hand edits are blocked by a hook, every backtick is escaped —
 * while the benefit is deferred until a human rewrites every reference by hand."
 * The checker was never the problem: he hand-wrote two `file()` calls and compile
 * correctly reported `[stale-file]`, exit 1. The ADOPTION PATH did not populate it,
 * so nobody reached the value and the second step never happened.
 *
 * WHY RESOLVE-NOW IS THE RIGHT FILTER, and not a heuristic. The undecidable
 * question is "is this OUR path or a path inside the third-party repo this
 * document DESCRIBES?" — the same wall that made `doc-refs` default to off after
 * scoring 0 true positives, and that the adopter hit independently (1560
 * path-shaped strings in his corpus, 907 unresolvable, single-digit true
 * positives after filtering; almost all the rest were paths in repos his skills
 * merely describe). Asking instead "does it resolve HERE, right now?" sidesteps
 * it: a described repo's path does not exist locally, so it is never emitted.
 *
 * The consequences are the ones adoption needs:
 *  - ZERO new failures at adoption time — only already-green refs are emitted, so
 *    `compile` cannot start red on a file that was fine a second earlier;
 *  - value from the FIRST compile rather than after a manual pass — the ref goes
 *    red exactly when the file moves, which is the entire point of marking it;
 *  - a false emit is benign (an extra verified ref), while a false SKIP costs
 *    only what the old behaviour already cost.
 *
 * Fence-awareness goes through the shared `fencedLineFlags` oracle, never a
 * private toggle: a path inside a fenced block is example code, and hand-rolled
 * fence state is the exact defect that oracle exists to make unrepresentable.
 */
export function refInterpolatedTemplate(
  content: string,
  exists: (p: string) => boolean,
): { template: string; refs: string[] } {
  const fenced = fencedLineFlags(content);
  const refs: string[] = [];
  const rendered = content
    .split("\n")
    .map((line, i) => {
      if (fenced[i]) return tsTemplate(line).slice(1, -1);
      let out = "";
      let last = 0;
      for (const m of line.matchAll(PATH_LIKE)) {
        const token = m[1];
        if (!adoptableRef(token, exists)) continue;
        out += tsTemplate(line.slice(last, m.index)).slice(1, -1);
        out += "${file(" + JSON.stringify(token) + ")}";
        refs.push(token);
        last = m.index + m[0].length;
      }
      return out + tsTemplate(line.slice(last)).slice(1, -1);
    })
    .join("\n");
  return { template: "`" + rendered + "`", refs };
}

function renderSpecSource(
  spec: AdoptedSpec,
  exists?: (p: string) => boolean,
): { source: string; refs: string[] } {
  const targetLine =
    spec.target !== "CLAUDE.md"
      ? `\n  target: ${JSON.stringify(spec.target)},`
      : "";
  // The raised guard is rendered WITH the debt spelled out. A bare number reads
  // as a considered setting; the comment says it was accepted as-is and by how
  // much, so the next author sees a debt rather than a decision.
  const over = (spec.maxSectionLines ?? 0) - DEFAULT_MAX_SECTION_LINES;
  const maxLine =
    spec.maxSectionLines !== undefined
      ? `\n  // Adopted as-is: the longest section is ${String(spec.maxSectionLines)} lines, ` +
        `${String(over)} over the ${String(DEFAULT_MAX_SECTION_LINES)}-line budget.` +
        `\n  // Lower this as you split that section up; it is a debt, not a setting.` +
        `\n  maxSectionLines: ${String(spec.maxSectionLines)},`
      : "";
  const adopted: string[] = [];
  const entries = Object.entries(spec.sections)
    .map(([key, content]) => {
      if (!exists) return `    ${JSON.stringify(key)}: ${tsTemplate(content)},`;
      const { template, refs } = refInterpolatedTemplate(content, exists);
      adopted.push(...refs);
      return `    ${JSON.stringify(key)}: ${template},`;
    })
    .join("\n");
  const sectionsBlock = entries
    ? `\n  sections: {\n${entries}\n  },`
    : `\n  sections: {},`;
  const source = `// Adopted from ${spec.target} by \`vigiles init\` — faithful by default.
// Each heading became a prose section; no rules were inferred. Run the
// \`/strengthen\` skill to upgrade prose to verified enforce()/guard() rules.
import { instructionFile${adopted.length ? ", file" : ""} } from "vigiles/spec";

export default instructionFile({${targetLine}${maxLine}${sectionsBlock}
  rules: {},
});
`;
  return { source, refs: adopted };
}

/**
 * Parse an instruction file's markdown into the faithful `instructionFile()` spec FIELDS.
 * The shared core of {@link adoptMarkdown} and the round-trip tests.
 *
 * @param markdown the file's current content (an existing integrity header, if
 *   any, is stripped — we adopt the body)
 * @param target   the bare target filename (`"CLAUDE.md"` / `"AGENTS.md"`),
 *   which the compiler renders as the h1
 */
export function adoptToSpec(markdown: string, target: string): AdoptedSpec {
  const header = parseIntegrityHeader(markdown);
  const body = header ? header.body : markdown;

  const blocks = splitIntoBlocks(body);
  const overviewLines: string[] = [];
  const ordered: { key: string; content: string }[] = [];
  const usedKeys = new Set<string>();
  let titleConsumed = false;
  let synthesizedHeading = false;

  for (const block of blocks) {
    if (block.level === null) {
      // Preamble before any heading — has no structural home, so it goes to a
      // synthesized Overview section.
      overviewLines.push(...block.lines);
      continue;
    }
    if (!titleConsumed && block.level === 1) {
      // The document title — the compiler re-renders `# <target>` from the
      // filename, so drop the heading line; its body (intro prose under the h1)
      // also has no slot, so it joins Overview.
      titleConsumed = true;
      overviewLines.push(...block.lines);
      continue;
    }
    const key = allocKey(safeKey(block.heading ?? ""), usedKeys);
    ordered.push({ key, content: block.lines.join("\n").trim() });
  }

  const overview = overviewLines.join("\n").trim();
  if (overview) {
    synthesizedHeading = true;
    // Allocate the synthesized key with the SAME dedup as real headings, so a
    // file that already has a literal `## Overview` doesn't collide and silently
    // drop the intro when the sections object is built (it becomes "Overview (2)").
    ordered.unshift({ key: allocKey("Overview", usedKeys), content: overview });
  }

  const sections: Record<string, string> = {};
  for (const { key, content } of ordered) sections[key] = content;

  // A faithful section can legitimately be long, and adoption must not fail on
  // prose the user already has — so the 200-line guard is raised to EXACTLY the
  // longest section, never above it.
  //
  // IT USED TO BE `longest + 50`, and that headroom is the bug this block exists
  // to name: the guard was disarmed hardest for the population that needs it
  // most — someone adopting a spec over a file that is already oversized — and
  // the next fifty lines of growth were pre-approved, silently, by the tool
  // meant to notice them. Raising to `longest` keeps adoption green on the file
  // as it stands and makes the very next line that grows trip the gate. The
  // override is rendered with a comment stating how far above the budget it
  // sits, so the debt is visible in the spec rather than inferable from a number
  // nobody reads.
  const longest = ordered.reduce(
    (n, s) => Math.max(n, s.content.split("\n").length),
    0,
  );

  return {
    target,
    sections,
    maxSectionLines: longest > DEFAULT_MAX_SECTION_LINES ? longest : undefined,
    tier: synthesizedHeading || ordered.length === 0 ? "raw" : "structured",
  };
}

/**
 * Convert an instruction file's markdown into a faithful `instructionFile()` spec source
 * (the deliverable `init` writes).
 */
export function adoptMarkdown(
  markdown: string,
  target: string,
  opts: { readonly exists?: (p: string) => boolean } = {},
): AdoptResult {
  const spec = adoptToSpec(markdown, target);
  const { source, refs } = renderSpecSource(spec, opts.exists);
  return {
    source,
    tier: spec.tier,
    sectionCount: Object.keys(spec.sections).length,
    adoptedRefs: refs,
  };
}

// ---------------------------------------------------------------------------
// Skill / subagent adoption — turn an existing SKILL.md / agents/<name>.md into
// an `experimental_skill()` / `experimental_agent()` spec source. BEST-EFFORT (not a guaranteed byte
// round-trip like the instruction-file path): the verbatim BODY and the
// standard frontmatter fields round-trip, but a non-standard frontmatter key the
// typed spec can't model (e.g. a custom `level:`/`skills:`) is PRESERVED in a
// loud comment, never silently dropped (the same "review the diff, lose nothing"
// contract as instruction adoption). The deferred harness-parity gap from the
// roadmap — `init` adopts CLAUDE.md today; this extends it to skills + subagents.
// ---------------------------------------------------------------------------

export interface AdoptSurfaceResult {
  /** Generated `.spec.ts` source. */
  source: string;
  kind: "skill" | "agent";
  /**
   * The parsed spec object the source builds — exposed so a round-trip test can
   * feed it straight to `compileSkill`/`compileAgent` without evaluating the
   * generated TS (the same split as `adoptToSpec`/`renderSpecSource`).
   */
  spec: SkillSpec | AgentSpec;
  /**
   * Frontmatter keys present in the source that the typed spec has no field for
   * — emitted as a `// NOTE:` comment in the source so nothing is lost silently.
   */
  unmappedKeys: string[];
}

// Consumes the WHOLE leading frontmatter block (through its closing `---` and the
// trailing newline) so the remainder is the verbatim body — mirrors BLOCK_RE in
// frontmatter-read.ts but matches past the closing fence.
const FRONTMATTER_CONSUME_RE =
  /^\uFEFF?(?:<!--[\s\S]*?-->\s*)?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

function splitFrontmatterBody(markdown: string): {
  fm: FrontmatterRead;
  body: string;
} {
  // Strip the integrity header FIRST, wherever it sits. FRONTMATTER_CONSUME_RE above knows
  // only the pre-2026-08-17 placement (a comment BEFORE the frontmatter); once the header
  // moved below the frontmatter it landed inside what this function calls "the body", so a
  // round-trip adopt \u2192 compile \u2192 re-adopt grew a stamp into the spec's body on every pass.
  // Delegating keeps ONE site that knows where the header can be \u2014 which is the entire point
  // of findIntegrityHeader, and this caller is the one the move missed.
  const source = findIntegrityHeader(markdown)?.withoutHeader ?? markdown;
  const fm = readFrontmatter(source);
  if (fm.block === null) return { fm, body: source.replace(/^\uFEFF/, "") };
  const m = FRONTMATTER_CONSUME_RE.exec(source);
  return { fm, body: m ? source.slice(m[0].length) : source };
}

/** The first non-empty, non-heading paragraph — the CC fallback for a skill's
 * description when its frontmatter omits one (name←dir, description←first ¶). */
function firstParagraph(body: string): string {
  const para: string[] = [];
  let started = false;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!started) {
      if (t === "" || /^#{1,6}\s/.test(t)) continue;
      started = true;
      para.push(t);
    } else {
      if (t === "") break;
      para.push(t);
    }
  }
  return para.join(" ").trim();
}

/** Keys the typed spec models — everything else is reported as unmapped. */
const SKILL_KNOWN_KEYS = new Set([
  "name",
  "description",
  "allowed-tools",
  "tools",
  "disable-model-invocation",
  "argument-hint",
  "context",
]);
const AGENT_KNOWN_KEYS = new Set([
  "name",
  "description",
  "model",
  "color",
  "tools",
  "disallowedTools",
  "disallowed-tools",
]);

/**
 * Top-level `key:` names from a raw frontmatter block (column-0 only, so nested
 * map entries and `- list` items are ignored). The fallback for a MALFORMED block
 * where js-yaml gave us no parsed map — without it every key would be silently
 * dropped from the NOTE (dogfood E3).
 */
function rawTopLevelKeys(block: string): string[] {
  const keys: string[] = [];
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

function unmappedFrontmatterKeys(
  fm: FrontmatterRead,
  known: Set<string>,
): string[] {
  // Valid YAML → the parsed keys.
  if (fm.data) return Object.keys(fm.data).filter((k) => !known.has(k));
  // Malformed YAML (data === null but a block is present): the parsed map is
  // empty, so EVERY unmapped key would otherwise vanish silently from the NOTE
  // (dogfood E3). Recover the top-level key names from the raw block so the user
  // is told which frontmatter didn't survive adoption.
  if (fm.block !== null) {
    return rawTopLevelKeys(fm.block).filter((k) => !known.has(k));
  }
  return [];
}

/** A `// NOTE:` banner naming any frontmatter keys we couldn't represent. */
function unmappedNote(kind: "skill" | "agent", keys: string[]): string {
  if (keys.length === 0) return "";
  return (
    `// NOTE: these frontmatter keys had no ${kind}() field and were left out —\n` +
    `// re-add them by hand if they matter: ${keys.join(", ")}\n`
  );
}

const SURFACE_HEADER = (from: string) =>
  `// Adopted from ${from} by \`vigiles init\` — body verbatim, standard\n` +
  `// frontmatter mapped; no rules inferred. Review the diff, then \`compile\`.\n`;

/**
 * Adopt an existing SKILL.md into an `experimental_skill()` spec. The body is carried verbatim
 * (skills are freeform markdown — `##` headings stay in the body), so a clean
 * skill round-trips below the integrity header.
 *
 * @param markdown the SKILL.md content
 * @param dirName  the skill's directory name — the CC fallback for `name` when
 *   frontmatter omits it
 */
export function adoptSkill(
  markdown: string,
  dirName: string,
): AdoptSurfaceResult {
  const { fm, body } = splitFrontmatterBody(markdown);
  const name = frontmatterScalar(fm, "name") ?? dirName;
  const description =
    frontmatterScalar(fm, "description") ?? firstParagraph(body) ?? name;
  const tools =
    frontmatterList(fm, "allowed-tools") ?? frontmatterList(fm, "tools");
  const argumentHint = frontmatterScalar(fm, "argument-hint");
  const disableModelInvocation =
    frontmatterScalar(fm, "disable-model-invocation") === "true";
  // `context: fork` is a supported skill key (a forked skill runs as a subagent);
  // `"fork"` is the only valid value. Previously it was in SKILL_KNOWN_KEYS but
  // never read, so an existing SKILL.md's `context: fork` was silently dropped on
  // adopt with NO unmapped-key warning (the key was falsely marked "known"). (#107)
  const isFork = frontmatterScalar(fm, "context") === "fork";
  const unmappedKeys = unmappedFrontmatterKeys(fm, SKILL_KNOWN_KEYS);

  const lines = [
    `  name: ${JSON.stringify(name)},`,
    `  description: ${JSON.stringify(description)},`,
  ];
  if (argumentHint)
    lines.push(`  argumentHint: ${JSON.stringify(argumentHint)},`);
  if (isFork) lines.push(`  context: "fork",`);
  if (disableModelInvocation) lines.push(`  disableModelInvocation: true,`);
  if (tools && tools.length > 0)
    lines.push(`  tools: ${JSON.stringify(tools)},`);
  const trimmedBody = body.trim();
  if (trimmedBody) lines.push(`  body: ${tsTemplate(trimmedBody)},`);

  const spec = experimental_skill({
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    ...(isFork ? { context: "fork" as const } : {}),
    ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(trimmedBody ? { body: trimmedBody } : {}),
  });

  const source =
    SURFACE_HEADER(`${dirName}/SKILL.md`) +
    unmappedNote("skill", unmappedKeys) +
    `import { experimental_skill } from "vigiles/spec";\n\n` +
    `export default experimental_skill({\n${lines.join("\n")}\n});\n`;
  return { source, kind: "skill", spec, unmappedKeys };
}

/**
 * Adopt an existing subagent (`agents/<name>.md`) into an `experimental_agent()` spec. Unlike
 * a skill, an agent's `sections` reject `##` headers, so the body is split: the
 * lead preamble becomes `body` and each `##`/`#` heading becomes a named section
 * (reusing the instruction-file splitter). The tool contract is carried as-is —
 * if the source lists a never-available tool, the generated spec surfaces it on
 * `compile` (which is the point).
 *
 * @param markdown the subagent file content
 * @param fileBase the file's base name (sans `.md`) — the fallback for `name`
 */
/** Split a subagent system prompt: preamble → `body`, each `#`/`##` heading →
 * a named section (agent `sections` reject `##` in the body, so they're hoisted). */
function splitAgentBody(body: string): {
  lead: string;
  sectionEntries: { key: string; content: string }[];
} {
  const blocks = splitIntoBlocks(body);
  let lead = "";
  const used = new Set<string>();
  const sectionEntries: { key: string; content: string }[] = [];
  for (const block of blocks) {
    if (block.level === null) {
      lead = block.lines.join("\n").trim();
    } else {
      sectionEntries.push({
        key: allocKey(safeKey(block.heading ?? ""), used),
        content: block.lines.join("\n").trim(),
      });
    }
  }
  return { lead, sectionEntries };
}

interface AgentFields {
  name: string;
  description: string;
  model?: string;
  color?: string;
  tools: string[] | null;
  disallowedTools: string[] | null;
  lead: string;
  sectionEntries: { key: string; content: string }[];
}

/** Render the `experimental_agent({…})` source lines from the extracted fields. */
function buildAgentLines(f: AgentFields): string[] {
  const lines = [
    `  name: ${JSON.stringify(f.name)},`,
    `  description: ${JSON.stringify(f.description)},`,
  ];
  if (f.model) lines.push(`  model: ${JSON.stringify(f.model)},`);
  if (f.color) lines.push(`  color: ${JSON.stringify(f.color)},`);
  if (f.tools && f.tools.length > 0)
    lines.push(`  tools: ${JSON.stringify(f.tools)},`);
  if (f.disallowedTools && f.disallowedTools.length > 0)
    lines.push(`  disallowedTools: ${JSON.stringify(f.disallowedTools)},`);
  if (f.lead) lines.push(`  body: ${tsTemplate(f.lead)},`);
  if (f.sectionEntries.length > 0) {
    const entries = f.sectionEntries
      .map(
        ({ key, content }) =>
          `    ${JSON.stringify(key)}: ${tsTemplate(content)},`,
      )
      .join("\n");
    lines.push(`  sections: {\n${entries}\n  },`);
  }
  return lines;
}

export function adoptAgent(
  markdown: string,
  fileBase: string,
): AdoptSurfaceResult {
  const { fm, body } = splitFrontmatterBody(markdown);
  const name = frontmatterScalar(fm, "name") ?? fileBase;
  const f: AgentFields = {
    name,
    description: frontmatterScalar(fm, "description") ?? name,
    model: frontmatterScalar(fm, "model"),
    color: frontmatterScalar(fm, "color"),
    tools: frontmatterList(fm, "tools"),
    disallowedTools:
      frontmatterList(fm, "disallowedTools") ??
      frontmatterList(fm, "disallowed-tools"),
    ...splitAgentBody(body),
  };
  const unmappedKeys = unmappedFrontmatterKeys(fm, AGENT_KNOWN_KEYS);

  const sections: Record<string, string> = {};
  for (const { key, content } of f.sectionEntries) sections[key] = content;

  const spec = experimental_agent({
    name: f.name,
    description: f.description,
    ...(f.model ? { model: f.model } : {}),
    ...(f.color ? { color: f.color } : {}),
    ...(f.tools && f.tools.length > 0 ? { tools: f.tools } : {}),
    ...(f.disallowedTools && f.disallowedTools.length > 0
      ? { disallowedTools: f.disallowedTools }
      : {}),
    ...(f.lead ? { body: f.lead } : {}),
    ...(f.sectionEntries.length > 0 ? { sections } : {}),
  });

  const source =
    SURFACE_HEADER(`${fileBase}.md`) +
    unmappedNote("agent", unmappedKeys) +
    `import { experimental_agent } from "vigiles/spec";\n\n` +
    `export default experimental_agent({\n${buildAgentLines(f).join("\n")}\n});\n`;
  return { source, kind: "agent", spec, unmappedKeys };
}
