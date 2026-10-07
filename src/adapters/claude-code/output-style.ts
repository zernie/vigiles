/**
 * How Claude Code keeps output styles and switches one on. Every rule here was
 * measured on Claude Code 2.1.291; the tests beside this file hold the cases.
 */
import { basename } from "node:path";

// `yaml` is the lazy loader: this module hangs off the layout, which is on the
// hook path, so a top-level `js-yaml` import would load into every hook decision.
import {
  frontmatterBody,
  readFrontmatter,
  yaml,
} from "../../core/frontmatter-read.js";
import type { ModelRequest } from "../../core/harness-driver.js";
import type { OutputStyle, OutputStyleRules } from "../../core/output-style.js";

/** Claude Code puts this line, then the body, into the first user message. */
const HEADER = "# Output Style: ";

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** YAML as Claude Code reads it: the core schema, and a repeated key keeps the last value. */
const parse = (block: string): Readonly<Record<string, unknown>> | null => {
  try {
    const { CORE_SCHEMA, load } = yaml();
    const value: unknown = load(block, { schema: CORE_SCHEMA, json: true });
    if (value === null || value === undefined) return {};
    return isRecord(value) ? value : null;
  } catch (e) {
    if (e instanceof yaml().YAMLException) return null;
    throw e;
  }
};

/** `name: Status: Block` is not YAML, but Claude Code takes the rest of the line. */
const quoteColonValues = (block: string): string =>
  block
    .split("\n")
    .map((line) => {
      const m = /^([A-Za-z0-9_-]+): (.*)$/.exec(line.replace(/\r$/, ""));
      if (m === null) return line;
      const [, key = "", value = ""] = m;
      const needsQuotes = /: |:$/.test(value) && !/^["'[{|>]/.test(value);
      return needsQuotes ? `${key}: ${JSON.stringify(value)}` : line;
    })
    .join("\n");

const readBlock = (block: string): Readonly<Record<string, unknown>> | null =>
  parse(block) ?? parse(quoteColonValues(block));

/** A declared name if there is one, else the file name; null when unknowable. */
const nameFrom = (text: string, stem: string): string | null => {
  const { block } = readFrontmatter(text);
  if (block === null) return stem;
  const data = readBlock(block);
  if (data === null) return null;
  const name = data["name"];
  if (typeof name === "string") return name === "" ? stem : name;
  if (typeof name === "number" || typeof name === "boolean")
    return String(name);
  return name === null || name === undefined ? stem : null;
};

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

const read = (path: string, text: string): OutputStyle => ({
  path,
  name: nameFrom(text, basename(path).replace(/\.md$/, "")),
  body: frontmatterBody(text).trim(),
});

/** The header and the whole body, in the system prompt or in any message. */
const reached = (style: OutputStyle, request: ModelRequest): boolean => {
  if (style.name === null) return false;
  const probe = squash(`${HEADER}${style.name}\n${style.body}`);
  return [request.system, ...request.messages.map((m) => m.text)].some((text) =>
    squash(text).includes(probe),
  );
};

export const claudeCodeOutputStyles: OutputStyleRules = {
  dir: "output-styles",
  isStyleFile: (pathInDir) => pathInDir.endsWith(".md"),
  read,
  select: (name) => ({ outputStyle: name }),
  // A user-wide `outputStyle` in `~/.claude/settings.json` loads in every
  // project; the project's own `default` wins over it (measured on 2.1.292).
  selectNone: { outputStyle: "default" },
  reached,
};
