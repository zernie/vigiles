/**
 * The "last audit N days ago" record (#475): `audit` stamps a local file under
 * `.vigiles/`, and `lint --summary` (the session-start path) turns it into one
 * line when it is old or missing. Pure over (record text, now); the CLI's read
 * and write are covered in `src/cli-audit-summary.test.ts`.
 */
import { format } from "prettier";
import { describe, it, expect } from "vitest";
import {
  LAST_AUDIT_STALE_DAYS,
  lastAuditLine,
  lastAuditRecord,
  parseLastAudit,
} from "./last-audit.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe("lastAuditLine", () => {
  it("is silent while the last audit is recent", () => {
    expect(lastAuditLine({ kind: "at", at: ago(1) }, NOW)).toBeNull();
    expect(
      lastAuditLine({ kind: "at", at: ago(LAST_AUDIT_STALE_DAYS - 1) }, NOW),
    ).toBeNull();
  });

  it("names the age once the last audit is older than the limit", () => {
    expect(lastAuditLine({ kind: "at", at: ago(9) }, NOW)).toBe(
      "vigiles: last audit 9 days ago — run npx vigiles audit",
    );
  });

  it("says no audit has run here yet when there is no record", () => {
    expect(lastAuditLine({ kind: "never" }, NOW)).toBe(
      "vigiles: no local audit yet — run npx vigiles audit",
    );
  });

  it("does not claim 'no audit yet' over a record it could not read", () => {
    const line = lastAuditLine({ kind: "unreadable" }, NOW);
    expect(line).not.toBeNull();
    expect(line).not.toContain("no local audit yet");
    expect(line).toContain("npx vigiles audit");
  });

  it("a record from the future (a skewed clock) counts as recent", () => {
    expect(lastAuditLine({ kind: "at", at: ago(-3) }, NOW)).toBeNull();
  });
});

describe("lastAuditRecord / parseLastAudit", () => {
  // The record sits in the user's tree, where `prettier --check .` reads it
  // (prettier ignores the nested `.vigiles/.gitignore`): it must already be in
  // prettier's shape, or a local audit turns the user's format check red.
  it("is written exactly as prettier formats it", async () => {
    const text = lastAuditRecord(ago(2));
    expect(await format(text, { parser: "json" })).toBe(text);
  });

  it("reads back what it wrote", () => {
    expect(parseLastAudit(lastAuditRecord(ago(2)))).toEqual({
      kind: "at",
      at: ago(2),
    });
  });

  it("no file is 'never'; a broken file is 'unreadable'", () => {
    expect(parseLastAudit(undefined)).toEqual({ kind: "never" });
    expect(parseLastAudit("{ not json")).toEqual({ kind: "unreadable" });
    expect(parseLastAudit(JSON.stringify({ at: "not a date" }))).toEqual({
      kind: "unreadable",
    });
  });
});
