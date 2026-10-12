/**
 * SPIKE (plugin-compiled-hooks): let a hook program that lives OUTSIDE any
 * `node_modules` reach — a Claude Code plugin's `hooks/x.hook.ts`, installed
 * under `~/.claude/plugins/…` with no `node_modules` of its own — import
 * `vigiles/hook` from the runtime that is executing it.
 *
 * Measured on Node 22.22.2: without this, `import … from "vigiles/hook"` in
 * `${CLAUDE_PLUGIN_ROOT}/hooks/pre-edit.hook.mjs` fails with
 * `Cannot find package 'vigiles'` — ESM resolution walks up from the PROGRAM's
 * directory, never from the process that loads it, and `NODE_PATH` is ignored
 * by ESM.
 *
 * Same contract as `self-resolve.mts` (the rescue the spec host and harness
 * scripts register): normal resolution first, the rescue only on the way out of
 * a failure, and only for `vigiles` / `vigiles/*`. A program that CAN see a
 * vigiles of its own keeps it. Resolved through this package's own `exports`
 * map (Node's self-reference), so `vigiles/nope` still fails as the author's
 * typo, not as ours.
 *
 * `module.registerHooks` (Node >= 22.15 / 23.5) runs IN-THREAD and synchronous,
 * which is why it is used: `module.register` starts a loader worker, a cost
 * every gated tool call would pay. On a Node without it this is a no-op and the
 * program resolves (or not) exactly as before. NOT MEASURED on Node < 22.15.
 */
import { createRequire } from "node:module";

type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type ResolveFn = (
  specifier: string,
  context: unknown,
  next: (specifier: string, context?: unknown) => Resolved,
) => Resolved;
type ModuleWithHooks = {
  registerHooks?: (hooks: { resolve: ResolveFn }) => unknown;
};

let registered = false;

export function registerSelfResolve(): void {
  if (registered) return;
  registered = true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: only the run-program path pays for it
  const mod = require("node:module") as ModuleWithHooks;
  if (typeof mod.registerHooks !== "function") return;
  const self = createRequire(__filename);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  mod.registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        if (specifier !== "vigiles" && !specifier.startsWith("vigiles/"))
          throw err;
        let file: string;
        try {
          file = self.resolve(specifier);
        } catch {
          throw err;
        }
        return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    },
  });
}
