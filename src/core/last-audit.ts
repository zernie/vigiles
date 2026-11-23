/**
 * When `audit` last ran on this checkout (#475) — the record and the line.
 *
 * `lint` is the gate CI runs; `audit` is the local report a person runs, and
 * the only place the consent-gated checks (live MCP, skill trigger rate, the
 * ESLint catalog) ever run. Nothing reminded anyone to run it again, so the
 * session-start path (`lint --summary`, called by the plugin's
 * `hooks/session-start.sh`) prints one line when the last local audit is older
 * than {@link LAST_AUDIT_STALE_DAYS} days, or when there has been none.
 *
 * WHO STAMPS: only a person's `audit` of this project — not `--json`, not
 * `--md`, not an audit of another directory, and nothing that runs in CI
 * (ci-info), whatever its flags. The line asks "have you looked at the full
 * report lately"; a machine read in CI is not that and runs none of the
 * consent-gated checks. (The Action's capability diff is a plain `audit`, and
 * it stamped until CI was checked by name rather than by flag.)
 *
 * The record is written in prettier's own JSON shape: it sits in the user's
 * tree, and `prettier --check .` does not read the nested `.vigiles/.gitignore`.
 *
 * Pure. The CLI root reads and writes `.vigiles/last-audit.json` (a per-checkout
 * file, kept out of git with the others in `local-files.ts`).
 */
import { z } from "zod";
import { jsonText } from "./json-text.js";

/** Days after which the last audit is old enough to mention. */
export const LAST_AUDIT_STALE_DAYS = 7;

/** What the record says. A broken record is not "no audit yet". */
export type LastAudit =
  | { readonly kind: "never" }
  | { readonly kind: "at"; readonly at: Date }
  | { readonly kind: "unreadable" };

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN = "run npx vigiles audit";

const recordSchema = z.object({ at: z.iso.datetime() });

/** The file's content for an audit that finished at `now`. */
export function lastAuditRecord(now: Readonly<Date>): string {
  return JSON.stringify({ at: now.toISOString() }, null, 2) + "\n";
}

/** Read the record; `undefined` is a file that does not exist. */
export function parseLastAudit(text: string | undefined): LastAudit {
  if (text === undefined) return { kind: "never" };
  const parsed = jsonText.pipe(recordSchema).safeParse(text);
  return parsed.success
    ? { kind: "at", at: new Date(parsed.data.at) }
    : { kind: "unreadable" };
}

/** The one session-start line, or null when the last audit is recent. */
export function lastAuditLine(
  last: LastAudit,
  now: Readonly<Date>,
  staleDays: number = LAST_AUDIT_STALE_DAYS,
): string | null {
  switch (last.kind) {
    case "never":
      return `vigiles: no local audit yet — ${RUN}`;
    case "unreadable":
      return `vigiles: the last-audit record is unreadable — ${RUN}`;
    case "at": {
      const age = now.getTime() - last.at.getTime();
      if (age <= staleDays * DAY_MS) return null;
      return `vigiles: last audit ${String(Math.floor(age / DAY_MS))} days ago — ${RUN}`;
    }
  }
}
