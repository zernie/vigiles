import { assertToolUsed, runHarnessTest } from "vigiles";
import { scriptModel } from "vigiles/claude-code";

// The skill your plugin already ships.
const trace = await runHarnessTest({
  pluginDir: "./plugins/scv-scan",
  allowedTools: ["Read", "Edit", "Write", "Bash", "Skill"], // a tool left out is withheld
  model: scriptModel([{ tool: "Skill", input: { skill: "scv-scan" } }]),
});

assertToolUsed(trace, "Skill"); // fails CI the day the skill stops resolving
