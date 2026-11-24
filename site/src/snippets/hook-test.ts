import { assertChecks, check, runHook } from "vigiles";

// The guard your plugin already ships.
const guard = "./hooks/block-force-push.sh";

const blocked = runHook(guard, {
  event: "PreToolUse",
  tool: "Bash",
  input: { command: "git push --force origin main" },
});

assertChecks(blocked, [check.blocked()]); // fails CI the day it stops blocking
