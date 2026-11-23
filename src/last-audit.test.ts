/**
 * The "last audit N days ago" record (#475): `audit` stamps a local file under
 * `.vigiles/`, and `lint --summary` (the session-start path) turns it into one
 * line when it is old or missing. The decision is pure over (record, now); the
 * read and write are exercised against a temp directory.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LAST_AUDIT_STALE_DAYS,
  lastAuditLine,
  readLastAudit,
  recordAuditRun,
} from "./last-audit.js";
import { LAST_AUDIT_FILE, VIGILES_DIR } from "./local-files.js";

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

describe("recordAuditRun / readLastAudit", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads back what it wrote", () => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-last-audit-"));
    recordAuditRun(dir, ago(2));
    expect(readLastAudit(dir)).toEqual({ kind: "at", at: ago(2) });
  });

  it("keeps the record out of git", () => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-last-audit-"));
    recordAuditRun(dir, NOW);
    const ignore = readFileSync(join(dir, VIGILES_DIR, ".gitignore"), "utf-8");
    expect(ignore.split("\n")).toContain(`/${LAST_AUDIT_FILE}`);
  });

  it("no file is 'never'; a broken file is 'unreadable'", () => {
    dir = mkdtempSync(join(tmpdir(), "vigiles-last-audit-"));
    expect(readLastAudit(dir)).toEqual({ kind: "never" });
    mkdirSync(join(dir, VIGILES_DIR), { recursive: true });
    writeFileSync(join(dir, VIGILES_DIR, LAST_AUDIT_FILE), "{ not json");
    expect(readLastAudit(dir)).toEqual({ kind: "unreadable" });
    writeFileSync(
      join(dir, VIGILES_DIR, LAST_AUDIT_FILE),
      JSON.stringify({ at: "not a date" }),
    );
    expect(readLastAudit(dir)).toEqual({ kind: "unreadable" });
  });
});
