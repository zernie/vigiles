/**
 * The shareable HTML audit report — the prebuilt **Vite + React + shadcn** template
 * (`report/`, built to one self-contained file at `dist/audit-report.template.html`)
 * with the {@link AuditReport} JSON injected. The React app runs in the reader's
 * browser, so the CLI stays runtime-dependency-light and the output is still a
 * single offline file. There is ONE renderer (pure shadcn/Tailwind) — no inline-CSS
 * fallback; the build guarantees the template exists, and if it somehow doesn't the
 * caller skips the HTML (the JSON + terminal report still work).
 *
 * `<`/`>`/`&` are escaped on injection so report text can never break out of the
 * `<script>`. `injectReportData` is the pure, testable core.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditReport } from "./audit-report.js";

const PLACEHOLDER = "__VIGILES_DATA_PLACEHOLDER__";

/**
 * Candidate locations for the built template, relative to this module (`__dirname`
 * is the compiled `dist/` at runtime, or `src/` under vitest). CommonJS output, so
 * we use `__dirname`, not `import.meta`.
 */
export function templatePath(): string | null {
  const candidates = [
    resolve(__dirname, "audit-report.template.html"), // dist/ (shipped)
    resolve(__dirname, "..", "dist", "audit-report.template.html"), // src/ under vitest
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Escape `<`, `>`, `&` so report text can never break out of the `<script>`. */
function escapeForScript(json: string): string {
  return json.replace(
    /[<>&]/g,
    (ch) => "\\u00" + ch.charCodeAt(0).toString(16).padStart(2, "0"),
  );
}

/**
 * Live-server info injected into the report when it's served by `audit --serve`
 * (not a static file): the per-run token the report must send on every adopt
 * POST. Absent for a plain static report — the buttons fall back to copy-command.
 */
export interface ServeInfo {
  readonly token: string;
}

/**
 * Inject the report JSON into a template by replacing the quoted placeholder
 * string with the JSON object literal. Pure — the testable core. Throws if the
 * template is missing the placeholder. When `serve` is given (the `--serve`
 * path), also sets `window.__VIGILES_SERVE__` so the report's adopt buttons POST
 * to the local server instead of copying the command.
 */
export function injectReportData(
  template: string,
  report: AuditReport,
  serve?: ServeInfo,
): string {
  const re = new RegExp(`(["'])${PLACEHOLDER}\\1`);
  if (!re.test(template)) {
    throw new Error("audit report template is missing the data placeholder");
  }
  // Every replacement goes through a function: a replacement STRING reads `$1`,
  // `$&`, `$'` and the like as patterns, and report text quotes files that say
  // "$120/h". A function's return value is used verbatim.
  const data = escapeForScript(JSON.stringify(report));
  let out = template.replace(re, () => data);
  if (serve) {
    // Prepend the serve global onto the same statement that carries the data, so
    // it's set before the app bundle reads it. The token is hex, but escape anyway.
    const prefix = `window.__VIGILES_SERVE__=${escapeForScript(JSON.stringify(serve))};`;
    out = out.replace(
      "window.__VIGILES_DATA__",
      () => `${prefix}window.__VIGILES_DATA__`,
    );
  }
  return out;
}

/**
 * Render the self-contained HTML report (React template + injected data). Throws
 * if the template hasn't been built — the caller (writeAuditHtml) catches that and
 * skips the HTML, since the JSON + terminal report don't depend on it. Pass
 * `serve` to render the live (`--serve`) variant whose buttons POST.
 */
export function renderAuditHtml(
  report: AuditReport,
  serve?: ServeInfo,
): string {
  const p = templatePath();
  if (!p) {
    throw new Error(
      "audit report template not built — run `npm run build` (builds report/), or use --json / --no-html",
    );
  }
  return injectReportData(readFileSync(p, "utf-8"), report, serve);
}
