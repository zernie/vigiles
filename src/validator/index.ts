import * as fs from "node:fs";
import * as path from "node:path";

export interface RuleEntry {
  title: string;
  line: number;
  enforcement: "enforced" | "guidance" | "missing";
  enforcedBy?: string;
}

export interface ValidationResult {
  rules: RuleEntry[];
  enforced: number;
  guidanceOnly: number;
  missing: number;
  total: number;
  valid: boolean;
}

export interface ValidateOptions {
  claudeMdPath?: string;
  checkEslintRules?: boolean;
  projectRoot?: string;
}

const ENFORCED_BY_RE = /\*\*Enforced by:\*\*\s*`([^`]+)`/;
const GUIDANCE_RE = /\*\*Guidance only\*\*/;

function parseClaudeMd(content: string): RuleEntry[] {
  const lines = content.split("\n");
  const rules: RuleEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^###\s+(.+)$/);
    if (!headerMatch) continue;

    const title = headerMatch[1].trim();
    const lineNumber = i + 1;

    // Look ahead in the next lines for enforcement annotations
    let enforcement: RuleEntry["enforcement"] = "missing";
    let enforcedBy: string | undefined;

    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      // Stop if we hit another header
      if (/^###\s+/.test(lines[j])) break;

      const enforcedMatch = lines[j].match(ENFORCED_BY_RE);
      if (enforcedMatch) {
        enforcement = "enforced";
        enforcedBy = enforcedMatch[1];
        break;
      }

      if (GUIDANCE_RE.test(lines[j])) {
        enforcement = "guidance";
        break;
      }
    }

    rules.push({ title, line: lineNumber, enforcement, enforcedBy });
  }

  return rules;
}

export function validate(options: ValidateOptions = {}): ValidationResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const claudeMdPath = options.claudeMdPath ?? path.join(projectRoot, "CLAUDE.md");

  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found at ${claudeMdPath}`);
  }

  const content = fs.readFileSync(claudeMdPath, "utf-8");
  const rules = parseClaudeMd(content);

  const enforced = rules.filter((r) => r.enforcement === "enforced").length;
  const guidanceOnly = rules.filter((r) => r.enforcement === "guidance").length;
  const missing = rules.filter((r) => r.enforcement === "missing").length;

  return {
    rules,
    enforced,
    guidanceOnly,
    missing,
    total: rules.length,
    valid: missing === 0,
  };
}
