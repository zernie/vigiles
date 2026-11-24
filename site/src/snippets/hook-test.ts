import { assertChecks, check, runHook } from "vigiles";

// The guard your plugin already ships.
const guard = "./hooks/block-force-push.sh";

const blocked = runHook(guard, {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push --force origin main" },
});

// fails CI the day it stops blocking
assertChecks(blocked, [check.hook("PreToolUse", { blocked: true })]);
