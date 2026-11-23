/**
 * Claude Code's request-body channel — what the eval's per-trial context check
 * reads to see whether the project's instruction files reached the model
 * (vigiles#416).
 *
 * The channel, measured on Claude Code 2.1.330 with the mock model
 * (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_LOG_RAW_API_BODIES=file:<dir>`): the
 * client writes every API request as `<uuid>.request.json` plus an `index.jsonl`
 * that lists them in order. With the three `OTEL_*_EXPORTER=none` the run
 * exports nothing — a listener on `OTEL_EXPORTER_OTLP_ENDPOINT` received zero
 * requests — so the bodies (the whole prompt) never leave the machine. Setting
 * the exporters explicitly also overrides an `otlp` exporter a user's own
 * environment carries into an `inherit` run.
 *
 * It is the one channel that sees both `CLAUDE.md` and a lone `AGENTS.md`: the
 * `InstructionsLoaded` hook stays silent on the second, and `system/init` names
 * neither.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestCapture, RequestChannel } from "../../core/runtime.js";
import { claudeCodeLayout } from "./layout.js";

/** Every string inside a JSON value, depth-first — the request as decoded text. */
function strings(v: unknown): readonly string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v !== null && typeof v === "object")
    return Object.values(v).flatMap(strings);
  return [];
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

const readJson = (path: string): unknown =>
  existsSync(path) ? parseJson(readFileSync(path, "utf-8")) : undefined;

/** The request files `index.jsonl` lists, in the order the client sent them. */
function requestFiles(dir: string): readonly string[] {
  const index = join(dir, "index.jsonl");
  if (!existsSync(index)) return [];
  return readFileSync(index, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      const entry = parseJson(l);
      const file =
        entry !== null && typeof entry === "object" && "request_file" in entry
          ? entry.request_file
          : undefined;
      return typeof file === "string" ? [file] : [];
    });
}

/**
 * The agent loop's request declares tools; a side-channel request (the
 * notification classifier, a title) does not. Same criterion as the mock
 * model's `isMainLoopRequest`.
 */
const declaresTools = (body: unknown): boolean =>
  body !== null &&
  typeof body === "object" &&
  "tools" in body &&
  Array.isArray(body.tools) &&
  body.tools.length > 0;

/** The first agent-loop request under `dir` (else the first one), as text. */
export function firstClaudeRequest(dir: string): string | undefined {
  const bodies = requestFiles(dir)
    .map((f) => readJson(join(dir, f)))
    .filter((b) => b !== undefined);
  const first = bodies.find(declaresTools) ?? bodies[0];
  return first === undefined ? undefined : strings(first).join("\n\u0000\n");
}

/** The env that writes each request under `dir` and exports nothing. */
export function captureEnv(dir: string): Readonly<Record<string, string>> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
    OTEL_LOGS_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
  };
}

/**
 * One run's channel: a fresh directory under the system temp dir, BESIDE the
 * trial's work dir and never in it, so no cache snapshot can carry a body.
 */
function openChannel(): RequestChannel {
  const dir = mkdtempSync(join(tmpdir(), "vigiles-requests-"));
  return {
    env: captureEnv(dir),
    reset: () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    },
    firstRequest: () => firstClaudeRequest(dir),
    close: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const claudeCodeRequestCapture: RequestCapture = {
  layout: claudeCodeLayout,
  open: openChannel,
};
