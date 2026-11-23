/**
 * What `audit` prints and what it compares with, read from argv. Pure.
 *
 * ONE `--format=` picks stdout's format, the way Lighthouse's `--output`,
 * ESLint's `--format` and Trivy's `--format` do; `--json` and `--md` stay as
 * the aliases they were. Two formats asked at once is a contradiction, refused
 * with exit 2 — honouring one and dropping the other is the silently-ignored
 * flag this CLI refuses everywhere else. HTML is not a format: it is a report
 * FILE `audit` writes (`--no-html`), beside whatever stdout carries.
 *
 * `--compare` (bare) asks the CLI to find the base itself, the way
 * `test --changed` does (`core/changed-base.ts`); `--compare=<ref>` names it.
 * Neither is a path: the CLI copies the base out of git (#474), so the GitHub
 * Action decides nothing.
 */

/** What `audit` prints on stdout. */
export type AuditFormat = "text" | "json" | "md";

const FORMATS: readonly AuditFormat[] = ["text", "json", "md"];

export type AuditFormatParse =
  | { readonly kind: "ok"; readonly format: AuditFormat }
  | { readonly kind: "refused"; readonly message: string };

const isFormat = (s: string): s is AuditFormat => FORMATS.some((f) => f === s);

/** The format each format-picking argument asks for, in argv order. */
function asked(args: readonly string[]): readonly string[] {
  return args.flatMap((a) => {
    if (a === "--json") return ["json"];
    if (a === "--md") return ["md"];
    return a.startsWith("--format=") ? [a.slice("--format=".length)] : [];
  });
}

/** `--format=` / `--json` / `--md`, or why the combination is refused. */
export function parseAuditFormat(args: readonly string[]): AuditFormatParse {
  const wanted = [...new Set(asked(args))];
  const unknown = wanted.filter((w) => !isFormat(w));
  if (unknown.length > 0)
    return {
      kind: "refused",
      message: `--format=${unknown[0] ?? ""}: not a format. Pick one of ${FORMATS.join(", ")}.`,
    };
  const formats = wanted.filter(isFormat);
  if (formats.length > 1)
    return {
      kind: "refused",
      message:
        `--format: one output at a time, but ${formats.join(" and ")} were asked ` +
        `(--json is --format=json, --md is --format=md).`,
    };
  return { kind: "ok", format: formats[0] ?? "text" };
}

/** What `--compare` asked for. */
export type CompareRequest =
  | { readonly kind: "none" }
  /** Bare `--compare`: the CLI decides the base (`core/changed-base.ts`). */
  | { readonly kind: "decide" }
  | { readonly kind: "ref"; readonly ref: string };

export function parseCompareRequest(args: readonly string[]): CompareRequest {
  const arg = args.find((a) => a === "--compare" || a.startsWith("--compare="));
  if (arg === undefined) return { kind: "none" };
  const ref = arg.slice("--compare=".length);
  return arg === "--compare" || ref === ""
    ? { kind: "decide" }
    : { kind: "ref", ref };
}
