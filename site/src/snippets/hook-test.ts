import { assertChecks, check, runHook } from "vigiles";

// Does my force-push guard still
// block? The one your plugin ships.
const guard = "./hooks/block-force-push.sh";

// The event Claude Code would send.
// No model, no key: just the hook.
const blocked = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push --force origin main" },
});

// fails CI the day it stops blocking
assertChecks(blocked, [check.hook("PreToolUse", { blocked: true })]);
