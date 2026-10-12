<!-- vigiles:sha256:8f6c6435dc55a17c compiled from src/CLAUDE.md.spec.ts -->

# CLAUDE.md

## Scope

Working in `src/`? The root `CLAUDE.md` holds the full positioning, architecture, and rule set — read it first. This file adds the discipline specific to the CLI surface (`src/cli.ts`, `src/cli-main.ts`, `src/cli-commands.ts`): keep the command set small and cohesive. A new walk over the user's repository goes through `src/exclude.ts`, so `.vigilesrc.json#exclude` applies to it; a walk that does not import it ignores what the user excluded.

## Rules

### High Bar For New Commands

**Guidance only** — Adding a new CLI verb (or `hook-runtime` subcommand) is a LAST resort, not a reflex. vigiles is ONE cohesive organism with FEW human verbs (see the `cohesive-cli-surface` rule in the root spec): every new command widens the surface the CLI, the GitHub Action, and the docs must all track in lockstep. A new command must clear a HIGH BAR — (1) it is a genuinely NEW mental action no existing verb owns; if it is a variant of an action a verb already does, add a FLAG to that verb instead; (2) it does NOT overlap an existing command's job — two doors to one room is the smell; (3) related siblings collapse into ONE verb with a subcommand, not N hyphenated verbs; (4) a runtime entrypoint stays hidden under `hook-runtime`, never a public verb. DEFAULT to extending an existing verb with a flag; spawning a sibling verb is the exception you must justify out loud. When in doubt, don't add the verb — and prefer removing or merging an overlapping one.
