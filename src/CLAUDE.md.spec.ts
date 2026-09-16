/**
 * Directory-scoped guidance for working in `src/` (the CLI + core).
 *
 * The full project rule set is the ROOT `CLAUDE.md` (compiled from
 * `CLAUDE.md.spec.ts`). This nested spec adds only the CLI-surface discipline
 * that belongs next to the code that defines it — Claude Code loads it as
 * directory memory whenever you work in `src/`. Source of truth; `src/CLAUDE.md`
 * is a compiled build artifact (`vigiles compile`).
 */
import { instructionFile, guidance } from "./core/spec.js";

export default instructionFile({
  sections: {
    scope: `Working in \`src/\`? The root \`CLAUDE.md\` holds the full positioning, architecture, and rule set — read it first. This file adds the discipline specific to the CLI surface (\`src/cli.ts\`, \`src/cli-main.ts\`, \`src/cli-commands.ts\`): keep the command set small and cohesive.`,
  },

  keyFiles: {
    "src/cli.ts":
      "The bin — a DISPATCHER SHIM with NO top-level imports (#216), so a hook decision never pays for the verb barrel. The emitted hook-runtime command must stay byte-stable.",
    "src/hook-runtime.ts":
      "The compiled-hook RUNTIME — stdin event, stamp check, dispatch by role. Kept OUT of the verb barrel so a decision loads only what it needs; three lazy edges carry their measurement.",
    "src/cli-main.ts":
      "The VERB barrel — the single source of truth for what each verb does. Loaded lazily by src/cli.ts for everything that is not a hook decision.",
    "src/cli-commands.ts":
      "The canonical VERBS + HOOK_RUNTIME_KINDS list (the self-command-refs moat)",
  },

  rules: {
    "high-bar-for-new-commands": guidance(
      "Adding a new CLI verb (or `hook-runtime` subcommand) is a LAST resort, not a reflex. vigiles is ONE cohesive organism with FEW human verbs (see the `cohesive-cli-surface` rule in the root spec): every new command widens the surface the CLI, the GitHub Action, and the docs must all track in lockstep. A new command must clear a HIGH BAR — (1) it is a genuinely NEW mental action no existing verb owns; if it is a variant of an action a verb already does, add a FLAG to that verb instead; (2) it does NOT overlap an existing command's job — two doors to one room is the smell; (3) related siblings collapse into ONE verb with a subcommand, not N hyphenated verbs; (4) a runtime entrypoint stays hidden under `hook-runtime`, never a public verb. DEFAULT to extending an existing verb with a flag; spawning a sibling verb is the exception you must justify out loud. When in doubt, don't add the verb — and prefer removing or merging an overlapping one.",
    ),
  },
});
