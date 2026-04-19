/**
 * Integrity check: verify a compiled markdown file hasn't been hand-edited.
 *
 * Every compiled file has a SHA-256 hash in its first line:
 *   <!-- vigiles:sha256:<hash> compiled from CLAUDE.md.spec.ts -->
 *
 * If the body content's hash no longer matches what's recorded, someone
 * edited the compiled output directly. The check is one-pass and ~free.
 *
 * This is the entire freshness story now: no input fingerprinting, no
 * recompile diffing. Those responsibilities belong elsewhere:
 *
 * - Hand-edit detection → this module
 * - "Did the spec change?" → guard() rules emitting compile hooks
 * - "Are referenced linter rules / files / scripts still valid?"
 *   → enforce() / file() / cmd() catch this at compile time
 * - "Are committed compiled files actually fresh?"
 *   → CI runs `vigiles compile` then `git diff --exit-code`
 */

import { sha256short } from "./hash.js";

const HASH_LINE_RE =
  /^<!-- vigiles:sha256:([a-f0-9]+) compiled from (.+) -->\r?\n\r?\n?/;

export interface IntegrityResult {
  intact: boolean;
  reason?: string;
}

/**
 * Check whether the compiled markdown's SHA-256 hash matches its body.
 * Files without a hash header are treated as hand-written (intact).
 */
export function checkIntegrity(content: string): IntegrityResult {
  const match = content.match(HASH_LINE_RE);
  if (!match) {
    return { intact: true, reason: "No hash header (hand-written file)" };
  }
  const expectedHash = match[1];
  const body = content.replace(HASH_LINE_RE, "");
  if (sha256short(body) !== expectedHash) {
    return {
      intact: false,
      reason:
        "Compiled file was modified directly — edit the .spec.ts source and recompile",
    };
  }
  return { intact: true };
}
