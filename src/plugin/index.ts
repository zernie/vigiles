import { noConsoleInProduction } from "./rules/no-console-in-production.js";
import { noAntdImports } from "./rules/no-antd-imports.js";
import { noMagicSpacing } from "./rules/no-magic-spacing.js";

export const plugin = {
  meta: {
    name: "eslint-plugin-agent-lint",
    version: "0.1.0",
  },
  rules: {
    "no-console-in-production": noConsoleInProduction,
    "no-antd-imports": noAntdImports,
    "no-magic-spacing": noMagicSpacing,
  },
};
