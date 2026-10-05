/**
 * Writes the start-of-session check described in `src/hook-check.ts` and adds its
 * entry to each harness's settings. `vigiles compile` calls this once, after it
 * has merged the hooks.
 *
 * The list of files comes from the settings as they are now, not from the hooks
 * this run compiled. So compiling one hook does not make the check forget the
 * others, and compiling twice changes nothing. The entry is found again by the
 * script's path, so a recompile replaces it in place and leaves any
 * `SessionStart` hook the user wrote alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HarnessAdapter } from "./core/adapter.js";
import {
  HOOK_CHECK_REF,
  checkPaths,
  commandsIn,
  renderHookCheck,
} from "./hook-check.js";
import { hookGateRef } from "./hook-install.js";

/** A harness whose hooks are shell commands listed in a settings file. */
type ShellAdapter = Extract<HarnessAdapter, { readonly shellHooks: true }>;

function isShellAdapter(adapter: HarnessAdapter): adapter is ShellAdapter {
  return adapter.shellHooks;
}

/** One harness's settings as a plain object, or `undefined` if the file does not exist yet. */
function readSettings(
  adapter: ShellAdapter,
  cwd: string,
): Record<string, unknown> | undefined {
  const file = resolve(cwd, adapter.layout.settingsPath);
  return existsSync(file)
    ? adapter.layout.settings.parse(readFileSync(file, "utf-8"))
    : undefined;
}

/** Add the check's `SessionStart` entry to one harness's settings, or replace it where it already is. */
function registerCheck(
  adapter: ShellAdapter,
  existing: Record<string, unknown>,
  cwd: string,
): void {
  const ref = hookGateRef(HOOK_CHECK_REF, adapter.layout.projectRootTokens);
  const merged = adapter.hookProtocol.mergeRegistrations(
    existing,
    {
      SessionStart: [
        { hooks: [{ type: "command", command: `sh ${ref} || exit 0` }] },
      ],
    },
    HOOK_CHECK_REF,
  );
  writeFileSync(
    resolve(cwd, adapter.layout.settingsPath),
    adapter.layout.settings.render(merged),
  );
}

export function installHookCheck(
  adapters: readonly HarnessAdapter[],
  cwd: string = process.cwd(),
): void {
  const found = adapters.filter(isShellAdapter).flatMap((adapter) => {
    const settings = readSettings(adapter, cwd);
    return settings === undefined ? [] : [{ adapter, settings }];
  });
  const { paths, unsafe } = checkPaths(
    found.flatMap((f) => commandsIn(f.settings.hooks)),
  );
  for (const path of unsafe) {
    console.warn(
      `⚠ hook-check: ${path} has characters the check cannot quote safely, so it is NOT covered.`,
    );
  }
  if (paths.length === 0) return;

  const script = resolve(cwd, HOOK_CHECK_REF);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, renderHookCheck(paths));
  for (const { adapter, settings } of found)
    registerCheck(adapter, settings, cwd);
  console.log(
    `✓ ${HOOK_CHECK_REF} → SessionStart notice for ${paths.length} wired hook file(s)`,
  );
}
