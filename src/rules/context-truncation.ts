/**
 * `context-truncation` — an instruction file the harness loads AFTER launch
 * (a folder's own `CLAUDE.md`, a folder `AGENTS.md` with no `CLAUDE.md`
 * beside it, a `paths:` rule, a rule in a folder's own rules dir) is longer
 * than the harness delivers: Claude Code cuts it past a per-file limit, so the
 * rules after the cut never reach the model.
 *
 * The DETECTOR is core's `checkOnDemandFiles` over the adapter's instruction
 * chain (`src/core/on-demand-limits.ts`); `lint` and `audit` both run it. This
 * module is the POLICY: `external-decidable` (the file's length against the
 * harness's own number), `error` by default because a cut file loses rules,
 * and no baseline, since recording a size would accept the loss.
 *
 * `limit` replaces the adapter's cut (150,000 characters on Claude Code, the
 * cut on the 1M window its default models run). A repository whose sessions
 * run on a 200K window sets 40000. A threshold, not a second rule: one rule
 * has one severity, and the number is the repository's to set, as ESLint's
 * `max-lines` takes `max`. See docs/rules/context-truncation.md.
 */
import { z } from "zod";

import { defineRule } from "../core/rule.js";

/** `limit`: the per-file cut, in the harness's unit; a positive integer. */
export const onDemandLimitOptions = z
  .object({ limit: z.number().int().positive().optional() })
  .strict();

export const contextTruncation = defineRule({
  id: "context-truncation",
  group: "structural",
  bucket: "external-decidable",
  surface: ["instruction"],
  defaultSeverity: "error",
  cure: "edit",
  summary:
    "An instruction file the harness loads after launch (a folder's CLAUDE.md, a path-scoped or folder rule) fits the harness's per-file cut.",
  detector: "checkOnDemandFiles",
  options: onDemandLimitOptions,
});
