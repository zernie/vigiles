import { useState } from "react";
import { Check, Copy, FilePlus2, Loader2, X } from "lucide-react";
import type { Adoptable } from "../schema";
import { TEXT } from "../lib/band";
import { cn } from "../lib/utils";

/**
 * Adoption affordances. The report ships two ways:
 *
 *  - STATIC file (the default): a browser can't write your repo, so the buttons
 *    COPY the exact `npx vigiles init …` command for you to paste.
 *  - LIVE (`audit --serve`): the report is served by a local server, so a button
 *    click POSTs to it and the CLI runs `init` for you. Detected via the
 *    `window.__VIGILES_SERVE__` token the server injects.
 *
 * Same component, two behaviours — keyed off whether a serve token is present.
 */
interface ServeInfo {
  token: string;
}
function serveInfo(): ServeInfo | null {
  const s = (window as unknown as { __VIGILES_SERVE__?: ServeInfo })
    .__VIGILES_SERVE__;
  return s && typeof s.token === "string" ? s : null;
}

async function postAdopt(
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vigiles-token": token },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean; message?: string };
    return { ok: data.ok ?? res.ok, message: data.message ?? "" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const BTN =
  "inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-left text-sm font-medium hover:border-foreground disabled:opacity-60";

/** STATIC mode: copy the command to the clipboard. */
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy: ${command}`}
      className={BTN}
    >
      {copied ? (
        <Check size={14} className={TEXT["good"]} />
      ) : (
        <Copy size={14} className="text-muted-foreground" />
      )}
      <span className={cn(copied && TEXT["good"])}>
        {copied ? "copied!" : label}
      </span>
    </button>
  );
}

type LiveState = "idle" | "running" | "done" | "error";

/** LIVE mode: POST to the local server, which runs `init`. */
function LiveButton({
  endpoint,
  body,
  token,
  label,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  token: string;
  label: string;
}) {
  const [state, setState] = useState<LiveState>("idle");
  const [msg, setMsg] = useState("");
  const run = (): void => {
    setState("running");
    void postAdopt(endpoint, body, token).then((r) => {
      setState(r.ok ? "done" : "error");
      setMsg(r.message);
    });
  };
  return (
    <button
      type="button"
      onClick={run}
      disabled={state === "running" || state === "done"}
      title={state === "error" ? msg : label}
      className={BTN}
    >
      {state === "running" && (
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
      )}
      {state === "done" && <Check size={14} className={TEXT["good"]} />}
      {state === "error" && <X size={14} className={TEXT["bad"]} />}
      {state === "idle" && (
        <FilePlus2 size={14} className="text-muted-foreground" />
      )}
      <span
        className={cn(
          state === "done" && TEXT["good"],
          state === "error" && TEXT["bad"],
        )}
      >
        {state === "done"
          ? "created"
          : state === "error"
            ? "failed"
            : state === "running"
              ? "creating…"
              : label}
      </span>
    </button>
  );
}

function SurfaceRow({ path, command }: { path: string; command: string }) {
  const serve = serveInfo();
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border py-3">
      <code className="min-w-0 break-all font-mono text-sm text-foreground">
        {path}
      </code>
      <div className="ml-auto">
        {serve ? (
          <LiveButton
            endpoint="/adopt"
            body={{ target: path }}
            token={serve.token}
            label="Create spec"
          />
        ) : (
          <CopyCommand command={command} label="Create spec" />
        )}
      </div>
    </li>
  );
}

/**
 * The "adoptable surfaces" section — surfaces that exist but aren't spec-managed
 * yet. A header "Create all specs" affordance + one per surface. Live (POST) when
 * served by `audit --serve`; copy-the-command otherwise.
 */
export function Adopt({ data }: { data: Adoptable }) {
  const serve = serveInfo();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <FilePlus2 size={16} className="text-muted-foreground" aria-hidden />
          {data.surfaces.length} surface
          {data.surfaces.length === 1 ? "" : "s"} not yet spec-managed
        </div>
        <div className="ml-auto">
          {serve ? (
            <LiveButton
              endpoint="/adopt-all"
              body={{}}
              token={serve.token}
              label="Create all specs"
            />
          ) : (
            <CopyCommand
              command={data.createAllCommand}
              label="Create all specs"
            />
          )}
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {serve
          ? "Click to create the typed spec — this report is live, so the CLI writes it for you (re-run audit to see it spec-managed)."
          : "Copy the command and run it in your terminal — the CLI writes the typed spec (the browser can’t write files)."}
      </p>
      {data.surfaces.length > 0 && (
        <ul className="mt-4">
          {data.surfaces.map((s) => (
            <SurfaceRow key={s.path} path={s.path} command={s.command} />
          ))}
        </ul>
      )}
    </div>
  );
}
