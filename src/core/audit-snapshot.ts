/**
 * The few fields of a saved `audit --json` report that a comparison reads —
 * parsed with a schema, never cast. Used by `audit --md --compare=<base.json>`
 * (#474), where the base report comes from another process (the GitHub Action
 * audits the PR base and hands the file over).
 *
 * Harness- and version-agnostic on purpose: which schema version and which ring
 * names count is the caller's decision (`src/audit-pr-summary.ts`), so this
 * module names neither.
 */
import { z } from "zod";
import { jsonText } from "./json-text.js";

const snapshotSchema = z.object({
  meta: z.object({ kind: z.string(), schemaVersion: z.number() }),
  score: z.object({
    overall: z.number(),
    grade: z.string(),
    empty: z.boolean(),
    categories: z.array(
      z.object({ key: z.string(), score: z.number().nullable() }),
    ),
  }),
});

/** What a comparison reads off a saved report. */
export type AuditSnapshot = z.infer<typeof snapshotSchema>;

/** Why a text is not a snapshot: not JSON at all, or JSON of another shape. */
export type SnapshotResult =
  | { readonly kind: "snapshot"; readonly snapshot: AuditSnapshot }
  | { readonly kind: "not-json" }
  | { readonly kind: "wrong-shape" };

/** Parse `audit --json` output into the fields a comparison reads. */
export function parseAuditSnapshot(text: string): SnapshotResult {
  const json = jsonText.safeParse(text);
  if (!json.success) return { kind: "not-json" };
  const snap = snapshotSchema.safeParse(json.data);
  return snap.success
    ? { kind: "snapshot", snapshot: snap.data }
    : { kind: "wrong-shape" };
}
