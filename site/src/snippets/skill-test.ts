import { assertChecks, check, runHarnessTest } from "vigiles";
import { scriptModel } from "vigiles/claude-code";

// The skill your plugin already ships.
const trace = await runHarnessTest({
  pluginDir: "./plugins/scv-scan",
  model: scriptModel([{ tool: "Skill", input: { skill: "scv-scan" } }]),
});

assertChecks(trace, [check.tool("Skill")]); // fails CI the day the skill stops resolving
