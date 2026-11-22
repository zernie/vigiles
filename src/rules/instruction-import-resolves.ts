/**
 * `instruction-import-resolves` — an `@path` import in an instruction file the
 * harness loads (`CLAUDE.md`, `AGENTS.md`, a rules file) names a file that is
 * not in the repository: the harness tries to load it and gets nothing.
 * Reported where it is written — the file and the 1-based line of the token —
 * by `lint` and `audit` alike.
 *
 * The DETECTOR is core's `unresolvedImports`, run once by each scan engine over
 * the ADAPTER's resolved import paths (`InstructionChain.imports`), so the
 * harness decides what is a pointer and what it is relative to; this module is
 * the POLICY around it. `external-decidable`: whether the path exists is a fact
 * of the file system. A file that exists only under another letter case is its
 * own finding — it opens on macOS and fails on Linux and in CI — and so is a
 * name that is there but is not a file (a directory, a dangling symlink).
 *
 * In the `structural` group at `warn`, scored in Truthfulness from the scan's
 * `instructionImportIssues` — the COMMITTED view's (a teammate's checkout): an
 * import in one machine's file is reported and never scored, and one in a
 * committed file this copy does not load is scored and not reported here. See docs/rules/instruction-import-resolves.md.
 */
import { defineRule, type Finding, type ScanInput } from "../core/rule.js";
import {
  isScoredImport,
  isShownImport,
  type UnresolvedImport,
} from "../core/instruction-imports.js";

/** What is wrong with one import, in the words a report prints. */
function messageOf(issue: UnresolvedImport): string {
  switch (issue.resolution.kind) {
    case "missing":
      return `imports ${issue.path}, which does not exist — the harness loads nothing for it.`;
    case "case-mismatch":
      return `imports ${issue.path}, but the file is ${issue.resolution.actual} — it loads on a case-insensitive file system (macOS) and not on Linux or in CI.`;
    case "not-a-file":
      return issue.resolution.is === "dir"
        ? `imports ${issue.path}, which is a directory, not a file — the harness loads nothing for it.`
        : `imports ${issue.path}, which is not a readable file (a broken symlink, or a special file) — the harness loads nothing for it.`;
  }
}

/** Every unresolved import, located at the line its token is written on. */
function findings(scan: ScanInput): readonly Finding[] {
  return scan.instructionImportIssues.filter(isShownImport).map(
    (issue): Finding => ({
      kind: "finding",
      path: issue.from,
      line: issue.line,
      subject: issue.token,
      message: messageOf(issue),
    }),
  );
}

export const instructionImportResolves = defineRule({
  id: "instruction-import-resolves",
  group: "structural",
  bucket: "external-decidable",
  surface: ["instruction"],
  defaultSeverity: "warn",
  cure: "edit",
  summary:
    "An @path import in a loaded instruction file names a file that exists, in the same letter case.",
  detector: "unresolvedImports",
  scored: {
    // Scored from the COMMITTED view where it fires (`isScoredImport`): a
    // gitignored file can neither add a deduction (an import in
    // `CLAUDE.local.md`) nor remove one (a `CLAUDE.local.md` that stops this
    // copy reading `AGENTS.md`). `findings` reads this copy's view instead.
    narrow: (scan, firesAt) => ({
      instructionImportIssues: scan.instructionImportIssues.filter(
        (issue) => isScoredImport(issue) && firesAt(issue.from),
      ),
    }),
  },
  findings,
});
